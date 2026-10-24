let updateReady = false;
const listeners = new Set<() => void>();

export function subscribeUpdate(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const isUpdateReady = (): boolean => updateReady;

/** Enregistre sw.js (production seulement). Une nouvelle version qui prend la main sur une page déjà contrôlée
 * lève `updateReady` : la bannière propose de recharger, sans recharger d'office (une approbation peut être ouverte). */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || import.meta.env.VITE_PWA_KILL === "1" || !("serviceWorker" in navigator)) return;
  const hadController = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return;
    updateReady = true;
    listeners.forEach((l) => l());
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((reg) => {
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") void reg.update();
        });
      })
      .catch(() => undefined);
  });
}
