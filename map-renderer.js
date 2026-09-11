'use strict';

/**
 * 지도 렌더링 모듈
 * - clearRenderedFromFirestore: 기존 렌더링 객체 모두 제거
 * - openInfoWindowAt: 공통 InfoWindow 열기 유틸
 * - renderSiteSummaryMarkers: 초록색 요약 마커
 * - renderFromFirestoreData: Firestore 데이터 기반 도형/마커/경로 전체 렌더링
 */
(function (MWMAP) {
  var S; // MWMAP._state 참조 (bind 시점에 연결)

  function getState() {
    if (!S) S = MWMAP._state;
    return S;
  }

  function clearRenderedFromFirestore() {
    var s = getState();
    s.renderedMarkers.forEach(function (m) {
      if (m && m.setMap) m.setMap(null);
    });
    s.renderedLines.forEach(function (l) {
      if (l && l.setMap) l.setMap(null);
    });
    s.renderedPolygons.forEach(function (p) {
      if (p && p.setMap) p.setMap(null);
    });
    s.renderedMarkers = [];
    s.renderedLines = [];
    s.renderedPolygons = [];
    s.renderedManualMarkers.forEach(function (m) {
      if (m && m.setMap) m.setMap(null);
    });
    s.renderedManualMarkers = [];
    s.renderedManualRoutes.forEach(function (r) {
      if (r && r.setMap) r.setMap(null);
    });
    s.renderedManualRoutes = [];
    if (s.manualRouteTempLine && s.manualRouteTempLine.setMap) {
      s.manualRouteTempLine.setMap(null);
    }
    s.manualRouteTempLine = null;
    if (s.longPressTempMarker && s.longPressTempMarker.setMap) {
      s.longPressTempMarker.setMap(null);
    }
    s.longPressTempMarker = null;
  }

  /**
   * 공통 InfoWindow 열기 유틸
   * - 기존 InfoWindow 닫기
   * - 줌 20으로 확대 후 열기
   * - 지도 클릭 시 자동 닫기 리스너 등록
   */
  function openInfoWindowAt(latLng, html, onDomReady, options) {
    var s = getState();
    var map = MWMAP.map;
    if (!latLng || !map) return;
    var skipPanAndZoom = options && options.skipPanAndZoom;

    if (s.currentInfoWindow) {
      s.currentInfoWindow.close();
    }
    s.currentInfoWindow = new google.maps.InfoWindow({
      content: html,
      position: latLng,
      maxWidth: 320,
      disableAutoPan: true
    });

    if (!skipPanAndZoom) {
      var targetZoom = 20;
      var currentZoom = map.getZoom();
      if (typeof map.moveCamera === 'function') {
        if (typeof currentZoom !== 'number' || currentZoom < targetZoom) {
          // zoom 20 미만일 때만 확대 이동
          map.moveCamera({ center: latLng, zoom: targetZoom });
        } else {
          // 이미 zoom 20 이상이면 위치만 부드럽게 이동
          map.panTo(latLng);
        }
      } else {
        if (typeof currentZoom === 'number' && currentZoom < targetZoom) {
          map.setZoom(targetZoom);
        }
        map.setCenter(latLng);
      }
    }
    s.currentInfoWindow.open(map);

    if (onDomReady && google && google.maps && google.maps.event) {
      google.maps.event.addListenerOnce(s.currentInfoWindow, 'domready', function () {
        try {
          onDomReady();
        } catch (e) {
          console.warn('InfoWindow domready handler error:', e);
        }
      });
    }

    // 지도 다른 곳 클릭 시 InfoWindow 닫기
    if (s.mapClickCloseListener) {
      google.maps.event.removeListener(s.mapClickCloseListener);
      s.mapClickCloseListener = null;
    }
    s.mapClickCloseListener = google.maps.event.addListener(map, 'click', function () {
      if (s.currentInfoWindow) {
        s.currentInfoWindow.close();
        s.currentInfoWindow = null;
      }
    });
  }

  // =============================================
  // 초록색 요약 마커: 앱 시작 시 전체 현장 위치 표시
  // =============================================
  function renderSiteSummaryMarkers(sites) {
    var s = getState();
    s.sitesMeta = sites || [];
    // 기존 초록색 요약 마커 정리
    s.renderedSiteSummaryMarkers.forEach(function (m) {
      if (m && m.setMap) m.setMap(null);
    });
    s.renderedSiteSummaryMarkers = [];

    var map = MWMAP.map;
    if (!map || !google || !google.maps) return;

    s.sitesMeta.forEach(function (site) {
      if (!site || !site.id) return;
      if (typeof site.centerLat !== 'number' || typeof site.centerLng !== 'number') return;

      var pos = { lat: site.centerLat, lng: site.centerLng };
      var isSelected = (s.selectedSiteId === site.id);

      var marker = new google.maps.Marker({
        map: isSelected ? null : map,
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
        if (getState().isManualRouteMode) return;
        if (window.MWMAP && window.MWMAP._skipOverlayClickOnce) {
          window.MWMAP._skipOverlayClickOnce = false;
          return;
        }
        if (MWMAP.kmlImport && typeof MWMAP.kmlImport.focusSite === 'function') {
          MWMAP.kmlImport.focusSite(site.id);
        }
      });

      s.renderedSiteSummaryMarkers.push(marker);
    });
  }

  function openPhotoModal(markerData) {
    var s = getState();
    var overlay = document.getElementById('photo-modal-overlay');
    var img = document.getElementById('photo-modal-img');
    var title = document.getElementById('photo-modal-title');
    var memo = document.getElementById('photo-modal-memo');
    if (!overlay || !img || !title) return;

    s.activePhotoSiteId = markerData.__siteId || s.selectedSiteId;
    s.activePhotoDocId = markerData.__photoDocId || null;
    s.activePhotoData = markerData;

    img.src = markerData.base64Data || '';
    title.textContent = markerData.title || '';
    if (memo) {
      memo.value = markerData.description || '';
    }

    // 더블탭 시 브라우저 네이티브 전체화면 제공
    if (!img._photoZoomBound) {
      img._photoZoomBound = true;
      img.addEventListener('dblclick', function () {
        if (img.requestFullscreen) {
          img.requestFullscreen();
        } else if (img.webkitRequestFullscreen) {
          img.webkitRequestFullscreen();
        }
      });
    }

    overlay.classList.add('show');
  }

  function closePhotoModal() {
    var overlay = document.getElementById('photo-modal-overlay');
    if (overlay) overlay.classList.remove('show');
  }

  // Firestore에서 읽어온 데이터를 기반으로
  // 1) 모든 현장에 대한 대표 원(클러스터) 표시
  // 2) 선택된 현장에 대해서만 세부 도형(KML shapes) 렌더링
  function renderFromFirestoreData(data) {
    var s = getState();
    s.latestData = data || null;
    clearRenderedFromFirestore();
    if (!data) return;
    var map = MWMAP.map;
    if (!map || !google || !google.maps) return;

    // 1) 모든 현장에 대해 대표 원(클러스터)만 먼저 그림
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

      if (manualMarkersPayload && Array.isArray(manualMarkersPayload.markers)) {
        manualMarkersPayload.markers.forEach(function (mm) {
          if (mm && typeof mm.lat === 'number' && typeof mm.lng === 'number') {
            bounds.extend(new google.maps.LatLng(mm.lat, mm.lng));
            hasAny = true;
          }
        });
      }

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

      var isSelected = s.selectedSiteId && s.selectedSiteId === siteId;
      var title = '현장 (대표)';
      
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
        if (getState().isManualRouteMode) return;
        if (window.MWMAP && window.MWMAP._skipOverlayClickOnce) {
          window.MWMAP._skipOverlayClickOnce = false;
          return;
        }
        s.selectedSiteId = siteId;
        map.fitBounds(bounds);
        renderFromFirestoreData(s.latestData || {});
      });

      s.renderedMarkers.push(marker);
    });

    // 2) 선택된 현장이 있으면, 그 현장의 세부 도형(KML) + 수동 마커/경로 렌더링
    var hasKml = data.kmlBySite && data.kmlBySite[s.selectedSiteId] && data.kmlBySite[s.selectedSiteId].shapes;
    var hasManualMarkers = data.manualMarkersBySite && data.manualMarkersBySite[s.selectedSiteId] &&
      Array.isArray(data.manualMarkersBySite[s.selectedSiteId].markers) && data.manualMarkersBySite[s.selectedSiteId].markers.length > 0;
    var hasManualRoutes = data.manualRoutesBySite && data.manualRoutesBySite[s.selectedSiteId] &&
      Array.isArray(data.manualRoutesBySite[s.selectedSiteId].routes) && data.manualRoutesBySite[s.selectedSiteId].routes.length > 0;

    if (s.selectedSiteId && (hasKml || hasManualMarkers || hasManualRoutes)) {

      if (hasKml) {
        var payloadSel = data.kmlBySite[s.selectedSiteId];
        var shapesSel = payloadSel && payloadSel.shapes ? payloadSel.shapes : { points: [], lines: [], polygons: [] };

      (shapesSel.points || []).forEach(function (pt, pIdx) {
        if (typeof pt.lat !== 'number' || typeof pt.lng !== 'number') return;
        var pos = { lat: pt.lat, lng: pt.lng };
        var isText = pt.type === 'text';
        var isBlockPoint = pt.type === 'blockPoint';
        var scale = isText ? 4.8 : 2.5;
        var fillColor = isBlockPoint ? '#0d9488' : (isText ? '#8b5cf6' : '#facc15');
        var markerPt = new google.maps.Marker({
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
          markerPt.addListener('click', function () {
            if (getState().isManualRouteMode) return;
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
                var kmlRef = fs.doc(window.db, 'users', 'currentUser', 'schedules', s.selectedSiteId, 'data', 'kml_doc');
                
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
                  if (s.currentInfoWindow) {
                    s.currentInfoWindow.close();
                    s.currentInfoWindow = null;
                  }
                  // onSnapshot이 자동으로 재렌더링 — focusSite 호출 불필요 (줄 유지)
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
                  var kmlRef = fs.doc(window.db, 'users', 'currentUser', 'schedules', s.selectedSiteId, 'data', 'kml_doc');
                  
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
                    if (s.currentInfoWindow) {
                      s.currentInfoWindow.close();
                      s.currentInfoWindow = null;
                    }
                    // onSnapshot이 자동으로 제거 — focusSite 호출 불필요 (줄 유지)
                  }).catch(function (err) {
                    console.error('KML 포인트 삭제 실패:', err);
                    alert('포인트를 삭제하는 데 실패했습니다.');
                  });
                });
              }
            });
          });
        } else if (isBlockPoint && (pt.blockName || pt.title)) {
          markerPt.addListener('click', function () {
            if (getState().isManualRouteMode) return;
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
        s.renderedMarkers.push(markerPt);
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
        
        line.addListener('click', function (event) {
          if (getState().isManualRouteMode) return;
          
          if (google && google.maps) {
            var bounds = new google.maps.LatLngBounds();
            path.forEach(function (p) { bounds.extend(p); });
            map.fitBounds(bounds);
          }

          var lengthKm = 0;
          if (MWMAP.manualRoute && typeof MWMAP.manualRoute.computeRouteDistanceKm === 'function') {
            lengthKm = MWMAP.manualRoute.computeRouteDistanceKm(path);
          }
          
          var pos = event && event.latLng ? event.latLng : new google.maps.LatLng(path[0].lat, path[0].lng);
          var name = ln.title || 'KML 선 객체';
          var html =
            '<div style="padding:12px;max-width:280px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;">' +
            '<div style="font-weight:700;font-size:14px;color:#111827;margin-bottom:4px;">' + name + '</div>' +
            '<div style="font-size:13px;color:#4b5563;">길이: ' + lengthKm.toFixed(2) + ' km</div>' +
            '</div>';
            
          openInfoWindowAt(pos, html, null, { skipPanAndZoom: true });
        });

        s.renderedLines.push(line);
      });

      (shapesSel.polygons || []).forEach(function (pg) {
        if (!Array.isArray(pg.path) || pg.path.length < 3) return;
        var polyPath = pg.path.map(function (p) { return { lat: p.lat, lng: p.lng }; });
        var poly = new google.maps.Polygon({
          map: map,
          paths: polyPath,
          strokeColor: pg.color || '#2563eb',
          strokeOpacity: 0.9,
          strokeWeight: 2,
          fillColor: pg.color || '#2563eb',
          fillOpacity: 0.15
        });

        poly.addListener('click', function (event) {
          if (getState().isManualRouteMode) return;

          if (google && google.maps) {
            var bounds = new google.maps.LatLngBounds();
            polyPath.forEach(function (p) { bounds.extend(p); });
            map.fitBounds(bounds);
          }

          var name = pg.title || 'KML 면 객체';
          var pos = event && event.latLng ? event.latLng : bounds.getCenter();
          var html =
            '<div style="padding:12px;max-width:280px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;">' +
            '<div style="font-weight:700;font-size:14px;color:#111827;">' + name + '</div>' +
            '</div>';
            
          openInfoWindowAt(pos, html, null, { skipPanAndZoom: true });
        });

        s.renderedPolygons.push(poly);
      });
      }

      // 3) 선택된 현장에 저장된 수동 마커(빨간 원) 렌더링
      if (MWMAP.manualMarker && typeof MWMAP.manualMarker.renderManualMarkers === 'function') {
        MWMAP.manualMarker.renderManualMarkers(data, s.selectedSiteId);
      }

      // 4) 선택된 현장에 저장된 수동 경로(라인) 렌더링
      if (MWMAP.manualRoute && typeof MWMAP.manualRoute.renderManualRoutes === 'function') {
        MWMAP.manualRoute.renderManualRoutes(data, s.selectedSiteId);
      }
    }
  }

  MWMAP.mapRenderer = {
    clearRenderedFromFirestore: clearRenderedFromFirestore,
    openInfoWindowAt: openInfoWindowAt,
    renderSiteSummaryMarkers: renderSiteSummaryMarkers,
    renderFromFirestoreData: renderFromFirestoreData,
    openPhotoModal: openPhotoModal,
    closePhotoModal: closePhotoModal
  };
})(window.MWMAP);
