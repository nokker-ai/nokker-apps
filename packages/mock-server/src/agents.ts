/**
 * Crew avec moteur (BUBBLES.md §9.5, lot X14, contrat provisoire du 25.10) — mock.
 *
 * Un passage simulé : queued → running (≈ 3 s) → succeeded, dans un fil à lui (un tour ordinaire), avec un coût de
 * démo. Un agent dont le nom contient « échec » échoue (pour voir le rouge). `arm` avec une règle `auto_approve`
 * d'écriture rend 202 `{approval_id}` et l'agent reste `paused` (le mock ne simule pas la carte forte).
 */
import { randomBytes } from "node:crypto";
import type { Agent, AgentRun, AgentTrigger, CreateAgentRequest } from "@nokker-apps/sdk";
import { hexId, type MockState } from "./state.js";
import { deckMachines } from "./link.js";

type Send = (status: number, payload: unknown) => void;

const runsByAgent = new WeakMap<MockState, Map<string, AgentRun[]>>();
function runsOf(state: MockState, id: string): AgentRun[] {
  let m = runsByAgent.get(state);
  if (!m) runsByAgent.set(state, (m = new Map()));
  let l = m.get(id);
  if (!l) m.set(id, (l = []));
  return l;
}

const WRITE_RULE = /^(write|patch|shell|mail_send|send|delete|rm|exec)/i;

function validTrigger(t: unknown): AgentTrigger | null {
  if (!t || typeof t !== "object") return null;
  const o = t as Record<string, unknown>;
  if (o.kind === "manual") return { kind: "manual" };
  if (o.kind === "schedule" && typeof o.cron === "string" && o.cron.trim()) return { kind: "schedule", cron: o.cron.trim(), tz: typeof o.tz === "string" ? o.tz : "UTC" };
  if (o.kind === "once" && typeof o.at === "string" && !Number.isNaN(Date.parse(o.at))) return { kind: "once", at: o.at };
  if (o.kind === "event" && typeof o.event === "string" && /^(alert|webhook):.+/.test(o.event)) return { kind: "event", event: o.event };
  return null;
}

/** Prochain passage : le mock ne lit pas le cron (le noyau le fera), il annonce « dans une heure ». */
function nextRun(t: AgentTrigger): string | null {
  if (t.kind === "once") return t.at;
  if (t.kind === "schedule") return new Date(Date.now() + 3600_000).toISOString();
  return null;
}

function touch(state: MockState, a: Agent, patch: Partial<Agent>): Agent {
  Object.assign(a, patch, { updated_at: new Date().toISOString() });
  state.publish({ type: "agent.updated", agent: structuredClone(a) });
  return a;
}

export function createAgentFull(state: MockState, req: CreateAgentRequest, user: string, origin: Agent["origin"] = null): Agent {
  const now = new Date().toISOString();
  const trigger = req.trigger ?? { kind: "manual" as const };
  const agent: Agent = {
    id: hexId("ag"),
    name: req.name,
    role: req.role,
    model: req.model ?? "",
    tools: req.tools ?? [],
    // « Ce que le code a tranché » : manuel SANS règle d'écriture → armé ; sinon au repos (armer = carte forte).
    status: trigger.kind === "manual" && !(req.auto_approve ?? []).some((r) => WRITE_RULE.test(r)) ? "armed" : "paused",
    arm_approval_id: null,
    project: null,
    created_by: user,
    created_at: now,
    updated_at: now,
    instructions: req.instructions ?? req.role,
    trigger,
    next_run_at: null,
    last_run: null,
    secrets: req.secrets ?? [],
    budget: req.budget ?? null,
    auto_approve: req.auto_approve ?? [],
    placement: null,
    ...(origin ? { origin } : {}),
  };
  state.agents.set(agent.id, agent);
  state.publish({ type: "agent.created", agent: structuredClone(agent) });
  return agent;
}

function publishRun(state: MockState, run: AgentRun): void {
  state.publish({ type: "agent.run", agent_id: run.agent_id, run: structuredClone(run) });
}

/** Le noyau refuse `mail:` (400 NO_MAIL_TRIGGER) : pas de déclencheur sur les mails reçus. */
const isMailTrigger = (t: unknown): boolean =>
  !!t && typeof t === "object" && (t as { kind?: unknown }).kind === "event" && typeof (t as { event?: unknown }).event === "string" && (t as { event: string }).event.startsWith("mail:");

const globRe = (g: string): RegExp => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

/** `AgentEngine.fire_event` : chaque agent armé dont le déclencheur couvre l'événement reçoit un passage. */
export function fireAgentEvent(state: MockState, event: string): AgentRun[] {
  const out: AgentRun[] = [];
  for (const a of state.agents.values()) {
    if (a.status !== "armed" || a.trigger?.kind !== "event" || !globRe(a.trigger.event).test(event)) continue;
    out.push(startRun(state, a, "event"));
  }
  return out;
}

function startRun(state: MockState, a: Agent, kind: AgentTrigger["kind"]): AgentRun {
  const now = new Date().toISOString();
  const thread = state.ensureThread(hexId("th"), `Passage — ${a.name}`);
  const runId = hexId("run");
  // §9.5 : le fil d'un passage porte son origine, le web le range sous l'agent (pas dans la liste des sessions).
  thread.thread.origin = { kind: "agent", agent_id: a.id, run_id: runId };
  state.publish({ type: "thread.updated", thread: { ...thread.thread } });
  const run: AgentRun = {
    run_id: runId,
    agent_id: a.id,
    trigger: kind,
    scheduled_for: null,
    started_at: now,
    ended_at: null,
    status: "running",
    thread_id: thread.thread.id,
    cost: null,
    summary: null,
  };
  runsOf(state, a.id).unshift(run);
  const before = a.status === "running" ? "armed" : a.status === "failed" ? "armed" : a.status;
  touch(state, a, { status: "running" });
  publishRun(state, run);
  state.later(3000, () => {
    if (run.status !== "running") return;
    const fails = /échec/i.test(a.name);
    run.status = fails ? "failed" : "succeeded";
    run.ended_at = new Date().toISOString();
    run.cost = { tokens_in: 4200, tokens_out: 610, amount: 0.012, currency: "EUR", calls: 3 };
    run.summary = fails ? "(démo) Échec : la source ne répond pas." : `(démo) Passage terminé : ${a.instructions ?? a.role}`;
    state.appendTurn(thread.thread.id, a.instructions ?? a.role, run.summary, { sender: null, channel: "agent", silent: true });
    publishRun(state, run);
    if (state.agents.has(a.id)) {
      touch(state, a, { status: fails ? "failed" : before, last_run: { run_id: run.run_id, status: run.status, ended_at: run.ended_at } });
    }
  });
  return run;
}

/** Démo du deck : quelques passages passés pour un agent. */
export function seedRuns(state: MockState, a: Agent, n: number, failedLast = false): void {
  const l = runsOf(state, a.id);
  for (let i = n; i >= 1; i--) {
    const end = new Date(Date.now() - i * 86_400_000).toISOString();
    const st = failedLast && i === 1 ? "failed" : "succeeded";
    l.unshift({
      run_id: hexId("run"),
      agent_id: a.id,
      trigger: a.trigger?.kind ?? "manual",
      scheduled_for: end,
      started_at: end,
      ended_at: end,
      status: st,
      thread_id: null,
      cost: { tokens_in: 3800, tokens_out: 540, amount: 0.011, currency: "EUR" },
      summary: st === "failed" ? "(démo) Échec : la source ne répond pas." : "(démo) Rien à signaler.",
    });
  }
  const last = l[0]!;
  a.last_run = { run_id: last.run_id, status: last.status, ended_at: last.ended_at };
}

export async function handleAgents(
  state: MockState,
  user: string,
  method: string,
  url: URL,
  readBody: () => Promise<Record<string, unknown>>,
  send: Send,
): Promise<boolean> {
  const path = url.pathname;
  if (method === "POST" && path === "/v1/agents") {
    const b = await readBody();
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const role = typeof b.role === "string" ? b.role.trim() : "";
    if (!name || !role) return send(400, { error: { message: "name et role requis" } }), true;
    if (isMailTrigger(b.trigger)) return send(400, { error: { code: "NO_MAIL_TRIGGER", message: "pas de déclencheur sur les mails reçus" } }), true;
    const trigger = b.trigger === undefined ? undefined : validTrigger(b.trigger);
    if (b.trigger !== undefined && !trigger) return send(400, { error: { message: "trigger invalide" } }), true;
    const req: CreateAgentRequest = {
      name,
      role,
      model: typeof b.model === "string" ? b.model : "",
      tools: Array.isArray(b.tools) ? b.tools.map(String) : [],
      instructions: typeof b.instructions === "string" ? b.instructions : undefined,
      trigger: trigger ?? undefined,
      secrets: Array.isArray(b.secrets) ? b.secrets.map(String) : [],
      auto_approve: Array.isArray(b.auto_approve) ? b.auto_approve.map(String) : [],
    };
    if (trigger?.kind === "event" && req.auto_approve!.some((r) => WRITE_RULE.test(r))) {
      return send(400, { error: { message: "écriture levée refusée pour un agent déclenché par événement" } }), true;
    }
    return send(201, createAgentFull(state, req, user)), true;
  }
  if (method === "GET" && path === "/v1/agents") {
    return send(200, [...state.agents.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))), true;
  }
  const m = /^\/v1\/agents\/([^/]+)(\/arm|\/disarm|\/run|\/runs|\/webhook-secret|\/move|\/runs\/([^/]+)\/cancel)?$/.exec(path);
  if (!m) return false;
  const a = state.agents.get(decodeURIComponent(m[1]!));
  if (!a) return send(404, { error: { message: "agent inconnu" } }), true;
  const tail = m[2] ?? "";

  if (tail === "" && method === "GET") return send(200, a), true;
  // X15 : déménagement. 409 + `missing` : ce qu'il faut poser à destination (démo : GPU, secrets, machine éteinte).
  if (tail === "/move" && method === "POST") {
    const b = await readBody();
    const to = typeof b.to === "string" ? b.to : "";
    if (a.status === "running") return send(409, { error: { message: "un passage est en cours", missing: [] } }), true;
    const machines = deckMachines(state, user);
    const missing: { kind: string; name?: string; machine_id?: string; message: string }[] = [];
    if (to === "web") {
      for (const s of a.secrets ?? []) missing.push({ kind: "secret", name: s, message: `secret « ${s} » : pas de coffre chez nokker.ai` });
      if (a.needs?.gpu) missing.push({ kind: "gpu", message: "pas de GPU chez nokker.ai" });
    } else if (to === "auto") {
      if (!machines.some((mc) => mc.online)) missing.push({ kind: "machine", message: "aucune machine en ligne" });
    } else if (to.startsWith("mc_")) {
      const mc = machines.find((x) => x.id === to);
      if (!mc) return send(400, { error: { message: "machine inconnue de ce compte" } }), true;
      if (!mc.online) missing.push({ kind: "machine", machine_id: mc.id, message: `« ${mc.name} » est hors ligne` });
      if (a.needs?.gpu && !mc.gpu) missing.push({ kind: "gpu", machine_id: mc.id, message: `pas de GPU sur « ${mc.name} »` });
    } else return send(400, { error: { message: "to : web, auto ou mc_…" } }), true;
    if (missing.length) return send(409, { error: { message: "déménagement impossible", missing } }), true;
    return send(200, touch(state, a, { placement: { machine: to } })), true;
  }
  if (tail === "/webhook-secret" && method === "POST") {
    if (a.trigger?.kind !== "event" || !a.trigger.event.startsWith("webhook:")) return send(400, { error: { message: "agent sans déclencheur webhook" } }), true;
    return send(200, { secret: `whk_${randomBytes(24).toString("base64url")}`, url: `/v1/hooks/${a.trigger.event.slice(8)}` }), true;
  }
  if (tail === "" && method === "PATCH") {
    const b = await readBody();
    const patch: Partial<Agent> = {};
    let resetsArm = false;
    for (const k of ["name", "role", "model", "instructions"] as const) if (typeof b[k] === "string") patch[k] = b[k] as string;
    if (b.trigger !== undefined) {
      if (isMailTrigger(b.trigger)) return send(400, { error: { code: "NO_MAIL_TRIGGER", message: "pas de déclencheur sur les mails reçus" } }), true;
      const t = validTrigger(b.trigger);
      if (!t) return send(400, { error: { message: "trigger invalide" } }), true;
      patch.trigger = t;
      resetsArm = true;
    }
    for (const k of ["tools", "secrets", "auto_approve"] as const) {
      if (Array.isArray(b[k])) {
        patch[k] = (b[k] as unknown[]).map(String);
        resetsArm = true;
      }
    }
    if (resetsArm && a.status === "armed") patch.status = "paused";
    if (patch.trigger || patch.status === "paused") patch.next_run_at = patch.status === "paused" ? null : a.next_run_at;
    return send(200, touch(state, a, patch)), true;
  }
  if (tail === "" && method === "DELETE") {
    for (const r of runsOf(state, a.id)) if (r.status === "running" || r.status === "queued") r.status = "cancelled";
    state.agents.delete(a.id);
    state.publish({ type: "agent.deleted", id: a.id });
    return send(204, null), true;
  }
  if (tail === "/arm" && method === "POST") {
    if ((a.auto_approve ?? []).some((r) => WRITE_RULE.test(r))) {
      // Un second `arm` pendant l'attente rend la même carte.
      if (!a.arm_approval_id) touch(state, a, { arm_approval_id: hexId("appr") });
      return send(202, { approval_id: a.arm_approval_id, agent: a }), true;
    }
    const t = a.trigger ?? { kind: "manual" as const };
    return send(200, touch(state, a, { status: a.status === "running" ? "running" : "armed", next_run_at: nextRun(t) })), true;
  }
  if (tail === "/disarm" && method === "POST") {
    return send(200, touch(state, a, { status: a.status === "running" ? "running" : "paused", next_run_at: null })), true;
  }
  if (tail === "/run" && method === "POST") {
    if (a.status === "running") return send(409, { error: { message: "un passage est déjà en cours" } }), true;
    return send(202, { run_id: startRun(state, a, "manual").run_id }), true;
  }
  if (tail === "/runs" && method === "GET") {
    const all = runsOf(state, a.id);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20));
    const before = url.searchParams.get("before");
    const start = before ? all.findIndex((r) => r.run_id === before) + 1 : 0;
    const page = all.slice(start, start + limit);
    const next = start + limit < all.length ? page.at(-1)!.run_id : null;
    return send(200, { runs: page, next_before: next }), true;
  }
  if (m[3] && method === "POST") {
    const r = runsOf(state, a.id).find((x) => x.run_id === decodeURIComponent(m[3]!));
    if (!r) return send(404, { error: { message: "passage inconnu" } }), true;
    if (r.status === "running" || r.status === "queued" || r.status === "waiting_approval") {
      r.status = "cancelled";
      r.ended_at = new Date().toISOString();
      publishRun(state, r);
      touch(state, a, { status: "armed", last_run: { run_id: r.run_id, status: r.status, ended_at: r.ended_at } });
    }
    return send(200, r), true;
  }
  return false;
}
