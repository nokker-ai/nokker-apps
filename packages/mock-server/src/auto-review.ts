/**
 * Automatic review of `standard` cards (APPROVALS.md §8) — mock of the decision, of the revocation and of the
 * per-card restore point (`nokker/tools/card_snapshots.py`).
 *
 * In the chat: « auto-review » (or « relecteur automatique ») → a file write approved by the reviewer and executed;
 * add « agenda »/« calendar » → a calendar write (no restore point); add « refus »/« reject » → a refusal by the
 * reviewer (no bubble, like the core: the card goes back to the humans once revoked). The approval bubble follows the
 * core (`BubbleHub.auto_review_decided` / `approval_changed`). The restore reports the second file as modified since the write (a conflict), like the core does when the
 * file's fingerprint changed.
 *
 * Routes: `POST /v1/approvals/{id}/auto-review/revoke`, `POST /v1/approvals/{id}/auto-review/rollback`.
 * `MOCK_AUTO_REVIEW=off` → 404, like a core whose reviewer is off.
 */
import { argsSha256, type Approval, type ApprovalBubbleState, type AutoReviewRollbackOffer } from "@nokker-apps/sdk";
import { createBubble, updateBubble } from "./bubbles.js";
import { randomId, type MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;

interface Point {
  files: string[];
  /** Files modified since the write: never overwritten. */
  changed: string[];
  applied: boolean;
  appliedAt?: string;
}

const points = new WeakMap<MockState, Map<string, Point>>();
const pointsOf = (state: MockState): Map<string, Point> => {
  let m = points.get(state);
  if (!m) points.set(state, (m = new Map()));
  return m;
};

const NO_POINT = "aucun point de retour pour cette carte";

/** Chat demo; `null` when the message is not about the automatic review. */
export function autoReviewDemo(state: MockState, threadId: string, n: string): string | null {
  if (!/\b(auto-?review|relecteur automatique)\b/.test(n)) return null;
  if (process.env.MOCK_AUTO_REVIEW === "off") return null;
  const refuse = /\b(refus|refuse|reject)\b/.test(n);
  const calendar = /\b(agenda|calendar)\b/.test(n);
  const now = new Date().toISOString();
  const files = ["notes/plan.md", "src/settings.json"];
  const [tool, args, reason] = calendar
    ? (["calendar_create_event", { title: "Team sync", start: "2026-11-05T10:00", end: "2026-11-05T10:30" }, "Calendar entry the request asked for."] as const)
    : (["write_file", { path: files[0], also: files[1], content: "(demo)" }, "File write inside the working folder, as the request asked."] as const);
  const approval: Approval = {
    id: randomId("appr"),
    thread_id: threadId,
    turn_index: state.threads.get(threadId)?.turns.length ?? 0,
    channel: "web",
    tool_name: tool,
    arguments: { ...args },
    args_sha256: argsSha256({ ...args }),
    effect: "write",
    rule: "effect:write",
    reason: calendar ? "Create a calendar entry (demo)." : "Write two files in the working folder (demo).",
    advice: null,
    strength: "standard",
    status: refuse ? "rejected" : "executed",
    created_at: now,
    expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    decided_by: "auto-review",
    decided_via: "auto-review",
    decided_at: now,
    result_summary: refuse ? null : calendar ? "Event created (demo)." : "2 files written (demo).",
    error: null,
    auto_review: {
      decision: refuse ? "reject" : "approve",
      reason: refuse ? "The request does not mention this change." : reason,
      model: "mock-reviewer",
      at: now,
      by_rule: false,
    },
  };
  state.approvals.set(approval.id, approval);
  if (!refuse && !calendar) pointsOf(state).set(approval.id, { files, changed: [files[1]!], applied: false });
  state.publish({ type: "approval.requested", approval });
  state.publish({ type: "approval.decided", approval_id: approval.id, decision: approval.status, by: "auto-review", via: "auto-review" });
  // Like the core (`BubbleHub.auto_review_decided`): a bubble for an automatic APPROVAL only, once the tool ran;
  // none for a refusal or an escalation.
  if (!refuse) createBubble(state, threadId || null, { kind: "approval", title: tool, status: "done", state: bubbleState(approval) });
  return refuse
    ? "The automatic review refused this action (demo)."
    : calendar
      ? "The automatic review approved the calendar entry (demo). You can revoke it on the card."
      : "The automatic review approved the file write (demo). You can revoke it on the card, then restore the files.";
}

/** State of the `approval` bubble of an automatic decision (`BubbleHub._approval_state`). */
function bubbleState(a: Approval, rollbackApplied?: boolean): ApprovalBubbleState {
  const rec = a.auto_review;
  return {
    approval_id: a.id,
    tool_name: a.tool_name,
    status: a.status,
    decision: rec?.decision ?? null,
    decided_via: a.decided_via,
    reason: rec?.reason ?? "",
    revoked: Boolean(rec?.revoked_by),
    ...(rollbackApplied !== undefined ? { rollback_applied: rollbackApplied } : {}),
  };
}

/** Revocation or restore: `bubble.updated` on the card's bubbles (`BubbleHub.approval_changed`). */
function approvalChanged(state: MockState, a: Approval, rollbackApplied?: boolean): void {
  for (const b of state.bubbles.values()) {
    if (b.kind !== "approval" || b.closed_at || b.state.approval_id !== a.id) continue;
    const prev = (b.state as ApprovalBubbleState).rollback_applied;
    updateBubble(state, b.id, { state: { ...bubbleState(a, rollbackApplied ?? prev) } });
  }
}

const restoredOf = (p: Point): string[] => p.files.filter((f) => !p.changed.includes(f));

/** `GET /v1/approvals/{id}` of a revoked automatic approval carries its restore point (applied or not). */
export function withRollback(state: MockState, a: Approval): Approval {
  const rec = a.auto_review;
  return rec?.decision === "approve" && rec.revoked_by ? { ...a, rollback: offer(state, a.id) } : a;
}

function offer(state: MockState, id: string): AutoReviewRollbackOffer {
  const p = pointsOf(state).get(id);
  if (!p) return { available: false, checkpoint_id: null, reason: NO_POINT };
  if (p.applied) {
    return { available: false, checkpoint_id: id, files: p.files, reason: "restauration déjà appliquée", applied: true, applied_at: p.appliedAt, restored: restoredOf(p), conflicts: p.changed };
  }
  return { available: true, checkpoint_id: id, files: p.files, applied: false };
}

export async function handleAutoReview(state: MockState, user: string | null, method: string, path: string, send: Send): Promise<boolean> {
  const m = /^\/v1\/approvals\/([^/]+)\/auto-review\/(revoke|rollback)$/.exec(path);
  if (!m || method !== "POST") return false;
  if (process.env.MOCK_AUTO_REVIEW === "off") return send(404, { error: { message: "not found" } }), true;
  if (!user) return send(401, { error: { message: "unauthorized" } }), true;
  const a = state.approvals.get(m[1]!);
  if (!a) return send(404, { error: { message: "approbation inconnue" } }), true;
  const rec = a.auto_review;
  if (m[2] === "revoke") {
    if (!rec || rec.revoked_by) return send(409, { error: { message: "décision automatique déjà révoquée" } }), true;
    if (a.decided_via !== "auto-review" || (rec.decision !== "approve" && rec.decision !== "reject")) {
      return send(409, { error: { message: "aucune décision du relecteur automatique à révoquer" } }), true;
    }
    const now = new Date().toISOString();
    a.auto_review = { ...rec, revoked_by: user, revoked_at: now };
    if (rec.decision === "reject") {
      // Refusal revoked: the card is pending again and goes to the humans.
      a.status = Date.parse(a.expires_at) > Date.now() ? "pending" : "expired";
      a.decided_by = a.decided_via = a.decided_at = null;
    }
    approvalChanged(state, a);
    state.publish({ type: "approval.auto_review_revoked", approval_id: a.id, by: user, decision: rec.decision, status: a.status });
    send(200, withRollback(state, a));
    return true;
  }
  if (!rec || rec.decision !== "approve" || !rec.revoked_by) return send(409, { error: { message: "révoquer d'abord l'approbation automatique" } }), true;
  const p = pointsOf(state).get(a.id);
  if (!p) return send(409, { error: { message: NO_POINT } }), true;
  if (p.applied) return send(409, { error: { message: "restauration déjà appliquée" } }), true;
  p.applied = true;
  p.appliedAt = new Date().toISOString();
  approvalChanged(state, a, true);
  send(200, { approval_id: a.id, checkpoint_id: a.id, restored: restoredOf(p), conflicts: p.changed });
  return true;
}
