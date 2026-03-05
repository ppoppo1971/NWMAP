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
        'style="width:100%;padding:8px 10px;border:none;border-radius:8px;background:linear-gradient(135deg,#ef4444,#b91c1c);color:#fff;font-size:13px;font-weight:500;cursor:pointer;">마커 생성</button>' +
        '</div>';

      if (_currentInfoWindow) {
        _currentInfoWindow.close();
      }
      _currentInfoWindow = new google.maps.InfoWindow({
        content: html,
        position: latLng,
        maxWidth: 280
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
          if (!btn) return;
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
            openSiteSelectModalForManualMarkers(markers);
          });
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
            description: props.description || '',
            blockName: isBlockPoint ? blkName : undefined
          };

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

  // Firestore에서 읽어온 kmlBySite 데이터를 기반으로
  // 1) 모든 현장에 대한 대표 원(클러스터) 표시
  // 2) 선택된 현장(_selectedSiteId)에 대해서만 세부 도형(KML shapes) 렌더링
  function renderFromFirestoreData(data) {
    _latestData = data || null;
    clearRenderedFromFirestore();
    if (!data) return;
    var map = MWMAP.map;
    if (!map || !google || !google.maps) return;

    // 1) 모든 현장에 대해 대표 원(클러스터)만 먼저 그림 (kmlBySite에 있는 현장만)
    if (data.kmlBySite && typeof data.kmlBySite === 'object') {
    Object.keys(data.kmlBySite).forEach(function (siteId) {
      var payload = data.kmlBySite[siteId];
      if (!payload || !payload.shapes) return;
      var shapes = payload.shapes;

      var bounds = new google.maps.LatLngBounds();
      var hasAny = false;

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

      if (!hasAny) return;
      var center = bounds.getCenter();

      var isSelected = _selectedSiteId && _selectedSiteId === siteId;
      var marker = new google.maps.Marker({
        // 선택된 현장의 경우 대표 원은 숨김
        map: isSelected ? null : map,
        position: center,
        title: (payload.fileName || '현장') + ' (대표)',
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
    }

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
          maxWidth: 320
        });
        _currentInfoWindow.open(map);

        // 축척 조정: 현재 줌이 기준보다 작으면 확대 (기준 20)
        var targetZoom = 20;
        var currentZoom = map.getZoom();
        if (typeof currentZoom === 'number' && currentZoom < targetZoom) {
          map.setZoom(targetZoom);
        }
        map.panTo(latLng);

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
      (shapesSel.points || []).forEach(function (pt) {
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
            var html =
              '<div style="padding:12px;max-width:280px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;">' +
              '<div style="font-weight:700;margin-bottom:6px;">' + (pt.title || '텍스트') + '</div>';
            if (pt.description) {
              html += '<div style="font-size:13px;color:#6b7280;line-height:1.4;">' +
                pt.description + '</div>';
            }
            html += '</div>';
            openInfoWindowAt(pos, html, null);
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
              scale: 4.8, // 수동 마커: 빨간색 1.2배
              fillColor: '#ef4444', // 수동 마커: 빨간색
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
            var descText = cur.description || '';

            var html =
              '<div style="padding:12px;max-width:280px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;">' +
              '<div style="margin-bottom:6px;">' +
              '<label style="display:block;font-size:12px;color:#4b5563;margin-bottom:2px;">새 제목</label>' +
              '<input id="manual-marker-title-' + idSuffix + '" type="text" ' +
              'style="width:100%;box-sizing:border-box;padding:6px 8px;font-size:13px;border:1px solid #e5e7eb;border-radius:6px;" ' +
              'value="' + (titleText || '') + '">' +
              '</div>' +
              '<div style="margin-bottom:8px;">' +
              '<label style="display:block;font-size:12px;color:#4b5563;margin-bottom:2px;">LINK</label>' +
              '<textarea id="manual-marker-desc-' + idSuffix + '" ' +
              'style="width:100%;box-sizing:border-box;padding:6px 8px;font-size:13px;border:1px solid #e5e7eb;border-radius:6px;min-height:60px;">' +
              (descText || '') + '</textarea>' +
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
              var descInput = document.getElementById('manual-marker-desc-' + idSuffix);
              if (saveBtn) {
                saveBtn.addEventListener('click', function () {
                  var newTitle = titleInput ? titleInput.value.trim() : '';
                  var newDesc = descInput ? descInput.value.trim() : '';
                  if (!window.firestore || !window.db) {
                    alert('Firebase 연결이 되지 않았습니다. 잠시 후 다시 시도해 주세요.');
                    return;
                  }
                  var firestore = window.firestore;
                  var ref = firestore.doc(window.db, 'users', 'currentUser');
                  firestore.getDoc(ref).then(function (snap) {
                    if (!snap.exists()) return;
                    var dataFull = snap.data() || {};
                    var bySite = dataFull.manualMarkersBySite || {};
                    var payloadSite = bySite[meta.siteId];
                    if (!payloadSite || !Array.isArray(payloadSite.markers)) return;
                    if (meta.index < 0 || meta.index >= payloadSite.markers.length) return;
                    var markersArr = payloadSite.markers.slice();
                    var target = markersArr[meta.index] || {};
                    var updatedMarker = {};
                    for (var k in target) {
                      if (Object.prototype.hasOwnProperty.call(target, k)) {
                        updatedMarker[k] = target[k];
                      }
                    }
                    updatedMarker.title = newTitle;
                    updatedMarker.description = newDesc;
                    markersArr[meta.index] = updatedMarker;

                    var updateData = {};
                    updateData['manualMarkersBySite.' + meta.siteId] = {
                      markers: markersArr,
                      updatedAt: new Date().toISOString()
                    };
                    updateData.lastUpdated = firestore.serverTimestamp();
                    return firestore.updateDoc(ref, updateData);
                  }).then(function () {
                    if (MWMAP.sites && typeof MWMAP.sites.showSyncSuccessBadge === 'function') {
                      MWMAP.sites.showSyncSuccessBadge();
                    }
                    if (_currentInfoWindow) {
                      _currentInfoWindow.close();
                      _currentInfoWindow = null;
                    }
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
                  var ref = firestore.doc(window.db, 'users', 'currentUser');
                  firestore.getDoc(ref).then(function (snap) {
                    if (!snap.exists()) return;
                    var dataFull = snap.data() || {};
                    var bySite = dataFull.manualMarkersBySite || {};
                    var payloadSite = bySite[meta.siteId];
                    if (!payloadSite || !Array.isArray(payloadSite.markers)) return;
                    var markersArr = payloadSite.markers.slice();
                    if (meta.index < 0 || meta.index >= markersArr.length) return;
                    markersArr.splice(meta.index, 1);

                    var updateData = {};
                    updateData['manualMarkersBySite.' + meta.siteId] = {
                      markers: markersArr,
                      updatedAt: new Date().toISOString()
                    };
                    updateData.lastUpdated = firestore.serverTimestamp();
                    return firestore.updateDoc(ref, updateData);
                  }).then(function () {
                    if (MWMAP.sites && typeof MWMAP.sites.showSyncSuccessBadge === 'function') {
                      MWMAP.sites.showSyncSuccessBadge();
                    }
                    if (m && m.setMap) {
                      m.setMap(null);
                    }
                    var idxRendered = _renderedManualMarkers.indexOf(m);
                    if (idxRendered > -1) {
                      _renderedManualMarkers.splice(idxRendered, 1);
                    }
                    if (_currentInfoWindow) {
                      _currentInfoWindow.close();
                      _currentInfoWindow = null;
                    }
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
                var ref = firestore.doc(window.db, 'users', 'currentUser');
                firestore.getDoc(ref).then(function (snap) {
                  if (!snap.exists()) return;
                  var dataFull = snap.data() || {};
                  var bySite = dataFull.manualRoutesBySite || {};
                  var payloadSiteFull = bySite[meta.siteId];
                  if (!payloadSiteFull || !Array.isArray(payloadSiteFull.routes)) return;
                  var routesArr = payloadSiteFull.routes.slice();
                  if (meta.index < 0 || meta.index >= routesArr.length) return;
                  routesArr.splice(meta.index, 1);

                  var updateData = {};
                  updateData['manualRoutesBySite.' + meta.siteId] = {
                    routes: routesArr,
                    updatedAt: new Date().toISOString()
                  };
                  updateData.lastUpdated = firestore.serverTimestamp();
                  return firestore.updateDoc(ref, updateData);
                }).then(function () {
                  if (MWMAP.sites && typeof MWMAP.sites.showSyncSuccessBadge === 'function') {
                    MWMAP.sites.showSyncSuccessBadge();
                  }
                  if (line && line.setMap) {
                    line.setMap(null);
                  }
                  if (line.__dottedOverlay && line.__dottedOverlay.setMap) {
                    line.__dottedOverlay.setMap(null);
                  }
                  var idxRendered = _renderedManualRoutes.indexOf(line);
                  if (idxRendered > -1) {
                    _renderedManualRoutes.splice(idxRendered, 1);
                  }
                  var idxDot = _renderedManualRoutes.indexOf(dottedLine);
                  if (idxDot > -1) {
                    _renderedManualRoutes.splice(idxDot, 1);
                  }
                  if (_currentInfoWindow) {
                    _currentInfoWindow.close();
                    _currentInfoWindow = null;
                  }
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

  function focusSite(siteId) {
    if (!siteId || !_latestData) return;
    var map = MWMAP && MWMAP.map;
    if (!map) return;

    var bounds = new google.maps.LatLngBounds();
    var hasAny = false;

    var sitePayload = _latestData.kmlBySite && _latestData.kmlBySite[siteId];
    var shapesSel = sitePayload && sitePayload.shapes ? sitePayload.shapes : null;
    if (shapesSel) {
      (shapesSel.points || []).forEach(function (pt) {
        if (!pt || typeof pt.lat !== 'number' || typeof pt.lng !== 'number') return;
        hasAny = true;
        bounds.extend(new google.maps.LatLng(pt.lat, pt.lng));
      });
      (shapesSel.lines || []).forEach(function (ln) {
        if (!Array.isArray(ln.path)) return;
        ln.path.forEach(function (p) {
          if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
          hasAny = true;
          bounds.extend(new google.maps.LatLng(p.lat, p.lng));
        });
      });
      (shapesSel.polygons || []).forEach(function (pg) {
        if (!Array.isArray(pg.path)) return;
        pg.path.forEach(function (p) {
          if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
          hasAny = true;
          bounds.extend(new google.maps.LatLng(p.lat, p.lng));
        });
      });
    }

    if (!hasAny && _latestData.manualMarkersBySite && _latestData.manualMarkersBySite[siteId] && Array.isArray(_latestData.manualMarkersBySite[siteId].markers)) {
      _latestData.manualMarkersBySite[siteId].markers.forEach(function (mm) {
        if (mm && typeof mm.lat === 'number' && typeof mm.lng === 'number') {
          hasAny = true;
          bounds.extend(new google.maps.LatLng(mm.lat, mm.lng));
        }
      });
    }
    if (!hasAny && _latestData.manualRoutesBySite && _latestData.manualRoutesBySite[siteId] && Array.isArray(_latestData.manualRoutesBySite[siteId].routes)) {
      _latestData.manualRoutesBySite[siteId].routes.forEach(function (rt) {
        if (!rt || !Array.isArray(rt.path)) return;
        rt.path.forEach(function (p) {
          if (p && typeof p.lat === 'number' && typeof p.lng === 'number') {
            hasAny = true;
            bounds.extend(new google.maps.LatLng(p.lat, p.lng));
          }
        });
      });
    }

    _selectedSiteId = siteId;
    if (hasAny) {
      map.fitBounds(bounds);
    }
    renderFromFirestoreData(_latestData);
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
      // KML 저장 후 오른쪽 지도종류 패널도 자동으로 닫기
      if (MWMAP.uiMapType && typeof MWMAP.uiMapType.closePanel === 'function') {
        MWMAP.uiMapType.closePanel();
      }
    }).catch(function (err) {
      console.error('KML 저장 실패:', err);
      alert('KML 데이터를 저장하는 데 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
    });
  }

  function saveManualMarkersForSite(siteId, markers) {
    if (!siteId || !markers || !markers.length) return;
    var firestore = window.firestore;
    var ref = firestore.doc(window.db, 'users', 'currentUser');

    firestore.getDoc(ref).then(function (snap) {
      if (!snap.exists()) {
        var payloadNew = {
          markers: markers.slice(),
          updatedAt: new Date().toISOString()
        };
        var manualObj = {};
        manualObj[siteId] = payloadNew;
        return firestore.setDoc(ref, {
          customSchedules: [],
          kmlBySite: {},
          manualMarkersBySite: manualObj,
          lastUpdated: firestore.serverTimestamp()
        });
      }
      var data = snap.data() || {};
      var existingBySite = data.manualMarkersBySite || {};
      var existingPayload = existingBySite[siteId] || {};
      var existingMarkers = Array.isArray(existingPayload.markers) ? existingPayload.markers : [];
      var merged = existingMarkers.concat(markers.slice());

      var updateData = {};
      updateData['manualMarkersBySite.' + siteId] = {
        markers: merged,
        updatedAt: new Date().toISOString()
      };
      updateData.lastUpdated = firestore.serverTimestamp();
      return firestore.updateDoc(ref, updateData);
    }).then(function () {
      closeSiteSelectModal();
      if (MWMAP.sites && typeof MWMAP.sites.showSyncSuccessBadge === 'function') {
        MWMAP.sites.showSyncSuccessBadge();
      }
      // 임시 수동 마커는 저장 후 지도에서 제거 (스냅샷 기반으로 다시 렌더링)
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
    }).catch(function (err) {
      console.error('수동 마커 저장 실패:', err);
      alert('마커 데이터를 저장하는 데 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
    });
  }

  function saveManualRouteForSite(siteId, pathOrRoutes) {
    if (!siteId || !pathOrRoutes || !pathOrRoutes.length) return;
    var firestore = window.firestore;
    var ref = firestore.doc(window.db, 'users', 'currentUser');

    var routesToAdd = [];
    // pathOrRoutes가 단일 경로(path 배열)인지, 이미 객체 배열인지 판별
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

    firestore.getDoc(ref).then(function (snap) {
      if (!snap.exists()) {
        var routeBySite = {};
        routeBySite[siteId] = {
          routes: routesToAdd,
          updatedAt: new Date().toISOString()
        };
        return firestore.setDoc(ref, {
          customSchedules: [],
          kmlBySite: {},
          manualMarkersBySite: {},
          manualRoutesBySite: routeBySite,
          lastUpdated: firestore.serverTimestamp()
        });
      }
      var data = snap.data() || {};
      var existingBySite = data.manualRoutesBySite || {};
      var existingPayload = existingBySite[siteId] || {};
      var existingRoutes = Array.isArray(existingPayload.routes) ? existingPayload.routes : [];
      var merged = existingRoutes.concat(routesToAdd);

      var updateData = {};
      updateData['manualRoutesBySite.' + siteId] = {
        routes: merged,
        updatedAt: new Date().toISOString()
      };
      updateData.lastUpdated = firestore.serverTimestamp();
      return firestore.updateDoc(ref, updateData);
    }).then(function () {
      closeSiteSelectModal();
      if (MWMAP.sites && typeof MWMAP.sites.showSyncSuccessBadge === 'function') {
        MWMAP.sites.showSyncSuccessBadge();
      }
      // 임시 경로는 저장 후 지도에서 제거 (스냅샷 기반으로 다시 렌더링)
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
            openSiteSelectModalForManualRoute(pathToSave);
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
  }

  MWMAP.kmlImport = { bind: bind, renderFromFirestoreData: renderFromFirestoreData, focusSite: focusSite };
})(window.MWMAP);

