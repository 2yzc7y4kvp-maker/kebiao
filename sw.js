const CACHE = 'huang-schedule-v11';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const isDoc = req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') >= 0;

  if (isDoc) {
    // 鏈夌綉鍏堟嬁鏈€鏂伴〉闈紝娌＄綉鎴栬秴鏃跺啀鐢ㄧ紦瀛?    event.respondWith(
      Promise.race([fetch(req), timeout(4000)]).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('./index.html', copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match('./index.html').then(hit => hit || caches.match('./')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(hit => {
      if (hit) return hit;
      return fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});

/* ---------- 鎺ㄩ€侀€氱煡 ---------- */
const PUSH_LOG = 'push-log';
const PUSH_LOG_KEY = './__lastpush';

async function logPush(entry) {
  try {
    const c = await caches.open(PUSH_LOG);
    await c.put(PUSH_LOG_KEY, new Response(JSON.stringify(entry), {
      headers: { 'Content-Type': 'application/json' }
    }));
  } catch (e) {}
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let raw = '', data = {}, err = '';
    try { raw = event.data ? event.data.text() : ''; } catch (e) { err = 'text:' + e.message; }
    try { data = raw ? JSON.parse(raw) : {}; } catch (e) { data = { body: raw }; err = (err + ' json:' + e.message).trim(); }

    await logPush({ at: Date.now(), raw, parsed: data, err });

    // 鍛婅瘔寮€鐫€鐨勯〉闈?    try {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of list) c.postMessage({ type: 'push-received', payload: data });
    } catch (e) {}

    const title = data.title || '澶ц偉楸硷細瑕佷笂璇惧暒';
    const body = data.body || '璇ュ幓鏁欏浜?;

    // iOS 瀵?options 鎸戯紝鍏堢粰鏈€绠€鐨勶紱澶辫触鍐嶉檷绾?    try {
      await self.registration.showNotification(title, {
        body, tag: data.tag || 'class', data: { url: data.url || './' }
      });
    } catch (e1) {
      await logPush({ at: Date.now(), raw, parsed: data, err: 'show1:' + e1.message, fallback: true });
      try {
        await self.registration.showNotification(title, { body });
      } catch (e2) {
        await logPush({ at: Date.now(), raw, parsed: data, err: 'show2:' + e2.message, fallback: true });
      }
    }
  })());
});

/* ---------- 鐐归€氱煡锛氬洖鍒?App ---------- */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
