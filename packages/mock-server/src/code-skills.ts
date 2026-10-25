/**
 * Skills du dépôt et sous-agents des sessions de code (LOKKAL §7.28 points 13 et 14, §7.21.8, §7.22.10) — mock.
 * Une session ouverte sur un dépôt a un arbre `.nokker/skills` de démo (2 skills, `untrusted` jusqu'à la confiance du
 * propriétaire) ; sans dépôt : `absent`. Sous-agents : `max_subagents` = 3 ; ils naissent par le réglage de démo (le
 * modèle les lance dans le vrai noyau), publient `subagent.*` et peuvent poser une carte forte sur leur fil
 * `<cs>/sa-<id>`. Réglages, par `POST /v1/dev/code-mock` : `skills: {session, action: "rewrite" | "invalid"}`,
 * `spawn: {session, goal?, card?}`, `finish: {session, child, status?}`.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Approval, CodeSessionSkills, SubagentView } from "@nokker-apps/sdk";
import { approvalBubble, settleApprovalBubbles } from "./demo.js";
import { randomId, type MockState } from "./state.js";

export const MAX_SUBAGENTS = 3;
const ROOT = "/workspace";

interface Kid {
  view: SubagentView;
  started: number;
}
export interface SessionExtras {
  skills: CodeSessionSkills;
  kids: Map<string, Kid>;
}

const SKILLS = [
  { name: "release-notes", category: "docs", description: "Rédige les notes de version depuis les commits du dépôt.", content: "# Notes de version\n\n1. Lire `git log` depuis la dernière étiquette.\n2. Regrouper par type (feat, fix).\n3. Écrire `CHANGELOG.md`.\n", linked_files: ["templates/changelog.md"] },
  { name: "test-runner", category: "dev", description: "Lance la suite de tests du projet et résume les échecs.", content: "# Tests\n\nLancer `npm test`, puis résumer chaque échec en une ligne.\n", linked_files: [] },
];

const sha = (): string => createHash("sha256").update(randomBytes(16)).digest("hex");

export function extrasFor(withRepo: boolean): SessionExtras {
  return {
    skills: withRepo
      ? { enabled: true, project: "untrusted", root: ROOT, sha256: sha(), count: SKILLS.length, notice: `${SKILLS.length} compétence(s) dans .nokker/skills (dépôt de la session) : invisibles tant que tu ne leur fais pas confiance` }
      : { enabled: true, project: "absent", root: ROOT, sha256: null, count: 0, notice: null },
    kids: new Map(),
  };
}

export const liveCount = (x: SessionExtras): number => [...x.kids.values()].filter((k) => ["queued", "running", "stopping"].includes(k.view.status)).length;

export class SkillsErr extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** `POST …/skills/trust {sha256}` : 404 `skills_absent` (absent ou invalid), 409 `skills_changed`. */
export function trustSkills(cs: string, x: SessionExtras, sha256: unknown): { thread_id: string; root: string; sha256: string; trusted: true } {
  const s = x.skills;
  if (s.project === "absent" || s.project === "invalid" || !s.sha256) throw new SkillsErr(404, "skills_absent", "pas de skills de dépôt dans cette session");
  if (String(sha256 ?? "") !== s.sha256) throw new SkillsErr(409, "skills_changed", "l'arbre .nokker/skills a changé : relis la session");
  s.project = "trusted";
  s.notice = null;
  return { thread_id: cs, root: s.root, sha256: s.sha256, trusted: true };
}

/** `skill_list`, `skill_view`, `delegate_status`, `delegate_cancel` par `tools/call` ; null pour les autres outils. */
export function extraTool(state: MockState, cs: string, x: SessionExtras, name: string, a: Record<string, unknown>): { payload: unknown; error: boolean } | null {
  if (name === "skill_list") {
    if (x.skills.project !== "trusted") return { payload: { skills: [] }, error: false };
    return { payload: { skills: SKILLS.map((k) => ({ name: k.name, category: k.category, description: k.description, source: "project" })) }, error: false };
  }
  if (name === "skill_view") {
    const k = x.skills.project === "trusted" ? SKILLS.find((s) => s.name === a.name || `${s.category}/${s.name}` === a.name) : undefined;
    if (!k) return { payload: `compétence introuvable : '${String(a.name ?? "")}' (skill_list pour voir les noms)`, error: true };
    return { payload: { name: k.name, category: k.category, source: "project", description: k.description, content: k.content, linked_files: k.linked_files }, error: false };
  }
  if (name === "delegate_status") {
    const now = Date.now();
    const children = [...x.kids.values()].map((k) => ({ ...k.view, elapsed_s: Math.round((now - k.started) / 1000) }));
    return { payload: { children, running: children.filter((c) => ["queued", "running", "stopping"].includes(c.status)).length, finished: children.filter((c) => !["queued", "running", "stopping"].includes(c.status)).length }, error: false };
  }
  if (name === "delegate_cancel") {
    const ids = Array.isArray(a.ids) ? a.ids.map(String) : [...x.kids.keys()];
    const cancelled: string[] = [];
    const unknown: string[] = [];
    for (const id of ids) {
      const k = x.kids.get(id);
      if (!k) unknown.push(id);
      else if (["queued", "running", "stopping"].includes(k.view.status)) {
        finishKid(state, cs, k, "interrupted", "cancelled");
        cancelled.push(id);
      }
    }
    return { payload: { cancelled, ...(unknown.length ? { unknown } : {}) }, error: false };
  }
  return null;
}

function finishKid(state: MockState, cs: string, k: Kid, status: string, exit: string): void {
  k.view.status = status;
  k.view.exit_reason = exit;
  k.view.summary = status === "completed" ? `(démo) ${k.view.goal} : fait, 1 commit sur ${k.view.worktree?.branch}.` : undefined;
  if (k.view.worktree) k.view.worktree = { ...k.view.worktree, commits: status === "completed" ? 1 : 0, dirty: false, kept: status !== "completed" };
  // Sa carte en attente est refusée (§7.28.14, fermeture et arrêt).
  for (const ap of state.approvals.values()) if (ap.thread_id === k.view.thread_id && ap.status === "pending") ap.status = "rejected";
  state.publish({ type: "subagent.finished", parent_thread_id: cs, child_id: k.view.child_id, status, commits: k.view.worktree?.commits ?? 0, dirty: false, kept: k.view.worktree?.kept, background: true, exit_reason: exit });
}

/** Fermeture de la session : ses enfants sont arrêtés (`interrupted / cancelled`). */
export function stopKids(state: MockState, cs: string, x: SessionExtras): void {
  for (const k of x.kids.values()) if (["queued", "running", "stopping"].includes(k.view.status)) finishKid(state, cs, k, "interrupted", "cancelled");
}

/** Réglages de démo (voir l'en-tête). Rend une erreur lisible, ou null. */
export function devExtras(state: MockState, cs: string, x: SessionExtras, b: Record<string, unknown>): string | null {
  const sk = b.skills as { action?: string } | undefined;
  if (sk?.action === "rewrite" || sk?.action === "invalid") {
    const invalid = sk.action === "invalid";
    x.skills = invalid
      ? { enabled: true, project: "invalid", root: ROOT, sha256: null, count: 0, notice: "arbre .nokker/skills refusé : il contient un lien symbolique" }
      : { enabled: true, project: "untrusted", root: ROOT, sha256: sha(), count: SKILLS.length, notice: "l'arbre .nokker/skills a changé pendant la session : nouvelle confiance nécessaire" };
    if (!invalid) state.publish({ type: "skill.untrusted", thread_id: cs, session_id: cs, root: ROOT, sha256: x.skills.sha256!, count: x.skills.count, notice: x.skills.notice! });
  }
  const sp = b.spawn as { goal?: string; card?: boolean } | undefined;
  if (sp) {
    if (liveCount(x) >= MAX_SUBAGENTS) return `${MAX_SUBAGENTS} sous-agents vivants au plus par session`;
    const id = `sa${x.kids.size + 1}`;
    const thread = `${cs}/sa-${id}`;
    const goal = sp.goal || "relire les tests et corriger les échecs";
    const k: Kid = { started: Date.now(), view: { child_id: id, thread_id: thread, task_index: x.kids.size, goal, elapsed_s: 0, status: "running", last_tool: "read_file", isolated: true, worktree: { path: `${ROOT}/.nokker/worktrees/${id}`, branch: `nokker/sa-${id}` } } };
    x.kids.set(id, k);
    state.publish({ type: "subagent.started", thread_id: thread, parent_thread_id: cs, parent_turn: 0, child_id: id, child_thread_id: thread, goal, background: true });
    state.publish({ type: "subagent.progress", parent_thread_id: cs, child_id: id, tool: "read_file", ms: 120 });
    if (sp.card) {
      // L'enfant veut écrire hors de son worktree : carte forte sur SON fil, décidée par le propriétaire seul.
      const args = { command: "rm -rf build/" };
      const approval: Approval = {
        id: randomId("appr"),
        thread_id: thread,
        turn_index: 0,
        channel: "web",
        tool_name: "terminal",
        arguments: args,
        args_sha256: createHash("sha256").update(JSON.stringify(args)).digest("hex"),
        effect: "destructive",
        rule: "effect:destructive",
        reason: `sous-agent ${id} : terminal « rm -rf build/ »`,
        advice: null,
        strength: "strong",
        status: "pending",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        decided_by: null,
        decided_via: null,
        decided_at: null,
        result_summary: null,
        error: null,
      };
      state.approvals.set(approval.id, approval);
      state.publish({ type: "approval.requested", approval });
      approvalBubble(state, approval);
      // Exécutée avec le noyau de l'ENFANT (pas de tour de suite chez le parent) ; enfant arrêté : la carte échoue.
      state.approvalEffects.set(approval.id, () => {
        settleApprovalBubbles(state, approval);
        return k.view.status === "running" ? `(démo) sous-agent ${id} : commande exécutée dans son worktree` : "failed";
      });
      k.view.last_tool = "terminal";
    }
  }
  const fin = b.finish as { child?: string; status?: string } | undefined;
  if (fin?.child) {
    const k = x.kids.get(fin.child);
    if (!k) return "sous-agent inconnu";
    finishKid(state, cs, k, fin.status === "failed" ? "failed" : "completed", fin.status === "failed" ? "error" : "completed");
  }
  return null;
}
