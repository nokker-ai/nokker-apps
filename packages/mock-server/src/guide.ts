/**
 * Le Guide — mock of core docs/GUIDE.md (flag `guide`, off by default like the core: option `guide` or `MOCK_GUIDE=1`;
 * off → 404). Codes only, like the core: ids, statuses, `screen`, `ui` (only when `show_me` is on and the feature is
 * `on` or `setup`), `command`. A small fixed catalogue with a feature in every status. `ask` is deterministic: the
 * reply and the cited ids depend on keywords of the question; the words `quota` / `nomodel` give 429 / 503.
 */
import type { MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;
type Status = "on" | "setup" | "off" | "not_for_you";
interface Entry {
  id: string;
  status: Status;
  used: number;
  screen?: string;
  ui?: string;
  command?: string;
}

const CATALOG: Entry[] = [
  { id: "images", status: "on", used: 0, ui: "attach" },
  { id: "crew", status: "on", used: 0, screen: "crew" },
  { id: "goals", status: "on", used: 2, command: "/goal" },
  { id: "learning", status: "on", used: 1, screen: "learning" },
  { id: "bubbles", status: "on", used: 4, ui: "bubbles" },
  { id: "telegram", status: "setup", used: 0, screen: "account", ui: "account" },
  { id: "connectors", status: "setup", used: 0, screen: "connectors" },
  { id: "slack", status: "off", used: 0 },
  { id: "whatsapp", status: "off", used: 0 },
  { id: "household_minors", status: "not_for_you", used: 0 },
];
const INTRO = ["crew", "images", "telegram"];
const seen = new WeakMap<MockState, Set<string>>();

/** What the core would send: `screen`/`ui`/`command` only for `on` and `setup`, `ui` only with `show_me`. */
function shown(state: MockState, e: Entry): Omit<Entry, "used"> {
  const { used: _used, ...rest } = e;
  if (e.status === "off" || e.status === "not_for_you") return { id: e.id, status: e.status };
  const out: Omit<Entry, "used"> = { ...rest };
  if (!state.showMe) delete out.ui;
  return out;
}

const REPLIES: Array<[RegExp, string, string[]]> = [
  [/photo|image|joindre|attach/i, "Tu peux joindre une image avec le trombone, à gauche du champ du message.", ["images"]],
  [/slack|whatsapp/i, "Slack et WhatsApp ne sont pas disponibles sur cette installation.", ["slack", "whatsapp"]],
  [/telegram|mobile|phone/i, "Telegram se relie depuis ton compte : il te manque ce geste.", ["telegram"]],
];
const DEFAULT_REPLY: [RegExp, string, string[]] = [/./, "Je peux te montrer le Crew, pour des agents qui travaillent seuls, et les images jointes.", ["crew", "images"]];

export async function handleGuide(state: MockState, user: string, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  if (path !== "/v1/guide" && path !== "/v1/guide/intro" && path !== "/v1/guide/ask") return false;
  if (!state.guide) return send(404, { error: { code: "not_found", message: "not found" } }), true;
  const done = seen.get(state) ?? new Set<string>();
  seen.set(state, done);
  if (path === "/v1/guide") {
    if (method !== "GET") return send(405, { error: { code: "method_not_allowed", message: "GET only" } }), true;
    const next = CATALOG.find((e) => e.status === "on" && e.used === 0)?.id ?? null;
    return (
      send(200, {
        profile: "solo",
        show_me: state.showMe,
        features: CATALOG.map((e) => ({ ...shown(state, e), used: e.used })),
        intro: { seen: done.has(user), picks: INTRO },
        next,
        catalog_tokens: 1800,
      }),
      true
    );
  }
  if (method !== "POST") return send(405, { error: { code: "method_not_allowed", message: "POST only" } }), true;
  if (path === "/v1/guide/intro") {
    done.add(user);
    return send(200, { seen: true }), true;
  }
  const b = await readBody();
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text) return send(400, { error: { code: "empty", message: "empty question" } }), true;
  if (/nomodel/i.test(text)) return send(503, { error: { code: "guide_model_missing", message: "no model" } }), true;
  if (/quota/i.test(text)) return send(429, { error: { code: "guide_quota", message: "quota" } }), true;
  const [, reply, ids] = REPLIES.find(([re]) => re.test(text)) ?? DEFAULT_REPLY;
  const features = ids.map((id) => shown(state, CATALOG.find((e) => e.id === id)!));
  const first = features.find((f) => f.ui);
  return send(200, { reply, features, point: first ? { ui: first.ui, feature: first.id } : null }), true;
}
