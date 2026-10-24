/* Kill-switch PWA : remplace sw.js quand la PWA pose problème (build avec --build-arg PWA_KILL=1, cf README).
   Les navigateurs qui ont l'ancien service worker le vérifient à chaque navigation : celui-ci vide tous les caches,
   se désenregistre et recharge les onglets ouverts, qui repartent sur le réseau. Aucun fetch n'est intercepté. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) await caches.delete(k);
      await self.registration.unregister();
      for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url).catch(() => undefined);
    })(),
  );
});
