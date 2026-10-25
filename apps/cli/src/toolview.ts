/**
 * Modèle d'affichage des appels d'outils — pur (sans Ink), testé par `test/toolview.test.ts`.
 * `tool.call` et `tool.result` sont reliés par `call_id` (jamais par nom : deux `terminal` se suivent).
 *
 * Écriture en direct (X22, BUBBLES.md §6) : les `tool.input.delta` d'un `write_file`/`patch`/`page_create` arrivent
 * AVANT son `tool.call` ; le premier crée la ligne (provisoire), les suivants accumulent le texte vivant affiché sous
 * elle. Le `tool.call` met la ligne à jour (pas de doublon), le `tool.result` replie le bloc, `turn.done` replie tout
 * (et retire une ligne jamais appelée : rien n'a été exécuté).
 *
 * Carte posée par le modèle (LOKKAL.md §7.4.9) : le premier `tool.result` dit « en attente d'approbation
 * [approval:<id>] » et la ligne reste ouverte (⏸) ; approuvée, l'outil s'exécute en fond et son vrai résultat arrive
 * par un second `tool.result` du même `call_id` (avec `approval_id`) ; refusée ou expirée, `approval.decided` la ferme.
 */
import { liveTail, type LocalToolEffect, type NokkerEvent } from "@nokker-apps/sdk";

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
  /** Texte que le modèle est en train d'écrire (`tool.input.delta`) ; `null` = pas de bloc vivant (ou replié). */
  live?: string | null;
  /** Dernier `seq` appliqué au bloc vivant. */
  liveSeq?: number;
  /** Le direct s'est arrêté (appel trop gros) : « … » sous les lignes. */
  truncated?: boolean;
  /** `tool.call` reçu (sinon la ligne ne vient que du direct). */
  called?: boolean;
  turnId?: string | null;
  /** Carte que l'appel attend (`[approval:<id>]` du noyau) ; `null`/absent : aucune. */
  approvalId?: string | null;
  /** Carte approuvée : l'outil tourne (ou attend son tour dans la file du fil). */
  approved?: boolean;
}

/** Marqueur du `tool.result` « en attente » d'un appel qui a posé une carte. */
const PENDING_MARKER = /\[approval:([\w-]+)\]/;

/** Nombre de lignes écrites qui défilent sous la ligne de l'outil. */
export const LIVE_WINDOW = 6;

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
  if (t.ok === null && t.approvalId) return t.approved ? `⟳ ${head} (approuvé, exécution…)` : `⏸ ${head} (en attente d'approbation)`;
  if (t.ok === null) return `⟳ ${head}${t.effect ? ` (${EFFECT_LABEL[t.effect]})` : ""}`;
  return `${t.ok ? "✓" : "✗"} ${head}${t.ms !== null ? ` ${t.ms} ms` : ""}`;
}

export function previewLines(preview: string | null): string[] {
  return preview ? preview.split("\n").slice(0, 3) : [];
}

/** Les dernières lignes du bloc vivant (au plus `n`, coupées à `width`) ; vide sans bloc. */
export function liveLines(t: ToolLine, n = LIVE_WINDOW, width = Infinity): string[] {
  return t.live ? liveTail(t.live, n, width) : [];
}

/** Applique un événement au tableau de lignes d'outils (immuable). Renvoie le même tableau si l'événement
 * ne concerne pas les outils. Les anciens noyaux (sans `effect`/`args`) restent affichables via `args_preview`. */
export function applyToolEvent(lines: ToolLine[], e: NokkerEvent): ToolLine[] {
  switch (e.type) {
    case "tool.input.delta": {
      const i = lines.findIndex((l) => l.callId === e.call_id);
      const prev = i >= 0 ? lines[i]! : null;
      if (e.discarded) {
        if (!prev) return lines;
        // Proposition abandonnée : la ligne disparaît si l'outil n'a jamais été appelé, sinon seul le bloc se replie.
        return prev.called ? lines.map((l, k) => (k === i ? { ...l, live: null } : l)) : lines.filter((_, k) => k !== i);
      }
      if (prev && (prev.ok !== null || prev.truncated || (prev.liveSeq ?? -1) >= e.seq)) return lines;
      const args = prev?.args.path || !e.path ? prev?.args ?? {} : { ...prev?.args, path: e.path };
      const next: ToolLine = {
        callId: e.call_id,
        name: prev?.name ?? e.name,
        args,
        effect: prev?.effect ?? "write",
        ok: null,
        ms: null,
        preview: null,
        depth: prev?.depth ?? 0,
        live: (prev?.live ?? "") + (e.text ?? ""),
        liveSeq: e.seq,
        truncated: e.truncated === true,
        called: prev?.called ?? false,
        turnId: e.turn_id,
      };
      return prev ? lines.map((l, k) => (k === i ? next : l)) : [...lines, next];
    }
    case "tool.call": {
      const args = e.args ?? (e.args_preview ? { aperçu: e.args_preview } : {});
      const i = lines.findIndex((l) => l.callId === e.call_id);
      if (i >= 0) {
        // Ligne née du direct : on la complète (arguments caviardés du noyau, effet) au lieu d'en ajouter une.
        return lines.map((l, k) => (k === i ? { ...l, name: e.name, args: { ...l.args, ...args }, effect: e.effect ?? l.effect, called: true, turnId: e.turn_id } : l));
      }
      return [...lines, { callId: e.call_id, name: e.name, args, effect: e.effect ?? null, ok: null, ms: null, preview: null, depth: 0, called: true, turnId: e.turn_id }];
    }
    case "tool.result": {
      const waiting = e.approval_id ? undefined : e.preview?.match(PENDING_MARKER)?.[1];
      if (waiting && !e.is_error) {
        // L'outil n'a pas tourné : la ligne reste ouverte jusqu'à la décision (puis la vraie sortie).
        return lines.map((l) => (l.callId === e.call_id ? { ...l, approvalId: waiting, approved: false, live: null } : l));
      }
      return lines.map((l) =>
        l.callId === e.call_id
          ? {
              ...l,
              ok: e.is_error !== undefined ? !e.is_error : e.ok !== false,
              ms: e.ms ?? null,
              preview: e.preview ?? null,
              effect: l.effect ?? e.effect ?? null,
              live: null,
              approvalId: null,
              approved: false,
            }
          : l,
      );
    }
    case "approval.decided": {
      if (!lines.some((l) => l.approvalId === e.approval_id && l.ok === null)) return lines;
      if (e.decision === "approved") return lines.map((l) => (l.approvalId === e.approval_id && l.ok === null ? { ...l, approved: true } : l));
      // Refus, expiration, annulation : rien n'a été exécuté, et le noyau ne publie pas de `tool.result`.
      const why = e.decision === "expired" ? "approbation expirée — non exécuté" : e.decision === "rejected" ? "refusé — non exécuté" : "non exécuté";
      return lines.map((l) => (l.approvalId === e.approval_id && l.ok === null ? { ...l, ok: false, preview: why, approvalId: null, approved: false } : l));
    }
    case "turn.done": {
      if (!lines.some((l) => l.turnId === e.turn_id && (l.live != null || !l.called))) return lines;
      return lines
        .filter((l) => !(l.turnId === e.turn_id && !l.called && l.ok === null))
        .map((l) => (l.turnId === e.turn_id && l.live != null ? { ...l, live: null } : l));
    }
    default:
      return lines;
  }
}
