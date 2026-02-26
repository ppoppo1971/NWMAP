'use strict';

/**
 * 위치검색: Geocoding + Places (한국어/한국 지역), 마커 클릭 시 이름·주소만 표시
 */
(function (MWMAP) {
  var addressMarkers = [];
  var currentInfoWindow = null;

  function clearMarkers() {
    addressMarkers.forEach(function (m) {
      if (m && m.setMap) m.setMap(null);
    });
    addressMarkers = [];
  }

  /** 화면 밖으로 나간 마커만 제거 */
  function removeMarkersOutsideBounds() {
    var map = MWMAP.map;
    if (!map) return;
    var bounds = map.getBounds();
    if (!bounds) return;
    var kept = [];
    addressMarkers.forEach(function (m) {
      if (m && m.getPosition && bounds.contains(m.getPosition())) {
        kept.push(m);
      } else {
        if (m && m.setMap) m.setMap(null);
      }
    });
    addressMarkers = kept;
  }

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function bind() {
    var map = MWMAP.map;
    var geocoder = MWMAP.geocoder;
    var inputEl = document.getElementById('address-input');

    function searchAddress() {
      var query = (inputEl && inputEl.value) ? inputEl.value.trim() : '';
      if (!query) {
        alert('검색어를 입력하세요.');
        return;
      }
      if (!map || !geocoder) {
        alert('지도가 아직 준비되지 않았습니다.');
        return;
      }
      clearMarkers();
      performSearch(query);
    }

    function performSearch(query) {
      var allResults = [];
      var done = 0;
      var total = 2;

      function onDone() {
        done++;
        if (done >= total) processResults(allResults, query);
      }

      geocoder.geocode({
        address: query,
        bounds: map.getBounds() || undefined,
        region: 'kr',
        language: 'ko'
      }, function (results, status) {
        if (status === 'OK' && results && results.length) {
          results.forEach(function (r) {
            allResults.push({
              geometry: r.geometry,
              formatted_address: r.formatted_address,
              name: r.formatted_address,
              place_id: r.place_id,
              source: 'geocoding'
            });
          });
        }
        onDone();
      });

      if (window.google.maps.places && window.google.maps.places.PlacesService) {
        var service = new google.maps.places.PlacesService(map);
        var request = {
          query: query,
          bounds: map.getBounds() || undefined,
          region: 'kr',
          language: 'ko'
        };
        service.textSearch(request, function (results, status) {
          if (status === google.maps.places.PlacesServiceStatus.OK && results && results.length) {
            results.forEach(function (r) {
              allResults.push({
                geometry: { location: r.geometry.location },
                formatted_address: r.formatted_address || r.name,
                name: r.name,
                place_id: r.place_id,
                source: 'places_text'
              });
            });
          }
          onDone();
        });
      } else {
        onDone();
      }
    }

    function processResults(allResults, query) {
      var seen = {};
      var unique = [];
      allResults.forEach(function (r) {
        var loc = r.geometry.location;
        var lat = typeof loc.lat === 'function' ? loc.lat() : loc.lat;
        var lng = typeof loc.lng === 'function' ? loc.lng() : loc.lng;
        var key = r.place_id || (lat.toFixed(5) + ',' + lng.toFixed(5));
        if (!seen[key]) {
          seen[key] = true;
          unique.push(r);
        }
      });

      var bounds = map.getBounds();
      var filtered = bounds ? unique.filter(function (r) {
        return bounds.contains(r.geometry.location);
      }) : unique;

      if (!filtered.length) {
        alert('현재 화면 범위 내에서 검색 결과가 없습니다. 지도를 이동·확대 후 다시 시도하세요.');
        return;
      }

      var scored = filtered.map(function (r) {
        var name = (r.name || r.formatted_address || '').toLowerCase();
        var q = query.toLowerCase();
        var score = name.indexOf(q) >= 0 ? 50 : 0;
        if (name === q) score = 100;
        else if (name.indexOf(q) === 0) score = 80;
        return { _score: score, result: r };
      });
      scored.sort(function (a, b) { return b._score - a._score; });
      var results = scored.map(function (x) { return x.result; });
      showMarkersOnMap(results);
    }

    /** 검색 결과를 목록 모달 없이 지도에 마커로 바로 표시 */
    function showMarkersOnMap(results) {
      var bounds = new google.maps.LatLngBounds();

      results.forEach(function (result) {
        var loc = result.geometry.location;
        var name = result.name || result.formatted_address || '';
        var address = result.formatted_address || result.vicinity || '';

        var marker = new google.maps.Marker({
          position: loc,
          map: map,
          title: name,
          zIndex: 1000,
          icon: {
            url: 'https://maps.google.com/mapfiles/ms/icons/red-dot.png',
            scaledSize: new google.maps.Size(36, 36)
          }
        });

        var infoContent = '<div style="padding:12px; max-width:280px; font-family:sans-serif;">' +
          '<div style="font-weight:700; margin-bottom:6px;">' + escapeHtml(name) + '</div>' +
          (address ? '<div style="font-size:13px; color:#6b7280;">' + escapeHtml(address) + '</div>' : '') +
          '</div>';
        var infoWindow = new google.maps.InfoWindow({ content: infoContent });

        marker.addListener('click', function () {
          if (currentInfoWindow) currentInfoWindow.close();
          currentInfoWindow = infoWindow;
          infoWindow.open(map, marker);
        });

        addressMarkers.push(marker);
        bounds.extend(loc);
      });

      if (addressMarkers.length === 1) {
        map.setCenter(results[0].geometry.location);
        map.setZoom(Math.max(map.getZoom() || 10, 14));
      } else if (addressMarkers.length > 1) {
        map.fitBounds(bounds, { top: 60, right: 40, bottom: 40, left: 40 });
      }
    }

    /** 지도 클릭 시 정보창 닫기 (모달 외 터치로 닫기) */
    google.maps.event.addListener(map, 'click', function () {
      if (currentInfoWindow) {
        currentInfoWindow.close();
        currentInfoWindow = null;
      }
    });

    /** 화면 이동 후 화면 밖 마커 제거 */
    google.maps.event.addListener(map, 'idle', removeMarkersOutsideBounds);

    if (inputEl) {
      inputEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') searchAddress();
      });
    }
  }

  MWMAP.mapSearch = { bind: bind };
})(window.MWMAP);
