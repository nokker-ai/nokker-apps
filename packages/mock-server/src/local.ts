/**
 * Sessions de code locales du mock (LOKKAL.md §7.4) : scénario réaliste « corrige le test X » —
 * read_file → search_files → patch (write) → terminal pytest (write) → terminal `rm -rf build`
 * (destructive → carte d'approbation locale). Aucun outil n'est réellement exécuté.
 *
 * Mode par défaut `accept_edits` : patch / write_file passent sans carte ; `terminal` (pytest, build) demande une
 * carte locale, le destructif une carte « forte-locale » (sans « toujours »), sauf règle `allow` (fichier de
 * réglages ou règle de session). `deny`, `plan` et hardline refusent sans carte (hardline : tool.result en erreur).
 */
import { basename, isAbsolute, relative, resolve } from "node:path";
import {
  argsSha256,
  decide,
  suggestRules,
  type Approval,
  type LocalToolEffect,
} from "@nokker-apps/sdk";
import { LOCAL_OWNER, MockState, normalize, randomId, type ApprovalOutcome } from "./state.js";

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
  return basename(resolve(cwd)) || "racine";
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

function scenarioFor(text: string): { kind: "fix" | "hardline" | "delegate" | "plain"; test: string } {
  const n = normalize(text);
  const test = text.match(/\btest[\s_:]*([\w./-]+)/i)?.[1] ?? "test_app";
  if (/rm -rf \/|mkfs|fork bomb|efface tout le disque/.test(n)) return { kind: "hardline", test };
  if (/sous-?agent|delegu|en parallele/.test(n)) return { kind: "delegate", test };
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
  const folder = meta ? localTitle(meta.cwd) : "dossier";
  const testFile = sc.test.includes(".") ? sc.test : `tests/${sc.test.startsWith("test_") ? sc.test : `test_${sc.test}`}.py`;
  const steps: Step[] = [];
  let rejected = false;

  if (sc.kind === "plain") {
    await sleep(state, 120, signal);
    return signal.aborted
      ? { reply: "", cancelled: true }
      : { reply: `Session locale sur « ${folder} ». Demande-moi par exemple « corrige le test ${sc.test} ».`, cancelled: false };
  }
  if (sc.kind === "hardline") {
    steps.push({ name: "terminal", effect: "destructive", args: { command: "rm -rf /" }, ms: 40, preview: "" });
  } else if (sc.kind === "delegate") {
    const r = await runDelegate(state, threadId, turnId, signal);
    return r;
  } else {
    steps.push(
      { name: "read_file", effect: "read", args: { path: testFile }, ms: 12, preview: `def test_add():\n    assert add(2, 3) == 5\n# ${testFile}` },
      { name: "search_files", effect: "read", args: { pattern: "def add", path: "src" }, ms: 31, preview: "src/app.py:3: def add(a, b):\n1 résultat" },
      {
        name: "patch",
        effect: "write",
        args: { path: "src/app.py", old: "return a - b", new: "return a + b" },
        ms: 120,
        preview: "--- src/app.py\n-    return a - b\n+    return a + b",
      },
      { name: "terminal", effect: "write", args: { command: `pytest -q ${testFile}` }, ms: 480, preview: ".                                  [100%]\n1 passed in 0.12s" },
      { name: "terminal", effect: "destructive", args: { command: "rm -rf build" }, ms: 60, preview: "build/ supprimé" },
    );
  }

  for (const step of steps) {
    if (signal.aborted) return { reply: "", cancelled: true };
    const callId = randomId("call");
    const shownArgs = redactArgs(step.args);
    state.publish({ type: "tool.call", thread_id: threadId, turn_id: turnId, call_id: callId, name: step.name, effect: step.effect, args: shownArgs });
    const hard = step.name === "terminal" && isHardline(String(step.args.command ?? ""));
    // Hardline : refus direct SANS carte, l'outil revient en erreur (permissions:hardline).
    const verdict = hard ? "deny" : decide(state.effectiveSettings(threadId), step.name, step.args, step.effect);
    let ok = step.ok ?? true;
    let preview = step.preview;
    if (hard) {
      ok = false;
      preview = "refusé : commande interdite (hardline)";
    } else if (verdict === "deny") {
      ok = false;
      preview = "refusé par une règle (deny)";
    } else if (verdict === "ask") {
      const outcome = await askLocalApproval(state, threadId, turnId, step);
      if (outcome === "cancelled") {
        state.publish({ type: "tool.result", thread_id: threadId, turn_id: turnId, call_id: callId, name: step.name, is_error: true, ms: 0, effect: step.effect, preview: "annulé" });
        return { reply: "", cancelled: true };
      }
      if (outcome !== "approved") {
        ok = false;
        rejected = true;
        preview = outcome === "expired" ? "approbation expirée — refusé" : "refusé par l'utilisateur";
      }
    }
    if (ok) await sleep(state, step.ms, signal);
    if (signal.aborted) {
      state.publish({ type: "tool.result", thread_id: threadId, turn_id: turnId, call_id: callId, name: step.name, is_error: true, ms: step.ms, effect: step.effect, preview: "annulé" });
      return { reply: "", cancelled: true };
    }
    state.publish({ type: "tool.result", thread_id: threadId, turn_id: turnId, call_id: callId, name: step.name, is_error: !ok, ms: ok ? step.ms : 0, effect: step.effect, preview: preview.split("\n").slice(0, 3).join("\n") });
  }

  if (sc.kind === "hardline") {
    return { reply: "Cette commande est interdite par le noyau, je ne l'exécute pas.", cancelled: false };
  }
  return {
    reply: rejected
      ? `J'ai corrigé \`src/app.py\` (add retournait a - b) et le test ${sc.test} passe. Je n'ai pas nettoyé \`build/\` : suppression refusée.`
      : `J'ai corrigé \`src/app.py\` (add retournait a - b), le test ${sc.test} passe et \`build/\` est nettoyé.`,
    cancelled: false,
  };
}

async function runDelegate(state: MockState, threadId: string, turnId: string, signal: AbortSignal): Promise<LocalTurnResult> {
  const callId = randomId("call");
  const goal = "lire les tests et proposer un correctif";
  state.publish({ type: "tool.call", thread_id: threadId, turn_id: turnId, call_id: callId, name: "delegate", effect: "write", args: { goal } });
  const child = randomId("sa");
  state.publish({ type: "subagent.started", thread_id: threadId, parent_turn: turnId, child_id: child, goal });
  for (const tool of ["read_file", "search_files", "patch"]) {
    await sleep(state, 60, signal);
    if (signal.aborted) return { reply: "", cancelled: true };
    state.publish({ type: "subagent.progress", thread_id: threadId, child_id: child, tool, ms: 20 });
  }
  state.publish({ type: "subagent.finished", thread_id: threadId, child_id: child, status: "ok", commits: 1, dirty: false });
  state.publish({ type: "tool.result", thread_id: threadId, turn_id: turnId, call_id: callId, name: "delegate", is_error: false, ms: 180, effect: "write", preview: "sous-agent terminé : 1 commit" });
  return { reply: "Le sous-agent a terminé : un commit sur sa branche, arbre propre.", cancelled: false };
}

/** Émet la carte `local`, attend la décision (une fois / session / toujours se règle dans la route de décision). */
export async function askLocalApproval(
  state: MockState,
  threadId: string,
  turnId: string,
  step: Pick<Step, "name" | "effect" | "args">,
  onCreated?: (approval: Approval) => void,
  channel: Approval["channel"] = "cli",
): Promise<ApprovalOutcome> {
  const args = redactArgs(step.args);
  const approval: Approval = {
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
        ? "Commande destructive dans le dossier de travail."
        : step.effect === "write"
          ? "Commande qui modifie le dossier de travail."
          : "Action à effet externe.",
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
    // Carte destructive = « forte-locale » : jamais d'« always » (aucune règle proposée).
    suggested_rules: step.effect === "destructive" ? [] : suggestRules(step.name, step.args),
  };
  state.approvals.set(approval.id, approval);
  const waiter = new Promise<ApprovalOutcome>((res) => state.approvalWaiters.set(approval.id, res));
  // L'événement ne porte pas `suggested_rules` : la CLI récupère la carte par GET /v1/local/approvals.
  const { suggested_rules: _rules, ...onWire } = approval;
  void _rules;
  state.publish({ type: "approval.requested", approval: onWire });
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
    approval.result_summary = "exécuté (démo locale).";
  }
  return outcome;
}
