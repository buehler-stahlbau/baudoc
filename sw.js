/* =========================================================
   Service Worker – App funktioniert auch ohne Netz.
   Strategie: erst Netz (damit Updates sofort ankommen),
   bei fehlendem Netz der zwischengespeicherte Stand.
   Bei jeder neuen Version CACHE hochzählen.
========================================================= */
const CACHE = "baudoc-2.1.0-beta-4";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./logo.png",
  "./icon-192.png",
  "./icon-512.png",
  "./vendor/jspdf.umd.min.js",
  "./vendor/msal-browser.min.js",
  "./js/app.js",
  "./js/backup.js",
  "./js/config.js",
  "./js/db.js",
  "./js/images.js",
  "./js/onedrive.js",
  "./js/pdf.js",
  "./js/store.js",
  "./js/sync.js",
  "./js/util.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("baudoc-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Microsoft/OneDrive nie abfangen

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    try {
      const res = await Promise.race([fetch(req), timeout(cached ? 4000 : 30000)]);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch (e) {
      if (cached) return cached;
      if (req.mode === "navigate") {
        const index = await cache.match("./index.html");
        if (index) return index;
      }
      throw e;
    }
  })());
});
