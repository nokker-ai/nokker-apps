/**
 * Pages créées en session (BUBBLES.md §10) — mock. Une page = un HTML autonome ; le state de la bulle ne porte
 * jamais le HTML. Simplifications : pas de carte forte pour `publish`, pas de relais ni d'origine séparée
 * (le lien est `/v1/pages/<id>?exp=&sig=` sur le serveur du mock), contenu généré.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Bubble } from "@nokker-apps/sdk";
import { MockHttpError } from "./errors.js";
import { createBubble, getBubble, registerAction, updateBubble } from "./bubbles.js";
import { streamToolInput } from "./live-input.js";
import { randomId, type MockState } from "./state.js";

const PAGE_SECRET = Buffer.from("mock-pages-secret-" + Math.random());
const LINK_TTL_S = 3600;

export interface MockPage {
  id: string;
  thread_id: string;
  bubble_id: string;
  path: string;
  title: string;
  public: boolean;
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
  return { page_id: p.id, path: p.path, title: p.title, mime: "text/html", version: p.versions.length, size: Buffer.byteLength(v), public: p.public, updated_at: p.updated_at };
}

function actionsOf(p: MockPage) {
  return p.public ? [{ id: "unpublish", label: "Rendre privée" }] : [{ id: "publish", label: "Publier", primary: false }];
}

/** `page_create` : une page par (fil, chemin) — le même chemin rend la même bulle. */
export function createPage(state: MockState, threadId: string, path: string, title: string): Bubble {
  const existing = [...state.pages.values()].find((p) => p.thread_id === threadId && p.path === path);
  if (existing) return state.bubbles.get(existing.bubble_id)!;
  const id = "pg_" + randomBytes(8).toString("hex");
  const page: MockPage = { id, thread_id: threadId, bubble_id: "", path, title, public: false, versions: [html(title, 1)], updated_at: Date.now() / 1000 };
  const b = createBubble(state, threadId, { kind: "artifact", title, status: "done", state: stateOf(page) as never, actions: actionsOf(page) });
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

export function setPagePublic(state: MockState, bubbleId: string, value: boolean): Bubble {
  const p = [...state.pages.values()].find((x) => x.bubble_id === bubbleId);
  if (!p) throw new MockHttpError(404, "page inconnue");
  p.public = value;
  getBubble(state, bubbleId).actions = actionsOf(p);
  return updateBubble(state, bubbleId, { state: stateOf(p) });
}

registerAction("artifact:publish", (state, b) => {
  setPagePublic(state, b.id, true);
  return `Page « ${b.title} » publiée : toute personne avec le lien peut la voir.`;
});
registerAction("artifact:unpublish", (state, b) => {
  setPagePublic(state, b.id, false);
  return `Page « ${b.title} » de nouveau privée.`;
});

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

/** Nom du fichier téléchargé : le titre réduit à des caractères sûrs pour un en-tête. */
export function downloadName(title: string): string {
  const base = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${base || "page"}.html`;
}
