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
import type { Agent, ApprovalSummary } from "@nokker-apps/sdk";
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
  summary_source: "nokker.ai" | "machine";
  summary: ApprovalSummary;
  args_sha256: string;
  error: string | null;
  outcome: "executed" | "failed" | null;
  advice: string | null;
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
  const name = typeof b.machine === "string" && b.machine ? b.machine : "Workshop";
  if (b.linked === true) {
    const seen = typeof b.last_seen_s === "number" ? now() - b.last_seen_s : null;
    const mc = addMachine(m, name, null, seen);
    // `approval: true` : une carte forte en attente sur cette machine (page `/approve/<machine>/<approbation>`).
    // `approval_kind: "mail"` : carte d'un connecteur relayé, résumé rendu par nokker.ai (X20c) ; sinon carte locale.
    if (b.approval === true) {
      const id = `ap_${randomBytes(8).toString("hex")}`;
      const mail = b.approval_kind === "mail";
      m.approvals.set(id, {
        machineId: mc.id,
        approval_id: id,
        title: mail ? "Send the meeting minutes (demo)" : "Delete the build/ folder (demo)",
        reason: mail ? "The “Accounting” session wants to send the meeting minutes." : "The “Cleanup” session wants to run rm -rf build/ in ~/projects/site.",
        strength: "strong",
        expires_at: new Date(Date.now() + (typeof b.expires_in === "number" ? b.expires_in : 600) * 1000).toISOString(),
        challenge: randomBytes(32).toString("base64url"),
        status: "pending",
        summary_source: mail ? "nokker.ai" : "machine",
        summary: mail
          ? {
              tool: "mail_send",
              class: "external_send",
              headline: "Send an email in your name to 2 recipients",
              lines: [
                { key: "to", label: "To", value: "alice@example.com, bob@example.com", items: ["alice@example.com", "bob@example.com"], count: 2 },
                { key: "subject", label: "Subject", value: "Minutes of 25.10" },
                { key: "body", label: "Message", value: "Hello, here are the minutes of this morning's meeting. Decisions: 1) we keep the 6.11 date; 2) the demo goes over the phone; 3) password ‹redacted›", truncated: true, length: 1240, redacted: true },
              ],
              erased: false,
            }
          : { tool: "shell", class: null, headline: null, lines: [], erased: false },
        args_sha256: randomBytes(32).toString("hex"),
        error: null,
        outcome: null,
        advice: null,
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
    if (a.status !== "pending" && a.status !== "forwarded" && !a.summary.erased) a.summary = { ...a.summary, lines: [], erased: true };
    const view = () => ({
      approval_id: a.approval_id, title: a.title, reason: a.reason, strength: a.strength, expires_at: a.expires_at, challenge: a.challenge, status: a.status,
      summary_source: a.summary_source, summary: a.summary, args_sha256: a.args_sha256, error: a.error, outcome: a.outcome, advice: a.advice,
    });
    if (method === "GET" && !ap[3]) return send(200, view()), true;
    if (method === "POST" && ap[3]) {
      const b = await readBody();
      const proof = (b.proof ?? {}) as Record<string, unknown>;
      const has = (k: string): boolean => typeof proof[k] === "string" && proof[k] !== "";
      const webauthn = ["webauthn_client_data_json", "webauthn_authenticator_data", "webauthn_signature"].every(has);
      // X10 : une carte forte se signe à la passkey ; une signature de clé simple (P1363) seule est refusée.
      if (has("device_id") && has("signature") && !webauthn && a.strength === "strong") return send(403, { error: "strong_approval_required" }), true;
      const okProof = has("device_id") && (webauthn || has("signature"));
      if ((b.decision !== "approve" && b.decision !== "reject") || !okProof) return send(400, { error: { message: "décision ou preuve invalide" } }), true;
      if (a.status !== "pending") return send(409, { error: { message: `carte déjà ${a.status}` } }), true;
      a.status = "forwarded";
      // Le « Lokkal » du mock vérifie et rend son verdict un peu plus tard (il ne vérifie pas la signature).
      const verdict = b.decision === "approve" ? "approved" : "rejected";
      setTimeout(() => {
        if (a.status !== "forwarded") return;
        a.status = verdict;
        if (verdict === "approved") a.outcome = "executed";
        a.summary = { ...a.summary, lines: [], erased: true };
      }, 1500);
      return send(202, { status: "forwarded" }), true;
    }
  }
  // X15 (LOKKAL §7.19 point 5) : deck de toutes les machines, des noms et des états seulement. Charge et sessions de démo.
  if (method === "GET" && url.pathname === "/v1/link/deck") {
    const nowS = now();
    const machines = [...m.machines.values()].filter((mc) => visible(mc, user)).sort((x, y) => x.name.localeCompare(y.name));
    const deckAgent = (a: Agent) => ({
      id: a.id, name: a.name, status: a.status, placement: a.placement ?? null, trigger: a.trigger?.kind ?? "manual",
      next_run_at: a.next_run_at ? Math.floor(Date.parse(a.next_run_at) / 1000) : null,
      last_run: a.last_run ? { status: a.last_run.status, ended_at: a.last_run.ended_at ? Math.floor(Date.parse(a.last_run.ended_at) / 1000) : null } : null,
      live_run: a.status === "running" ? { run_id: a.last_run?.run_id ?? "", status: "running", machine_id: a.placement?.machine?.startsWith("mc_") ? a.placement.machine : null } : null,
      defined_at: "nokker.ai" as const,
    });
    const agents = [...state.agents.values()];
    const online = (mc: MockMachine) => mc.lastSeenAt !== null && nowS - mc.lastSeenAt < 180;
    return send(200, {
      at: nowS,
      machines: machines.map((mc, i) => ({
        machine_id: mc.id, name: mc.name, host: mc.host, online: online(mc),
        load_age_s: mc.lastSeenAt === null ? null : nowS - mc.lastSeenAt,
        load: online(mc)
          ? { ram: { total_mb: 32768, free_mb: i === 0 ? 9100 : 21400 }, cpu: { count: 16, load1: i === 0 ? 7.2 : 1.1, rel: i === 0 ? 0.45 : 0.07 }, gpus: i === 0 ? [{ name: "Demo GPU", memory_total_mb: 24576, memory_free_mb: 20000, util_pct: 12 }] : [], sessions: 2, active_turns: i === 0 ? 1 : 0 }
          : null,
        deck_at: mc.lastSeenAt, deck_age_s: mc.lastSeenAt === null ? null : nowS - mc.lastSeenAt,
        sessions: online(mc)
          ? [{ thread_id: `th_${mc.id}_site`, name: "site", state: i === 0 ? "working" : "idle", title: null }, { thread_id: `th_${mc.id}_api`, name: "api", state: i === 0 ? "awaiting_approval" : "idle", title: null }]
          : [],
        agents: agents.filter((a) => a.placement?.machine === mc.id).map(deckAgent),
        pending_approvals: [...m.approvals.values()].filter((a) => a.machineId === mc.id && a.status === "pending").length,
        strong_approvals: [...m.approvals.values()].filter((a) => a.machineId === mc.id && a.status === "pending").map((a) => ({ approval_id: a.approval_id, expires_at: a.expires_at, url: `/approve/${mc.id}/${a.approval_id}` })),
      })),
      web: { engine: true, agents: agents.filter((a) => !a.placement || a.placement.machine === "web").map(deckAgent) },
      auto: { agents: agents.filter((a) => a.placement?.machine === "auto").map(deckAgent) },
    }), true;
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

/** X15 : machines du compte vues par le moteur de démo (déménagement). */
export function deckMachines(state: MockState, user: string): { id: string; name: string; online: boolean; gpu: boolean }[] {
  const m = linkMock(state);
  const nowS = now();
  const list = [...m.machines.values()].filter((mc) => visible(mc, user)).sort((x, y) => x.name.localeCompare(y.name));
  return list.map((mc, i) => ({ id: mc.id, name: mc.name, online: mc.lastSeenAt !== null && nowS - mc.lastSeenAt < 180, gpu: i === 0 }));
}
