'use strict';

/**
 * 현재 위치 표시 (방식: NDMAP 참조, 스타일: WMAP 참조)
 * - NDMAP: getCurrentPosition → 마커 표시 → panTo, 지도 클릭 시 마커 제거
 * - WMAP: 오른쪽 하단 버튼(📌), 로딩 상태, 위치 마커 아이콘(📌 SVG)
 */
(function (MWMAP) {
  var currentLocationMarker = null;
  var currentLocationClickListener = null;

  function getLocationMarkerIcon(isMobile) {
    var size = isMobile ? 28 : 32;
    var half = size / 2;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' + size + '" height="' + size + '">' +
      '<text x="12" y="20" font-family="Arial, sans-serif" font-size="24" text-anchor="middle" fill="#FF0000">📌</text>' +
      '</svg>';
    return {
      url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
      scaledSize: new google.maps.Size(size, size),
      anchor: new google.maps.Point(half, half)
    };
  }

  function clearLocationUI() {
    var btn = document.getElementById('location-btn');
    if (btn) {
      btn.classList.remove('loading');
      btn.textContent = '📌';
    }
  }

  function bind() {
    var map = MWMAP.map;
    var btn = document.getElementById('location-btn');
    if (!map || !btn) return;

    var isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    btn.addEventListener('click', function () {
      if (btn.classList.contains('loading')) return;
      if (!navigator.geolocation) {
        alert('이 기기에서는 위치를 사용할 수 없습니다.');
        return;
      }

      if (currentLocationMarker) {
        currentLocationMarker.setMap(null);
        currentLocationMarker = null;
      }
      if (currentLocationClickListener) {
        google.maps.event.removeListener(currentLocationClickListener);
        currentLocationClickListener = null;
      }

      btn.classList.add('loading');
      btn.textContent = '로딩중...';

      navigator.geolocation.getCurrentPosition(
        function (pos) {
          var lat = pos.coords.latitude;
          var lng = pos.coords.longitude;
          var accuracy = pos.coords.accuracy;
          var position = { lat: lat, lng: lng };

          currentLocationMarker = new google.maps.Marker({
            map: map,
            position: position,
            title: '현재 위치 (정확도: ' + (accuracy ? accuracy.toFixed(0) : '?') + 'm)',
            zIndex: 1000,
            icon: getLocationMarkerIcon(isMobile),
            optimized: isMobile ? false : true
          });

          map.panTo(position);
          var z = map.getZoom();
          if (typeof z === 'number') map.setZoom(Math.max(z, 15));

          currentLocationClickListener = map.addListener('click', function () {
            if (currentLocationMarker) {
              currentLocationMarker.setMap(null);
              currentLocationMarker = null;
            }
            if (currentLocationClickListener) {
              google.maps.event.removeListener(currentLocationClickListener);
              currentLocationClickListener = null;
            }
          });

          clearLocationUI();
        },
        function () {
          clearLocationUI();
          alert('위치를 가져올 수 없습니다. 위치 권한을 허용했는지 확인하세요.');
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 } // maximumAge: 0 = 캐시 미사용, 버튼 누른 시점의 실시간 위치 사용
      );
    });
  }

  MWMAP.mapLocation = { bind: bind };
})(window.MWMAP);
