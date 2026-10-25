/**
 * Mise en forme (pure, testée sans Ink) des résultats des outils du noyau appelés par /diff /checkpoints /rollback
 * /skills /plan /agents /memory, dans la langue de l'interface.
 */
import type {
  CheckpointInfo,
  CheckpointRestoreResult,
  LocalMemoryStatus,
  ProjectMemoryList,
  ProjectMemoryView,
  ProjectSkillsStatus,
  SkillInfo,
  SubagentView,
  TodoItem,
} from "@nokker-apps/sdk";
import { formatCost } from "@nokker-apps/sdk";
import { costLang, t } from "./i18n/index.js";

export function notLocalMessage(): string {
  return t("available in a code session (nokker in a folder)");
}
export const DIFF_MAX_LINES = 300;

export type DiffKind = "add" | "del" | "hunk" | "meta" | "ctx";
export interface DiffLine {
  text: string;
  kind: DiffKind;
}

export function classifyDiffLine(line: string): DiffKind {
  if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

/** Diff coloré (vert/rouge), tronqué à `max` lignes avec le nombre de lignes omises. */
export function renderDiff(text: string, max = DIFF_MAX_LINES): { lines: DiffLine[]; omitted: number } {
  const all = text.replace(/\n$/, "").split("\n");
  return { lines: all.slice(0, max).map((t) => ({ text: t, kind: classifyDiffLine(t) })), omitted: Math.max(0, all.length - max) };
}

/** `checkpoint_list` : liste JSON NUE (noyau) ou enveloppe `{checkpoints}` (tolérée). `undefined` si illisible. */
export function parseCheckpointList(content: string): CheckpointInfo[] | undefined {
  try {
    const v = JSON.parse(content) as unknown;
    if (Array.isArray(v)) return v as CheckpointInfo[];
    const c = (v as { checkpoints?: unknown } | null)?.checkpoints;
    return Array.isArray(c) ? (c as CheckpointInfo[]) : undefined;
  } catch {
    return undefined;
  }
}

/** `checkpoint_diff` : `{stat, diff, message?}` (noyau) ; un texte brut (diff nu) est toléré. */
export function parseCheckpointDiff(content: string): { stat: string | null; diff: string; message: string | null } {
  try {
    const v = JSON.parse(content) as { stat?: string; diff?: string; message?: string } | null;
    if (v && typeof v === "object" && !Array.isArray(v)) return { stat: v.stat?.trim() || null, diff: v.diff ?? "", message: v.message ?? null };
  } catch {
    // texte brut
  }
  return { stat: null, diff: content, message: null };
}

export function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatCheckpoints(list: CheckpointInfo[]): string {
  if (!list.length) return t("No checkpoints.");
  // Tour du point (noyau du 25.10 : `turn_index` 0 = premier tour) quand le lien est connu ; rien sinon.
  const turn = (c: CheckpointInfo): string => (typeof c.turn_index === "number" ? `  · ${t("turn {0}", c.turn_index + 1)}` : "");
  const rows = list.map((c, i) => `${String(i + 1).padStart(2)}. ${c.short_hash}  ${hhmm(c.timestamp)}  ${c.reason}  (${c.files_changed > 1 ? t("{0} files", c.files_changed) : t("{0} file", c.files_changed)})${turn(c)}`);
  return `${t("Checkpoints (most recent first):")}\n${rows.join("\n")}\n/diff <hash|n> · /rollback <hash|n>`;
}

/** `arg` : numéro (1 = le plus récent), hash ou préfixe de hash ; absent = le plus récent. */
export function resolveCheckpoint(list: CheckpointInfo[], arg: string | null): CheckpointInfo | null {
  if (!list.length) return null;
  if (arg === null) return list[0]!;
  if (/^\d{1,3}$/.test(arg) && Number(arg) >= 1 && Number(arg) <= list.length) return list[Number(arg) - 1]!;
  return list.find((c) => c.hash === arg || c.hash.startsWith(arg) || c.short_hash === arg) ?? null;
}

/** État des skills du dépôt connu du client : la clé `skills` de l'ouverture (ou le dernier `skill.untrusted`), `off`
 * (noyau sans skills de dépôt : pas de clé à l'ouverture), `unknown` (session reprise sans nouvelle ouverture : le noyau
 * n'a pas de route qui le relise). */
export type ProjectSkillsState = ProjectSkillsStatus | "off" | "unknown";

const short = (sha: string | null | undefined): string => (sha ? `${sha.slice(0, 12)}…` : "—");

/** Une ligne sur la confiance des skills du dépôt (en tête de `/skills`). */
export function formatProjectSkills(st: ProjectSkillsState): string {
  if (st === "off") return t("Repository skills: not read by this core (local.project_skills is off).");
  if (st === "unknown") return t("Repository skills: state unknown for a resumed session (the core reports it when a session opens).");
  switch (st.project) {
    case "trusted":
      return t("Repository skills ({0}): {1} trusted, fingerprint {2}.", st.root, st.count, short(st.sha256));
    case "untrusted":
      return t("Repository skills ({0}): {1} NOT trusted, ignored — fingerprint {2}. /skills trust to review and trust them.", st.root, st.count, short(st.sha256));
    case "invalid":
      return t("Repository skills ignored: {0}", st.notice ?? st.root);
    default:
      return t("No repository skills (.nokker/skills) in {0}.", st.root);
  }
}

export function formatSkills(skills: SkillInfo[], project?: ProjectSkillsState): string {
  const head = project !== undefined ? [formatProjectSkills(project)] : [];
  if (!skills.length) return [...head, t("No skills.")].join("\n");
  const byFamily = new Map<string, SkillInfo[]>();
  for (const s of skills) byFamily.set(s.category, [...(byFamily.get(s.category) ?? []), s]);
  const width = Math.max(...skills.map((s) => s.name.length));
  const out: string[] = [...head];
  for (const [family, items] of [...byFamily].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`${family}`);
    for (const s of items) out.push(`  ${s.name.padEnd(width)}  ${s.description}  [${s.source}]`);
  }
  out.push(t("/skills <name> to read a skill"));
  return out.join("\n");
}

const TODO_MARK: Record<TodoItem["status"], string> = { completed: "[x]", in_progress: "[~]", pending: "[ ]", cancelled: "[-]" };
export function formatPlan(todos: TodoItem[]): string {
  if (!todos.length) return t("No plan yet.");
  return [t("Plan:"), ...todos.map((x) => `• ${TODO_MARK[x.status] ?? "[ ]"} ${x.content}`)].join("\n");
}

export function formatRestore(r: CheckpointRestoreResult, target: string): string {
  if (!r.success) return r.error ? t("✗ Rollback to {0} failed: {1}.", target, r.error) : t("✗ Rollback to {0} failed.", target);
  const lines = [t("✓ Rolled back to {0}: {1} file(s) restored", target, r.restored_files.length)];
  for (const f of r.restored_files) lines.push(`    ${t("restored")}  ${f}`);
  for (const f of r.skipped_user_edits) lines.push(`    ${t("kept")}  ${f} ${t("(edited by you since)")}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Sous-agents (/agents) : événements `subagent.*` et `delegate_status` (LOKKAL.md §7.22)
// ---------------------------------------------------------------------------

export type SubagentStatusName = "queued" | "running" | "stopping" | "completed" | "failed" | "interrupted";

export interface SubagentState {
  childId: string;
  /** `<parent>/sa-<id>` (ses cartes y sont posées). */
  threadId: string | null;
  goal: string;
  status: SubagentStatusName | (string & {});
  /** Enfant de fond (`delegate(background: true)`) : le parent ne l'attend pas. */
  background: boolean;
  lastTool: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Durée donnée par le noyau (`delegate_status.elapsed_s`), prioritaire sur l'horloge locale. */
  elapsedS: number | null;
  exitReason: string | null;
  summary: string | null;
  commits: number | null;
  dirty: boolean | null;
  kept: boolean | null;
  branch: string | null;
  tokens: number | null;
  /** CHF (ledger du noyau). */
  cost: number | null;
  /** Repris après sa carte (§7.22.7). */
  resumed: boolean;
}

const LIVE = new Set(["queued", "running", "stopping"]);
export const isLive = (s: SubagentState): boolean => LIVE.has(s.status);

function blank(id: string, now: number): SubagentState {
  return { childId: id, threadId: null, goal: "", status: "running", background: false, lastTool: null, startedAt: now, endedAt: null, elapsedS: null, exitReason: null, summary: null, commits: null, dirty: null, kept: null, branch: null, tokens: null, cost: null, resumed: false };
}

/** `ok` (anciens mocks) = `completed`. */
const normStatus = (s: string | undefined): string => (s === "ok" ? "completed" : s || "failed");

interface SubagentEventLike {
  type: string;
  child_id?: string;
  child_thread_id?: string;
  goal?: string;
  tool?: string;
  status?: string;
  background?: boolean;
  exit_reason?: string | null;
  commits?: number;
  dirty?: boolean;
  kept?: boolean;
  resumed?: boolean;
}

/** Applique un événement `subagent.*` (immuable) ; ignore les autres. */
export function applySubagentEvent(map: ReadonlyMap<string, SubagentState>, e: SubagentEventLike, now = Date.now()): Map<string, SubagentState> {
  const next = new Map(map);
  const id = e.child_id;
  if (!id) return next;
  const cur = next.get(id) ?? blank(id, now);
  if (e.type === "subagent.started") {
    next.set(id, { ...blank(id, now), threadId: e.child_thread_id ?? null, goal: e.goal ?? "", background: e.background === true });
  } else if (e.type === "subagent.progress") {
    next.set(id, { ...cur, lastTool: e.tool ?? cur.lastTool, status: cur.status === "queued" ? "running" : cur.status });
  } else if (e.type === "subagent.finished") {
    next.set(id, {
      ...cur,
      status: normStatus(e.status),
      background: cur.background || e.background === true,
      endedAt: now,
      exitReason: e.exit_reason ?? cur.exitReason,
      commits: e.commits ?? cur.commits,
      dirty: e.dirty ?? cur.dirty,
      kept: e.kept ?? cur.kept,
      resumed: cur.resumed || e.resumed === true,
    });
  }
  return next;
}

/** Fusionne les vues de `delegate_status` (source de vérité pour les enfants de fond : état, dernier outil, durée,
 * résultat complet). */
export function mergeSubagentViews(map: ReadonlyMap<string, SubagentState>, views: SubagentView[], now = Date.now()): Map<string, SubagentState> {
  const next = new Map(map);
  for (const v of views) {
    const cur = next.get(v.child_id) ?? blank(v.child_id, now - (v.elapsed_s ?? 0) * 1000);
    const live = LIVE.has(v.status);
    next.set(v.child_id, {
      ...cur,
      threadId: v.thread_id ?? cur.threadId,
      goal: v.goal || cur.goal,
      status: normStatus(v.status),
      background: true,
      lastTool: v.last_tool ?? cur.lastTool,
      elapsedS: v.elapsed_s ?? cur.elapsedS,
      endedAt: live ? null : (cur.endedAt ?? now),
      exitReason: v.exit_reason ?? cur.exitReason,
      summary: v.summary ?? cur.summary,
      commits: v.worktree?.commits ?? cur.commits,
      dirty: v.worktree?.dirty ?? cur.dirty,
      kept: v.worktree?.kept ?? cur.kept,
      branch: v.worktree?.branch ?? cur.branch,
      tokens: v.tokens ?? cur.tokens,
      cost: v.cost ?? cur.cost,
    });
  }
  return next;
}

export function subagentStatusLabel(status: string): string {
  switch (status) {
    case "queued":
      return t("queued");
    case "running":
      return t("running");
    case "stopping":
      return t("stopping");
    case "completed":
      return t("done");
    case "failed":
      return t("failed");
    case "interrupted":
      return t("interrupted");
    default:
      return status;
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

function durationOf(a: SubagentState, now: number): string {
  if (a.elapsedS !== null && !isLive(a)) return formatDuration(a.elapsedS * 1000);
  if (a.elapsedS !== null && a.endedAt === null) return formatDuration(Math.max(a.elapsedS * 1000, now - a.startedAt));
  return formatDuration((a.endedAt ?? now) - a.startedAt);
}

function outcome(a: SubagentState): string {
  if (isLive(a)) return "";
  const parts: string[] = [];
  if (a.exitReason === "restart") parts.push(t("the core restarted: worktree kept, not inspected"));
  else if (a.exitReason && a.exitReason !== "completed") parts.push(a.exitReason);
  if (a.commits !== null) parts.push(t("{0} commit(s)", a.commits));
  if (a.dirty) parts.push(t("tree modified"));
  if (a.resumed) parts.push(t("resumed after its card"));
  return parts.length ? ` — ${parts.join(", ")}` : "";
}

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

export function formatSubagents(map: ReadonlyMap<string, SubagentState>, now = Date.now(), note: string | null = null): string {
  if (!map.size) return [t("No sub-agents on this thread."), ...(note ? [note] : [])].join("\n");
  const rows = [...map.values()].map((a) => {
    const kind = a.background ? ` ${t("(background)")}` : "";
    const res = a.summary && !isLive(a) ? `\n      ${t("result:")} ${clip(a.summary, 100)}` : "";
    return `• ${a.childId}  ${subagentStatusLabel(a.status).padEnd(10)}${kind}  ${clip(a.goal, 40)}  ${t("last tool:")} ${a.lastTool ?? "—"}  ${durationOf(a, now)}${outcome(a)}${res}`;
  });
  const live = [...map.values()].some((a) => a.background && isLive(a));
  const hint = live ? [t("/agents <id> for details · /agents cancel <id|all> to stop")] : [t("/agents <id> for details")];
  return [t("Sub-agents:"), ...rows, ...(note ? [note] : []), ...hint].join("\n");
}

/** `/agents <id>` : tout ce que le client sait d'un enfant, résultat complet compris. */
export function formatSubagent(a: SubagentState, now = Date.now()): string {
  const lines = [`${t("Sub-agent {0}", a.childId)}${a.background ? ` ${t("(background)")}` : ""}`];
  lines.push(`  ${t("goal:")} ${a.goal || "—"}`);
  lines.push(`  ${t("state:")} ${subagentStatusLabel(a.status)}${a.exitReason ? ` (${a.exitReason})` : ""} · ${durationOf(a, now)}`);
  lines.push(`  ${t("last tool:")} ${a.lastTool ?? "—"}`);
  if (a.threadId) lines.push(`  ${t("thread:")} ${a.threadId}`);
  if (a.branch) lines.push(`  ${t("worktree:")} ${a.branch}${a.commits !== null ? ` · ${t("{0} commit(s)", a.commits)}` : ""}${a.kept ? ` · ${t("kept")}` : ""}`);
  if (a.tokens !== null || a.cost !== null) {
    const money = a.cost !== null ? formatCost({ CHF: a.cost }, costLang()) : "";
    lines.push(`  ${t("cost:")} ${a.tokens !== null ? t("{0} tokens", a.tokens) : ""}${money ? `${a.tokens !== null ? " · " : ""}${money}` : ""}`);
  }
  if (a.summary) lines.push(`  ${t("result:")}`, ...a.summary.split("\n").map((l) => `    ${l}`));
  else if (isLive(a)) lines.push(`  ${t("result: not yet (still running)")}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Mémoire de projet (/memory) : outil `memory` et état de la mémoire longue (LOKKAL.md §7.11.7, §7.13)
// ---------------------------------------------------------------------------

function kindLabel(kind: string): string {
  switch (kind) {
    case "rule":
      return t("rule");
    case "feedback":
      return t("feedback");
    case "fact":
      return t("fact");
    default:
      return kind;
  }
}

function originLabel(from: string | undefined): string {
  switch (from) {
    case "user":
      return t("from you");
    case "repo":
      return t("from the repository");
    case "agent":
      return t("from the agent");
    default:
      return from ?? "";
  }
}

/** Ligne d'état de la mémoire longue (`GET /v1/local/memory`), `null` si inconnue. */
export function formatMemoryStatus(st: LocalMemoryStatus | null): string | null {
  if (!st) return null;
  if (st.mode === "off") return t("Long-term memory: off on this core.");
  if (st.ok === false) return t("Long-term memory: DOWN ({0}) — `nokker doctor` for details.", st.error ?? st.last_error ?? st.mode);
  const notes = st.store?.notes;
  return notes !== null && notes !== undefined ? t("Long-term memory: {0}, healthy, {1} indexed note(s).", st.mode, notes) : t("Long-term memory: {0}, healthy.", st.mode);
}

export function formatMemory(list: ProjectMemoryList, status: LocalMemoryStatus | null = null): string {
  const out: string[] = [list.project ? t("Project memory — {0}", list.project) : t("Project memory")];
  out.push(list.notes.length ? t("Learned notes ({0}):", list.notes.length) : t("Learned notes: none yet."));
  for (const n of list.notes) {
    const tags = [n.scope === "user" ? t("all your projects") : t("this project"), originLabel(n.derived_from), n.in_core ? t("always in context") : t("recalled when relevant")].filter(Boolean);
    out.push(`  • [${kindLabel(n.kind)}] ${n.title}  (${n.name}) · ${tags.join(" · ")}`);
  }
  if (list.sources.length) {
    out.push(t("Instruction files (edit the file to change them):"));
    for (const src of list.sources) {
      out.push(`  ${src.path}`);
      for (const s of src.sections) out.push(`    • ${s.title}  (${s.name})${s.in_core ? ` · ${t("always in context")}` : ""}`);
    }
  } else out.push(t("Instruction files: none (AGENTS.md, NOKKER.md, CLAUDE.md)."));
  const st = formatMemoryStatus(status);
  if (st) out.push(st);
  out.push(t("/memory <note> to read · /memory forget <note> to forget a learned note"));
  return out.join("\n");
}

export function formatMemoryView(v: ProjectMemoryView): string {
  if ("source" in v) return [`${v.title}  (${v.name})`, t("from {0} — edit the file to change it", v.source), "", v.text].join("\n");
  const meta = [kindLabel(v.kind), v.scope === "user" ? t("all your projects") : t("this project"), originLabel(v.derived_from), v.origin ?? "", v.created ?? ""].filter(Boolean);
  return [`${v.title}  (${v.name})`, meta.join(" · "), "", v.text].join("\n");
}

/** Une note ou section de la liste, par nom exact ou préfixe unique ; `null` sinon. */
export function findMemoryEntry(list: ProjectMemoryList, query: string): { name: string; title: string; learned: boolean } | null {
  const all = [
    ...list.notes.map((n) => ({ name: n.name, title: n.title, learned: true })),
    ...list.sources.flatMap((s) => s.sections.map((x) => ({ name: x.name, title: x.title, learned: false }))),
  ];
  const exact = all.find((e) => e.name === query);
  if (exact) return exact;
  const pre = all.filter((e) => e.name.startsWith(query));
  return pre.length === 1 ? pre[0]! : null;
}
