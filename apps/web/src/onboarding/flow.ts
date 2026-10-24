import type { CalendarSettings, ConnectorKind, MailSettings, PutConnectorRequest } from "@nokker-apps/sdk";
import type { Lang } from "./i18n.js";

export type Step = "invitation" | "invalid" | "unreachable" | "terms" | "connectors" | "telegram" | "done";

export interface FlowState {
  step: Step;
  token: string;
  lang: Lang;
  prenom?: string;
  /** Empreinte des conditions affichées (celle que l'acceptation doit citer). */
  termsSha?: string;
  accepted: boolean;
  /** Consentement facultatif à l'entraînement : case distincte, jamais pré-cochée, liée à la version affichée. */
  training: boolean;
  submitting: boolean;
  error?: string;
  connectorsLinked: Record<ConnectorKind, boolean>;
  telegramGenerated: boolean;
}

export type Action =
  | { type: "invitation_ok"; lang: Lang; prenom?: string }
  | { type: "invitation_invalid" }
  | { type: "invitation_unreachable" }
  | { type: "retry" }
  | { type: "terms_loaded"; sha: string; lang: Lang }
  | { type: "set_lang"; lang: Lang }
  | { type: "toggle_accept"; value: boolean }
  | { type: "toggle_training"; value: boolean }
  | { type: "submit" }
  | { type: "accept_ok" }
  | { type: "accept_failed"; error: string; resetTerms?: boolean; invalid?: boolean }
  | { type: "connector_linked"; kind: ConnectorKind; linked: boolean }
  | { type: "next" }
  | { type: "telegram_generated" };

export function initialState(token: string): FlowState {
  return {
    step: "invitation",
    token,
    lang: "fr",
    accepted: false,
    training: false,
    submitting: false,
    connectorsLinked: { mail: false, calendar: false },
    telegramGenerated: false,
  };
}

/** La case est la condition d'entrée : sans elle, ni envoi, ni passage à l'étape suivante. */
export function canSubmit(s: FlowState): boolean {
  return s.step === "terms" && s.accepted && !!s.termsSha && !s.submitting;
}

export function reduce(s: FlowState, a: Action): FlowState {
  switch (a.type) {
    case "invitation_ok":
      return s.step === "invitation" ? { ...s, step: "terms", lang: a.lang, prenom: a.prenom } : s;
    case "invitation_invalid":
      return { ...s, step: "invalid" };
    case "invitation_unreachable":
      return { ...s, step: "unreachable" };
    case "retry":
      return s.step === "unreachable" ? { ...s, step: "invitation" } : s;
    case "terms_loaded":
      // Nouvelle version des conditions (autre langue, ou mise à jour) : l'acceptation précédente ne vaut plus.
      return s.termsSha === a.sha ? { ...s, lang: a.lang } : { ...s, termsSha: a.sha, lang: a.lang, accepted: false, training: false };
    case "set_lang":
      return s.lang === a.lang ? s : { ...s, lang: a.lang, termsSha: undefined, accepted: false, training: false };
    case "toggle_accept":
      return s.step === "terms" ? { ...s, accepted: a.value, error: undefined } : s;
    case "toggle_training":
      return s.step === "terms" ? { ...s, training: a.value } : s;
    case "submit":
      return canSubmit(s) ? { ...s, submitting: true, error: undefined } : s;
    case "accept_ok":
      return s.step === "terms" && s.submitting ? { ...s, step: "connectors", submitting: false, error: undefined } : s;
    case "accept_failed":
      if (a.invalid) return { ...s, step: "invalid", submitting: false, error: undefined };
      return {
        ...s,
        submitting: false,
        error: a.error,
        ...(a.resetTerms ? { termsSha: undefined, accepted: false, training: false } : {}),
      };
    case "connector_linked":
      return { ...s, connectorsLinked: { ...s.connectorsLinked, [a.kind]: a.linked } };
    case "telegram_generated":
      return { ...s, telegramGenerated: true };
    case "next":
      if (s.step === "connectors") return { ...s, step: "telegram" };
      if (s.step === "telegram") return { ...s, step: "done" };
      return s;
    default:
      return s;
  }
}

// -- Connecteurs ------------------------------------------------------------

export interface MailForm {
  preset: string;
  address: string;
  secret: string;
  imapHost?: string;
  imapPort?: string;
  smtpHost?: string;
  smtpPort?: string;
}

export type CalendarForm =
  | { mode: "ical"; label: string; secret: string }
  | { mode: "caldav"; url: string; username: string; secret: string };

/** Corps du `PUT /v1/connectors/{kind}`, ou `null` si un champ manque. Le secret n'existe que le temps de cet appel. */
export function buildMailRequest(f: MailForm): PutConnectorRequest | null {
  const address = f.address.trim();
  const secret = f.secret.trim();
  if (!address || !secret) return null;
  if (f.preset !== "custom") return { settings: { preset: f.preset, address } satisfies MailSettings, secret };
  const imapHost = (f.imapHost ?? "").trim();
  const smtpHost = (f.smtpHost ?? "").trim();
  const imapPort = Number(f.imapPort);
  const smtpPort = Number(f.smtpPort);
  if (!imapHost || !smtpHost || !Number.isInteger(imapPort) || !Number.isInteger(smtpPort)) return null;
  return {
    settings: { preset: "custom", address, imap_host: imapHost, imap_port: imapPort, smtp_host: smtpHost, smtp_port: smtpPort } satisfies MailSettings,
    secret,
  };
}

export function buildCalendarRequest(f: CalendarForm): PutConnectorRequest | null {
  const secret = f.secret.trim();
  if (!secret) return null;
  if (f.mode === "ical") {
    const label = f.label.trim();
    return label ? { settings: { mode: "ical", label } satisfies CalendarSettings, secret } : null;
  }
  const url = f.url.trim();
  const username = f.username.trim();
  return url && username ? { settings: { mode: "caldav", url, username } satisfies CalendarSettings, secret } : null;
}

/** Les fournisseurs qui exigent un mot de passe d'application : on affiche le conseil. */
export function needsAppPassword(preset: string): boolean {
  return preset === "gmail" || preset === "icloud";
}

// -- Telegram ---------------------------------------------------------------

export function secondsLeft(expiresAt: string, now: number): number {
  const end = Date.parse(expiresAt);
  return Number.isNaN(end) ? 0 : Math.max(0, Math.ceil((end - now) / 1000));
}

export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const PRESET_ORDER = ["gmail", "icloud", "infomaniak", "fastmail"];
const PRESET_LABEL: Record<string, string> = { gmail: "Gmail", icloud: "iCloud", infomaniak: "Infomaniak", fastmail: "Fastmail" };

/** Gmail et iCloud d'abord (les plus courants), puis le reste dans l'ordre alphabétique. */
export function orderPresets(presets: string[]): string[] {
  const rank = (p: string) => (PRESET_ORDER.indexOf(p) === -1 ? PRESET_ORDER.length : PRESET_ORDER.indexOf(p));
  return [...presets].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function presetLabel(preset: string): string {
  return PRESET_LABEL[preset] ?? preset;
}
