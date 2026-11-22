/**
 * Coque native (nokker docs/LOKKAL-PHONE.md §1.1, §2) : la même webapp, empaquetée par Capacitor, avec ses fichiers
 * DANS le paquet (pas de `server.url`). Ce module est le seul endroit qui sait si l'on tourne dans l'app, et il ne
 * dépend pas de Capacitor (le pont `window.Capacitor` existe dès que la coque charge la page) : le web n'embarque rien.
 *
 *  - W1 : l'origine de la page est `capacitor://localhost` (iOS) ou `https://localhost` (Android) → l'API est une base
 *    ABSOLUE (`https://app.nokker.ai` par défaut, `VITE_NOKKER_SERVER_URL` sinon).
 *  - W4 : pas de service worker dans l'app (les fichiers sont dans le paquet ; la mise à jour passe par le magasin).
 *  - W11 : build pour un magasin (`VITE_NOKKER_STORE_BUILD=ios|android`, ou plateforme native détectée) → aucun achat ni
 *    lien d'achat ; l'état de l'abonnement reste visible.
 *  - W12 : la détection « navigateur intégré » de /approve ne s'applique pas : la décision se fait dans l'app.
 */

export const NATIVE_DEFAULT_SERVER = "https://app.nokker.ai";

type Bridge = { isNativePlatform?: () => boolean; getPlatform?: () => string };
const bridge = (w: unknown = globalThis): Bridge | undefined => (w as { Capacitor?: Bridge } | undefined)?.Capacitor;

/** Vrai dans la coque Capacitor (iOS ou Android), faux dans un navigateur. */
export function isNativeShell(w: unknown = globalThis): boolean {
  try {
    return bridge(w)?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

export type NativePlatform = "ios" | "android" | "web";
export function nativePlatform(w: unknown = globalThis): NativePlatform {
  if (!isNativeShell(w)) return "web";
  const p = bridge(w)?.getPlatform?.();
  return p === "ios" || p === "android" ? p : "web";
}

/**
 * Fausse coque des recettes e2e (`window.__NOKKER_FAKE_SHELL__`, posé par Playwright avec des fonctions natives
 * simulées) : elle garde la base du MOCK. Acceptée SEULEMENT par le serveur de développement de Vite et jamais dans une
 * build de magasin ; une build de production l'ignore (DEV faux), donc la vraie coque parle toujours à app.nokker.ai.
 */
export function fakeShellAllowed(env: { DEV?: boolean; VITE_NOKKER_STORE_BUILD?: string } = import.meta.env ?? {}, w: unknown = globalThis): boolean {
  return env.DEV === true && !env.VITE_NOKKER_STORE_BUILD && (w as { __NOKKER_FAKE_SHELL__?: unknown }).__NOKKER_FAKE_SHELL__ === true;
}

/** Base de l'API : celle de la build, sinon la même origine (web), sinon app.nokker.ai (coque native, sauf fausse coque
 * de recette en développement). */
export function resolveServerUrl(built: string | undefined, origin: string, native: boolean, fake = false): string {
  if (built) return built.replace(/\/+$/, "");
  return native && !fake ? NATIVE_DEFAULT_SERVER : origin;
}

export type StoreBuild = "ios" | "android" | null;
/** Build destinée à un magasin d'applications : la variable de build prime, puis la plateforme native. */
export function storeBuild(built: string | undefined = import.meta.env?.VITE_NOKKER_STORE_BUILD, w: unknown = globalThis): StoreBuild {
  if (built === "ios" || built === "android") return built;
  const p = nativePlatform(w);
  return p === "web" ? null : p;
}

/** Achat, lien vers le paiement, portail de facturation et code d'essai : jamais dans une build de magasin (§6.3). */
export const purchasesAllowed = (s: StoreBuild = storeBuild()): boolean => s === null;

type Listener = { remove?: () => void | Promise<void> };
type AppPlugin = { addListener?: (ev: string, cb: (e: { canGoBack?: boolean }) => void) => Listener | Promise<Listener>; exitApp?: () => void };
const appPlugin = (w: unknown = globalThis): AppPlugin | undefined =>
  isNativeShell(w) ? (w as { Capacitor?: { Plugins?: { App?: AppPlugin } } }).Capacitor?.Plugins?.App : undefined;

/** Bouton retour d'Android dans l'app (`@capacitor/app`, événement `backButton`) ; rend de quoi se désabonner. Sans coque
 * ou sans plugin : rien (le navigateur gère son propre retour). */
export function onNativeBack(cb: (canGoBack: boolean) => void, w: unknown = globalThis): () => void {
  const app = appPlugin(w);
  if (!app?.addListener) return () => undefined;
  let handle: Listener | undefined;
  let gone = false;
  void Promise.resolve(app.addListener("backButton", (e) => cb(e?.canGoBack === true))).then((h) => {
    if (gone) void h?.remove?.();
    else handle = h;
  });
  return () => {
    gone = true;
    void handle?.remove?.();
  };
}

/** Quitter l'app (Android, au bout de l'historique). */
export function exitNativeApp(w: unknown = globalThis): void {
  appPlugin(w)?.exitApp?.();
}

type BrowserPlugin = { open?: (o: { url: string }) => Promise<void> | void };
/** Ouvre une page web hors de l'app : navigateur système (`@capacitor/browser` : SFSafariViewController, Custom Tabs). */
export function openExternal(url: string, w: unknown = globalThis): void {
  const b = isNativeShell(w) ? (w as { Capacitor?: { Plugins?: { Browser?: BrowserPlugin } } }).Capacitor?.Plugins?.Browser : undefined;
  if (b?.open) void b.open({ url });
  else (w as Window).open?.(url, "_blank", "noopener");
}

/** Lien http(s) d'une page dans la coque : il part TOUJOURS vers le navigateur système (la page de l'app est servie par
 * le paquet, `capacitor://localhost` ; une page web dans la vue web de l'app perdrait le retour et la sécurité). */
export function externalHref(a: { href?: string; getAttribute(n: string): string | null } | null): string | null {
  const href = a?.getAttribute("href");
  if (!href || !/^https?:\/\//i.test(href)) return null;
  return href;
}

/** Dans la coque : tout clic sur un lien http(s) ouvre le navigateur système. Rien dans un navigateur. */
export function installExternalLinks(doc: Document = document, w: unknown = globalThis): void {
  if (!isNativeShell(w)) return;
  doc.addEventListener(
    "click",
    (e) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      const href = externalHref(a);
      if (!href) return;
      e.preventDefault();
      openExternal(href, w);
    },
    true,
  );
}

type HapticsPlugin = { vibrate?: (o: { duration: number }) => Promise<void> | void; impact?: (o: { style: "LIGHT" | "MEDIUM" | "HEAVY" }) => Promise<void> | void };
/** Motif de vibration [marche, arrêt, marche…] (ms) joué par `@capacitor/haptics` dans l'app (W10) : chaque « marche »
 * est une impulsion — durée sur Android, choc moyen sur iOS (le motif AHAP du kit viendra avec un plugin maison).
 * Faux hors de l'app ou sans plugin : l'appelant garde `navigator.vibrate`. */
export function nativeHaptics(pattern: number[], w: unknown = globalThis, later: (f: () => void, ms: number) => void = (f, ms) => void setTimeout(f, ms)): boolean {
  const h = isNativeShell(w) ? (w as { Capacitor?: { Plugins?: { Haptics?: HapticsPlugin } } }).Capacitor?.Plugins?.Haptics : undefined;
  if (!h) return false;
  const ios = nativePlatform(w) === "ios";
  let at = 0;
  pattern.forEach((ms, i) => {
    if (i % 2 === 0) {
      const pulse = () => void (ios ? h.impact?.({ style: "MEDIUM" }) : h.vibrate?.({ duration: ms }));
      if (at === 0) pulse();
      else later(pulse, at);
    }
    at += ms;
  });
  return true;
}
