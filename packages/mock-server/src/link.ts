/**
 * Page `/link` en démo : `GET /v1/link/pending?code=` et `POST /v1/link/approve` (session du compte, comme le
 * noyau). Réglage mock seulement : `POST /v1/dev/link-mock {machine?, expires_in?, rate?}` pose une demande en
 * attente et rend son `user_code` ; `rate: true` fait répondre 429 au prochain `pending` ; `linked: true` pose
 * directement une machine liée (visible de tout compte de démo) et rend son `machine_id`, avec `last_seen_s` (secondes
 * écoulées depuis le dernier contact du relais, absent = jamais vu).
 *
 * « Mes machines » : `GET /v1/link/machines` et `POST /v1/link/machines/{id}/revoke` (session du compte ; contrat
 * proposé à dev le 24.10, LOKKAL.md §7.2). Une machine approuvée par `/link` appartient au compte qui l'a approuvée.
 */
import { randomBytes } from "node:crypto";
import type { MockState } from "./state.js";

type Send = (status: number, payload: unknown, headers?: Record<string, string>) => void;

interface LinkRequest {
  code: string;
  machine: string;
  expiresAt: number;
  state: "pending" | "approved" | "denied";
}
interface MockMachine {
  id: string;
  name: string;
  host: string;
  /** `null` : machine de démo posée par `/v1/dev/link-mock`, visible de tout compte. */
  owner: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  revoked: boolean;
}
interface MockRemoteApproval {
  machineId: string;
  approval_id: string;
  title: string;
  reason: string;
  strength: string;
  expires_at: string;
  challenge: string;
  status: "pending" | "forwarded" | "approved" | "rejected" | "expired";
}
interface LinkMock {
  approvals: Map<string, MockRemoteApproval>;
  requests: Map<string, LinkRequest>;
  machines: Map<string, MockMachine>;
  rateOnce: boolean;
}

const mocks = new WeakMap<MockState, LinkMock>();
export function linkMock(state: MockState): LinkMock {
  let m = mocks.get(state);
  if (!m) {
    m = { approvals: new Map(), requests: new Map(), machines: new Map(), rateOnce: false };
    mocks.set(state, m);
  }
  return m;
}

const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";
const code4 = (): string => Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "machine";
const notFound = { error: { message: "code inconnu ou expiré" } };
const now = (): number => Math.floor(Date.now() / 1000);

function addMachine(m: LinkMock, name: string, owner: string | null, lastSeenAt: number | null): MockMachine {
  const base = slug(name);
  let host = base;
  for (let i = 2; [...m.machines.values()].some((x) => x.host === `${host}.gw.example.test`); i++) host = `${base}-${i}`;
  const mc: MockMachine = { id: `mc_${host}`, name, host: `${host}.gw.example.test`, owner, createdAt: now(), lastSeenAt, revoked: false };
  m.machines.set(mc.id, mc);
  return mc;
}
const visible = (mc: MockMachine | undefined, user: string): mc is MockMachine =>
  !!mc && !mc.revoked && (mc.owner === null || mc.owner === user);

function live(m: LinkMock, raw: unknown): LinkRequest | null {
  const r = m.requests.get(String(raw ?? "").trim().toUpperCase());
  return r && r.state === "pending" && Date.now() <= r.expiresAt ? r : null;
}

/** Réglage de démo : sans session (comme `/v1/dev/demo-session`), pour s'en servir avec curl. */
export async function handleLinkDev(
  state: MockState,
  method: string,
  path: string,
  readBody: () => Promise<Record<string, unknown>>,
  send: Send,
): Promise<boolean> {
  if (method !== "POST" || path !== "/v1/dev/link-mock") return false;
  const m = linkMock(state);
  const b = await readBody();
  if (b.rate === true) m.rateOnce = true;
  const name = typeof b.machine === "string" && b.machine ? b.machine : "Atelier";
  if (b.linked === true) {
    const seen = typeof b.last_seen_s === "number" ? now() - b.last_seen_s : null;
    const mc = addMachine(m, name, null, seen);
    // `approval: true` : une carte forte en attente sur cette machine (page `/approve/<machine>/<approbation>`).
    if (b.approval === true) {
      const id = `ap_${randomBytes(8).toString("hex")}`;
      m.approvals.set(id, {
        machineId: mc.id,
        approval_id: id,
        title: "Supprimer le dossier build/ (démo)",
        reason: "La session « Nettoyage » veut lancer rm -rf build/ dans ~/projets/site.",
        strength: "strong",
        expires_at: new Date(Date.now() + (typeof b.expires_in === "number" ? b.expires_in : 600) * 1000).toISOString(),
        challenge: randomBytes(32).toString("base64url"),
        status: "pending",
      });
      send(200, { machine_id: mc.id, approval_id: id });
      return true;
    }
    send(200, { machine_id: mc.id });
    return true;
  }
  const code = `${code4()}-${code4()}`;
  const seconds = typeof b.expires_in === "number" ? b.expires_in : 600;
  m.requests.set(code, { code, machine: name, expiresAt: Date.now() + seconds * 1000, state: "pending" });
  send(200, { user_code: code });
  return true;
}

export async function handleLink(
  state: MockState,
  user: string,
  method: string,
  url: URL,
  readBody: () => Promise<Record<string, unknown>>,
  send: Send,
): Promise<boolean> {
  const m = linkMock(state);
  if (method === "GET" && url.pathname === "/v1/link/pending") {
    if (m.rateOnce) {
      m.rateOnce = false;
      return send(429, { error: "rate", retry_after_s: 60 }), true;
    }
    const r = live(m, url.searchParams.get("code"));
    if (!r) return send(404, notFound), true;
    return send(200, { machine_name: r.machine, expires_in: Math.max(0, Math.floor((r.expiresAt - Date.now()) / 1000)) }), true;
  }
  if (method === "POST" && url.pathname === "/v1/link/approve") {
    const b = await readBody();
    const r = live(m, b.user_code);
    if (!r) return send(404, notFound), true;
    if (b.decision !== undefined && b.decision !== "approve") {
      r.state = "denied";
      return send(200, { state: "denied" }), true;
    }
    r.state = "approved";
    const mc = addMachine(m, r.machine, user, null);
    return send(200, { state: "approved", machine_id: mc.id, host: mc.host }), true;
  }
  if (method === "GET" && url.pathname === "/v1/link/machines") {
    const list = [...m.machines.values()].filter((mc) => visible(mc, user));
    return send(200, {
      machines: list.map((mc) => ({ machine_id: mc.id, name: mc.name, host: mc.host, created_at: mc.createdAt, last_seen_at: mc.lastSeenAt })),
    }), true;
  }
  const ap = /^\/v1\/link\/machines\/([^/]+)\/approvals\/([^/]+)(\/decision)?$/.exec(url.pathname);
  if (ap) {
    const mc = m.machines.get(decodeURIComponent(ap[1]!));
    const a = m.approvals.get(decodeURIComponent(ap[2]!));
    if (!visible(mc, user) || !a || a.machineId !== mc.id) return send(404, { error: { message: "carte inconnue" } }), true;
    if (a.status === "pending" && Date.parse(a.expires_at) < Date.now()) a.status = "expired";
    const view = () => ({ approval_id: a.approval_id, title: a.title, reason: a.reason, strength: a.strength, expires_at: a.expires_at, challenge: a.challenge, status: a.status });
    if (method === "GET" && !ap[3]) return send(200, view()), true;
    if (method === "POST" && ap[3]) {
      const b = await readBody();
      const proof = (b.proof ?? {}) as Record<string, unknown>;
      const has = (k: string): boolean => typeof proof[k] === "string" && proof[k] !== "";
      const okProof = has("device_id") && (["webauthn_client_data_json", "webauthn_authenticator_data", "webauthn_signature"].every(has) || has("signature"));
      if ((b.decision !== "approve" && b.decision !== "reject") || !okProof) return send(400, { error: { message: "décision ou preuve invalide" } }), true;
      if (a.status !== "pending") return send(409, { error: { message: `carte déjà ${a.status}` } }), true;
      a.status = "forwarded";
      // Le « Lokkal » du mock vérifie et rend son verdict un peu plus tard (il ne vérifie pas la signature).
      const verdict = b.decision === "approve" ? "approved" : "rejected";
      setTimeout(() => {
        if (a.status === "forwarded") a.status = verdict;
      }, 1500);
      return send(202, { status: "forwarded" }), true;
    }
  }
  const rv = method === "POST" ? /^\/v1\/link\/machines\/([^/]+)\/revoke$/.exec(url.pathname) : null;
  if (rv) {
    const mc = m.machines.get(decodeURIComponent(rv[1]!));
    // Machine d'un autre compte : même 404 qu'une machine inconnue (pas d'oracle).
    if (!visible(mc, user)) return send(404, { error: { message: "machine inconnue" } }), true;
    mc.revoked = true;
    return send(200, { revoked: true }), true;
  }
  return false;
}
