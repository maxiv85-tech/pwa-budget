// Мой Бюджет — service worker
// Стратегия: «сначала кэш, обновление в фоне». Приложение открывается мгновенно, даже без сети
// (в режиме полёта запрос к серверу мог висеть десятки секунд). Свежие файлы подтягиваются в фоне
// и применяются при следующем запуске; при обнаружении новой версии приложение покажет подсказку.
const CACHE = 'budget-v21';
const FILES = ['./index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png'];
const FETCH_TIMEOUT = 8000;

// Ответ после редиректа нельзя отдавать на навигацию — копируем его «начисто»
const clean = async r => r.redirected ? new Response(await r.blob(), { status: 200, statusText: 'OK', headers: r.headers }) : r;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(FILES.map(async u => {
      const r = await fetch(new Request(u, { cache: 'reload' }));
      if (!r.ok) throw new Error('precache failed: ' + u);
      await c.put(u, await clean(r));
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function notifyUpdate() {
  const cs = await self.clients.matchAll({ type: 'window' });
  cs.forEach(c => c.postMessage({ type: 'update' }));
}

// Фоновая проверка свежей версии: запрос с проверкой на сервере, результат кладём в кэш
async function refresh(req, cache, key, isNav, cached) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
  try {
    const r = await fetch(isNav ? './index.html' : req, { cache: 'no-cache', signal: ctl.signal });
    if (!r || !r.ok) return null;
    const fresh = await clean(r);
    let changed = false;
    if (cached && isNav) changed = (await cached.text()) !== (await fresh.clone().text());
    await cache.put(key, fresh.clone());
    if (changed) await notifyUpdate();
    return fresh;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const isNav = req.mode === 'navigate';
    const key = isNav ? './index.html' : req;
    const cached = await cache.match(key, { ignoreSearch: true });
    // копия для сравнения версий делается ДО отдачи ответа странице (после отдачи тело уже прочитано)
    const forCompare = cached && isNav ? cached.clone() : null;
    const job = refresh(req, cache, key, isNav, forCompare);
    if (cached) { e.waitUntil(job); return cached; }          // мгновенный ответ из кэша
    const fresh = await job;                                    // кэша нет — ждём сеть (не дольше таймаута)
    return fresh || Response.error();
  })());
});
