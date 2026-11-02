/** Jeton local de Lokkal (docs/LOKKAL.md §7.1). L'installeur et `nokker` ouvrent `/setup#token=<jeton>` : le jeton est
 * dans le FRAGMENT, donc jamais envoyé au serveur ni journalisé. On le lit, on l'efface de la barre d'adresse et on le
 * garde. Sur un Lokkal (origine en boucle locale), il est gardé en localStorage, comme le jeton de Jupyter : un nouvel
 * onglet sur la même machine n'a pas à le recoller, l'origine est locale et la clé ne sort jamais de la machine. Il est
 * effacé au premier 401 (`forgetLocalToken`). Ailleurs (`persistent: false`), il ne vit que le temps de l'onglet. */

const KEY = "nokker.local-token";

type Opts = { persistent?: boolean };

function safe<T>(f: () => T): T | null {
  try {
    return f() ?? null;
  } catch {
    return null;
  }
}

function storages(): Storage[] {
  return [safe(() => window.localStorage), safe(() => window.sessionStorage)].filter((s): s is Storage => !!s);
}

export function takeLocalToken({ persistent = true }: Opts = {}): string | null {
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
    keepLocalToken(fromHash, { persistent });
    return fromHash;
  }
  for (const s of storages()) {
    const v = safe(() => s.getItem(KEY));
    if (v) return v;
  }
  return null;
}

/** Garde une clé (fragment, ou collée sur la page « ouvrir avec la clé ») : localStorage sur un Lokkal, sinon l'onglet. */
export function keepLocalToken(token: string, { persistent = true }: Opts = {}): void {
  const session = safe(() => window.sessionStorage);
  const target = persistent ? (safe(() => window.localStorage) ?? session) : session;
  try {
    target?.setItem(KEY, token);
  } catch {
    /* stockage indisponible : la clé ne survit pas au rechargement */
  }
}

/** Clé refusée (401 : révoquée, ou d'une autre installation) : effacée partout, la page de clé reprend. Seulement si
 * c'est encore CETTE clé qui est gardée : une clé plus récente (collée dans un autre onglet pendant que l'ancienne
 * était en vol) n'est jamais effacée par le refus de l'ancienne. */
export function forgetLocalToken(refused: string): void {
  for (const s of storages()) {
    try {
      if (s.getItem(KEY) === refused) s.removeItem(KEY);
    } catch {
      /* stockage indisponible */
    }
  }
}
