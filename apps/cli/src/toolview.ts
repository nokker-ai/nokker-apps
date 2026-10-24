/**
 * Modèle d'affichage des appels d'outils — pur (sans Ink), testé par `test/toolview.test.ts`.
 * `tool.call` et `tool.result` sont reliés par `call_id` (jamais par nom : deux `terminal` se suivent).
 */
import type { LocalToolEffect, NokkerEvent } from "@nokker-apps/sdk";

export interface ToolLine {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  effect: LocalToolEffect | null;
  /** `null` = en cours. */
  ok: boolean | null;
  ms: number | null;
  /** Aperçu du résultat (3 lignes au plus). */
  preview: string | null;
  /** 1 = ligne de sous-agent (indentée). */
  depth: number;
}

export const EFFECT_LABEL: Record<LocalToolEffect, string> = {
  read: "lecture",
  write: "écriture",
  destructive: "destructif",
  send_external: "envoi",
  spend: "dépense",
  secret: "secret",
};

export const EFFECT_COLOR: Record<LocalToolEffect, string> = {
  read: "gray",
  write: "cyan",
  destructive: "redBright",
  send_external: "yellow",
  spend: "yellow",
  secret: "magenta",
};

/** Cible lisible : la commande pour `terminal`, sinon le chemin, le motif ou le premier champ texte. */
export function toolTarget(name: string, args: Record<string, unknown>): string {
  if (name === "terminal" && typeof args.command === "string") return args.command;
  for (const key of ["path", "pattern", "query", "url", "goal", "command"]) {
    const v = args[key];
    if (typeof v === "string" && v) return v;
  }
  const first = Object.values(args).find((v) => typeof v === "string") as string | undefined;
  return first ? first.slice(0, 80) : "";
}

/** `⟳ patch src/app.py (écriture)` en cours ; `✓ patch src/app.py 120 ms` à la fin ; `✗ …` en échec. */
export function formatToolLine(t: ToolLine): string {
  const target = toolTarget(t.name, t.args);
  const head = `${t.name}${target ? ` ${target}` : ""}`;
  if (t.ok === null) return `⟳ ${head}${t.effect ? ` (${EFFECT_LABEL[t.effect]})` : ""}`;
  return `${t.ok ? "✓" : "✗"} ${head}${t.ms !== null ? ` ${t.ms} ms` : ""}`;
}

export function previewLines(preview: string | null): string[] {
  return preview ? preview.split("\n").slice(0, 3) : [];
}

/** Applique un événement au tableau de lignes d'outils (immuable). Renvoie le même tableau si l'événement
 * ne concerne pas les outils. Les anciens noyaux (sans `effect`/`args`) restent affichables via `args_preview`. */
export function applyToolEvent(lines: ToolLine[], e: NokkerEvent): ToolLine[] {
  switch (e.type) {
    case "tool.call": {
      const args = e.args ?? (e.args_preview ? { aperçu: e.args_preview } : {});
      return [...lines, { callId: e.call_id, name: e.name, args, effect: e.effect ?? null, ok: null, ms: null, preview: null, depth: 0 }];
    }
    case "tool.result":
      return lines.map((l) =>
        l.callId === e.call_id ? { ...l, ok: e.is_error !== undefined ? !e.is_error : e.ok !== false, ms: e.ms ?? null, preview: e.preview ?? null, effect: l.effect ?? e.effect ?? null } : l,
      );
    default:
      return lines;
  }
}
