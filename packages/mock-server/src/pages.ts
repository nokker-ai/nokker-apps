/**
 * Pages créées en session (BUBBLES.md §10) — mock. Une page = un HTML autonome ; le state de la bulle ne porte
 * jamais le HTML. Simplifications : pas de carte forte pour `publish`, pas de relais ni d'origine séparée
 * (le lien est `/v1/pages/<id>?exp=&sig=` sur le serveur du mock), contenu généré.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Bubble } from "@nokker-apps/sdk";
import { MockHttpError } from "./errors.js";
import { createBubble, getBubble, registerAction, updateBubble } from "./bubbles.js";
import type { MockState } from "./state.js";

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
  return { page_id: p.id, path: p.path, title: p.title, mime: "text/html", version: p.versions.length, size: Buffer.byteLength(v), public: p.public, updated_at: new Date().toISOString() };
}

function actionsOf(p: MockPage) {
  return p.public ? [{ id: "unpublish", label: "Rendre privée" }] : [{ id: "publish", label: "Publier", primary: false }];
}

/** `page_create` : une page par (fil, chemin) — le même chemin rend la même bulle. */
export function createPage(state: MockState, threadId: string, path: string, title: string): Bubble {
  const existing = [...state.pages.values()].find((p) => p.thread_id === threadId && p.path === path);
  if (existing) return state.bubbles.get(existing.bubble_id)!;
  const id = "pg_" + randomBytes(8).toString("hex");
  const page: MockPage = { id, thread_id: threadId, bubble_id: "", path, title, public: false, versions: [html(title, 1)] };
  const b = createBubble(state, threadId, { kind: "artifact", title, status: "done", state: stateOf(page) as never, actions: actionsOf(page) });
  page.bubble_id = b.id;
  state.pages.set(id, page);
  return b;
}

/** Modification du fichier : version + 1, `working` pendant le tour puis `done`. */
export function updatePage(state: MockState, pageId: string): void {
  const p = state.pages.get(pageId);
  if (!p) return;
  updateBubble(state, p.bubble_id, { status: "working" });
  state.later(1500, () => {
    p.versions.push(html(p.title, p.versions.length + 1));
    updateBubble(state, p.bubble_id, { state: stateOf(p), status: "done" });
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
