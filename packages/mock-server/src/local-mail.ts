/**
 * Boîte mail posée dans Lokkal (LOKKAL §7.25) — mock, jeton local seulement. Le mot de passe est le NOM d'un secret
 * du coffre local (une valeur, un nom absent du coffre, un champ `password` → 400 sans répéter ce qui a été envoyé).
 * Test simulé : une adresse qui contient « refus » → 422 `auth_failed` ; un hôte qui contient « injoignable » → 502
 * `unreachable` ; sinon la boîte répond. Erreurs au format des connecteurs : `{error: <code>, message}`.
 */
import type { LocalMailCard } from "@nokker-apps/sdk";
import { LOCAL_OWNER, type MockState } from "./state.js";
import { localSecretNames } from "./local-machine.js";

type Send = (status: number, payload: unknown) => void;
const PRESETS: Record<string, { imap_host: string; imap_port: number; smtp_host: string; smtp_port: number }> = {
  fastmail: { imap_host: "imap.fastmail.com", imap_port: 993, smtp_host: "smtp.fastmail.com", smtp_port: 465 },
  gmail: { imap_host: "imap.gmail.com", imap_port: 993, smtp_host: "smtp.gmail.com", smtp_port: 465 },
  icloud: { imap_host: "imap.mail.me.com", imap_port: 993, smtp_host: "smtp.mail.me.com", smtp_port: 587 },
  infomaniak: { imap_host: "mail.infomaniak.com", imap_port: 993, smtp_host: "mail.infomaniak.com", smtp_port: 465 },
};
const PORTS = { imap: [993, 143], smtp: [465, 587] };
const NOT_A_NAME = "secret : le NOM d'un secret du coffre local est attendu (le ranger d'abord : PUT /v1/local/secrets/NOM ou `nokker secret set NOM`), jamais le mot de passe lui-même";
const NOT_IN_VAULT = "secret : ce nom n'est pas dans le coffre local — ranger d'abord le mot de passe (PUT /v1/local/secrets/NOM ou `nokker secret set NOM`), puis donner ici son NOM";
const STATUS: Record<string, number> = { bad_settings: 400, port_not_allowed: 400, unsupported: 400, not_configured: 404, auth_failed: 422, unreachable: 502 };

interface Box {
  settings: Record<string, string | number>;
  secret: string;
  created_at: string;
  last_ok_at: string | null;
}
const all = new WeakMap<MockState, { box: Box | null }>();
const mb = (state: MockState) => {
  let m = all.get(state);
  if (!m) all.set(state, (m = { box: null }));
  return m;
};

class Refused extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const looksLikeValue = (n: string): boolean => /^(sk-|ghp_|xox|AKIA)/i.test(n) || (n.length >= 24 && !/[_.-]/.test(n) && /\d/.test(n) && /[A-Za-z]/.test(n));

function normalize(raw: unknown): Record<string, string | number> {
  if (!raw || typeof raw !== "object") throw new Refused("bad_settings", "réglages illisibles");
  const s = raw as Record<string, unknown>;
  const preset = String(s.preset || "custom");
  if (preset !== "custom" && !PRESETS[preset]) throw new Refused("bad_settings", `préréglage inconnu : ${preset}`);
  const out: Record<string, unknown> = { ...(PRESETS[preset] ?? {}), ...Object.fromEntries(Object.entries(s).filter(([, v]) => v !== null && v !== "")) };
  const address = String(out.address ?? "").trim();
  if (!/^[^@\s<>"',;]+@[^@\s<>"',;]+\.[A-Za-z]{2,}$/.test(address)) throw new Refused("bad_settings", "adresse e-mail invalide");
  const norm: Record<string, string | number> = { preset, address, username: String(out.username || address) };
  for (const k of ["imap_host", "smtp_host"]) {
    if (!out[k]) throw new Refused("bad_settings", `${k} requis`);
    norm[k] = String(out[k]).trim().toLowerCase();
  }
  for (const [k, proto] of [["imap_port", "imap"], ["smtp_port", "smtp"]] as const) {
    const n = Number(out[k] ?? 0);
    if (!Number.isInteger(n)) throw new Refused("bad_settings", `${k} invalide`);
    if (!PORTS[proto].includes(n)) throw new Refused("port_not_allowed", `port ${n} refusé pour ${proto}`);
    norm[k] = n;
  }
  return norm;
}

function test(s: Record<string, string | number>): { ok: boolean; message: string; code: string | null } {
  if (String(s.address).includes("refus")) return { ok: false, message: "identifiants refusés par le serveur IMAP", code: "auth_failed" };
  if (String(s.imap_host).includes("injoignable") || String(s.smtp_host).includes("injoignable")) return { ok: false, message: "serveur injoignable", code: "unreachable" };
  return { ok: true, message: "IMAP et SMTP répondent", code: null };
}

function card(b: Box | null): LocalMailCard {
  if (!b) return { kind: "mail", state: "absent", locality: "local" };
  const { preset, address, username, imap_host, smtp_host } = b.settings;
  return { kind: "mail", state: b.last_ok_at ? "ok" : "unverified", settings: { preset: preset!, address: address!, username: username!, imap_host: imap_host!, smtp_host: smtp_host! }, connected_at: b.created_at, last_ok_at: b.last_ok_at, locality: "local", secret: b.secret };
}

export async function handleLocalMail(state: MockState, user: string | null, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  const route = path.replace(/\/+$/, "");
  if (route !== "/v1/local/connectors" && !route.startsWith("/v1/local/connectors/")) return false;
  if (user !== LOCAL_OWNER) return send(401, { error: { message: "jeton local requis" } }), true;
  const m = mb(state);
  const parts = route.slice("/v1/local/connectors".length).split("/").filter(Boolean);
  try {
    if (method === "GET" && parts.length === 0) return send(200, { connectors: [card(m.box)], presets: { mail: Object.keys(PRESETS).sort() } }), true;
    if (parts[0] !== "mail") throw new Refused("unsupported", "connecteur local : mail seulement");
    if (method === "PUT" && parts.length === 1) {
      const b = await readBody();
      const settings = b.settings;
      if (!settings || typeof settings !== "object") throw new Refused("bad_settings", "settings requis");
      const secretKeys = ["password", "secret", "value", "app_password", "token"];
      if (secretKeys.some((k) => k in (settings as object)) || secretKeys.some((k) => k !== "secret" && k in b)) throw new Refused("bad_settings", NOT_A_NAME);
      const raw = String(b.secret ?? "").trim();
      const name = raw.startsWith("secret:") ? raw.slice(7) : raw;
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(name) || looksLikeValue(name)) throw new Refused("bad_settings", NOT_A_NAME);
      if (!localSecretNames(state).has(name)) throw new Refused("bad_settings", NOT_IN_VAULT);
      const norm = normalize(settings);
      const r = test(norm);
      if (!r.ok) throw new Refused(r.code ?? "protocol_error", r.message);
      const now = new Date().toISOString();
      m.box = { settings: norm, secret: name, created_at: now, last_ok_at: now };
      return send(200, { ...card(m.box), message: r.message }), true;
    }
    if (method === "POST" && parts.length === 2 && parts[1] === "test") {
      if (!m.box) throw new Refused("not_configured", "connecteur non relié");
      const r = test(m.box.settings);
      if (r.ok) m.box.last_ok_at = new Date().toISOString();
      return send(200, r), true;
    }
    if (method === "DELETE" && parts.length === 1) {
      const revoked = m.box !== null;
      m.box = null;
      return send(200, { revoked }), true;
    }
  } catch (e) {
    if (e instanceof Refused) return send(STATUS[e.code] ?? 500, { error: e.code, message: e.message }), true;
    throw e;
  }
  return send(404, { error: { message: "inconnu" } }), true;
}
