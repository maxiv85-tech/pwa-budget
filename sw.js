// Мой Бюджет — service worker
// Приложение открывается из кэша мгновенно и без сети. Обновления:
//   «вручную» (по умолчанию) — сервер не запрашивается вообще, пока пользователь не нажмёт «Проверить обновление»;
//   «автоматически»          — при запуске в фоне проверяется свежая версия, применяется со следующего запуска.
// Файл sw.js не меняется между версиями приложения, поэтому обновлений «за спиной» пользователя не бывает.
const CACHE = 'budget-app';
const META = 'budget-meta';
const DL = 'budget-dl';          // временное хранилище для скачивания резервной копии обычной ссылкой
const FILES = ['./index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png'];
const FETCH_TIMEOUT = 10000;

// Ответ после редиректа нельзя отдавать на навигацию — копируем его «начисто»
const clean = async r => r.redirected ? new Response(await r.blob(), { status: 200, statusText: 'OK', headers: r.headers }) : r;

async function getMode() {
  try { const r = await (await caches.open(META)).match('mode'); return r ? await r.text() : 'manual'; }
  catch (_) { return 'manual'; }
}
async function setMode(m) {
  await (await caches.open(META)).put('mode', new Response(m === 'auto' ? 'auto' : 'manual'));
}

async function load(u, noCache) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
  try {
    const r = await fetch(u, { cache: noCache ? 'no-cache' : 'reload', signal: ctl.signal });
    if (!r || !r.ok) throw new Error('bad response: ' + u);
    return await clean(r);
  } finally { clearTimeout(timer); }
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const got = await Promise.all(FILES.map(async u => [u, await load(new Request(u), false)]));
    const c = await caches.open(CACHE);
    for (const [u, r] of got) await c.put(u, r);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = [CACHE, META, DL];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function broadcast(msg) {
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage(msg);
}

// Фоновое обновление одного файла (режим «автоматически»)
async function refresh(req, cache, key, isNav, cachedCopy) {
  try {
    const fresh = await load(isNav ? './index.html' : req, true);
    const changed = cachedCopy && isNav ? (await cachedCopy.text()) !== (await fresh.clone().text()) : false;
    await cache.put(key, fresh.clone());
    if (changed) await broadcast({ type: 'update' });
  } catch (_) { /* нет сети — не страшно */ }
}

// Проверка по кнопке: сначала скачиваем всё, потом заменяем кэш целиком (чтобы не получить «полуобновление»)
async function checkNow(client) {
  const reply = m => client ? client.postMessage(m) : broadcast(m);
  try {
    const cache = await caches.open(CACHE);
    const old = await cache.match('./index.html');
    const got = await Promise.all(FILES.map(async u => [u, await load(new Request(u), true)]));
    let changed = false;
    for (const [u, r] of got) {
      if (u === './index.html' && old) changed = (await old.text()) !== (await r.clone().text());
    }
    for (const [u, r] of got) await cache.put(u, r);
    reply({ type: 'checked', changed });
  } catch (_) {
    reply({ type: 'checked', error: true });
  }
}

self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'mode') e.waitUntil(setMode(d.mode));
  else if (d.type === 'check') e.waitUntil(checkNow(e.source));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // файл для скачивания, подготовленный страницей (с заголовком Content-Disposition: attachment)
  if (new URL(req.url).pathname.includes('/__dl/')) {
    e.respondWith((async () => {
      const r = await (await caches.open(DL)).match(req.url);
      return r || new Response('Файл не найден. Закройте окно и повторите сохранение.', { status: 404 });
    })());
    return;
  }
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const isNav = req.mode === 'navigate';
    const key = isNav ? './index.html' : req;
    const cached = await cache.match(key, { ignoreSearch: true });
    if (cached) {
      // копия для сравнения версий делается ДО отдачи ответа странице (после отдачи тело уже прочитано)
      const forCompare = isNav ? cached.clone() : null;
      if (await getMode() === 'auto') e.waitUntil(refresh(req, cache, key, isNav, forCompare));
      return cached;                                            // мгновенный ответ из кэша
    }
    try { const r = await load(isNav ? './index.html' : req, true); await cache.put(key, r.clone()); return r; }
    catch (_) { return Response.error(); }                      // кэша нет и сети нет — быстрая ошибка, без зависания
  })());
});
