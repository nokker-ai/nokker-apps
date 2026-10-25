/**
 * Écriture en direct (lot X22, BUBBLES.md §6) — mock : `tool.input.delta` réalistes pendant que le « modèle » écrit
 * les arguments d'un `write_file`/`patch`, AVANT le `tool.call` du même `call_id`. Comme le noyau : d'abord le chemin
 * (texte vide), puis le contenu par morceaux de quelques lignes toutes les ~100 ms, `seq` croissant ; au-delà de
 * `LIVE_INPUT_MAX` caractères, un dernier événement `truncated` et plus rien.
 */
import type { ToolInputDeltaEvent } from "@nokker-apps/sdk";
import type { MockState } from "./state.js";

export const LIVE_INPUT_MAX = 200_000;
const LINES_PER_CHUNK = 2;
const CHUNK_MS = 100;

export interface LiveInputSpec {
  threadId: string;
  turnId: string;
  callId: string;
  name: "write_file" | "patch" | "page_create";
  path: string;
  /** `content` (write_file), `new_string` ou `patch` (patch) ; absent pour `page_create`. */
  field?: "content" | "new_string" | "patch";
  text: string;
}

function wait(state: MockState, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, Math.max(0, Math.round(ms * state.speed)));
    function done(): void {
      signal?.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Découpe en morceaux de `LINES_PER_CHUNK` lignes (fins de ligne gardées : la concaténation redonne le texte). */
export function chunkLines(text: string, per = LINES_PER_CHUNK): string[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += per) out.push(lines.slice(i, i + per).join(""));
  return out;
}

/** Publie le flux d'un appel ; rend quand le « modèle » a fini d'écrire (ou que le tour est annulé). */
export async function streamToolInput(state: MockState, spec: LiveInputSpec, signal?: AbortSignal): Promise<void> {
  const base = { type: "tool.input.delta" as const, thread_id: spec.threadId, turn_id: spec.turnId, call_id: spec.callId, name: spec.name, path: spec.path };
  const field = spec.field ? { field: spec.field } : {};
  let seq = 0;
  const publish = (e: Omit<ToolInputDeltaEvent, keyof typeof base | "seq" | "type">): void =>
    state.publish({ ...base, ...field, seq: seq++, ...e });
  publish({ text: "" });
  if (!spec.field) return;
  let sent = 0;
  for (const piece of chunkLines(spec.text)) {
    await wait(state, CHUNK_MS, signal);
    if (signal?.aborted) return;
    if (sent + piece.length > LIVE_INPUT_MAX) {
      publish({ text: "", truncated: true });
      return;
    }
    sent += piece.length;
    publish({ text: piece });
  }
}
