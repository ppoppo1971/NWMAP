'use strict';

/**
 * KML/KMZ 가져오기 → GeoJSON 변환 → 화면 표시 → 현장별로 Firebase에 요약 데이터 저장
 * - 화면 표시/파싱: @참조_WMAP 의 KML 처리 방식을 참조
 * - 업로드: 현장별 kmlBySite[siteId] 필드에 points/lines/polygons 요약 구조 저장
 * - 실제 렌더링 재사용은 추후 별도 모듈에서 확장 가능
 */
(function (MWMAP) {
  var _latestGeoJson = null;
  var _renderedMarkers = [];
  var _renderedLines = [];
  var _renderedPolygons = [];
  var _currentInfoWindow = null;
  var _mapClickCloseListener = null;
  var _latestData = null;
  var _selectedSiteId = null;
  var _isManualMarkerMode = false;
  var _manualMarkersTemp = [];
  var _renderedManualMarkers = [];
  var _mapClickManualListener = null;
  var _isManualRouteMode = false;
  var _manualRoutePointsTemp = [];
  var _renderedManualRoutes = [];
  var _mapClickManualRouteListener = null;
  var _manualRouteTempLine = null;
  var _longPressTempMarker = null;
  var _renderedSiteSummaryMarkers = [];
  var _sitesMeta = [];
  var _activePhotoSiteId = null;
  var _activePhotoDocId = null;
  var _activePhotoData = null;

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
    // Folder 이름(마커/경로 등)을 ExtendedData.layer 로 태깅
    try {
      tagFolderLayersForManualObjects(kmlDoc);
    } catch (e) {
      console.warn('Folder 레이어 태깅 중 오류 (무시 가능):', e);
    }
    var geoJson = toGeoJSON.kml(kmlDoc);
    if (!geoJson || !Array.isArray(geoJson.features) || !geoJson.features.length) {
      throw new Error('KML 파일에 유효한 데이터가 없습니다.');
    }
    return geoJson;
  }

  // KML의 Folder 이름(예: 마커, 경로)을 이용해
  // 해당 Folder 아래의 Placemark 들에 ExtendedData/Data name="layer" 값을 주입
  // → toGeoJSON 변환 후 properties.layer 로 활용
  function tagFolderLayersForManualObjects(doc) {
    if (!doc || !doc.getElementsByTagName) return;
    var folders = doc.getElementsByTagName('Folder');
    if (!folders || !folders.length) return;

    for (var i = 0; i < folders.length; i++) {
      var folder = folders[i];
      if (!folder) continue;
      var nameEls = folder.getElementsByTagName('name');
      if (!nameEls || !nameEls.length) continue;
      var folderName = (nameEls[0].textContent || '').trim();
      if (!folderName) continue;

      var lower = folderName.toLowerCase();
      var layerTag = null;
      if (lower === '마커' || lower === 'marker') {
        layerTag = 'marker';
      } else if (lower === '경로' || lower === 'route') {
        layerTag = 'route';
      }
      if (!layerTag) continue;

      var placemarks = folder.getElementsByTagName('Placemark');
      for (var j = 0; j < placemarks.length; j++) {
        var pm = placemarks[j];
        if (!pm) continue;
        var ext = pm.getElementsByTagName('ExtendedData')[0];
        if (!ext) {
          ext = doc.createElement('ExtendedData');
          pm.appendChild(ext);
        }
        var foundLayer = false;
        var dataEls = ext.getElementsByTagName('Data');
        for (var k = 0; k < dataEls.length; k++) {
          var d = dataEls[k];
          if (d.getAttribute && d.getAttribute('name') === 'layer') {
            var valEls = d.getElementsByTagName('value');
            if (valEls && valEls.length) {
              valEls[0].textContent = layerTag;
            } else {
              var v = doc.createElement('value');
              v.textContent = layerTag;
              d.appendChild(v);
            }
            foundLayer = true;
            break;
          }
        }
        if (!foundLayer) {
          var dataEl = doc.createElement('Data');
          dataEl.setAttribute('name', 'layer');
          var valueEl = doc.createElement('value');
          valueEl.textContent = layerTag;
          dataEl.appendChild(valueEl);
          ext.appendChild(dataEl);
        }
      }
    }
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
      if (window.MWMAP && window.MWMAP._skipOverlayClickOnce) {
        window.MWMAP._skipOverlayClickOnce = false;
        return;
      }
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
        maxWidth: 320,
        disableAutoPan: true
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

  function clearRenderedFromFirestore() {
    _renderedMarkers.forEach(function (m) {
      if (m && m.setMap) m.setMap(null);
    });
    _renderedLines.forEach(function (l) {
      if (l && l.setMap) l.setMap(null);
    });
    _renderedPolygons.forEach(function (p) {
      if (p && p.setMap) p.setMap(null);
    });
    _renderedMarkers = [];
    _renderedLines = [];
    _renderedPolygons = [];
    _renderedManualMarkers.forEach(function (m) {
      if (m && m.setMap) m.setMap(null);
    });
    _renderedManualMarkers = [];
    _renderedManualRoutes.forEach(function (r) {
      if (r && r.setMap) r.setMap(null);
    });
    _renderedManualRoutes = [];
    if (_manualRouteTempLine && _manualRouteTempLine.setMap) {
      _manualRouteTempLine.setMap(null);
    }
    _manualRouteTempLine = null;
    if (_longPressTempMarker && _longPressTempMarker.setMap) {
      _longPressTempMarker.setMap(null);
    }
    _longPressTempMarker = null;
  }

  function handleMapLongPress(latLng) {
    var map = MWMAP.map;
    var geocoder = MWMAP.geocoder;
    if (!map) return;
    if (_isManualMarkerMode || _isManualRouteMode) return;

    if (_currentInfoWindow) {
      _currentInfoWindow.close();
      _currentInfoWindow = null;
    }
    if (_longPressTempMarker && _longPressTempMarker.setMap) {
      _longPressTempMarker.setMap(null);
    }

    _longPressTempMarker = new google.maps.Marker({
      position: latLng,
      map: map,
      zIndex: 1000,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 5,
        fillColor: '#3b82f6',
        fillOpacity: 1,
        strokeColor: '#ffffff',
        strokeWeight: 2
      }
    });

    function openInfo(addressText) {
      var lat = typeof latLng.lat === 'function' ? latLng.lat() : latLng.lat;
      var lng = typeof latLng.lng === 'function' ? latLng.lng() : latLng.lng;
      var idSuffix = String(Date.now());
      var addr = addressText || '주소를 찾을 수 없습니다.';
      var html =
        '<div style="padding:12px;max-width:260px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;">' +
        '<div style="font-size:13px;color:#111827;margin-bottom:8px;">' + addr + '</div>' +
        '<button id="longpress-create-marker-' + idSuffix + '" ' +
        'style="width:100%;padding:8px 10px;border:none;border-radius:8px;background:linear-gradient(135deg,#ef4444,#b91c1c);color:#fff;font-size:13px;font-weight:500;cursor:pointer;margin-bottom:6px;">마커 생성</button>' +
        '<button id="longpress-take-photo-' + idSuffix + '" ' +
        'style="width:100%;padding:8px 10px;border:none;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;font-size:13px;font-weight:500;cursor:pointer;">사진 촬영</button>' +
        '<input type="file" id="longpress-file-input-' + idSuffix + '" accept="image/*" capture="environment" style="display:none;" />' +
        '</div>';

      if (_currentInfoWindow) {
        _currentInfoWindow.close();
      }
      _currentInfoWindow = new google.maps.InfoWindow({
        content: html,
        position: latLng,
        maxWidth: 280,
        disableAutoPan: true
      });
      _currentInfoWindow.open(map, _longPressTempMarker);

      if (_mapClickCloseListener && google && google.maps && google.maps.event) {
        google.maps.event.removeListener(_mapClickCloseListener);
        _mapClickCloseListener = null;
      }
      _mapClickCloseListener = google.maps.event.addListener(map, 'click', function () {
        if (MWMAP._skipMapClickCloseOnce) {
          MWMAP._skipMapClickCloseOnce = false;
          return;
        }
        if (_currentInfoWindow) {
          _currentInfoWindow.close();
          _currentInfoWindow = null;
        }
        if (_longPressTempMarker) {
          _longPressTempMarker.setMap(null);
          _longPressTempMarker = null;
        }
      });

      if (google && google.maps && google.maps.event) {
        google.maps.event.addListenerOnce(_currentInfoWindow, 'domready', function () {
          var btn = document.getElementById('longpress-create-marker-' + idSuffix);
          var photoBtn = document.getElementById('longpress-take-photo-' + idSuffix);
          var fileInput = document.getElementById('longpress-file-input-' + idSuffix);

          if (btn) {
            btn.addEventListener('click', function () {
              if (_currentInfoWindow) {
                _currentInfoWindow.close();
                _currentInfoWindow = null;
              }
              if (_longPressTempMarker) {
                _longPressTempMarker.setMap(null);
                _longPressTempMarker = null;
              }
              var markers = [{
                lat: lat,
                lng: lng,
                title: '',
                description: '',
                createdAt: new Date().toISOString()
              }];
              if (_selectedSiteId) {
                saveManualMarkersForSite(_selectedSiteId, markers);
              } else {
                openSiteSelectModalForManualMarkers(markers);
              }
            });
          }

          if (photoBtn && fileInput) {
            photoBtn.addEventListener('click', function () {
              fileInput.click();
            });

            fileInput.addEventListener('change', function (e) {
              var file = e.target.files[0];
              if (!file) return;

              var reader = new FileReader();
              reader.onload = function (event) {
                var img = new Image();
                img.onload = function () {
                  var canvas = document.createElement('canvas');
                  var ctx = canvas.getContext('2d');
                  
                  // 최대 크기 800px로 제한
                  var MAX_SIZE = 800;
                  var width = img.width;
                  var height = img.height;
                  
                  if (width > height) {
                    if (width > MAX_SIZE) {
                      height *= MAX_SIZE / width;
                      width = MAX_SIZE;
                    }
                  } else {
                    if (height > MAX_SIZE) {
                      width *= MAX_SIZE / height;
                      height = MAX_SIZE;
                    }
                  }
                  
                  canvas.width = width;
                  canvas.height = height;
                  ctx.drawImage(img, 0, 0, width, height);
                  
                  // 품질 0.5 (50%) 압축 적용
                  var base64Data = canvas.toDataURL('image/jpeg', 0.5);
                  
                  // 1MB Firestore 안전을 위해 대략적인 텍스트 크기 확인 (~333333 글자 이내)
                  if (base64Data.length > 400000) {
                    alert('사진 용량이 너무 큽니다. Firestore 한도 방지를 위해 더 작은 사진을 선택해 주세요.');
                    return;
                  }

                  if (_currentInfoWindow) {
                    _currentInfoWindow.close();
                    _currentInfoWindow = null;
                  }
                  if (_longPressTempMarker) {
                    _longPressTempMarker.setMap(null);
                    _longPressTempMarker = null;
                  }

                  var markers = [{
                    lat: lat,
                    lng: lng,
                    title: '사진 메모',
                    description: '',
                    isPhoto: true,
                    base64Data: base64Data,
                    createdAt: new Date().toISOString()
                  }];
                  if (_selectedSiteId) {
                    saveManualMarkersForSite(_selectedSiteId, markers);
                  } else {
                    openSiteSelectModalForManualMarkers(markers);
                  }
                };
                img.src = event.target.result;
              };
              reader.readAsDataURL(file);
            });
          }
        });
      }
    }

    if (geocoder && geocoder.geocode) {
      geocoder.geocode({ location: latLng }, function (results, status) {
        if (status === 'OK' && results && results.length) {
          openInfo(results[0].formatted_address || '');
        } else {
          openInfo('');
        }
      });
    } else {
      openInfo('');
    }
  }

  function buildShapesFromGeoJson(geoJson) {
    var shapes = { points: [], lines: [], polygons: [] };
    var manualMarkers = [];
    var manualRoutes = [];
    if (!geoJson || !Array.isArray(geoJson.features)) {
      return { shapes: shapes, manualMarkers: manualMarkers, manualRoutes: manualRoutes };
    }

    geoJson.features.forEach(function (f) {
      if (!f || !f.geometry) return;
      var g = f.geometry;
      var props = f.properties || {};
      var layer = (props.layer || props.LAYER || '').toString().toLowerCase();

      if (g.type === 'Point') {
        var c = g.coordinates;
        if (Array.isArray(c) && c.length >= 2) {
          var latP = c[1];
          var lngP = c[0];
          var blkName = (props.BlkName || props.blockName || '').toString().trim();
          var isBlockPoint = blkName.length > 0;
          var isText = !isBlockPoint && !!(props.name || props.description);
          var pointType = isBlockPoint ? 'blockPoint' : (isText ? 'text' : 'point');
          var pointObj = {
            lat: latP,
            lng: lngP,
            type: pointType,
            title: props.name || '',
            description: props.description || ''
          };
          if (isBlockPoint) {
            pointObj.blockName = blkName;
          }

          // DXF → KML에서 마커용 레이어(MARKER/마커 등)인 경우: 수동 마커로 취급
          if (layer === 'marker' || layer === '마커') {
            manualMarkers.push({
              lat: latP,
              lng: lngP,
              title: pointObj.title,
              description: pointObj.description,
              createdAt: new Date().toISOString()
            });
          } else {
            shapes.points.push(pointObj);
          }
        }
      } else if (g.type === 'LineString') {
        var coords = Array.isArray(g.coordinates) ? g.coordinates.slice() : [];
        if (coords.length >= 2) {
          var pathArr = coords.map(function (p) { return { lat: p[1], lng: p[0] }; });
          // DXF → KML에서 경로용 레이어(ROUTE/경로 등)인 경우: 수동 경로로 취급
          if (layer === 'route' || layer === '경로') {
            manualRoutes.push({
              path: pathArr,
              title: props.name || '',
              description: props.description || '',
              createdAt: new Date().toISOString()
            });
          } else {
            shapes.lines.push({
              path: pathArr,
              name: props.name || '',
              description: props.description || '',
              color: props.stroke || '#3b82f6'
            });
          }
        }
      } else if (g.type === 'Polygon' && Array.isArray(g.coordinates) && g.coordinates.length) {
        var ring = g.coordinates[0] || [];
        if (ring.length >= 4) {
          shapes.polygons.push({
            path: ring.map(function (p) { return { lat: p[1], lng: p[0] }; }),
            type: 'block',
            name: props.name || '',
            description: props.description || '',
            color: props.stroke || '#3b82f6'
          });
        }
      }
    });

    return {
      shapes: shapes,
      manualMarkers: manualMarkers,
      manualRoutes: manualRoutes
    };
  }

  // =============================================
  // 초록색 요약 마커: 앱 시작 시 전체 현장 위치 표시
  // =============================================
  function renderSiteSummaryMarkers(sites) {
    _sitesMeta = sites || [];
    // 기존 초록색 요약 마커 정리
    _renderedSiteSummaryMarkers.forEach(function (m) {
      if (m && m.setMap) m.setMap(null);
    });
    _renderedSiteSummaryMarkers = [];

    var map = MWMAP.map;
    if (!map || !google || !google.maps) return;

    _sitesMeta.forEach(function (site) {
      if (!site || !site.id) return;
      // 좌표가 없으면 초록색 원을 찍지 않음
      if (typeof site.centerLat !== 'number' || typeof site.centerLng !== 'number') return;

      var pos = { lat: site.centerLat, lng: site.centerLng };
      var isSelected = (_selectedSiteId === site.id);

      var marker = new google.maps.Marker({
        map: isSelected ? null : map,  // 선택된 현장은 초록색 원 숨김
        position: pos,
        title: (site.title || '(이름 없음)') + ' (현장)',
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: '#10b981',
          fillOpacity: 0.9,
          strokeColor: '#ffffff',
          strokeWeight: 2
        }
      });

      marker.__siteId = site.id;

      marker.addListener('click', function () {
        if (window.MWMAP && window.MWMAP._skipOverlayClickOnce) {
          window.MWMAP._skipOverlayClickOnce = false;
          return;
        }
        focusSite(site.id);
      });

      _renderedSiteSummaryMarkers.push(marker);
    });
  }

  /**
   * 현재 활성화된 현장 데이터(KML, 마커, 경로)를 지도에서 모두 제거
   */
  function clearActiveSite() {
    clearRenderedFromFirestore();
    _selectedSiteId = null;
    _latestData = null;
    // 초록색 요약 마커 다시 모두 보이기
    _renderedSiteSummaryMarkers.forEach(function (m) {
      if (m && m.setMap) m.setMap(MWMAP.map);
    });

    var versionLabel = document.getElementById('version-label');
    if (versionLabel) versionLabel.textContent = '';
  }

  function openPhotoModal(markerData) {
    var overlay = document.getElementById('photo-modal-overlay');
    var img = document.getElementById('photo-modal-img');
    var title = document.getElementById('photo-modal-title');
    var memo = document.getElementById('photo-modal-memo');
    if (!overlay || !img || !title) return;

    _activePhotoSiteId = markerData.__siteId || _selectedSiteId;
    _activePhotoDocId = markerData.__photoDocId || null;
    _activePhotoData = markerData;

    img.src = markerData.base64Data || '';
    title.textContent = markerData.title || '';
    if (memo) {
      memo.value = markerData.description || '';
    }
    overlay.classList.add('show');
  }

  function closePhotoModal() {
    var overlay = document.getElementById('photo-modal-overlay');
    if (overlay) overlay.classList.remove('show');
  }

  // Firestore에서 읽어온 kmlBySite 데이터를 기반으로
  // 1) 모든 현장에 대한 대표 원(클러스터) 표시
  // 2) 선택된 현장(_selectedSiteId)에 대해서만 세부 도형(KML shapes) 렌더링
  function renderFromFirestoreData(data) {
    _latestData = data || null;
    clearRenderedFromFirestore();
    if (!data) return;
    var map = MWMAP.map;
    if (!map || !google || !google.maps) return;

    // 1) 모든 현장에 대해 대표 원(클러스터)만 먼저 그림 (KML, 수동 마커, 수동 경로 중 하나라도 있는 현장)
    var siteIds = {};
    if (data.kmlBySite) {
      Object.keys(data.kmlBySite).forEach(function(id) { siteIds[id] = true; });
    }
    if (data.manualMarkersBySite) {
      Object.keys(data.manualMarkersBySite).forEach(function(id) { siteIds[id] = true; });
    }
    if (data.manualRoutesBySite) {
      Object.keys(data.manualRoutesBySite).forEach(function(id) { siteIds[id] = true; });
    }

    Object.keys(siteIds).forEach(function (siteId) {
      var kmlPayload = data.kmlBySite && data.kmlBySite[siteId];
      var manualMarkersPayload = data.manualMarkersBySite && data.manualMarkersBySite[siteId];
      var manualRoutesPayload = data.manualRoutesBySite && data.manualRoutesBySite[siteId];

      var bounds = new google.maps.LatLngBounds();
      var hasAny = false;

      // Extract coords from KML
      if (kmlPayload && kmlPayload.shapes) {
        var shapes = kmlPayload.shapes;
        (shapes.points || []).forEach(function (pt) {
          if (typeof pt.lat !== 'number' || typeof pt.lng !== 'number') return;
          bounds.extend(new google.maps.LatLng(pt.lat, pt.lng));
          hasAny = true;
        });
        (shapes.lines || []).forEach(function (ln) {
          if (!Array.isArray(ln.path)) return;
          ln.path.forEach(function (p) {
            if (typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
            bounds.extend(new google.maps.LatLng(p.lat, p.lng));
            hasAny = true;
          });
        });
        (shapes.polygons || []).forEach(function (pg) {
          if (!Array.isArray(pg.path)) return;
          pg.path.forEach(function (p) {
            if (typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
            bounds.extend(new google.maps.LatLng(p.lat, p.lng));
            hasAny = true;
          });
        });
      }

      // Extract coords from manual markers
      if (manualMarkersPayload && Array.isArray(manualMarkersPayload.markers)) {
        manualMarkersPayload.markers.forEach(function (mm) {
          if (mm && typeof mm.lat === 'number' && typeof mm.lng === 'number') {
            bounds.extend(new google.maps.LatLng(mm.lat, mm.lng));
            hasAny = true;
          }
        });
      }

      // Extract coords from manual routes
      if (manualRoutesPayload && Array.isArray(manualRoutesPayload.routes)) {
        manualRoutesPayload.routes.forEach(function (rt) {
          if (rt && Array.isArray(rt.path)) {
            rt.path.forEach(function (p) {
              if (p && typeof p.lat === 'number' && typeof p.lng === 'number') {
                bounds.extend(new google.maps.LatLng(p.lat, p.lng));
                hasAny = true;
              }
            });
          }
        });
      }

      if (!hasAny) return;
      var center = bounds.getCenter();

      var isSelected = _selectedSiteId && _selectedSiteId === siteId;
      var title = '현장 (대표)';
      
      // Attempt to get title from kml fileName or customSchedules
      if (kmlPayload && kmlPayload.fileName) {
        title = kmlPayload.fileName + ' (대표)';
      }
      if (data.customSchedules && Array.isArray(data.customSchedules)) {
        for (var i = 0; i < data.customSchedules.length; i++) {
          if (data.customSchedules[i] && data.customSchedules[i].id === siteId && data.customSchedules[i].title) {
            title = data.customSchedules[i].title + ' (대표)';
            break;
          }
        }
      }

      var marker = new google.maps.Marker({
        // 선택된 현장의 경우 대표 원은 숨김
        map: isSelected ? null : map,
        position: center,
        title: title,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: '#10b981',
          fillOpacity: 0.9,
          strokeColor: '#ffffff',
          strokeWeight: 2
        }
      });

      marker.addListener('click', function () {
        if (window.MWMAP && window.MWMAP._skipOverlayClickOnce) {
          window.MWMAP._skipOverlayClickOnce = false;
          return;
        }
        _selectedSiteId = siteId;
        // 선택된 현장 영역으로 확대
        map.fitBounds(bounds);
        // 선택 변경 시 세부 도형/대표 원 상태를 다시 렌더링
        renderFromFirestoreData(_latestData || {});
      });

      _renderedMarkers.push(marker);
    });

    // 2) 선택된 현장이 있으면, 그 현장의 세부 도형(KML) + 수동 마커/경로 렌더링 (KML 없어도 수동 데이터만 있으면 진입)
    var hasKml = data.kmlBySite && data.kmlBySite[_selectedSiteId] && data.kmlBySite[_selectedSiteId].shapes;
    var hasManualMarkers = data.manualMarkersBySite && data.manualMarkersBySite[_selectedSiteId] &&
      Array.isArray(data.manualMarkersBySite[_selectedSiteId].markers) && data.manualMarkersBySite[_selectedSiteId].markers.length > 0;
    var hasManualRoutes = data.manualRoutesBySite && data.manualRoutesBySite[_selectedSiteId] &&
      Array.isArray(data.manualRoutesBySite[_selectedSiteId].routes) && data.manualRoutesBySite[_selectedSiteId].routes.length > 0;

    if (_selectedSiteId && (hasKml || hasManualMarkers || hasManualRoutes)) {
      // 공통 InfoWindow 닫기/맵 클릭 리스너 설정 함수
      function openInfoWindowAt(latLng, html, onDomReady) {
        if (!latLng) return;
        if (_currentInfoWindow) {
          _currentInfoWindow.close();
        }
        _currentInfoWindow = new google.maps.InfoWindow({
          content: html,
          position: latLng,
          maxWidth: 320,
          disableAutoPan: true
        });

        // 축척 조정: 현재 줌이 기준보다 작으면 확대 (기준 20)
        var targetZoom = 20;
        var currentZoom = map.getZoom();
        if (typeof currentZoom === 'number' && currentZoom < targetZoom) {
          map.setZoom(targetZoom);
        }
        map.setCenter(latLng);
        _currentInfoWindow.open(map);

        if (onDomReady && google && google.maps && google.maps.event) {
          google.maps.event.addListenerOnce(_currentInfoWindow, 'domready', function () {
            try {
              onDomReady();
            } catch (e) {
              console.warn('InfoWindow domready handler error:', e);
            }
          });
        }

        // 지도 다른 곳 클릭 시 InfoWindow 닫기
        if (_mapClickCloseListener) {
          google.maps.event.removeListener(_mapClickCloseListener);
          _mapClickCloseListener = null;
        }
        _mapClickCloseListener = google.maps.event.addListener(map, 'click', function () {
          if (_currentInfoWindow) {
            _currentInfoWindow.close();
            _currentInfoWindow = null;
          }
        });
      }

      if (hasKml) {
        var payloadSel = data.kmlBySite[_selectedSiteId];
        var shapesSel = payloadSel && payloadSel.shapes ? payloadSel.shapes : { points: [], lines: [], polygons: [] };
      (shapesSel.points || []).forEach(function (pt, pIdx) {
        if (typeof pt.lat !== 'number' || typeof pt.lng !== 'number') return;
        var pos = { lat: pt.lat, lng: pt.lng };
        var isText = pt.type === 'text';
        var isBlockPoint = pt.type === 'blockPoint';
        var scale = isText ? 4.8 : 2.5;
        var fillColor = isBlockPoint ? '#0d9488' : (isText ? '#8b5cf6' : '#facc15'); // 블록: 청녹, 텍스트: 보라, 포인트: 노랑
        var marker = new google.maps.Marker({
          map: map,
          position: pos,
          title: pt.title || '',
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: scale,
            fillColor: fillColor,
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 1
          }
        });
        if (isText) {
          marker.addListener('click', function () {
            if (window.MWMAP && window.MWMAP._skipOverlayClickOnce) {
              window.MWMAP._skipOverlayClickOnce = false;
              return;
            }
            var idSuffix = 'kml_pt_' + pIdx;
            var titleText = pt.title || '';
            var html =
              '<div style="padding:12px;max-width:280px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;">' +
              '<div style="margin-bottom:6px;">' +
              '<label style="display:block;font-size:12px;color:#4b5563;margin-bottom:2px;">제목</label>' +
              '<input id="kml-pt-title-' + idSuffix + '" type="text" ' +
              'style="width:100%;box-sizing:border-box;padding:6px 8px;font-size:13px;border:1px solid #e5e7eb;border-radius:6px;" ' +
              'value="' + titleText + '">' +
              '</div>' +
              '<div style="display:flex;gap:6px;">' +
              '<button id="kml-pt-save-' + idSuffix + '" ' +
              'style="flex:1;padding:8px 10px;border:none;border-radius:6px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;font-size:13px;font-weight:500;cursor:pointer;">저장</button>' +
              '<button id="kml-pt-delete-' + idSuffix + '" ' +
              'style="flex:1;padding:8px 10px;border:none;border-radius:6px;background:#ef4444;color:#fff;font-size:13px;font-weight:500;cursor:pointer;">삭제</button>' +
              '</div>' +
              '</div>';

            openInfoWindowAt(pos, html, function () {
              var saveBtn = document.getElementById('kml-pt-save-' + idSuffix);
              if (!saveBtn) return;
              saveBtn.addEventListener('click', function () {
                var titleInput = document.getElementById('kml-pt-title-' + idSuffix);
                var newTitle = titleInput ? titleInput.value.trim() : '';
                
                if (!window.firestore || !window.db) return;
                var fs = window.firestore;
                var kmlRef = fs.doc(window.db, 'users', 'currentUser', 'schedules', _selectedSiteId, 'data', 'kml_doc');
                
                fs.getDoc(kmlRef).then(function (snap) {
                  if (!snap || !snap.exists || !snap.exists()) return;
                  var kmlData = snap.data();
                  if (kmlData && kmlData.shapes && Array.isArray(kmlData.shapes.points)) {
                    kmlData.shapes.points[pIdx].title = newTitle;
                    return fs.setDoc(kmlRef, kmlData);
                  }
                }).then(function () {
                  if (MWMAP.sites && typeof MWMAP.sites.showSyncSuccessBadge === 'function') {
                    MWMAP.sites.showSyncSuccessBadge();
                  }
                  if (_currentInfoWindow) {
                    _currentInfoWindow.close();
                    _currentInfoWindow = null;
                  }
                  focusSite(_selectedSiteId); // 맵 다시 그리기
                }).catch(function (err) {
                  console.error('KML 포인트 저장 실패:', err);
                  alert('포인트 정보를 저장하는 데 실패했습니다.');
                });
              });

              var deleteBtn = document.getElementById('kml-pt-delete-' + idSuffix);
              if (deleteBtn) {
                deleteBtn.addEventListener('click', function () {
                  if (!confirm('이 포인트를 삭제하시겠습니까?')) return;
                  if (!window.firestore || !window.db) return;
                  var fs = window.firestore;
                  var kmlRef = fs.doc(window.db, 'users', 'currentUser', 'schedules', _selectedSiteId, 'data', 'kml_doc');
                  
                  fs.getDoc(kmlRef).then(function (snap) {
                    if (!snap || !snap.exists || !snap.exists()) return;
                    var kmlData = snap.data();
                    if (kmlData && kmlData.shapes && Array.isArray(kmlData.shapes.points)) {
                      kmlData.shapes.points.splice(pIdx, 1);
                      return fs.setDoc(kmlRef, kmlData);
                    }
                  }).then(function () {
                    if (MWMAP.sites && typeof MWMAP.sites.showSyncSuccessBadge === 'function') {
                      MWMAP.sites.showSyncSuccessBadge();
                    }
                    if (_currentInfoWindow) {
                      _currentInfoWindow.close();
                      _currentInfoWindow = null;
                    }
                    focusSite(_selectedSiteId); // 맵 다시 그리기
                  }).catch(function (err) {
                    console.error('KML 포인트 삭제 실패:', err);
                    alert('포인트를 삭제하는 데 실패했습니다.');
                  });
                });
              }
            });
          });
        } else if (isBlockPoint && (pt.blockName || pt.title)) {
          marker.addListener('click', function () {
            if (window.MWMAP && window.MWMAP._skipOverlayClickOnce) {
              window.MWMAP._skipOverlayClickOnce = false;
              return;
            }
            var blockLabel = pt.blockName || pt.title || '블록';
            var html =
              '<div style="padding:12px;max-width:280px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;">' +
              '<div style="font-weight:700;margin-bottom:6px;">' + blockLabel + '</div></div>';
            openInfoWindowAt(pos, html, null);
          });
        }
        _renderedMarkers.push(marker);
      });

      (shapesSel.lines || []).forEach(function (ln) {
        if (!Array.isArray(ln.path) || ln.path.length < 2) return;
        var path = ln.path.map(function (p) { return { lat: p.lat, lng: p.lng }; });
        var line = new google.maps.Polyline({
          map: map,
          path: path,
          strokeColor: ln.color || '#3b82f6',
          strokeOpacity: 0.9,
          strokeWeight: 2
        });
        // 선형은 선택되지 않도록 InfoWindow 리스너를 붙이지 않음
        _renderedLines.push(line);
      });

      (shapesSel.polygons || []).forEach(function (pg) {
        if (!Array.isArray(pg.path) || pg.path.length < 3) return;
        var polyPath = pg.path.map(function (p) { return { lat: p.lat, lng: p.lng }; });
        var poly = new google.maps.Polygon({
          map: map,
          paths: polyPath,
          strokeColor: pg.color || '#2563eb', // 블록: 파란색
          strokeOpacity: 0.9,
          strokeWeight: 2,
          fillColor: pg.color || '#2563eb',
          fillOpacity: 0.15
        });
        // 블록(폴리곤)은 비활성: InfoWindow 리스너를 붙이지 않음
        _renderedPolygons.push(poly);
      });
      }

      // 3) 선택된 현장에 저장된 수동 마커(빨간 원) 렌더링
      var manualMarkersBySite = (data && data.manualMarkersBySite && typeof data.manualMarkersBySite === 'object')
        ? data.manualMarkersBySite
        : null;
      if (manualMarkersBySite && manualMarkersBySite[_selectedSiteId] && Array.isArray(manualMarkersBySite[_selectedSiteId].markers)) {
        var manualList = manualMarkersBySite[_selectedSiteId].markers;
        manualList.forEach(function (mm, idx) {
          if (!mm || typeof mm.lat !== 'number' || typeof mm.lng !== 'number') return;
          var mPos = { lat: mm.lat, lng: mm.lng };
          var m = new google.maps.Marker({
            map: map,
            position: mPos,
            icon: {
              path: google.maps.SymbolPath.CIRCLE,
              scale: 4.8,
              fillColor: mm.isPhoto ? '#3b82f6' : '#ef4444', // 사진이면 파란색, 일반이면 빨간색
              fillOpacity: 1,
              strokeColor: '#ffffff',
              strokeWeight: 1
            }
          });
          // 어떤 현장의 몇 번째 마커인지 메타정보 저장
          m.__manualMeta = { siteId: _selectedSiteId, index: idx };

          // 클릭 시 정보창 + 편집
          m.addListener('click', function () {
            if (window.MWMAP && window.MWMAP._skipOverlayClickOnce) {
              window.MWMAP._skipOverlayClickOnce = false;
              return;
            }
            var meta = m.__manualMeta;
            if (!meta || !manualMarkersBySite[meta.siteId]) return;
            var currentPayload = manualMarkersBySite[meta.siteId];
            if (!currentPayload || !Array.isArray(currentPayload.markers)) return;
            if (meta.index < 0 || meta.index >= currentPayload.markers.length) return;
            var cur = currentPayload.markers[meta.index] || {};

            var idSuffix = String(meta.siteId) + '_' + String(meta.index);
            var titleText = cur.title || '';
            
            // 사진인 경우 전체화면 모달 호출
            if (cur.isPhoto) {
              openPhotoModal(cur);
              return;
            }

            var html =
              '<div style="padding:12px;max-width:280px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;">' +
              '<div style="margin-bottom:6px;">' +
              '<label style="display:block;font-size:12px;color:#4b5563;margin-bottom:2px;">새 제목</label>' +
              '<input id="manual-marker-title-' + idSuffix + '" type="text" ' +
              'style="width:100%;box-sizing:border-box;padding:6px 8px;font-size:13px;border:1px solid #e5e7eb;border-radius:6px;" ' +
              'value="' + (titleText || '') + '">' +
              '</div>' +
              '<div style="display:flex;gap:6px;">' +
              '<button id="manual-marker-save-' + idSuffix + '" ' +
              'style="flex:1;padding:8px 10px;border:none;border-radius:6px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;font-size:13px;font-weight:500;cursor:pointer;">저장</button>' +
              '<button id="manual-marker-delete-' + idSuffix + '" ' +
              'style="flex:1;padding:8px 10px;border:none;border-radius:6px;background:#ef4444;color:#fff;font-size:13px;font-weight:500;cursor:pointer;">삭제</button>' +
              '</div>' +
              '</div>';

            openInfoWindowAt(mPos, html, function () {
              var saveBtn = document.getElementById('manual-marker-save-' + idSuffix);
              var deleteBtn = document.getElementById('manual-marker-delete-' + idSuffix);
              var titleInput = document.getElementById('manual-marker-title-' + idSuffix);
              if (saveBtn) {
                saveBtn.addEventListener('click', function () {
                  var newTitle = titleInput ? titleInput.value.trim() : '';
                  if (!window.firestore || !window.db) {
                    alert('Firebase 연결이 되지 않았습니다. 잠시 후 다시 시도해 주세요.');
                    return;
                  }
                  var firestore = window.firestore;
                  var photoDocId = cur.__photoDocId;
                  if (!photoDocId) {
                    alert('이 마커는 개별 문서 ID가 없어 편집할 수 없습니다.');
                    return;
                  }
                  var ref = firestore.doc(window.db, 'users', 'currentUser', 'schedules', meta.siteId, 'photos', photoDocId);
                  firestore.updateDoc(ref, {
                    title: newTitle
                  }).then(function () {
                    if (MWMAP.sites && typeof MWMAP.sites.showSyncSuccessBadge === 'function') {
                      MWMAP.sites.showSyncSuccessBadge();
                    }
                    if (_currentInfoWindow) {
                      _currentInfoWindow.close();
                      _currentInfoWindow = null;
                    }
                    // 편집 후 현장을 다시 로드
                    focusSite(meta.siteId);
                  }).catch(function (err) {
                    console.error('수동 마커 정보 저장 실패:', err);
                    alert('마커 정보를 저장하는 데 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
                  });
                });
              }

              if (deleteBtn) {
                deleteBtn.addEventListener('click', function () {
                  if (!window.firestore || !window.db) {
                    alert('Firebase 연결이 되지 않았습니다. 잠시 후 다시 시도해 주세요.');
                    return;
                  }
                  var firestore = window.firestore;
                  var photoDocId = cur.__photoDocId;
                  if (!photoDocId) {
                    alert('이 마커는 개별 문서 ID가 없어 삭제할 수 없습니다.');
                    return;
                  }
                  var ref = firestore.doc(window.db, 'users', 'currentUser', 'schedules', meta.siteId, 'photos', photoDocId);
                  firestore.deleteDoc(ref).then(function () {
                    if (MWMAP.sites && typeof MWMAP.sites.showSyncSuccessBadge === 'function') {
                      MWMAP.sites.showSyncSuccessBadge();
                    }
                    if (_currentInfoWindow) {
                      _currentInfoWindow.close();
                      _currentInfoWindow = null;
                    }
                    // 삭제 후 현장을 다시 로드
                    focusSite(meta.siteId);
                  }).catch(function (err) {
                    console.error('수동 마커 삭제 실패:', err);
                    alert('마커를 삭제하는 데 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
                  });
                });
              }
            });
          });
          _renderedManualMarkers.push(m);
        });
      }

      // 4) 선택된 현장에 저장된 수동 경로(라인) 렌더링
      var manualRoutesBySite = (data && data.manualRoutesBySite && typeof data.manualRoutesBySite === 'object')
        ? data.manualRoutesBySite
        : null;
      if (manualRoutesBySite && manualRoutesBySite[_selectedSiteId] && Array.isArray(manualRoutesBySite[_selectedSiteId].routes)) {
        var routeList = manualRoutesBySite[_selectedSiteId].routes;
        routeList.forEach(function (rt, rIdx) {
          if (!rt || !Array.isArray(rt.path) || rt.path.length < 2) return;
          var pathLatLng = rt.path.map(function (p) {
            if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') return null;
            return { lat: p.lat, lng: p.lng };
          }).filter(function (p) { return !!p; });
          if (pathLatLng.length < 2) return;

          // 메인 수동 경로 라인 (굵은 주황색 실선)
          var line = new google.maps.Polyline({
            map: map,
            path: pathLatLng,
            strokeColor: '#f97316', // 주황색 경로
            strokeOpacity: 0.95,
            strokeWeight: 5,
            zIndex: 20
          });

          // 점선 오버레이 (흰 점 + 주황 테두리)로 하이라이트
          var dottedLine = new google.maps.Polyline({
            map: map,
            path: pathLatLng,
            strokeColor: '#ffffff',
            strokeOpacity: 0, // 기본 실선은 보이지 않게
            strokeWeight: 0,
            zIndex: 21,
            icons: [{
              icon: {
                path: google.maps.SymbolPath.CIRCLE,
                fillColor: '#ffffff',
                fillOpacity: 1,
                strokeColor: '#f97316',
                strokeWeight: 1,
                scale: 2
              },
              offset: '0',
              repeat: '16px'
            }]
          });

          line.__manualRouteMeta = { siteId: _selectedSiteId, index: rIdx };
          line.__dottedOverlay = dottedLine;

          line.addListener('click', function (event) {
            if (window.MWMAP && window.MWMAP._skipOverlayClickOnce) {
              window.MWMAP._skipOverlayClickOnce = false;
              return;
            }
            var meta = line.__manualRouteMeta;
            if (!meta || !manualRoutesBySite[meta.siteId]) return;
            var payloadSite = manualRoutesBySite[meta.siteId];
            if (!payloadSite || !Array.isArray(payloadSite.routes)) return;
            if (meta.index < 0 || meta.index >= payloadSite.routes.length) return;
            var route = payloadSite.routes[meta.index];
            if (!route || !Array.isArray(route.path) || route.path.length < 2) return;

            var lengthKm = computeRouteDistanceKm(route.path);
            var pos = event && event.latLng ? event.latLng : new google.maps.LatLng(pathLatLng[0].lat, pathLatLng[0].lng);
            var idSuffix = String(meta.siteId) + '_' + String(meta.index);

            // 경로 전체 확대 (setCenter, setZoom)
            if (google && google.maps) {
              var bounds = new google.maps.LatLngBounds();
              pathLatLng.forEach(function (p) { bounds.extend(p); });
              var targetZoom = 20;
              var currentZoom = map.getZoom();
              if (typeof currentZoom === 'number' && currentZoom < targetZoom) {
                map.setZoom(targetZoom);
              }
              map.setCenter(bounds.getCenter());
            }

            var html =
              '<div style="padding:12px;max-width:280px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;">' +
              '<div style="font-size:13px;color:#111827;margin-bottom:8px;">경로 길이: ' + lengthKm.toFixed(2) + ' km</div>' +
              '<button id="manual-route-delete-' + idSuffix + '" ' +
              'style="width:100%;padding:8px 10px;border:none;border-radius:6px;background:#ef4444;color:#fff;font-size:13px;font-weight:500;cursor:pointer;">삭제</button>' +
              '</div>';

            openInfoWindowAt(pos, html, function () {
              var delBtn = document.getElementById('manual-route-delete-' + idSuffix);
              if (!delBtn) return;
              delBtn.addEventListener('click', function () {
                if (!window.firestore || !window.db) {
                  alert('Firebase 연결이 되지 않았습니다. 잠시 후 다시 시도해 주세요.');
                  return;
                }
                var firestore = window.firestore;
                var routesDocRef = firestore.doc(window.db, 'users', 'currentUser', 'schedules', meta.siteId, 'data', 'routes_doc');
                firestore.getDoc(routesDocRef).then(function (snap) {
                  if (!snap || !snap.exists || !snap.exists()) return;
                  var dataFull = snap.data() || {};
                  var existingRoutes = Array.isArray(dataFull.routes) ? dataFull.routes : [];
                  if (meta.index < 0 || meta.index >= existingRoutes.length) return;
                  
                  var routesArr = existingRoutes.slice();
                  routesArr.splice(meta.index, 1);

                  return firestore.setDoc(routesDocRef, {
                    routes: routesArr,
                    updatedAt: new Date().toISOString()
                  });
                }).then(function () {
                  if (MWMAP.sites && typeof MWMAP.sites.showSyncSuccessBadge === 'function') {
                    MWMAP.sites.showSyncSuccessBadge();
                  }
                  if (_currentInfoWindow) {
                    _currentInfoWindow.close();
                    _currentInfoWindow = null;
                  }
                  // 삭제 후 현장을 다시 로드
                  focusSite(meta.siteId);
                }).catch(function (err) {
                  console.error('수동 경로 삭제 실패:', err);
                  alert('경로를 삭제하는 데 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
                });
              });
            });
          });

          _renderedManualRoutes.push(line);
          _renderedManualRoutes.push(dottedLine);
        });
      }
    }
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
      btn.className = 'kml-site-item-btn';
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

  function openSiteSelectModalForManualMarkers(markers) {
    var overlay = document.getElementById('kml-site-overlay');
    var listEl = document.getElementById('kml-site-list');
    if (!overlay || !listEl) return;

    if (!markers || !markers.length) return;

    var sites = getSitesForSelection();
    if (!sites.length) {
      alert('먼저 현장을 추가한 뒤 마커를 저장해 주세요.');
      return;
    }

    listEl.innerHTML = '';
    sites.forEach(function (site) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'kml-site-item-btn';
      btn.textContent = site.title || '(이름 없음)';
      btn.addEventListener('click', function () {
        saveManualMarkersForSite(site.id, markers);
      });
      listEl.appendChild(btn);
    });

    overlay.classList.add('show');
  }

  function openSiteSelectModalForManualRoute(path) {
    var overlay = document.getElementById('kml-site-overlay');
    var listEl = document.getElementById('kml-site-list');
    if (!overlay || !listEl) return;
    if (!path || !path.length) return;

    var sites = getSitesForSelection();
    if (!sites.length) {
      alert('먼저 현장을 추가한 뒤 경로를 저장해 주세요.');
      return;
    }

    listEl.innerHTML = '';
    sites.forEach(function (site) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'kml-site-item-btn';
      btn.textContent = site.title || '(이름 없음)';
      btn.addEventListener('click', function () {
        saveManualRouteForSite(site.id, path);
      });
      listEl.appendChild(btn);
    });

    overlay.classList.add('show');
  }

  /**
   * 지연 로딩(Lazy Loading) 기반 focusSite
   * 현장을 선택하면 해당 현장의 하위 서브컬렉션에서 KML, 경로, 사진을 다운로드하여 렌더링
   */
  function focusSite(siteId) {
    if (!siteId) return;
    var map = MWMAP && MWMAP.map;
    if (!map) return;
    var fs = window.firestore;
    if (!fs || !window.db) return;

    _selectedSiteId = siteId;

    // 초록색 요약 마커 상태 업데이트 (선택된 현장의 초록 원 숨기기)
    var siteTitle = '';
    _renderedSiteSummaryMarkers.forEach(function (m) {
      if (m && m.__siteId === siteId) {
        m.setMap(null);
        siteTitle = m.title ? m.title.replace(' (현장)', '') : '';
      } else if (m && m.setMap) {
        m.setMap(map);
      }
    });

    var versionLabel = document.getElementById('version-label');
    if (versionLabel) versionLabel.textContent = siteTitle;

    // 기존 세부 렌더링 제거
    clearRenderedFromFirestore();

    // 서브컬렉션에서 데이터 가져오기
    var kmlRef = fs.doc(window.db, 'users', 'currentUser', 'schedules', siteId, 'data', 'kml_doc');
    var routesRef = fs.doc(window.db, 'users', 'currentUser', 'schedules', siteId, 'data', 'routes_doc');
    var photosColRef = fs.collection(window.db, 'users', 'currentUser', 'schedules', siteId, 'photos');

    Promise.all([
      fs.getDoc(kmlRef).catch(function () { return null; }),
      fs.getDoc(routesRef).catch(function () { return null; }),
      fs.getDocs(photosColRef).catch(function () { return null; })
    ]).then(function (results) {
      var kmlSnap = results[0];
      var routesSnap = results[1];
      var photosSnap = results[2];

      // 가상 병합 데이터 구축 (기존 renderFromFirestoreData와 호환되는 형태)
      var mergedData = {
        customSchedules: _sitesMeta,
        kmlBySite: {},
        manualMarkersBySite: {},
        manualRoutesBySite: {}
      };

      if (kmlSnap && kmlSnap.exists && kmlSnap.exists()) {
        mergedData.kmlBySite[siteId] = kmlSnap.data();
      }

      if (routesSnap && routesSnap.exists && routesSnap.exists()) {
        var routesData = routesSnap.data() || {};
        mergedData.manualRoutesBySite[siteId] = {
          routes: routesData.routes || []
        };
      }

      // 사진들을 마커 형태로 통합
      var photoMarkers = [];
      if (photosSnap && photosSnap.forEach) {
        photosSnap.forEach(function (docSnap) {
          var d = docSnap.data();
          if (d) {
            d.__photoDocId = docSnap.id;
            photoMarkers.push(d);
          }
        });
      }
      if (photoMarkers.length) {
        mergedData.manualMarkersBySite[siteId] = { markers: photoMarkers };
      }

      _latestData = mergedData;

      // 데이터에 기반해 지도 렌더링
      renderFromFirestoreData(mergedData);

      // 지도 범위 조정
      var bounds = new google.maps.LatLngBounds();
      var hasAny = false;

      var kmlPayload = mergedData.kmlBySite[siteId];
      if (kmlPayload && kmlPayload.shapes) {
        var shapes = kmlPayload.shapes;
        (shapes.points || []).forEach(function (pt) {
          if (typeof pt.lat === 'number' && typeof pt.lng === 'number') {
            bounds.extend(new google.maps.LatLng(pt.lat, pt.lng)); hasAny = true;
          }
        });
        (shapes.lines || []).forEach(function (ln) {
          (ln.path || []).forEach(function (p) {
            if (typeof p.lat === 'number' && typeof p.lng === 'number') {
              bounds.extend(new google.maps.LatLng(p.lat, p.lng)); hasAny = true;
            }
          });
        });
        (shapes.polygons || []).forEach(function (pg) {
          (pg.path || []).forEach(function (p) {
            if (typeof p.lat === 'number' && typeof p.lng === 'number') {
              bounds.extend(new google.maps.LatLng(p.lat, p.lng)); hasAny = true;
            }
          });
        });
      }
      photoMarkers.forEach(function (mm) {
        if (typeof mm.lat === 'number' && typeof mm.lng === 'number') {
          bounds.extend(new google.maps.LatLng(mm.lat, mm.lng)); hasAny = true;
        }
      });
      var routesList = mergedData.manualRoutesBySite[siteId];
      if (routesList && Array.isArray(routesList.routes)) {
        routesList.routes.forEach(function (rt) {
          (rt.path || []).forEach(function (p) {
            if (typeof p.lat === 'number' && typeof p.lng === 'number') {
              bounds.extend(new google.maps.LatLng(p.lat, p.lng)); hasAny = true;
            }
          });
        });
      }

      if (hasAny) {
        map.fitBounds(bounds);
      }
    }).catch(function (err) {
      console.error('현장 데이터 로딩 실패:', err);
    });
  }

  function saveKmlForSite(siteId, payload) {
    if (!siteId || !payload) return;
    var firestore = window.firestore;
    // KML 데이터를 data/kml_doc 서브컬렉션 문서에 저장
    var kmlDocRef = firestore.doc(window.db, 'users', 'currentUser', 'schedules', siteId, 'data', 'kml_doc');
    var siteRef = firestore.doc(window.db, 'users', 'currentUser', 'schedules', siteId);

    firestore.setDoc(kmlDocRef, payload).then(function () {
      // KML 도면의 중심 좌표를 계산하여 현장 요약본에 기록 (초록색 마커용)
      var avgLat = 0, avgLng = 0, count = 0;
      if (payload.shapes) {
        var shapes = payload.shapes;
        (shapes.points || []).forEach(function (pt) {
          if (typeof pt.lat === 'number' && typeof pt.lng === 'number') {
            avgLat += pt.lat; avgLng += pt.lng; count++;
          }
        });
        (shapes.lines || []).forEach(function (ln) {
          (ln.path || []).forEach(function (p) {
            if (typeof p.lat === 'number' && typeof p.lng === 'number') {
              avgLat += p.lat; avgLng += p.lng; count++;
            }
          });
        });
        (shapes.polygons || []).forEach(function (pg) {
          (pg.path || []).forEach(function (p) {
            if (typeof p.lat === 'number' && typeof p.lng === 'number') {
              avgLat += p.lat; avgLng += p.lng; count++;
            }
          });
        });
      }
      if (count > 0) {
        return firestore.updateDoc(siteRef, {
          centerLat: avgLat / count,
          centerLng: avgLng / count,
          lastUpdated: firestore.serverTimestamp()
        });
      }
      return Promise.resolve();
    }).then(function () {
      // KML 저장 이후, KML에서 추출된 수동 마커/경로가 있다면 함께 저장
      if (payload.manualMarkersFromKml && payload.manualMarkersFromKml.length) {
        saveManualMarkersForSite(siteId, payload.manualMarkersFromKml);
      }
      if (payload.manualRoutesFromKml && payload.manualRoutesFromKml.length) {
        saveManualRouteForSite(siteId, payload.manualRoutesFromKml);
      }
      closeSiteSelectModal();
      if (MWMAP.sites && typeof MWMAP.sites.showSyncSuccessBadge === 'function') {
        MWMAP.sites.showSyncSuccessBadge();
      }
      // 로컬 KML(Data Layer)은 제거하고, Firebase 기반 객체만 남기기
      if (MWMAP.map && MWMAP.map.data) {
        MWMAP.map.data.forEach(function (feature) {
          MWMAP.map.data.remove(feature);
        });
      }
      if (MWMAP.uiMapType && typeof MWMAP.uiMapType.closePanel === 'function') {
        MWMAP.uiMapType.closePanel();
      }
      // 저장 후 해당 현장 활성화
      _selectedSiteId = siteId;
      focusSite(siteId);
    }).catch(function (err) {
      console.error('KML 저장 실패:', err);
      alert('KML 데이터를 저장하는 데 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
    });
  }

  function saveManualMarkersForSite(siteId, markers) {
    if (!siteId || !markers || !markers.length) return;
    var firestore = window.firestore;
    var photosColRef = firestore.collection(window.db, 'users', 'currentUser', 'schedules', siteId, 'photos');
    var siteRef = firestore.doc(window.db, 'users', 'currentUser', 'schedules', siteId);

    // 각 마커를 photos 서브컬렉션에 개별 문서로 저장
    var savePromises = markers.map(function (marker) {
      var photoId = 'photo_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      var docRef = firestore.doc(window.db, 'users', 'currentUser', 'schedules', siteId, 'photos', photoId);
      return firestore.setDoc(docRef, marker);
    });

    Promise.all(savePromises).then(function () {
      // 현장 본체에 중심 좌표가 없으면 첫 번째 마커 좌표를 기록
      return firestore.getDoc(siteRef);
    }).then(function (snap) {
      if (snap && snap.exists && snap.exists()) {
        var d = snap.data() || {};
        if (typeof d.centerLat !== 'number' || typeof d.centerLng !== 'number') {
          var firstMarker = markers[0];
          if (firstMarker && typeof firstMarker.lat === 'number' && typeof firstMarker.lng === 'number') {
            return firestore.updateDoc(siteRef, {
              centerLat: firstMarker.lat,
              centerLng: firstMarker.lng,
              lastUpdated: firestore.serverTimestamp()
            });
          }
        }
      }
      return Promise.resolve();
    }).then(function () {
      closeSiteSelectModal();
      if (MWMAP.sites && typeof MWMAP.sites.showSyncSuccessBadge === 'function') {
        MWMAP.sites.showSyncSuccessBadge();
      }
      // 임시 수동 마커는 저장 후 지도에서 제거
      _renderedManualMarkers.forEach(function (m) {
        if (m && m.setMap) m.setMap(null);
      });
      _renderedManualMarkers = [];
      _manualMarkersTemp = [];
      _isManualMarkerMode = false;
      if (_mapClickManualListener && google && google.maps && google.maps.event) {
        google.maps.event.removeListener(_mapClickManualListener);
        _mapClickManualListener = null;
      }
      var markerBtn = document.getElementById('add-marker-btn');
      if (markerBtn) {
        markerBtn.textContent = '마커추가';
        markerBtn.style.background = '';
        markerBtn.style.color = '';
      }
      // 저장 후 해당 현장을 다시 로드하여 표시
      _selectedSiteId = siteId;
      focusSite(siteId);
    }).catch(function (err) {
      console.error('수동 마커 저장 실패:', err);
      alert('마커 데이터를 저장하는 데 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
    });
  }

  function saveManualRouteForSite(siteId, pathOrRoutes) {
    if (!siteId || !pathOrRoutes || !pathOrRoutes.length) return;
    var firestore = window.firestore;
    var routesDocRef = firestore.doc(window.db, 'users', 'currentUser', 'schedules', siteId, 'data', 'routes_doc');

    var routesToAdd = [];
    if (Array.isArray(pathOrRoutes) && pathOrRoutes.length && typeof pathOrRoutes[0].lat === 'number') {
      routesToAdd.push({
        path: pathOrRoutes.slice(),
        title: '',
        description: '',
        createdAt: new Date().toISOString()
      });
    } else if (Array.isArray(pathOrRoutes)) {
      routesToAdd = pathOrRoutes.slice();
    }
    if (!routesToAdd.length) return;

    // 기존 routes_doc에서 기존 경로를 읽어와 합침
    firestore.getDoc(routesDocRef).then(function (snap) {
      var existingRoutes = [];
      if (snap && snap.exists && snap.exists()) {
        var d = snap.data() || {};
        existingRoutes = Array.isArray(d.routes) ? d.routes : [];
      }
      var merged = existingRoutes.concat(routesToAdd);
      return firestore.setDoc(routesDocRef, {
        routes: merged,
        updatedAt: new Date().toISOString()
      });
    }).then(function () {
      closeSiteSelectModal();
      if (MWMAP.sites && typeof MWMAP.sites.showSyncSuccessBadge === 'function') {
        MWMAP.sites.showSyncSuccessBadge();
      }
      if (_manualRouteTempLine && _manualRouteTempLine.setMap) {
        _manualRouteTempLine.setMap(null);
      }
      _manualRouteTempLine = null;
      _manualRoutePointsTemp = [];
      _isManualRouteMode = false;
      if (_mapClickManualRouteListener && google && google.maps && google.maps.event) {
        google.maps.event.removeListener(_mapClickManualRouteListener);
        _mapClickManualRouteListener = null;
      }
      var routeBtn = document.getElementById('add-route-btn');
      if (routeBtn) {
        routeBtn.textContent = '경로추가';
        routeBtn.style.background = '';
        routeBtn.style.color = '';
      }
      _selectedSiteId = siteId;
      focusSite(siteId);
    }).catch(function (err) {
      console.error('수동 경로 저장 실패:', err);
      alert('경로 데이터를 저장하는 데 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
    });
  }

  function computeRouteDistanceKm(path) {
    if (!Array.isArray(path) || path.length < 2) return 0;
    var R = 6371; // 지구 반지름 km
    var total = 0;
    for (var i = 1; i < path.length; i++) {
      var p1 = path[i - 1];
      var p2 = path[i];
      if (!p1 || !p2 || typeof p1.lat !== 'number' || typeof p1.lng !== 'number' ||
        typeof p2.lat !== 'number' || typeof p2.lng !== 'number') {
        continue;
      }
      var lat1 = p1.lat * Math.PI / 180;
      var lat2 = p2.lat * Math.PI / 180;
      var dLat = (p2.lat - p1.lat) * Math.PI / 180;
      var dLng = (p2.lng - p1.lng) * Math.PI / 180;
      var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1) * Math.cos(lat2) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
      var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      total += R * c;
    }
    return total;
  }

  function handleKmlFile(file) {
    if (!file || !file.name) return;
    if (!ensureDeps()) return;

    loadKmlTextFromFile(file).then(function (kmlText) {
      var geoJson = parseKmlToGeoJson(kmlText);
      displayKmlOnMap(geoJson);
      var parsed = buildShapesFromGeoJson(geoJson);
      var shapes = parsed.shapes || { points: [], lines: [], polygons: [] };
      var manualMarkers = parsed.manualMarkers || [];
      var manualRoutes = parsed.manualRoutes || [];
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
        shapes: shapes,
        manualMarkersFromKml: manualMarkers,
        manualRoutesFromKml: manualRoutes
      };

      // Firestore 업로드 전에 요약 데이터 크기(대략)를 사용자에게 안내
      try {
        var previewObj = {
          shapes: shapes,
          manualMarkers: manualMarkers,
          manualRoutes: manualRoutes
        };
        var jsonStr = JSON.stringify(previewObj);
        var byteSize;
        if (window.TextEncoder) {
          byteSize = new TextEncoder().encode(jsonStr).length;
        } else {
          // 대략적인 추정: 1문자 ≈ 2바이트로 계산
          byteSize = jsonStr.length * 2;
        }
        var kb = byteSize / 1024;
        var msg =
          '이 KML에서 추출된 요약 데이터의 예상 크기: ' +
          kb.toFixed(1) + ' KB\n' +
          '(Firestore 문서 한도: 약 1024 KB)\n\n' +
          '계속해서 업로드를 진행합니다.';
        alert(msg);
      } catch (e) {
        console.warn('요약 데이터 크기 계산 실패(무시 가능):', e);
      }

      openSiteSelectModal(payload);
    }).catch(function (err) {
      console.error('KML/KMZ 처리 실패:', err);
      alert('KML/KMZ 파일을 처리하는 데 실패했습니다: ' + (err.message || err));
    });
  }

  function bind() {
    var importBtn = document.getElementById('kml-import-btn');
    var manualRouteBtn = document.getElementById('add-route-btn');
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

    if (manualRouteBtn) {
      manualRouteBtn.addEventListener('click', function () {
        var map = MWMAP.map;
        if (!map || !google || !google.maps) return;

        // 이미 경로 모드인 상태에서 다시 누르면 → 종료 및 저장 플로우
        if (_isManualRouteMode) {
          _isManualRouteMode = false;
          if (_mapClickManualRouteListener && google.maps.event) {
            google.maps.event.removeListener(_mapClickManualRouteListener);
            _mapClickManualRouteListener = null;
          }
          manualRouteBtn.textContent = '경로추가';
          manualRouteBtn.style.background = '';
          manualRouteBtn.style.color = '';

          if (_manualRoutePointsTemp.length >= 2) {
            // path는 {lat,lng} 배열로 저장
            var pathToSave = _manualRoutePointsTemp.slice();
            if (_selectedSiteId) {
              saveManualRouteForSite(_selectedSiteId, pathToSave);
            } else {
              openSiteSelectModalForManualRoute(pathToSave);
            }
          } else {
            if (_manualRouteTempLine && _manualRouteTempLine.setMap) {
              _manualRouteTempLine.setMap(null);
            }
            _manualRouteTempLine = null;
            _manualRoutePointsTemp = [];
          }
          return;
        }

        // 모드가 꺼져 있으면 켜기
        _isManualRouteMode = true;
        manualRouteBtn.textContent = '경로추가 중...';
        manualRouteBtn.style.background = 'linear-gradient(135deg,#10b981,#059669)';
        manualRouteBtn.style.color = '#ffffff';

        _manualRoutePointsTemp = [];
        if (_manualRouteTempLine && _manualRouteTempLine.setMap) {
          _manualRouteTempLine.setMap(null);
        }
        _manualRouteTempLine = null;

        if (_mapClickManualRouteListener && google.maps.event) {
          google.maps.event.removeListener(_mapClickManualRouteListener);
          _mapClickManualRouteListener = null;
        }
        _mapClickManualRouteListener = google.maps.event.addListener(map, 'click', function (event) {
          if (!_isManualRouteMode) return;
          if (!event || !event.latLng) return;
          var latLng = event.latLng;
          var lat = typeof latLng.lat === 'function' ? latLng.lat() : latLng.lat;
          var lng = typeof latLng.lng === 'function' ? latLng.lng() : latLng.lng;
          if (typeof lat !== 'number' || typeof lng !== 'number') return;

          _manualRoutePointsTemp.push({ lat: lat, lng: lng });

          // 임시 라인 갱신
          if (_manualRouteTempLine && _manualRouteTempLine.setMap) {
            _manualRouteTempLine.setMap(null);
          }
          if (_manualRoutePointsTemp.length >= 2) {
            _manualRouteTempLine = new google.maps.Polyline({
              map: map,
              path: _manualRoutePointsTemp.map(function (p) { return { lat: p.lat, lng: p.lng }; }),
              strokeColor: '#f97316',
              strokeOpacity: 0.8,
              strokeWeight: 3
            });
          }
        });
      });
    }

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

    // 지도 롱프레스 이벤트 수신 → 수동 마커 생성 플로우 진입
    window.addEventListener('mwmappMapLongPress', function (e) {
      if (!e || !e.detail || !e.detail.latLng) return;
      handleMapLongPress(e.detail.latLng);
    });

    // 사진 모달 닫기 바인딩
    var photoOverlay = document.getElementById('photo-modal-overlay');
    var photoCloseBtn = document.getElementById('photo-modal-close');
    if (photoOverlay) {
      photoOverlay.addEventListener('click', function (e) {
        if (e.target === photoOverlay) closePhotoModal();
      });
    }
    if (photoCloseBtn) {
      photoCloseBtn.addEventListener('click', closePhotoModal);
    }

    // 사진 모달 메모 저장 바인딩
    var photoSaveBtn = document.getElementById('photo-modal-save-btn');
    if (photoSaveBtn) {
      photoSaveBtn.addEventListener('click', function () {
        var memoEl = document.getElementById('photo-modal-memo');
        var newMemo = memoEl ? memoEl.value.trim() : '';
        if (!_activePhotoSiteId || !_activePhotoDocId) {
          alert('수정할 사진 정보가 올바르지 않습니다.');
          return;
        }
        if (!window.firestore || !window.db) return;
        var firestore = window.firestore;
        var ref = firestore.doc(window.db, 'users', 'currentUser', 'schedules', _activePhotoSiteId, 'photos', _activePhotoDocId);
        
        firestore.updateDoc(ref, {
          description: newMemo
        }).then(function () {
          if (MWMAP.sites && typeof MWMAP.sites.showSyncSuccessBadge === 'function') {
            MWMAP.sites.showSyncSuccessBadge();
          }
          // 데이터 캐시 업데이트 및 현장 다시 로드 (필요시)
          if (_activePhotoData) _activePhotoData.description = newMemo;
          alert('메모가 저장되었습니다.');
        }).catch(function (err) {
          console.error('사진 메모 저장 실패:', err);
          alert('메모 저장에 실패했습니다.');
        });
      });
    }
  }

  MWMAP.kmlImport = {
    bind: bind,
    renderFromFirestoreData: renderFromFirestoreData,
    renderSiteSummaryMarkers: renderSiteSummaryMarkers,
    focusSite: focusSite,
    clearActiveSite: clearActiveSite
  };
})(window.MWMAP);

