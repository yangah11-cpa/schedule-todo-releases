// 서비스 워커: 오프라인 실행(앱 파일 캐시), 자동 업데이트, 푸시 알림
const CACHE = 'st-pwa-v19';
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
  './lib/mailparse.js',
  './lib/gmail.js',
  './lib/attext.js',
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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'st-share').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 앱 파일: 네트워크 우선(항상 최신) → 실패하면 캐시. Google API 등 외부 요청은 건드리지 않음.
// 휴대폰 공유(카톡·문자·사진 등) 받기: 받은 글·이미지를 잠시 보관하고 앱을 연다
const SHARE = 'st-share';
async function receiveShare(req) {
  const fd = await req.formData();
  const c = await caches.open(SHARE);
  const keys = await c.keys();
  await Promise.all(keys.map((k) => c.delete(k)));
  const files = fd.getAll('files').filter((f) => f && typeof f !== 'string' && f.size);
  const meta = { title: fd.get('title') || '', text: fd.get('text') || '', url: fd.get('url') || '', files: [] };
  for (const [i, f] of files.slice(0, 3).entries()) {
    const key = `./__share__/file${i}`;
    if (/^text\//.test(f.type) || /\.txt$/i.test(f.name || '')) meta.text += `\n${await f.text()}`;
    else {
      await c.put(key, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }));
      meta.files.push({ key, type: f.type, name: f.name || '' });
    }
  }
  await c.put('./__share__/meta', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
  return Response.redirect('./index.html?shared=1', 303);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(e.request).catch(() => Response.redirect('./index.html?shared=0', 303)));
    return;
  }
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
