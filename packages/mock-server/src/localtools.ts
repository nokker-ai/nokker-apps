/**
 * Route locale d'appel d'outil du mock : `POST /v1/local/tools/call {thread_id, name, arguments}` (PROPOSÉE au noyau).
 * Liste blanche checkpoint_* / skill_* / todo (autre nom : 403) ; fil non local : 404 ; `todo` avec des arguments : 400 ;
 * tour en cours sur le fil : 409 ; refus par règle / mode plan : 200 `{content, is_error: true}` ; 200 `{content, is_error}` sinon ;
 * 202 `{approval_id}` si l'effet exige une carte (puis UN `tool.result {thread_id, approval_id, content, is_error}`, rien d'autre,
 * aucun tour modèle). Rien n'est réellement restauré : état simulé en mémoire.
 */
import { LOCAL_TOOL_NAMES, decide, type CheckpointInfo, type LocalToolEffect, type LocalToolName, type SkillInfo, type TodoItem } from "@nokker-apps/sdk";
import { askLocalApproval } from "./local.js";
import { randomId, type MockState } from "./state.js";

const EFFECTS: Record<LocalToolName, LocalToolEffect> = {
  checkpoint_list: "read",
  checkpoint_diff: "read",
  checkpoint_create: "write",
  checkpoint_restore: "destructive",
  skill_list: "read",
  skill_view: "read",
  todo: "read",
};

export const MOCK_SKILLS: Array<SkillInfo & { body: string }> = [
  { name: "git-bisect", category: "dev", description: "Trouver le commit fautif par bissection.", source: "builtin", body: "# git-bisect\n\nTrouver le commit qui a cassé un test.\n\n1. `git bisect start`\n2. Marquer `good` et `bad`\n3. Lancer le test à chaque étape\n\n- Toujours finir par `git bisect reset`\n" },
  { name: "pytest-debug", category: "dev", description: "Diagnostiquer un test pytest qui échoue.", source: "builtin", body: "# pytest-debug\n\nLire l'échec **avant** de modifier.\n\n- `pytest -x -q <fichier>`\n- `pytest --pdb` pour entrer dans le débogueur\n\n```bash\npytest -q tests/test_app.py\n```\n" },
  { name: "release-notes", category: "docs", description: "Rédiger des notes de version depuis les commits.", source: "user", body: "# release-notes\n\nRegrouper les commits par type (`feat`, `fix`) et résumer en une phrase chacun.\n" },
  { name: "sql-explain", category: "data", description: "Lire un plan EXPLAIN et proposer un index.", source: "user", body: "# sql-explain\n\n1. `EXPLAIN (ANALYZE, BUFFERS)`\n2. Repérer les `Seq Scan` coûteux\n3. Proposer un index ciblé\n" },
];

interface ThreadTools {
  checkpoints: CheckpointInfo[];
  todos: TodoItem[];
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
    };
    m.set(threadId, t);
  }
  return t;
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
      return ok(t.checkpoints);
    case "checkpoint_diff": {
      const cp = find(args.hash);
      return cp ? ok({ stat: " src/app.py | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)", diff: diffText(cp) }) : fail(`point de retour introuvable : ${String(args.hash)}`);
    }
    case "checkpoint_create": {
      const hash = randomId("x").replace(/[^0-9a-f]/g, "").padEnd(40, "0").slice(0, 40);
      const cp: CheckpointInfo = { hash, short_hash: hash.slice(0, 8), timestamp: new Date().toISOString(), reason: String(args.reason ?? "manuel"), files_changed: 0 };
      t.checkpoints.unshift(cp);
      return ok({ success: true, checkpoint: cp });
    }
    case "checkpoint_restore": {
      const cp = find(args.hash);
      if (!cp) return fail(`point de retour introuvable : ${String(args.hash)}`);
      if (args.safe !== false) {
        const hash = randomId("x").replace(/[^0-9a-f]/g, "").padEnd(40, "1").slice(0, 40);
        t.checkpoints.unshift({ hash, short_hash: hash.slice(0, 8), timestamp: new Date().toISOString(), reason: `avant retour à ${cp.short_hash}`, files_changed: 0 });
      }
      return ok({ success: true, restored_files: ["src/app.py", "tests/test_app.py"], skipped_user_edits: ["notes.md"] });
    }
    case "skill_list": {
      const cat = typeof args.category === "string" ? args.category : null;
      return ok({ skills: MOCK_SKILLS.filter((s) => !cat || s.category === cat).map(({ body: _b, ...s }) => (void _b, s)) });
    }
    case "skill_view": {
      const s = MOCK_SKILLS.find((x) => x.name === args.name);
      return s ? ok(s.body) : fail(`skill inconnu : ${String(args.name)}`);
    }
    case "todo": {
      const count = (st: string): number => t.todos.filter((x) => x.status === st).length;
      return ok({ todos: t.todos, revision: 1, summary: { total: t.todos.length, pending: count("pending"), in_progress: count("in_progress"), completed: count("completed"), cancelled: count("cancelled") } });
    }
  }
}

export async function handleLocalToolCall(state: MockState, body: Record<string, unknown>): Promise<Reply> {
  const threadId = typeof body.thread_id === "string" ? body.thread_id : "";
  const name = body.name as LocalToolName;
  if (!LOCAL_TOOL_NAMES.includes(name)) return forbidden(`outil non appelable directement : ${String(body.name)}`);
  if (!state.localSessions.has(threadId)) return { status: 404, body: { error: { message: "session locale inconnue" } } };
  const args = body.arguments && typeof body.arguments === "object" ? (body.arguments as Record<string, unknown>) : {};
  if (name === "todo" && Object.keys(args).length > 0) return { status: 400, body: { error: { message: "arguments invalides (todo : lecture seule, sans argument)" } } };
  if (state.activeTurns.has(threadId)) return { status: 409, body: { error: { message: "un tour est en cours sur ce fil" } } };
  const effect = EFFECTS[name];
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
