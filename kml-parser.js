'use strict';

/**
 * KML/KMZ 파일 파싱 및 GeoJSON 변환 모듈
 * - loadKmlTextFromFile: KML/KMZ 파일 → 텍스트 추출
 * - parseKmlToGeoJson: KML 텍스트 → GeoJSON 변환
 * - buildShapesFromGeoJson: GeoJSON → shapes/manualMarkers/manualRoutes 구조 추출
 * - displayKmlOnMap: GeoJSON을 지도 Data Layer에 표시
 */
(function (MWMAP) {

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
    var S = MWMAP._state;
    if (!map) return;

    // 기존 Data Layer 비우기
    map.data.forEach(function (feature) {
      map.data.remove(feature);
    });

    var added = map.data.addGeoJson(geoJson);
    S.latestGeoJson = geoJson;

    // 간단 스타일
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

    // 클릭 시 정보창
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

  MWMAP.kmlParser = {
    ensureDeps: ensureDeps,
    openFilePicker: openFilePicker,
    loadKmlTextFromFile: loadKmlTextFromFile,
    parseKmlToGeoJson: parseKmlToGeoJson,
    buildShapesFromGeoJson: buildShapesFromGeoJson,
    displayKmlOnMap: displayKmlOnMap
  };
})(window.MWMAP);
