/**
 * « Maison » — the household's shared room with one avatar per agent (core docs/HOUSE-ROOM.md §6, flags `house_room` +
 * `household`; off → 404 on every route). Account session.
 *
 *   GET  /v1/house                                   → HouseView
 *   GET  /v1/house/messages?after=&before=&limit≤100 → {messages, cursor}  (no `after`: the latest; `after`: what follows)
 *   POST /v1/house/messages {text}                   → 202 {message, reply: null, agent} — the reply comes as `house.message`
 *        400 bad_text | 403 agent_forbidden | 403 member_suspended | 404 no_household | 429 rate (30 per minute)
 *   SSE  house.message {household_id, message} ; house.agent {household_id, agent, state: working | idle}
 *
 * Privacy: members are anonymised labels (« le payeur (adulte) », « membre B (ado, 13-17 ans) »); `adults` messages never
 * reach a minor (the core filters); `approvals` only on MY messages (my cards, decided with the existing routes).
 * The log is append-only: no route edits or deletes a message.
 */

export type HouseProfile = "adult" | "teen" | "child";
/** adult → strong, teen → act, child → read (core HOUSE-ROOM §4); `none`: no right on the house (read-only view). */
export type HouseRight = "none" | "read" | "act" | "strong";

export interface HouseAgent {
  slug: string;
  name: string;
  role: string;
  /** Name of the model tier (`ship` by default, maybe `deep` or `local`): a detail, not shown by the web. */
  tier: string;
  /** `false`: the agent answers with a fixed sentence, without a model. */
  available: boolean;
  /** This member may address it (`@slug`). */
  may_address: boolean;
  /** The agent that answers a message without a mention (`intendant`). */
  default: boolean;
  audience: "all" | "adults";
}

export interface HouseView {
  household_id: string;
  me: { handle: string; label: string; profile: HouseProfile; payer: boolean; right: HouseRight };
  agents: HouseAgent[];
}

export type HouseEventKind = "camera.incident" | "mail.arrived" | "memory.report" | "agenda.reminder" | "card.pending";

export interface HouseMessage {
  id: number | string;
  kind: "member" | "agent" | "event";
  text: string;
  /** Epoch seconds. */
  at: number;
  agent: string | null;
  /** Anonymised label of the member who wrote it, `null` for an agent or an event. */
  author: string | null;
  mine: boolean;
  audience: "all" | "adults";
  origin: { kind: "room" | "ask_house" | "event"; channel?: string; via?: string };
  reply_to: number | string | null;
  event: HouseEventKind | null;
  /** Only on my messages: my cards, decided with the existing approval routes. */
  approvals?: string[];
}

export interface HouseMessagesPage {
  messages: HouseMessage[];
  cursor: number | string | null;
}

export interface HousePostResult {
  message: HouseMessage;
  reply: null;
  agent: string;
}

export interface HouseMessageEvent {
  type: "house.message";
  household_id: string;
  message: HouseMessage;
}

export interface HouseAgentEvent {
  type: "house.agent";
  household_id: string;
  agent: string;
  state: "working" | "idle";
}

/** The agent a text addresses: the first `@slug` (or `@Name`) of a known agent this member may address, else the default. */
export function addressedAgent(text: string, agents: readonly HouseAgent[]): HouseAgent | null {
  const norm = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  for (const m of text.matchAll(/@([\p{L}\p{N}_-]+)/gu)) {
    const w = norm(m[1]!);
    const hit = agents.find((a) => norm(a.slug) === w || norm(a.name) === w);
    if (hit) return hit;
  }
  return agents.find((a) => a.default) ?? null;
}
