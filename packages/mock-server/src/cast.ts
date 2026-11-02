/**
 * Showing something on a screen of the home — mock of core docs/SCREEN-CAST.md §7 (flag `local.cast.enabled`, off by
 * default like the core: option `cast` or `MOCK_CAST=1`). One `cast` bubble per `cast_id`; decisions are direct
 * (`POST /v1/bubbles/{id}/actions/{approve|refuse|stop}` → 200 `{cast: <state without html>}`), never a turn.
 * The first time on a screen asks for a go (`request.reason: "new_screen"`): nothing is shown before it.
 */
import type { Bubble, CastState } from "@nokker-apps/sdk";
import { createBubble, registerDirectAction, updateBubble } from "./bubbles.js";
import { hexId, MOCK_USER, type MockState } from "./state.js";

const SCREEN = { id: "scr_living", name: "Living room TV", room: "Living room", kind: "chromecast" as const, caps: ["page" as const, "image" as const], approved: false, personal: false };

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:16px system-ui,sans-serif;background:#0b0f14;color:#eef}
h1{font-size:20px;margin:16px}table{border-collapse:collapse;margin:0 16px}td,th{padding:6px 12px;border-bottom:1px solid #334;text-align:left}
</style></head><body><h1>Week plan (demo)</h1><table><tr><th>Day</th><th>Task</th></tr>
<tr><td>Mon</td><td>Invoice follow-ups</td></tr><tr><td>Tue</td><td>Docs deploy</td></tr><tr><td>Wed</td><td>[masked]</td></tr></table></body></html>`;

function withoutHtml(st: CastState): Omit<CastState, "html"> & { html?: never } {
  const { html: _h, ...rest } = st;
  void _h;
  return rest;
}

export function startCast(state: MockState, threadId: string): Bubble {
  const st: CastState = {
    cast_id: hexId("cast"),
    status: "pending",
    bubble_status: "idle",
    screen: { ...SCREEN, approved: state.castApproved },
    request: state.castApproved ? null : { id: hexId("cr"), reason: "new_screen" },
    view: { kind: "table", title: "Week plan" },
    html: PAGE,
    html_too_large: false,
    masked: 1,
    version: 1,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    error: null,
    actions: [
      { id: "approve", label: "Approve", primary: true },
      { id: "refuse", label: "Refuse" },
    ],
  };
  if (state.castApproved) {
    // An approved screen shows at once.
    st.status = "showing";
    st.bubble_status = "working";
    st.actions = [{ id: "stop", label: "Stop" }];
  }
  return createBubble(state, threadId, { kind: "cast", title: `On screen: ${st.view.title}`, status: st.bubble_status, created_by: MOCK_USER, state: st });
}

registerDirectAction("cast", (state, b, actionId) => {
  if (b.kind !== "cast") return null;
  const st = b.state;
  let patch: Partial<CastState> | null = null;
  if (st.status === "pending" && actionId === "approve") {
    state.castApproved = true;
    patch = { status: "showing", bubble_status: "working", request: null, screen: { ...st.screen, approved: true }, actions: [{ id: "stop", label: "Stop" }], version: st.version + 1 };
  } else if (st.status === "pending" && actionId === "refuse") {
    patch = { status: "refused", bubble_status: "failed", actions: [], version: st.version + 1 };
  } else if (st.status === "showing" && actionId === "stop") {
    patch = { status: "stopped", bubble_status: "done", actions: [], version: st.version + 1 };
  }
  if (!patch) return null;
  const status = patch.bubble_status!;
  updateBubble(state, b.id, { state: patch as Record<string, unknown>, status });
  const next = state.bubbles.get(b.id);
  return { cast: withoutHtml((next?.kind === "cast" ? next.state : { ...st, ...patch }) as CastState) };
});
