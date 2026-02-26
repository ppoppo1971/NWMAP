(function (global) {
  'use strict';

  /**
   * MWMAP 전역 설정
   * - 향후 DXF, 사진, 메모 등 기능이 붙어도 이 객체를 통해 공통 설정을 관리한다.
   */
  var GMAPS_API_KEY = 'AIzaSyDVwJrvIcbqAOX24g9JODhD7DGtTz7z2Pg'; // NDMAP과 동일 키 사용

  /**
   * 남한 영역 대략값
   * - 남서(SW): 위도 33.0, 경도 124.5
   * - 북동(NE): 위도 38.8, 경도 131.0
   * 필요 시 추후 더 정밀하게 조정 가능.
   */
  var KOREA_BOUNDS = {
    south: 33.0,
    west: 124.5,
    north: 38.8,
    east: 131.0
  };

  /** 지도 줌 범위 (확대/축소 버튼용) */
  var ZOOM_MIN = 1;
  var ZOOM_MAX = 20;

  /**
   * 도로 전용 스타일 (NDMAP ROAD_ONLY_STYLE 참고)
   * - POI, 대중교통, 모든 라벨을 숨기고
   *   도로 지오메트리만 간결하게 남긴다.
   */
  var ROAD_ONLY_STYLE = [
    { featureType: 'poi', elementType: 'geometry', stylers: [{ visibility: 'off' }] },
    { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', elementType: 'geometry', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', elementType: 'labels', stylers: [{ visibility: 'off' }] },
    { featureType: 'administrative', elementType: 'all', stylers: [{ visibility: 'off' }] },
    { featureType: 'all', elementType: 'labels', stylers: [{ visibility: 'off' }] },
    { featureType: 'all', elementType: 'labels.text', stylers: [{ visibility: 'off' }] },
    { featureType: 'all', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ visibility: 'simplified' }] }
  ];

  global.MWMAP_CONFIG = {
    GMAPS_API_KEY: GMAPS_API_KEY,
    KOREA_BOUNDS: KOREA_BOUNDS,
    ROAD_ONLY_STYLE: ROAD_ONLY_STYLE,
    ZOOM_MIN: ZOOM_MIN,
    ZOOM_MAX: ZOOM_MAX
  };
})(typeof window !== 'undefined' ? window : this);

