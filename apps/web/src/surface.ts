/** Surface du client web pour `X-Nokker-Surface` (module sans dépendance : testable seul). */
/** `pwa` : l'application installée (écran d'accueil, fenêtre autonome) ; `web` : l'onglet du navigateur (et la coque native). */
export function webSurface(): "web" | "pwa" {
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return "pwa";
    if ((navigator as { standalone?: boolean }).standalone === true) return "pwa"; // Safari iOS
  } catch {
    /* pas de matchMedia : onglet */
  }
  return "web";
}
