/** Approbations fortes d'une machine liée, signées depuis app.nokker.ai (LOKKAL §7.3) — fonctions pures. */
import type { RemoteApprovalStatus } from "@nokker-apps/sdk";
import { shellLang, tr } from "../i18n/index.js";

export type RemoteTarget = { kind: "id"; machineId: string; approvalId: string } | { kind: "host"; host: string; approvalId: string };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `/approve/<machine_id>/<approval_id>` (lien de la notification) ou `/approve?host=<nom>.nokker.app&approval=<id>`
 * (lien de la bulle sur la passerelle, qui ne connaît pas son `machine_id`). */
export function remoteTargetFrom(pathname: string, search: string): RemoteTarget | null {
  const m = /^\/approve\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (m) {
    const [machineId, approvalId] = [decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)];
    return ID.test(machineId) && ID.test(approvalId) ? { kind: "id", machineId, approvalId } : null;
  }
  if (pathname !== "/approve" && pathname !== "/approve/") return null;
  const q = new URLSearchParams(search);
  const host = (q.get("host") ?? "").toLowerCase();
  const approvalId = q.get("approval") ?? "";
  return /^[a-z0-9.:-]{3,80}$/.test(host) && ID.test(approvalId) ? { kind: "host", host, approvalId } : null;
}

/** Statut final : plus rien à relever. */
export const isFinal = (s: RemoteApprovalStatus): boolean => s === "approved" || s === "rejected" || s === "expired";

/** Minutes restantes avant expiration (0 si passée). */
export function minutesLeftUntil(expiresAt: string, nowMs: number): number {
  const ms = Date.parse(expiresAt) - nowMs;
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 60_000) : 0;
}

/** Bandeau d'une classe qui engage (X20c) : « part chez quelqu'un d'autre », « supprime » ; rien sinon. */
export function classBanner(cls: string | null | undefined): string | null {
  if (cls === "external_send") return tr("Goes to someone else");
  if (cls === "destructive") return tr("Deletes");
  return null;
}

/** Suffixe d'un extrait coupé : « … (1,240 characters in total) ». */
export function truncatedSuffix(length: number | undefined): string {
  return length ? tr("… ({0} characters in total)", length.toLocaleString(shellLang() === "fr" ? "fr-CH" : "en-GB")) : "…";
}

/** Outil d'un connecteur du compte (mail, agenda) : une carte « machine » sur lui ne sera pas exécutée par nokker.ai. */
export const isAccountConnectorTool = (tool: string | undefined): boolean => !!tool && /^(mail|gmail|email|calendar|agenda|caldav|event)[_.]/i.test(tool);

/** Les 12 premiers caractères d'une empreinte (le reste en survol / copie). */
export const shortSha = (sha: string | undefined): string => (sha ? sha.slice(0, 12) : "");

/** Navigateurs intégrés aux applis (le lien d'une notification s'ouvre souvent dedans) : signature d'agent connue. */
const IN_APP: Array<[RegExp, string]> = [
  [/Instagram/i, "Instagram"],
  [/FBAN|FBAV|FB_IAB|FBIOS/i, "Facebook"],
  [/LinkedInApp/i, "LinkedIn"],
  [/MicroMessenger/i, "WeChat"],
  [/\bLine\//i, "LINE"],
  [/Snapchat/i, "Snapchat"],
  [/musical_ly|BytedanceWebview|TikTok/i, "TikTok"],
  [/Twitter/i, "X"],
  [/Telegram/i, "Telegram"],
];

export const isIOS = (ua: string): boolean => /iPhone|iPad|iPod/i.test(ua);

export interface BrowserEnv {
  ua: string;
  /** `window.PublicKeyCredential` présent. */
  webauthn: boolean;
  /** `window.TelegramWebviewProxy` (ou `TelegramWebview`) : navigateur intégré de Telegram, iOS comme Android. */
  telegram: boolean;
}

export function browserEnv(): BrowserEnv {
  const w = window as unknown as Record<string, unknown>;
  return { ua: navigator.userAgent, webauthn: typeof w.PublicKeyCredential !== "undefined", telegram: "TelegramWebviewProxy" in w || "TelegramWebview" in w };
}

/** Pourquoi CE navigateur ne peut pas signer avec une passkey : navigateur intégré (nom de l'appli si connu), ou
 * WebAuthn absent ; `null` s'il le peut. Une vue web iOS sans le jeton `Safari/` est un navigateur intégré. */
export function signBlocker(env: BrowserEnv): { kind: "in_app"; app: string | null } | { kind: "no_webauthn" } | null {
  if (env.telegram) return { kind: "in_app", app: "Telegram" };
  const hit = IN_APP.find(([re]) => re.test(env.ua));
  if (hit) return { kind: "in_app", app: hit[1] };
  if (isIOS(env.ua) && /AppleWebKit/i.test(env.ua) && !/Safari\//i.test(env.ua)) return { kind: "in_app", app: null };
  if (/Android/i.test(env.ua) && /; wv\)/.test(env.ua)) return { kind: "in_app", app: null };
  return env.webauthn ? null : { kind: "no_webauthn" };
}

export type RaLang = "fr" | "en";

const RA_FR = {
  openTitle: "Ouvre ce lien dans Safari ou Chrome",
  inAppNamed: "{app} ouvre les liens dans son propre navigateur, qui ne sait pas utiliser ta passkey.",
  inAppAnon: "Ce navigateur intégré à une appli ne sait pas utiliser ta passkey.",
  noWebauthn: "Ce navigateur ne gère pas les passkeys. Ouvre ce lien dans Safari, Chrome ou Edge à jour.",
  iosHint: "Sur iPhone : touche ⋯ ou l'icône de partage, puis « Ouvrir dans Safari ».",
  androidHint: "Sur Android : menu ⋮, puis « Ouvrir dans Chrome ».",
  copy: "Copier le lien",
  copied: "Lien copié : colle-le dans Safari ou Chrome.",
  copyFailed: "Copie impossible : touche longuement le lien pour le copier.",
  loginOnly: "Ce navigateur n'a pas de passkey : il ne signe pas une carte forte. Signe-la dans la Mini App Telegram (Face ID ou empreinte).",
  noDevice: "Aucune passkey sur ce navigateur. Signe cette carte dans la Mini App Telegram (Face ID ou empreinte).",
  miniTitle: "Signe dans Telegram",
  miniBody: "Une carte forte se signe dans la Mini App Telegram de Nokker, avec Face ID ou ton empreinte.",
  miniOpen: "Ouvrir dans Telegram",
  miniNoLink: "Ouvre le message du bot Nokker dans Telegram et touche « Approuver » : la Mini App te demande Face ID.",
};
type RaKey = keyof typeof RA_FR;
const RA_EN: Record<RaKey, string> = {
  openTitle: "Open this link in Safari or Chrome",
  inAppNamed: "{app} opens links in its own browser, which cannot use your passkey.",
  inAppAnon: "This in-app browser cannot use your passkey.",
  noWebauthn: "This browser does not support passkeys. Open this link in an up-to-date Safari, Chrome or Edge.",
  iosHint: "On iPhone: tap ⋯ or the share icon, then “Open in Safari”.",
  androidHint: "On Android: tap the ⋮ menu, then “Open in Chrome”.",
  copy: "Copy the link",
  copied: "Link copied: paste it into Safari or Chrome.",
  copyFailed: "Cannot copy: press and hold the link to copy it.",
  loginOnly: "This browser has no passkey: it does not sign a strong card. Sign it in the Telegram Mini App (Face ID or fingerprint).",
  noDevice: "No passkey in this browser. Sign this card in the Telegram Mini App (Face ID or fingerprint).",
  miniTitle: "Sign in Telegram",
  miniBody: "A strong card is signed in the Nokker Telegram Mini App, with Face ID or your fingerprint.",
  miniOpen: "Open in Telegram",
  miniNoLink: "Open the Nokker bot's message in Telegram and tap “Approve”: the Mini App asks for Face ID.",
};

export function raText(lang: RaLang, key: RaKey, vars: Record<string, string> = {}): string {
  return (lang === "en" ? RA_EN : RA_FR)[key].replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

/** Lien vers la Mini App Telegram qui signe une carte forte de machine (attestation nokker.ai). Format du noyau à venir
 * (p2/rc8-tg-attest : deep link `startapp`, ou URL de la Mini App avec `machine` et `approval`) — SEULE ligne à changer.
 * `null` tant qu'il n'est pas fixé : la page renvoie alors au message du bot. */
export function miniAppApproveUrl(t: { machineId?: string; host?: string; approvalId: string }): string | null {
  void t;
  return null;
}
