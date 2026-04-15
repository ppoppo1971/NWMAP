'use strict';

/**
 * 수동 경로 관리 모듈
 * - renderManualRoutes: 선택된 현장의 수동 경로 렌더링
 * - saveManualRouteForSite: Firestore에 경로 저장
 * - bindRouteButton: 경로추가 버튼 이벤트 바인딩
 * - computeRouteDistanceKm: 경로 거리 계산
 */
(function (MWMAP) {

  function getState() { return MWMAP._state; }

  function getSitesForSelection() {
    var list = document.getElementById('project-sites-list');
    if (!list) return [];
    var items = list.querySelectorAll('.site-item');
    var sites = [];
    items.forEach(function (el) {
      var id = el.getAttribute('data-site-id') || '';
      if (!id) return;
      sites.push({ id: id, title: el.textContent || '' });
    });
    return sites;
  }

  function closeSiteSelectModal() {
    var overlay = document.getElementById('kml-site-overlay');
    if (overlay) overlay.classList.remove('show');
  }

  function computeRouteDistanceKm(path) {
    if (!Array.isArray(path) || path.length < 2) return 0;
    var R = 6371;
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

  /**
   * 선택된 현장의 수동 경로를 지도에 렌더링
   * (map-renderer.js의 renderFromFirestoreData에서 호출됨)
   */
  function renderManualRoutes(data, selectedSiteId) {
    var s = getState();
    var map = MWMAP.map;
    if (!map) return;

    var manualRoutesBySite = (data && data.manualRoutesBySite && typeof data.manualRoutesBySite === 'object')
      ? data.manualRoutesBySite
      : null;
    if (!manualRoutesBySite || !manualRoutesBySite[selectedSiteId] || !Array.isArray(manualRoutesBySite[selectedSiteId].routes)) return;

    var routeList = manualRoutesBySite[selectedSiteId].routes;
    routeList.forEach(function (rt, rIdx) {
      if (!rt || !Array.isArray(rt.path) || rt.path.length < 2) return;
      var pathLatLng = rt.path.map(function (p) {
        if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') return null;
        return { lat: p.lat, lng: p.lng };
      }).filter(function (p) { return !!p; });
      if (pathLatLng.length < 2) return;

      var line = new google.maps.Polyline({
        map: map,
        path: pathLatLng,
        strokeColor: '#f97316',
        strokeOpacity: 0.95,
        strokeWeight: 5,
        zIndex: 20
      });

      var dottedLine = new google.maps.Polyline({
        map: map,
        path: pathLatLng,
        strokeColor: '#ffffff',
        strokeOpacity: 0,
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

      line.__manualRouteMeta = { siteId: selectedSiteId, index: rIdx };
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

        if (google && google.maps) {
          var bounds = new google.maps.LatLngBounds();
          pathLatLng.forEach(function (p) { bounds.extend(p); });
          var targetZoom = 20;
          if (typeof map.moveCamera === 'function') {
            map.moveCamera({ center: bounds.getCenter(), zoom: targetZoom });
          } else {
            var currentZoom = map.getZoom();
            if (typeof currentZoom === 'number' && currentZoom < targetZoom) {
              map.setZoom(targetZoom);
            }
            map.setCenter(bounds.getCenter());
          }
        }

        var html =
          '<div style="padding:12px;max-width:280px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;">' +
          '<div style="font-size:13px;color:#111827;margin-bottom:8px;">경로 길이: ' + lengthKm.toFixed(2) + ' km</div>' +
          '<button id="manual-route-delete-' + idSuffix + '" ' +
          'style="width:100%;padding:8px 10px;border:none;border-radius:6px;background:#ef4444;color:#fff;font-size:13px;font-weight:500;cursor:pointer;">삭제</button>' +
          '</div>';

        MWMAP.mapRenderer.openInfoWindowAt(pos, html, function () {
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
              if (s.currentInfoWindow) {
                s.currentInfoWindow.close();
                s.currentInfoWindow = null;
              }
              if (MWMAP.kmlImport && typeof MWMAP.kmlImport.focusSite === 'function') {
                MWMAP.kmlImport.focusSite(meta.siteId);
              }
            }).catch(function (err) {
              console.error('수동 경로 삭제 실패:', err);
              alert('경로를 삭제하는 데 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
            });
          });
        });
      });

      s.renderedManualRoutes.push(line);
      s.renderedManualRoutes.push(dottedLine);
    });
  }

  function saveManualRouteForSite(siteId, pathOrRoutes) {
    var s = getState();
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
      if (s.manualRouteTempLine && s.manualRouteTempLine.setMap) {
        s.manualRouteTempLine.setMap(null);
      }
      s.manualRouteTempLine = null;
      s.manualRoutePointsTemp = [];
      s.isManualRouteMode = false;
      if (s.mapClickManualRouteListener && google && google.maps && google.maps.event) {
        google.maps.event.removeListener(s.mapClickManualRouteListener);
        s.mapClickManualRouteListener = null;
      }
      var routeBtn = document.getElementById('add-route-btn');
      if (routeBtn) {
        routeBtn.textContent = '경로추가';
        routeBtn.style.background = '';
        routeBtn.style.color = '';
      }
      s.selectedSiteId = siteId;
      if (MWMAP.kmlImport && typeof MWMAP.kmlImport.focusSite === 'function') {
        MWMAP.kmlImport.focusSite(siteId);
      }
    }).catch(function (err) {
      console.error('수동 경로 저장 실패:', err);
      alert('경로 데이터를 저장하는 데 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
    });
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
   * 경로추가 버튼 이벤트 바인딩
   */
  function bindRouteButton() {
    var s = getState();
    var manualRouteBtn = document.getElementById('add-route-btn');
    if (!manualRouteBtn) return;

    manualRouteBtn.addEventListener('click', function () {
      var map = MWMAP.map;
      if (!map || !google || !google.maps) return;

      if (s.isManualRouteMode) {
        s.isManualRouteMode = false;
        if (s.mapClickManualRouteListener && google.maps.event) {
          google.maps.event.removeListener(s.mapClickManualRouteListener);
          s.mapClickManualRouteListener = null;
        }
        manualRouteBtn.textContent = '경로추가';
        manualRouteBtn.style.background = '';
        manualRouteBtn.style.color = '';

        if (s.manualRoutePointsTemp.length >= 2) {
          var pathToSave = s.manualRoutePointsTemp.slice();
          if (s.selectedSiteId) {
            saveManualRouteForSite(s.selectedSiteId, pathToSave);
          } else {
            openSiteSelectModalForManualRoute(pathToSave);
          }
        } else {
          if (s.manualRouteTempLine && s.manualRouteTempLine.setMap) {
            s.manualRouteTempLine.setMap(null);
          }
          s.manualRouteTempLine = null;
          s.manualRoutePointsTemp = [];
        }
        return;
      }

      s.isManualRouteMode = true;
      manualRouteBtn.textContent = '경로추가 중...';
      manualRouteBtn.style.background = 'linear-gradient(135deg,#10b981,#059669)';
      manualRouteBtn.style.color = '#ffffff';

      s.manualRoutePointsTemp = [];
      if (s.manualRouteTempLine && s.manualRouteTempLine.setMap) {
        s.manualRouteTempLine.setMap(null);
      }
      s.manualRouteTempLine = null;

      if (s.mapClickManualRouteListener && google.maps.event) {
        google.maps.event.removeListener(s.mapClickManualRouteListener);
        s.mapClickManualRouteListener = null;
      }
      s.mapClickManualRouteListener = google.maps.event.addListener(map, 'click', function (event) {
        if (!s.isManualRouteMode) return;
        if (!event || !event.latLng) return;
        var latLng = event.latLng;
        var lat = typeof latLng.lat === 'function' ? latLng.lat() : latLng.lat;
        var lng = typeof latLng.lng === 'function' ? latLng.lng() : latLng.lng;
        if (typeof lat !== 'number' || typeof lng !== 'number') return;

        s.manualRoutePointsTemp.push({ lat: lat, lng: lng });

        if (s.manualRouteTempLine && s.manualRouteTempLine.setMap) {
          s.manualRouteTempLine.setMap(null);
        }
        if (s.manualRoutePointsTemp.length >= 2) {
          s.manualRouteTempLine = new google.maps.Polyline({
            map: map,
            path: s.manualRoutePointsTemp.map(function (p) { return { lat: p.lat, lng: p.lng }; }),
            strokeColor: '#f97316',
            strokeOpacity: 0.8,
            strokeWeight: 3
          });
        }
      });
    });
  }

  MWMAP.manualRoute = {
    renderManualRoutes: renderManualRoutes,
    saveManualRouteForSite: saveManualRouteForSite,
    openSiteSelectModalForManualRoute: openSiteSelectModalForManualRoute,
    bindRouteButton: bindRouteButton
  };
})(window.MWMAP);
