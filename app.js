'use strict';

/**
 * MWMAP 전역 네임스페이스
 * - 이후 기능을 추가할 때 이 객체 아래로 모듈별 속성을 붙여 나갈 수 있다.
 *   예) MWMAP.dxf, MWMAP.photos, MWMAP.ui 등
 */
window.MWMAP = window.MWMAP || {};

(function (MWMAP) {
  var map = null;

  /**
   * 초기 지도 생성
   * - WMAP 처럼 남한 전체가 보이도록 bounds 기준으로 화면을 맞춘다.
   * - 다른 기능(마커, 메뉴 등)은 아직 추가하지 않는다.
   */
  function initMap() {
    var cfg = window.MWMAP_CONFIG || {};
    var boundsCfg = cfg.KOREA_BOUNDS;

    if (!window.google || !window.google.maps) {
      console.error('Google Maps API 가 로드되지 않았습니다. config.js 의 키와 네트워크 상태를 확인하세요.');
      return;
    }

    var mapEl = document.getElementById('map');
    if (!mapEl) {
      console.error('#map 요소를 찾을 수 없습니다.');
      return;
    }

    // 기본 중심은 남한 중간 지점 근처
    var centerLat = (boundsCfg.south + boundsCfg.north) / 2;
    var centerLng = (boundsCfg.west + boundsCfg.east) / 2;

    map = new google.maps.Map(mapEl, {
      center: { lat: centerLat, lng: centerLng },
      zoom: 7,
      mapTypeId: 'roadmap',
      // UI 요소를 모두 제거하고 제스처만 허용
      disableDefaultUI: true,
      zoomControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      mapTypeControl: false,
      scaleControl: false,
      rotateControl: false,
      clickableIcons: false,
      gestureHandling: 'greedy',
      // WMAP 초기 화면처럼 도로와 지형만 보이도록 하는 스타일
      styles: cfg.ROAD_ONLY_STYLE || null
    });

    // 남한 전체가 보이도록 영역 맞추기
    if (boundsCfg) {
      var koreaBounds = new google.maps.LatLngBounds(
        { lat: boundsCfg.south, lng: boundsCfg.west },
        { lat: boundsCfg.north, lng: boundsCfg.east }
      );
      map.fitBounds(koreaBounds);

      // fitBounds 로 결정된 초기 축척보다 한 단계 더 확대
      google.maps.event.addListenerOnce(map, 'idle', function () {
        var currentZoom = map.getZoom();
        if (typeof currentZoom === 'number') {
          map.setZoom(currentZoom + 1);
        }
      });
    }

    MWMAP.map = map;
    bindZoomControls();
    bindProjectPanel();
  }

  /** 프로젝트 버튼·사이드 패널 (WMAP 방식: 버튼 클릭 시 패널 열기, 오버레이/닫기로 닫기) */
  function bindProjectPanel() {
    var btn = document.getElementById('project-btn');
    var panel = document.getElementById('project-panel');
    var overlay = document.getElementById('project-panel-overlay');
    var closeBtn = document.getElementById('project-panel-close');

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
    if (closeBtn) closeBtn.addEventListener('click', closePanel);
  }

  /** 확대/축소 버튼 동작 (WMAP 참고) */
  function bindZoomControls() {
    var cfg = window.MWMAP_CONFIG || {};
    var minZoom = cfg.ZOOM_MIN != null ? cfg.ZOOM_MIN : 1;
    var maxZoom = cfg.ZOOM_MAX != null ? cfg.ZOOM_MAX : 20;

    function zoomIn() {
      if (!map) return;
      var z = map.getZoom();
      if (typeof z === 'number') map.setZoom(Math.min(z + 1, maxZoom));
    }
    function zoomOut() {
      if (!map) return;
      var z = map.getZoom();
      if (typeof z === 'number') map.setZoom(Math.max(z - 1, minZoom));
    }

    var inBtn = document.getElementById('zoom-in-btn');
    var outBtn = document.getElementById('zoom-out-btn');
    if (inBtn) inBtn.addEventListener('click', zoomIn);
    if (outBtn) outBtn.addEventListener('click', zoomOut);
  }

  // Google Maps API 의 callback 이 호출할 전역 함수로 노출
  window.initMap = initMap;
})(window.MWMAP);

