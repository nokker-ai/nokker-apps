/**
 * Routes LOCALES de Lokkal (jeton local seulement ; par la passerelle : lecture permise au mieux, écriture 403) —
 * processus en arrière-plan (X6, LOKKAL §7.7), coffre (X4, §7.10), confiance des hooks (X3, §7.9), événements de
 * mémoire (X1, §7.11) et de hooks.
 */

export interface LocalProcess {
  thread_id: string;
  id: string;
  name: string;
  command: string;
  state: "running" | "exited" | "stopped" | "lost";
  port?: number | null;
  returncode?: number | null;
  started_at?: string | number;
  ended_at?: string | number | null;
}

export interface LocalSecrets {
  provider: string;
  notice?: string | null;
  sealed?: boolean;
  /** Noms seulement : jamais de valeur. */
  secrets: { name: string; updated_at: string | number }[];
}

export interface HookUntrustedEvent {
  type: "hook.untrusted";
  thread_id: string;
  sha256: string;
  count: number;
  notice: string;
}

export interface HookRanEvent {
  type: "hook.ran";
  thread_id: string;
  event: string;
  match?: string | null;
  source: "user" | "project";
  exit_code: number | null;
  duration_ms: number;
  timed_out: boolean;
  output?: string;
}

export interface MemoryNotedEvent {
  type: "memory.noted";
  thread_id: string;
  turn_index: number;
  name: string;
  kind: "rule" | "feedback" | "fact" | (string & {});
  scope: "project" | "user" | (string & {});
  title: string;
  derived_from: "user" | "repo" | "agent" | (string & {});
}

export interface MemoryForgottenEvent {
  type: "memory.forgotten";
  thread_id: string;
  name: string;
  kind: string;
  scope: string;
}
