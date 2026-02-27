'use strict';

/**
 * 현장 목록: +현장추가 버튼, 새 현장 모달, Firebase 실시간 동기화, 동기화 배지
 */
(function (MWMAP) {
  var USER_DOC_PATH = ['users', 'currentUser'];
  var SITES_FIELD = 'customSchedules';
  var _initialSynced = false;
  var _pendingLocalChange = false;
  var _initialSyncTimeout = null;
  var _editingSiteId = null;

  function getDocRef() {
    if (!window.db || !window.firestore) return null;
    return window.firestore.doc(window.db, USER_DOC_PATH[0], USER_DOC_PATH[1]);
  }

  function showAddSiteModal() {
    var overlay = document.getElementById('add-site-overlay');
    var input = document.getElementById('add-site-title');
    if (overlay) overlay.classList.add('show');
    if (input) {
      input.value = '';
      setTimeout(function () {
        input.focus();
      }, 100);
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

  function subscribeFirestore() {
    var ref = getDocRef();
    if (!ref) return;

    // 스냅샷이 한 번이라도 오면 초기 동기화 성공으로 간주 (데스크톱/모바일 공통)
    window.firestore.onSnapshot(ref, function (snap) {
      var data = snap.data();
      var sites = (data && data[SITES_FIELD]) ? data[SITES_FIELD] : [];
      renderSitesList(sites);

      if (_initialSyncTimeout) {
        clearTimeout(_initialSyncTimeout);
        _initialSyncTimeout = null;
      }
      if (!_initialSynced) {
        _initialSynced = true;
        showSyncSuccessBadge();
      } else if (_pendingLocalChange) {
        _pendingLocalChange = false;
        showSyncSuccessBadge();
      }
    }, function (err) {
      console.warn('Firestore 현장 목록 구독 실패:', err);
      showSyncErrorBadge();
    });

    // 일정 시간 안에 어떤 스냅샷도 받지 못하면 동기화 실패 토스트 표시
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
    var title = input ? input.value.trim() : '';
    if (!title) {
      return;
    }
    var ref = getDocRef();
    if (!ref) {
      alert('Firebase 연결이 되지 않았습니다. 잠시 후 다시 시도해 주세요.');
      return;
    }
    var newItem = {
      id: 'site_' + Date.now(),
      title: title,
      timestamp: new Date().toISOString(),
      type: 'custom_schedule'
    };
    _pendingLocalChange = true;

    window.firestore.getDoc(ref).then(function (snap) {
      var existing = (snap.exists() && snap.data() && snap.data().customSchedules) ? snap.data().customSchedules : [];
      var updated = [newItem].concat(existing);
      if (!snap.exists()) {
        return window.firestore.setDoc(ref, {
          customSchedules: updated,
          lastUpdated: window.firestore.serverTimestamp()
        });
      }
      return window.firestore.updateDoc(ref, {
        customSchedules: updated,
        lastUpdated: window.firestore.serverTimestamp()
      });
    }).then(function () {
      closeAddSiteModal();
      // Firebase 쓰기 성공 시점에서 즉시 동기화 토스트 표시 (데스크톱/모바일 공통)
      showSyncSuccessBadge();
    }).catch(function (err) {
      console.error('현장 추가 실패:', err);
      console.error('Firebase 오류 상세:', err && err.code, err && err.message);
      alert('저장에 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
    });
  }

  function openEditSiteModal(siteId, title) {
    var overlay = document.getElementById('edit-site-overlay');
    var input = document.getElementById('edit-site-title');
    if (!overlay || !input) return;
    _editingSiteId = siteId || null;
    input.value = title || '';
    overlay.classList.add('show');
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
    var newTitle = input ? input.value.trim() : '';
    if (!_editingSiteId || !newTitle) return;
    var ref = getDocRef();
    if (!ref) {
      alert('Firebase 연결이 되지 않았습니다. 잠시 후 다시 시도해 주세요.');
      return;
    }
    _pendingLocalChange = true;
    window.firestore.getDoc(ref).then(function (snap) {
      if (!snap.exists()) return;
      var data = snap.data() || {};
      var existing = data.customSchedules || [];
      var updated = existing.map(function (item) {
        if (item && item.id === _editingSiteId) {
          var copy = {};
          for (var k in item) {
            if (Object.prototype.hasOwnProperty.call(item, k)) {
              copy[k] = item[k];
            }
          }
          copy.title = newTitle;
          return copy;
        }
        return item;
      });
      return window.firestore.updateDoc(ref, {
        customSchedules: updated,
        lastUpdated: window.firestore.serverTimestamp()
      });
    }).then(function () {
      closeEditSiteModal();
      showSyncSuccessBadge();
    }).catch(function (err) {
      console.error('현장 수정 실패:', err);
      alert('수정에 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
    });
  }

  function deleteEditingSite() {
    if (!_editingSiteId) return;
    if (!confirm('이 현장을 삭제하시겠습니까?')) return;
    var ref = getDocRef();
    if (!ref) {
      alert('Firebase 연결이 되지 않았습니다. 잠시 후 다시 시도해 주세요.');
      return;
    }
    _pendingLocalChange = true;
    window.firestore.getDoc(ref).then(function (snap) {
      if (!snap.exists()) return;
      var data = snap.data() || {};
      var existing = data.customSchedules || [];
      var updated = existing.filter(function (item) {
        return !(item && item.id === _editingSiteId);
      });
      var updateData = {
        customSchedules: updated,
        lastUpdated: window.firestore.serverTimestamp()
      };
      // 해당 현장에 연결된 KML 데이터도 함께 정리
      if (data.kmlBySite && typeof data.kmlBySite === 'object') {
        var kmlBySite = {};
        for (var k in data.kmlBySite) {
          if (Object.prototype.hasOwnProperty.call(data.kmlBySite, k) && k !== _editingSiteId) {
            kmlBySite[k] = data.kmlBySite[k];
          }
        }
        updateData.kmlBySite = kmlBySite;
      }
      return window.firestore.updateDoc(ref, updateData);
    }).then(function () {
      closeEditSiteModal();
      showSyncSuccessBadge();
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
