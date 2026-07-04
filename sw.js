/**
 * NIF Platform Service Worker — Offline-First
 * © Fumoca Technologies · fumoca.co.za
 *
 * Strategies:
 *   App shell (HTML/JS/CSS):  Cache-first, background revalidate
 *   Google Fonts:             Cache-first (permanent)
 *   API /nif/:id:             Network-first, 5-min cache fallback
 *   NIF stream/R2 signed URLs: Network-only (time-limited signatures)
 *   POST/PATCH/DELETE:        Network-only, queue if offline
 *
 * Offline upload queue:
 *   Uploads that fail due to no network are stored in IndexedDB.
 *   Background sync fires when connectivity returns.
 */

const V              = 'nif-v3';
const SHELL_CACHE    = `${V}-shell`;
const API_CACHE      = `${V}-api`;
const FONT_CACHE     = `${V}-fonts`;
const API_TTL_MS     = 5 * 60 * 1000; // 5 minutes

const APP_SHELL = [
  '/',
  '/dashboard',
  '/feed',
  '/editor',
  '/print',
  '/capture',
  '/delivery',
  '/compare',
  '/developers',
  '/config.js',
  '/sw.js',
  '/sdk/embed/nif-viewer.js',
  '/manifest.json',
];

// ── Install — cache app shell ─────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(c => c.addAll(APP_SHELL.map(u => new Request(u, { cache:'reload' }))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()) // don't block install on cache failure
  );
});

// ── Activate — clean old caches ───────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !k.startsWith('nif-v3'))
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Skip non-GET (uploads, API mutations)
  if (req.method !== 'GET') return;

  // Skip signed R2 URLs and streaming
  if (url.hostname.includes('r2.cloudflarestorage') ||
      url.pathname.includes('/stream') ||
      url.searchParams.has('X-Amz-Signature')) return;

  // Google Fonts — permanent cache
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req, FONT_CACHE));
    return;
  }

  // API reads — network first, cache fallback with TTL
  if (url.hostname.includes('api.fumoca.co.za') || url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstAPI(req));
    return;
  }

  // App shell and static assets — cache first, revalidate in background
  event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
});

// ── Background sync for queued uploads ───────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'nif-upload-queue') {
    event.waitUntil(flushUploadQueue());
  }
});

// ── Strategies ────────────────────────────────────────────────────────────────

async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const fresh = await fetch(req);
  if (fresh.ok) {
    const c = await caches.open(cacheName);
    c.put(req, fresh.clone());
  }
  return fresh;
}

async function networkFirstAPI(req) {
  const cache = await caches.open(API_CACHE);
  try {
    const res = await fetch(req.clone());
    if (res.ok) {
      // Tag with expiry time in a synthetic header wrapper
      const body    = await res.clone().text();
      const wrapped = new Response(body, {
        status:  res.status,
        headers: {
          ...Object.fromEntries(res.headers.entries()),
          'x-nif-cached-at': Date.now().toString(),
        },
      });
      cache.put(req, wrapped);
    }
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) {
      const cachedAt = parseInt(cached.headers.get('x-nif-cached-at') || '0');
      if (Date.now() - cachedAt < API_TTL_MS) return cached;
    }
    return new Response(JSON.stringify({ error:'offline', cached: !!cached }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(req);

  const fetchPromise = fetch(req.clone()).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);

  return cached ?? await fetchPromise ?? new Response('Offline', { status: 503 });
}

// ── Upload queue (IndexedDB) ──────────────────────────────────────────────────
async function flushUploadQueue() {
  const db = await openDB();
  const tx = db.transaction('uploads', 'readwrite');
  const store = tx.objectStore('uploads');
  const all   = await promisify(store.getAll());

  for (const item of all) {
    try {
      const res = await fetch(item.url, {
        method:  'POST',
        headers: item.headers,
        body:    item.body,
      });
      if (res.ok) {
        await promisify(store.delete(item.id));
      }
    } catch {}
  }
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('nif-sw', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('uploads', { keyPath:'id', autoIncrement:true });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

// ── Push notifications (future) ───────────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title ?? '✦ NIF Ready', {
      body:    data.body ?? 'Your NIF reconstruction is complete.',
      icon:    '/icon-192.png',
      badge:   '/icon-192.png',
      data:    { url: data.url ?? '/dashboard' },
      actions: [{ action:'view', title:'View NIF →' }],
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/dashboard';
  event.waitUntil(
    clients.matchAll({ type:'window' }).then(wins => {
      const existing = wins.find(w => w.url.includes('fumoca.co.za'));
      if (existing) { existing.focus(); existing.navigate(url); }
      else clients.openWindow(url);
    })
  );
});
