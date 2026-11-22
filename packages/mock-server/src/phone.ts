/**
 * Nœud téléphone (LOKKAL-PHONE §3, lot P7, PHASE S) — faux noyau du contrat (packages/sdk/src/node.ts).
 *
 * Session du membre : POST /v1/link/phone (carte FORTE `phone_register`, décidée sur un AUTRE appareil enrôlé ; elle
 * porte le nom du téléphone et l'empreinte de sa clé), GET /v1/link/phone/registrations/{id} (jeton rendu UNE fois),
 * GET /v1/link/phone/{machine}/tasks (journal sans contenu), POST /v1/link/machines/{id}/revoke pour un téléphone.
 * Nœud : jeton de machine + `X-Nokker-Node-Proof` (ES256 sur method\nhost\npath?query\nts\nnonce\nsha256hex(corps),
 * ± 60 s, nonce vu dans les 120 s refusé) : beat, long poll (bail 60 s), lease, result (idempotent), blobs signés
 * (2 min, usage unique, liés au nœud ; une autre machine reçoit 403).
 * Drapeaux de phase S : `phone_nodes` et `phone_nodes_unattested` (compte QA du mock : les deux à vrai) ; un nœud non
 * attesté ne reçoit que des opérations de LECTURE (toutes les opérations de la table P7 en sont).
 * Réglages du mock (sans session, boucle locale) : GET /v1/dev/phone/pending (dernière carte en attente) ;
 * POST /v1/dev/phone/approve {approval_id, decision?} joue l'autre
 * appareil ; POST /v1/dev/phone/task {machine_id?, op, args?, image?, audio?} met une tâche en file et rend son id ;
 * GET /v1/dev/phone/task/{id} lit l'état et le résultat ; POST /v1/dev/phone/flags {phone_nodes?, unattested?}.
 */
import type { IncomingMessage } from "node:http";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { argsSha256, DISCOVERY_TYPES, HA_WRITE_OPS, PHONE_OPS, type HaOp, sealToken, phoneResultMax, parseProof, proofString, type PhoneBeat, type PhoneCap, type PhoneOp, type PhoneTask, type PhoneTaskLog } from "@nokker-apps/sdk";
import type { Approval } from "@nokker-apps/sdk";
import { finalizeDecision, MOCK_USER, type MockState } from "./state.js";

type Send = (status: number, obj: unknown, headers?: Record<string, string>) => void;

const LEASE_MS = 60_000;
const SKEW_S = 60;
const NONCE_MS = 120_000;
const BLOB_MS = 120_000;
const MAX_PHONES = 3;
const MAX_WAIT_S = 25;
const CAPS_ALLOWED: PhoneCap[] = ["location", "device_calendar", "ocr", "stt", "lan_home"];

interface Reg {
  user: string;
  fromDevice: string;
  name: string;
  platform: "ios" | "android";
  osVersion: string;
  appVersion: string;
  keyStorage: string;
  spki: Uint8Array;
  encSpki: string;
  fingerprint: string;
  machineId: string | null;
  token: string | null;
  claimed: boolean;
  /** Création du nœud après l'approbation (import de la clé, asynchrone) : la route d'inscription l'attend. */
  ready?: Promise<void>;
}
export interface Node {
  id: string;
  user: string;
  name: string;
  platform: string;
  keyStorage: string;
  attested: boolean;
  key: webcrypto.CryptoKey;
  fingerprint: string;
  token: string;
  revoked: boolean;
  createdAt: string;
  lastBeat: number | null;
  beat: PhoneBeat | null;
  nonces: Map<string, number>;
}
export interface Task {
  id: string;
  machine: string;
  user: string;
  op: PhoneOp;
  args: Record<string, unknown>;
  origin: PhoneTask["origin"];
  status: PhoneTaskLog["status"];
  leaseUntil: number;
  deadline: number;
  at: string;
  result?: string;
  error?: { code: string; message?: string };
}
interface Blob {
  machine: string;
  exp: number;
  used: boolean;
  type: string;
  bytes: Buffer;
}
interface PhoneMock {
  regs: Map<string, Reg>;
  nodes: Map<string, Node>;
  tasks: Map<string, Task>;
  blobs: Map<string, Blob>;
  waiters: Map<string, Array<() => void>>;
  flags: { phone_nodes: boolean; unattested: boolean };
}
const all = new WeakMap<MockState, PhoneMock>();
export function phoneMock(state: MockState): PhoneMock {
  let m = all.get(state);
  if (!m) all.set(state, (m = { regs: new Map(), nodes: new Map(), tasks: new Map(), blobs: new Map(), waiters: new Map(), flags: { phone_nodes: true, unattested: true } }));
  return m;
}

const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const fromB64u = (s: string): Buffer => Buffer.from(s, "base64url");
const sha256hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
};
const rid = (p: string): string => `${p}_${randomBytes(8).toString("hex")}`;
const err = (send: Send, status: number, code: string, message = code): true => (send(status, { error: { code, message } }), true);

/** Nœuds du membre en ligne (battement depuis moins de 180 s) : P8 bascule sur la file quand il y en a un. */
export function liveNodeOf(state: MockState, user: string): Node | undefined {
  const t = Date.now();
  return [...phoneMock(state).nodes.values()].find((n) => n.user === user && !n.revoked && n.lastBeat !== null && t - n.lastBeat < 180_000);
}

function wake(m: PhoneMock, machine: string): void {
  const w = m.waiters.get(machine);
  m.waiters.delete(machine);
  for (const f of w ?? []) f();
}

/** Nœud en ligne du membre dont `egress` est allumé (battement : `caps.egress = "on"`). */
export function liveEgressNode(state: MockState, user: string): Node | undefined {
  const t = Date.now();
  return [...phoneMock(state).nodes.values()].find((n) => n.user === user && !n.revoked && n.lastBeat !== null && t - n.lastBeat < 180_000 && n.beat?.reach === "live" && n.beat?.caps?.egress === "on");
}

/**
 * Placement P7b (`nokker/cloud/placement.py`, entre téléphones) : en ligne (battement ≤ 180 s, `reach: live`), la
 * capacité à `on` dans le battement (`off`/`denied` = absente), puis en charge avant batterie, Wi-Fi avant cellulaire,
 * puis nom et id. Le modèle ne choisit jamais la machine.
 */
export function placeNode(state: MockState, user: string, cap: string): Node | undefined {
  const t = Date.now();
  const caps = (n: Node): Record<string, string> => (n.beat?.caps ?? {}) as Record<string, string>;
  const home = cap === "lan_home" || cap === "camera";
  // P10a : `lan_home` exige le Wi-Fi déclaré « maison » au battement ; mode `home` avant `pocket` pour la maison.
  const ok = [...phoneMock(state).nodes.values()].filter((n) => n.user === user && !n.revoked && n.lastBeat !== null && t - n.lastBeat < 180_000 && n.beat?.reach === "live" && caps(n)[cap] === "on" && (cap !== "lan_home" || n.beat?.net?.home_wifi === true));
  const rank = (n: Node): [number, number, number, string, string] => [home && n.beat?.mode !== "home" ? 1 : 0, n.beat?.power?.charging ? 0 : 1, n.beat?.net?.type === "wifi" ? 0 : 1, n.name, n.id];
  ok.sort((a, b) => {
    const x = rank(a), y = rank(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3].localeCompare(y[3]) || x[4].localeCompare(y[4]);
  });
  return ok[0];
}

/** Blob signé pour CE nœud (2 min, usage unique) : l'URL que le natif relit avec sa preuve. */
export function mediaUrl(state: MockState, machine: string, type: string, bytes: Buffer, hostHeader: string): string {
  const tok = randomBytes(18).toString("base64url");
  phoneMock(state).blobs.set(tok, { machine, exp: Date.now() + BLOB_MS, used: false, type, bytes });
  return `http://${hostHeader}/v1/gateway/phone/blobs/${tok}`;
}

/** Attend la fin d'une tâche (fait, échec, expirée, annulée) au plus `ms`. */
export async function waitTask(t: Task, ms: number): Promise<Task> {
  const end = Date.now() + ms;
  while (Date.now() < end && (t.status === "queued" || t.status === "leased")) await new Promise((r) => setTimeout(r, 25));
  return t;
}

/** Met une tâche en file (le noyau le fait pendant un tour ; ici la route de réglage et P8). */
export function enqueuePhoneTask(state: MockState, machine: string, op: PhoneOp, args: Record<string, unknown>, origin: PhoneTask["origin"] = { kind: "turn" }): Task {
  const m = phoneMock(state);
  const n = m.nodes.get(machine)!;
  const t: Task = { id: rid("tk"), machine, user: n.user, op, args, origin, status: "queued", leaseUntil: 0, deadline: Date.now() + 5 * 60_000, at: new Date().toISOString() };
  m.tasks.set(t.id, t);
  wake(m, machine);
  return t;
}

function wire(t: Task): PhoneTask {
  return { task_id: t.id, op: t.op, args: t.args, args_sha256: argsSha256(t.args), origin: t.origin, heavy: t.op === "stt.audio", deadline: new Date(t.deadline).toISOString(), lease_until: new Date(t.leaseUntil).toISOString() };
}

function expire(m: PhoneMock): void {
  const t = Date.now();
  for (const k of m.tasks.values()) {
    if (k.status === "leased" && t > k.leaseUntil) k.status = "queued"; // bail échu : la tâche revient en file
    if ((k.status === "queued" || k.status === "leased") && t > k.deadline) k.status = "expired";
  }
}

/** Vérifie jeton + preuve. Rend le nœud, ou envoie l'erreur et rend null. */
async function authNode(m: PhoneMock, req: IncomingMessage, url: URL, method: string, raw: Buffer, send: Send): Promise<Node | null> {
  const token = String(req.headers["authorization"] ?? "").replace(/^Bearer /, "").trim();
  const n = [...m.nodes.values()].find((x) => x.token === token);
  if (!token || !n || n.revoked) return err(send, 401, "machine_unknown"), null;
  const p = parseProof(req.headers["x-nokker-node-proof"] as string | undefined);
  if (!p) return err(send, 401, "proof_invalid", "preuve absente ou mal formée"), null;
  const nowS = Math.floor(Date.now() / 1000);
  if (Math.abs(nowS - p.ts) > SKEW_S) return err(send, 401, "proof_invalid", "horloge hors fenêtre"), null;
  for (const [k, at] of n.nonces) if (Date.now() - at > NONCE_MS) n.nonces.delete(k);
  if (n.nonces.has(p.nonce)) return err(send, 401, "proof_invalid", "nonce déjà vu"), null;
  const host = String(req.headers["host"] ?? "");
  const data = new TextEncoder().encode(proofString(method, host, url.pathname + url.search, p.ts, p.nonce, sha256hex(raw)));
  const sig = fromB64u(p.sig);
  const ok = sig.length === 64 && (await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, n.key, sig, data));
  if (!ok) return err(send, 401, "proof_invalid", "signature invalide"), null;
  n.nonces.set(p.nonce, Date.now());
  return n;
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Routes du NŒUD (sans session) et réglages du mock. À appeler AVANT toute lecture du corps de la requête. */
export async function handlePhoneNode(state: MockState, req: IncomingMessage, method: string, url: URL, send: Send, sendRaw: (status: number, type: string, body: Buffer) => void, loopback: boolean): Promise<boolean> {
  const path = url.pathname;
  const m = phoneMock(state);
  if (path.startsWith("/v1/dev/phone/")) {
    if (!loopback) return err(send, 403, "loopback_only");
    const raw = await readRaw(req);
    let b: Record<string, unknown> = {};
    try {
      b = raw.length ? (JSON.parse(raw.toString("utf-8")) as Record<string, unknown>) : {};
    } catch {
      return err(send, 400, "bad_json");
    }
    if (method === "POST" && path === "/v1/dev/phone/flags") {
      if (typeof b.phone_nodes === "boolean") m.flags.phone_nodes = b.phone_nodes;
      if (typeof b.unattested === "boolean") m.flags.unattested = b.unattested;
      return send(200, m.flags), true;
    }
    if (method === "GET" && path === "/v1/dev/phone/pending") {
      const id = [...m.regs.keys()].reverse().find((k) => state.approvals.get(k)?.status === "pending");
      return id ? (send(200, { approval_id: id, key_fingerprint: m.regs.get(id)!.fingerprint, name: m.regs.get(id)!.name }), true) : err(send, 404, "none");
    }
    if (method === "POST" && path === "/v1/dev/phone/approve") {
      const a = state.approvals.get(String(b.approval_id ?? ""));
      if (!a || a.tool_name !== "phone_register" || a.status !== "pending") return err(send, 404, "not_found");
      finalizeDecision(state, a, b.decision === "reject" ? "reject" : "approve", "webauthn", a.decided_by ?? MOCK_USER);
      return send(200, { status: a.status }), true;
    }
    if (method === "POST" && path === "/v1/dev/phone/task") {
      const op = b.op as PhoneOp;
      if (!PHONE_OPS.has(op)) return err(send, 400, "unknown_op");
      // P11 : fetch.get ne se met en file QUE par la liste d'hôtes ou le geste de la personne (egress.ts), jamais ici.
      if (op === "fetch.get") return err(send, 403, "fetch_needs_grant");
      const n = b.machine_id ? m.nodes.get(String(b.machine_id)) : [...m.nodes.values()].reverse().find((x) => !x.revoked);
      if (!n || n.revoked) return err(send, 404, "no_node");
      // P10a : une action sur la maison ne part qu'à un nœud ATTESTÉ (un nœud non attesté ne fait que des lectures).
      if (HA_WRITE_OPS.has(op as HaOp) && !n.attested) return err(send, 403, "attestation_required");
      const args = { ...((b.args as Record<string, unknown>) ?? {}) };
      if (op === "ocr.image" || op === "stt.audio") {
        const isImg = op === "ocr.image";
        const src = String((isImg ? b.image : b.audio) ?? "");
        const mm = /^data:([^;]+);base64,(.+)$/.exec(src);
        if (!mm) return err(send, 400, "data_url_required");
        args[isImg ? "image_url" : "audio_url"] = mediaUrl(state, n.id, mm[1]!, Buffer.from(mm[2]!, "base64"), String(req.headers["host"]));
      }
      const t = enqueuePhoneTask(state, n.id, op, args);
      return send(201, { task_id: t.id }), true;
    }
    const tm = /^\/v1\/dev\/phone\/task\/([^/]+)$/.exec(path);
    if (method === "GET" && tm) {
      expire(m);
      const t = m.tasks.get(decodeURIComponent(tm[1]!));
      return t ? (send(200, { status: t.status, result: t.result ?? null, error: t.error ?? null }), true) : err(send, 404, "not_found");
    }
    return err(send, 404, "not_found");
  }
  if (!path.startsWith("/v1/gateway/phone/")) return false;
  const raw = await readRaw(req);
  const n = await authNode(m, req, url, method, raw, send);
  if (!n) return true;
  let b: Record<string, unknown> = {};
  try {
    b = raw.length ? (JSON.parse(raw.toString("utf-8")) as Record<string, unknown>) : {};
  } catch {
    return err(send, 400, "bad_json");
  }
  expire(m);
  if (method === "POST" && path === "/v1/gateway/phone/beat") {
    if (b.v !== 1 || (b.reach !== "live" && b.reach !== "push")) return err(send, 400, "bad_beat");
    // Phase S : sans APNs, seul « live » est joignable.
    if (b.reach === "push") return err(send, 400, "push_unavailable");
    n.lastBeat = Date.now();
    n.beat = b as unknown as PhoneBeat;
    return send(200, { ok: true, state: "live", next_beat_s: 60 }), true;
  }
  if (method === "GET" && path === "/v1/gateway/phone/tasks") {
    n.lastBeat = Date.now();
    const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(url.searchParams.get("wait") ?? 0) || 0));
    const take = (): PhoneTask[] => {
      expire(m);
      const out: PhoneTask[] = [];
      for (const t of m.tasks.values()) {
        if (t.machine !== n.id || t.status !== "queued") continue;
        t.status = "leased";
        t.leaseUntil = Date.now() + LEASE_MS;
        out.push(wire(t));
        if (out.length >= 4) break;
      }
      return out;
    };
    let got = take();
    if (!got.length && wait > 0) {
      await new Promise<void>((ok) => {
        const timer = setTimeout(ok, wait * 1000);
        const list = m.waiters.get(n.id) ?? [];
        list.push(() => (clearTimeout(timer), ok()));
        m.waiters.set(n.id, list);
        req.once("close", () => (clearTimeout(timer), ok()));
      });
      got = take();
    }
    return send(200, { tasks: got }), true;
  }
  const lm = /^\/v1\/gateway\/phone\/tasks\/([^/]+)\/(lease|result)$/.exec(path);
  if (lm && method === "POST") {
    const t = m.tasks.get(decodeURIComponent(lm[1]!));
    if (!t || t.machine !== n.id) return err(send, 404, "not_found");
    if (lm[2] === "lease") {
      if (t.status !== "leased") return err(send, 409, `task_${t.status}`);
      t.leaseUntil = Date.now() + LEASE_MS;
      return send(200, { lease_until: new Date(t.leaseUntil).toISOString() }), true;
    }
    // Résultat idempotent : un second envoi identique rend {stored: false} ; un résultat différent après coup, 409.
    if (t.status === "done" || t.status === "failed") {
      const same = b.status === t.status && (b.result ?? null) === (t.result ?? null);
      return same ? (send(200, { stored: false }), true) : err(send, 409, "already_answered");
    }
    if (t.status !== "leased") return err(send, 409, `task_${t.status}`);
    if (b.status === "done") {
      if (typeof b.result !== "string") return err(send, 400, "result_required");
      if (Buffer.byteLength(b.result, "utf-8") > phoneResultMax(t.op)) return err(send, 413, "result_too_large");
      t.status = "done";
      t.result = b.result;
    } else if (b.status === "failed") {
      const e = b.error as { code?: unknown; message?: unknown } | undefined;
      if (!e || typeof e.code !== "string") return err(send, 400, "error_required");
      t.status = "failed";
      t.error = { code: e.code.slice(0, 40), ...(typeof e.message === "string" ? { message: e.message.slice(0, 200) } : {}) };
    } else return err(send, 400, "bad_status");
    t.at = new Date().toISOString();
    return send(200, { stored: true }), true;
  }
  const bm = /^\/v1\/gateway\/phone\/blobs\/([A-Za-z0-9_-]+)$/.exec(path);
  if (bm && method === "GET") {
    const bl = m.blobs.get(bm[1]!);
    if (!bl || bl.used || Date.now() > bl.exp) return err(send, 410, "gone");
    if (bl.machine !== n.id) return err(send, 403, "not_your_blob");
    bl.used = true;
    return sendRaw(200, bl.type, bl.bytes), true;
  }
  return err(send, 404, "not_found");
}

/** Routes de la SESSION du membre (l'app qui inscrit son téléphone, la carte « Ce téléphone »). */
/** P10c : une lecture à la demande par la file du nœud (10 s), pour le TITULAIRE ; rien n'est gardé ici. */
async function cameraAsk(state: MockState, user: string, machine: string, op: "camera.watch_event" | "camera.thumb_url" | "lan.discover", args: Record<string, unknown>, send: Send): Promise<Task | null> {
  const n = phoneMock(state).nodes.get(machine);
  if (!n || n.revoked || n.user !== user) return err(send, 404, "not_found"), null;
  const t = Date.now();
  const live = n.lastBeat !== null && t - n.lastBeat < 180_000 && n.beat?.reach === "live";
  if (!live) return err(send, 409, "node_offline"), null;
  const task = await waitTask(enqueuePhoneTask(state, machine, op, args, { kind: "turn" }), Number(process.env.NOKKER_MOCK_CAMERA_WAIT_MS) || 10_000);
  if (task.status === "queued" || task.status === "leased") {
    task.status = "cancelled";
    return err(send, 504, "phone_timeout"), null;
  }
  if (task.status !== "done") {
    const code = task.error?.code ?? "phone_timeout";
    if (code === "thumb_gone") return err(send, 410, "thumb_gone"), null;
    if (code === "not_found") return err(send, 404, "not_found"), null;
    return send(502, { error: { code, message: code } }), null;
  }
  return task;
}

export async function handlePhoneSession(state: MockState, user: string, sessionDevice: string, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send, query: URLSearchParams = new URLSearchParams()): Promise<boolean> {
  const m = phoneMock(state);
  // P10c : caméra de veille du nœud maison (contrat verrouillé avec onboarding le 06.11). Texte seulement ; l'url et la
  // clé de la vignette ne sont JAMAIS gardées : la tâche est close avec un résultat vide après la réponse.
  const ce = /^\/v1\/link\/phone\/([^/]+)\/camera\/events$/.exec(path);
  if (ce && method === "GET") {
    const t = await cameraAsk(state, user, decodeURIComponent(ce[1]!), "camera.watch_event", { after: Number(query.get("after") ?? 0) || 0, limit: 200 }, send);
    if (!t) return true;
    const r = JSON.parse(t.result ?? "{}") as { items?: Record<string, unknown>[]; now?: number };
    const keys = ["id", "camera", "start", "end", "severity", "niveau", "title", "summary", "objects", "zones", "has_thumb"];
    const items = (r.items ?? []).map((i) => Object.fromEntries(keys.filter((k) => k in i).map((k) => [k, i[k]])));
    return send(200, { items, now: r.now ?? Date.now() / 1000 }, { "Cache-Control": "no-store" }), true;
  }
  // P10d : appareils du réseau local, à la demande par la file (contrat d'onboarding) ; adresse ou TXT → 502 bad_result.
  const ls = /^\/v1\/link\/phone\/([^/]+)\/lan\/services$/.exec(path);
  if (ls && method === "GET") {
    const types = (query.get("types") ?? "").split(",").filter(Boolean);
    if (types.some((t) => !(DISCOVERY_TYPES as readonly string[]).includes(t))) return err(send, 400, "bad_op");
    const n = m.nodes.get(decodeURIComponent(ls[1]!));
    if (n && n.user === user && !n.revoked && n.beat?.net?.home_wifi !== true) return err(send, 409, "node_offline");
    const t = await cameraAsk(state, user, decodeURIComponent(ls[1]!), "lan.discover", { ...(types.length ? { types } : {}), timeout_s: 3 }, send);
    if (!t) return true;
    const r = JSON.parse(t.result ?? "{}") as { services?: Record<string, unknown>[]; at?: string };
    const banned = ["ip", "port", "txt", "address", "addresses", "host", "mac"];
    if ((r.services ?? []).some((x) => banned.some((k) => k in x))) return err(send, 502, "bad_result");
    const services = (r.services ?? []).map((x) => ({ id: String(x.id ?? ""), types: Array.isArray(x.types) ? x.types.map(String) : [String(x.type ?? "")], name: String(x.name ?? "").replace(/<[^>]*>/g, "").slice(0, 63) }));
    return send(200, { services, at: r.at ?? new Date().toISOString() }, { "Cache-Control": "no-store" }), true;
  }
  const ct = /^\/v1\/link\/phone\/([^/]+)\/camera\/(?:thumb|([^/]+)\/thumb)$/.exec(path);
  if (ct && (method === "POST" || method === "GET")) {
    const id = method === "POST" ? String((await readBody()).id ?? "") : decodeURIComponent(ct[2] ?? "");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) return err(send, 400, "bad_request");
    const t = await cameraAsk(state, user, decodeURIComponent(ct[1]!), "camera.thumb_url", { id }, send);
    if (!t) return true;
    const r = JSON.parse(t.result ?? "{}") as { url?: string; key?: string; expires_in?: number };
    t.result = undefined; // jamais gardé (le noyau clôt la tâche avec un résultat vide)
    return send(200, { id, url: r.url, key: r.key, expires_in: Math.min(300, r.expires_in ?? 300) }, { "Cache-Control": "no-store" }), true;
  }
  if (method === "POST" && path === "/v1/link/phone") {
    if (!m.flags.phone_nodes) return err(send, 404, "not_found");
    const b = await readBody();
    const allowed = new Set(["name", "platform", "os_version", "app_version", "public_key_spki", "enc_key_spki", "attestation", "key_storage", "push_token"]);
    if (Object.keys(b).some((k) => !allowed.has(k))) return err(send, 400, "unknown_field");
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name || name.length > 40) return err(send, 400, "bad_name");
    if (b.platform !== "ios" && b.platform !== "android") return err(send, 400, "bad_platform");
    if (!["secure_enclave", "strongbox", "software"].includes(String(b.key_storage))) return err(send, 400, "bad_key_storage");
    if (b.attestation !== null && b.attestation !== undefined) return err(send, 400, "attestation_unsupported", "phase S : pas d'attestation");
    if (!m.flags.unattested) return err(send, 400, "attestation_required");
    if (b.push_token !== null && b.push_token !== undefined) return err(send, 400, "push_unavailable");
    let spki: Buffer;
    try {
      spki = fromB64u(String(b.public_key_spki ?? ""));
      await webcrypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    } catch {
      return err(send, 400, "bad_public_key");
    }
    // Clé d'ACCORD (ECDH) qui recevra le jeton scellé ; jamais la clé de signature.
    const encSpki = String(b.enc_key_spki ?? "");
    try {
      await webcrypto.subtle.importKey("spki", fromB64u(encSpki), { name: "ECDH", namedCurve: "P-256" }, false, []);
    } catch {
      return err(send, 400, "bad_enc_key");
    }
    if (encSpki === String(b.public_key_spki)) return err(send, 400, "enc_key_reused", "la clé d'accord doit différer de la clé de signature");
    if ([...m.nodes.values()].filter((n) => n.user === user && !n.revoked).length >= MAX_PHONES) return err(send, 409, "too_many_phones");
    const fingerprint = sha256hex(spki).slice(0, 8);
    const args = { name, platform: b.platform, key_fingerprint: fingerprint, key_storage: b.key_storage, attested: false };
    const a: Approval = {
      id: `appr_${randomBytes(6).toString("hex")}`,
      thread_id: "",
      turn_index: 0,
      channel: "web",
      tool_name: "phone_register",
      arguments: args,
      args_sha256: argsSha256(args),
      effect: "account",
      rule: "effect:account",
      reason: `Inscrire le téléphone « ${name} » comme nœud (clé ${fingerprint}).`,
      advice: "À approuver sur un AUTRE appareil déjà enrôlé.",
      strength: "strong",
      status: "pending",
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      decided_by: null,
      decided_via: null,
      decided_at: null,
      result_summary: null,
      error: null,
    };
    const reg: Reg = { user, fromDevice: sessionDevice, name, platform: b.platform, osVersion: String(b.os_version ?? "").slice(0, 20), appVersion: String(b.app_version ?? "").slice(0, 20), keyStorage: String(b.key_storage), spki, encSpki, fingerprint, machineId: null, token: null, claimed: false };
    m.regs.set(a.id, reg);
    state.approvals.set(a.id, a);
    state.approvalEffects.set(a.id, () => {
      const id = `mc_ph_${randomBytes(5).toString("hex")}`;
      reg.machineId = id;
      reg.token = `mt_${randomBytes(24).toString("base64url")}`;
      reg.ready = webcrypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]).then((key) =>
        void m.nodes.set(id, { id, user, name, platform: reg.platform, keyStorage: reg.keyStorage, attested: false, key, fingerprint, token: reg.token!, revoked: false, createdAt: new Date().toISOString(), lastBeat: null, beat: null, nonces: new Map() }),
      );
      return `téléphone ${name} inscrit`;
    });
    state.publish({ type: "approval.requested", approval: a });
    return send(202, { approval_id: a.id, key_fingerprint: fingerprint, expires_at: a.expires_at }), true;
  }
  const rm = /^\/v1\/link\/phone\/registrations\/([^/]+)$/.exec(path);
  if (rm && method === "GET") {
    const id = decodeURIComponent(rm[1]!);
    const reg = m.regs.get(id);
    const a = state.approvals.get(id);
    if (!reg || reg.user !== user || !a) return err(send, 404, "not_found");
    if (a.status === "pending") return Date.parse(a.expires_at) < Date.now() ? err(send, 410, "gone") : (send(202, { status: "pending" }), true);
    if (a.status === "rejected") return err(send, 403, "rejected");
    await reg.ready;
    if (!reg.machineId || !m.nodes.has(reg.machineId)) return send(202, { status: "pending" }), true;
    if (reg.claimed) return err(send, 410, "gone", "jeton déjà rendu");
    reg.claimed = true;
    // Le jeton ne sort que SCELLÉ pour la clé d'accord du nœud : la WebView ne voit qu'un blob opaque.
    const sealed_token = await sealToken(reg.encSpki, id, reg.token!, webcrypto as never);
    return send(201, { machine_id: reg.machineId, sealed_token, member: user, caps_allowed: CAPS_ALLOWED }), true;
  }
  const tm = /^\/v1\/link\/phone\/([^/]+)\/tasks$/.exec(path);
  if (tm && method === "GET") {
    const n = m.nodes.get(decodeURIComponent(tm[1]!));
    if (!n || n.user !== user) return err(send, 404, "not_found");
    expire(m);
    const tasks: PhoneTaskLog[] = [...m.tasks.values()].filter((t) => t.machine === n.id).reverse().slice(0, 200).map((t) => ({ task_id: t.id, op: t.op, origin: t.origin.kind, status: t.status, at: t.at, ...(t.op === "fetch.get" ? { host: hostOf(String(t.args.url ?? "")) } : {}) }));
    return send(200, { tasks }), true;
  }
  if (method === "GET" && path === "/v1/link/phone") {
    const phones = [...m.nodes.values()]
      .filter((n) => n.user === user && !n.revoked)
      .map((n) => ({ machine_id: n.id, name: n.name, platform: n.platform, key_storage: n.keyStorage, key_fingerprint: n.fingerprint, attested: n.attested, created_at: n.createdAt, last_beat_at: n.lastBeat ? new Date(n.lastBeat).toISOString() : null, live: n.lastBeat !== null && Date.now() - n.lastBeat < 180_000 }));
    return send(200, { phones }), true;
  }
  const rv = method === "POST" ? /^\/v1\/link\/machines\/([^/]+)\/revoke$/.exec(path) : null;
  if (rv) {
    const n = m.nodes.get(decodeURIComponent(rv[1]!));
    if (!n) return false; // pas un téléphone : la route de link.ts s'en charge
    if (n.user !== user || n.revoked) return err(send, 404, "not_found", "machine inconnue");
    n.revoked = true;
    for (const t of m.tasks.values()) if (t.machine === n.id && (t.status === "queued" || t.status === "leased")) t.status = "cancelled";
    wake(m, n.id);
    return send(200, { revoked: true }), true;
  }
  return false;
}

/** « Mes machines » (une seule liste, P7) : les téléphones du membre, `kind: "phone"`, sans passerelle. Un téléphone
 * non révoqué qui ne bat plus reste listé (vu il y a longtemps) pour qu'on le retire. */
export function phoneMachines(state: MockState, user: string): Array<{ machine_id: string; name: string; kind: "phone"; host: string; created_at: number; last_seen_at: number | null }> {
  return [...phoneMock(state).nodes.values()]
    .filter((n) => n.user === user && !n.revoked)
    .map((n) => ({ machine_id: n.id, name: n.name, kind: "phone" as const, host: "", created_at: Math.floor(Date.parse(n.createdAt) / 1000), last_seen_at: n.lastBeat ? Math.floor(n.lastBeat / 1000) : null }));
}

/** La carte d'inscription se décide sur un AUTRE appareil que celui qui l'a demandée (§3.2). */
export function phoneDecisionRefusal(state: MockState, approval: Approval, deviceId: string): string | null {
  if (approval.tool_name !== "phone_register") return null;
  const reg = phoneMock(state).regs.get(approval.id);
  return reg && reg.fromDevice && reg.fromDevice === deviceId ? "other_device_required" : null;
}

