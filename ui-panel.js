'use strict';

/**
 * 프로젝트 버튼·사이드 패널 (열기/닫기)
 */
(function (MWMAP) {
  function bind() {
    var btn = document.getElementById('project-btn');
    var panel = document.getElementById('project-panel');
    var overlay = document.getElementById('project-panel-overlay');

    function openPanel() {
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
    MWMAP.uiPanel.closePanel = closePanel;
  }

  MWMAP.uiPanel = { bind: bind };
})(window.MWMAP);
