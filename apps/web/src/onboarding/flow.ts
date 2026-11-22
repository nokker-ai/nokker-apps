import type { CalendarSettings, ConnectorKind, MailSettings, Persona, PersonaAvatarRef, PersonaCatalog, PutConnectorRequest, PutPersonaRequest } from "@nokker-apps/sdk";
import type { Key, Lang } from "./i18n.js";

export type Step = "invitation" | "invalid" | "unreachable" | "terms" | "connectors" | "persona" | "telegram" | "done";

/** Étape « Ton Nokker » (nom, voix, avatar) entre les connecteurs et Telegram. Drapeau web `onboarding_avatar`
 * (`VITE_NOKKER_ONBOARDING_AVATAR=1` à la build), ÉTEINT par défaut : éteint, le parcours est exactement celui d'avant
 * et aucune route `/v1/persona*` n'est appelée. */
let avatarFlag: boolean = import.meta.env?.VITE_NOKKER_ONBOARDING_AVATAR === "1";

export function onboardingAvatarEnabled(): boolean {
  return avatarFlag;
}

/** Tests only. */
export function setOnboardingAvatarForTests(on: boolean): void {
  avatarFlag = on;
}

/** Fil d'étapes affiché en haut du parcours. */
const STEPS: { step: Step; label: Key }[] = [
  { step: "terms", label: "stepTerms" },
  { step: "connectors", label: "stepConnectors" },
  { step: "telegram", label: "stepTelegram" },
  { step: "done", label: "stepDone" },
];

/** Avec le drapeau `onboarding_avatar` : l'étape « Ton Nokker » entre les connecteurs et Telegram. */
export function stepsFor(avatarStep: boolean): { step: Step; label: Key }[] {
  if (!avatarStep) return STEPS;
  const i = STEPS.findIndex((x) => x.step === "telegram");
  return [...STEPS.slice(0, i), { step: "persona", label: "stepPersona" }, ...STEPS.slice(i)];
}

/** Formulaire de l'étape persona. `loading` : catalogue en lecture ; `saving` : PUT en cours. */
export interface PersonaForm {
  status: "loading" | "ready" | "saving";
  catalog?: PersonaCatalog;
  name: string;
  voiceId: string;
  avatar: PersonaAvatarRef | null;
  /** Clé de traduction de l'erreur affichée (refus 400, 429, réseau…). */
  error?: Key;
  /** Champ refusé par le noyau (400), pour le signaler à côté du champ. */
  field?: "name" | "voice" | "avatar";
}

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
  /** Le drapeau `onboarding_avatar`, lu une fois au début du parcours. */
  avatarStep: boolean;
  /** Présent seulement quand le parcours est passé par l'étape persona. */
  persona?: PersonaForm;
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
  | { type: "telegram_generated" }
  | { type: "persona_loaded"; catalog: PersonaCatalog; current?: Persona | null }
  | { type: "persona_unavailable" }
  | { type: "persona_name"; value: string }
  | { type: "persona_voice"; id: string }
  | { type: "persona_avatar"; avatar: PersonaAvatarRef }
  | { type: "persona_skip" }
  | { type: "persona_submit" }
  | { type: "persona_saved" }
  | { type: "persona_failed"; code: string; error: Key };

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
    avatarStep: onboardingAvatarEnabled(),
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
      if (s.step === "connectors") return s.avatarStep ? { ...s, step: "persona", persona: emptyPersona() } : { ...s, step: "telegram" };
      if (s.step === "telegram") return { ...s, step: "done" };
      return s;
    default:
      return s.step === "persona" && s.persona ? reducePersona(s, s.persona, a) : s;
  }
}

function emptyPersona(): PersonaForm {
  return { status: "loading", name: "", voiceId: "", avatar: null };
}

/** Étape persona : « Passer » garde les valeurs par défaut (aucun PUT) ; « Continuer » envoie le PUT. Un catalogue
 * illisible (noyau sans la route, réseau) ne bloque jamais le parcours : l'étape est sautée. */
function reducePersona(s: FlowState, p: PersonaForm, a: Action): FlowState {
  const set = (q: Partial<PersonaForm>): FlowState => ({ ...s, persona: { ...p, ...q } });
  const editable = p.status === "ready";
  switch (a.type) {
    case "persona_loaded": {
      if (p.status !== "loading") return s;
      const c = a.catalog;
      // Un choix déjà fait (persona non `defaulted`) est repris tel quel, s'il est encore au catalogue.
      const cur = a.current && !a.current.defaulted ? a.current : null;
      const voiceId = cur && c.voices.some((v) => v.id === cur.voice_id) ? cur.voice_id : c.defaults.voice_id;
      const avatar = cur && findAvatar(c, cur.avatar) ? cur.avatar : c.defaults.avatar;
      return set({ status: "ready", catalog: c, name: cur?.name ?? c.defaults.name, voiceId, avatar: { id: avatar.id, version: avatar.version } });
    }
    case "persona_unavailable":
      return p.status === "loading" ? { ...s, step: "telegram", persona: undefined } : s;
    case "persona_name":
      return editable ? set({ name: a.value, error: undefined, field: undefined }) : s;
    case "persona_voice":
      return editable && p.catalog?.voices.some((v) => v.id === a.id) ? set({ voiceId: a.id, error: undefined, field: undefined }) : s;
    case "persona_avatar":
      return editable && p.catalog && findAvatar(p.catalog, a.avatar) ? set({ avatar: { id: a.avatar.id, version: a.avatar.version }, error: undefined, field: undefined }) : s;
    case "persona_skip":
      return p.status === "saving" ? s : { ...s, step: "telegram" };
    case "persona_submit": {
      if (!editable) return s;
      if (!personaRequest(p)) return set({ error: "personaErrName", field: "name" });
      return set({ status: "saving", error: undefined, field: undefined });
    }
    case "persona_saved":
      return p.status === "saving" ? { ...s, step: "telegram", persona: { ...p, status: "ready" } } : s;
    case "persona_failed": {
      if (p.status !== "saving") return s;
      const field = a.code === "bad_name" ? "name" : a.code === "bad_voice" ? "voice" : a.code === "bad_avatar" ? "avatar" : undefined;
      return set({ status: "ready", error: a.error, field });
    }
    default:
      return s;
  }
}

function findAvatar(c: PersonaCatalog, ref: PersonaAvatarRef) {
  return c.avatars.find((x) => x.id === ref.id && x.version === ref.version);
}

/** Lettres (accents compris), espaces, trait d'union, apostrophe ; au moins une lettre. */
const NAME_RE = /^[\p{L}\p{M} '’-]+$/u;

/** Nom valide pour le catalogue : 1 à 24 caractères (bornes du catalogue) une fois les blancs du bord retirés. */
export function validPersonaName(name: string, bounds: { min: number; max: number } = { min: 1, max: 24 }): boolean {
  const n = name.trim();
  const len = [...n].length;
  return len >= bounds.min && len <= bounds.max && NAME_RE.test(n) && /\p{L}/u.test(n);
}

/** Corps du `PUT /v1/persona`, ou `null` si le nom est invalide ou s'il manque un choix. */
export function personaRequest(p: PersonaForm): PutPersonaRequest | null {
  if (!p.catalog || !p.avatar || !p.voiceId) return null;
  if (!validPersonaName(p.name, p.catalog.name)) return null;
  return { name: p.name.trim(), voice_id: p.voiceId, avatar: { id: p.avatar.id, version: p.avatar.version } };
}

/** Clé d'erreur d'un échec du `PUT /v1/persona`, d'après son code (`errorCode`). */
export function personaErrorKey(code: string): Key {
  switch (code) {
    case "bad_name":
      return "personaErrName";
    case "bad_voice":
      return "personaErrVoice";
    case "bad_avatar":
      return "personaErrAvatar";
    case "rate":
    case "rate_limited":
      return "errRate";
    case "network":
      return "errNetwork";
    default:
      return "errGeneric";
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
