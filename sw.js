// WOORI MAP Service Worker (PWA 지원 및 네트워크 우선 캐싱)
const CACHE_NAME = 'mwmap-cache-v1';

// 설치 시 즉시 활성화
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// 활성화 시 이전 캐시 정리 및 제어권 즉시 획득
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// 네트워크 요청 가로채기 (네트워크 우선 전략)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Firebase, Google Maps API, 브이월드(VWorld) 타일 등 외부 API 및 동적 요청은
  //    서비스 워커가 간섭하지 않고 브라우저 네트워크로 직접 통과시킵니다.
  if (
    url.origin !== self.location.origin ||
    event.request.method !== 'GET' ||
    url.pathname.includes('firestore') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('vworld.kr') ||
    url.hostname.includes('google.com')
  ) {
    return; // 브라우저 기본 네트워크 처리
  }

  // 2. 앱 자체의 정적 파일(HTML, JS, CSS, 아이콘 등):
  //    항상 네트워크에서 최신 버전을 먼저 가져오고, 네트워크가 끊겼을 때만 캐시를 사용합니다.
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // 오프라인 상태일 때 캐시된 파일 제공
        return caches.match(event.request);
      })
  );
});
