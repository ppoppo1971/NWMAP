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

    // 지도 롱프레스 감지용 변수
    var longPressTimer = null;
    var longPressStartLatLng = null;
    var longPressTriggered = false;
    var LONG_PRESS_DURATION = 600; // ms
    var longPressStartPixel = null;

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
        return;
      }
      if (MWMAP.uiPanel && typeof MWMAP.uiPanel.closePanel === 'function') {
        MWMAP.uiPanel.closePanel();
      }
      if (MWMAP.uiMapType && typeof MWMAP.uiMapType.closePanel === 'function') {
        MWMAP.uiMapType.closePanel();
      }
    });

    // 지도 mousedown → 롱프레스 타이머 시작
    google.maps.event.addListener(map, 'mousedown', function (event) {
      longPressTriggered = false;
      longPressStartLatLng = event && event.latLng ? event.latLng : null;
      var projection = map.getProjection();
      if (projection && longPressStartLatLng) {
        longPressStartPixel = projection.fromLatLngToPoint(longPressStartLatLng);
      } else {
        longPressStartPixel = null;
      }
      clearLongPressTimer();
      longPressTimer = setTimeout(function () {
        longPressTimer = null;
        longPressTriggered = true;
        if (longPressStartLatLng) {
          window.dispatchEvent(new CustomEvent('mwmappMapLongPress', {
            detail: { latLng: longPressStartLatLng }
          }));
        }
      }, LONG_PRESS_DURATION);
    });

    // 지도 mousemove → 일정 이상 이동 시 롱프레스 취소
    google.maps.event.addListener(map, 'mousemove', function (event) {
      if (!longPressTimer || !longPressStartPixel || !event || !event.latLng) return;
      var projection = map.getProjection();
      if (!projection) return;
      var currentPixel = projection.fromLatLngToPoint(event.latLng);
      var dx = Math.abs(currentPixel.x - longPressStartPixel.x);
      var dy = Math.abs(currentPixel.y - longPressStartPixel.y);
      if (dx > 0.0005 || dy > 0.0005) {
        clearLongPressTimer();
      }
    });

    // mouseup/dragstart/zoom_changed → 롱프레스 취소
    google.maps.event.addListener(map, 'mouseup', function () {
      clearLongPressTimer();
    });
    google.maps.event.addListener(map, 'dragstart', function () {
      clearLongPressTimer();
    });
    var prevZoom = map.getZoom();
    google.maps.event.addListener(map, 'zoom_changed', function () {
      var currentZoom = map.getZoom();
      if (currentZoom !== prevZoom) {
        clearLongPressTimer();
        longPressStartLatLng = null;
        longPressStartPixel = null;
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
