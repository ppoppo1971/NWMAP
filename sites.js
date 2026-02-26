'use strict';

/**
 * 현장 목록: +현장추가 버튼, 새 현장 모달, Firebase 실시간 동기화, 동기화 배지
 */
(function (MWMAP) {
  var USER_DOC_PATH = ['users', 'currentUser'];
  var SITES_FIELD = 'customSchedules';

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

  function showSyncBadge() {
    var badge = document.getElementById('sync-badge');
    if (!badge) return;
    badge.classList.remove('hide');
    badge.textContent = '동기화됨';
    clearTimeout(badge._hideTimer);
    badge._hideTimer = setTimeout(function () {
      badge.classList.add('hide');
    }, 2500);
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
      list.appendChild(el);
    });
  }

  function subscribeFirestore() {
    var ref = getDocRef();
    if (!ref) return;
    window.firestore.onSnapshot(ref, function (snap) {
      var data = snap.data();
      var sites = (data && data[SITES_FIELD]) ? data[SITES_FIELD] : [];
      renderSitesList(sites);
    }, function (err) {
      console.warn('Firestore 현장 목록 구독 실패:', err);
    });
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
      showSyncBadge();
    }).catch(function (err) {
      console.error('현장 추가 실패:', err);
      console.error('Firebase 오류 상세:', err && err.code, err && err.message);
      alert('저장에 실패했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
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

    if (window.db && window.firestore) {
      subscribeFirestore();
    } else {
      window.addEventListener('firebaseReady', function () {
        subscribeFirestore();
      });
    }
  }

  MWMAP.sites = { bind: bind };
})(window.MWMAP);
