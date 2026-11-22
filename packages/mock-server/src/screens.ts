/**
 * Screens for the wall — mock of core docs/SCREENS.md (lot V7, flag `ambient.screens.enabled`, off by default like the
 * core: option `screens` or `MOCK_SCREENS=1`). One `screen` bubble per screen; `publish` lays a STRONG card
 * `wall_publish` (rule `wall:publish`) and nothing reaches the wall before it is approved; `unpublish` is direct.
 * The HTML below is the REAL core output (nokker p2/v-screen, render.py) for a two-column screen: preview (no household
 * data) and wall (with the next event, after the wall filter).
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Approval, Bubble, ScreenState } from "@nokker-apps/sdk";
import { createBubble, registerDirectAction, updateBubble } from "./bubbles.js";
import { finalizeDecision, hexId, LOCAL_OWNER, MOCK_USER, randomId, type MockState } from "./state.js";

export const SCREEN_PREVIEW_HTML = "<!doctype html><html lang=\"fr\" data-theme=\"dark\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src &#x27;none&#x27;; style-src &#x27;sha256-fgkJt7xaHylAG0/6Mm+7nM+pc1Dp/15DWdFLjAzkCW8=&#x27;; font-src &#x27;self&#x27;; base-uri &#x27;none&#x27;; form-action &#x27;none&#x27;\"><title>Kitchen</title><style>@font-face{font-family:\"Cinzel\";font-style:normal;font-weight:600;font-display:swap;src:url(/v1/screens/fonts/cinzel-latin-600-normal.woff2) format(\"woff2\");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2212}@font-face{font-family:\"Cinzel\";font-style:normal;font-weight:600;font-display:swap;src:url(/v1/screens/fonts/cinzel-latin-ext-600-normal.woff2) format(\"woff2\");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1E00-1E9F,U+20A0-20C0,U+A720-A7FF}@font-face{font-family:\"IBM Plex Sans\";font-style:normal;font-weight:400;font-display:swap;src:url(/v1/screens/fonts/ibm-plex-sans-latin-400-normal.woff2) format(\"woff2\");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2212}@font-face{font-family:\"IBM Plex Sans\";font-style:normal;font-weight:400;font-display:swap;src:url(/v1/screens/fonts/ibm-plex-sans-latin-ext-400-normal.woff2) format(\"woff2\");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1E00-1E9F,U+20A0-20C0,U+A720-A7FF}@font-face{font-family:\"IBM Plex Sans\";font-style:normal;font-weight:600;font-display:swap;src:url(/v1/screens/fonts/ibm-plex-sans-latin-600-normal.woff2) format(\"woff2\");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2212}@font-face{font-family:\"IBM Plex Sans\";font-style:normal;font-weight:600;font-display:swap;src:url(/v1/screens/fonts/ibm-plex-sans-latin-ext-600-normal.woff2) format(\"woff2\");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1E00-1E9F,U+20A0-20C0,U+A720-A7FF}\n:root{--bg:#0A0D14;--card:rgba(20,24,34,.78);--text:#EEF1F6;--muted:#AEB6C4;--accent:#FF7A6D;--ember:#E2474F;\n--line:rgba(255,122,109,.22);--done:#8E97A8;--glow1:rgba(255,111,97,.20);--glow2:rgba(226,71,79,.14);\n--grain:rgba(255,255,255,.025);--brand:\"Cinzel\",\"Times New Roman\",serif;\n--font:\"IBM Plex Sans\",\"Segoe UI\",system-ui,sans-serif}\n[data-theme=light]{--bg:#F4F2EE;--card:rgba(255,255,255,.82);--text:#1C1F24;--muted:#4A5260;--accent:#B52A33;\n--ember:#C8313A;--line:rgba(200,49,58,.20);--done:#5B6472;--glow1:rgba(226,71,79,.13);--glow2:rgba(255,166,120,.16);\n--grain:rgba(0,0,0,.022)}\n*{box-sizing:border-box}\nhtml,body{overflow-x:clip;margin:0}\nbody{min-height:100vh;color:var(--text);font-family:var(--font);font-size:clamp(20px,2.45vmax,46px);line-height:1.35;\nbackground:radial-gradient(60vw 70vh at 88% 0%,var(--glow1),transparent 70%),\nradial-gradient(55vw 60vh at 0% 100%,var(--glow2),transparent 72%),\nrepeating-linear-gradient(0deg,var(--grain) 0 1px,transparent 1px 3px),var(--bg)}\nmain{min-height:100vh;max-width:2400px;margin:0 auto;padding:5vh 4vw;display:grid;gap:3vw;align-content:start}\nmain.hero{grid-template-columns:minmax(0,.9fr) minmax(0,1.7fr)}\nh1{font-family:var(--brand);font-weight:600;font-size:1.45em;line-height:1.1;margin:0 0 .5em;overflow-wrap:break-word;min-width:0}\nh2{font-family:var(--brand);font-weight:600;font-size:1.1em;margin:0 0 .4em;overflow-wrap:break-word;min-width:0}\nh3{font-weight:600;font-size:.82em;color:var(--accent);margin:0 0 .45em}\np{margin:0 0 .5em;max-width:40em}\n.side{display:flex;flex-direction:column;gap:1.2em;min-width:0}\n.clock .t{font-family:var(--brand);font-weight:600;font-size:min(4em,11vw);line-height:1;white-space:nowrap}\n.clock .d{color:var(--muted);margin-top:.25em}\n.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,12em),1fr));gap:1.1em;align-content:start;align-items:start}\n.card{background:var(--card);border:1px solid var(--line);border-radius:.75em;padding:.85em 1em;min-width:0}\n.ev{border-left:.22em solid var(--ember)}\n.ev .w{color:var(--muted);margin:0}\n.ev .what{font-weight:600;margin:0 0 .15em}\nul{margin:0;padding:0;list-style:none}\nli{padding:.28em 0;border-bottom:1px solid var(--line);display:flex;gap:.55em;align-items:baseline}\nli:last-child{border-bottom:0}\nli .dot{flex:none;width:.42em;height:.42em;border-radius:50%;background:var(--accent);transform:translateY(-.12em)}\nli .box{flex:none;width:.85em;height:.85em;border:2px solid var(--accent);border-radius:.22em;transform:translateY(.08em)}\nli.done{color:var(--done);text-decoration:line-through}\nli.done .box{background:var(--accent)}\n.stat .v{font-family:var(--brand);font-weight:600;font-size:2.1em;color:var(--accent);line-height:1.05}\n.stat .l{color:var(--muted)}\n.note{border-left:.22em solid var(--accent)}\n.card p.note{padding-left:.6em;margin:.45em 0 0}\n.note.warn{border-left-color:var(--ember);font-weight:600}\nhr{border:0;border-top:1px solid var(--line);margin:.6em 0}\n@media (max-width:820px),(orientation:portrait){main.hero{grid-template-columns:minmax(0,1fr)}}</style></head><body><main class=\"hero\"><div class=\"side\"><h1>Kitchen</h1><div class=\"clock\"><div class=\"t\">07:30</div><div class=\"d\">lundi 9 novembre</div></div><div class=\"card ev\"><h3>Prochain rendez-vous</h3><p class=\"w\">Sur le mur : votre prochain rendez-vous.</p></div></div><div class=\"cards\"><div class=\"card\"><h3>Groceries</h3><ul><li class=\"done\"><span class=\"box\"></span><span>bread</span></li><li class=\"todo\"><span class=\"box\"></span><span>milk</span></li><li class=\"todo\"><span class=\"box\"></span><span>eggs</span></li></ul></div></div></main></body></html>";
export const SCREEN_WALL_HTML = "<!doctype html><html lang=\"fr\" data-theme=\"dark\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src &#x27;none&#x27;; style-src &#x27;sha256-fgkJt7xaHylAG0/6Mm+7nM+pc1Dp/15DWdFLjAzkCW8=&#x27;; font-src &#x27;self&#x27;; base-uri &#x27;none&#x27;; form-action &#x27;none&#x27;\"><title>Kitchen</title><style>@font-face{font-family:\"Cinzel\";font-style:normal;font-weight:600;font-display:swap;src:url(/v1/screens/fonts/cinzel-latin-600-normal.woff2) format(\"woff2\");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2212}@font-face{font-family:\"Cinzel\";font-style:normal;font-weight:600;font-display:swap;src:url(/v1/screens/fonts/cinzel-latin-ext-600-normal.woff2) format(\"woff2\");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1E00-1E9F,U+20A0-20C0,U+A720-A7FF}@font-face{font-family:\"IBM Plex Sans\";font-style:normal;font-weight:400;font-display:swap;src:url(/v1/screens/fonts/ibm-plex-sans-latin-400-normal.woff2) format(\"woff2\");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2212}@font-face{font-family:\"IBM Plex Sans\";font-style:normal;font-weight:400;font-display:swap;src:url(/v1/screens/fonts/ibm-plex-sans-latin-ext-400-normal.woff2) format(\"woff2\");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1E00-1E9F,U+20A0-20C0,U+A720-A7FF}@font-face{font-family:\"IBM Plex Sans\";font-style:normal;font-weight:600;font-display:swap;src:url(/v1/screens/fonts/ibm-plex-sans-latin-600-normal.woff2) format(\"woff2\");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2212}@font-face{font-family:\"IBM Plex Sans\";font-style:normal;font-weight:600;font-display:swap;src:url(/v1/screens/fonts/ibm-plex-sans-latin-ext-600-normal.woff2) format(\"woff2\");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1E00-1E9F,U+20A0-20C0,U+A720-A7FF}\n:root{--bg:#0A0D14;--card:rgba(20,24,34,.78);--text:#EEF1F6;--muted:#AEB6C4;--accent:#FF7A6D;--ember:#E2474F;\n--line:rgba(255,122,109,.22);--done:#8E97A8;--glow1:rgba(255,111,97,.20);--glow2:rgba(226,71,79,.14);\n--grain:rgba(255,255,255,.025);--brand:\"Cinzel\",\"Times New Roman\",serif;\n--font:\"IBM Plex Sans\",\"Segoe UI\",system-ui,sans-serif}\n[data-theme=light]{--bg:#F4F2EE;--card:rgba(255,255,255,.82);--text:#1C1F24;--muted:#4A5260;--accent:#B52A33;\n--ember:#C8313A;--line:rgba(200,49,58,.20);--done:#5B6472;--glow1:rgba(226,71,79,.13);--glow2:rgba(255,166,120,.16);\n--grain:rgba(0,0,0,.022)}\n*{box-sizing:border-box}\nhtml,body{overflow-x:clip;margin:0}\nbody{min-height:100vh;color:var(--text);font-family:var(--font);font-size:clamp(20px,2.45vmax,46px);line-height:1.35;\nbackground:radial-gradient(60vw 70vh at 88% 0%,var(--glow1),transparent 70%),\nradial-gradient(55vw 60vh at 0% 100%,var(--glow2),transparent 72%),\nrepeating-linear-gradient(0deg,var(--grain) 0 1px,transparent 1px 3px),var(--bg)}\nmain{min-height:100vh;max-width:2400px;margin:0 auto;padding:5vh 4vw;display:grid;gap:3vw;align-content:start}\nmain.hero{grid-template-columns:minmax(0,.9fr) minmax(0,1.7fr)}\nh1{font-family:var(--brand);font-weight:600;font-size:1.45em;line-height:1.1;margin:0 0 .5em;overflow-wrap:break-word;min-width:0}\nh2{font-family:var(--brand);font-weight:600;font-size:1.1em;margin:0 0 .4em;overflow-wrap:break-word;min-width:0}\nh3{font-weight:600;font-size:.82em;color:var(--accent);margin:0 0 .45em}\np{margin:0 0 .5em;max-width:40em}\n.side{display:flex;flex-direction:column;gap:1.2em;min-width:0}\n.clock .t{font-family:var(--brand);font-weight:600;font-size:min(4em,11vw);line-height:1;white-space:nowrap}\n.clock .d{color:var(--muted);margin-top:.25em}\n.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,12em),1fr));gap:1.1em;align-content:start;align-items:start}\n.card{background:var(--card);border:1px solid var(--line);border-radius:.75em;padding:.85em 1em;min-width:0}\n.ev{border-left:.22em solid var(--ember)}\n.ev .w{color:var(--muted);margin:0}\n.ev .what{font-weight:600;margin:0 0 .15em}\nul{margin:0;padding:0;list-style:none}\nli{padding:.28em 0;border-bottom:1px solid var(--line);display:flex;gap:.55em;align-items:baseline}\nli:last-child{border-bottom:0}\nli .dot{flex:none;width:.42em;height:.42em;border-radius:50%;background:var(--accent);transform:translateY(-.12em)}\nli .box{flex:none;width:.85em;height:.85em;border:2px solid var(--accent);border-radius:.22em;transform:translateY(.08em)}\nli.done{color:var(--done);text-decoration:line-through}\nli.done .box{background:var(--accent)}\n.stat .v{font-family:var(--brand);font-weight:600;font-size:2.1em;color:var(--accent);line-height:1.05}\n.stat .l{color:var(--muted)}\n.note{border-left:.22em solid var(--accent)}\n.card p.note{padding-left:.6em;margin:.45em 0 0}\n.note.warn{border-left-color:var(--ember);font-weight:600}\nhr{border:0;border-top:1px solid var(--line);margin:.6em 0}\n@media (max-width:820px),(orientation:portrait){main.hero{grid-template-columns:minmax(0,1fr)}}</style></head><body><main class=\"hero\"><div class=\"side\"><h1>Kitchen</h1><div class=\"clock\"><div class=\"t\">07:30</div><div class=\"d\">lundi 9 novembre</div></div><div class=\"card ev\"><h3>Prochain rendez-vous</h3><p class=\"what\">Rendez-vous</p><p class=\"w\">aujourd&#x27;hui, 14:30</p></div></div><div class=\"cards\"><div class=\"card\"><h3>Groceries</h3><ul><li class=\"done\"><span class=\"box\"></span><span>bread</span></li><li class=\"todo\"><span class=\"box\"></span><span>milk</span></li><li class=\"todo\"><span class=\"box\"></span><span>eggs</span></li></ul></div></div></main></body></html>";

function withoutHtml(st: ScreenState): Omit<ScreenState, "html"> & { html?: never } {
  const { html: _h, ...rest } = st;
  void _h;
  return rest;
}

export function startScreen(state: MockState, threadId: string): Bubble {
  const st: ScreenState = {
    screen_id: hexId("scr"),
    version: 1,
    title: "Kitchen",
    status: "draft",
    published_version: null,
    html: SCREEN_PREVIEW_HTML,
    html_too_large: false,
    bubble_status: "idle",
    actions: [{ id: "publish", label: "Publish on the wall", primary: true }],
  };
  return createBubble(state, threadId, { kind: "screen", title: st.title, status: "idle", created_by: MOCK_USER, state: st });
}

function setState(state: MockState, b: Bubble, patch: Partial<ScreenState>): ScreenState {
  const status = patch.status === "published" ? "done" : "idle";
  updateBubble(state, b.id, { state: { ...patch, bubble_status: status } as Record<string, unknown>, status });
  const next = state.bubbles.get(b.id);
  return (next?.kind === "screen" ? next.state : { ...(b.state as ScreenState), ...patch }) as ScreenState;
}

function requestPublish(state: MockState, b: Bubble, st: ScreenState): Approval {
  const args = { screen_id: st.screen_id, title: st.title, version: st.version, sha256: createHash("sha256").update(st.html ?? "").digest("hex") };
  const approval: Approval = {
    id: randomId("appr"),
    thread_id: b.thread_id ?? "",
    turn_index: 0,
    channel: "web",
    tool_name: "wall_publish",
    arguments: args,
    args_sha256: createHash("sha256").update(JSON.stringify(args)).digest("hex"),
    effect: "write",
    rule: "wall:publish",
    reason: `Publier l'écran « ${st.title} » (version ${st.version}) sur votre mur. Tous ceux qui voient le mur le verront.`,
    advice: null,
    strength: "strong",
    status: "pending",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
    decided_by: null,
    decided_via: null,
    decided_at: null,
    result_summary: null,
    error: null,
  };
  state.approvals.set(approval.id, approval);
  state.approvalEffects.set(approval.id, () => {
    const cur = state.bubbles.get(b.id);
    if (cur?.kind !== "screen" || (cur.state as ScreenState).version !== st.version) return "failed";
    state.wallScreen = { id: st.screen_id, version: st.version, title: st.title, html: SCREEN_WALL_HTML };
    setState(state, cur, { status: "published", published_version: st.version, actions: [{ id: "unpublish", label: "Remove from the wall" }] });
    return "published";
  });
  return approval;
}

registerDirectAction("screen", (state, b, actionId) => {
  if (b.kind !== "screen") return null;
  const st = b.state as ScreenState;
  if (actionId === "publish" && st.status === "draft") {
    requestPublish(state, b, st);
    return { screen: withoutHtml(setState(state, b, { status: "pending", actions: [] })) };
  }
  if (actionId === "unpublish" && st.status === "published") {
    state.wallScreen = null;
    return { screen: withoutHtml(setState(state, b, { status: "draft", published_version: null, actions: [{ id: "publish", label: "Publish on the wall", primary: true }] })) };
  }
  return null;
});

/** E2E only: `POST /v1/dev/screens/approve` (local token) approves the pending `wall_publish` cards, as the person would
 * on the phone with the device key. */
export function handleScreensDev(state: MockState, user: string | null, method: string, path: string, send: (status: number, obj: unknown) => void): boolean {
  if (!(method === "POST" && path === "/v1/dev/screens/approve")) return false;
  if (user !== LOCAL_OWNER) return send(403, { error: { code: "forbidden", message: "local token required" } }), true;
  let n = 0;
  for (const a of state.approvals.values()) {
    if (a.tool_name === "wall_publish" && a.status === "pending") {
      finalizeDecision(state, a, "approve", "local", LOCAL_OWNER);
      n += 1;
    }
  }
  send(200, { approved: n });
  return true;
}

// -- Frame served by the core (core docs/SCREENS.md §3): own CSP, sandbox WITHOUT scripts. A `srcdoc` page would inherit
// the web's CSP (`style-src 'self'` blocks its style). `POST /v1/screens/{id}/frame-url` (session) → {url, version};
// `GET /v1/screens/frame/{key}?exp=&sig=` (no token: the signature decides) → the HTML. `MOCK_SCREENS_FRAME=0`: older core.
const FRAME_KEY = randomBytes(32);
const FRAME_TTL_MS = 5 * 60_000;
const frames = new Map<string, { html: string; exp: number }>();
const frameSig = (key: string, exp: number): string => createHmac("sha256", FRAME_KEY).update(`${key}.${exp}`).digest("hex").slice(0, 32);
const STYLE_SHA = (html: string): string => {
  const m = /<style>([\s\S]*?)<\/style>/.exec(html);
  return createHash("sha256").update(m?.[1] ?? "").digest("base64");
};

export function screenFrameUrl(html: string): string {
  const key = randomBytes(18).toString("base64url");
  const exp = Math.floor((Date.now() + FRAME_TTL_MS) / 1000);
  frames.set(key, { html, exp });
  return `/v1/screens/frame/${key}?exp=${exp}&sig=${frameSig(key, exp)}`;
}

export function handleScreensFrameUrl(state: MockState, method: string, path: string, send: (status: number, obj: unknown) => void): boolean {
  const m = /^\/v1\/screens\/([^/]+)\/frame-url$/.exec(path);
  if (!m || method !== "POST") return false;
  if (!state.screens || process.env.MOCK_SCREENS_FRAME === "0") return send(404, { error: { message: "not found" } }), true;
  const id = decodeURIComponent(m[1]!);
  for (const b of state.bubbles.values()) {
    if (b.kind === "screen" && (b.state as ScreenState).screen_id === id) {
      const st = b.state as ScreenState;
      return send(200, { url: screenFrameUrl(SCREEN_PREVIEW_HTML), version: st.version }), true;
    }
  }
  return send(404, { error: { message: "unknown screen" } }), true;
}

// Brand fonts, same origin as the frame (the core serves the same files: nokker/screens/fonts, SIL OFL).
const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../brand/assets/fonts");
const FONTS = new Set(["cinzel-latin-600-normal", "cinzel-latin-ext-600-normal", "ibm-plex-sans-latin-400-normal", "ibm-plex-sans-latin-ext-400-normal", "ibm-plex-sans-latin-600-normal", "ibm-plex-sans-latin-ext-600-normal"]);

export function handleScreensFrame(method: string, path: string, query: URLSearchParams, res: { writeHead: (s: number, h: Record<string, string>) => void; end: (b?: string | Buffer) => void }): boolean {
  const font = /^\/v1\/screens\/fonts\/([a-z0-9-]+)\.woff2$/.exec(path);
  if (font && method === "GET") {
    if (!FONTS.has(font[1]!)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404");
      return true;
    }
    res.writeHead(200, { "Content-Type": "font/woff2", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=604800, immutable", "X-Content-Type-Options": "nosniff" });
    res.end(readFileSync(join(FONT_DIR, `${font[1]}.woff2`)));
    return true;
  }
  const m = /^\/v1\/screens\/frame\/([A-Za-z0-9_-]+)$/.exec(path);
  if (!m || method !== "GET") return false;
  const f = frames.get(m[1]!);
  const exp = Number(query.get("exp"));
  const ok = f && exp === f.exp && query.get("sig") === frameSig(m[1]!, exp) && exp * 1000 >= Date.now();
  if (!ok) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404");
    return true;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `sandbox; default-src 'none'; style-src 'sha256-${STYLE_SHA(f.html)}'; font-src 'self'; base-uri 'none'; form-action 'none'`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end(f.html);
  return true;
}
