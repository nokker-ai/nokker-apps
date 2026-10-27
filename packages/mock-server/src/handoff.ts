/**
 * Relais web → Lokkal (X21, LOKKAL §7.16) — mock. Une bulle `handoff` proposée par le « modèle » ; l'utilisateur seul
 * accepte ou refuse (200 `{handoff}`, en direct, jamais un tour). Accepté : machine en ligne → running → done avec
 * une réponse de démo ; hors ligne → waiting (la démo n'avance plus : « Annuler » = refuse).
 */
import type { Bubble } from "@nokker-apps/sdk";
import { createBubble, getBubble, updateBubble } from "./bubbles.js";
import { MockHttpError } from "./errors.js";
import { hexId, type MockState } from "./state.js";

type HandoffStateName = "proposed" | "waiting" | "accepted" | "running" | "awaiting_approval" | "done" | "refused" | "expired" | "failed";

const STATUS: Record<HandoffStateName, Bubble["status"]> = {
  proposed: "idle", waiting: "idle", accepted: "working", running: "working", awaiting_approval: "working",
  done: "done", refused: "done", failed: "failed", expired: "failed",
};

export function proposeHandoff(
  state: MockState,
  threadId: string,
  spec: { kind: "repo" | "host" | "connector" | "mcp"; name: string; task: string; machine: string; online: boolean },
): Bubble {
  const now = Date.now() / 1000;
  const kindLabel = { repo: "repository", host: "host", connector: "connector", mcp: "MCP" }[spec.kind];
  return createBubble(state, threadId, {
    kind: "handoff",
    title: `Handoff to “${spec.machine}” — ${kindLabel} “${spec.name}”`,
    status: "idle",
    actions: [
      { id: "accept", label: "Hand off", primary: true },
      { id: "refuse", label: "No" },
    ],
    state: {
      handoff_id: hexId("ho"), state: "proposed", need: { kind: spec.kind, name: spec.name },
      machine_id: `mc_${spec.machine.toLowerCase()}`, machine_name: spec.machine, online: spec.online, task: spec.task,
      lokkal_thread: null, reply: null, error: null, pending_approvals: 0, created_at: now, updated_at: now,
    } as never,
  });
}

function set(state: MockState, b: Bubble, next: HandoffStateName, extra: Record<string, unknown> = {}): void {
  const st = { ...(b.state as unknown as Record<string, unknown>), state: next, updated_at: Date.now() / 1000, ...extra };
  updateBubble(state, b.id, { state: st as never, status: STATUS[next] });
}

/** `POST /v1/bubbles/{id}/actions/accept|refuse` sur une bulle `handoff` : 200 `{handoff}`, en direct. */
export function decideHandoff(state: MockState, b: Bubble, actionId: string): { status: number; body: { handoff: unknown } } {
  const st = b.state as unknown as { state: HandoffStateName; online: boolean; handoff_id: string };
  if (actionId !== "accept" && actionId !== "refuse") throw new MockHttpError(400, "décision inconnue");
  if (actionId === "refuse") {
    if (st.state !== "proposed" && st.state !== "waiting") throw new MockHttpError(409, "déjà décidée");
    set(state, b, "refused");
  } else {
    if (st.state !== "proposed") throw new MockHttpError(409, "déjà décidée");
    if (!st.online) set(state, b, "waiting", { error: null });
    else {
      set(state, b, "accepted");
      state.later(600, () => set(state, getBubble(state, b.id), "running", { lokkal_thread: hexId("th") }));
      state.later(3000, () =>
        set(state, getBubble(state, b.id), "done", { reply: "(demo) Done on the machine: the tests pass, the fix is on a local branch." }),
      );
    }
  }
  return { status: 200, body: { handoff: getBubble(state, b.id).state } };
}
