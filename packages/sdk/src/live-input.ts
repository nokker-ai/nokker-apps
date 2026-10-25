/**
 * Écriture en direct (lot X22, BUBBLES.md §6) — accumulation PURE des `tool.input.delta` par `call_id`, partagée par
 * les clients (terminal, web). Aucun état caché : chaque fonction rend une nouvelle table.
 *
 * Règles du contrat : `seq` déjà vu ou plus petit → ignoré ; `discarded` → bloc retiré ; `truncated` → bloc figé
 * (plus rien ne s'ajoute) ; `tool.result` du même `call_id` ou `turn.done` du tour → bloc clos (retiré).
 */
import type { NokkerEvent, ToolInputDeltaEvent } from "./types.js";

export interface LiveInput {
  callId: string;
  threadId: string;
  turnId: string;
  name: string;
  path: string | null;
  field: string | null;
  /** Texte reçu jusqu'ici (déjà caviardé par le noyau). */
  text: string;
  /** Dernier `seq` appliqué. */
  seq: number;
  truncated: boolean;
}

export type LiveInputs = ReadonlyMap<string, LiveInput>;

/** Applique un `tool.input.delta`. Rend la même table si l'événement n'apporte rien (doublon, bloc figé). */
export function applyToolInputDelta(live: LiveInputs, e: ToolInputDeltaEvent): LiveInputs {
  const prev = live.get(e.call_id);
  if (e.discarded) {
    if (!prev) return live;
    const next = new Map(live);
    next.delete(e.call_id);
    return next;
  }
  if (prev && (e.seq <= prev.seq || prev.truncated)) return live;
  const next = new Map(live);
  next.set(e.call_id, {
    callId: e.call_id,
    threadId: e.thread_id,
    turnId: e.turn_id,
    name: e.name,
    path: e.path ?? prev?.path ?? null,
    field: e.field ?? prev?.field ?? null,
    text: (prev?.text ?? "") + (e.text ?? ""),
    seq: e.seq,
    truncated: e.truncated === true,
  });
  return next;
}

/** Applique n'importe quel événement : delta, clôture par `tool.result` (même `call_id`) ou `turn.done` (même tour). */
export function applyLiveInputEvent(live: LiveInputs, e: NokkerEvent): LiveInputs {
  switch (e.type) {
    case "tool.input.delta":
      return applyToolInputDelta(live, e);
    case "tool.result": {
      if (!e.call_id || !live.has(e.call_id)) return live;
      const next = new Map(live);
      next.delete(e.call_id);
      return next;
    }
    case "turn.done": {
      let next: Map<string, LiveInput> | null = null;
      for (const [id, l] of live) {
        if (l.turnId === e.turn_id) {
          next ??= new Map(live);
          next.delete(id);
        }
      }
      return next ?? live;
    }
    default:
      return live;
  }
}

/** Les `n` dernières lignes non vides du texte, chacune coupée à `width` caractères (« … » en bout de ligne coupée). */
export function liveTail(text: string, n: number, width = Infinity): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const tail = lines.slice(-Math.max(0, n));
  if (!Number.isFinite(width) || width <= 1) return tail;
  return tail.map((l) => (l.length > width ? `${l.slice(0, width - 1)}…` : l));
}
