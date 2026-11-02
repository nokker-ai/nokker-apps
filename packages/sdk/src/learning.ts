/**
 * Apprentissage (noyau docs/LEARNING.md, CLIENT-API.md §Apprentissage, APPROVALS.md §7) : notes de mémoire en attente
 * de validation, journal de ce que Nokker a appris, skills appris (versions, diff, retour, désactivation) et règles
 * d'approbation suggérées. Drapeaux du noyau `learning`, `memory_pending`, `approval_suggestions` : éteints = 404.
 */
export type PendingStatus = "pending" | "approved" | "rejected";

export interface PendingNote {
  id: string;
  source: "memory_note" | "propose";
  kind: string;
  title: string;
  text: string;
  scope: "project" | "user";
  derived_from: string;
  project: string;
  links: string[];
  thread_id: string | null;
  turn_index: number | null;
  at: string;
  status: PendingStatus;
  decided_at: string | null;
  decided_by: string | null;
  /** Nom de la note écrite (approuvée), sinon null. */
  result: string | null;
}

export type JournalKind = "skill.created" | "skill.updated" | "skill.reverted" | "skill.disabled" | "memory.pending" | "memory.approved" | "memory.rejected";

export interface JournalEntry {
  id: string;
  kind: JournalKind;
  /** Nom du skill, ou id de la note. */
  subject: string;
  at: string;
  /** `agent` : carte approuvée ; `owner` : geste de la personne. */
  actor: "agent" | "owner";
  version: number | null;
  thread_id?: string | null;
  turn_index?: number | null;
  detail: Record<string, unknown>;
}

export interface LearnedSkill {
  name: string;
  version: number;
  active: boolean;
  at: string;
}

export interface SkillVersion {
  name: string;
  version: number;
  sha256: string;
  op: "create" | "update" | "revert" | "disable";
  active: boolean;
  reverted_to: number | null;
  thread_id: string | null;
  turn_index: number | null;
  actor: "agent" | "owner";
  approval_id: string | null;
  at: string;
  content?: string;
}

export interface LearnedSkillDetail {
  name: string;
  current: number;
  active: boolean;
  versions: SkillVersion[];
  /** Présent avec `version` ou `diff_from`. */
  version?: SkillVersion;
  /** Diff unifié (`name@vN`), présent avec `diff_from` ; "" si identiques. */
  diff?: string;
}

export interface SkillRevertResult {
  skill: string;
  version: number;
  op: "revert" | "disable";
  active: boolean;
  reverted_to: number | null;
}

export interface ApprovalSuggestion {
  id: string;
  rule: string;
  tool: string;
  approved: number;
  rejected: number;
  approval_ids: string[];
  first_at: string;
  last_at: string;
}

export interface ApprovalSuggestions {
  suggestions: ApprovalSuggestion[];
  /** `user_settings` : propriétaire de Lokkal (Accepter possible) ; null : nuage (Accepter → 409 no_rule_store). */
  rule_store: "user_settings" | null;
  threshold: number;
  window_days: number;
}

/** Mémoire importée d'un autre agent comme DONNÉES (noyau lot 30 d, `local.import_codex_memory`) : Lokkal seulement. */
export interface ImportedMemoryEntry {
  name: string;
  title: string;
  /** Texte caviardé à l'import. */
  text: string;
  /** Date d'origine (AAAA-MM-JJ). */
  date: string;
  source: "codex";
}
