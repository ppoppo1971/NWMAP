'use strict';

/**
 * 오른쪽 사이드 패널 + 지도 종류 선택 (MAP 버튼, 모달)
 * - 오른쪽 상단 M 버튼: 왼쪽 P 버튼과 동일 스타일, 탭 시 오른쪽 패널 열림
 * - 패널 내 MAP 버튼: 현재 지도 종류 표시, 탭 시 지도 종류 모달
 * - 모달에서 구글(도로/위성), 브이월드(도로/위성) 선택 시 지도 전환 및 MAP 버튼 라벨 갱신
 */
(function (MWMAP) {
  function bind() {
    var mapBtn = document.getElementById('map-type-btn');
    var panel = document.getElementById('map-type-panel');
    var overlay = document.getElementById('map-type-panel-overlay');
    var innerBtn = document.getElementById('map-type-inner-btn');
    var modalOverlay = document.getElementById('map-type-overlay');
    var modalDialog = document.getElementById('map-type-dialog');

    function openPanel() {
      // 왼쪽 프로젝트 패널이 열려 있으면 먼저 닫기
      if (MWMAP.uiPanel && typeof MWMAP.uiPanel.closePanel === 'function') {
        MWMAP.uiPanel.closePanel();
      }
      if (panel) panel.classList.remove('hide');
      if (overlay) overlay.classList.add('show');
      if (mapBtn) mapBtn.classList.add('hide');
      updateMapButtonLabel();
    }

    function closePanel() {
      if (panel) panel.classList.add('hide');
      if (overlay) overlay.classList.remove('show');
      if (mapBtn) mapBtn.classList.remove('hide');
    }

    function updateMapButtonLabel() {
      if (!innerBtn || !MWMAP.map || !MWMAP.mapInit || !MWMAP.mapInit.getMapTypeLabel) return;
      var typeId = MWMAP.map.getMapTypeId();
      if (typeof typeId !== 'string') typeId = 'roadmap';
      innerBtn.textContent = 'MAP · ' + MWMAP.mapInit.getMapTypeLabel(typeId);
    }

    function openModal() {
      if (modalOverlay) modalOverlay.classList.add('show');
    }

    function closeModal() {
      if (modalOverlay) modalOverlay.classList.remove('show');
    }

    if (mapBtn) mapBtn.addEventListener('click', openPanel);
    if (overlay) overlay.addEventListener('click', closePanel);

    if (innerBtn) {
      innerBtn.addEventListener('click', function () {
        openModal();
      });
    }

    if (modalOverlay) {
      modalOverlay.addEventListener('click', function (e) {
        if (e.target === modalOverlay) closeModal();
      });
    }
    if (modalDialog) {
      modalDialog.addEventListener('click', function (e) {
        e.stopPropagation();
      });
    }

    var options = document.querySelectorAll('.map-type-option');
    options.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var typeId = btn.getAttribute('data-type');
        if (typeId && MWMAP.mapInit && MWMAP.mapInit.setMapType) {
          MWMAP.mapInit.setMapType(typeId);
          updateMapButtonLabel();
          closeModal();
        }
      });
    });

    MWMAP.uiMapType = { bind: bind, closePanel: closePanel, updateMapButtonLabel: updateMapButtonLabel };
    updateMapButtonLabel();
  }

  MWMAP.uiMapType = { bind: bind };
})(window.MWMAP);
