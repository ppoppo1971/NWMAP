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

    /* 브이월드 타일 레이어 (WMAP 참조) */
    var vworldRoadmapType = new google.maps.ImageMapType({
      getTileUrl: function (coord, zoom) {
        return 'https://xdworld.vworld.kr/2d/Base/service/' + zoom + '/' + coord.x + '/' + coord.y + '.png';
      },
      tileSize: new google.maps.Size(256, 256),
      name: '브이월드일반',
      maxZoom: 19
    });
    var vworldSatelliteType = new google.maps.ImageMapType({
      getTileUrl: function (coord, zoom) {
        return 'https://xdworld.vworld.kr/2d/Satellite/service/' + zoom + '/' + coord.x + '/' + coord.y + '.jpeg';
      },
      tileSize: new google.maps.Size(256, 256),
      name: '브이월드영상',
      maxZoom: 19
    });
    map.mapTypes.set('브이월드일반', vworldRoadmapType);
    map.mapTypes.set('브이월드영상', vworldSatelliteType);

    geocoder = new google.maps.Geocoder();
    MWMAP.map = map;
    MWMAP.geocoder = geocoder;
    // 롱프레스 시 오버레이 클릭 1회 무시용 플래그
    MWMAP._skipOverlayClickOnce = false;

    // 지도 롱프레스 감지용 변수
    var longPressTimer = null;
    var longPressStartLatLng = null;
    var longPressTriggered = false;
    var LONG_PRESS_DURATION = 600; // ms
    var longPressStartClient = null; // pointer down 시 화면 좌표

    function clearLongPressTimer() {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    }

    // 지도 선택 시 양쪽 사이드 패널 자동 닫기 (롱프레스 클릭은 무시)
    google.maps.event.addListener(map, 'click', function () {
      if (longPressTriggered) {
        longPressTriggered = false;
        MWMAP._skipMapClickCloseOnce = true;
        return;
      }
      if (MWMAP.uiPanel && typeof MWMAP.uiPanel.closePanel === 'function') {
        MWMAP.uiPanel.closePanel();
      }
      if (MWMAP.uiMapType && typeof MWMAP.uiMapType.closePanel === 'function') {
        MWMAP.uiMapType.closePanel();
      }
    });

    // 픽셀 좌표 → 위경도 변환
    function clientPointToLatLng(clientX, clientY) {
      var rect = mapEl.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) return map.getCenter();
      var bounds = map.getBounds();
      if (!bounds) return map.getCenter();

      var xRatio = (clientX - rect.left) / rect.width;
      var yRatio = (clientY - rect.top) / rect.height;
      xRatio = Math.max(0, Math.min(1, xRatio));
      yRatio = Math.max(0, Math.min(1, yRatio));

      var sw = bounds.getSouthWest();
      var ne = bounds.getNorthEast();
      var lat = ne.lat() - yRatio * (ne.lat() - sw.lat());
      var lng = sw.lng() + xRatio * (ne.lng() - sw.lng());
      return new google.maps.LatLng(lat, lng);
    }

    function startLongPressFromClientPoint(clientX, clientY) {
      longPressTriggered = false;
      longPressStartClient = { x: clientX, y: clientY };
      longPressStartLatLng = clientPointToLatLng(clientX, clientY);
      clearLongPressTimer();
      longPressTimer = setTimeout(function () {
        longPressTimer = null;
        longPressTriggered = true;
        if (longPressStartLatLng) {
          // 이 롱프레스로 인해 발생하는 오버레이 click 1회 무시
          MWMAP._skipOverlayClickOnce = true;
          window.dispatchEvent(new CustomEvent('mwmappMapLongPress', {
            detail: { latLng: longPressStartLatLng }
          }));
        }
      }, LONG_PRESS_DURATION);
    }

    function handlePointerDown(e) {
      // 우클릭은 롱프레스 처리하지 않음 (rightclick 리스너 사용)
      if (e.type === 'mousedown' && e.button === 2) return;
      // 멀티터치는 롱프레스에서 제외
      if (e.type === 'touchstart' && e.touches && e.touches.length !== 1) return;

      var clientX, clientY;
      if (e.type === 'touchstart') {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else {
        clientX = e.clientX;
        clientY = e.clientY;
      }
      startLongPressFromClientPoint(clientX, clientY);
    }

    function handlePointerMove(e) {
      if (!longPressTimer || !longPressStartClient) return;
      var clientX, clientY;
      if (e.type === 'touchmove') {
        if (!e.touches || !e.touches.length) return;
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else {
        clientX = e.clientX;
        clientY = e.clientY;
      }
      var dx = clientX - longPressStartClient.x;
      var dy = clientY - longPressStartClient.y;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        clearLongPressTimer();
      }
    }

    function handlePointerUpOrCancel() {
      longPressStartClient = null;
      clearLongPressTimer();
    }

    // 캡처 단계에서 이벤트를 받아, 객체 위에서도 롱프레스 감지
    mapEl.addEventListener('mousedown', handlePointerDown, true);
    mapEl.addEventListener('touchstart', handlePointerDown, true);
    mapEl.addEventListener('mousemove', handlePointerMove, true);
    mapEl.addEventListener('touchmove', handlePointerMove, true);
    mapEl.addEventListener('mouseup', handlePointerUpOrCancel, true);
    mapEl.addEventListener('touchend', handlePointerUpOrCancel, true);
    mapEl.addEventListener('touchcancel', handlePointerUpOrCancel, true);

    // 데스크톱: 마우스 오른쪽 클릭으로도 롱프레스 기능 실행
    google.maps.event.addListener(map, 'rightclick', function (event) {
      longPressTriggered = true;
      var latLng = event && event.latLng ? event.latLng : null;
      if (latLng) {
        window.dispatchEvent(new CustomEvent('mwmappMapLongPress', {
          detail: { latLng: latLng }
        }));
      }
    });

    // dragstart/zoom_changed → 롱프레스 취소
    google.maps.event.addListener(map, 'dragstart', function () {
      clearLongPressTimer();
    });
    var prevZoom = map.getZoom();
    google.maps.event.addListener(map, 'zoom_changed', function () {
      var currentZoom = map.getZoom();
      if (currentZoom !== prevZoom) {
        clearLongPressTimer();
        longPressStartLatLng = null;
        longPressStartClient = null;
      }
      prevZoom = currentZoom;
    });

    return true;
  }

  var MAP_TYPE_LABELS = {
    roadmap: '구글(도로)',
    satellite: '구글(위성)',
    '브이월드일반': '브이월드(도로)',
    '브이월드영상': '브이월드(위성)'
  };

  function setMapType(typeId) {
    var m = MWMAP.map;
    if (!m || !m.setMapTypeId) return;
    m.setMapTypeId(typeId);
    var cfg = window.MWMAP_CONFIG || {};
    if (typeId === 'roadmap' && cfg.ROAD_ONLY_STYLE) {
      m.setOptions({ styles: cfg.ROAD_ONLY_STYLE });
    } else if (typeId === 'satellite' || typeId === '브이월드일반' || typeId === '브이월드영상') {
      m.setOptions({ styles: [] });
    }
  }

  function getMapTypeLabel(typeId) {
    return MAP_TYPE_LABELS[typeId] || typeId || '구글(도로)';
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

  MWMAP.mapInit = { create: create, bindZoomControls: bindZoomControls, setMapType: setMapType, getMapTypeLabel: getMapTypeLabel };
})(window.MWMAP);
