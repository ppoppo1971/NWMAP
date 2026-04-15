'use strict';

/**
 * KML Import 오케스트레이터 (리팩토링)
 * - 각 모듈(kml-parser, map-renderer, manual-marker, manual-route)을 연결
 * - focusSite: 현장 포커스 (Firestore 데이터 로딩 → 렌더링)
 * - handleMapLongPress: 롱프레스 시 마커 생성 / 사진 촬영 플로우
 * - bind: 이벤트 리스너 총괄 바인딩
 */
(function (MWMAP) {
  var S; // MWMAP._state 참조

  function getState() {
    if (!S) S = MWMAP._state;
    return S;
  }

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

  // =============================================
  // 롱프레스 핸들러
  // =============================================
  function handleMapLongPress(latLng) {
    var s = getState();
    var map = MWMAP.map;
    var geocoder = MWMAP.geocoder;
    if (!map) return;
    if (s.isManualMarkerMode || s.isManualRouteMode) return;

    if (s.currentInfoWindow) {
      s.currentInfoWindow.close();
      s.currentInfoWindow = null;
    }
    if (s.longPressTempMarker && s.longPressTempMarker.setMap) {
      s.longPressTempMarker.setMap(null);
    }

    s.longPressTempMarker = new google.maps.Marker({
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

      if (s.currentInfoWindow) {
        s.currentInfoWindow.close();
      }
      s.currentInfoWindow = new google.maps.InfoWindow({
        content: html,
        position: latLng,
        maxWidth: 280,
        disableAutoPan: true
      });
      s.currentInfoWindow.open(map, s.longPressTempMarker);

      if (s.mapClickCloseListener && google && google.maps && google.maps.event) {
        google.maps.event.removeListener(s.mapClickCloseListener);
        s.mapClickCloseListener = null;
      }
      s.mapClickCloseListener = google.maps.event.addListener(map, 'click', function () {
        if (MWMAP._skipMapClickCloseOnce) {
          MWMAP._skipMapClickCloseOnce = false;
          return;
        }
        if (s.currentInfoWindow) {
          s.currentInfoWindow.close();
          s.currentInfoWindow = null;
        }
        if (s.longPressTempMarker) {
          s.longPressTempMarker.setMap(null);
          s.longPressTempMarker = null;
        }
      });

      if (google && google.maps && google.maps.event) {
        google.maps.event.addListenerOnce(s.currentInfoWindow, 'domready', function () {
          var btn = document.getElementById('longpress-create-marker-' + idSuffix);
          var photoBtn = document.getElementById('longpress-take-photo-' + idSuffix);
          var fileInput = document.getElementById('longpress-file-input-' + idSuffix);

          if (btn) {
            btn.addEventListener('click', function () {
              if (s.currentInfoWindow) {
                s.currentInfoWindow.close();
                s.currentInfoWindow = null;
              }
              if (s.longPressTempMarker) {
                s.longPressTempMarker.setMap(null);
                s.longPressTempMarker = null;
              }
              var markers = [{
                lat: lat,
                lng: lng,
                title: '',
                description: '',
                createdAt: new Date().toISOString()
              }];
              if (s.selectedSiteId) {
                MWMAP.manualMarker.saveManualMarkersForSite(s.selectedSiteId, markers);
              } else {
                MWMAP.manualMarker.openSiteSelectModalForManualMarkers(markers);
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
                  
                  // 최대 크기 1200px로 제한 (고화질)
                  var MAX_SIZE = 1200;
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
                  
                  // 품질 0.8 (80%) 적용
                  var base64Data = canvas.toDataURL('image/jpeg', 0.8);
                  
                  // 1MB Firestore 안전을 위해 텍스트 크기 확인 (약 85만 글자 이내)
                  if (base64Data.length > 850000) {
                    alert('사진 용량이 너무 큽니다. Firestore 한도 방지를 위해 더 작은 사진을 선택해 주세요.');
                    return;
                  }

                  if (s.currentInfoWindow) {
                    s.currentInfoWindow.close();
                    s.currentInfoWindow = null;
                  }
                  if (s.longPressTempMarker) {
                    s.longPressTempMarker.setMap(null);
                    s.longPressTempMarker = null;
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
                  if (s.selectedSiteId) {
                    MWMAP.manualMarker.saveManualMarkersForSite(s.selectedSiteId, markers);
                  } else {
                    MWMAP.manualMarker.openSiteSelectModalForManualMarkers(markers);
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

  // =============================================
  // 현장 활성화 해제
  // =============================================
  function clearActiveSite() {
    var s = getState();
    MWMAP.mapRenderer.clearRenderedFromFirestore();
    s.selectedSiteId = null;
    s.latestData = null;
    // 초록색 요약 마커 다시 모두 보이기
    s.renderedSiteSummaryMarkers.forEach(function (m) {
      if (m && m.setMap) m.setMap(MWMAP.map);
    });

    var versionLabel = document.getElementById('version-label');
    if (versionLabel) versionLabel.textContent = '';
  }

  // =============================================
  // focusSite: 현장 포커스 (핵심 오케스트레이션)
  // =============================================
  function focusSite(siteId) {
    var s = getState();
    if (!siteId) return;
    var map = MWMAP && MWMAP.map;
    if (!map) return;
    var fs = window.firestore;
    if (!fs || !window.db) return;

    s.selectedSiteId = siteId;

    // 초록색 요약 마커 상태 업데이트
    var siteTitle = '';
    s.renderedSiteSummaryMarkers.forEach(function (m) {
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
    MWMAP.mapRenderer.clearRenderedFromFirestore();

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

      var mergedData = {
        customSchedules: s.sitesMeta,
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

      s.latestData = mergedData;

      // 데이터에 기반해 지도 렌더링
      MWMAP.mapRenderer.renderFromFirestoreData(mergedData);

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

  // =============================================
  // KML 저장
  // =============================================
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

  function saveKmlForSite(siteId, payload) {
    var s = getState();
    if (!siteId || !payload) return;
    var firestore = window.firestore;
    var kmlDocRef = firestore.doc(window.db, 'users', 'currentUser', 'schedules', siteId, 'data', 'kml_doc');
    var siteRef = firestore.doc(window.db, 'users', 'currentUser', 'schedules', siteId);

    firestore.setDoc(kmlDocRef, payload).then(function () {
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
      if (payload.manualMarkersFromKml && payload.manualMarkersFromKml.length) {
        MWMAP.manualMarker.saveManualMarkersForSite(siteId, payload.manualMarkersFromKml);
      }
      if (payload.manualRoutesFromKml && payload.manualRoutesFromKml.length) {
        MWMAP.manualRoute.saveManualRouteForSite(siteId, payload.manualRoutesFromKml);
      }
      closeSiteSelectModal();
      if (MWMAP.sites && typeof MWMAP.sites.showSyncSuccessBadge === 'function') {
        MWMAP.sites.showSyncSuccessBadge();
      }
      if (MWMAP.map && MWMAP.map.data) {
        MWMAP.map.data.forEach(function (feature) {
          MWMAP.map.data.remove(feature);
        });
      }
      if (MWMAP.uiMapType && typeof MWMAP.uiMapType.closePanel === 'function') {
        MWMAP.uiMapType.closePanel();
      }
      s.selectedSiteId = siteId;
      focusSite(siteId);
    }).catch(function (err) {
      console.error('KML 저장 실패:', err);
      alert('KML 데이터를 저장하는 데 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
    });
  }

  function handleKmlFile(file) {
    if (!file || !file.name) return;
    if (!MWMAP.kmlParser.ensureDeps()) return;

    MWMAP.kmlParser.loadKmlTextFromFile(file).then(function (kmlText) {
      var geoJson = MWMAP.kmlParser.parseKmlToGeoJson(kmlText);
      MWMAP.kmlParser.displayKmlOnMap(geoJson);
      var parsed = MWMAP.kmlParser.buildShapesFromGeoJson(geoJson);
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

      try {
        var previewObj = { shapes: shapes, manualMarkers: manualMarkers, manualRoutes: manualRoutes };
        var jsonStr = JSON.stringify(previewObj);
        var byteSize;
        if (window.TextEncoder) {
          byteSize = new TextEncoder().encode(jsonStr).length;
        } else {
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

  // =============================================
  // bind: 이벤트 리스너 총괄
  // =============================================
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
      MWMAP.kmlParser.openFilePicker(fileInput);
    });

    fileInput.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) handleKmlFile(f);
    });

    // 경로추가 버튼 바인딩 (manual-route 모듈)
    if (MWMAP.manualRoute && typeof MWMAP.manualRoute.bindRouteButton === 'function') {
      MWMAP.manualRoute.bindRouteButton();
    }

    // 현장 선택 모달 닫기
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

    // 지도 롱프레스 이벤트 수신
    window.addEventListener('mwmappMapLongPress', function (e) {
      if (!e || !e.detail || !e.detail.latLng) return;
      handleMapLongPress(e.detail.latLng);
    });

    // 사진 모달 닫기 바인딩
    var photoOverlay = document.getElementById('photo-modal-overlay');
    var photoCloseBtn = document.getElementById('photo-modal-close');
    if (photoOverlay) {
      photoOverlay.addEventListener('click', function (e) {
        if (e.target === photoOverlay) MWMAP.mapRenderer.closePhotoModal();
      });
    }
    if (photoCloseBtn) {
      photoCloseBtn.addEventListener('click', MWMAP.mapRenderer.closePhotoModal);
    }

    // 사진 모달 메모 저장 바인딩
    var photoSaveBtn = document.getElementById('photo-modal-save-btn');
    if (photoSaveBtn) {
      photoSaveBtn.addEventListener('click', function () {
        var s = getState();
        var memoEl = document.getElementById('photo-modal-memo');
        var newMemo = memoEl ? memoEl.value.trim() : '';
        if (!s.activePhotoSiteId || !s.activePhotoDocId) {
          alert('수정할 사진 정보가 올바르지 않습니다.');
          return;
        }
        if (!window.firestore || !window.db) return;
        var firestore = window.firestore;
        var ref = firestore.doc(window.db, 'users', 'currentUser', 'schedules', s.activePhotoSiteId, 'photos', s.activePhotoDocId);
        
        firestore.updateDoc(ref, {
          description: newMemo
        }).then(function () {
          if (MWMAP.sites && typeof MWMAP.sites.showSyncSuccessBadge === 'function') {
            MWMAP.sites.showSyncSuccessBadge();
          }
          if (s.activePhotoData) s.activePhotoData.description = newMemo;
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
    renderFromFirestoreData: function (data) {
      return MWMAP.mapRenderer.renderFromFirestoreData(data);
    },
    renderSiteSummaryMarkers: function (sites) {
      return MWMAP.mapRenderer.renderSiteSummaryMarkers(sites);
    },
    focusSite: focusSite,
    clearActiveSite: clearActiveSite,
    getSelectedSiteId: function () { return getState().selectedSiteId; }
  };
})(window.MWMAP);
