/* Service worker Nokker : coquille de l'app + /assets/* (hachés, immuables). Jamais /v1/* : données propres à
   chaque testeur, l'isolation interdit tout cache. __BUILD_ID__ est remplacé au build (vite.config.ts) : sw.js change
   à chaque déploiement qui change les assets, donc le navigateur installe la nouvelle version. */
const BUILD = "__BUILD_ID__";
const SHELL = `nokker-shell-${BUILD}`;
const ASSETS = "nokker-assets";
const MAX_ASSETS = 80;
const NEVER = [/^\/v1\//, /^\/healthz/, /^\/\.well-known\//, /^\/sw\.js$/];
const PRECACHE = ["/", "/manifest.webmanifest", "/brand/icon/nokker-app-192.png", "/brand/icon/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("nokker-shell-") && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(k);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER.some((re) => re.test(url.pathname))) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && res.type === "basic" && (res.headers.get("content-type") || "").includes("text/html")) {
            const copy = res.clone();
            event.waitUntil(caches.open(SHELL).then((c) => c.put("/", copy)));
          }
          return res;
        })
        .catch(() => caches.match("/", { cacheName: SHELL }).then((r) => r || Response.error())),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(ASSETS).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok && res.type === "basic") {
          await cache.put(req, res.clone());
          event.waitUntil(trim(cache));
        }
        return res;
      }),
    );
    return;
  }

  if (url.pathname.startsWith("/brand/") || url.pathname === "/manifest.webmanifest") {
    event.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const hit = await cache.match(req);
        const net = fetch(req)
          .then((res) => {
            if (res.ok && res.type === "basic") cache.put(req, res.clone());
            return res;
          })
          .catch(() => hit || Response.error());
        return hit || net;
      }),
    );
  }
});
