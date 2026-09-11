'use strict';

/**
 * 프로젝트 버튼·사이드 패널 (열기/닫기)
 */
(function (MWMAP) {
  function bind() {
    var btn = document.getElementById('project-btn');
    var panel = document.getElementById('project-panel');
    var overlay = document.getElementById('project-panel-overlay');
    var titleEl = document.getElementById('project-panel-title');

    function forceReload() {
      try {
        var url = new URL(window.location.href);
        url.searchParams.set('_nocache', Date.now());
        window.location.href = url.toString();
      } catch (e) {
        window.location.reload(true);
      }
    }

    function openPanel() {
      // 다른 사이드 패널이 열려 있으면 먼저 닫기
      if (MWMAP.uiMapType && typeof MWMAP.uiMapType.closePanel === 'function') {
        MWMAP.uiMapType.closePanel();
      }
      if (panel) panel.classList.remove('hide');
      if (overlay) overlay.classList.add('show');
      if (btn) btn.classList.add('hide');
    }
    function closePanel() {
      if (panel) panel.classList.add('hide');
      if (overlay) overlay.classList.remove('show');
      if (btn) btn.classList.remove('hide');
    }

    if (btn) btn.addEventListener('click', openPanel);
    if (overlay) overlay.addEventListener('click', closePanel);
    if (titleEl) titleEl.addEventListener('click', forceReload);
    MWMAP.uiPanel.closePanel = closePanel;
  }

  MWMAP.uiPanel = { bind: bind };
})(window.MWMAP);
