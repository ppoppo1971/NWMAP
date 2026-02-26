'use strict';

/**
 * MWMAP 진입점
 * - Google Maps API callback 으로 initMap 호출 후 각 모듈 create/bind 실행
 */
(function () {
  function initMap() {
    if (!window.google || !window.google.maps) {
      console.error('Google Maps API 가 로드되지 않았습니다.');
      return;
    }

    var MWMAP = window.MWMAP;
    if (!MWMAP || !MWMAP.mapInit || !MWMAP.mapInit.create) {
      console.error('MWMAP.mapInit 이 로드되지 않았습니다. 스크립트 로드 순서를 확인하세요.');
      return;
    }

    if (!MWMAP.mapInit.create()) return;

    if (MWMAP.mapInit.bindZoomControls) MWMAP.mapInit.bindZoomControls();
    if (MWMAP.mapSearch && MWMAP.mapSearch.bind) MWMAP.mapSearch.bind();
    if (MWMAP.uiPanel && MWMAP.uiPanel.bind) MWMAP.uiPanel.bind();
    if (MWMAP.sites && MWMAP.sites.bind) MWMAP.sites.bind();
    if (typeof window.__setVh === 'function') {
      window.__setVh();
      setTimeout(window.__setVh, 100);
    }
  }

  window.initMap = initMap;
})();
