const CACHE = 'orbit-shell-v2';
const SHELL = '/app';
async function receipt(message, state) {
  const value = message?.receipt;
  if (
    !value ||
    typeof value.workspaceId !== 'string' ||
    typeof value.deliveryId !== 'string' ||
    typeof value.token !== 'string'
  )
    return;
  await fetch('/api/v1/notification-delivery/receipts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...value, state }),
    credentials: 'omit',
    cache: 'no-store',
  }).catch(() => {});
}
self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let message;
      try {
        message = event.data?.json();
      } catch {
        return;
      }
      if (!message || typeof message !== 'object') return;
      await self.registration.showNotification('Orbit', {
        body: 'Open Orbit to view your notifications.',
        tag: typeof message.tag === 'string' ? message.tag.slice(0, 80) : 'orbit',
        data: { receipt: message.receipt },
      });
      await receipt(message, 'received');
    })(),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      await receipt(event.notification.data, 'opened');
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find(
        (client) =>
          new URL(client.url).origin === self.location.origin &&
          new URL(client.url).pathname === '/app',
      );
      if (existing) await existing.focus();
      else await self.clients.openWindow('/app');
    })(),
  );
});
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE),
        response = await fetch(SHELL);
      if (!response.ok) throw new Error('Shell is unavailable');
      await cache.put(SHELL, response.clone());
      const html = await response.text(),
        assets = [...html.matchAll(/(?:src|href)="([^" ]+)"/g)]
          .map((match) => new URL(match[1], self.location.origin))
          .filter(
            (url) =>
              url.origin === self.location.origin && url.pathname.startsWith('/_next/static/'),
          );
      await Promise.all(
        assets.map(async (url) => {
          const asset = await fetch(url);
          if (asset.ok) await cache.put(url, asset);
        }),
      );
      await self.skipWaiting();
    })(),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith('orbit-shell-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener('fetch', (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  const shell = request.mode === 'navigate' && url.pathname === SHELL,
    asset = url.pathname.startsWith('/_next/static/');
  if (!shell && !asset) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE),
        key = shell ? SHELL : request;
      try {
        const response = await fetch(request);
        if (response.ok) {
          await cache.put(key, response.clone());
          const keys = await cache.keys();
          for (const expired of keys.slice(0, Math.max(0, keys.length - 200)))
            if (new URL(expired.url).pathname !== SHELL) await cache.delete(expired);
        }
        return response;
      } catch (error) {
        const cached = await cache.match(key);
        if (cached) return cached;
        throw error;
      }
    })(),
  );
});
