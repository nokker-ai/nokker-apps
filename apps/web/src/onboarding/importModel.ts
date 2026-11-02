/**
 * Écran « Tu viens d'un autre agent ? » (lot 30) : logique sans rendu. Le noyau ne lit que ce qui lui est visible
 * (les dossiers des autres agents ne sont jamais montés dans son conteneur) ; sinon l'écran donne la commande à lancer
 * sur l'hôte et relit le rapport qu'elle a écrit.
 */
import type { ImportItem, ImportReport, ImportSource } from "@nokker-apps/sdk";
import { t, type Lang } from "./i18n.js";

export const SOURCES: { id: ImportSource; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "hermes", label: "Hermes" },
  { id: "openclaw", label: "OpenClaw" },
];

/** Commande à lancer sur l'hôte (CLI de Lokkal) : à blanc, puis avec --apply. */
export function hostCommand(source: ImportSource, apply: boolean): string {
  return `nokker import ${source}${apply ? " --apply" : ""}`;
}

const TAKEN = new Set(["planned", "imported", "native"]);

/** Le rapport vu par une personne : ce qui est (ou sera) repris, ce qui ne l'est pas, et les serveurs MCP à ajouter
 * dans une session. Les lignes de fichier « lu clé par clé » sont du bruit pour elle : retirées. */
export function groupReport(r: ImportReport): { taken: ImportItem[]; left: ImportItem[]; mcp: ImportItem[] } {
  const items = r.items.filter((i) => i.kind !== "source-file");
  const mcp = items.filter((i) => i.kind === "mcp" && (i.status === "planned" || (i.status === "skipped" && !!i.detail.entry)));
  return {
    taken: items.filter((i) => TAKEN.has(i.status) && !mcp.includes(i)),
    left: items.filter((i) => !TAKEN.has(i.status) && !mcp.includes(i)),
    mcp,
  };
}

/** Rien de lisible pour le noyau (hors chemins non lus) : il faut passer par la commande de l'hôte. */
export function nothingVisible(r: ImportReport): boolean {
  return r.items.every((i) => i.kind === "unaccounted-source");
}

/** Phrase à dire à Nina dans une session pour ajouter un serveur MCP (sa carte forte fait foi). */
export function mcpRequest(it: ImportItem, lang: Lang): string {
  const e = (it.detail.entry ?? {}) as { name?: string; url?: string };
  return t(lang, "impMcpAsk", { name: e.name ?? "?", url: e.url ?? "?" });
}

/** Libellé court d'un élément : le nom quand il y en a un, sinon la fin du chemin source. */
export function itemLabel(it: ImportItem): string {
  const d = it.detail as { name?: string; title?: string };
  if (d.title) return d.title;
  if (d.name) return d.name;
  const [file, key] = it.source.split("#", 2);
  return key ?? file!.split("/").filter(Boolean).slice(-1)[0] ?? it.source;
}
