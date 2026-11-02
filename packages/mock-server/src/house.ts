/**
 * « Maison » room — mock of core docs/HOUSE-ROOM.md §6 (flags `house_room` + `household`, off by default like the core:
 * option `houseRoom` or `MOCK_HOUSE_ROOM=1`; off → 404). One avatar per agent; a member's message gets a 202 and the
 * agent's answer comes later as `house.message`, framed by `house.agent` working → idle. Members are anonymised labels;
 * `adults` messages and the `courrier` agent never reach a minor (`MOCK_HOUSEHOLD=minor`). Append-only.
 */
import type { HouseAgent, HouseMessage, HouseView } from "@nokker-apps/sdk";
import { addressedAgent } from "@nokker-apps/sdk";
import { householdMinor } from "./household.js";
import type { MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;

const HOUSEHOLD_ID = "hh_demo";
const AGENTS: HouseAgent[] = [
  { slug: "intendant", name: "Intendant", role: "Answers the household and asks the others", tier: "ship", available: true, may_address: true, default: true, audience: "all" },
  { slug: "maison", name: "Maison", role: "Lights, heating, devices of the home", tier: "ship", available: true, may_address: true, default: false, audience: "all" },
  { slug: "courrier", name: "Courrier", role: "Mail and letters of the household", tier: "ship", available: true, may_address: true, default: false, audience: "adults" },
  { slug: "veille", name: "Veille", role: "Cameras and alarms", tier: "ship", available: true, may_address: true, default: false, audience: "all" },
  { slug: "agenda", name: "Agenda", role: "Calendar and reminders", tier: "ship", available: true, may_address: true, default: false, audience: "all" },
  { slug: "memoire", name: "Mémoire", role: "What the household asked to remember", tier: "ship", available: false, may_address: true, default: false, audience: "all" },
];

interface R {
  log: HouseMessage[];
  next: number;
  sent: number[];
  /** Who wrote each member message (server side only: the client sees labels and `mine`). */
  owner: Map<number | string, string>;
}
const all = new WeakMap<MockState, R>();
const now = (): number => Math.floor(Date.now() / 1000);

function room(state: MockState): R {
  let r = all.get(state);
  if (!r) {
    const t = now();
    const ev = (id: number, agent: string, event: HouseMessage["event"], text: string, ago: number, audience: "all" | "adults" = "all"): HouseMessage => ({
      id, kind: "event", text, at: t - ago, agent, author: null, mine: false, audience, origin: { kind: "event" }, reply_to: null, event,
    });
    r = {
      next: 6,
      sent: [],
      owner: new Map(),
      log: [
        ev(1, "memoire", "memory.report", "Last night: 3 notes merged, 1 left for you to review (demo).", 6 * 3600),
        ev(2, "courrier", "mail.arrived", "A letter from the tax office arrived (demo).", 3 * 3600, "adults"),
        { id: 3, kind: "member", text: "@agenda what is on tomorrow?", at: t - 2 * 3600, agent: null, author: "membre B (ado, 13-17 ans)", mine: false, audience: "all", origin: { kind: "room" }, reply_to: null, event: null },
        { id: 4, kind: "agent", text: "Tomorrow: dentist at 9:00, football at 17:30 (demo).", at: t - 2 * 3600 + 20, agent: "agenda", author: null, mine: false, audience: "all", origin: { kind: "room" }, reply_to: 3, event: null },
        ev(5, "agenda", "agenda.reminder", "Reminder: bins go out tonight (demo).", 1800),
      ],
    };
    all.set(state, r);
  }
  return r;
}

const minor = (state: MockState, user: string): boolean => householdMinor(state, user);
const visibleTo = (state: MockState, user: string) => (m: HouseMessage): boolean => !(minor(state, user) && m.audience === "adults");
const agentsFor = (state: MockState, user: string): HouseAgent[] => AGENTS.filter((a) => !(minor(state, user) && a.audience === "adults"));

function view(state: MockState, user: string): HouseView {
  const isMinor = minor(state, user);
  return {
    household_id: HOUSEHOLD_ID,
    me: isMinor
      ? { handle: "membre-b", label: "membre B (ado, 13-17 ans)", profile: "teen", payer: false, right: "act" }
      : { handle: "payeur", label: "le payeur (adulte)", profile: "adult", payer: true, right: "strong" },
    agents: agentsFor(state, user),
  };
}

function answerOf(agent: HouseAgent, text: string): string {
  if (!agent.available) return `${agent.name} is not available right now.`;
  const t = text.replace(/@[\p{L}\p{N}_-]+/gu, "").trim();
  return `${agent.name} (demo): noted — « ${t.slice(0, 80)} ».`;
}

const err = (send: Send, status: number, code: string, message: string): true => (send(status, { error: { code, message } }), true);

export async function handleHouse(state: MockState, user: string, method: string, url: URL, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  const path = url.pathname;
  if (path !== "/v1/house" && path !== "/v1/house/messages") return false;
  if (!state.houseRoom) return err(send, 404, "not_found", "not found");
  const r = room(state);
  if (path === "/v1/house" && method === "GET") return send(200, view(state, user)), true;
  if (method === "GET") {
    const lim = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 100);
    const after = url.searchParams.get("after");
    const before = url.searchParams.get("before");
    let l = r.log.filter(visibleTo(state, user));
    if (after) l = l.filter((m) => Number(m.id) > Number(after)).slice(0, lim);
    else {
      if (before) l = l.filter((m) => Number(m.id) < Number(before));
      l = l.slice(-lim);
    }
    const out = l.map((m) => ({ ...m, mine: r.owner.get(m.id) === user }));
    return send(200, { messages: out, cursor: out.length ? out[out.length - 1]!.id : (after ?? null) }), true;
  }
  if (method !== "POST") return false;
  const text = String((await readBody()).text ?? "").trim();
  if (!text || text.length > 2000) return err(send, 400, "bad_text", "text required (≤ 2000 characters)");
  const t = Date.now();
  r.sent = r.sent.filter((x) => t - x < 60_000);
  if (r.sent.length >= 30) return err(send, 429, "rate", "at most 30 messages per minute");
  const agent = addressedAgent(text, AGENTS);
  if (!agent || !agentsFor(state, user).some((a) => a.slug === agent.slug) || !agent.may_address) return err(send, 403, "agent_forbidden", "this agent is not for you");
  r.sent.push(t);
  const me = view(state, user).me;
  const message: HouseMessage = { id: r.next++, kind: "member", text, at: now(), agent: null, author: me.label, mine: true, audience: "all", origin: { kind: "room" }, reply_to: null, event: null };
  r.log.push(message);
  r.owner.set(message.id, user);
  state.publish({ type: "house.message", household_id: HOUSEHOLD_ID, message });
  state.later(300, () => state.publish({ type: "house.agent", household_id: HOUSEHOLD_ID, agent: agent.slug, state: "working" }));
  state.later(1200, () => {
    const reply: HouseMessage = { id: r.next++, kind: "agent", text: answerOf(agent, text), at: now(), agent: agent.slug, author: null, mine: false, audience: agent.audience, origin: { kind: "room" }, reply_to: message.id, event: null };
    r.log.push(reply);
    state.publish({ type: "house.message", household_id: HOUSEHOLD_ID, message: reply });
    state.publish({ type: "house.agent", household_id: HOUSEHOLD_ID, agent: agent.slug, state: "idle" });
  });
  return send(202, { message, reply: null, agent: agent.slug }), true;
}
