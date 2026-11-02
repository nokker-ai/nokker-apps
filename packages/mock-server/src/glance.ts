/**
 * Glance view for display glasses — mock of core docs/AMBIENT.md §6 (flag `ambient.glance`, on in the mock).
 * A glance token (`nkg_…`) opens ONLY `GET /v1/glance`: every other route answers 403 `glance_scope` (the gate runs
 * before any other authentication, like the core). Codes: 8 characters on ABCDEFGHJKMNPQRSTVWXYZ23456789, shown
 * `XXXX-XXXX`, 5 minutes, single use; 5 glance devices per account; 10 wrong codes in a row → 429.
 * Reads: at most 2 per minute per token (core p2/ambient-out e21cf34) → 429 `glance_rate` with Retry-After (seconds).
 * The mock keeps tokens in memory (the core keeps only their fingerprint).
 */
import { randomBytes, randomInt } from "node:crypto";
import type { Approval, GlanceDevice } from "@nokker-apps/sdk";
import { latestRun } from "./agents.js";
import { glanceOps } from "./ops.js";
import { randomId, type MockState } from "./state.js";

type Send = (status: number, payload: unknown, headers?: Record<string, string>) => void;

const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const OFFER_S = 300;
const MAX_DEVICES = 5;
const MAX_ATTEMPTS = 10;
const READS_PER_MIN = 2;

interface Offer {
  code: string;
  user: string;
  name: string;
  expires: number;
}
interface Device extends GlanceDevice {
  token: string;
  user: string;
  /** Times of the reads in the last minute (rate limit). */
  reads: number[];
}
interface G {
  offers: Map<string, Offer>;
  devices: Map<string, Device>;
  wrong: number;
}
const all = new WeakMap<MockState, G>();
function g(state: MockState): G {
  let x = all.get(state);
  if (!x) all.set(state, (x = { offers: new Map(), devices: new Map(), wrong: 0 }));
  return x;
}

const err = (send: Send, status: number, code: string, message: string): true => (send(status, { error: { code, message } }), true);

function newCode(): string {
  let c = "";
  for (let i = 0; i < 8; i++) c += ALPHABET[randomInt(ALPHABET.length)];
  return c;
}

function bearer(header: string | undefined): string | null {
  return header && header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

/** The view, read for the device's owner, with the same JSON shapes as the original routes. */
function view(state: MockState): unknown {
  const unavailable: string[] = [];
  const { briefAgent, liveIncidents } = glanceOps(state);
  const approvals: Approval[] = [...state.approvals.values()].filter((a) => a.status === "pending");
  return {
    brief: { agent: briefAgent },
    brief_last_run: briefAgent ? latestRun(state, briefAgent.id) : null,
    approvals,
    incidents: liveIncidents,
    unavailable,
    at: new Date().toISOString(),
  };
}

/**
 * Runs before every other handler. `authUser` gives the account behind a normal session (null without one).
 * Returns true when the request was answered.
 */
export async function handleGlance(
  state: MockState,
  authorization: string | undefined,
  method: string,
  path: string,
  readBody: () => Promise<Record<string, unknown>>,
  send: Send,
  authUser: () => string | null,
): Promise<boolean> {
  const x = g(state);
  const token = bearer(authorization);
  // Gate: a glance token opens GET /v1/glance and nothing else.
  if (token?.startsWith("nkg_")) {
    if (!(path === "/v1/glance" && method === "GET")) return path.startsWith("/v1/") ? err(send, 403, "glance_scope", "a glance token only reads GET /v1/glance") : false;
    const d = [...x.devices.values()].find((v) => v.token === token && !v.revoked);
    if (!d) return err(send, 401, "bad_glance_token", "unknown or revoked glance token");
    const now = Date.now();
    d.reads = d.reads.filter((t) => now - t < 60_000);
    if (d.reads.length >= READS_PER_MIN) {
      const wait = Math.max(1, Math.ceil((d.reads[0]! + 60_000 - now) / 1000));
      return send(429, { error: { code: "glance_rate", message: `at most ${READS_PER_MIN} reads per minute`, retry_after: wait } }, { "Retry-After": String(wait) }), true;
    }
    d.reads.push(now);
    d.last_seen_at = new Date().toISOString();
    return send(200, view(state)), true;
  }
  if (path === "/v1/glance" && method === "GET") return err(send, 401, "glance_token_required", "GET /v1/glance needs a glance token");

  if (path === "/v1/glance/claim" && method === "POST") {
    if (x.wrong >= MAX_ATTEMPTS) return err(send, 429, "too_many_attempts", "too many wrong codes, try again later");
    const raw = String((await readBody()).code ?? "");
    const code = raw.trim().replace(/^NOKKER-GLANCE:/i, "").replace(/[\s-]+/g, "").toUpperCase();
    const o = x.offers.get(code);
    if (!o || o.expires < Date.now()) {
      x.wrong++;
      return err(send, 404, "unknown_code", "unknown, expired or already used code");
    }
    x.offers.delete(code);
    x.wrong = 0;
    const id = randomId("gl");
    const d: Device = { id, name: o.name, kind: "glance", paired: true, revoked: false, created_at: new Date().toISOString(), last_seen_at: null, account_id: o.user, token: `nkg_${randomBytes(24).toString("base64url")}`, user: o.user, reads: [] };
    x.devices.set(id, d);
    return send(201, { token: d.token, device: { id, name: d.name }, scope: "glance" }), true;
  }

  const owner = path === "/v1/glance/pair" || path === "/v1/glance/devices" || path.startsWith("/v1/glance/devices/");
  if (!owner) return false;
  const user = authUser();
  if (!user) return err(send, 401, "unauthorized", "unauthorized");
  if (path === "/v1/glance/pair" && method === "POST") {
    const live = [...x.devices.values()].filter((d) => d.user === user && !d.revoked).length;
    if (live >= MAX_DEVICES) return err(send, 409, "too_many_glance", `at most ${MAX_DEVICES} glance views per account`);
    const name = String((await readBody()).name ?? "").trim().slice(0, 60) || "Glasses";
    const code = newCode();
    x.offers.set(code, { code, user, name, expires: Date.now() + OFFER_S * 1000 });
    return send(201, { offer_id: randomId("go"), code: `${code.slice(0, 4)}-${code.slice(4)}`, qr: `NOKKER-GLANCE:${code}`, expires_in: OFFER_S }), true;
  }
  if (path === "/v1/glance/devices" && method === "GET") {
    const devices = [...x.devices.values()].filter((d) => d.user === user).map(({ token: _t, user: _u, reads: _r, ...pub }) => (void _t, void _u, void _r, pub));
    return send(200, { devices }), true;
  }
  const m = /^\/v1\/glance\/devices\/([^/]+)$/.exec(path);
  if (m && method === "DELETE") {
    const d = x.devices.get(decodeURIComponent(m[1]!));
    if (!d || d.user !== user) return err(send, 404, "not_found", "no such glance device");
    d.revoked = true;
    return send(200, { revoked: true }), true;
  }
  return false;
}
