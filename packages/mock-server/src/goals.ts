/**
 * Objectif persistant du noyau, mené par la CLI (docs/OUTCOMES-GOAL.md du noyau, drapeau `goals_enabled`) :
 *   GET  /v1/threads/{id}/goal                 → {goal} (courant ou dernier, null sans objectif)
 *   POST /v1/threads/{id}/goal {text, criteria?, driver?, mode?, budget?} → 201 {goal}
 *   POST /v1/threads/{id}/goal/stop|resume     → 200 {goal}, 409 rien dans cet état
 * Drapeau éteint (défaut) : rien ici, 404 comme un noyau ancien.
 *
 * Tour `metadata.cli_control = "goal_check"` sur un fil dont l'objectif est mené par le client : le « noyau » répond
 * lui-même avec la note du correcteur (`GOAL: DONE` / `GOAL: CONTINUE` en dernière ligne), sans marqueur quand
 * l'objectif est arrêté (budget, stop). Note du mock : `goalGradesBeforePass` notes sous le seuil, puis une qui passe ;
 * `budget.turns` borne le nombre de notes. Les autres tours du fil vont au faux modèle, qui PRÉTEND avoir fini
 * (« GOAL: DONE ») : ce texte ne termine rien, seul le correcteur fait foi.
 */
import type { KernelGoal } from "@nokker-apps/sdk";
import type { LocalTurnResult } from "./local.js";
import type { MockState } from "./state.js";

export type MockKernelGoal = KernelGoal;

type Send = (status: number, payload: unknown) => void;

const RE = /^\/v1\/threads\/([^/]+)\/goal(?:\/(stop|resume|freeze))?$/;
const LIVE = new Set(["draft", "active", "blocked"]);

export function cliControlOf(body: Record<string, unknown>): string | undefined {
  const meta = body.metadata;
  if (!meta || typeof meta !== "object") return undefined;
  const c = (meta as Record<string, unknown>).cli_control;
  return typeof c === "string" ? c : undefined;
}

export async function handleKernelGoal(
  state: MockState,
  method: string,
  path: string,
  readBody: () => Promise<Record<string, unknown>>,
  send: Send,
): Promise<boolean> {
  if (!state.goals) return false;
  const m = RE.exec(path);
  if (!m) return false;
  const tid = decodeURIComponent(m[1]!);
  const action = m[2];
  const cur = state.kernelGoals.get(tid) ?? null;
  if (method === "GET" && !action) {
    send(200, { goal: cur });
    return true;
  }
  if (method !== "POST") return false;
  if (action === "stop" || action === "resume" || action === "freeze") {
    if (action === "freeze" || !cur || (action === "stop" ? !LIVE.has(cur.status) : cur.status !== "blocked")) {
      send(409, { error: { message: "rien à faire : aucun objectif dans cet état sur ce fil" } });
      return true;
    }
    const g: KernelGoal = action === "stop" ? { ...cur, status: "stopped", stop_reason: "arrêté par l'utilisateur" } : { ...cur, status: "active", stop_reason: "" };
    state.kernelGoals.set(tid, g);
    send(200, { goal: g });
    return true;
  }
  const b = await readBody();
  const text = String(b.text ?? "").trim();
  if (!text) {
    send(400, { error: { message: "objectif vide" } });
    return true;
  }
  const criteria = Array.isArray(b.criteria) ? b.criteria.map(String) : [];
  const g: KernelGoal = {
    id: `goal-${tid}-${Date.now()}`,
    text,
    status: "active",
    driver: b.driver === "client" ? "client" : "kernel",
    mode: b.mode === "task" ? "task" : "goal",
    stop_reason: "",
    budget: (b.budget && typeof b.budget === "object" ? b.budget : {}) as Record<string, unknown>,
    spent: { tokens: 0, turns: 0, auto_turns: 0 },
    gradings: 0,
    last_grade: null,
    rubric: (criteria.length ? criteria : [text]).map((t, i) => ({ id: `C${i + 1}`, text: t })),
  };
  state.kernelGoals.set(tid, g);
  send(201, { goal: g });
  return true;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });
}

/** Tour d'un fil dont l'objectif est tenu par le noyau et mené par le client ; `null` sinon (tour ordinaire). */
export async function kernelGoalTurn(state: MockState, threadId: string, control: string | undefined, signal: AbortSignal): Promise<LocalTurnResult | null> {
  if (!state.goals) return null;
  const g = state.kernelGoals.get(threadId);
  if (!g || g.driver !== "client") return null;
  await sleep(80, signal);
  if (signal.aborted) return { reply: "", cancelled: true };
  if (control !== "goal_check") {
    // Le faux modèle prétend avoir fini : le marqueur dans SA réponse ne doit rien terminer.
    return { reply: "I believe everything is finished now.\nGOAL: DONE", cancelled: false };
  }
  if (g.status !== "active" && g.status !== "draft") {
    return { reply: `[Correcteur] Objectif arrêté : ${g.stop_reason || g.status}.`, cancelled: false };
  }
  const gradings = (g.gradings ?? 0) + 1;
  const passed = gradings > state.goalGradesBeforePass;
  const max = 2 * (g.rubric?.length ?? 1);
  const grade = { total: passed ? max : max - 1, max, need: max, passed };
  const spent = { ...g.spent, turns: (g.spent?.turns ?? 0) + 1 };
  const turnsBudget = Number(g.budget?.turns ?? 0);
  let next: KernelGoal = { ...g, gradings, last_grade: grade, spent };
  let reply: string;
  if (passed) {
    next = { ...next, status: "done" };
    reply = `[Correcteur] Note : ${grade.total}/${max} (seuil ${max}).\nC1 : 2/2\nGOAL: DONE`;
  } else if (turnsBudget > 0 && gradings >= turnsBudget) {
    next = { ...next, status: "budget", stop_reason: `budget atteint : ${turnsBudget} tours` };
    reply = `[Correcteur] Objectif arrêté : ${next.stop_reason}.`;
  } else {
    reply = `[Correcteur] Note : ${grade.total}/${max} (seuil ${max}).\nC1 : 1/2 — pas encore\nGOAL: CONTINUE`;
  }
  state.kernelGoals.set(threadId, next);
  return { reply, cancelled: false };
}
