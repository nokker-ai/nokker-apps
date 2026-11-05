/**
 * Liens qui ouvrent Mon compte : `/account` (retour de Stripe Checkout, `?billing=success|cancel`, nokker/billing)
 * et `/pricing` (lien « Tarifs » d'un client connecté) ; `/account/connectors` (retour d'une connexion OAuth) ouvre
 * Connecteurs. La coque n'a pas de routeur : ces chemins ouvrent la vue,
 * puis l'adresse revient à « / » (le hash du fil est gardé, `billing` est retiré, les autres paramètres restent).
 */
import type { OAuthReturn } from "@nokker-apps/sdk";

export type BillingReturn = "success" | "cancel";

export const ACCOUNT_PATHS: ReadonlySet<string> = new Set(["/account", "/account/", "/pricing", "/pricing/"]);
/** Retour d'une connexion OAuth (CONNECTORS-OAUTH §3) : l'écran Connecteurs. */
export const CONNECTORS_PATHS: ReadonlySet<string> = new Set(["/account/connectors", "/account/connectors/"]);

const OAUTH_KINDS = new Set(["mail", "calendar", "contacts", "files", "tasks", "pages"]);

/** `?oauth=done&provider=…&account=oa_…&missing=a,b` ou `?oauth=error&code=…` ; `null` sans `oauth`. */
export function readOAuthReturn(search: string): OAuthReturn | null {
  const q = new URLSearchParams(search);
  const status = q.get("oauth");
  if (status !== "done" && status !== "error") return null;
  const clean = (v: string | null, re: RegExp): string | null => (v && re.test(v) ? v : null);
  return {
    status,
    provider: clean(q.get("provider"), /^[a-z][a-z0-9_]{0,31}$/),
    code: status === "error" ? clean(q.get("code"), /^[a-z][a-z0-9_]{0,40}$/) : null,
    account: clean(q.get("account"), /^oa_[a-z0-9]{10}$/),
    missing: (q.get("missing") ?? "").split(",").filter((k) => OAUTH_KINDS.has(k)) as OAuthReturn["missing"],
  };
}

// Lu une fois au chargement (main.tsx), avant que l'adresse ne soit nettoyée ; l'écran Connecteurs le prend.
let pendingOAuth: OAuthReturn | null = null;
export function captureOAuthReturn(search: string): void {
  pendingOAuth = readOAuthReturn(search);
}
export function takeOAuthReturn(): OAuthReturn | null {
  const r = pendingOAuth;
  pendingOAuth = null;
  return r;
}

export function readBillingReturn(search: string): BillingReturn | null {
  const b = new URLSearchParams(search).get("billing");
  return b === "success" || b === "cancel" ? b : null;
}

/** Code d'essai d'une campagne (`?code=`, lien d'invitation ou de campagne) : gardé pour la session de l'onglet, pour
 * survivre à l'inscription (invitation → compte → Mon compte). Stockage absent ou refusé : rien n'est gardé. */
const VOUCHER_KEY = "nokker.voucher";
const VOUCHER_RE = /^[A-Za-z0-9][A-Za-z0-9 -]{2,39}$/;

export function captureVoucher(search: string): void {
  const q = new URLSearchParams(search);
  // `?oauth=error&code=denied` : le code d'erreur d'un retour OAuth n'est pas un code d'essai.
  if (q.has("oauth")) return;
  const c = q.get("code");
  if (!c || !VOUCHER_RE.test(c.trim())) return;
  try {
    sessionStorage.setItem(VOUCHER_KEY, c.trim().toUpperCase());
  } catch {
    /* stockage indisponible : le code se saisit à la main */
  }
}

export function recallVoucher(): string {
  try {
    return sessionStorage.getItem(VOUCHER_KEY) ?? "";
  } catch {
    return "";
  }
}

export function forgetVoucher(): void {
  try {
    sessionStorage.removeItem(VOUCHER_KEY);
  } catch {
    /* rien à oublier */
  }
}

export function cleanAccountUrl(search: string, hash: string): string {
  const q = new URLSearchParams(search);
  q.delete("billing");
  q.delete("code");
  for (const k of ["oauth", "provider", "account", "missing"]) q.delete(k);
  const rest = q.toString();
  return `/${rest ? `?${rest}` : ""}${hash}`;
}
