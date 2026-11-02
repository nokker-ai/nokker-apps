/**
 * `/export [md|html] [fichier]` : le fil entier (getThread paginé jusqu'au début) rendu en Markdown ou en HTML autonome.
 * Pur hors `exportThread` (qui écrit le fichier) : testé par `test/export.test.ts`. Les appels d'outils ne sont pas dans
 * l'export : le noyau ne les sert pas par `GET /v1/threads/{id}`.
 */
import { writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Thread, ThreadMessage, ThreadView } from "@nokker-apps/sdk";
import { t } from "./i18n/index.js";

export type ExportFormat = "md" | "html";

/** Tours demandés par page (maximum du noyau). */
export const EXPORT_PAGE_LIMIT = 200;

export interface ThreadSource {
  getThread(id: string, opts?: { before?: number; limit?: number }): Promise<ThreadView>;
}

/** Tout l'historique : pages de `limit` tours en remontant (`before` = plus petit index de la page précédente) jusqu'à
 * une page incomplète ou vide. Renvoie les messages du plus ancien au plus récent, sans doublon. */
export async function fetchWholeThread(src: ThreadSource, id: string, limit = EXPORT_PAGE_LIMIT): Promise<{ thread: Thread; messages: ThreadMessage[] }> {
  let before: number | undefined;
  let thread: Thread | null = null;
  const seen = new Set<string>();
  const pages: ThreadMessage[][] = [];
  for (;;) {
    const view = await src.getThread(id, { limit, ...(before !== undefined ? { before } : {}) });
    thread ??= view.thread;
    const fresh = view.messages.filter((m) => !seen.has(`${m.index}:${m.role}`));
    for (const m of fresh) seen.add(`${m.index}:${m.role}`);
    if (fresh.length) pages.unshift(fresh);
    const turns = new Set(view.messages.map((m) => m.index));
    const oldest = Math.min(...turns);
    // Page incomplète (moins de `limit` tours), vide, ou qui ne remonte plus : le début est atteint.
    if (turns.size < limit || fresh.length === 0 || (before !== undefined && oldest >= before)) break;
    before = oldest;
  }
  return { thread: thread!, messages: pages.flat().sort((a, b) => a.index - b.index || (a.role === b.role ? 0 : a.role === "user" ? -1 : 1)) };
}

export interface ExportMeta {
  cwd: string | null;
  exportedAt: Date;
}

const imageName = (im: NonNullable<ThreadMessage["images"]>[number]): string => im.name || `${im.sha256.slice(0, 8)}.${im.media_type.split("/")[1] ?? "img"}`;

function labelOf(m: ThreadMessage): string {
  return m.role === "user" ? t("You") : t("Assistant");
}

export function renderMarkdown(thread: Thread, messages: ThreadMessage[], meta: ExportMeta): string {
  const out: string[] = [`# ${thread.title || thread.id}`, ""];
  out.push(`- ${t("Session")}: ${thread.id}`);
  if (meta.cwd) out.push(`- ${t("Working folder")}: ${meta.cwd}`);
  out.push(`- ${t("Exported")}: ${meta.exportedAt.toISOString()}`);
  out.push(`- ${t("Tool calls are not included in this export (the core does not serve them).")}`, "");
  for (const m of messages) {
    out.push(`## ${labelOf(m)}${m.created_at ? ` — ${m.created_at}` : ""}`, "");
    out.push(m.content.trimEnd(), "");
    if (m.images?.length) out.push(...m.images.map((im) => `_${t("Image")}: ${imageName(im)}_`), "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function renderHtml(thread: Thread, messages: ThreadMessage[], meta: ExportMeta): string {
  const title = escapeHtml(thread.title || thread.id);
  const li = (s: string): string => `<li>${escapeHtml(s)}</li>`;
  const head = [
    li(`${t("Session")}: ${thread.id}`),
    ...(meta.cwd ? [li(`${t("Working folder")}: ${meta.cwd}`)] : []),
    li(`${t("Exported")}: ${meta.exportedAt.toISOString()}`),
    li(t("Tool calls are not included in this export (the core does not serve them).")),
  ].join("");
  const turns = messages
    .map((m) => {
      const imgs = (m.images ?? []).map((im) => `<p style="margin:.4em 0;color:#666;font-style:italic">${escapeHtml(t("Image"))}: ${escapeHtml(imageName(im))}</p>`).join("");
      const bg = m.role === "user" ? "#eef3fb" : "#f6f6f6";
      return `<section style="background:${bg};border-radius:8px;padding:12px 16px;margin:12px 0"><h2 style="font-size:.85em;margin:0 0 6px;color:#555">${escapeHtml(labelOf(m))}${m.created_at ? ` — ${escapeHtml(m.created_at)}` : ""}</h2><pre style="white-space:pre-wrap;word-wrap:break-word;margin:0;font:inherit">${escapeHtml(m.content)}</pre>${imgs}</section>`;
    })
    .join("\n");
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>\n<body style="font:15px/1.5 system-ui,sans-serif;max-width:50em;margin:2em auto;padding:0 1em;color:#222">\n<h1>${title}</h1>\n<ul style="color:#666;font-size:.85em">${head}</ul>\n${turns}\n</body></html>\n`;
}

/** `nokker-session-<id court>-<date>.<ext>` */
export function defaultExportName(threadId: string, format: ExportFormat, now: Date): string {
  const short = threadId.replace(/^th_/, "").slice(0, 8);
  return `nokker-session-${short}-${now.toISOString().slice(0, 10)}.${format}`;
}

/** Récupère le fil, écrit le fichier, renvoie son chemin absolu. `base` = dossier de la session (ou du processus). */
export async function exportThread(src: ThreadSource, threadId: string, opts: { format: ExportFormat; file: string | null; base: string; cwd: string | null; now?: Date }): Promise<{ path: string; turns: number }> {
  const now = opts.now ?? new Date();
  const { thread, messages } = await fetchWholeThread(src, threadId);
  const meta: ExportMeta = { cwd: opts.cwd, exportedAt: now };
  const body = opts.format === "html" ? renderHtml(thread, messages, meta) : renderMarkdown(thread, messages, meta);
  const target = opts.file ?? defaultExportName(thread.id, opts.format, now);
  const path = isAbsolute(target) ? target : resolve(opts.base, target);
  await writeFile(path, body, "utf8");
  return { path, turns: new Set(messages.map((m) => m.index)).size };
}
