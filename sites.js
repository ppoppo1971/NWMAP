'use strict';

/**
 * 현장 목록: +현장추가 버튼, 새 현장 모달, Firebase 실시간 동기화, 동기화 배지
 */
(function (MWMAP) {
  var USER_DOC_PATH = ['users', 'currentUser'];
  var SCHEDULES_COLLECTION = 'schedules';
  var _initialSynced = false;
  var _pendingLocalChange = false;
  var _initialSyncTimeout = null;
  var _editingSiteId = null;

  function getCollectionRef() {
    if (!window.db || !window.firestore) return null;
    return window.firestore.collection(window.db, USER_DOC_PATH[0], USER_DOC_PATH[1], SCHEDULES_COLLECTION);
  }

  function getSiteDocRef(siteId) {
    if (!window.db || !window.firestore || !siteId) return null;
    return window.firestore.doc(window.db, USER_DOC_PATH[0], USER_DOC_PATH[1], SCHEDULES_COLLECTION, siteId);
  }

  function showAddSiteModal() {
    var overlay = document.getElementById('add-site-overlay');
    var input = document.getElementById('add-site-title');
    var memoInput = document.getElementById('add-site-memo');
    if (overlay) overlay.classList.add('show');
    if (input) {
      input.value = '';
      setTimeout(function () {
        input.focus();
      }, 100);
    }
    if (memoInput) {
      memoInput.value = '';
    }
  }

  function closeAddSiteModal() {
    var overlay = document.getElementById('add-site-overlay');
    if (overlay) overlay.classList.remove('show');
  }

  function showSyncToast(message, variant, options) {
    var badge = document.getElementById('sync-badge');
    if (!badge) return;
    options = options || {};

    // variant: 'success' | 'error'
    badge.textContent = message || '';
    badge.classList.remove('hide', 'success', 'error');
    if (variant === 'error') {
      badge.classList.add('error');
    } else {
      badge.classList.add('success');
    }

    clearTimeout(badge._hideTimer);
    if (options.autoHide !== false) {
      var duration = typeof options.duration === 'number' ? options.duration : 2500;
      badge._hideTimer = setTimeout(function () {
        badge.classList.add('hide');
      }, duration);
    }
  }

  function showSyncSuccessBadge() {
    showSyncToast('동기화됨', 'success', { autoHide: true, duration: 2500 });
  }

  function showSyncErrorBadge() {
    showSyncToast('동기화 실패', 'error', { autoHide: false });
  }

  function renderSitesList(items) {
    var list = document.getElementById('project-sites-list');
    if (!list) return;
    list.innerHTML = '';
    if (!items || !items.length) return;
    items.forEach(function (item) {
      var title = (item && item.title) ? item.title : '(이름 없음)';
      var el = document.createElement('div');
      el.className = 'site-item';
      el.textContent = title;
      if (item && item.id) {
        el.setAttribute('data-site-id', item.id);
      }
      list.appendChild(el);
    });
  }

  var _cachedSchedules = []; // 증분 업데이트를 위한 로컬 캐시

  function subscribeFirestore() {
    var collRef = getCollectionRef();
    if (!collRef) return;

    window.firestore.onSnapshot(collRef, function (querySnapshot) {
      // 증분 업데이트: 변경된 문서만 처리
      var changes = querySnapshot.docChanges();
      changes.forEach(function (change) {
        var id = change.doc.id;
        var d = change.doc.data();

        if (change.type === 'added') {
          _cachedSchedules.push({
            id: id,
            title: d.title || '',
            memo: d.memo || '',
            timestamp: d.timestamp || '',
            type: d.type || '',
            centerLat: d.centerLat,
            centerLng: d.centerLng
          });
        } else if (change.type === 'modified') {
          for (var i = 0; i < _cachedSchedules.length; i++) {
            if (_cachedSchedules[i].id === id) {
              _cachedSchedules[i] = {
                id: id,
                title: d.title || '',
                memo: d.memo || '',
                timestamp: d.timestamp || '',
                type: d.type || '',
                centerLat: d.centerLat,
                centerLng: d.centerLng
              };
              break;
            }
          }
        } else if (change.type === 'removed') {
          _cachedSchedules = _cachedSchedules.filter(function (s) { return s.id !== id; });
        }
      });

      // 최신순 정렬
      _cachedSchedules.sort(function(a, b) {
        var ta = a.timestamp || '';
        var tb = b.timestamp || '';
        return ta > tb ? -1 : (ta < tb ? 1 : 0);
      });

      renderSitesList(_cachedSchedules);

      var renderOk = true;
      if (window.MWMAP && window.MWMAP.kmlImport && typeof window.MWMAP.kmlImport.renderSiteSummaryMarkers === 'function') {
        try {
          window.MWMAP.kmlImport.renderSiteSummaryMarkers(_cachedSchedules);
        } catch (e) {
          console.warn('초록색 요약 마커 렌더링 실패:', e);
          renderOk = false;
        }
      }

      if (_initialSyncTimeout) {
        clearTimeout(_initialSyncTimeout);
        _initialSyncTimeout = null;
      }
      if (!_initialSynced) {
        _initialSynced = true;
        if (renderOk) showSyncSuccessBadge();
        else showSyncErrorBadge();
      } else if (_pendingLocalChange) {
        _pendingLocalChange = false;
        if (renderOk) showSyncSuccessBadge();
        else showSyncErrorBadge();
      }
    }, function (err) {
      console.warn('Firestore 현장 목록 구독 실패:', err);
      showSyncErrorBadge();
    });

    if (_initialSyncTimeout) {
      clearTimeout(_initialSyncTimeout);
    }
    _initialSyncTimeout = setTimeout(function () {
      if (!_initialSynced) {
        showSyncErrorBadge();
      }
    }, 7000);
  }

  function addNewSite() {
    var input = document.getElementById('add-site-title');
    var memoInput = document.getElementById('add-site-memo');
    var title = input ? input.value.trim() : '';
    if (!title) return;
    
    var memo = memoInput ? memoInput.value.trim() : '';
    var newId = 'site_' + Date.now();
    var siteRef = getSiteDocRef(newId);
    if (!siteRef) {
      alert('Firebase 연결이 되지 않았습니다. 잠시 후 다시 시도해 주세요.');
      return;
    }

    var newItem = {
      id: newId,
      title: title,
      memo: memo,
      timestamp: new Date().toISOString(),
      type: 'custom_schedule',
      lastUpdated: window.firestore.serverTimestamp()
    };
    
    _pendingLocalChange = true;

    window.firestore.setDoc(siteRef, newItem).then(function () {
      closeAddSiteModal();
      showSyncSuccessBadge();
    }).catch(function (err) {
      console.error('현장 추가 실패:', err);
      alert('저장에 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
    });
  }

  function openEditSiteModal(siteId, title) {
    var overlay = document.getElementById('edit-site-overlay');
    var input = document.getElementById('edit-site-title');
    var memoInput = document.getElementById('edit-site-memo');
    if (!overlay || !input) return;
    _editingSiteId = siteId || null;
    input.value = title || '';
    overlay.classList.add('show');
    if (memoInput) {
      memoInput.value = '';
    }
    // Firebase에서 해당 현장의 메모를 읽어와 입력란에 채움
    var siteRef = getSiteDocRef(_editingSiteId);
    if (siteRef && _editingSiteId) {
      window.firestore.getDoc(siteRef).then(function (snap) {
        if (!snap.exists()) return;
        var data = snap.data() || {};
        if (memoInput && data.memo !== undefined) {
          memoInput.value = data.memo || '';
        }
      }).catch(function () {
        // 무시
      });
    }
    setTimeout(function () {
      input.focus();
      input.select();
    }, 100);
  }

  function closeEditSiteModal() {
    var overlay = document.getElementById('edit-site-overlay');
    if (overlay) overlay.classList.remove('show');
    _editingSiteId = null;
  }

  function updateEditingSiteTitle() {
    var input = document.getElementById('edit-site-title');
    var memoInput = document.getElementById('edit-site-memo');
    var newTitle = input ? input.value.trim() : '';
    if (!_editingSiteId || !newTitle) return;
    var newMemo = memoInput ? memoInput.value.trim() : '';
    
    var siteRef = getSiteDocRef(_editingSiteId);
    if (!siteRef) {
      alert('Firebase 연결이 되지 않았습니다. 잠시 후 다시 시도해 주세요.');
      return;
    }
    _pendingLocalChange = true;
    
    window.firestore.updateDoc(siteRef, {
      title: newTitle,
      memo: newMemo,
      lastUpdated: window.firestore.serverTimestamp()
    }).then(function () {
      closeEditSiteModal();
      showSyncSuccessBadge();
    }).catch(function (err) {
      console.error('현장 수정 실패:', err);
      alert('수정에 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
    });
  }

  /**
   * 현장 삭제 – 하위 서브컬렉션(photos, data)까지 모두 제거하여 고아 데이터 방지
   */
  function deleteEditingSite() {
    if (!_editingSiteId) return;
    if (!confirm('이 현장을 삭제하시겠습니까?\n(관련 도면, 사진, 경로 데이터가 모두 삭제됩니다)')) return;

    var siteRef = getSiteDocRef(_editingSiteId);
    if (!siteRef) {
      alert('Firebase 연결이 되지 않았습니다. 잠시 후 다시 시도해 주세요.');
      return;
    }

    _pendingLocalChange = true;
    var fs = window.firestore;
    var siteId = _editingSiteId;

    // 1) photos 서브컬렉션의 모든 문서 삭제
    var photosRef = fs.collection(window.db, 'users', 'currentUser', SCHEDULES_COLLECTION, siteId, 'photos');
    var dataRef = fs.collection(window.db, 'users', 'currentUser', SCHEDULES_COLLECTION, siteId, 'data');

    Promise.all([
      fs.getDocs(photosRef),
      fs.getDocs(dataRef)
    ]).then(function (results) {
      var deletePromises = [];
      // photos 하위 문서들 삭제
      results[0].forEach(function (docSnap) {
        deletePromises.push(fs.deleteDoc(docSnap.ref));
      });
      // data 하위 문서들 삭제
      results[1].forEach(function (docSnap) {
        deletePromises.push(fs.deleteDoc(docSnap.ref));
      });
      return Promise.all(deletePromises);
    }).then(function () {
      // 2) 하위 문서 모두 소멸 후 → 현장 본체(껍데기) 삭제
      return fs.deleteDoc(siteRef);
    }).then(function () {
      closeEditSiteModal();
      showSyncSuccessBadge();
      // 삭제된 현장이 활성화 상태였다면 지도 정리
      if (window.MWMAP && window.MWMAP.kmlImport && typeof window.MWMAP.kmlImport.clearActiveSite === 'function') {
        window.MWMAP.kmlImport.clearActiveSite();
      }
    }).catch(function (err) {
      console.error('현장 삭제 실패:', err);
      alert('삭제에 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
    });
  }

  function bind() {
    var addBtn = document.getElementById('add-site-btn');
    var overlay = document.getElementById('add-site-overlay');
    var dialog = document.getElementById('add-site-dialog');
    var submitBtn = document.getElementById('add-site-submit');
    var titleInput = document.getElementById('add-site-title');

    if (addBtn) addBtn.addEventListener('click', showAddSiteModal);

    if (overlay) {
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeAddSiteModal();
      });
    }
    if (dialog) {
      dialog.addEventListener('click', function (e) {
        e.stopPropagation();
      });
    }

    if (submitBtn) submitBtn.addEventListener('click', addNewSite);
    if (titleInput) {
      titleInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          addNewSite();
        }
      });
    }

    // 현장 목록 항목 탭 → 편집/삭제 모달
    var listEl = document.getElementById('project-sites-list');
    if (listEl && listEl.addEventListener) {
      listEl.addEventListener('click', function (e) {
        var target = e.target || e.srcElement;
        if (!target) return;
        var itemEl = target.closest ? target.closest('.site-item') : null;
        if (!itemEl) return;
        var siteId = itemEl.getAttribute('data-site-id') || '';
        var title = itemEl.textContent || '';
        openEditSiteModal(siteId, title);
      });
    }

    // 편집 모달 바인딩
    var editOverlay = document.getElementById('edit-site-overlay');
    var editDialog = document.getElementById('edit-site-dialog');
    var editSaveBtn = document.getElementById('edit-site-save');
    var editDeleteBtn = document.getElementById('edit-site-delete');
    var editTitleInput = document.getElementById('edit-site-title');
    var editFocusBtn = document.getElementById('edit-site-focus');

    if (editOverlay) {
      editOverlay.addEventListener('click', function (e) {
        if (e.target === editOverlay) closeEditSiteModal();
      });
    }
    if (editDialog) {
      editDialog.addEventListener('click', function (e) {
        e.stopPropagation();
      });
    }
    if (editSaveBtn) editSaveBtn.addEventListener('click', updateEditingSiteTitle);
    if (editDeleteBtn) editDeleteBtn.addEventListener('click', deleteEditingSite);
    if (editFocusBtn) {
      editFocusBtn.addEventListener('click', function () {
        if (!_editingSiteId) return;
        if (window.MWMAP && window.MWMAP.kmlImport && typeof window.MWMAP.kmlImport.focusSite === 'function') {
          window.MWMAP.kmlImport.focusSite(_editingSiteId);
        }
        closeEditSiteModal();
        if (window.MWMAP && window.MWMAP.uiPanel && typeof window.MWMAP.uiPanel.closePanel === 'function') {
          window.MWMAP.uiPanel.closePanel();
        }
      });
    }
    if (editTitleInput) {
      editTitleInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          updateEditingSiteTitle();
        }
      });
    }

    var syncBadgeEl = document.getElementById('sync-badge');
    if (syncBadgeEl) {
      syncBadgeEl.addEventListener('click', function () {
        if (syncBadgeEl.classList.contains('error')) {
          syncBadgeEl.classList.add('hide');
        }
      });
    }

    if (window.db && window.firestore) {
      subscribeFirestore();
    } else {
      window.addEventListener('firebaseReady', function () {
        subscribeFirestore();
      });
    }
  }

  MWMAP.sites = {
    bind: bind,
    showSyncSuccessBadge: showSyncSuccessBadge
  };
})(window.MWMAP);
