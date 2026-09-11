/**
 * photo-export.js - NWMAP 사진/마커 내보내기 모듈 (AutoCAD용)
 * 
 * 워크플로우:
 * 1. 사이드패널 "사진내보내기" 버튼 클릭
 * 2. 좌표계 선택 모달 (EPSG:5185~5188)
 * 3. Firestore에서 현재 선택된 현장의 사진+마커 수집
 * 4. proj4js로 WGS84 → 선택 좌표계 변환
 * 5. 메타데이터 JSON + 사진 JPEG + NInsertPhotos.lsp → ZIP 다운로드
 */
(function (MWMAP) {
  'use strict';

  // ============================================================
  // proj4 좌표계 정의 (한국 2000 TM)
  // ============================================================
  function initProj4Defs() {
    if (typeof proj4 === 'undefined') {
      console.error('[photo-export] proj4js 라이브러리가 로드되지 않았습니다.');
      return false;
    }
    proj4.defs('EPSG:5185', '+proj=tmerc +lat_0=38 +lon_0=125 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs');
    proj4.defs('EPSG:5186', '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs');
    proj4.defs('EPSG:5187', '+proj=tmerc +lat_0=38 +lon_0=129 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs');
    proj4.defs('EPSG:5188', '+proj=tmerc +lat_0=38 +lon_0=131 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs');
    return true;
  }

  // ============================================================
  // 좌표계 선택 모달
  // ============================================================
  function showCrsSelectModal() {
    var overlay = document.getElementById('crs-select-overlay');
    if (overlay) overlay.classList.add('show');
  }

  function hideCrsSelectModal() {
    var overlay = document.getElementById('crs-select-overlay');
    if (overlay) overlay.classList.remove('show');
  }

  // ============================================================
  // Base64 → Blob 변환
  // ============================================================
  function base64ToBlob(base64Str) {
    var parts = base64Str.split(',');
    var mimeMatch = (parts[0] || '').match(/data:(.*?);base64/);
    var mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    var binary = atob(parts[1] || parts[0]);
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  // ============================================================
  // Firestore에서 사진/마커 데이터 수집
  // ============================================================
  function collectSiteData(siteId) {
    return new Promise(function (resolve, reject) {
      if (!window.firestore || !window.db) {
        reject(new Error('Firebase 연결이 되지 않았습니다.'));
        return;
      }
      var fs = window.firestore;

      // 현장명 가져오기
      var siteRef = fs.doc(window.db, 'users', 'currentUser', 'schedules', siteId);
      var photosColRef = fs.collection(window.db, 'users', 'currentUser', 'schedules', siteId, 'photos');

      Promise.all([
        fs.getDoc(siteRef),
        fs.getDocs(photosColRef)
      ]).then(function (results) {
        var siteSnap = results[0];
        var photosSnap = results[1];

        var siteName = '현장';
        if (siteSnap && siteSnap.exists && siteSnap.exists()) {
          var siteData = siteSnap.data() || {};
          siteName = siteData.title || siteData.name || siteId;
        }

        var photos = [];
        var markers = [];

        if (photosSnap && photosSnap.docs) {
          photosSnap.docs.forEach(function (doc) {
            var d = doc.data();
            if (!d || typeof d.lat !== 'number' || typeof d.lng !== 'number') return;

            if (d.isPhoto && d.base64Data) {
              photos.push({
                id: doc.id,
                lat: d.lat,
                lng: d.lng,
                title: d.title || '',
                description: d.description || '',
                base64Data: d.base64Data
              });
            } else if (!d.isPhoto) {
              markers.push({
                id: doc.id,
                lat: d.lat,
                lng: d.lng,
                title: d.title || '',
                description: d.description || ''
              });
            }
          });
        }

        resolve({
          siteId: siteId,
          siteName: siteName,
          photos: photos,
          markers: markers
        });
      }).catch(reject);
    });
  }

  // ============================================================
  // NInsertPhotos.lsp 내용 (AutoLISP 스크립트)
  // ============================================================
  function getLspContent() {
    return [
      ';;; ====================================================================',
      ';;; NInsertPhotos.lsp - NWMAP 전용 사진/텍스트 삽입 스크립트',
      ';;; NWMAP 웹앱에서 내보낸 사진과 마커 텍스트를 AutoCAD 도면에 자동 삽입',
      ';;;',
      ';;; 기능:',
      ';;;   1. 탐색기로 메타데이터 JSON 파일 선택',
      ';;;   2. 사진은 JSON 파일과 같은 폴더에서 자동 로드',
      ';;;   3. 사진 → 0_IM 레이어, 텍스트 → 0_TEXT 레이어',
      ';;;   4. 사진 스케일: 1.5, 텍스트 높이: 1.5',
      ';;;   5. 스마트 스냅: 2M(도면단위 2.0) 이내 블록 삽입점(INSERT)만 스냅',
      ';;; ====================================================================',
      '',
      '(defun C:NINSERTPHOTOS (/ dwg-path json-file f line content',
      '                          photo-count text-count i j fileName x y memo photo-path',
      '                          insert-pt scale text-height',
      '                          text-x text-y text-content',
      '                          success-count fail-count',
      '                          start-time end-time snap-pt snap-x snap-y',
      '                          photo-folder doc mspace textstyle-name old-cmdecho)',
      '  ',
      '  (vl-load-com)',
      '  ',
      '  (princ "\\n========================================")',
      '  (princ "\\nNWMAP 사진/텍스트 자동 삽입 시작")',
      '  (princ "\\n  사진 스케일: 1.5 | 텍스트 높이: 1.5")',
      '  (princ "\\n  사진 레이어: 0_IM | 텍스트 레이어: 0_TEXT")',
      '  (princ "\\n========================================\\n")',
      '  ',
      '  (setq start-time (getvar "MILLISECS"))',
      '  (setq dwg-path (getvar "DWGPREFIX"))',
      '  ',
      '  ;; 메타데이터 파일 선택',
      '  (princ "\\n탐색기에서 메타데이터 JSON 파일을 선택하세요...")',
      '  (setq json-file',
      '    (getfiled "NWMAP 메타데이터 JSON 파일 선택"',
      '              dwg-path',
      '              "json"',
      '              0))',
      '  (if (= json-file nil)',
      '    (progn',
      '      (princ "\\n파일 선택이 취소되었습니다.")',
      '      (princ)',
      '      (exit)',
      '    )',
      '  )',
      '  ',
      '  (setq photo-folder (strcat (vl-filename-directory json-file) "\\\\"))',
      '  (princ (strcat "\\n메타데이터: " (vl-filename-base json-file) ".json"))',
      '  (princ (strcat "\\n사진 폴더: " photo-folder))',
      '  ',
      '  (if (not (findfile json-file))',
      '    (progn',
      '      (princ "\\n파일을 찾을 수 없습니다.")',
      '      (princ)',
      '      (exit)',
      '    )',
      '  )',
      '  ',
      '  ;; 파일 읽기',
      '  (setq content "")',
      '  (setq f (open json-file "r"))',
      '  (if (not f)',
      '    (progn (princ "\\n파일을 열 수 없습니다.") (princ) (exit))',
      '  )',
      '  (while (setq line (read-line f))',
      '    (setq content (strcat content line "\\n"))',
      '  )',
      '  (close f)',
      '  ',
      '  ;; 사진/텍스트 개수 계산',
      '  (setq photo-count (n-count-occurrences "\\"fileName\\"" content))',
      '  (setq text-count (n-count-texts content))',
      '  ',
      '  (princ (strcat "\\n\\n발견된 항목:"))',
      '  (princ (strcat "\\n   사진: " (itoa photo-count) "개"))',
      '  (princ (strcat "\\n   텍스트: " (itoa text-count) "개"))',
      '  ',
      '  (if (and (= photo-count 0) (= text-count 0))',
      '    (progn (princ "\\n삽입할 항목이 없습니다.") (princ) (exit))',
      '  )',
      '  ',
      '  ;; 레이어 생성',
      '  (command "._LAYER" "_Make" "0_IM" "")',
      '  (command "._LAYER" "_Make" "0_TEXT" "")',
      '  ',
      '  ;; 성능 최적화',
      '  (setq old-cmdecho (getvar "CMDECHO"))',
      '  (setvar "CMDECHO" 0)',
      '  (command "_.UNDO" "_Begin")',
      '  (setq doc (vla-get-ActiveDocument (vlax-get-acad-object)))',
      '  (setq mspace (vla-get-ModelSpace doc))',
      '  (setq textstyle-name (getvar "TEXTSTYLE"))',
      '  (setq success-count 0)',
      '  (setq fail-count 0)',
      '  (setq scale 1.5)',
      '  (setq text-height 1.5)',
      '  ',
      '  ;; === 사진 삽입 ===',
      '  (if (> photo-count 0)',
      '    (progn',
      '      (princ "\\n\\n사진 삽입 중...\\n")',
      '      (setq i 0)',
      '      (while (< i photo-count)',
      '        (princ (strcat "\\r   진행: [" (itoa (+ i 1)) "/" (itoa photo-count) "] "))',
      '        (setq fileName (n-get-json-value content "\\"fileName\\"" i))',
      '        (setq x (atof (n-get-photo-field content "\\"x\\"" i)))',
      '        (setq y (atof (n-get-photo-field content "\\"y\\"" i)))',
      '        (setq memo (n-get-json-value content "\\"memo\\"" i))',
      '        ',
      '        ;; 스마트 스냅',
      '        (setq snap-pt (n-smart-snap (list x y 0.0) 2.0))',
      '        (setq snap-x (car snap-pt))',
      '        (setq snap-y (cadr snap-pt))',
      '        ',
      '        (setq photo-path (strcat photo-folder fileName))',
      '        ',
      '        (if (not (findfile photo-path))',
      '          (progn',
      '            (princ (strcat "\\n       파일 없음: " fileName))',
      '            (setq fail-count (+ fail-count 1))',
      '          )',
      '          (progn',
      '            ;; 현재 레이어를 0_IM으로 변경 후 삽입',
      '            (setvar "CLAYER" "0_IM")',
      '            (if (vl-catch-all-error-p',
      '                  (vl-catch-all-apply',
      '                    \'vla-AddRaster',
      '                    (list mspace photo-path (vlax-3D-point snap-x snap-y 0.0) scale 0.0)',
      '                  )',
      '                )',
      '              (progn',
      '                (if (vl-catch-all-error-p',
      '                      (vl-catch-all-apply',
      '                        \'vl-cmdf',
      '                        (list "._-IMAGE" "_A" photo-path (strcat (rtos snap-x 2 6) "," (rtos snap-y 2 6)) (rtos scale 2 6) "0")',
      '                      )',
      '                    )',
      '                  (progn',
      '                    (princ (strcat "\\n       이미지 삽입 실패: " fileName))',
      '                    (setq fail-count (+ fail-count 1))',
      '                  )',
      '                  (progn',
      '                    (if (and memo (> (strlen memo) 0) (/= (vl-string-trim " \\t\\n\\r" memo) ""))',
      '                      (progn',
      '                        (setvar "CLAYER" "0_TEXT")',
      '                        (entmake (list \'(0 . "TEXT") (cons 8 "0_TEXT") (cons 10 (list snap-x (- snap-y 2.0) 0.0)) (cons 40 text-height) (cons 1 memo) (cons 50 0.0) (cons 7 textstyle-name)))',
      '                      )',
      '                    )',
      '                    (setq success-count (+ success-count 1))',
      '                  )',
      '                )',
      '              )',
      '              (progn',
      '                (if (and memo (> (strlen memo) 0) (/= (vl-string-trim " \\t\\n\\r" memo) ""))',
      '                  (progn',
      '                    (setvar "CLAYER" "0_TEXT")',
      '                    (entmake (list \'(0 . "TEXT") (cons 8 "0_TEXT") (cons 10 (list snap-x (- snap-y 2.0) 0.0)) (cons 40 text-height) (cons 1 memo) (cons 50 0.0) (cons 7 textstyle-name)))',
      '                  )',
      '                )',
      '                (setq success-count (+ success-count 1))',
      '              )',
      '            )',
      '          )',
      '        )',
      '        (setq i (+ i 1))',
      '      )',
      '      (princ "\\n")',
      '    )',
      '  )',
      '  ',
      '  ;; === 텍스트(마커) 삽입 ===',
      '  (if (> text-count 0)',
      '    (progn',
      '      (princ "\\n텍스트 삽입 중...\\n")',
      '      (setvar "CLAYER" "0_TEXT")',
      '      (setq j 0)',
      '      (while (< j text-count)',
      '        (princ (strcat "\\r   진행: [" (itoa (+ j 1)) "/" (itoa text-count) "] "))',
      '        (setq text-x (atof (n-get-text-field content "\\"x\\"" j)))',
      '        (setq text-y (atof (n-get-text-field content "\\"y\\"" j)))',
      '        (setq text-content (n-get-text-field content "\\"text\\"" j))',
      '        ',
      '        (setq snap-pt (n-smart-snap (list text-x text-y 0.0) 2.0))',
      '        (setq snap-x (car snap-pt))',
      '        (setq snap-y (cadr snap-pt))',
      '        ',
      '        (if (and text-content (> (strlen text-content) 0))',
      '          (progn',
      '            (entmake (list \'(0 . "TEXT") (cons 8 "0_TEXT") (cons 10 (list snap-x snap-y 0.0)) (cons 40 1.5) (cons 1 text-content) (cons 50 0.0) (cons 7 textstyle-name)))',
      '            (setq success-count (+ success-count 1))',
      '          )',
      '        )',
      '        (setq j (+ j 1))',
      '      )',
      '      (princ "\\n")',
      '    )',
      '  )',
      '  ',
      '  ;; 완료',
      '  (command "_.UNDO" "_End")',
      '  (setvar "CMDECHO" old-cmdecho)',
      '  ',
      '  (princ "\\n\\n========================================")',
      '  (princ "\\n삽입 완료!")',
      '  (princ (strcat "\\n   성공: " (itoa success-count) "개"))',
      '  (if (> fail-count 0) (princ (strcat "\\n   실패: " (itoa fail-count) "개")))',
      '  (setq end-time (getvar "MILLISECS"))',
      '  (princ (strcat "\\n   소요 시간: " (itoa (- end-time start-time)) "ms"))',
      '  (princ "\\n========================================")',
      '  (princ)',
      ')',
      '',
      ';;; 보조 함수들',
      '',
      '(defun n-smart-snap (pt snap-radius / ss ent ent-data closest-pt closest-dist test-pt test-dist i min-x min-y max-x max-y)',
      '  (setq min-x (- (car pt) snap-radius))',
      '  (setq min-y (- (cadr pt) snap-radius))',
      '  (setq max-x (+ (car pt) snap-radius))',
      '  (setq max-y (+ (cadr pt) snap-radius))',
      '  (setq ss (ssget "C" (list min-x min-y) (list max-x max-y) \'((0 . "INSERT"))))',
      '  (setq closest-pt nil)',
      '  (setq closest-dist snap-radius)',
      '  (if ss',
      '    (progn',
      '      (setq i 0)',
      '      (while (< i (sslength ss))',
      '        (setq ent (ssname ss i))',
      '        (setq ent-data (entget ent))',
      '        (if (= (cdr (assoc 0 ent-data)) "INSERT")',
      '          (progn',
      '            (setq test-pt (cdr (assoc 10 ent-data)))',
      '            (setq test-dist (distance pt (list (car test-pt) (cadr test-pt))))',
      '            (if (< test-dist closest-dist)',
      '              (progn (setq closest-dist test-dist) (setq closest-pt (list (car test-pt) (cadr test-pt) 0.0)))',
      '            )',
      '          )',
      '        )',
      '        (setq i (1+ i))',
      '      )',
      '    )',
      '  )',
      '  (if closest-pt closest-pt pt)',
      ')',
      '',
      '(defun n-count-occurrences (search-str in-str / count pos)',
      '  (setq count 0 pos 1)',
      '  (while (setq pos (vl-string-search search-str in-str (1- pos)))',
      '    (setq count (1+ count) pos (+ pos (strlen search-str) 1)))',
      '  count)',
      '',
      '(defun n-count-texts (content / ts te tc)',
      '  (setq ts (vl-string-search "\\"texts\\":" content))',
      '  (if ts',
      '    (progn',
      '      (setq ts (vl-string-search "[" content ts))',
      '      (setq te (vl-string-search "]" content ts))',
      '      (setq tc (substr content (1+ ts) (- te ts)))',
      '      (n-count-occurrences "\\"text\\"" tc))',
      '    0))',
      '',
      '(defun n-get-json-value (json-str key occurrence / pos count start-pos end-pos value)',
      '  (setq count 0 pos 0 value "")',
      '  (while (and (<= count occurrence) (< pos (strlen json-str)))',
      '    (setq pos (vl-string-search key json-str pos))',
      '    (if pos',
      '      (progn',
      '        (if (= count occurrence)',
      '          (progn',
      '            (setq start-pos (vl-string-search ":" json-str pos))',
      '            (if start-pos (progn',
      '              (setq start-pos (1+ start-pos))',
      '              (while (and (< start-pos (strlen json-str)) (member (substr json-str (1+ start-pos) 1) \'(" " "\\t" "\\n" "\\r")))',
      '                (setq start-pos (1+ start-pos)))',
      '              (setq start-pos (1+ start-pos))',
      '              (cond',
      '                ((= (substr json-str start-pos 1) "\\"")',
      '                 (setq end-pos (vl-string-search "\\"" json-str start-pos))',
      '                 (if end-pos (setq value (substr json-str (1+ start-pos) (- end-pos start-pos))) (setq value "")))',
      '                ((wcmatch (substr json-str start-pos 1) "0123456789.-+")',
      '                 (setq end-pos start-pos)',
      '                 (while (and (< end-pos (strlen json-str)) (wcmatch (substr json-str (1+ end-pos) 1) "0123456789.-+eE"))',
      '                   (setq end-pos (1+ end-pos)))',
      '                 (setq value (substr json-str start-pos (1+ (- end-pos start-pos)))))',
      '                (t (setq end-pos (vl-string-search "," json-str start-pos))',
      '                   (if (not end-pos) (setq end-pos (vl-string-search "}" json-str start-pos)))',
      '                   (if end-pos (setq value (substr json-str start-pos (1+ (- end-pos start-pos)))) (setq value "")))',
      '              )',
      '            ))',
      '          )',
      '        )',
      '        (setq count (1+ count) pos (+ pos (strlen key)))',
      '      )',
      '      (setq pos (strlen json-str))))',
      '  (while (and (> (strlen value) 0) (member (substr value 1 1) \'(" " "\\t" "\\n" "\\r" "\\"" "\'")))',
      '    (setq value (substr value 2)))',
      '  (while (and (> (strlen value) 0) (member (substr value (strlen value) 1) \'(" " "\\t" "\\n" "\\r" "," "\\"" "\'")))',
      '    (setq value (substr value 1 (1- (strlen value)))))',
      '  value)',
      '',
      ';; photos 배열 내에서 N번째 키 값 추출',
      '(defun n-get-photo-field (json-str key occurrence / ps pe pc)',
      '  (setq ps (vl-string-search "\\"photos\\":" json-str))',
      '  (if ps (progn',
      '    (setq ps (vl-string-search "[" json-str ps))',
      '    (setq pe (n-find-matching-bracket json-str ps))',
      '    (setq pc (substr json-str (1+ ps) (- pe ps)))',
      '    (n-get-json-value pc key occurrence)) "0"))',
      '',
      ';; texts 배열 내에서 N번째 키 값 추출',
      '(defun n-get-text-field (json-str key occurrence / ts te tc)',
      '  (setq ts (vl-string-search "\\"texts\\":" json-str))',
      '  (if ts (progn',
      '    (setq ts (vl-string-search "[" json-str ts))',
      '    (setq te (n-find-matching-bracket json-str ts))',
      '    (setq tc (substr json-str (1+ ts) (- te ts)))',
      '    (n-get-json-value tc key occurrence)) ""))',
      '',
      ';; 매칭되는 닫는 괄호 위치 찾기',
      '(defun n-find-matching-bracket (str start-pos / depth i ch len)',
      '  (setq depth 0 i start-pos len (strlen str))',
      '  (while (< i len)',
      '    (setq ch (substr str (1+ i) 1))',
      '    (cond ((= ch "[") (setq depth (1+ depth)))',
      '          ((= ch "]") (setq depth (1- depth)) (if (= depth 0) (progn (setq len -1)))))',
      '    (if (>= len 0) (setq i (1+ i))))',
      '  i)',
      '',
      '(princ "\\n========================================")',
      '(princ "\\nNInsertPhotos.lsp 로드 완료")',
      '(princ "\\n========================================")',
      '(princ "\\n명령어: NINSERTPHOTOS")',
      '(princ "\\n  - 사진 → 0_IM 레이어")',
      '(princ "\\n  - 텍스트 → 0_TEXT 레이어")',
      '(princ "\\n========================================")',
      '(princ)'
    ].join('\r\n');
  }

  // ============================================================
  // 메인 내보내기 함수
  // ============================================================
  function exportPhotosForCAD(siteId, epsgCode) {
    if (!siteId) {
      alert('현장이 선택되지 않았습니다. 먼저 현장을 선택해 주세요.');
      return;
    }
    if (!initProj4Defs()) {
      alert('좌표 변환 라이브러리(proj4js)가 로드되지 않았습니다.');
      return;
    }
    if (typeof JSZip === 'undefined') {
      alert('JSZip 라이브러리가 로드되지 않았습니다.');
      return;
    }

    // 로딩 표시
    var exportBtn = document.getElementById('export-photos-btn');
    if (exportBtn) {
      exportBtn.disabled = true;
      exportBtn.textContent = '내보내는 중...';
    }

    collectSiteData(siteId).then(function (data) {
      if (data.photos.length === 0 && data.markers.length === 0) {
        alert('내보낼 사진이나 마커가 없습니다.');
        return;
      }

      var zip = new JSZip();
      var photoEntries = [];
      var textEntries = [];

      // 사진 처리: 좌표 변환 + JPEG 파일 생성
      data.photos.forEach(function (photo, idx) {
        var coord = proj4('EPSG:4326', epsgCode, [photo.lng, photo.lat]);
        var fileName = 'photo_' + String(idx + 1).padStart(3, '0') + '.jpg';
        var blob = base64ToBlob(photo.base64Data);
        zip.file(fileName, blob);

        photoEntries.push({
          fileName: fileName,
          x: Math.round(coord[0] * 100) / 100,
          y: Math.round(coord[1] * 100) / 100,
          memo: photo.description || ''
        });
      });

      // 마커(텍스트) 처리: 좌표 변환
      data.markers.forEach(function (marker) {
        var coord = proj4('EPSG:4326', epsgCode, [marker.lng, marker.lat]);
        textEntries.push({
          x: Math.round(coord[0] * 100) / 100,
          y: Math.round(coord[1] * 100) / 100,
          text: marker.title || '',
          description: marker.description || ''
        });
      });

      // 메타데이터 JSON
      var metadata = {
        siteName: data.siteName,
        siteId: data.siteId,
        crs: epsgCode,
        photos: photoEntries,
        texts: textEntries,
        exportedAt: new Date().toISOString()
      };

      var jsonStr = JSON.stringify(metadata, null, 2);
      var baseName = (data.siteName || 'nwmap').replace(/[\\/:*?"<>|]/g, '_');
      zip.file(baseName + '_metadata.json', jsonStr);

      // AutoLISP 스크립트 포함
      zip.file('NInsertPhotos.lsp', getLspContent());

      // ZIP 생성 및 다운로드
      return zip.generateAsync({ type: 'blob' }).then(function (zipBlob) {
        var zipName = baseName + '_photos.zip';

        // File System Access API (데스크탑 Chrome/Edge)
        if (typeof window.showSaveFilePicker === 'function') {
          return window.showSaveFilePicker({
            suggestedName: zipName,
            types: [{
              description: 'ZIP 파일',
              accept: { 'application/zip': ['.zip'] }
            }]
          }).then(function (handle) {
            return handle.createWritable();
          }).then(function (writable) {
            return writable.write(zipBlob).then(function () {
              return writable.close();
            });
          }).then(function () {
            alert('내보내기 완료! (' + photoEntries.length + '장 사진, ' + textEntries.length + '개 텍스트)');
          }).catch(function (err) {
            // 사용자가 취소한 경우
            if (err.name === 'AbortError') return;
            // 폴백: 일반 다운로드
            fallbackDownload(zipBlob, zipName, photoEntries.length, textEntries.length);
          });
        } else {
          // 폴백: 일반 다운로드
          fallbackDownload(zipBlob, zipName, photoEntries.length, textEntries.length);
        }
      });
    }).catch(function (err) {
      console.error('사진 내보내기 실패:', err);
      alert('내보내기 실패: ' + (err && err.message ? err.message : err));
    }).finally(function () {
      if (exportBtn) {
        exportBtn.disabled = false;
        exportBtn.textContent = '사진내보내기';
      }
    });
  }

  function fallbackDownload(blob, filename, photoCount, textCount) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    alert('내보내기 완료! (' + photoCount + '장 사진, ' + textCount + '개 텍스트)');
  }

  // ============================================================
  // 이벤트 바인딩
  // ============================================================
  function bindExportUI() {
    var exportBtn = document.getElementById('export-photos-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', function () {
        var siteId = MWMAP.kmlImport && MWMAP.kmlImport.getSelectedSiteId
          ? MWMAP.kmlImport.getSelectedSiteId()
          : null;
        if (!siteId) {
          alert('현장이 선택되지 않았습니다.\n먼저 현장 목록에서 현장을 선택해 주세요.');
          return;
        }
        showCrsSelectModal();
      });
    }

    // 좌표계 선택 모달 버튼들
    var crsOverlay = document.getElementById('crs-select-overlay');
    if (crsOverlay) {
      crsOverlay.addEventListener('click', function (e) {
        if (e.target === crsOverlay) hideCrsSelectModal();
      });

      var crsButtons = crsOverlay.querySelectorAll('[data-crs]');
      crsButtons.forEach(function (btn) {
        btn.addEventListener('click', function () {
          var crs = this.getAttribute('data-crs');
          hideCrsSelectModal();
          var siteId = MWMAP.kmlImport.getSelectedSiteId();
          exportPhotosForCAD(siteId, crs);
        });
      });
    }
  }

  // DOMContentLoaded 또는 즉시 바인딩
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindExportUI);
  } else {
    bindExportUI();
  }

  // 공개 API
  MWMAP.photoExport = {
    exportPhotosForCAD: exportPhotosForCAD,
    showCrsSelectModal: showCrsSelectModal,
    hideCrsSelectModal: hideCrsSelectModal
  };

})(window.MWMAP || (window.MWMAP = {}));
