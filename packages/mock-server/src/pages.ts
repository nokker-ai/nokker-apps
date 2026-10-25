/**
 * Pages créées en session (BUBBLES.md §10) — mock. Une page = un HTML autonome ; le state de la bulle ne porte
 * jamais le HTML. Publication (LOKKAL §7.26) : `POST /v1/pages/{id}/publish` dépose une carte forte `page_publish`
 * (approuvée à la clé d'appareil, ou par `POST /v1/dev/pages-mock {approve: id}` en démo) ; c'est la version signée
 * qui devient publique, servie par son id public seulement (`GET /v1/pages/public/{public_id}`), jamais par son
 * `page_id` sans preuve. Simplifications : pas de relais ni d'origine séparée (l'adresse publique est
 * `https://demo--pub.nokker.app/<id public>` pour l'affichage, et le mock la sert sous `/v1/pages/public/`), contenu
 * généré. Réglage : `POST /v1/dev/pages-mock {pages_public?, approve?, reject?}`.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Approval, Bubble } from "@nokker-apps/sdk";
import { MockHttpError } from "./errors.js";
import { createBubble, getBubble, updateBubble } from "./bubbles.js";
import { streamToolInput } from "./live-input.js";
import { finalizeDecision, randomId, type MockState } from "./state.js";

const PAGE_SECRET = Buffer.from("mock-pages-secret-" + Math.random());
const LINK_TTL_S = 3600;

export interface MockPage {
  id: string;
  thread_id: string;
  bubble_id: string;
  path: string;
  title: string;
  public: boolean;
  /** Id public (24 car., hasard, jamais dérivé du page_id) ; effacé à la dépublication. */
  public_id: string | null;
  public_version: number | null;
  public_index: boolean;
  locality: "local" | null;
  versions: string[];
  /** Dernière écriture, en secondes epoch (comme `nokker/pages/store.py`). */
  updated_at: number;
}

/** `download` est dans la signature : on ne transforme pas un lien d'affichage en téléchargement (ni l'inverse). */
function pageSig(id: string, exp: number, download: boolean): string {
  return createHmac("sha256", PAGE_SECRET).update(`${id}:${exp}:${download ? 1 : 0}`).digest("hex").slice(0, 32);
}

export function signPageUrl(id: string, download = false, now = Date.now()): { path: string; expires_at: string } {
  const exp = Math.floor(now / 1000) + LINK_TTL_S;
  return { path: `/v1/pages/${id}?exp=${exp}&sig=${pageSig(id, exp, download)}${download ? "&dl=1" : ""}`, expires_at: new Date(exp * 1000).toISOString() };
}

export function verifyPageSignature(id: string, exp: string | null, sig: string | null, download = false, now = Date.now()): boolean {
  const e = Number(exp);
  if (!sig || !Number.isInteger(e) || e < Math.floor(now / 1000)) return false;
  const want = Buffer.from(pageSig(id, e, download));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

function html(title: string, version: number): string {
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#14161a;color:#e8e6df}
main{text-align:center}b{color:#C3E26B}</style>
<main><h1>${title}</h1><p>Version <b>${version}</b> de la page (démo).</p>
</main></html>`;
}

function stateOf(p: MockPage): Record<string, unknown> {
  const v = p.versions[p.versions.length - 1]!;
  return { page_id: p.id, path: p.path, title: p.title, mime: "text/html", version: p.versions.length, size: Buffer.byteLength(v), public: p.public, public_version: p.public_version, public_index: p.public_index, locality: p.locality, updated_at: p.updated_at };
}

/** `page_create` : une page par (fil, chemin) — le même chemin rend la même bulle. */
export function createPage(state: MockState, threadId: string, path: string, title: string): Bubble {
  const existing = [...state.pages.values()].find((p) => p.thread_id === threadId && p.path === path);
  if (existing) return state.bubbles.get(existing.bubble_id)!;
  const id = "pg_" + randomBytes(8).toString("hex");
  const page: MockPage = { id, thread_id: threadId, bubble_id: "", path, title, public: false, public_id: null, public_version: null, public_index: false, locality: null, versions: [html(title, 1)], updated_at: Date.now() / 1000 };
  // Publier / dépublier sont des gestes du client (BUBBLES §10.4), pas des actions de la bulle.
  const b = createBubble(state, threadId, { kind: "artifact", title, status: "done", state: stateOf(page) as never, actions: [] });
  page.bubble_id = b.id;
  state.pages.set(id, page);
  return b;
}

/** Modification du fichier : le « modèle » réécrit la page en direct (X22 : `tool.input.delta` du `write_file`, bulle
 * en `state.writing`, `working`), puis l'outil s'exécute, version + 1 et la bulle se recale (`writing` retiré, `done`). */
export function updatePage(state: MockState, pageId: string, turnId = ""): void {
  const p = state.pages.get(pageId);
  if (!p) return;
  const callId = randomId("call");
  const tid = turnId || `${p.thread_id}:0`;
  const next = html(p.title, p.versions.length + 1);
  updateBubble(state, p.bubble_id, {
    status: "working",
    state: { writing: { call_id: callId, turn_id: tid, name: "write_file", since: Date.now() / 1000 } },
  });
  void streamToolInput(state, { threadId: p.thread_id, turnId: tid, callId, name: "write_file", path: p.path, field: "content", text: next }).then(() => {
    state.later(100, () => {
      state.publish({ type: "tool.call", thread_id: p.thread_id, turn_id: tid, call_id: callId, name: "write_file", effect: "write", args: { path: p.path, content: `${next.slice(0, 200)}…` } });
      p.versions.push(next);
      p.updated_at = Date.now() / 1000;
      const b = getBubble(state, p.bubble_id);
      delete (b.state as { writing?: unknown }).writing;
      updateBubble(state, p.bubble_id, { state: stateOf(p), status: "done" });
      state.publish({ type: "tool.result", thread_id: p.thread_id, turn_id: tid, call_id: callId, name: "write_file", is_error: false, ms: 4, effect: "write" });
    });
  });
}

/** Publication et localité suivent dans la bulle (`BubbleHub.page_changed`). */
function changed(state: MockState, p: MockPage): void {
  if (state.bubbles.has(p.bubble_id)) updateBubble(state, p.bubble_id, { state: stateOf(p) });
}

const cfg = new WeakMap<MockState, { pagesPublic: boolean }>();
/** Le compte peut publier (nokker.ai `pages_public`) ; vrai en démo, réglable. */
export function pagesPublicAllowed(state: MockState): boolean {
  return cfg.get(state)?.pagesPublic ?? true;
}

function unpublish(p: MockPage): void {
  p.public = false;
  p.public_id = null; // l'URL meurt pour toujours ; republier en tire un neuf
  p.public_version = null;
  p.public_index = false;
}

/** Carte forte `page_publish` : ce qui est signé (cette version, cette empreinte) est exactement ce qui devient public. */
function requestPublish(state: MockState, p: MockPage, index: boolean): Approval {
  const version = p.versions.length;
  const body = p.versions[version - 1]!;
  const args = { page_id: p.id, path: p.path, title: p.title, version, sha256: createHash("sha256").update(body).digest("hex"), size: Buffer.byteLength(body), index };
  const approval: Approval = {
    id: randomId("appr"),
    thread_id: p.thread_id,
    turn_index: 0,
    channel: "web",
    tool_name: "page_publish",
    arguments: args,
    args_sha256: createHash("sha256").update(JSON.stringify(args)).digest("hex"),
    effect: "external",
    rule: "pages:publish",
    reason: `page_publish : ${p.path}`,
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
  // Geste du noyau à l'exécution (pas de tour de suite) : page épinglée ou version disparue → la carte échoue.
  state.approvalEffects.set(approval.id, () => {
    if (p.locality === "local" || !p.versions[version - 1]) return "failed";
    p.public = true;
    p.public_id ??= randomBytes(18).toString("base64url");
    p.public_version = version;
    p.public_index = index;
    changed(state, p);
    return `page ${p.id} publique (version ${version})`;
  });
  state.publish({ type: "approval.requested", approval });
  state.publish({ type: "approval.forwarded", approval_id: approval.id, thread_id: p.thread_id });
  return approval;
}

type Send = (status: number, payload: unknown) => void;
const fail = (send: Send, status: number, code: string | null, message: string): true => (send(status, { error: code ? { code, message } : { message } }), true);

/** `POST /v1/pages/{id}/publish|unpublish`, `PUT /v1/pages/{id}/locality`, `GET /v1/pages/public/{public_id}` et le
 * réglage de démo. Rend false si la route n'est pas la sienne. */
export async function handlePagePublication(state: MockState, user: string | null, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send, sendPage: (body: string, index: boolean) => void): Promise<boolean> {
  if (method === "POST" && path === "/v1/dev/pages-mock") {
    const b = await readBody();
    if (typeof b.pages_public === "boolean") cfg.set(state, { pagesPublic: b.pages_public });
    for (const [k, d] of [["approve", "approve"], ["reject", "reject"]] as const) {
      const a = typeof b[k] === "string" ? state.approvals.get(b[k] as string) : undefined;
      if (a && a.status === "pending") finalizeDecision(state, a, d, "webauthn");
    }
    return send(200, { pages_public: pagesPublicAllowed(state) }), true;
  }
  const pub = /^\/v1\/pages\/public\/([A-Za-z0-9_-]{24})$/.exec(path);
  if (pub && (method === "GET" || method === "HEAD")) {
    const p = [...state.pages.values()].find((x) => x.public && x.public_id === pub[1]);
    const body = p && p.public_version ? p.versions[p.public_version - 1] : undefined;
    if (!p || body === undefined) return fail(send, 404, null, "not found");
    return sendPage(body, p.public_index), true;
  }
  const m = /^\/v1\/pages\/(pg_[0-9a-f]{16})\/(publish|unpublish|locality)$/.exec(path);
  if (!m) return false;
  if (!user) return fail(send, 401, null, "unauthorized");
  const p = state.pages.get(m[1]!);
  if (!p) return fail(send, 404, null, "not found");
  const op = m[2]!;
  if ((op === "locality") !== (method === "PUT") || (op !== "locality" && method !== "POST")) return fail(send, 404, null, "not found");
  if (op === "unpublish") {
    const was = p.public;
    unpublish(p);
    changed(state, p);
    return send(200, { page_id: p.id, public: false, purge: was ? "done" : "none" }), true;
  }
  const b = await readBody();
  if (op === "locality") {
    if (b.locality !== "local" && b.locality !== null) return fail(send, 400, null, 'corps {locality: "local" | null} requis');
    const was = p.public;
    p.locality = b.locality;
    if (p.locality === "local") unpublish(p);
    changed(state, p);
    return send(200, { page_id: p.id, locality: p.locality, public: p.public, purge: was && p.locality === "local" ? "done" : "none" }), true;
  }
  if (p.locality === "local") return fail(send, 409, "local_page", "page épinglée « local » : elle ne quitte pas la machine");
  if (!pagesPublicAllowed(state)) return fail(send, 403, "pages_public_not_allowed", "pages publiques réservées aux abonnés et comptes vérifiés");
  if ("index" in b && typeof b.index !== "boolean") return fail(send, 400, null, "index : booléen");
  const a = requestPublish(state, p, b.index === true);
  return send(202, { approval_id: a.id, strength: "strong", rule: "pages:publish", version: (a.arguments as { version: number }).version }), true;
}

export function getPage(state: MockState, id: string): MockPage {
  const p = state.pages.get(id);
  if (!p) throw new MockHttpError(404, "page inconnue");
  return p;
}

export const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

/** En-têtes d'une page publique (relais, §7.26) : le JS en ligne seulement, aucun appel réseau ni formulaire. */
export const PUBLIC_PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

/** Nom du fichier téléchargé : le titre réduit à des caractères sûrs pour un en-tête. */
export function downloadName(title: string): string {
  const base = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${base || "page"}.html`;
}
