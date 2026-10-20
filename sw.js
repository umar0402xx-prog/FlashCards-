/* Offline support for A Level Recall.
   Bump VERSION whenever app files (not decks) change so phones pick up the new version. */
const VERSION = '1.0.2';
const SHELL = 'recall-shell-' + VERSION;
const DECKS = 'recall-decks';
const FONTS = 'recall-fonts';

const KATEX_FONTS = [
  'AMS-Regular', 'Caligraphic-Bold', 'Caligraphic-Regular', 'Fraktur-Bold', 'Fraktur-Regular',
  'Main-Bold', 'Main-BoldItalic', 'Main-Italic', 'Main-Regular', 'Math-BoldItalic', 'Math-Italic',
  'SansSerif-Bold', 'SansSerif-Italic', 'SansSerif-Regular', 'Script-Regular',
  'Size1-Regular', 'Size2-Regular', 'Size3-Regular', 'Size4-Regular', 'Typewriter-Regular'
].map(n => `vendor/katex/fonts/KaTeX_${n}.woff2`);

const SHELL_FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'vendor/katex/katex.min.css',
  'vendor/katex/katex.min.js',
  'vendor/katex/contrib/auto-render.min.js',
  'vendor/katex/contrib/mhchem.min.js',
  ...KATEX_FONTS
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL).then(cache => cache.addAll(SHELL_FILES.map(f => new Request(f, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('recall-shell-') && k !== SHELL).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// Decks: try the network first so Claude's new cards show up, fall back to the saved copy offline.
async function networkFirst(request) {
  const cache = await caches.open(DECKS);
  const key = request.url.split('?')[0];
  try {
    const res = await withTimeout(fetch(request), 5000);
    if (res && res.ok) cache.put(key, res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match(key);
    if (cached) return cached;
    throw e;
  }
}

// App files: answer from the cache straight away, refresh it in the background.
async function staleWhileRevalidate(request, cacheName, cacheKey) {
  const cache = await caches.open(cacheName);
  const key = cacheKey || request;
  const cached = await cache.match(key);
  const refresh = fetch(request).then(res => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(key, res.clone());
    return res;
  }).catch(() => null);
  if (cached) return cached;
  const res = await refresh;
  if (res) return res;
  return new Response('Offline', { status: 503, statusText: 'Offline' });
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(request, FONTS).catch(() => new Response('', { status: 503 })));
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes('/decks/') && url.pathname.endsWith('.json')) {
    event.respondWith(networkFirst(request));
    return;
  }
  if (request.mode === 'navigate') {
    const indexUrl = new URL('index.html', self.registration.scope).href;
    event.respondWith(staleWhileRevalidate(new Request(indexUrl), SHELL, indexUrl));
    return;
  }
  event.respondWith(staleWhileRevalidate(request, SHELL));
});
