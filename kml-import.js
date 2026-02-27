'use strict';

/**
 * KML/KMZ 가져오기 → GeoJSON 변환 → 화면 표시 → 현장별로 Firebase에 요약 데이터 저장
 * - 화면 표시/파싱: @참조_WMAP 의 KML 처리 방식을 참조
 * - 업로드: 현장별 kmlBySite[siteId] 필드에 points/lines/polygons 요약 구조 저장
 * - 실제 렌더링 재사용은 추후 별도 모듈에서 확장 가능
 */
(function (MWMAP) {
  var _latestGeoJson = null;

  function ensureDeps() {
    if (typeof toGeoJSON === 'undefined') {
      alert('KML 변환 라이브러리가 로드되지 않았습니다. toGeoJSON을 확인해 주세요.');
      return false;
    }
    if (typeof JSZip === 'undefined') {
      alert('KMZ 처리를 위한 JSZip 라이브러리가 로드되지 않았습니다.');
      return false;
    }
    if (!window.google || !window.google.maps || !MWMAP.map) {
      alert('지도가 아직 준비되지 않았습니다.');
      return false;
    }
    if (!window.db || !window.firestore) {
      alert('Firebase 연결이 되지 않았습니다. 잠시 후 다시 시도해 주세요.');
      return false;
    }
    return true;
  }

  function openFilePicker(inputEl) {
    if (!inputEl) return;
    inputEl.value = '';
    inputEl.click();
  }

  function loadKmlTextFromFile(file) {
    var name = (file && file.name) ? file.name.toLowerCase() : '';
    if (!name) return Promise.reject(new Error('파일 이름이 없습니다.'));

    if (name.endsWith('.kmz')) {
      return JSZip.loadAsync(file).then(function (zip) {
        var kmlFile = zip.file('doc.kml');
        if (!kmlFile) {
          var fallback = null;
          zip.forEach(function (relPath, entry) {
            if (!fallback && relPath.toLowerCase().endsWith('.kml')) {
              fallback = entry;
            }
          });
          kmlFile = fallback;
        }
        if (!kmlFile) {
          throw new Error('KMZ 안에서 KML 파일을 찾을 수 없습니다.');
        }
        return kmlFile.async('string');
      });
    }

    // 기본: .kml
    return file.text();
  }

  function parseKmlToGeoJson(kmlText) {
    var parser = new DOMParser();
    var kmlDoc = parser.parseFromString(kmlText, 'text/xml');
    var parserError = kmlDoc.getElementsByTagName('parsererror');
    if (parserError && parserError.length) {
      throw new Error('KML 파일 파싱 실패: 유효하지 않은 XML 형식');
    }
    var geoJson = toGeoJSON.kml(kmlDoc);
    if (!geoJson || !Array.isArray(geoJson.features) || !geoJson.features.length) {
      throw new Error('KML 파일에 유효한 데이터가 없습니다.');
    }
    return geoJson;
  }

  function displayKmlOnMap(geoJson) {
    var map = MWMAP.map;
    if (!map) return;

    // 기존 Data Layer 비우기 (단순 구현: 다른 Data 사용 계획이 생기면 분리 필요)
    map.data.forEach(function (feature) {
      map.data.remove(feature);
    });

    var added = map.data.addGeoJson(geoJson);
    _latestGeoJson = geoJson;

    // 간단 스타일 (WMAP 참조, 단순화 버전)
    map.data.setStyle(function (feature) {
      var strokeColor = feature.getProperty('stroke') || feature.getProperty('strokeColor') || '#FF0000';
      var strokeOpacity = feature.getProperty('stroke-opacity') || 0.8;
      var strokeWeight = feature.getProperty('stroke-width') || 2;
      var fillColor = feature.getProperty('fill') || feature.getProperty('fillColor') || '#FF6B6B';
      var fillOpacity = feature.getProperty('fill-opacity') || 0.3;
      return {
        strokeColor: strokeColor,
        strokeOpacity: parseFloat(strokeOpacity),
        strokeWeight: parseFloat(strokeWeight),
        fillColor: fillColor,
        fillOpacity: parseFloat(fillOpacity),
        clickable: true
      };
    });

    // 클릭 시 정보창 (간단 버전)
    var currentInfoWindow = null;
    map.data.addListener('click', function (event) {
      var feature = event.feature;
      var name = feature.getProperty('name') || '이름 없음';
      var description = feature.getProperty('description') || '';
      var html =
        '<div style="padding:12px;max-width:280px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;">' +
        '<div style="font-weight:700;margin-bottom:6px;">' + name + '</div>';
      if (description) {
        html += '<div style="font-size:13px;color:#6b7280;line-height:1.4;">' + description + '</div>';
      }
      html += '</div>';

      if (currentInfoWindow) {
        currentInfoWindow.close();
      }
      currentInfoWindow = new google.maps.InfoWindow({
        content: html,
        position: event.latLng,
        maxWidth: 320
      });
      currentInfoWindow.open(map);
    });

    // 화면 범위 맞추기
    var bounds = new google.maps.LatLngBounds();
    var hasGeometry = false;
    added.forEach(function (f) {
      var geom = f.getGeometry();
      if (!geom) return;
      geom.forEachLatLng(function (latlng) {
        bounds.extend(latlng);
        hasGeometry = true;
      });
    });
    if (hasGeometry) {
      map.fitBounds(bounds);
      google.maps.event.addListenerOnce(map, 'bounds_changed', function () {
        var z = map.getZoom();
        if (z > 18) map.setZoom(18);
      });
    }
  }

  function buildShapesFromGeoJson(geoJson) {
    var shapes = { points: [], lines: [], polygons: [] };
    if (!geoJson || !Array.isArray(geoJson.features)) return shapes;

    geoJson.features.forEach(function (f) {
      if (!f || !f.geometry) return;
      var g = f.geometry;
      var props = f.properties || {};
      if (g.type === 'Point') {
        var c = g.coordinates;
        if (Array.isArray(c) && c.length >= 2) {
          shapes.points.push({
            lat: c[1],
            lng: c[0],
            title: props.name || '',
            description: props.description || ''
          });
        }
      } else if (g.type === 'LineString') {
        var coords = Array.isArray(g.coordinates) ? g.coordinates.slice() : [];
        if (coords.length >= 2) {
          shapes.lines.push({
            path: coords.map(function (p) { return { lat: p[1], lng: p[0] }; }),
            name: props.name || '',
            description: props.description || '',
            color: props.stroke || '#3b82f6'
          });
        }
      } else if (g.type === 'Polygon' && Array.isArray(g.coordinates) && g.coordinates.length) {
        var ring = g.coordinates[0] || [];
        if (ring.length >= 4) {
          shapes.polygons.push({
            path: ring.map(function (p) { return { lat: p[1], lng: p[0] }; }),
            name: props.name || '',
            description: props.description || '',
            color: props.stroke || '#3b82f6'
          });
        }
      }
    });

    return shapes;
  }

  function getSitesForSelection() {
    var list = document.getElementById('project-sites-list');
    if (!list) return [];
    var items = list.querySelectorAll('.site-item');
    var sites = [];
    items.forEach(function (el) {
      var id = el.getAttribute('data-site-id') || '';
      if (!id) return;
      sites.push({
        id: id,
        title: el.textContent || ''
      });
    });
    return sites;
  }

  function openSiteSelectModal(payload) {
    var overlay = document.getElementById('kml-site-overlay');
    var listEl = document.getElementById('kml-site-list');
    if (!overlay || !listEl) return;

    var sites = getSitesForSelection();
    if (!sites.length) {
      alert('먼저 현장을 추가한 뒤 KML을 저장해 주세요.');
      return;
    }

    listEl.innerHTML = '';
    sites.forEach(function (site) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dxf-site-item-btn'; // 동일 스타일 재사용
      btn.textContent = site.title || '(이름 없음)';
      btn.addEventListener('click', function () {
        saveKmlForSite(site.id, payload);
      });
      listEl.appendChild(btn);
    });

    overlay.classList.add('show');
  }

  function closeSiteSelectModal() {
    var overlay = document.getElementById('kml-site-overlay');
    if (overlay) overlay.classList.remove('show');
  }

  function saveKmlForSite(siteId, payload) {
    if (!siteId || !payload) return;
    var firestore = window.firestore;
    var ref = firestore.doc(window.db, 'users', 'currentUser');

    firestore.getDoc(ref).then(function (snap) {
      if (!snap.exists()) {
        var obj = {};
        obj[siteId] = payload;
        return firestore.setDoc(ref, {
          customSchedules: [],
          kmlBySite: obj,
          lastUpdated: firestore.serverTimestamp()
        });
      }
      var updateData = {};
      updateData['kmlBySite.' + siteId] = payload;
      updateData.lastUpdated = firestore.serverTimestamp();
      return firestore.updateDoc(ref, updateData);
    }).then(function () {
      closeSiteSelectModal();
      if (MWMAP.sites && typeof MWMAP.sites.showSyncSuccessBadge === 'function') {
        MWMAP.sites.showSyncSuccessBadge();
      }
    }).catch(function (err) {
      console.error('KML 저장 실패:', err);
      alert('KML 데이터를 저장하는 데 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
    });
  }

  function handleKmlFile(file) {
    if (!file || !file.name) return;
    if (!ensureDeps()) return;

    loadKmlTextFromFile(file).then(function (kmlText) {
      var geoJson = parseKmlToGeoJson(kmlText);
      displayKmlOnMap(geoJson);
      var shapes = buildShapesFromGeoJson(geoJson);
      var total = shapes.points.length + shapes.lines.length + shapes.polygons.length;
      if (!total) {
        alert('표시할 수 있는 객체가 없습니다.');
        return;
      }
      var payload = {
        fileName: file.name,
        uploadedAt: new Date().toISOString(),
        featureCount: total,
        pointCount: shapes.points.length,
        lineCount: shapes.lines.length,
        polygonCount: shapes.polygons.length,
        shapes: shapes
      };
      openSiteSelectModal(payload);
    }).catch(function (err) {
      console.error('KML/KMZ 처리 실패:', err);
      alert('KML/KMZ 파일을 처리하는 데 실패했습니다: ' + (err.message || err));
    });
  }

  function bind() {
    var importBtn = document.getElementById('kml-import-btn');
    if (!importBtn) return;

    var fileInput = document.getElementById('kml-file-input');
    if (!fileInput) {
      fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.id = 'kml-file-input';
      fileInput.accept = '.kml,.kmz';
      fileInput.style.display = 'none';
      document.body.appendChild(fileInput);
    }

    importBtn.addEventListener('click', function () {
      openFilePicker(fileInput);
    });

    fileInput.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) handleKmlFile(f);
    });

    var siteOverlay = document.getElementById('kml-site-overlay');
    var siteDialog = document.getElementById('kml-site-dialog');
    if (siteOverlay) {
      siteOverlay.addEventListener('click', function (e) {
        if (e.target === siteOverlay) {
          closeSiteSelectModal();
        }
      });
    }
    if (siteDialog) {
      siteDialog.addEventListener('click', function (e) {
        e.stopPropagation();
      });
    }
  }

  MWMAP.kmlImport = { bind: bind };
})(window.MWMAP);

