/**
 * Écriture en direct (lot X22, BUBBLES.md §10.7) vue de l'éditeur : les `tool.input.delta` d'un `write_file` / `patch`
 * (ce que le modèle PROPOSE, avant toute exécution : la carte reste la porte) accumulés par `applyLiveInputEvent` du
 * SDK, pour le bloc vivant du panneau et un éditeur en lecture seule qui se remplit. Pur (sans API VS Code).
 *
 * Fin d'un bloc : `tool.result` du même `call_id` ou `turn.done` du tour (le texte reste affiché, figé) ; `discarded` :
 * proposition abandonnée (le bloc dit qu'elle est retirée).
 */
import { applyLiveInputEvent, liveTail, type LiveInput, type LiveInputs, type NokkerEvent } from "@nokker-apps/sdk";

export interface LiveView {
  callId: string;
  name: string;
  /** Chemin tel que le modèle l'écrit (relatif ou sous `/workspace`), `null` tant qu'il n'est pas écrit. */
  path: string | null;
  field: string | null;
  text: string;
  truncated: boolean;
  /** Bloc fermé (`tool.result`, `turn.done`) : le texte ne bouge plus. */
  done: boolean;
  discarded: boolean;
}

/** Lignes montrées dans le panneau sous la ligne d'outil (comme le client terminal). */
export const LIVE_WINDOW = 6;

/** Chemin affichable : `/workspace/src/a.py` → `src/a.py`. */
export function livePath(path: string | null): string | null {
  if (!path) return null;
  return path.replace(/^\/workspace\/?/, "") || path;
}

export class LiveWrites {
  private live: LiveInputs = new Map();
  private views = new Map<string, LiveView>();

  constructor(private readonly onUpdate: (v: LiveView) => void) {}

  get(callId: string): LiveView | undefined {
    return this.views.get(callId);
  }

  /** Applique un événement du fil ; rend les blocs changés. */
  apply(e: NokkerEvent): LiveView[] {
    if (e.type !== "tool.input.delta" && e.type !== "tool.result" && e.type !== "turn.done") return [];
    const before = this.live;
    const next = applyLiveInputEvent(before, e);
    const changed: LiveView[] = [];
    if (e.type === "tool.input.delta") {
      const cur = next.get(e.call_id);
      if (e.discarded) {
        const v = this.views.get(e.call_id);
        if (v && !v.done) changed.push(this.put({ ...v, done: true, discarded: true }));
      } else if (cur && cur !== before.get(e.call_id)) {
        changed.push(this.put(viewOf(cur, false)));
      }
    } else {
      for (const [id, l] of before) {
        if (!next.has(id)) changed.push(this.put(viewOf(l, true)));
      }
    }
    this.live = next;
    return changed;
  }

  /** Les dernières lignes d'un bloc pour le panneau. */
  tail(callId: string, n = LIVE_WINDOW, width = 160): string[] {
    const v = this.views.get(callId);
    return v ? liveTail(v.text, n, width) : [];
  }

  clear(): void {
    this.live = new Map();
    this.views.clear();
  }

  private put(v: LiveView): LiveView {
    this.views.set(v.callId, v);
    this.onUpdate(v);
    return v;
  }
}

function viewOf(l: LiveInput, done: boolean): LiveView {
  return { callId: l.callId, name: l.name, path: l.path, field: l.field, text: l.text, truncated: l.truncated, done, discarded: false };
}
