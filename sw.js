/* 총무관리시스템 서비스워커 — 오프라인 지원 + 빠른 로딩
   전략: 같은 출처 GET은 "네트워크 우선, 실패 시 캐시"(항상 최신 우선, 오프라인 시 마지막 캐시).
         Supabase 등 외부 요청/데이터는 캐시하지 않음(항상 실시간). */
const CACHE = 'gongmu-cache-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 외부(Supabase API, CDN 폰트 등)는 서비스워커가 개입하지 않음 → 항상 네트워크
  if (url.origin !== location.origin) return;

  // 같은 출처(우리 앱 파일): 네트워크 우선, 실패하면 캐시, 그것도 없으면 index
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((r) => r || caches.match('./index.html'))
      )
  );
});
