/**
 * local-fs.js - 안드로이드 내부메모리 파일시스템 및 로컬 현장 폴더/메타데이터 관리 모듈
 * NWMAP 260908_0911
 *
 * 지원 기능:
 * 1. File System Access API (showDirectoryPicker) 상위 작업 폴더 지정 및 IndexedDB 영구 저장
 * 2. 활성화된 현장 폴더 자동 생성 ([현장명]/)
 * 3. nsmap_참고 규격 사진 파일 저장 ([현장명]_photo_[순번]_[MMDDHHmmss].jpg)
 * 4. AutoCAD 플러그인(INSERTPHOTOS) 규격 [현장명]_metadata.json 및 metadata.json 실시간 누적 기록
 * 5. 로컬 마커 IndexedDB 저장 및 지도 화면 연동
 * 6. iOS 기기 자동 판별 및 브라우저 지원 여부 검사
 */
(function (MWMAP) {
  'use strict';

  var DB_NAME = 'NWMAP_LOCAL_FS';
  var DB_VERSION = 1;
  var HANDLE_STORE = 'handles';
  var METADATA_STORE = 'site_metadata';

  var _dbPromise = null;
  var _baseDirHandle = null;
  var _storageMode = localStorage.getItem('nwmap_photo_storage_mode') || 'firebase';
  var _crs = localStorage.getItem('nwmap_photo_crs') || 'EPSG:5186';
  var _baseDirName = localStorage.getItem('nwmap_base_dir_name') || '';

  // Proj4 한국 TM 좌표계 정의 초기화
  function initProj4Defs() {
    if (typeof proj4 === 'undefined') return;
    if (!proj4.defs('EPSG:5185')) {
      proj4.defs('EPSG:5185', '+proj=tmerc +lat_0=38 +lon_0=125 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs');
    }
    if (!proj4.defs('EPSG:5186')) {
      proj4.defs('EPSG:5186', '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs');
    }
    if (!proj4.defs('EPSG:5187')) {
      proj4.defs('EPSG:5187', '+proj=tmerc +lat_0=38 +lon_0=129 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs');
    }
    if (!proj4.defs('EPSG:5188')) {
      proj4.defs('EPSG:5188', '+proj=tmerc +lat_0=38 +lon_0=131 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs');
    }
  }

  // iOS(아이폰, 아이패드) 기기 판별
  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  // File System Access API 지원 여부
  function isFSSupported() {
    return typeof window.showDirectoryPicker === 'function';
  }

  // IndexedDB 열기
  function openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB를 지원하지 않는 브라우저입니다.'));
        return;
      }
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(HANDLE_STORE)) {
          db.createObjectStore(HANDLE_STORE);
        }
        if (!db.objectStoreNames.contains(METADATA_STORE)) {
          db.createObjectStore(METADATA_STORE, { keyPath: 'siteId' });
        }
      };
      request.onsuccess = function (e) {
        resolve(e.target.result);
      };
      request.onerror = function (e) {
        reject(e.target.error);
      };
    });
    return _dbPromise;
  }

  // 저장된 상위 폴더 핸들 불러오기
  function loadSavedBaseDirHandle() {
    return openDb().then(function (db) {
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(HANDLE_STORE, 'readonly');
          var store = tx.objectStore(HANDLE_STORE);
          var req = store.get('baseDirHandle');
          req.onsuccess = function () {
            if (req.result) {
              _baseDirHandle = req.result;
              resolve(_baseDirHandle);
            } else {
              resolve(null);
            }
          };
          req.onerror = function () { resolve(null); };
        } catch (e) {
          resolve(null);
        }
      });
    });
  }

  // 상위 폴더 핸들 영구 저장
  function saveBaseDirHandle(handle) {
    _baseDirHandle = handle;
    _baseDirName = handle.name || '선택된 폴더';
    localStorage.setItem('nwmap_base_dir_name', _baseDirName);

    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(HANDLE_STORE, 'readwrite');
        var store = tx.objectStore(HANDLE_STORE);
        store.put(handle, 'baseDirHandle');
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  // 폴더 권한 확인 및 요청
  async function verifyPermission(handle, readWrite) {
    if (!handle) return false;
    var options = {};
    if (readWrite) options.mode = 'readwrite';
    try {
      if ((await handle.queryPermission(options)) === 'granted') {
        return true;
      }
      if ((await handle.requestPermission(options)) === 'granted') {
        return true;
      }
    } catch (e) {
      console.warn('[localFs] 권한 요청 실패:', e);
    }
    return false;
  }

  // 사용자에게 상위 작업 폴더 선택 요청
  async function pickBaseDirectory() {
    if (!isFSSupported()) {
      alert('현재 브라우저에서는 실제 폴더 저장 기능(File System Access API)을 지원하지 않습니다.\n안드로이드 Chrome 최신 버전을 사용해 주세요.');
      return null;
    }
    try {
      var handle = await window.showDirectoryPicker({
        id: 'nwmap_survey_root',
        mode: 'readwrite',
        startIn: 'documents'
      });
      if (handle) {
        await saveBaseDirHandle(handle);
        updateUiFolderDisplay();
        alert('저장 위치가 설정되었습니다:\n' + handle.name + '\n\n현장별로 [현장명] 폴더가 자동 생성되어 사진이 저장됩니다.');
        return handle;
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('[localFs] 폴더 선택 실패:', err);
        alert('폴더를 선택하지 못했습니다: ' + (err.message || err));
      }
    }
    return null;
  }

  // GPS 위경도 → 한국 캐드 좌표(X, Y) 변환
  function convertGpsToCad(lat, lng, targetCrs) {
    initProj4Defs();
    var crs = targetCrs || _crs;
    if (!crs || crs === 'AUTO') {
      // 경도 기준 자동 감지 (서부 5185 / 중부 5186 / 동부 5187 / 동해 5188)
      if (lng < 126.3) crs = 'EPSG:5185';
      else if (lng >= 126.3 && lng < 128.3) crs = 'EPSG:5186';
      else if (lng >= 128.3 && lng < 130.0) crs = 'EPSG:5187';
      else crs = 'EPSG:5188';
    }
    if (typeof proj4 !== 'undefined' && proj4.defs(crs)) {
      var pt = proj4('EPSG:4326', crs, [lng, lat]);
      return {
        x: Math.round(pt[0] * 100) / 100,
        y: Math.round(pt[1] * 100) / 100,
        crs: crs
      };
    }
    return { x: lng, y: lat, crs: 'EPSG:4326' };
  }

  // 활성화된 현장의 로컬 메타데이터 가져오기 (IndexedDB)
  function getLocalSiteRecord(siteId) {
    return openDb().then(function (db) {
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(METADATA_STORE, 'readonly');
          var req = tx.objectStore(METADATA_STORE).get(siteId);
          req.onsuccess = function () { resolve(req.result || null); };
          req.onerror = function () { resolve(null); };
        } catch (e) {
          resolve(null);
        }
      });
    });
  }

  // 로컬 메타데이터 저장 (IndexedDB)
  function saveLocalSiteRecord(siteRecord) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(METADATA_STORE, 'readwrite');
        tx.objectStore(METADATA_STORE).put(siteRecord);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function (e) { reject(e.target.error); };
      });
    });
  }

  // 파일명 안전화
  function sanitizeName(name) {
    return (name || '현장').replace(/[\\/:*?"<>|]/g, '_').trim();
  }

  // 사진 파일명 생성: [현장명]_photo_[순번]_[MMDDHHmmss].jpg
  function generatePhotoFileName(siteName, photoNum) {
    var baseName = sanitizeName(siteName);
    var now = new Date();
    var mm = String(now.getMonth() + 1).padStart(2, '0');
    var dd = String(now.getDate()).padStart(2, '0');
    var hh = String(now.getHours()).padStart(2, '0');
    var min = String(now.getMinutes()).padStart(2, '0');
    var ss = String(now.getSeconds()).padStart(2, '0');
    var numStr = photoNum ? photoNum + '_' : '';
    return baseName + '_photo_' + numStr + mm + dd + hh + min + ss + '.jpg';
  }

  // Base64 문자열을 Blob으로 변환
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

  /**
   * 사진을 내부메모리 현장 폴더에 저장 및 메타데이터 실시간 갱신
   * @param {string} siteId 현장 ID
   * @param {string} siteName 현장명
   * @param {object} photoData { lat, lng, base64Data, memo }
   * @returns {Promise<object>} 저장된 마커 객체
   */
  async function savePhotoToInternalStorage(siteId, siteName, photoData) {
    if (!_baseDirHandle) {
      _baseDirHandle = await loadSavedBaseDirHandle();
    }
    if (!_baseDirHandle) {
      _baseDirHandle = await pickBaseDirectory();
      if (!_baseDirHandle) {
        throw new Error('저장 폴더가 지정되지 않았습니다.');
      }
    }

    // 폴더 권한 확인
    var hasPermission = await verifyPermission(_baseDirHandle, true);
    if (!hasPermission) {
      throw new Error('선택된 폴더에 쓰기 권한이 없습니다.');
    }

    var cleanSite = sanitizeName(siteName || '미지정현장');

    // 1) 현장 폴더 생성/접근
    var siteFolderHandle = await _baseDirHandle.getDirectoryHandle(cleanSite, { create: true });

    // 2) 기존 메타데이터 읽기 (현장 폴더 내부 파일 또는 IndexedDB)
    var localRecord = await getLocalSiteRecord(siteId);
    var metadataObj = null;

    try {
      var metaFileHandle = await siteFolderHandle.getFileHandle(cleanSite + '_metadata.json');
      var metaFile = await metaFileHandle.getFile();
      var metaText = await metaFile.text();
      metadataObj = JSON.parse(metaText);
    } catch (e) {
      // 파일이 아직 없으면 새로 구성
      metadataObj = {
        siteName: cleanSite,
        crs: _crs,
        photos: [],
        texts: [],
        lastModified: new Date().toISOString()
      };
    }

    if (!metadataObj.photos) metadataObj.photos = [];
    if (!metadataObj.texts) metadataObj.texts = [];

    // 3) 초고속 순번 계산 (메모리 배열 길이 + 1, 0ms 렉 없음)
    var nextNum = metadataObj.photos.length + 1;
    var fileName = generatePhotoFileName(cleanSite, nextNum);

    // 4) 사진 Blob 쓰기
    var photoBlob = photoData.blob;
    if (!photoBlob && photoData.base64Data) {
      photoBlob = base64ToBlob(photoData.base64Data);
    }
    if (!photoBlob) {
      throw new Error('유효한 사진 데이터가 없습니다.');
    }

    var photoFileHandle = await siteFolderHandle.getFileHandle(fileName, { create: true });
    var photoWritable = await photoFileHandle.createWritable();
    await photoWritable.write(photoBlob);
    await photoWritable.close();

    // 5) GPS → CAD TM 좌표 변환
    var cadCoord = convertGpsToCad(photoData.lat, photoData.lng, _crs);
    var textNumId = 'text-num-' + nextNum;
    var photoId = 'photo_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

    // 6) 메타데이터 엔트리 추가 (nsmap_참고 및 INSERTPHOTOS 100% 호환)
    var photoEntry = {
      id: photoId,
      fileName: fileName,
      x: cadCoord.x,
      y: cadCoord.y,
      lat: photoData.lat,
      lng: photoData.lng,
      memo: photoData.memo || '',
      facilityType: '일반사진',
      numTextId: textNumId,
      createdAt: new Date().toISOString()
    };

    var textEntry = {
      id: textNumId,
      x: cadCoord.x,
      y: cadCoord.y,
      text: String(nextNum),
      layer: '사진번호'
    };

    metadataObj.photos.push(photoEntry);
    metadataObj.texts.push(textEntry);
    metadataObj.lastModified = new Date().toISOString();
    metadataObj.crs = cadCoord.crs;

    // 7) [현장명]_metadata.json 및 metadata.json 기록
    var jsonText = JSON.stringify(metadataObj, null, 2);

    var siteMetaFile = await siteFolderHandle.getFileHandle(cleanSite + '_metadata.json', { create: true });
    var smWritable = await siteMetaFile.createWritable();
    await smWritable.write(jsonText);
    await smWritable.close();

    var compatMetaFile = await siteFolderHandle.getFileHandle('metadata.json', { create: true });
    var cmWritable = await compatMetaFile.createWritable();
    await cmWritable.write(jsonText);
    await cmWritable.close();

    // 8) 로컬 마커 목록(지도 렌더링용) IndexedDB 갱신
    var markersList = (localRecord && localRecord.markers) ? localRecord.markers : [];
    var markerItem = {
      id: photoId,
      lat: photoData.lat,
      lng: photoData.lng,
      title: '사진 ' + nextNum,
      description: photoData.memo || '',
      isPhoto: true,
      base64Data: photoData.base64Data || null,
      fileName: fileName,
      photoNum: nextNum,
      isLocalFs: true,
      siteId: siteId,
      createdAt: new Date().toISOString()
    };
    markersList.push(markerItem);

    await saveLocalSiteRecord({
      siteId: siteId,
      siteName: cleanSite,
      lastUpdated: new Date().toISOString(),
      markers: markersList
    });

    return markerItem;
  }

  // 특정 현장의 로컬 마커 배열 가져오기
  async function getLocalMarkersForSite(siteId) {
    if (!siteId) return [];
    var rec = await getLocalSiteRecord(siteId);
    return (rec && rec.markers) ? rec.markers : [];
  }

  // UI 폴더명 표시 갱신
  function updateUiFolderDisplay() {
    var labelEl = document.getElementById('current-storage-folder');
    if (labelEl) {
      labelEl.textContent = _baseDirName || '미지정 (터치하여 선택)';
      labelEl.title = _baseDirName || '폴더 지정 필요';
      if (_baseDirName) {
        labelEl.style.color = '#1d4ed8';
        labelEl.style.fontWeight = '600';
      } else {
        labelEl.style.color = '#ef4444';
        labelEl.style.fontWeight = 'normal';
      }
    }
  }

  // 사이드바 UI 이벤트 바인딩 및 초기화
  function bindUi() {
    var firebaseRadio = document.querySelector('input[name="photo-storage-mode"][value="firebase"]');
    var internalRadio = document.querySelector('input[name="photo-storage-mode"][value="internal"]');
    var internalControls = document.getElementById('internal-storage-controls');
    var iosNotice = document.getElementById('storage-ios-notice');
    var selectFolderBtn = document.getElementById('select-storage-folder-btn');
    var crsSelect = document.getElementById('storage-crs-select');

    // iOS 기기 판별: 내부메모리 옵션 비활성화
    if (isIOS() || !isFSSupported()) {
      if (internalRadio) {
        internalRadio.disabled = true;
      }
      var internalLabel = document.getElementById('storage-radio-internal-label');
      if (internalLabel) {
        internalLabel.style.opacity = '0.5';
        internalLabel.style.cursor = 'not-allowed';
      }
      if (iosNotice) {
        iosNotice.classList.remove('hide');
        if (isIOS()) {
          iosNotice.textContent = '* iOS(아이폰/아이패드)는 애플 정책상 내부메모리 폴더 저장이 지원되지 않습니다.';
        } else {
          iosNotice.textContent = '* 현재 브라우저는 실제 폴더 저장 기능을 지원하지 않아 클라우드 업로드만 가능합니다.';
        }
      }
      // 강제로 firebase 모드로 유지
      _storageMode = 'firebase';
      localStorage.setItem('nwmap_photo_storage_mode', 'firebase');
      if (firebaseRadio) firebaseRadio.checked = true;
    } else {
      if (iosNotice) iosNotice.classList.add('hide');
      if (_storageMode === 'internal' && internalRadio) {
        internalRadio.checked = true;
      } else if (firebaseRadio) {
        firebaseRadio.checked = true;
      }
    }

    function toggleControls() {
      if (_storageMode === 'internal' && !isIOS() && isFSSupported()) {
        if (internalControls) internalControls.classList.remove('hide');
      } else {
        if (internalControls) internalControls.classList.add('hide');
      }
    }

    if (firebaseRadio) {
      firebaseRadio.addEventListener('change', function () {
        if (firebaseRadio.checked) {
          _storageMode = 'firebase';
          localStorage.setItem('nwmap_photo_storage_mode', 'firebase');
          toggleControls();
        }
      });
    }

    if (internalRadio) {
      internalRadio.addEventListener('change', async function () {
        if (internalRadio.checked) {
          _storageMode = 'internal';
          localStorage.setItem('nwmap_photo_storage_mode', 'internal');
          toggleControls();

          // 저장 폴더가 아직 지정되지 않은 경우 즉시 폴더 선택 다이얼로그 호출
          if (!_baseDirHandle) {
            _baseDirHandle = await loadSavedBaseDirHandle();
          }
          if (!_baseDirHandle) {
            await pickBaseDirectory();
          }
        }
      });
    }

    if (selectFolderBtn) {
      selectFolderBtn.addEventListener('click', function () {
        pickBaseDirectory();
      });
    }

    if (crsSelect) {
      crsSelect.value = _crs;
      crsSelect.addEventListener('change', function () {
        _crs = crsSelect.value;
        localStorage.setItem('nwmap_photo_crs', _crs);
      });
    }

    toggleControls();
    updateUiFolderDisplay();

    // 시작 시 저장된 폴더 핸들 백그라운드 로드
    loadSavedBaseDirHandle().then(function (handle) {
      if (handle) updateUiFolderDisplay();
    });
  }

  // 모듈 초기화
  function init() {
    initProj4Defs();
    bindUi();
  }

  // 로컬 사진 메모 수정
  async function updatePhotoMemo(siteId, photoId, newMemo) {
    if (!siteId || !photoId) return;
    var rec = await getLocalSiteRecord(siteId);
    if (!rec || !Array.isArray(rec.markers)) return;

    var targetMarker = rec.markers.find(function (m) { return m.id === photoId; });
    if (targetMarker) {
      targetMarker.description = newMemo || '';
      await saveLocalSiteRecord(rec);
    }

    // 폴더 내 metadata.json도 갱신 시도
    if (_baseDirHandle && rec.siteName) {
      try {
        var cleanSite = sanitizeName(rec.siteName);
        var siteFolderHandle = await _baseDirHandle.getDirectoryHandle(cleanSite);
        var metaFileHandle = await siteFolderHandle.getFileHandle(cleanSite + '_metadata.json');
        var metaFile = await metaFileHandle.getFile();
        var metaObj = JSON.parse(await metaFile.text());
        if (metaObj && metaObj.photos) {
          var p = metaObj.photos.find(function (x) { return x.id === photoId; });
          if (p) {
            p.memo = newMemo || '';
            metaObj.lastModified = new Date().toISOString();
            var jsonText = JSON.stringify(metaObj, null, 2);
            var smWritable = await metaFileHandle.createWritable();
            await smWritable.write(jsonText);
            await smWritable.close();

            var compatFileHandle = await siteFolderHandle.getFileHandle('metadata.json', { create: true });
            var cmWritable = await compatFileHandle.createWritable();
            await cmWritable.write(jsonText);
            await cmWritable.close();
          }
        }
      } catch (e) {
        console.warn('[localFs] metadata.json 메모 업데이트 실패 (무시 가능):', e);
      }
    }
  }

  // 로컬 사진 삭제
  async function deletePhoto(siteId, photoId) {
    if (!siteId || !photoId) return;
    var rec = await getLocalSiteRecord(siteId);
    if (!rec || !Array.isArray(rec.markers)) return;

    var deletedFileName = null;
    rec.markers = rec.markers.filter(function (m) {
      if (m.id === photoId) {
        deletedFileName = m.fileName;
        return false;
      }
      return true;
    });
    await saveLocalSiteRecord(rec);

    // 폴더 내 파일 및 metadata.json에서 제거
    if (_baseDirHandle && rec.siteName) {
      try {
        var cleanSite = sanitizeName(rec.siteName);
        var siteFolderHandle = await _baseDirHandle.getDirectoryHandle(cleanSite);
        if (deletedFileName) {
          try {
            await siteFolderHandle.removeEntry(deletedFileName);
          } catch (e) {}
        }
        var metaFileHandle = await siteFolderHandle.getFileHandle(cleanSite + '_metadata.json');
        var metaFile = await metaFileHandle.getFile();
        var metaObj = JSON.parse(await metaFile.text());
        if (metaObj && metaObj.photos) {
          metaObj.photos = metaObj.photos.filter(function (x) { return x.id !== photoId; });
          metaObj.lastModified = new Date().toISOString();
          var jsonText = JSON.stringify(metaObj, null, 2);
          var smWritable = await metaFileHandle.createWritable();
          await smWritable.write(jsonText);
          await smWritable.close();

          var compatFileHandle = await siteFolderHandle.getFileHandle('metadata.json', { create: true });
          var cmWritable = await compatFileHandle.createWritable();
          await cmWritable.write(jsonText);
          await cmWritable.close();
        }
      } catch (e) {
        console.warn('[localFs] metadata.json 사진 삭제 실패 (무시 가능):', e);
      }
    }
  }

  // 공개 API
  MWMAP.localFs = {
    init: init,
    isIOS: isIOS,
    isFSSupported: isFSSupported,
    getStorageMode: function () { return _storageMode; },
    getCrs: function () { return _crs; },
    getBaseDirHandle: function () { return _baseDirHandle; },
    pickBaseDirectory: pickBaseDirectory,
    savePhotoToInternalStorage: savePhotoToInternalStorage,
    getLocalMarkersForSite: getLocalMarkersForSite,
    updatePhotoMemo: updatePhotoMemo,
    deletePhoto: deletePhoto,
    convertGpsToCad: convertGpsToCad
  };

  // DOM 로드 완료 시 자동 초기화
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.MWMAP = window.MWMAP || {});
