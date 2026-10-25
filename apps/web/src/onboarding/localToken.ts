/** Jeton local de Lokkal (docs/LOKKAL.md §7.1). L'installeur et `nokker` ouvrent `/setup#token=<jeton>` : le jeton est
 * dans le FRAGMENT, donc jamais envoyé au serveur ni journalisé. On le lit, on l'efface de la barre d'adresse et on le
 * garde le temps de l'onglet (sessionStorage). */

const KEY = "nokker.local-token";

export function takeLocalToken(): string | null {
  let fromHash: string | null = null;
  try {
    const m = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
    if (m) fromHash = decodeURIComponent(m[1]!);
  } catch {
    /* fragment illisible : traité comme absent */
  }
  if (fromHash) {
    try {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch {
      /* la barre d'adresse garde le fragment : sans conséquence pour le serveur */
    }
    try {
      window.sessionStorage.setItem(KEY, fromHash);
    } catch {
      /* sessionStorage indisponible : le jeton ne survit pas au rechargement */
    }
    return fromHash;
  }
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}
