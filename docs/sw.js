// 서비스 워커: 오프라인 실행(앱 파일 캐시), 자동 업데이트, 푸시 알림
const CACHE = 'st-pwa-v2';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './lib/dates.js',
  './lib/lunar.js',
  './lib/holidays.js',
  './lib/recur.js',
  './lib/gsync.js',
  './vendor/korean-lunar-calendar.mjs',
  './icons/icon-192.png',
  './icons/badge-96.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 앱 파일: 네트워크 우선(항상 최신) → 실패하면 캐시. Google API 등 외부 요청은 건드리지 않음.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html')))
  );
});

// PC 프로그램이 보내는 알림
self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: '일정 & 할일', body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || '일정 & 할일', {
      body: d.body || '',
      tag: d.tag || undefined,
      icon: './icons/icon-192.png',
      badge: './icons/badge-96.png',
      data: { tab: d.tab || '' },
      requireInteraction: true,
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const tab = e.notification.data?.tab || '';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.postMessage({ type: 'open-tab', tab });
          return c.focus();
        }
      }
      return self.clients.openWindow(`./${tab ? `#${tab}` : ''}`);
    })
  );
});
