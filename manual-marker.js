'use strict';

/**
 * 수동 마커/사진 관리 모듈
 * - renderManualMarkers: 선택된 현장의 수동 마커 렌더링
 * - saveManualMarkersForSite: Firestore에 마커/사진 저장
 * - openSiteSelectModalForManualMarkers: 현장 선택 후 저장
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

  /**
   * 선택된 현장의 수동 마커들을 지도에 렌더링
   * (map-renderer.js의 renderFromFirestoreData에서 호출됨)
   */
  function renderManualMarkers(data, selectedSiteId) {
    var s = getState();
    var map = MWMAP.map;
    if (!map) return;

    var manualMarkersBySite = (data && data.manualMarkersBySite && typeof data.manualMarkersBySite === 'object')
      ? data.manualMarkersBySite
      : null;
    if (!manualMarkersBySite || !manualMarkersBySite[selectedSiteId] || !Array.isArray(manualMarkersBySite[selectedSiteId].markers)) return;

    var manualList = manualMarkersBySite[selectedSiteId].markers;
    manualList.forEach(function (mm, idx) {
      if (!mm || typeof mm.lat !== 'number' || typeof mm.lng !== 'number') return;
      var mPos = { lat: mm.lat, lng: mm.lng };
      var m = new google.maps.Marker({
        map: map,
        position: mPos,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 4.8,
          fillColor: mm.isPhoto ? '#3b82f6' : '#ef4444',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 1
        }
      });
      m.__manualMeta = { siteId: selectedSiteId, index: idx };

      m.addListener('click', function () {
        if (getState().isManualRouteMode) return;
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
          if (MWMAP.mapRenderer && typeof MWMAP.mapRenderer.openPhotoModal === 'function') {
            MWMAP.mapRenderer.openPhotoModal(cur);
          }
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

        MWMAP.mapRenderer.openInfoWindowAt(mPos, html, function () {
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
                if (s.currentInfoWindow) {
                  s.currentInfoWindow.close();
                  s.currentInfoWindow = null;
                }
                // onSnapshot이 자동으로 재렌더링 — focusSite 호출 불필요 (줄 유지됨)
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
                if (s.currentInfoWindow) {
                  s.currentInfoWindow.close();
                  s.currentInfoWindow = null;
                }
                // onSnapshot이 자동으로 마커 제거 — focusSite 호출 불필요 (줄 유지됨)
              }).catch(function (err) {
                console.error('수동 마커 삭제 실패:', err);
                alert('마커를 삭제하는 데 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
              });
            });
          }
        });
      });
      s.renderedManualMarkers.push(m);
    });
  }

  function saveManualMarkersForSite(siteId, markers) {
    var s = getState();
    if (!siteId || !markers || !markers.length) return;
    var firestore = window.firestore;
    var photosColRef = firestore.collection(window.db, 'users', 'currentUser', 'schedules', siteId, 'photos');
    var siteRef = firestore.doc(window.db, 'users', 'currentUser', 'schedules', siteId);

    var savePromises = markers.map(function (marker) {
      var photoId = 'photo_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      var docRef = firestore.doc(window.db, 'users', 'currentUser', 'schedules', siteId, 'photos', photoId);
      return firestore.setDoc(docRef, marker);
    });

    Promise.all(savePromises).then(function () {
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
      s.renderedManualMarkers.forEach(function (m) {
        if (m && m.setMap) m.setMap(null);
      });
      s.renderedManualMarkers = [];
      s.manualMarkersTemp = [];
      s.isManualMarkerMode = false;
      if (s.mapClickManualListener && google && google.maps && google.maps.event) {
        google.maps.event.removeListener(s.mapClickManualListener);
        s.mapClickManualListener = null;
      }
      var markerBtn = document.getElementById('add-marker-btn');
      if (markerBtn) {
        markerBtn.textContent = '마커추가';
        markerBtn.style.background = '';
        markerBtn.style.color = '';
      }
      s.selectedSiteId = siteId;
      if (MWMAP.kmlImport && typeof MWMAP.kmlImport.focusSite === 'function') {
        MWMAP.kmlImport.focusSite(siteId, { keepZoom: true });
      }
    }).catch(function (err) {
      console.error('수동 마커 저장 실패:', err);
      alert('마커 데이터를 저장하는 데 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
    });
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

  MWMAP.manualMarker = {
    renderManualMarkers: renderManualMarkers,
    saveManualMarkersForSite: saveManualMarkersForSite,
    openSiteSelectModalForManualMarkers: openSiteSelectModalForManualMarkers
  };
})(window.MWMAP);
