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
    // 有网先拿最新页面，没网或超时再用缓存
    event.respondWith(
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

/* ---------- 推送通知 ---------- */
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
    let raw = '';
    let data = {};
    let err = '';

    try {
      raw = event.data ? event.data.text() : '';
    } catch (e) {
      err = 'text:' + e.message;
    }
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (e) {
      data = { body: raw };
      err = (err + ' json:' + e.message).trim();
    }

    await logPush({ at: Date.now(), raw: raw, parsed: data, err: err });

    // 告诉正在开着的页面
    try {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of list) c.postMessage({ type: 'push-received', payload: data });
    } catch (e) {}

    const title = data.title || '大肥鱼：要上课啦';
    const body = data.body || '该去教室了';

    // iOS 对 options 挑，先给最简的，失败再降级
    try {
      await self.registration.showNotification(title, {
        body: body,
        tag: data.tag || 'class',
        data: { url: data.url || './' }
      });
    } catch (e1) {
      await logPush({ at: Date.now(), raw: raw, parsed: data, err: 'show1:' + e1.message, fallback: true });
      try {
        await self.registration.showNotification(title, { body: body });
      } catch (e2) {
        await logPush({ at: Date.now(), raw: raw, parsed: data, err: 'show2:' + e2.message, fallback: true });
      }
    }
  })());
});

/* ---------- 点通知：回到 App ---------- */
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
