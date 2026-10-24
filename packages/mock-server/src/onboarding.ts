/**
 * Étape 5 du noyau en démo (invitation → compte → conditions, connecteurs, appairage Telegram) — mêmes routes et mêmes
 * codes d'erreur que `nokker/onboarding/http.py`, `nokker/connectors/http.py` et `nokker/telegram/http.py`, pour que le
 * parcours web tourne sans noyau. Jetons de démo : `demo` (fr, Camille), `demo-en` (en, Sam) ; tout autre jeton est
 * invalide. Un jeton accepté est consommé (usage unique). Connecteurs : tout passe sauf mot de passe `mauvais`
 * (auth_failed), hôte local (host_blocked), port hors liste (port_not_allowed), hôte `down.example` (unreachable).
 */
import { createHash } from "node:crypto";
import type { ConnectorCard, ConnectorKind } from "@nokker-apps/sdk";
import { MOCK_USER, randomId, type MockDeviceRecord, type MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;

const TERMS: Record<string, string> = {
  fr:
    "Conditions de la bêta Nokker\n\nBêta gratuite de 30 jours, sur invitation. L'utilisation de tes échanges pour " +
    "améliorer les modèles est facultative (case distincte) ; elle compte dans les conditions de l'avantage « Solo offert 6 mois ».\n\nTes identifiants de messagerie et d'agenda " +
    "sont chiffrés, ne sont jamais affichés et tu peux les révoquer à tout moment. Aucun envoi externe n'a lieu sans ton clic.\n\n" +
    "Version du 28 octobre 2026 (texte de démonstration).",
  en:
    "Nokker beta terms\n\nFree 30-day beta, by invitation. Using your exchanges to improve the models is " +
    "optional (separate box); it counts toward the conditions of the \"Solo free for 6 months\" benefit.\n\nYour mailbox and calendar credentials are encrypted, never displayed, " +
    "and you can revoke them at any time. Nothing is sent externally without your click.\n\nVersion of 28 October 2026 (demo text).",
};
const sha = (lang: string): string => createHash("sha256").update(TERMS[lang]!).digest("hex");

const DEMO_INVITATIONS: Record<string, { lang: string; prenom: string }> = {
  demo: { lang: "fr", prenom: "Camille" },
  "demo-en": { lang: "en", prenom: "Sam" },
};

/** Routes publiques (avant toute session). Rend true si la route est à lui. */
export async function handlePublicOnboarding(
  state: MockState,
  method: string,
  url: URL,
  readBody: () => Promise<Record<string, unknown>>,
  send: Send,
): Promise<boolean> {
  const path = url.pathname;
  if (path.startsWith("/v1/auth/")) return handleEmailLogin(state, method, path, readBody, send);
  if (!path.startsWith("/v1/onboarding/")) return false;
  if (method === "GET" && path === "/v1/onboarding/invitation") {
    const t = url.searchParams.get("t") ?? "";
    const inv = DEMO_INVITATIONS[t];
    send(200, inv && !state.usedInvitations.has(t) ? { valid: true, ...inv } : { valid: false });
    return true;
  }
  if (method === "GET" && path === "/v1/onboarding/terms") {
    const lang = url.searchParams.get("lang") === "en" ? "en" : "fr";
    send(200, { lang, sha256: sha(lang), text: TERMS[lang] });
    return true;
  }
  if (method === "POST" && path === "/v1/onboarding/accept") {
    const body = await readBody();
    const token = String(body.token ?? "");
    const termsSha = String(body.terms_sha256 ?? "");
    const lang = (["fr", "en"] as const).find((l) => sha(l) === termsSha);
    if (!lang) return send(409, { error: "terms_mismatch" }), true;
    if (!body.public_key_spki || String(body.public_key_spki).length < 40) return send(400, { error: "invalid_key" }), true;
    const inv = DEMO_INVITATIONS[token];
    if (!inv || state.usedInvitations.has(token)) return send(410, { error: "invalid_token" }), true;
    state.usedInvitations.add(token);
    const id = randomId("dev");
    const now = new Date().toISOString();
    const device: MockDeviceRecord = {
      id,
      code: id.slice(4, 10),
      name: String(body.name ?? "appareil"),
      publicKeySpkiB64Url: String(body.public_key_spki),
      status: "approved",
      created_at: now,
      approved_at: now,
      approved_via: "invitation",
      user: MOCK_USER,
    };
    state.devices.set(id, device);
    send(201, { account_id: randomId("us"), device_id: id, lang });
    return true;
  }
  return false;
}

/** Connexion par code mail (démo) : code fixe `123456`, réponse de `start` identique pour toute adresse,
 * `limite@example.com` → 429, 5 faux codes brûlent le code, tout échec = 401 `invalid_code`. */
export const MOCK_EMAIL_CODE = "123456";
const emailFails = new Map<string, number>();

async function handleEmailLogin(
  state: MockState,
  method: string,
  path: string,
  readBody: () => Promise<Record<string, unknown>>,
  send: Send,
): Promise<boolean> {
  if (method !== "POST") return false;
  if (path === "/v1/auth/email/start") {
    const body = await readBody();
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(400, { error: "invalid_email" }), true;
    if (email === "limite@example.com") return send(429, { error: "rate_limited" }), true;
    emailFails.delete(email);
    send(200, { sent: true });
    return true;
  }
  if (path === "/v1/auth/email/verify") {
    const body = await readBody();
    const email = String(body.email ?? "").trim().toLowerCase();
    const fails = emailFails.get(email) ?? 0;
    if (fails >= 5 || String(body.code ?? "") !== MOCK_EMAIL_CODE || email.endsWith("@inconnu.example")) {
      emailFails.set(email, fails + 1);
      return send(401, { error: "invalid_code" }), true;
    }
    if (!body.public_key_spki || String(body.public_key_spki).length < 40) return send(400, { error: "invalid_key" }), true;
    emailFails.delete(email);
    const id = randomId("dev");
    const now = new Date().toISOString();
    const device: MockDeviceRecord = {
      id,
      code: id.slice(4, 10),
      name: String(body.name ?? "appareil"),
      publicKeySpkiB64Url: String(body.public_key_spki),
      status: "approved",
      created_at: now,
      approved_at: now,
      approved_via: "email",
      user: MOCK_USER,
    };
    state.devices.set(id, device);
    send(200, { device_id: id, user: MOCK_USER });
    return true;
  }
  return false;
}

const KINDS: ConnectorKind[] = ["mail", "calendar"];
const MAIL_PRESETS = ["fastmail", "gmail", "icloud", "infomaniak"];
const PRESET_HOST: Record<string, string> = {
  gmail: "imap.gmail.com",
  icloud: "imap.mail.me.com",
  infomaniak: "mail.infomaniak.com",
  fastmail: "imap.fastmail.com",
};

function publicSettings(kind: ConnectorKind, s: Record<string, unknown>): Record<string, string | number> {
  const keys = kind === "mail" ? ["preset", "address", "username", "imap_host", "smtp_host"] : ["mode", "label", "username"];
  const out: Record<string, string | number> = {};
  for (const k of keys) if (typeof s[k] === "string" || typeof s[k] === "number") out[k] = s[k] as string | number;
  return out;
}

function cardOf(state: MockState, kind: ConnectorKind): ConnectorCard {
  const c = state.connectors.get(kind);
  if (!c) return { kind, state: "absent" };
  return {
    kind,
    state: c.lastOkAt ? "ok" : "unverified",
    settings: publicSettings(kind, c.settings),
    connected_at: c.connectedAt,
    last_ok_at: c.lastOkAt,
  };
}

/** `[code, message]` si le faux connecteur refuse, sinon null. */
function refuse(kind: ConnectorKind, settings: Record<string, unknown>, secret: string): [number, string, string] | null {
  const host = String(settings.imap_host ?? settings.smtp_host ?? (settings.url ? new URL(String(settings.url)).hostname : ""));
  if (/^(localhost|127\.|10\.|192\.168\.)/.test(host)) return [400, "host_blocked", "adresse interne refusée"];
  if (settings.imap_port !== undefined && ![993, 143].includes(Number(settings.imap_port))) return [400, "port_not_allowed", "port IMAP non autorisé"];
  if (settings.smtp_port !== undefined && ![465, 587].includes(Number(settings.smtp_port))) return [400, "port_not_allowed", "port SMTP non autorisé"];
  if (host === "down.example") return [502, "unreachable", "serveur injoignable"];
  if (secret === "mauvais") return [422, "auth_failed", "identifiants refusés"];
  void kind;
  return null;
}

/** Routes qui exigent une session. Rend true si la route est à lui. */
export async function handleAuthedOnboarding(
  state: MockState,
  method: string,
  path: string,
  readBody: () => Promise<Record<string, unknown>>,
  send: Send,
): Promise<boolean> {
  if (method === "POST" && path === "/v1/telegram/pairing") {
    const code = Math.random().toString(36).slice(2, 10).toUpperCase();
    send(200, { code, link: `https://t.me/nokker_demo_bot?start=${code}`, expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
    return true;
  }
  if (path !== "/v1/connectors" && !path.startsWith("/v1/connectors/")) return false;
  const parts = path.slice("/v1/connectors".length).split("/").filter(Boolean);
  const kind = parts[0] as ConnectorKind | undefined;
  if (method === "GET" && parts.length === 0) {
    send(200, { connectors: KINDS.map((k) => cardOf(state, k)), presets: { mail: MAIL_PRESETS, calendar: ["ical", "caldav"] } });
    return true;
  }
  if (!kind || !KINDS.includes(kind)) return false;
  if (method === "PUT" && parts.length === 1) {
    const body = await readBody();
    const settings = body.settings;
    if (!settings || typeof settings !== "object") return send(400, { error: "bad_settings", message: "settings requis" }), true;
    const s = settings as Record<string, unknown>;
    const secret = String(body.secret ?? "").trim();
    if (!secret) return send(400, { error: "bad_settings", message: "secret requis" }), true;
    if (kind === "mail") {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s.address ?? ""))) return send(400, { error: "bad_settings", message: "adresse invalide" }), true;
      if (s.preset !== "custom" && !MAIL_PRESETS.includes(String(s.preset))) return send(400, { error: "bad_settings", message: "preset inconnu" }), true;
      if (s.preset !== "custom") {
        s.imap_host = PRESET_HOST[String(s.preset)];
        s.username = s.username ?? s.address;
      }
    }
    const no = refuse(kind, s, secret);
    if (no) return send(no[0], { error: no[1], message: no[2] }), true;
    const now = new Date().toISOString();
    state.connectors.set(kind, { settings: s, connectedAt: now, lastOkAt: now });
    send(200, { ...cardOf(state, kind), message: kind === "mail" ? "IMAP et SMTP ok" : "Agenda lu" });
    return true;
  }
  if (method === "POST" && parts[1] === "test") {
    const c = state.connectors.get(kind);
    if (!c) return send(404, { error: "not_configured", message: "connecteur non relié" }), true;
    c.lastOkAt = new Date().toISOString();
    send(200, { ok: true, message: "ok", code: null });
    return true;
  }
  if (method === "DELETE" && parts.length === 1) {
    send(200, { revoked: state.connectors.delete(kind) });
    return true;
  }
  return false;
}

/** Utilisé par les tests : empreinte des conditions de démo. */
export const demoTermsSha = sha;
