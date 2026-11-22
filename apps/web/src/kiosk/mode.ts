/**
 * Mode kiosque d'un Lokkal (docs/KIOSK.md côté noyau) : le Chrome de l'écran HDMI ouvre `/kiosk#token=<clé locale>`.
 *
 * - La clé du kiosque est lue dans le FRAGMENT (jamais envoyée au serveur), effacée de la barre d'adresse et gardée
 *   dans le sessionStorage SOUS UNE AUTRE CLÉ que la clé de l'app (`nokker.kiosk-token`) : elle meurt avec le Chrome du
 *   kiosque et n'ouvre jamais, à elle seule, le mode perso.
 * - « Mode perso » ouvre l'app normale, qui demande sa propre clé (page « ouvrir avec la clé »).
 * - Garde d'inactivité : dans ce Chrome (marqué kiosque), 10 min sans geste en mode perso → la clé de l'app est
 *   effacée et l'écran revient au kiosque. Il faudra retaper la clé pour revenir au mode perso.
 * Boucle locale seulement (127.0.0.1 / localhost) : ailleurs, rien de tout cela ne s'allume.
 */
import { isLoopbackHost } from "../auth.js";
import { forgetLocalToken } from "../onboarding/localToken.js";

export const KIOSK_PATH = "/kiosk";
export const PERSONAL_IDLE_MS = 10 * 60_000;
const TOKEN_KEY = "nokker.kiosk-token";
const MARK_KEY = "nokker.kiosk";
const APP_TOKEN_KEY = "nokker.local-token";
const LAST_KEY = "nokker.kiosk.personal-at";
const ACTIVITY = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

function stamp(t: number): void {
  try {
    window.localStorage.setItem(LAST_KEY, String(t));
  } catch {
    /* sans stockage : la clé de l'app est redemandée à chaque passage */
  }
}

function lastPersonal(): number {
  try {
    return Number(window.localStorage.getItem(LAST_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** « Mode perso » : la clé de l'app n'est gardée que si le mode perso a servi il y a moins de 10 min (sinon elle est
 * oubliée et l'app la redemande, même après un redémarrage du Chrome du kiosque). */
export function enterPersonal(now: () => number = Date.now): void {
  if (now() - lastPersonal() >= PERSONAL_IDLE_MS) dropAppToken();
  stamp(now());
  window.location.assign("/");
}

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function kioskEnabled(): boolean {
  return import.meta.env.VITE_NOKKER_KIOSK === "1" && isLoopbackHost(window.location.hostname);
}

/** Garde le jeton de portée `kiosk` obtenu par l'échange d'un `#code=` : sous la clé du kiosque, jamais celle de l'app. */
export function keepKioskToken(token: string): void {
  const s = session();
  try {
    s?.setItem(TOKEN_KEY, token);
    s?.setItem(MARK_KEY, "1");
  } catch {
    /* stockage indisponible : le jeton ne survit pas au rechargement */
  }
}

/** À appeler AVANT tout rendu sur `/kiosk` : la clé du fragment devient celle du kiosque, jamais celle de l'app. */
export function takeKioskToken(): string | null {
  const s = session();
  let fromHash: string | null = null;
  try {
    const m = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
    if (m) fromHash = decodeURIComponent(m[1]!);
  } catch {
    /* fragment illisible : absent */
  }
  if (fromHash) {
    try {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch {
      /* sans conséquence pour le serveur */
    }
    try {
      s?.setItem(TOKEN_KEY, fromHash);
    } catch {
      /* stockage indisponible : la clé vaut pour ce chargement */
    }
  }
  try {
    s?.setItem(MARK_KEY, "1");
  } catch {
    /* idem */
  }
  if (fromHash) return fromHash;
  try {
    return s?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function isKioskBrowser(): boolean {
  try {
    return session()?.getItem(MARK_KEY) === "1";
  } catch {
    return false;
  }
}

function dropAppToken(): void {
  let cur = "";
  try {
    cur = window.localStorage.getItem(APP_TOKEN_KEY) ?? session()?.getItem(APP_TOKEN_KEY) ?? "";
  } catch {
    /* rien à effacer */
  }
  if (cur) forgetLocalToken(cur);
}

/** Retour au kiosque : la clé de l'app est oubliée (le mode perso la redemandera). */
export function backToKiosk(): void {
  dropAppToken();
  window.location.replace(KIOSK_PATH);
}

/**
 * Garde d'inactivité du mode perso, posée au démarrage de l'app dans un Chrome marqué kiosque. Renvoie la fonction
 * qui la retire (tests). `now` et `every` injectables pour les tests.
 */
export function installPersonalIdleGuard(opts: { now?: () => number; every?: number; onIdle?: () => void } = {}): () => void {
  if (!isKioskBrowser() || window.location.pathname === KIOSK_PATH) return () => undefined;
  const now = opts.now ?? Date.now;
  const onIdle = opts.onIdle ?? backToKiosk;
  let last = now();
  stamp(last);
  const touch = (): void => {
    last = now();
    stamp(last);
  };
  for (const e of ACTIVITY) window.addEventListener(e, touch, { passive: true, capture: true });
  const id = window.setInterval(() => {
    if (now() - last >= PERSONAL_IDLE_MS) {
      window.clearInterval(id);
      onIdle();
    }
  }, opts.every ?? 15_000);
  return () => {
    window.clearInterval(id);
    for (const e of ACTIVITY) window.removeEventListener(e, touch, { capture: true });
  };
}
