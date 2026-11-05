/**
 * Showing something on a screen of the home — mock of core docs/SCREEN-CAST.md §7 (flag `local.cast.enabled`, off by
 * default like the core: option `cast` or `MOCK_CAST=1`). One `cast` bubble per `cast_id`; decisions are direct
 * (`POST /v1/bubbles/{id}/actions/{approve|refuse|stop}` → 200 `{cast: <state without html>}`), never a turn.
 * The first time on a screen asks for a go (`request.reason: "new_screen"`): nothing is shown before it.
 */
import { createHmac, randomBytes } from "node:crypto";
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


// -- Cadre de l'aperçu (p2/cast-frame b48cc48) -------------------------------------------------------------------------
// POST /v1/cast/{cast_id}/frame-url (session) → {url, expires_at} (2 min) ; GET /v1/cast/{cast_id}/frame?exp=&sig= (sans
// jeton : la signature fait foi) → la page COURANTE de l'aperçu, avec sa propre CSP. `MOCK_CAST_FRAME=0` : noyau d'avant
// (404 sur frame-url, le web revient à srcdoc).
const FRAME_KEY = randomBytes(32);
const FRAME_TTL_MS = 2 * 60_000;
const frameSig = (castId: string, exp: number): string => createHmac("sha256", FRAME_KEY).update(`${castId}.${exp}`).digest("base64url");

function castOf(state: MockState, castId: string): CastState | null {
  for (const b of state.bubbles.values()) if (b.kind === "cast" && (b.state as CastState).cast_id === castId) return b.state as CastState;
  return null;
}

export function handleCastFrameUrl(state: MockState, method: string, path: string, send: (status: number, obj: unknown) => void): boolean {
  const m = /^\/v1\/cast\/([^/]+)\/frame-url$/.exec(path);
  if (!m || method !== "POST") return false;
  if (process.env.MOCK_CAST_FRAME === "0") return send(404, { error: { message: "not found" } }), true;
  const st = castOf(state, decodeURIComponent(m[1]!));
  if (!st) return send(404, { error: "not_found" }), true;
  if (st.html_too_large || !st.html) return send(413, { error: "html_too_large" }), true;
  const exp = Date.now() + FRAME_TTL_MS;
  send(200, { url: `/v1/cast/${encodeURIComponent(st.cast_id)}/frame?exp=${exp}&sig=${frameSig(st.cast_id, exp)}`, expires_at: new Date(exp).toISOString() });
  return true;
}

/** Public (l'iframe n'envoie pas de Bearer) : signature et expiration vérifiées ici. */
export function handleCastFrame(state: MockState, method: string, path: string, query: URLSearchParams, res: { writeHead: (s: number, h: Record<string, string>) => void; end: (b?: string) => void }): boolean {
  const m = /^\/v1\/cast\/([^/]+)\/frame$/.exec(path);
  if (!m || method !== "GET") return false;
  const castId = decodeURIComponent(m[1]!);
  const exp = Number(query.get("exp"));
  const sig = query.get("sig") ?? "";
  const st = castOf(state, castId);
  const ok = Number.isFinite(exp) && sig === frameSig(castId, exp);
  const status = !ok ? 403 : exp < Date.now() ? 410 : !st?.html ? 404 : 200;
  if (status !== 200) {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(String(status));
    return true;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: https:",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end(st!.html!);
  return true;
}
