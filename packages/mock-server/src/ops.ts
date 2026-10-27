/**
 * Incidents et plan (X18, LOKKAL §7.18) — mock. Démo : une source « Prometheus (démo) », un incident vivant traité par
 * un agent, un incident en cours, un résolu ; un plan « Lancer la bêta publique » (objectif → lots → tâches).
 * `/v1/dev/ops-mock` (libre) : `{action: "alert", name, status?}` simule une alerte reçue, `{action: "split", thread_id,
 * card_id}` pose une bulle `plan_split`, `{action: "brief", thread_id}` une bulle `brief`.
 */
import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import type {
  AlertSource,
  Approval,
  BriefDelivery,
  Bubble,
  Incident,
  IncidentTimelineEntry,
  PlanCard,
  PlanCardDetail,
  PlanCardKind,
  PlanCardStatus,
  PlanChildProposal,
  PlanProposal,
} from "@nokker-apps/sdk";
import { createAgentFull, fireAgentEvent } from "./agents.js";
import { closeBubble, createBubble, updateBubble } from "./bubbles.js";
import { MockHttpError } from "./errors.js";
import { MOCK_USER, finalizeDecision, hexId, type MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;
const iso = (t = Date.now()): string => new Date(t).toISOString();
const hex = (p: string, n = 12): string => `${p}_${randomBytes(n / 2).toString("hex")}`;
const err = (send: Send, status: number, code: string, message: string): true => (send(status, { error: { code, message } }), true);

interface Src {
  s: AlertSource;
  key: string;
}
interface Inc {
  i: Incident;
  timeline: IncidentTimelineEntry[];
}
interface Card {
  id: string;
  parent_id: string | null;
  project: string | null;
  kind: PlanCardKind;
  title: string;
  intent: string;
  constraints: string[];
  decisions: string[];
  status: PlanCardStatus;
  agents: string[];
  threads: string[];
  position: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}
interface Ops {
  sources: Map<string, Src>;
  incidents: Map<string, Inc>;
  cards: Map<string, Card>;
  proposals: Map<string, PlanProposal>;
  brief: string | null;
  seen: Map<string, number>;
  /** Livraison du brief (§7.18.5) : choix de la personne ; démo : un chat Telegram relié, une boîte reliée. */
  delivery: { telegram: boolean; email: string | null; armed: string | null; approval: string | null; chats: number; sender: string | null; last: BriefDelivery["last"] };
}
const all = new WeakMap<MockState, Ops>();

function seed(): Ops {
  const o: Ops = { sources: new Map(), incidents: new Map(), cards: new Map(), proposals: new Map(), brief: null, seen: new Map(), delivery: { telegram: false, email: null, armed: null, approval: null, chats: 1, sender: `${MOCK_USER}@example.com`, last: null } };
  const sid = hex("as");
  o.sources.set(sid, {
    s: { id: sid, name: "Prometheus (demo)", format: "alertmanager", url: `/v1/alerts/${sid}`, created_by: MOCK_USER, created_at: iso(Date.now() - 86400_000 * 3), last_seen_at: iso(Date.now() - 600_000), has_secret: true, auth: "bearer" },
    key: "nkb_demo",
  });
  const src = { id: sid, name: "Prometheus (demo)" };
  const mk = (name: string, title: string, severity: string, state: Incident["state"], agoMin: number, extra: Partial<Incident> = {}, tl: IncidentTimelineEntry[] = []): void => {
    const id = hex("in", 16);
    const t0 = Date.now() - agoMin * 60_000;
    const timeline: IncidentTimelineEntry[] = [{ at: iso(t0), kind: "opened", text: `Alert “${name}” received from Prometheus (demo).` }, ...tl];
    o.incidents.set(id, {
      timeline,
      i: {
        id, source: src, fingerprint: createHash("sha256").update(name).digest("hex").slice(0, 16), name, title, severity, state,
        labels: { alertname: name, severity, instance: "web-1 (demo)" }, summary: title, occurrences: 1,
        first_seen_at: iso(t0), last_seen_at: iso(t0), started_at: iso(t0), resolved_at: null, resolved_by: null, acked_by: null,
        runs: [], created_at: iso(t0), updated_at: iso(t0), last_event: timeline.at(-1)!, ...extra,
      },
    });
  };
  mk("DiskAlmostFull", "Disk /var at 92% on web-1 (demo)", "warning", "in_progress", 14, { occurrences: 3, runs: [{ run_id: "run_demo_disk", agent_id: "ag_demo", agent: "Disk watcher", status: "waiting_approval", summary: null, thread_id: null, ended_at: null, approvals: [{ id: "ap_demo_disk", tool: "ssh_run", status: "pending", strength: "strong" }] }] }, [
    { at: iso(Date.now() - 13 * 60_000), kind: "agent_run", text: "“Disk watcher” starts: it reads the usage and the biggest folders.", run_id: "run_demo_disk" },
    { at: iso(Date.now() - 11 * 60_000), kind: "card", text: "Strong card posted: purge logs older than 14 days (ssh_run).", approval_id: "ap_demo_disk" },
  ]);
  mk("HighLatency", "API p95 latency above 800 ms (demo)", "critical", "open", 3, {}, [{ at: iso(Date.now() - 3 * 60_000 + 2000), kind: "no_agent", text: "No agent armed on “alert:HighLatency”." }]);
  mk("CertExpiring", "API certificate expiring in 7 days (demo)", "info", "resolved", 60 * 26, { resolved_at: iso(Date.now() - 3600_000 * 20), resolved_by: "source:Prometheus (demo)" }, [{ at: iso(Date.now() - 3600_000 * 20), kind: "resolved", text: "Resolved by the source." }]);

  const card = (title: string, parent: string | null, extra: Partial<Card> = {}): string => {
    const id = hex("pc");
    const depth = parent ? depthOf(o, parent) + 1 : 0;
    o.cards.set(id, { id, parent_id: parent, project: null, kind: (["goal", "milestone"][depth] ?? "task") as PlanCardKind, title, intent: "", constraints: [], decisions: [], status: "todo", agents: [], threads: [], position: o.cards.size, created_by: MOCK_USER, created_at: iso(Date.now() - 86400_000 * 2), updated_at: iso(Date.now() - 3600_000), ...extra });
    return id;
  };
  const g = card("Launch the public beta", null, { intent: "Open registrations to 50 testers before the end of the month.", constraints: ["No tester's data visible to another", "Payments in test mode only"], decisions: ["A single offer at launch"] });
  const m1 = card("Sign-up flow", g, { intent: "Invitation → terms → device → connectors." });
  card("Invitation email", m1, { status: "done" });
  card("Terms v2 reviewed", m1, { status: "done" });
  card("Telegram pairing", m1, { status: "in_progress" });
  const m2 = card("Account isolation", g, { constraints: ["Isolation suite green before every deployment"] });
  card("Isolation suite on prod", m2, { status: "done" });
  card("Review of shared logs", m2, { status: "blocked", intent: "Blocked: waiting for read access to the logs." });
  card("Pricing page", g);
  return o;
}
function ops(state: MockState): Ops {
  let o = all.get(state);
  if (!o) all.set(state, (o = seed()));
  return o;
}

function depthOf(o: Ops, id: string): number {
  let d = 0;
  for (let c = o.cards.get(id); c?.parent_id; c = o.cards.get(c.parent_id)) d++;
  return d;
}
const childrenOf = (o: Ops, id: string): Card[] => [...o.cards.values()].filter((c) => c.parent_id === id).sort((a, b) => a.position - b.position);

/** L'avancement remonte : une mère calcule son statut ; `progress` compte les feuilles. */
function cardJson(o: Ops, c: Card): PlanCard {
  const leaves: Card[] = [];
  const walk = (x: Card): void => {
    const ch = childrenOf(o, x.id);
    if (!ch.length) leaves.push(x);
    else ch.forEach(walk);
  };
  walk(c);
  const kids = childrenOf(o, c.id);
  const n = (s: PlanCardStatus): number => leaves.filter((l) => l.status === s).length;
  const progress = { done: n("done"), total: leaves.length, blocked: n("blocked"), in_progress: n("in_progress"), ratio: leaves.length ? n("done") / leaves.length : 0 };
  const status: PlanCardStatus = !kids.length ? c.status : progress.done === progress.total ? "done" : progress.blocked ? "blocked" : progress.done || progress.in_progress ? "in_progress" : "todo";
  return { ...c, status, computed: kids.length > 0, progress, children: kids.map((k) => k.id), depth: depthOf(o, c.id) };
}
function publishCard(state: MockState, o: Ops, id: string | null): void {
  for (let c = id ? o.cards.get(id) : undefined; c; c = c.parent_id ? o.cards.get(c.parent_id) : undefined) state.publish({ type: "plan.card.updated", card: cardJson(o, c) });
}
function contextOf(o: Ops, id: string): { chain: { id: string; kind: PlanCardKind; title: string }[]; block: string } {
  const chain: Card[] = [];
  for (let c = o.cards.get(id); c; c = c.parent_id ? o.cards.get(c.parent_id) : undefined) chain.unshift(c);
  const lines = chain.map((c) => {
    const parts = [`${c.kind === "goal" ? "Objectif" : c.kind === "milestone" ? "Lot" : "Tâche"} : ${c.title}`];
    if (c.intent) parts.push(`  But : ${c.intent}`);
    for (const k of c.constraints) parts.push(`  Contrainte : ${k}`);
    for (const k of c.decisions) parts.push(`  Décision : ${k}`);
    return parts.join("\n");
  });
  return { chain: chain.map((c) => ({ id: c.id, kind: c.kind, title: c.title })), block: `[Contexte du plan — ne pas contredire]\n${lines.join("\n")}\n[/Contexte du plan]`.slice(0, 6000) };
}

function incJson(x: Inc, withTimeline: boolean): Incident {
  const i = { ...x.i, last_event: x.timeline.at(-1) ?? null };
  return withTimeline ? { ...i, timeline: x.timeline.slice(-200) } : i;
}
function touchInc(state: MockState, x: Inc, patch: Partial<Incident>, entry?: IncidentTimelineEntry): void {
  if (entry) x.timeline.push(entry);
  Object.assign(x.i, patch, { updated_at: iso() });
  state.publish({ type: "incident.updated", incident: incJson(x, false) });
}

/** Alerte reçue (réception signée ou simulation) : regroupement par empreinte, agents armés sur `alert:<nom>`. */
function receive(state: MockState, o: Ops, src: Src, a: { name: string; status: "firing" | "resolved"; title?: string; severity?: string; fingerprint?: string }): { incident_id: string | null; name: string; result: string; runs?: string[] } {
  src.s.last_seen_at = iso();
  const fp = a.fingerprint ?? createHash("sha256").update(a.name).digest("hex").slice(0, 16);
  const live = [...o.incidents.values()].find((x) => x.i.source.id === src.s.id && x.i.fingerprint === fp && x.i.state !== "resolved");
  if (a.status === "resolved") {
    if (!live) return { incident_id: null, name: a.name, result: "ignored" };
    touchInc(state, live, { state: "resolved", resolved_at: iso(), resolved_by: `source:${src.s.name}` }, { at: iso(), kind: "resolved", text: "Resolved by the source." });
    return { incident_id: live.i.id, name: a.name, result: "resolved" };
  }
  if (live) {
    touchInc(state, live, { occurrences: live.i.occurrences + 1, last_seen_at: iso() });
    return { incident_id: live.i.id, name: a.name, result: "repeated" };
  }
  const id = hex("in", 16);
  const x: Inc = {
    timeline: [{ at: iso(), kind: "opened", text: `Alert “${a.name}” received from ${src.s.name}.` }],
    i: { id, source: { id: src.s.id, name: src.s.name }, fingerprint: fp, name: a.name, title: a.title ?? a.name, severity: a.severity ?? null, state: "open", labels: { alertname: a.name }, summary: a.title ?? "", occurrences: 1, first_seen_at: iso(), last_seen_at: iso(), started_at: iso(), resolved_at: null, resolved_by: null, acked_by: null, runs: [], created_at: iso(), updated_at: iso(), last_event: null },
  };
  o.incidents.set(id, x);
  const runs = fireAgentEvent(state, `alert:${a.name}`);
  if (!runs.length) touchInc(state, x, {}, { at: iso(), kind: "no_agent", text: `No agent armed on “alert:${a.name}”.` });
  else {
    const ag = (aid: string): string => state.agents.get(aid)?.name ?? aid;
    touchInc(state, x, { state: "in_progress", runs: runs.map((r) => ({ run_id: r.run_id, agent_id: r.agent_id, agent: ag(r.agent_id), status: r.status, summary: null, thread_id: r.thread_id, ended_at: null, approvals: [] })) }, { at: iso(), kind: "agent_run", text: `“${ag(runs[0]!.agent_id)}” starts.`, run_id: runs[0]!.run_id });
    state.later(3100, () => {
      const r = runs[0]!;
      touchInc(state, x, { runs: x.i.runs.map((y) => (y.run_id === r.run_id ? { ...y, status: r.status, summary: r.summary, ended_at: r.ended_at } : y)) }, { at: iso(), kind: "agent_run", text: r.summary ?? `Passage ${r.status}.`, run_id: r.run_id });
    });
  }
  return { incident_id: id, name: a.name, result: "opened", runs: runs.map((r) => r.run_id) };
}

function secretReply(src: Src): { source: AlertSource; secret: string; url: string; header: string; signature: string } {
  return src.s.auth === "bearer"
    ? { source: { ...src.s }, secret: src.key, url: src.s.url, header: "Authorization", signature: "Bearer <secret>" }
    : { source: { ...src.s }, secret: src.key, url: src.s.url, header: "X-Nokker-Signature", signature: 't=<epoch>,v1=<hex HMAC-SHA256(secret, "<t>." + corps brut)>' };
}

/** `POST /v1/alerts/{as_…}` : SANS session, signé (HMAC) ou Bearer selon la source. */
export async function handleAlertReceive(state: MockState, method: string, path: string, headers: Record<string, string | string[] | undefined>, rawBody: () => Promise<string>, send: Send): Promise<boolean> {
  const m = /^\/v1\/alerts\/(as_[0-9a-f]{12})$/.exec(path);
  if (!m || method !== "POST") return false;
  const o = ops(state);
  const src = o.sources.get(m[1]!);
  if (!src) return err(send, 404, "not_found", "source inconnue");
  const raw = await rawBody();
  const eq = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  if (src.s.auth === "bearer") {
    const h = String(headers.authorization ?? "");
    if (!h.startsWith("Bearer ") || !eq(h.slice(7), src.key)) return err(send, 401, "unauthorized", "jeton absent ou faux");
  } else {
    const sig = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(headers["x-nokker-signature"] ?? ""));
    if (!sig || Math.abs(Date.now() / 1000 - Number(sig[1])) > 300) return err(send, 401, "unauthorized", "signature absente ou hors délai");
    const want = createHmac("sha256", src.key).update(`${sig[1]}.${raw}`).digest("hex");
    if (!eq(want, sig[2]!)) return err(send, 401, "unauthorized", "signature fausse");
    if (o.seen.has(sig[0])) return err(send, 409, "replay", "signature déjà reçue");
    o.seen.set(sig[0], Date.now());
  }
  let body: { alerts?: unknown[] } & Record<string, unknown>;
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return err(send, 400, "bad_request", "corps illisible");
  }
  const list = (Array.isArray(body.alerts) ? body.alerts : [body]) as Record<string, unknown>[];
  const out = list.map((a) => {
    const labels = (a.labels ?? {}) as Record<string, string>;
    const ann = (a.annotations ?? {}) as Record<string, string>;
    const name = String(a.name ?? a.alertname ?? labels.alertname ?? "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64);
    if (!name) throw new MockHttpError(400, "alerte sans nom");
    return receive(state, o, src, { name, status: a.status === "resolved" ? "resolved" : "firing", title: String(a.title ?? ann.summary ?? name), severity: (a.severity ?? labels.severity) as string | undefined, fingerprint: a.fingerprint as string | undefined });
  });
  return send(202, { alerts: out }), true;
}

/** Bulle `plan_split` : décision de l'utilisateur, en direct (200 `{proposal, cards}`). */
export function decidePlanSplit(state: MockState, b: Bubble, actionId: string, user = MOCK_USER): { status: number; body: unknown } {
  const st = b.state as unknown as { proposal_id: string };
  if (actionId !== "accept" && actionId !== "refuse") throw new MockHttpError(404, `action inconnue : ${actionId}`);
  return { status: 200, body: decide(state, ops(state), st.proposal_id, actionId, user) };
}

function decide(state: MockState, o: Ops, pid: string, d: "accept" | "refuse", user: string): { proposal: PlanProposal; cards: PlanCard[] } {
  const p = o.proposals.get(pid);
  if (!p) throw new MockHttpError(404, "proposition inconnue");
  if (p.state !== "proposed") throw new MockHttpError(409, `proposition déjà ${p.state}`);
  const card = o.cards.get(p.card_id);
  const made: PlanCard[] = [];
  if (!card) p.state = "stale";
  else if (d === "refuse") p.state = "refused";
  else {
    p.state = "accepted";
    const depth = depthOf(o, card.id) + 1;
    for (const ch of p.children) {
      const id = hex("pc");
      o.cards.set(id, { id, parent_id: card.id, project: card.project, kind: ch.kind ?? ((["goal", "milestone"][depth] ?? "task") as PlanCardKind), title: ch.title, intent: ch.intent, constraints: ch.constraints, decisions: [], status: "todo", agents: [], threads: [], position: o.cards.size, created_by: user, created_at: iso(), updated_at: iso() });
      p.created.push(id);
      made.push(cardJson(o, o.cards.get(id)!));
    }
    publishCard(state, o, card.id);
  }
  p.decided_by = user;
  p.decided_at = iso();
  state.publish({ type: "plan.proposal.updated", proposal: { ...p } });
  if (p.bubble_id) {
    try {
      updateBubble(state, p.bubble_id, { state: { ...(state.bubbles.get(p.bubble_id)?.state as object), state: p.state, created: [...p.created] } as never, status: p.state === "accepted" ? "done" : "failed" });
      closeBubble(state, p.bubble_id);
    } catch {
      /* la bulle suit, la décision est rangée */
    }
  }
  return { proposal: { ...p }, cards: made };
}

export async function handleOpsDev(state: MockState, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  if (path !== "/v1/dev/ops-mock" || method !== "POST") return false;
  const o = ops(state);
  const b = await readBody();
  // Livraison du brief (§7.18.5) : `{delivery: {chats?, sender?, approve?}}` règle la démo ou signe la carte.
  if (b.delivery && typeof b.delivery === "object") {
    const d = b.delivery as { chats?: number; sender?: string | null; approve?: boolean };
    if (typeof d.chats === "number") o.delivery.chats = d.chats;
    if (d.sender !== undefined) o.delivery.sender = d.sender;
    const card = o.delivery.approval ? state.approvals.get(o.delivery.approval) : undefined;
    if (d.approve && card?.status === "pending") finalizeDecision(state, card, "approve", "webauthn");
    return send(200, deliveryView(state, o)), true;
  }
  if (b.action === "alert") {
    const src = [...o.sources.values()][0]!;
    return send(202, { alerts: [receive(state, o, src, { name: String(b.name ?? "DiskAlmostFull"), status: b.status === "resolved" ? "resolved" : "firing", title: typeof b.title === "string" ? b.title : undefined, severity: "warning" })] }), true;
  }
  // Sans `thread_id` : le premier fil de la démo (essai à la main).
  const threadId = typeof b.thread_id === "string" ? b.thread_id : ([...state.threads.keys()][0] ?? "");
  if (!state.threads.has(threadId)) return err(send, 404, "not_found", "fil inconnu");
  if (b.action === "split") {
    const card = o.cards.get(String(b.card_id ?? "")) ?? [...o.cards.values()].find((c) => !childrenOf(o, c.id).length)!;
    const children: PlanChildProposal[] = [
      { title: "Write the page text", kind: null, intent: "One offer, one final price.", constraints: [] },
      { title: "Review on mobile", kind: null, intent: "", constraints: ["No horizontal scrolling"] },
      { title: "Wire the button to the beta", kind: null, intent: "", constraints: [] },
    ];
    const p: PlanProposal = { id: hex("pp"), card_id: card.id, children, reason: "Three independent steps, each verifiable.", state: "proposed", proposed_by: "nina", thread_id: threadId, bubble_id: null, created: [], decided_by: null, decided_at: null, created_at: iso() };
    const bu = createBubble(state, threadId, {
      kind: "plan_split",
      title: `Split “${card.title}”`,
      status: "idle",
      actions: [
        { id: "accept", label: "Create these cards", primary: true },
        { id: "refuse", label: "No" },
      ],
      state: { proposal_id: p.id, card_id: card.id, card_title: card.title, children, reason: p.reason, state: "proposed" } as never,
    });
    p.bubble_id = bu.id;
    o.proposals.set(p.id, p);
    state.publish({ type: "plan.proposal.updated", proposal: { ...p } });
    return send(201, { proposal: p, bubble_id: bu.id }), true;
  }
  if (b.action === "brief") {
    const text = "**Goals**: Launch the public beta (3/5 tasks done).\n\n**Blocked**: Review of shared logs, waiting for read access.\n\n**Live incidents**: 2 (HighLatency open, DiskAlmostFull in progress).\n\n**Today**: no calendar connector, no appointment made up.";
    const bu = createBubble(state, threadId, { kind: "brief", title: `Brief du ${iso().slice(0, 10)}`, status: "done", state: { text, run_id: hexId("run"), agent_id: o.brief ?? "ag_brief", date: iso() } as never });
    return send(201, { bubble_id: bu.id }), true;
  }
  return err(send, 400, "bad_request", "action : alert | split | brief");
}

export async function handleOps(state: MockState, user: string, method: string, url: URL, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/v1/alerts/sources") && !path.startsWith("/v1/incidents") && !path.startsWith("/v1/plan/")) return false;
  const o = ops(state);

  // ── sources
  if (path === "/v1/alerts/sources") {
    if (method === "GET") return send(200, { sources: [...o.sources.values()].map((x) => ({ ...x.s })) }), true;
    if (method === "POST") {
      const b = await readBody();
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!/^[A-Za-z0-9 _.-]{1,64}$/.test(name)) return err(send, 400, "bad_request", "nom : 1 à 64 caractères [A-Za-z0-9 _.-]");
      if (b.format !== "alertmanager" && b.format !== "generic") return err(send, 400, "bad_request", "format : alertmanager | generic");
      if (o.sources.size >= 50) return err(send, 409, "too_many", "50 sources au plus");
      const auth = b.auth === "bearer" ? "bearer" : "hmac";
      const id = hex("as");
      const src: Src = { s: { id, name, format: b.format, url: `/v1/alerts/${id}`, created_by: user, created_at: iso(), last_seen_at: null, has_secret: true, auth }, key: auth === "bearer" ? `nkb_${randomBytes(32).toString("hex")}` : `whsec_${randomBytes(24).toString("hex")}` };
      o.sources.set(id, src);
      return send(201, secretReply(src)), true;
    }
  }
  const sm = /^\/v1\/alerts\/sources\/(as_[0-9a-f]{12})(\/secret)?$/.exec(path);
  if (sm) {
    const src = o.sources.get(sm[1]!);
    if (!src) return err(send, 404, "not_found", "source inconnue");
    if (sm[2] && method === "POST") {
      src.key = src.s.auth === "bearer" ? `nkb_${randomBytes(32).toString("hex")}` : `whsec_${randomBytes(24).toString("hex")}`;
      return send(200, secretReply(src)), true;
    }
    if (!sm[2] && method === "DELETE") return o.sources.delete(src.s.id), send(200, { deleted: true }), true;
  }

  // ── incidents
  if (path === "/v1/incidents" && method === "GET") {
    const st = url.searchParams.get("state");
    const lim = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
    const l = [...o.incidents.values()]
      .filter((x) => !st || (st === "live" ? x.i.state !== "resolved" : x.i.state === st))
      .sort((a, b) => b.i.last_seen_at.localeCompare(a.i.last_seen_at));
    return send(200, { incidents: l.slice(0, lim).map((x) => incJson(x, false)), next_before: l.length > lim ? l[lim - 1]!.i.id : null }), true;
  }
  const im = /^\/v1\/incidents\/(in_[0-9a-f]+)(\/ack|\/resolve)?$/.exec(path);
  if (im) {
    const x = o.incidents.get(im[1]!);
    if (!x) return err(send, 404, "not_found", "incident inconnu");
    if (!im[2] && method === "GET") return send(200, incJson(x, true)), true;
    if (method === "POST") {
      if (x.i.state === "resolved") return err(send, 409, "resolved", "incident déjà résolu");
      if (im[2] === "/ack") touchInc(state, x, { state: "in_progress", acked_by: user }, { at: iso(), kind: "acked", text: "Taken over.", by: user });
      else {
        const b = await readBody();
        const note = typeof b.note === "string" && b.note.trim() ? ` : ${b.note.trim().slice(0, 500)}` : "";
        touchInc(state, x, { state: "resolved", resolved_at: iso(), resolved_by: user }, { at: iso(), kind: "resolved", text: `Resolved by hand${note}`, by: user });
      }
      return send(200, incJson(x, true)), true;
    }
  }

  // ── plan
  if (path === "/v1/plan/cards") {
    if (method === "GET") {
      const pj = url.searchParams.get("project");
      const roots = url.searchParams.get("roots") === "1";
      const l = [...o.cards.values()].filter((c) => (!pj || c.project === pj) && (!roots || !c.parent_id)).sort((a, b) => a.position - b.position);
      return send(200, { cards: l.map((c) => cardJson(o, c)) }), true;
    }
    if (method === "POST") {
      const b = await readBody();
      const title = typeof b.title === "string" ? b.title.trim() : "";
      if (!title) return err(send, 400, "bad_request", "title requis");
      const parent = typeof b.parent_id === "string" ? o.cards.get(b.parent_id) : undefined;
      if (b.parent_id && !parent) return err(send, 404, "not_found", "carte mère inconnue");
      const depth = parent ? depthOf(o, parent.id) + 1 : 0;
      if (depth >= 6) return err(send, 400, "too_deep", "6 niveaux au plus");
      const id = hex("pc");
      o.cards.set(id, { id, parent_id: parent?.id ?? null, project: parent?.project ?? (typeof b.project === "string" ? b.project : null), kind: (b.kind as PlanCardKind) ?? ((["goal", "milestone"][depth] ?? "task") as PlanCardKind), title, intent: typeof b.intent === "string" ? b.intent : "", constraints: Array.isArray(b.constraints) ? b.constraints.map(String) : [], decisions: Array.isArray(b.decisions) ? b.decisions.map(String) : [], status: "todo", agents: [], threads: [], position: o.cards.size, created_by: user, created_at: iso(), updated_at: iso() });
      publishCard(state, o, id);
      return send(201, cardJson(o, o.cards.get(id)!)), true;
    }
  }
  const cm = /^\/v1\/plan\/cards\/(pc_[0-9a-f]{12})(?:\/(context|threads)(?:\/([^/]+))?)?$/.exec(path);
  if (cm) {
    const c = o.cards.get(cm[1]!);
    if (!c) return err(send, 404, "not_found", "carte inconnue");
    if (!cm[2]) {
      if (method === "GET") {
        const ctx = contextOf(o, c.id);
        const d: PlanCardDetail = { ...cardJson(o, c), ancestors: ctx.chain.slice(0, -1), children_cards: childrenOf(o, c.id).map((k) => cardJson(o, k)) };
        return send(200, d), true;
      }
      if (method === "PATCH") {
        const b = await readBody();
        if (b.status !== undefined && childrenOf(o, c.id).length) return err(send, 400, "computed", "statut calculé depuis les filles");
        if (b.status !== undefined && !["todo", "in_progress", "blocked", "done"].includes(String(b.status))) return err(send, 400, "bad_request", "status inconnu");
        for (const k of ["title", "intent", "status"] as const) if (typeof b[k] === "string") (c as unknown as Record<string, unknown>)[k] = k === "title" ? (b[k] as string).trim() || c.title : b[k];
        for (const k of ["constraints", "decisions"] as const) if (Array.isArray(b[k])) c[k] = (b[k] as unknown[]).map(String).filter(Boolean);
        c.updated_at = iso();
        publishCard(state, o, c.id);
        return send(200, cardJson(o, c)), true;
      }
      if (method === "DELETE") {
        const lifted = childrenOf(o, c.id).map((k) => ((k.parent_id = c.parent_id), k.id));
        o.cards.delete(c.id);
        for (const p of o.proposals.values()) if (p.card_id === c.id && p.state === "proposed") p.state = "stale";
        state.publish({ type: "plan.card.deleted", id: c.id, lifted });
        publishCard(state, o, c.parent_id);
        return send(200, { deleted: true, lifted }), true;
      }
    }
    if (cm[2] === "context" && method === "GET") return send(200, { card_id: c.id, ...contextOf(o, c.id) }), true;
    if (cm[2] === "threads") {
      if (method === "POST" && !cm[3]) {
        const b = await readBody();
        const tid = String(b.thread_id ?? "");
        if (!state.threads.has(tid)) return err(send, 403, "forbidden", "fil d'un autre ou inconnu");
        for (const k of o.cards.values()) k.threads = k.threads.filter((t) => t !== tid); // un fil, une carte
        c.threads.push(tid);
        publishCard(state, o, c.id);
        return send(200, cardJson(o, c)), true;
      }
      if (method === "DELETE" && cm[3]) {
        c.threads = c.threads.filter((t) => t !== decodeURIComponent(cm[3]!));
        publishCard(state, o, c.id);
        return send(200, cardJson(o, c)), true;
      }
    }
  }
  if (path === "/v1/plan/proposals" && method === "GET") {
    const cid = url.searchParams.get("card_id");
    const st = url.searchParams.get("state");
    return send(200, { proposals: [...o.proposals.values()].filter((p) => (!cid || p.card_id === cid) && (!st || p.state === st)).reverse() }), true;
  }
  const pm = /^\/v1\/plan\/proposals\/(pp_[0-9a-f]{12})\/(accept|refuse)$/.exec(path);
  if (pm && method === "POST") return send(200, decide(state, o, pm[1]!, pm[2] as "accept" | "refuse", user)), true;
  if (path === "/v1/plan/brief/delivery") {
    if (method === "GET") return send(200, deliveryView(state, o)), true;
    if (method === "PUT") {
      const b = await readBody();
      const d = o.delivery;
      const unknown = Object.keys(b).filter((k) => k !== "telegram" && k !== "email");
      if (unknown.length) return err(send, 400, "invalid", `livraison : clé inconnue ${unknown.sort()[0]} (telegram, email)`);
      if ("telegram" in b) {
        if (typeof b.telegram !== "boolean") return err(send, 400, "invalid", "telegram : true | false");
        if (b.telegram && !d.chats) return err(send, 409, "no_telegram", "aucun Telegram relié à ce compte : relie-le d'abord (/start <code>)");
        d.telegram = b.telegram;
      }
      if ("email" in b) {
        const pendingCard = d.approval ? state.approvals.get(d.approval) : undefined;
        const drop = (): void => {
          if (pendingCard?.status === "pending") pendingCard.status = "failed";
          d.approval = null;
        };
        if (b.email === null || b.email === "") {
          drop();
          Object.assign(d, { email: null, armed: null });
        } else {
          const to = String(b.email).trim();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return err(send, 400, "invalid", "email : une adresse e-mail");
          if (!d.sender) return err(send, 409, "no_mail_connector", "aucune boîte mail reliée à ce compte : relie le connecteur mail d'abord");
          const fp = createHash("sha256").update(`${user}|${to}|${d.sender}`).digest("hex");
          const same = (d.email ?? "").toLowerCase() === to.toLowerCase();
          if (!(same && (d.armed === fp || pendingCard?.status === "pending"))) {
            drop();
            Object.assign(d, { email: to, armed: null });
            d.approval = deliveryCard(state, o, user, to, d.sender, fp);
          }
        }
      }
      return send(200, deliveryView(state, o)), true;
    }
  }
  if (path === "/v1/plan/brief") {
    const cur = o.brief ? state.agents.get(o.brief) ?? null : null;
    if (method === "GET") return send(200, { agent: cur ? structuredClone(cur) : null }), true;
    if (method === "POST") {
      const b = await readBody();
      const cron = typeof b.cron === "string" && b.cron.trim() ? b.cron.trim() : "30 7 * * 1-5";
      const tz = typeof b.tz === "string" && b.tz.trim() ? b.tz.trim() : "Europe/Zurich";
      if (cur) {
        cur.trigger = { kind: "schedule", cron, tz };
        cur.updated_at = iso();
        state.publish({ type: "agent.updated", agent: structuredClone(cur) });
        return send(200, { agent: structuredClone(cur) }), true;
      }
      const a = createAgentFull(state, { name: "Brief du matin", role: "Résume le plan, les incidents vivants et l'agenda du jour.", tools: ["plan_brief"], trigger: { kind: "schedule", cron, tz } }, user);
      a.status = "armed"; // le POST est la décision : aucune écriture
      o.brief = a.id;
      state.publish({ type: "agent.updated", agent: structuredClone(a) });
      return send(201, { agent: structuredClone(a) }), true;
    }
    if (method === "DELETE") {
      if (!cur) return send(200, { deleted: false }), true;
      state.agents.delete(cur.id);
      o.brief = null;
      state.publish({ type: "agent.deleted", id: cur.id });
      return send(200, { deleted: true }), true;
    }
  }
  return err(send, 404, "not_found", "route inconnue");
}

/** Carte forte `brief_delivery_arm` : signée, la livraison par e-mail est armée sur cette empreinte (geste du noyau). */
function deliveryCard(state: MockState, o: Ops, owner: string, to: string, from: string, fingerprint: string): string {
  const args = { owner, to, from, fingerprint };
  const a: Approval = {
    id: hexId("appr"),
    thread_id: "",
    turn_index: 0,
    channel: "web",
    tool_name: "brief_delivery_arm",
    arguments: args,
    args_sha256: createHash("sha256").update(JSON.stringify(args)).digest("hex"),
    effect: "external",
    rule: "brief:mail_delivery",
    reason: `send the morning brief to ${to} every morning, from your mailbox ${from} (this brief only, to this address only)`,
    advice: null,
    strength: "strong",
    status: "pending",
    created_at: iso(),
    expires_at: iso(Date.now() + 24 * 3600_000),
    decided_by: null,
    decided_via: null,
    decided_at: null,
    result_summary: null,
    error: null,
  };
  state.approvals.set(a.id, a);
  state.approvalEffects.set(a.id, () => {
    if (o.delivery.approval === a.id) o.delivery.approval = null;
    if (o.delivery.email === to) o.delivery.armed = fingerprint;
    return `brief delivery armed for ${to}`;
  });
  state.publish({ type: "approval.requested", approval: a });
  return a.id;
}

function deliveryView(state: MockState, o: Ops): BriefDelivery {
  const d = o.delivery;
  const card = d.approval ? state.approvals.get(d.approval) : undefined;
  const fp = d.email && d.sender ? createHash("sha256").update(`${MOCK_USER}|${d.email}|${d.sender}`).digest("hex") : null;
  const st: BriefDelivery["email"]["state"] = !d.email ? "off" : d.armed && d.armed === fp ? "armed" : card?.status === "pending" ? "pending" : "not_armed";
  return { telegram: { enabled: d.telegram, chats: d.chats }, email: { address: d.email, from: d.sender, state: st, approval_id: st === "pending" ? d.approval : null }, last: d.last };
}
