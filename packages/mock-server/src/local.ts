/**
 * Sessions de code locales du mock (LOKKAL.md §7.4) : scénario réaliste « corrige le test X » —
 * read_file → search_files → patch (write) → terminal pytest (write) → terminal `rm -rf build`
 * (destructive → carte d'approbation locale). Aucun outil n'est réellement exécuté.
 *
 * Mode par défaut `accept_edits` : patch / write_file passent sans carte ; `terminal` (pytest, build) demande une
 * carte locale, le destructif une carte « forte-locale » (sans « toujours »), sauf règle `allow` (fichier de
 * réglages ou règle de session). `deny`, `plan` et hardline refusent sans carte (hardline : tool.result en erreur).
 *
 * Avant le premier appel non-READ exécuté d'un tour, un point de retour automatique (`autoCheckpoint`, comme le noyau).
 * `state.localWrites` : `patch` et `write_file` écrivent vraiment dans le dossier de la session.
 */
import { basename, isAbsolute, relative, resolve } from "node:path";
import {
  argsSha256,
  decide,
  suggestRules,
  type Approval,
  type ApprovalContinuation,
  type LocalToolEffect,
} from "@nokker-apps/sdk";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { streamToolInput } from "./live-input.js";
import { autoCheckpoint } from "./localtools.js";
import { LOCAL_OWNER, MockState, normalize, randomId, type ApprovalOutcome } from "./state.js";
import { publishTurnCost } from "./cost.js";
import { children, type MockChild } from "./project.js";

const APPROVAL_TTL_MS = 300_000;

/** Commandes qu'aucune décision ne peut approuver (rm -rf /, mkfs, dd sur disque, fork bomb). */
export function isHardline(command: string): boolean {
  const c = command.trim().replace(/\s+/g, " ");
  if (/(^|[;&|] ?)rm (-[a-zA-Z]*[rf][a-zA-Z]* ?)+(--no-preserve-root )?(\/|\/\*|~|~\/|\$HOME)( |$)/.test(c)) return true;
  if (/(^|[;&|] ?)(sudo )?mkfs(\.\w+)?( |$)/.test(c)) return true;
  if (/(^|[;&|] ?)(sudo )?dd .*of=\/dev\/(sd|nvme|vd|hd|mmcblk)/.test(c)) return true;
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(c)) return true;
  return false;
}

/** Dossier sous une racine déclarée ? Renvoie la racine, `null` sinon. `roots === null` : tout accepter. */
export function rootFor(cwd: string, roots: string[] | null): string | null {
  const abs = resolve(cwd);
  if (!roots) return abs;
  for (const r of roots) {
    const root = resolve(r);
    const rel = relative(root, abs);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return root;
  }
  return null;
}

export function localTitle(cwd: string): string {
  return basename(resolve(cwd)) || "root";
}

/** Caviardage : secrets masqués, gros champs tronqués à 200 caractères. */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (/token|secret|password|passwd|api[_-]?key|authorization/i.test(k)) out[k] = "***";
    else if (typeof v === "string" && v.length > 200) out[k] = `${v.slice(0, 200)}…`;
    else out[k] = v;
  }
  return out;
}

export interface LocalTurnResult {
  reply: string;
  cancelled: boolean;
}

interface Step {
  name: string;
  effect: LocalToolEffect;
  args: Record<string, unknown>;
  ms: number;
  ok?: boolean;
  preview: string;
  /** Écriture en direct (X22) : ce que le « modèle » écrit, montré avant le `tool.call`. */
  live?: { field: "content" | "new_string" | "patch"; text: string };
}

function sleep(state: MockState, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    if (signal.aborted) return resolveSleep();
    const t = setTimeout(done, Math.max(0, Math.round(ms * state.speed)));
    function done(): void {
      signal.removeEventListener("abort", done);
      clearTimeout(t);
      resolveSleep();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function scenarioFor(text: string): { kind: "fix" | "hardline" | "delegate" | "background" | "plain"; test: string } {
  const n = normalize(text);
  const test = text.match(/\btest[\s_:]*([\w./-]+)/i)?.[1] ?? "test_app";
  if (/rm -rf \/|mkfs|fork bomb|efface tout le disque|wipe the (?:whole|entire) disk/.test(n)) return { kind: "hardline", test };
  if (/arriere-plan|background/.test(n)) return { kind: "background", test };
  if (/sous-?agent|sub-?agent|delegu|delegate|en parallele|in parallel/.test(n)) return { kind: "delegate", test };
  if (/(corrig|repar|fix|debug)/.test(n) && /test/.test(n)) return { kind: "fix", test };
  return { kind: "plain", test };
}

export async function runLocalTurn(
  state: MockState,
  threadId: string,
  turnId: string,
  userText: string,
  signal: AbortSignal,
): Promise<LocalTurnResult> {
  const sc = scenarioFor(userText);
  const meta = state.localSessions.get(threadId);
  const folder = meta ? localTitle(meta.cwd) : "folder";
  const testFile = sc.test.includes(".") ? sc.test : `tests/${sc.test.startsWith("test_") ? sc.test : `test_${sc.test}`}.py`;
  const steps: Step[] = [];
  let rejected = false;

  if (sc.kind === "plain") {
    await sleep(state, 120, signal);
    return signal.aborted
      ? { reply: "", cancelled: true }
      : { reply: `Local session on “${folder}”. Ask me for example “fix test ${sc.test}”.`, cancelled: false };
  }
  if (sc.kind === "hardline") {
    steps.push({ name: "terminal", effect: "destructive", args: { command: "rm -rf /" }, ms: 40, preview: "" });
  } else if (sc.kind === "delegate") {
    const r = await runDelegate(state, threadId, turnId, signal);
    return r;
  } else if (sc.kind === "background") {
    return runBackgroundDelegate(state, threadId, turnId);
  } else {
    steps.push(
      { name: "read_file", effect: "read", args: { path: testFile }, ms: 12, preview: `def test_add():\n    assert add(2, 3) == 5\n# ${testFile}` },
      { name: "search_files", effect: "read", args: { pattern: "def add", path: "src" }, ms: 31, preview: "src/app.py:3: def add(a, b):\n1 result" },
      {
        name: "patch",
        effect: "write",
        args: { path: "src/app.py", old: "return a - b", new: "return a + b" },
        ms: 120,
        preview: "--- src/app.py\n-    return a - b\n+    return a + b",
        live: {
          field: "new_string",
          text: 'def add(a, b):\n    """Sum of a and b."""\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n',
        },
      },
      { name: "terminal", effect: "write", args: { command: `pytest -q ${testFile}` }, ms: 480, preview: ".                                  [100%]\n1 passed in 0.12s" },
      { name: "terminal", effect: "destructive", args: { command: "rm -rf build" }, ms: 60, preview: "build/ removed" },
    );
  }

  const r = await runSteps(state, threadId, turnId, steps, signal);
  if (r.cancelled) return { reply: "", cancelled: true };
  if (r.pending) {
    // Style `kernel` : le tour s'arrête sur la carte ; une approbation lancera la suite (`continueAfterDecision`).
    const { pending, pendingStep, rest } = r;
    state.continuations.set(pending.id, {
      threadId,
      run: () => continueAfterDecision(state, threadId, pending, pendingStep!, rest, sc.test),
    });
    return { reply: `The command \`${String(pending.arguments.command ?? pending.tool_name)}\` is waiting for your approval on the card.`, cancelled: false };
  }
  rejected = r.rejected;

  if (sc.kind === "hardline") {
    return { reply: "The core forbids this command, I am not running it.", cancelled: false };
  }
  return {
    reply: rejected
      ? `I fixed \`src/app.py\` (add returned a - b) and test ${sc.test} passes. I did not clean \`build/\`: deletion refused.`
      : `I fixed \`src/app.py\` (add returned a - b), test ${sc.test} passes and \`build/\` is cleaned up.`,
    cancelled: false,
  };
}

/** Joue des étapes d'outil ; en style `kernel`, s'arrête sur la première carte (`pending`, étapes restantes dans `rest`). */
async function runSteps(
  state: MockState,
  threadId: string,
  turnId: string,
  steps: Step[],
  signal: AbortSignal,
): Promise<{ cancelled: boolean; rejected: boolean; pending?: Approval; pendingStep?: Step; rest: Step[] }> {
  let rejected = false;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (signal.aborted) return { cancelled: true, rejected, rest: [] };
    const callId = randomId("call");
    const shownArgs = redactArgs(step.args);
    if (step.live && (step.name === "write_file" || step.name === "patch")) {
      await streamToolInput(state, { threadId, turnId, callId, name: step.name, path: String(step.args.path ?? ""), ...step.live }, signal);
      if (signal.aborted) return { cancelled: true, rejected, rest: [] };
    }
    state.publish({ type: "tool.call", thread_id: threadId, turn_id: turnId, call_id: callId, name: step.name, effect: step.effect, args: shownArgs });
    const hard = step.name === "terminal" && isHardline(String(step.args.command ?? ""));
    // Hardline : refus direct SANS carte, l'outil revient en erreur (permissions:hardline).
    const verdict = hard ? "deny" : decide(state.effectiveSettings(threadId), step.name, step.args, step.effect);
    let ok = step.ok ?? true;
    let preview = step.preview;
    let approvalId: string | undefined;
    if (hard) {
      ok = false;
      preview = "refusé : commande interdite (hardline)";
    } else if (verdict === "deny") {
      ok = false;
      preview = "refusé par une règle (deny)";
    } else if (verdict === "ask" && state.approvalStyle === "kernel") {
      const card = postLocalApproval(state, threadId, turnId, step, "cli", callId);
      state.publish({
        type: "tool.result",
        thread_id: threadId,
        turn_id: turnId,
        call_id: callId,
        name: step.name,
        is_error: false,
        ms: 0,
        effect: step.effect,
        preview: `EN ATTENTE D'APPROBATION HUMAINE (${card.rule}) [approval:${card.id}]. L'action n'a pas été exécutée. L'utilisateur décide sur la carte : ne rappelle pas l'outil.`,
      });
      return { cancelled: false, rejected, pending: card, pendingStep: step, rest: steps.slice(i + 1) };
    } else if (verdict === "ask") {
      const outcome = await askLocalApproval(state, threadId, turnId, step, (a) => (approvalId = a.id), "cli", callId);
      if (outcome === "cancelled") {
        state.publish({ type: "tool.result", thread_id: threadId, turn_id: turnId, call_id: callId, name: step.name, is_error: true, ms: 0, effect: step.effect, preview: "annulé" });
        return { cancelled: true, rejected, rest: [] };
      }
      if (outcome !== "approved") {
        ok = false;
        rejected = true;
        preview = outcome === "expired" ? "approbation expirée — refusé" : "refusé par l'utilisateur";
        approvalId = undefined;
      }
    }
    if (ok && step.effect !== "read") autoCheckpoint(state, threadId, turnId, step.name);
    if (ok) await sleep(state, step.ms, signal);
    if (ok && !signal.aborted && state.localWrites) {
      const w = await applyWrite(state, threadId, step);
      if (w) {
        ok = false;
        preview = w;
      }
    }
    if (signal.aborted) {
      state.publish({ type: "tool.result", thread_id: threadId, turn_id: turnId, call_id: callId, name: step.name, is_error: true, ms: step.ms, effect: step.effect, preview: "annulé" });
      return { cancelled: true, rejected, rest: [] };
    }
    state.publish({
      type: "tool.result",
      thread_id: threadId,
      turn_id: turnId,
      call_id: callId,
      name: step.name,
      is_error: !ok,
      ms: ok ? step.ms : 0,
      effect: step.effect,
      preview: preview.split("\n").slice(0, 3).join("\n"),
      // Outil exécuté après sa carte : le résultat porte la carte, comme celui de l'exécuteur du noyau.
      ...(approvalId ? { approval_id: approvalId } : {}),
    });
  }
  return { cancelled: false, rejected, rest: [] };
}

/** `localWrites` : `patch {path, old, new}` remplace le passage, `write_file {path, content}` écrit le fichier, dans le
 * dossier de la session. Rend l'erreur (passage introuvable, chemin hors du dossier), `null` si c'est écrit. */
async function applyWrite(state: MockState, threadId: string, step: Step): Promise<string | null> {
  if (step.name !== "patch" && step.name !== "write_file") return null;
  const cwd = state.localSessions.get(threadId.split("/sa-")[0]!)?.cwd;
  const rel = typeof step.args.path === "string" ? step.args.path : "";
  if (!cwd || !rel) return null;
  const target = resolve(cwd, rel);
  const rootRel = relative(cwd, target);
  if (rootRel.startsWith("..") || isAbsolute(rootRel)) return `chemin hors du dossier : ${rel}`;
  if (step.name === "write_file") {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, String(step.args.content ?? ""));
    return null;
  }
  const old = String(step.args.old ?? step.args.old_string ?? "");
  const now = String(step.args.new ?? step.args.new_string ?? "");
  let text: string;
  try {
    text = await readFile(target, "utf-8");
  } catch {
    return `fichier introuvable : ${rel}`;
  }
  if (!old || !text.includes(old)) return `passage introuvable dans ${rel}`;
  await writeFile(target, text.replace(old, now));
  return null;
}

/** Style `kernel`, après une APPROBATION, verrou du fil tenu (`scheduleLocalDecision`) — comme l'exécuteur du noyau
 * (LOKKAL.md §7.4.9) : l'outil de la carte s'exécute, son `tool.result` part avec le `call_id` de l'appel resté en
 * attente, `approval_id` et le `turn_id` du tour qui a posé la carte ; puis un tour de suite joue les étapes restantes,
 * éventuellement arrêtées sur une nouvelle carte. */
async function continueAfterDecision(
  state: MockState,
  threadId: string,
  card: Approval,
  step: Step,
  rest: Step[],
  test: string,
): Promise<void> {
  const ran = new AbortController();
  if (step.effect !== "read") autoCheckpoint(state, threadId, `${card.thread_id}:${card.turn_index}`, step.name);
  await sleep(state, step.ms, ran.signal);
  card.status = "executed";
  card.result_summary = step.preview.split("\n")[0] ?? "executed";
  state.publish({
    type: "tool.result",
    thread_id: card.thread_id,
    turn_id: `${card.thread_id}:${card.turn_index}`,
    ...(card.call_id ? { call_id: card.call_id } : {}),
    approval_id: card.id,
    name: card.tool_name,
    ok: true,
    is_error: false,
    preview: step.preview.slice(0, 1200),
    ms: step.ms,
  });

  const rec = state.ensureThread(threadId, "");
  const turnId = `${threadId}:${rec.turns.length}`;
  const block = `[Approbation]\nOutil : ${card.tool_name}\nDécision : approved\n[/Approbation]`;
  state.publish({ type: "turn.started", thread_id: threadId, turn_id: turnId });
  const ctl = new AbortController();
  state.activeTurns.set(threadId, { turnId, abort: ctl });
  let reply: string;
  let cancelled = false;
  try {
    const r = await runSteps(state, threadId, turnId, rest, ctl.signal);
    if (r.cancelled) {
      reply = "";
      cancelled = true;
    } else if (r.pending) {
      const { pending, pendingStep, rest: left } = r;
      state.continuations.set(pending.id, { threadId, run: () => continueAfterDecision(state, threadId, pending, pendingStep!, left, test) });
      reply = `The command \`${String(pending.arguments.command ?? pending.tool_name)}\` is waiting for your approval on the card.`;
    } else reply = `Test ${test} passes.${r.rejected ? " One action was refused." : ""}`;
  } finally {
    state.activeTurns.delete(threadId);
  }
  state.appendTurn(threadId, block, cancelled ? "(turn cancelled)" : reply, { sender: null, channel: "cli", silent: true });
  state.publish({ type: "turn.delta", thread_id: threadId, turn_id: turnId, text: reply });
  publishTurnCost(state, threadId, turnId, block, reply);
  state.publish({
    type: "turn.done",
    thread_id: threadId,
    turn_id: turnId,
    usage: { prompt_tokens: block.length, completion_tokens: reply.length, total_tokens: block.length + reply.length },
    tier: "mock",
    ...(cancelled ? { cancelled: true } : {}),
  });
}

/**
 * Suite d'une carte locale décidée (route `/v1/local/approvals/{id}/decide`), sans l'attendre — LOKKAL.md §7.4.3/§7.4.9.
 * Style `kernel` : une approbation prend sa place dans la file du fil (`queued` si un tour tourne ou attend, `running`
 * sinon) ; l'outil puis le tour de suite tournent quand vient son tour ; un fil annulé entre-temps abandonne la suite
 * (carte `failed`, `tool.result` en erreur). Un refus ne lance rien (`none`). Style `inline` : le tour en cours attend
 * la décision et exécute l'outil lui-même (`running`).
 */
export function scheduleLocalDecision(state: MockState, approval: Approval): ApprovalContinuation {
  const cont = state.continuations.get(approval.id);
  state.continuations.delete(approval.id);
  const waiter = state.approvalWaiters.get(approval.id);
  if (approval.status !== "approved") {
    waiter?.("rejected");
    return "none";
  }
  if (!cont) {
    waiter?.("approved"); // l'action s'exécute, puis le tour reprend
    return "running";
  }
  const root = cont.threadId.split("/sa-")[0]!;
  const epoch = state.cancelEpochs.get(root) ?? 0;
  const immediate = !state.threadBusy(cont.threadId);
  const place = state.lockThread(cont.threadId);
  void (async () => {
    const release = await place;
    try {
      if ((state.cancelEpochs.get(root) ?? 0) !== epoch) {
        approval.status = "failed";
        approval.error = "annulé par l'utilisateur";
        state.publish({
          type: "tool.result",
          thread_id: approval.thread_id,
          turn_id: `${approval.thread_id}:${approval.turn_index}`,
          ...(approval.call_id ? { call_id: approval.call_id } : {}),
          approval_id: approval.id,
          name: approval.tool_name,
          ok: false,
          is_error: true,
          preview: "annulé par l'utilisateur",
        });
        return;
      }
      await cont.run();
    } catch {
      // le mock ne lève pas ici ; une suite cassée ne doit pas bloquer la file
    } finally {
      release();
    }
  })();
  return immediate ? "running" : "queued";
}

/** Numéro du tour en cours du fil (le noyau publie `parent_turn` en entier). */
function turnIndex(state: MockState, threadId: string): number {
  return state.threads.get(threadId)?.turns.length ?? 0;
}

function newChild(state: MockState, threadId: string, goal: string, index: number, background: boolean): MockChild {
  const id = randomId("sa").replace(/^sa_?/, "").slice(0, 8);
  const c: MockChild = {
    parent: threadId,
    background,
    created: Date.now(),
    abort: new AbortController(),
    done: false,
    view: {
      child_id: id,
      thread_id: `${threadId}/sa-${id}`,
      task_index: index,
      goal,
      elapsed_s: 0,
      status: "queued",
      worktree: { path: `/workspace/.nokker/worktrees/${id}`, branch: `nokker/sa-${id}` },
    },
  };
  children(state).set(id, c);
  return c;
}

/** Un enfant : lecture, recherche, patch (`subagent.progress` par outil) puis `subagent.finished` (forme du noyau). */
async function runChild(state: MockState, c: MockChild, tools: string[], stepMs: number, outer?: AbortSignal): Promise<void> {
  const signal = outer ?? c.abort.signal;
  c.view.status = "running";
  let cancelled = false;
  for (const tool of tools) {
    await sleep(state, stepMs, c.abort.signal);
    if (c.abort.signal.aborted || signal.aborted) {
      cancelled = true;
      break;
    }
    c.view.last_tool = tool;
    state.publish({ type: "subagent.progress", parent_thread_id: c.parent, child_id: c.view.child_id, tool, ms: 20 });
  }
  if (c.done) return; // noyau « redémarré » (restartSubagents) : l'enfant est mort avec lui, rien n'est publié
  const { last_tool: _l, ...rest } = c.view;
  void _l;
  const wt = c.view.worktree!;
  c.view = cancelled
    ? { ...rest, status: "interrupted", exit_reason: "cancelled", summary: "", worktree: { ...wt, commits: 0, dirty: true, kept: true } }
    : { ...rest, status: "completed", exit_reason: "completed", summary: `Read the tests and fixed add() on ${wt.branch}: 1 commit, tests pass.`, worktree: { ...wt, commits: 1, dirty: false, kept: true }, tokens: 4210, cost: 0.0042 };
  c.done = true;
  const w = c.view.worktree!;
  state.publish({
    type: "subagent.finished",
    parent_thread_id: c.parent,
    child_id: c.view.child_id,
    status: c.view.status,
    commits: w.commits ?? 0,
    dirty: w.dirty ?? false,
    kept: w.kept ?? false,
    ...(c.background ? { background: true, exit_reason: c.view.exit_reason ?? null } : {}),
  });
}

async function runDelegate(state: MockState, threadId: string, turnId: string, signal: AbortSignal): Promise<LocalTurnResult> {
  const callId = randomId("call");
  const goal = "read the tests and propose a fix";
  state.publish({ type: "tool.call", thread_id: threadId, turn_id: turnId, call_id: callId, name: "delegate", effect: "write", args: { goal } });
  const c = newChild(state, threadId, goal, 0, false);
  state.publish({ type: "subagent.started", thread_id: threadId, parent_thread_id: threadId, parent_turn: turnIndex(state, threadId), child_id: c.view.child_id, child_thread_id: c.view.thread_id, goal });
  const stop = (): void => c.abort.abort();
  signal.addEventListener("abort", stop, { once: true });
  await runChild(state, c, ["read_file", "search_files", "patch"], 60);
  signal.removeEventListener("abort", stop);
  if (signal.aborted) return { reply: "", cancelled: true };
  state.publish({ type: "tool.result", thread_id: threadId, turn_id: turnId, call_id: callId, name: "delegate", is_error: false, ms: 180, effect: "write", preview: "sub-agent finished: 1 commit" });
  return { reply: "The sub-agent has finished: one commit on its branch, clean tree.", cancelled: false };
}

/** `delegate(tasks, background: true)` (LOKKAL.md §7.22.1) : rend TOUT DE SUITE les ids ; deux enfants tournent ensuite
 * sans tenir le fil (le parent reste libre), suivis par `delegate_status`, arrêtés par l'annulation du fil. */
function runBackgroundDelegate(state: MockState, threadId: string, turnId: string): LocalTurnResult {
  const callId = randomId("call");
  const goals = ["audit the test suite for flaky tests", "update the README examples"];
  state.publish({ type: "tool.call", thread_id: threadId, turn_id: turnId, call_id: callId, name: "delegate", effect: "write", args: { background: true, tasks: goals.map((goal) => ({ goal })) } });
  const kids = goals.map((goal, i) => newChild(state, threadId, goal, i, true));
  for (const c of kids) {
    state.publish({ type: "subagent.started", thread_id: threadId, parent_thread_id: threadId, parent_turn: turnIndex(state, threadId), child_id: c.view.child_id, child_thread_id: c.view.thread_id, goal: c.view.goal, background: true });
    void runChild(state, c, ["read_file", "search_files", "terminal", "patch"], 400);
  }
  const content = { background: true, children: kids.map((c) => ({ ...c.view })), note: "les sous-agents tournent en arrière-plan : delegate_status pour l'état ou le résultat (wait_s pour attendre), delegate_cancel pour arrêter ; tu seras prévenu au tour suivant" };
  state.publish({ type: "tool.result", thread_id: threadId, turn_id: turnId, call_id: callId, name: "delegate", is_error: false, ms: 15, effect: "write", preview: JSON.stringify(content).slice(0, 1200) });
  return { reply: `Two sub-agents are running in the background (${kids.map((c) => c.view.child_id).join(", ")}). /agents to follow them.`, cancelled: false };
}

/** Machine liée (`state.strongRelay`) : une carte forte part chez nokker.ai peu après sa pose, comme le dépôt du noyau
 * (LOKKAL.md §7.3) — `forwarded: true` dans `GET /v1/local/approvals` et l'événement `approval.forwarded`. */
function relayStrongCard(state: MockState, approval: Approval): void {
  if (!state.strongRelay || approval.strength !== "strong") return;
  state.later(state.strongRelayMs, () => {
    if (approval.status !== "pending") return;
    approval.forwarded = true;
    state.publish({ type: "approval.forwarded", approval_id: approval.id, thread_id: approval.thread_id });
  });
}

/** Pose une carte locale SANS l'attendre (style `kernel`). */
export function postLocalApproval(
  state: MockState,
  threadId: string,
  turnId: string,
  step: Pick<Step, "name" | "effect" | "args">,
  channel: Approval["channel"] = "cli",
  callId: string | null = null,
): Approval {
  const approval = newLocalApproval(threadId, turnId, step, channel, callId);
  state.approvals.set(approval.id, approval);
  const { suggested_rules: _rules, forwarded: _fwd, ...onWire } = approval;
  void _rules;
  void _fwd;
  state.publish({ type: "approval.requested", approval: onWire });
  relayStrongCard(state, approval);
  state.later(APPROVAL_TTL_MS, () => {
    if (approval.status !== "pending") return;
    approval.status = "expired";
    state.continuations.delete(approval.id);
    state.publish({ type: "approval.decided", approval_id: approval.id, decision: "expired", by: LOCAL_OWNER, via: "local" });
  });
  return approval;
}

function newLocalApproval(
  threadId: string,
  turnId: string,
  step: Pick<Step, "name" | "effect" | "args">,
  channel: Approval["channel"],
  callId: string | null,
): Approval {
  const args = redactArgs(step.args);
  return {
    id: randomId("appr"),
    thread_id: threadId,
    turn_index: Number(turnId.slice(turnId.lastIndexOf(":") + 1)) || 0,
    channel,
    tool_name: step.name,
    arguments: args,
    args_sha256: argsSha256(args),
    effect: step.effect,
    rule: `effect:${step.effect}`,
    reason:
      step.effect === "destructive"
        ? "Destructive command in the working folder."
        : step.effect === "write"
          ? "Command that modifies the working folder."
          : "Action with an external effect.",
    advice: null,
    // Plus de `strength: "local"` : standard, ou strong pour le destructif (« forte-locale » : once/refuser seulement).
    strength: step.effect === "destructive" ? "strong" : "standard",
    status: "pending",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    decided_by: null,
    decided_via: null,
    decided_at: null,
    result_summary: null,
    error: null,
    call_id: callId,
    // Carte destructive = « forte-locale » : jamais d'« always » (aucune règle proposée).
    suggested_rules: step.effect === "destructive" ? [] : suggestRules(step.name, step.args),
    forwarded: false,
  };
}

/** Émet la carte `local`, attend la décision (une fois / session / toujours se règle dans la route de décision). */
export async function askLocalApproval(
  state: MockState,
  threadId: string,
  turnId: string,
  step: Pick<Step, "name" | "effect" | "args">,
  onCreated?: (approval: Approval) => void,
  channel: Approval["channel"] = "cli",
  callId: string | null = null,
): Promise<ApprovalOutcome> {
  const approval = newLocalApproval(threadId, turnId, step, channel, callId);
  state.approvals.set(approval.id, approval);
  const waiter = new Promise<ApprovalOutcome>((res) => state.approvalWaiters.set(approval.id, res));
  // L'événement ne porte ni `suggested_rules` ni `forwarded` : la CLI récupère la carte par GET /v1/local/approvals.
  const { suggested_rules: _rules, forwarded: _fwd, ...onWire } = approval;
  void _rules;
  void _fwd;
  state.publish({ type: "approval.requested", approval: onWire });
  relayStrongCard(state, approval);
  onCreated?.(approval);
  state.later(APPROVAL_TTL_MS, () => {
    if (approval.status !== "pending") return;
    approval.status = "expired";
    state.publish({ type: "approval.decided", approval_id: approval.id, decision: "expired", by: LOCAL_OWNER, via: "local" });
    state.approvalWaiters.get(approval.id)?.("expired");
  });
  const outcome = await waiter;
  state.approvalWaiters.delete(approval.id);
  if (outcome === "cancelled" && approval.status === "pending") {
    approval.status = "rejected";
    approval.decided_by = LOCAL_OWNER;
    approval.decided_via = "local";
    approval.decided_at = new Date().toISOString();
    state.publish({ type: "approval.decided", approval_id: approval.id, decision: "rejected", by: LOCAL_OWNER, via: "local" });
  }
  if (outcome === "approved") {
    approval.status = "executed";
    approval.result_summary = "executed (local demo).";
  }
  return outcome;
}
