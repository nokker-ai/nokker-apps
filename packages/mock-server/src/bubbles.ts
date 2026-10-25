/**
 * Opérations sur les bulles (BUBBLES.md §2-§4 + §8, noyau p1/bubbles c4d04ff) au-dessus de `MockState`. Les
 * routes HTTP (`server.ts`) et le scénario de démo (`demo.ts`) passent tous deux par ici, pour que chaque
 * modification publie les mêmes événements que le noyau (`nokker/bubbles/hub.py`).
 */
import {
  renderBubbleForContext,
  type Agent,
  type Bubble,
  type BubbleAction,
  type BubbleActionResult,
  type BubbleKind,
  type BubbleStateByKind,
  type BubbleStatus,
  type CreateAgentRequest,
  type ShareRequest,
  type TransferMode,
  type TransferResult,
} from "@nokker-apps/sdk";
import { MockHttpError } from "./errors.js";
import { createAgentFull } from "./agents.js";
import { decideHandoff } from "./handoff.js";
import { decidePlanSplit } from "./ops.js";
import { KNOWN_USERS, MOCK_USER, hexId, type MockState } from "./state.js";

export { MockHttpError };

export interface NewBubble<K extends BubbleKind> {
  kind: K;
  title: string;
  state: BubbleStateByKind[K];
  status?: BubbleStatus;
  actions?: BubbleAction[];
  created_by?: string;
  shared_members?: string[];
}

export function createBubble<K extends BubbleKind>(state: MockState, threadId: string | null, spec: NewBubble<K>): Bubble {
  const now = new Date().toISOString();
  const bubble = {
    id: hexId("bu"),
    thread_id: threadId,
    kind: spec.kind,
    title: spec.title,
    status: spec.status ?? "idle",
    state: spec.state,
    actions: spec.actions ?? [],
    origin: null,
    shared_with: { members: spec.shared_members ?? [], threads: [] },
    created_by: spec.created_by ?? "nina",
    created_at: now,
    updated_at: now,
    closed_at: null,
    version: 1,
  } as Bubble;
  state.bubbles.set(bubble.id, bubble);
  state.publish({ type: "bubble.created", bubble: clone(bubble) });
  if (threadId) state.publishThread(threadId);
  return bubble;
}

/** 404 inconnue OU illisible (on ne révèle pas l'existence, §8). Mock mono-utilisateur : tout est lisible. */
export function getBubble(state: MockState, id: string): Bubble {
  const b = state.bubbles.get(id);
  if (!b) throw new MockHttpError(404, "bulle inconnue");
  return b;
}

export function updateBubble(
  state: MockState,
  id: string,
  patch: { title?: string; state?: Record<string, unknown>; status?: BubbleStatus; if_version?: number },
): Bubble {
  const b = getBubble(state, id);
  if (patch.if_version !== undefined && patch.if_version !== b.version) {
    throw new MockHttpError(409, `version ${b.version} ≠ if_version ${patch.if_version}`, { current_version: b.version });
  }
  if (patch.title !== undefined) b.title = patch.title;
  if (patch.state) b.state = { ...(b.state as object), ...patch.state } as unknown as Bubble["state"];
  if (patch.status !== undefined) b.status = patch.status;
  b.version += 1;
  b.updated_at = new Date().toISOString();
  state.publish({ type: "bubble.updated", bubble: clone(b) });
  return b;
}

export function closeBubble(state: MockState, id: string): Bubble {
  const b = getBubble(state, id);
  if (b.closed_at) return b;
  b.closed_at = new Date().toISOString();
  b.version += 1;
  b.updated_at = b.closed_at;
  state.publish({ type: "bubble.closed", bubble_id: b.id, thread_id: b.thread_id });
  if (b.thread_id) state.publishThread(b.thread_id);
  return b;
}

/** §3 + §8 — move (même id) ou copy (nouvelle bulle) ; le contexte va dans la BOÎTE du fil (prochain tour). */
export function transferBubble(state: MockState, id: string, toThread: string, mode: TransferMode, user: string = MOCK_USER): TransferResult {
  if (mode !== "move" && mode !== "copy") throw new MockHttpError(400, "mode ∈ move | copy");
  const b = getBubble(state, id);
  if (b.thread_id === null) throw new MockHttpError(400, "une notification sans fil ne se transfère pas");
  const from = state.requireMember(b.thread_id, user);
  const to = state.requireMember(toThread, user);
  if (to.thread.id === b.thread_id) throw new MockHttpError(400, "même fil");
  const fromThread = from.thread.id;
  const now = new Date().toISOString();

  let arrived: Bubble;
  if (mode === "move") {
    b.thread_id = toThread;
    b.origin = { thread_id: fromThread, bubble_id: b.id, mode: "move" };
    b.version += 1;
    b.updated_at = now;
    arrived = b;
  } else {
    arrived = {
      ...clone(b),
      id: hexId("bu"),
      thread_id: toThread,
      origin: { thread_id: fromThread, bubble_id: b.id, mode: "copy" },
      created_at: now,
      updated_at: now,
      version: 1,
    } as Bubble;
    delete arrived.shared;
    state.bubbles.set(arrived.id, arrived);
  }

  state.pushContext(toThread, renderBubbleForContext(arrived, from.thread.title));
  if (mode === "move") state.pushContext(fromThread, `[Bulle envoyée vers « ${to.thread.title} » — ${arrived.kind} « ${arrived.title} »]`);

  const data = { bubble_id: b.id, new_bubble_id: arrived.id, from_thread: fromThread, to_thread: toThread, mode };
  state.publish({ type: "bubble.transferred", ...data });
  state.publish(mode === "copy" ? { type: "bubble.created", bubble: clone(arrived) } : { type: "bubble.updated", bubble: clone(arrived) });
  state.publishThread(toThread);
  state.publishThread(fromThread);
  return { ...data, bubble: clone(arrived) };
}

/** §2 + §8 — remplace la liste de partage ; membres connus seulement ; fils dont l'appelant est membre. */
export function shareBubble(state: MockState, id: string, req: ShareRequest, user: string = MOCK_USER): Bubble {
  const b = getBubble(state, id);
  if (b.thread_id === null) throw new MockHttpError(400, "une notification ne se partage pas");
  const members = req.members ?? b.shared_with.members;
  const threads = req.threads ?? b.shared_with.threads;
  const unknown = members.filter((m) => !(KNOWN_USERS as readonly string[]).includes(m));
  if (unknown.length) throw new MockHttpError(400, `membre(s) inconnu(s) : ${unknown.join(", ")}`);
  for (const t of threads) state.requireMember(t, user);
  b.shared_with = { members: [...new Set(members)], threads: [...new Set(threads)].filter((t) => t !== b.thread_id) };
  b.version += 1;
  b.updated_at = new Date().toISOString();
  state.publish({ type: "bubble.updated", bubble: clone(b) });
  return b;
}

/** Bulles vues depuis un fil : les siennes + celles partagées avec lui (`shared: true`). */
export function bubblesForThread(state: MockState, threadId: string, includeClosed: boolean): Bubble[] {
  const out: Bubble[] = [];
  for (const b of state.bubbles.values()) {
    if (!includeClosed && b.closed_at) continue;
    if (b.thread_id === threadId) out.push(clone(b));
    else if (b.shared_with.threads.includes(threadId)) out.push({ ...clone(b), shared: true } as Bubble);
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * Tour lancé en tâche de fond dans un fil (noyau : `_run_background_turn`, canal `session`) : le fil travaille,
 * puis le tour est ajouté avec la réponse de `run` (appelé à la fin, il peut avoir des effets de bord : créer
 * une approbation, fermer une bulle…).
 */
export function backgroundTurn(
  state: MockState,
  threadId: string,
  input: string,
  run: () => string,
  opts: { sender?: string | null; channel?: string; delayMs?: number; onReply?: (reply: string) => void } = {},
): void {
  state.later(150, () => {
    state.setWorking(threadId, true);
    state.later(opts.delayMs ?? 1200, () => {
      const reply = run();
      state.appendTurn(threadId, input, reply, { sender: opts.sender ?? MOCK_USER, channel: opts.channel ?? "session" });
      state.setWorking(threadId, false);
      state.publishThread(threadId);
      opts.onReply?.(reply);
    });
  });
}

/** Effet d'une action non-notify, exécuté DANS le tour de fond ; renvoie la réponse du tour. */
export type ActionHandler = (state: MockState, bubble: Bubble) => string;
/** Effet de démo d'une action notify (le noyau se contente de fermer la notify). */
export type NotifyHandler = (state: MockState, bubble: Bubble) => void;

const handlers = new Map<string, ActionHandler>();
const notifyHandlers = new Map<string, NotifyHandler>();

/** Actions décidées EN DIRECT (200), sans tour : `null` = action inconnue (404). */
type DirectHandler = (state: MockState, b: Bubble, actionId: string) => Record<string, unknown> | null;
const directHandlers = new Map<string, DirectHandler>();
export function registerDirectAction(kind: string, handler: DirectHandler): void {
  directHandlers.set(kind, handler);
}

export function registerAction(key: string, handler: ActionHandler): void {
  handlers.set(key, handler);
}

export function registerNotifyAction(actionId: string, handler: NotifyHandler): void {
  notifyHandlers.set(actionId, handler);
}

/** §8 : notify → fermée, `{closed, goto}` (200) ; autre bulle → tour du fil, `{accepted, thread_id}` (202). */
export function runAction(state: MockState, id: string, actionId: string): { status: number; body: BubbleActionResult } {
  const b = getBubble(state, id);
  if (b.kind === "notify") {
    const known = new Set(["goto", ...b.state.actions.map((a) => a.id)]);
    if (!known.has(actionId)) throw new MockHttpError(404, `action inconnue : ${actionId}`);
    closeBubble(state, b.id);
    if (actionId !== "goto") notifyHandlers.get(actionId)?.(state, b);
    return { status: 200, body: { closed: true, goto: actionId === "goto" ? b.state.from_thread : null } };
  }
  if (b.kind === "agent_draft") {
    // §9.4 : seule `activate` est acceptée, exécutée EN DIRECT (200) — créer un agent armé n'a pas d'effet à
    // soumettre aux portes. La bulle est fermée, `agent.created` publié.
    if (actionId !== "activate") throw new MockHttpError(404, `action inconnue : ${actionId}`);
    // §9.5 : la carte porte aussi instructions, trigger, secrets, budget, auto_approve (facultatifs).
    const st = b.state as typeof b.state & Partial<CreateAgentRequest>;
    // §7.30 : une carte posée par un pack donne son origine à l'agent (retrait du pack → carte pack_agents).
    const origin = st.pack && st.template ? { pack: st.pack, template: st.template } : null;
    const agent = createAgent(state, { name: st.name, role: st.role, model: st.model, tools: st.tools, instructions: st.instructions, trigger: st.trigger, secrets: st.secrets, budget: st.budget, auto_approve: st.auto_approve }, MOCK_USER, origin);
    closeBubble(state, b.id);
    if (b.thread_id) state.appendTurn(b.thread_id, "", `Agent « ${agent.name} » créé et armé — il est dans l'onglet Crew.`, { sender: null, channel: "web" });
    return { status: 200, body: { activated: true, agent: clone(agent) } };
  }
  const direct = directHandlers.get(b.kind);
  if (direct) {
    const out = direct(state, b, actionId);
    if (!out) throw new MockHttpError(404, `action inconnue : ${actionId}`);
    return { status: 200, body: out as unknown as BubbleActionResult };
  }
  // X21 : décision de l'utilisateur sur un relais, en direct (200 `{handoff}`), jamais un tour.
  if (b.kind === "handoff") return decideHandoff(state, b, actionId) as unknown as { status: number; body: BubbleActionResult };
  // X18 : découpage proposé par le modèle ; seul l'humain crée les cartes, en direct (200 `{proposal, cards}`).
  if (b.kind === "plan_split") return decidePlanSplit(state, b, actionId) as unknown as { status: number; body: BubbleActionResult };
  const action = b.actions.find((a) => a.id === actionId);
  if (!action) throw new MockHttpError(404, `action inconnue : ${actionId}`);
  if (!b.thread_id) throw new MockHttpError(400, "bulle sans fil");
  const text = `[Action « ${action.label || actionId} » demandée sur la bulle « ${b.title} » (${b.id})]`;
  const handler = handlers.get(`${b.kind}:${actionId}`);
  backgroundTurn(state, b.thread_id, text, () => (handler ? handler(state, b) : `Action « ${action.label} » prise en compte (démo).`), {
    channel: "web",
    delayMs: 700,
  });
  return { status: 202, body: { accepted: true, thread_id: b.thread_id } };
}

/** Crée un agent du Crew (BUBBLES.md §9.4) : `status` toujours `armed`, `agent.created` diffusé à tous. */
/** §9.4/§9.5 : création d'agent (POST /v1/agents ou activation d'une carte `agent_draft`). */
export function createAgent(state: MockState, req: CreateAgentRequest, user: string, origin: Agent["origin"] = null): Agent {
  return createAgentFull(state, req, user, origin);
}

export function clone<T>(v: T): T {
  return structuredClone(v);
}
