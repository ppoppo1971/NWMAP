'use strict';

/**
 * 지도 초기화 및 줌 컨트롤
 * - create(): 지도·Geocoder 생성, MWMAP.map / MWMAP.geocoder 설정
 * - bindZoomControls(): 확대/축소 버튼 바인딩
 */
(function (MWMAP) {
  var map = null;
  var geocoder = null;

  function create() {
    var cfg = window.MWMAP_CONFIG || {};
    var boundsCfg = cfg.KOREA_BOUNDS;

    if (!window.google || !window.google.maps) {
      console.error('Google Maps API 가 로드되지 않았습니다.');
      return false;
    }

    var mapEl = document.getElementById('map');
    if (!mapEl) {
      console.error('#map 요소를 찾을 수 없습니다.');
      return false;
    }

    var centerLat = (boundsCfg.south + boundsCfg.north) / 2;
    var centerLng = (boundsCfg.west + boundsCfg.east) / 2;

    map = new google.maps.Map(mapEl, {
      center: { lat: centerLat, lng: centerLng },
      zoom: 7,
      mapTypeId: 'roadmap',
      disableDefaultUI: true,
      zoomControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      mapTypeControl: false,
      scaleControl: false,
      rotateControl: false,
      clickableIcons: false,
      gestureHandling: 'greedy',
      styles: cfg.ROAD_ONLY_STYLE || null
    });

    if (boundsCfg) {
      var koreaBounds = new google.maps.LatLngBounds(
        { lat: boundsCfg.south, lng: boundsCfg.west },
        { lat: boundsCfg.north, lng: boundsCfg.east }
      );
      map.fitBounds(koreaBounds);
      google.maps.event.addListenerOnce(map, 'idle', function () {
        var currentZoom = map.getZoom();
        if (typeof currentZoom === 'number') map.setZoom(currentZoom + 1);
      });
    }

    geocoder = new google.maps.Geocoder();
    MWMAP.map = map;
    MWMAP.geocoder = geocoder;
    return true;
  }

  function bindZoomControls() {
    var cfg = window.MWMAP_CONFIG || {};
    var minZoom = cfg.ZOOM_MIN != null ? cfg.ZOOM_MIN : 1;
    var maxZoom = cfg.ZOOM_MAX != null ? cfg.ZOOM_MAX : 20;
    var m = MWMAP.map;
    if (!m) return;

    function zoomIn() {
      var z = m.getZoom();
      if (typeof z === 'number') m.setZoom(Math.min(z + 1, maxZoom));
    }
    function zoomOut() {
      var z = m.getZoom();
      if (typeof z === 'number') m.setZoom(Math.max(z - 1, minZoom));
    }

    var inBtn = document.getElementById('zoom-in-btn');
    var outBtn = document.getElementById('zoom-out-btn');
    if (inBtn) inBtn.addEventListener('click', zoomIn);
    if (outBtn) outBtn.addEventListener('click', zoomOut);
  }

  MWMAP.mapInit = { create: create, bindZoomControls: bindZoomControls };
})(window.MWMAP);
