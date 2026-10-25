/**
 * Route locale d'appel d'outil du mock : `POST /v1/local/tools/call {thread_id, name, arguments}` (PROPOSÉE au noyau).
 * Liste blanche checkpoint_* / skill_* / todo, `memory` (drapeau mémoire de projet) et `delegate_status` (autre nom :
 * 403, `delegate_cancel` compris) ; fil non local : 404 ; `todo` avec des arguments : 400 ;
 * tour en cours sur le fil : 409 ; refus par règle / mode plan : 200 `{content, is_error: true}` ; 200 `{content, is_error}` sinon ;
 * 202 `{approval_id}` si l'effet exige une carte (puis UN `tool.result {thread_id, approval_id, content, is_error}`, rien d'autre,
 * aucun tour modèle). Par défaut rien n'est réellement restauré : état simulé en mémoire. `state.localWrites` : les
 * points pris pendant un tour photographient les fichiers du dossier et un retour PAR FICHIER les restaure, avec la
 * réponse du noyau (`git checkout <point> -- <fichier>` : un fichier absent du point est une erreur).
 *
 * Points automatiques (`autoCheckpoint`), comme `CheckpointingToolSource` du noyau : avant le premier appel non-READ de
 * chaque tour, au plus un par tour et par dossier, raison « avant <outil> », horodatage à la seconde (`git log %aI`) ;
 * aucun point si rien n'a changé depuis le précédent (dossier photographié).
 *
 * Point ↔ tour (§7.4.7) : chaque point pris ici est relié à `{thread_id, turn_index, tool}` (rendus par `checkpoint_list`
 * et `checkpoint_create`, jamais inventés pour les points de démo d'avant) et publie `checkpoint.created`. Retour d'un
 * fichier ABSENT du point (créé depuis, `localWrites`) : supprimé après un point « avant retour » qui le contient,
 * réponse `{success, restored_to, reason, directory, file, deleted, snapshot}`.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { LOCAL_TOOL_NAMES, decide, parseTurnId, type CheckpointInfo, type LocalToolEffect, type LocalToolName, type SkillInfo, type TodoItem } from "@nokker-apps/sdk";
import { askLocalApproval } from "./local.js";
import { delegateStatus, memoryTool, visibleProjectSkills } from "./project.js";
import { randomId, type MockState } from "./state.js";

const EFFECTS: Record<LocalToolName, LocalToolEffect> = {
  checkpoint_list: "read",
  checkpoint_diff: "read",
  checkpoint_create: "write",
  checkpoint_restore: "destructive",
  skill_list: "read",
  skill_view: "read",
  todo: "read",
  memory: "read",
  delegate_status: "read",
  delegate_cancel: "read",
};

/** Effet de CET appel : `memory {action: forget}` écrit (WRITE), le reste lit. */
function effectOf(name: LocalToolName, args: Record<string, unknown>): LocalToolEffect {
  if (name === "memory") return String(args.action ?? "list") === "forget" ? "write" : "read";
  return EFFECTS[name];
}

export const MOCK_SKILLS: Array<SkillInfo & { body: string }> = [
  { name: "git-bisect", category: "dev", description: "Trouver le commit fautif par bissection.", source: "builtin", body: "# git-bisect\n\nTrouver le commit qui a cassé un test.\n\n1. `git bisect start`\n2. Marquer `good` et `bad`\n3. Lancer le test à chaque étape\n\n- Toujours finir par `git bisect reset`\n" },
  { name: "pytest-debug", category: "dev", description: "Diagnostiquer un test pytest qui échoue.", source: "builtin", body: "# pytest-debug\n\nLire l'échec **avant** de modifier.\n\n- `pytest -x -q <fichier>`\n- `pytest --pdb` pour entrer dans le débogueur\n\n```bash\npytest -q tests/test_app.py\n```\n" },
  { name: "release-notes", category: "docs", description: "Rédiger des notes de version depuis les commits.", source: "user", body: "# release-notes\n\nRegrouper les commits par type (`feat`, `fix`) et résumer en une phrase chacun.\n" },
  { name: "sql-explain", category: "data", description: "Lire un plan EXPLAIN et proposer un index.", source: "user", body: "# sql-explain\n\n1. `EXPLAIN (ANALYZE, BUFFERS)`\n2. Repérer les `Seq Scan` coûteux\n3. Proposer un index ciblé\n" },
];

interface ThreadTools {
  checkpoints: CheckpointInfo[];
  todos: TodoItem[];
  /** `localWrites` : contenu des fichiers du dossier à chaque point (hash → chemin relatif → texte). */
  snapshots: Map<string, Map<string, string>>;
  /** Dernier tour qui a pris son point automatique. */
  lastTurn: string | null;
  /** Point → tour qui l'a pris (`{thread_id, turn_index, tool}`). */
  links: Map<string, { thread_id: string; turn_index: number; tool: string }>;
}
const store = new WeakMap<MockState, Map<string, ThreadTools>>();

function toolsFor(state: MockState, threadId: string): ThreadTools {
  let m = store.get(state);
  if (!m) store.set(state, (m = new Map()));
  let t = m.get(threadId);
  if (!t) {
    const now = Date.now();
    const mk = (n: number, ago: number, reason: string, files: number): CheckpointInfo => {
      const hash = (n.toString(16).padStart(2, "0") + "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678").slice(0, 40);
      return { hash, short_hash: hash.slice(0, 8), timestamp: new Date(now - ago * 60_000).toISOString(), reason, files_changed: files, insertions: files * 3, deletions: files };
    };
    t = {
      checkpoints: [mk(3, 2, "avant patch src/app.py", 1), mk(2, 25, "avant pytest", 3), mk(1, 90, "début de session", 0)],
      todos: [
        { id: "1", content: "Lire le test qui échoue", status: "completed" },
        { id: "2", content: "Corriger add() dans src/app.py", status: "in_progress" },
        { id: "3", content: "Relancer pytest", status: "pending" },
      ],
      snapshots: new Map(),
      lastTurn: null,
      links: new Map(),
    };
    m.set(threadId, t);
  }
  return t;
}

const hex40 = (): string => randomId("x").replace(/[^0-9a-f]/g, "").padEnd(40, "0").slice(0, 40);
/** Horodatage d'un point tel que `git log --format=%aI` le rend : à la seconde, avec le décalage. */
const gitTime = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

const SKIP_DIRS = new Set([".git", "node_modules", ".nokker", ".venv", "__pycache__"]);
/** Photo des fichiers texte du dossier (borné : 500 fichiers, 1 Mo chacun). */
function photograph(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names.sort()) {
      if (out.size >= 500) return;
      const p = join(dir, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(n)) walk(p);
      } else if (st.isFile() && st.size <= 1_000_000) {
        const text = readFileSync(p, "utf-8");
        if (!text.includes("\u0000")) out.set(relative(root, p).split(sep).join("/"), text);
      }
    }
  };
  walk(root);
  return out;
}

const samePhoto = (a: Map<string, string> | undefined, b: Map<string, string>): boolean =>
  !!a && a.size === b.size && [...b].every(([k, v]) => a.get(k) === v);

/** Point automatique avant un appel non-READ (au plus un par tour). Rend le point pris, ou `null`. */
export function autoCheckpoint(state: MockState, threadId: string, turnId: string, toolName: string): CheckpointInfo | null {
  const root = threadId.split("/sa-")[0]!;
  const t = toolsFor(state, root);
  if (t.lastTurn === turnId) return null;
  t.lastTurn = turnId;
  return takeCheckpoint(state, root, `avant ${toolName}`, { thread_id: threadId, turn_index: parseTurnId(turnId)?.index ?? 0, tool: toolName });
}

/** Index du prochain tour du fil (appel direct sans tour modèle, §7.4.7). */
function nextTurn(state: MockState, threadId: string): number {
  return state.threads.get(threadId)?.turns.length ?? 0;
}

const linked = (t: ThreadTools, cps: CheckpointInfo[]): CheckpointInfo[] => cps.map((c) => ({ ...c, ...(t.links.get(c.hash) ?? {}) }));

function takeCheckpoint(state: MockState, threadId: string, reason: string, link: { thread_id: string; turn_index: number; tool: string }): CheckpointInfo | null {
  const t = toolsFor(state, threadId);
  const cwd = state.localSessions.get(threadId)?.cwd;
  let photo: Map<string, string> | null = null;
  if (state.localWrites && cwd) {
    photo = photograph(cwd);
    const head = t.checkpoints[0];
    if (head && samePhoto(t.snapshots.get(head.hash), photo)) return null; // rien de neuf depuis le dernier point
  }
  const hash = hex40();
  const cp: CheckpointInfo = { hash, short_hash: hash.slice(0, 8), timestamp: gitTime(), reason, files_changed: 0, insertions: 0, deletions: 0 };
  t.checkpoints.unshift(cp);
  if (photo) t.snapshots.set(hash, photo);
  t.links.set(hash, link);
  state.publish({ type: "checkpoint.created", ...link, hash });
  return cp;
}

/** `checkpoint_restore {hash, file}` : un seul fichier, comme `git checkout <point> -- <fichier>` du noyau. */
function restoreFile(state: MockState, threadId: string, t: ThreadTools, cp: CheckpointInfo, file: string): Reply {
  const cwd = state.localSessions.get(threadId)?.cwd ?? "";
  const target = resolve(cwd, file);
  if (!cwd || (target !== cwd && !target.startsWith(cwd + sep))) return fail(JSON.stringify({ success: false, error: `Invalid file path: ${file}` }));
  const done = { success: true, restored_to: cp.hash.slice(0, 8), reason: cp.reason, directory: cwd, file };
  const link = { thread_id: threadId, turn_index: nextTurn(state, threadId), tool: "checkpoint_restore" };
  if (!state.localWrites) {
    takeCheckpoint(state, threadId, `avant retour à ${cp.short_hash}`, link);
    return ok(done);
  }
  const photo = t.snapshots.get(cp.hash);
  const rel = relative(cwd, target).split(sep).join("/");
  const text = photo?.get(rel);
  if (text === undefined) {
    // Fichier créé après le point : revenir au point = le supprimer, après une photo « avant retour » qui le contient.
    if (!existsSync(target)) return ok({ ...done, file: rel, deleted: false, message: "absent au point et déjà absent : rien à faire" });
    if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile()) {
      return fail(JSON.stringify({ success: false, error: `${rel} n'est pas un fichier ordinaire (dossier ou lien) : restaure le dossier entier` }));
    }
    takeCheckpoint(state, threadId, `avant retour à ${cp.short_hash}`, link); // sauté si rien n'a changé : le dernier point vaut
    const snap = t.checkpoints[0]!;
    if (t.snapshots.get(snap.hash)?.get(rel) !== readFileSync(target, "utf-8")) {
      return fail(JSON.stringify({ success: false, error: `${rel} non capturé par les points de retour (exclu ou ignoré) : pas supprimé, ce serait la seule copie` }));
    }
    unlinkSync(target);
    return ok({ ...done, file: rel, deleted: true, snapshot: snap.hash });
  }
  takeCheckpoint(state, threadId, `avant retour à ${cp.short_hash}`, link);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  return ok(done);
}

function diffText(cp: CheckpointInfo): string {
  return [
    `diff --git a/src/app.py b/src/app.py`,
    `--- a/src/app.py`,
    `+++ b/src/app.py`,
    `@@ -1,4 +1,4 @@`,
    ` def add(a, b):`,
    `-    return a - b`,
    `+    return a + b`,
    ` `,
    `# depuis le point ${cp.short_hash} (${cp.reason})`,
  ].join("\n");
}

interface Reply {
  status: number;
  body: unknown;
}
const forbidden = (message: string): Reply => ({ status: 403, body: { error: { message } } });
const ok = (payload: unknown): Reply => ({ status: 200, body: { content: typeof payload === "string" ? payload : JSON.stringify(payload), is_error: false } });
const fail = (message: string): Reply => ({ status: 200, body: { content: message, is_error: true } });

function execute(state: MockState, threadId: string, name: LocalToolName, args: Record<string, unknown>): Reply {
  const t = toolsFor(state, threadId);
  const find = (h: unknown): CheckpointInfo | undefined =>
    typeof h === "string" && h ? t.checkpoints.find((c) => c.hash === h || c.hash.startsWith(h)) : t.checkpoints[0];
  switch (name) {
    case "checkpoint_list":
      return ok(linked(t, t.checkpoints));
    case "checkpoint_diff": {
      const cp = find(args.hash);
      return cp ? ok({ stat: " src/app.py | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)", diff: diffText(cp) }) : fail(`point de retour introuvable : ${String(args.hash)}`);
    }
    case "checkpoint_create": {
      const hash = randomId("x").replace(/[^0-9a-f]/g, "").padEnd(40, "0").slice(0, 40);
      const cp: CheckpointInfo = { hash, short_hash: hash.slice(0, 8), timestamp: new Date().toISOString(), reason: String(args.reason ?? "manuel"), files_changed: 0 };
      t.checkpoints.unshift(cp);
      const link = { thread_id: threadId, turn_index: nextTurn(state, threadId), tool: "checkpoint_create" };
      t.links.set(hash, link);
      state.publish({ type: "checkpoint.created", ...link, hash });
      return ok({ created: true, ...cp, ...link });
    }
    case "checkpoint_restore": {
      const cp = find(args.hash);
      if (!cp) return fail(`point de retour introuvable : ${String(args.hash)}`);
      if (typeof args.file === "string" && args.file) return restoreFile(state, threadId, t, cp, args.file);
      if (args.safe !== false) {
        const hash = randomId("x").replace(/[^0-9a-f]/g, "").padEnd(40, "1").slice(0, 40);
        t.checkpoints.unshift({ hash, short_hash: hash.slice(0, 8), timestamp: new Date().toISOString(), reason: `avant retour à ${cp.short_hash}`, files_changed: 0 });
        const link = { thread_id: threadId, turn_index: nextTurn(state, threadId), tool: "checkpoint_restore" };
        t.links.set(hash, link);
        state.publish({ type: "checkpoint.created", ...link, hash });
      }
      return ok({ success: true, restored_files: ["src/app.py", "tests/test_app.py"], skipped_user_edits: ["notes.md"] });
    }
    case "skill_list": {
      const cat = typeof args.category === "string" ? args.category : null;
      // Précédence : dépôt > utilisateur > fournis (un skill du dépôt masque celui de même nom).
      const project = state.projectSkills ? visibleProjectSkills(state, threadId) : [];
      const all = [...project, ...MOCK_SKILLS.filter((m) => !project.some((p) => p.name === m.name))];
      return ok({ skills: all.filter((s) => !cat || s.category === cat).map(({ body: _b, ...s }) => (void _b, s)) });
    }
    case "skill_view": {
      const project = state.projectSkills ? visibleProjectSkills(state, threadId) : [];
      const s = [...project, ...MOCK_SKILLS].find((x) => x.name === args.name);
      return s ? ok(s.body) : fail(`skill inconnu : ${String(args.name)}`);
    }
    case "memory": {
      const r = memoryTool(state, threadId, args);
      return { status: 200, body: r };
    }
    case "delegate_status":
      return { status: 200, body: delegateStatus(state, threadId, args) };
    case "delegate_cancel":
      return fail("outil non appelable directement : delegate_cancel");
    case "todo": {
      const count = (st: string): number => t.todos.filter((x) => x.status === st).length;
      return ok({ todos: t.todos, revision: 1, summary: { total: t.todos.length, pending: count("pending"), in_progress: count("in_progress"), completed: count("completed"), cancelled: count("cancelled") } });
    }
  }
}

export async function handleLocalToolCall(state: MockState, body: Record<string, unknown>): Promise<Reply> {
  const threadId = typeof body.thread_id === "string" ? body.thread_id : "";
  const name = body.name as LocalToolName;
  // Liste blanche du noyau : `memory` seulement drapeau `local.project_memory` allumé ; `delegate_cancel` jamais.
  if (!LOCAL_TOOL_NAMES.includes(name) || (name === "memory" && !state.projectMemory)) return forbidden(`outil non appelable directement : ${String(body.name)}`);
  if (!state.localSessions.has(threadId)) return { status: 404, body: { error: { message: "session locale inconnue" } } };
  const args = body.arguments && typeof body.arguments === "object" ? (body.arguments as Record<string, unknown>) : {};
  if (name === "todo" && Object.keys(args).length > 0) return { status: 400, body: { error: { message: "arguments invalides (todo : lecture seule, sans argument)" } } };
  if (name === "delegate_status" && args.wait_s) return { status: 400, body: { error: { message: "delegate_status hors tour : sans wait_s" } } };
  if (state.activeTurns.has(threadId) || state.threadBusy(threadId)) return { status: 409, body: { error: { message: "un tour est en cours sur ce fil" } } };
  const effect = effectOf(name, args);
  // checkpoint_create : le noyau réel répond encore 202 (carte) ; il passera à 200 en accept_edits — la CLI gère les deux.
  const verdict = name === "checkpoint_create" ? "ask" : decide(state.effectiveSettings(threadId), name, args, effect);
  if (verdict === "deny") return fail("refusé par une règle ou par le mode plan");
  if (verdict === "allow") return execute(state, threadId, name, args);

  // Carte : même chemin que n'importe quel effet (approval.requested, GET /v1/local/approvals, decide).
  const turnId = `${threadId}:tools`;
  let approvalId = "";
  const created = new Promise<string>((resolve) => {
    void (async () => {
      const outcome = await askLocalApproval(state, threadId, turnId, { name, effect, args }, (a) => {
        approvalId = a.id;
        resolve(a.id);
      }, "local-direct");
      const result: Reply = outcome === "approved" ? execute(state, threadId, name, args) : fail(outcome === "expired" ? "approbation expirée — refusé" : "refusé par l'utilisateur");
      const r = result.body as { content: string; is_error: boolean };
      state.publish({ type: "tool.result", thread_id: threadId, approval_id: approvalId, name, ok: !(r.is_error || outcome !== "approved"), is_error: r.is_error || outcome !== "approved", content: r.content, preview: r.content.slice(0, 1200) });
    })();
  });
  return { status: 202, body: { approval_id: await created } };
}
