/**
 * Mise en forme (pure, testée sans Ink) des résultats des outils du noyau appelés par /diff /checkpoints /rollback
 * /skills /plan /agents.
 */
import type { CheckpointInfo, CheckpointRestoreResult, SkillInfo, TodoItem } from "@nokker-apps/sdk";

export const NOT_LOCAL_MESSAGE = "disponible dans une session de code (nokker dans un dossier)";
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
  if (!list.length) return "Aucun point de retour.";
  const rows = list.map((c, i) => `${String(i + 1).padStart(2)}. ${c.short_hash}  ${hhmm(c.timestamp)}  ${c.reason}  (${c.files_changed} fichier${c.files_changed > 1 ? "s" : ""})`);
  return `Points de retour (le plus récent d'abord) :\n${rows.join("\n")}\n/diff <hash|n> · /rollback <hash|n>`;
}

/** `arg` : numéro (1 = le plus récent), hash ou préfixe de hash ; absent = le plus récent. */
export function resolveCheckpoint(list: CheckpointInfo[], arg: string | null): CheckpointInfo | null {
  if (!list.length) return null;
  if (arg === null) return list[0]!;
  if (/^\d{1,3}$/.test(arg) && Number(arg) >= 1 && Number(arg) <= list.length) return list[Number(arg) - 1]!;
  return list.find((c) => c.hash === arg || c.hash.startsWith(arg) || c.short_hash === arg) ?? null;
}

export function formatSkills(skills: SkillInfo[]): string {
  if (!skills.length) return "Aucun skill.";
  const byFamily = new Map<string, SkillInfo[]>();
  for (const s of skills) byFamily.set(s.category, [...(byFamily.get(s.category) ?? []), s]);
  const width = Math.max(...skills.map((s) => s.name.length));
  const out: string[] = [];
  for (const [family, items] of [...byFamily].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`${family}`);
    for (const s of items) out.push(`  ${s.name.padEnd(width)}  ${s.description}  [${s.source}]`);
  }
  out.push("/skills <nom> pour lire un skill");
  return out.join("\n");
}

const TODO_MARK: Record<TodoItem["status"], string> = { completed: "[x]", in_progress: "[~]", pending: "[ ]", cancelled: "[-]" };
export function formatPlan(todos: TodoItem[]): string {
  if (!todos.length) return "Aucun plan pour l'instant.";
  return ["Plan :", ...todos.map((t) => `• ${TODO_MARK[t.status] ?? "[ ]"} ${t.content}`)].join("\n");
}

export function formatRestore(r: CheckpointRestoreResult, target: string): string {
  if (!r.success) return `✗ Retour à ${target} échoué${r.error ? ` : ${r.error}` : ""}.`;
  const lines = [`✓ Retour à ${target} : ${r.restored_files.length} fichier(s) restauré(s)`];
  for (const f of r.restored_files) lines.push(`    restauré  ${f}`);
  for (const f of r.skipped_user_edits) lines.push(`    conservé  ${f} (modifié par toi depuis)`);
  return lines.join("\n");
}

export interface SubagentState {
  childId: string;
  goal: string;
  status: "en cours" | "terminé" | "échec";
  lastTool: string | null;
  startedAt: number;
  endedAt: number | null;
}

/** Applique un événement `subagent.*` (immuable) ; ignore les autres. */
export function applySubagentEvent(
  map: ReadonlyMap<string, SubagentState>,
  e: { type: string; child_id?: string; goal?: string; tool?: string; status?: string },
  now = Date.now(),
): Map<string, SubagentState> {
  const next = new Map(map);
  const id = e.child_id;
  if (!id) return next;
  if (e.type === "subagent.started") {
    next.set(id, { childId: id, goal: e.goal ?? "", status: "en cours", lastTool: null, startedAt: now, endedAt: null });
  } else if (e.type === "subagent.progress") {
    const cur = next.get(id) ?? { childId: id, goal: "", status: "en cours" as const, lastTool: null, startedAt: now, endedAt: null };
    next.set(id, { ...cur, lastTool: e.tool ?? cur.lastTool });
  } else if (e.type === "subagent.finished") {
    const cur = next.get(id) ?? { childId: id, goal: "", status: "en cours" as const, lastTool: null, startedAt: now, endedAt: null };
    next.set(id, { ...cur, status: e.status === "ok" ? "terminé" : "échec", endedAt: now });
  }
  return next;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

export function formatSubagents(map: ReadonlyMap<string, SubagentState>, now = Date.now()): string {
  if (!map.size) return "Aucun sous-agent sur ce fil.";
  const rows = [...map.values()].map((a) => {
    const goal = a.goal.length > 40 ? `${a.goal.slice(0, 39)}…` : a.goal;
    return `• ${a.childId}  ${a.status.padEnd(8)}  ${goal}  dernier outil : ${a.lastTool ?? "—"}  ${formatDuration((a.endedAt ?? now) - a.startedAt)}`;
  });
  return `Sous-agents :\n${rows.join("\n")}`;
}
