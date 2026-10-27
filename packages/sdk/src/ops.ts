/**
 * X18 (LOKKAL §7.18) : incidents (drapeau `operate`) et plan (drapeau `plan`). Drapeaux éteints = 404 comme avant.
 * Erreurs `{error: {code, message}}`.
 */

export type IncidentState = "open" | "in_progress" | "resolved";

export interface AlertSource {
  id: string;
  name: string;
  format: "alertmanager" | "generic";
  url: string;
  created_by: string;
  created_at: string;
  last_seen_at: string | null;
  has_secret: boolean;
  auth: "hmac" | "bearer";
}

/** Rendu UNE fois (création ou rotation) : la clé ne se relit jamais. */
export interface AlertSourceSecret {
  source: AlertSource;
  secret: string;
  url: string;
  header: string;
  signature: string;
}

export interface IncidentRun {
  run_id: string;
  agent_id: string;
  agent: string;
  status: string;
  summary: string | null;
  thread_id: string | null;
  ended_at: string | null;
  approvals: { id: string; tool: string; status: string; strength: string }[];
}

export interface IncidentTimelineEntry {
  at: string;
  kind: "opened" | "agent_run" | "card" | "no_agent" | "acked" | "resolved" | (string & {});
  text: string;
  by?: string | null;
  run_id?: string | null;
  approval_id?: string | null;
}

export interface Incident {
  id: string;
  source: { id: string; name: string };
  fingerprint: string;
  name: string;
  title: string;
  severity: string | null;
  state: IncidentState;
  labels: Record<string, string>;
  summary: string;
  occurrences: number;
  first_seen_at: string;
  last_seen_at: string;
  started_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  acked_by: string | null;
  runs: IncidentRun[];
  created_at: string;
  updated_at: string;
  last_event: IncidentTimelineEntry | null;
  /** GET d'un incident seulement. */
  timeline?: IncidentTimelineEntry[];
}

export interface IncidentUpdatedEvent {
  type: "incident.updated";
  incident: Incident;
}

export type PlanCardKind = "goal" | "milestone" | "task";
export type PlanCardStatus = "todo" | "in_progress" | "blocked" | "done";

export interface PlanCard {
  id: string;
  parent_id: string | null;
  project: string | null;
  kind: PlanCardKind;
  title: string;
  intent: string;
  constraints: string[];
  decisions: string[];
  status: PlanCardStatus;
  /** Carte mère : statut calculé depuis les filles, lecture seule (`PATCH {status}` → 400 `computed`). */
  computed: boolean;
  progress: { done: number; total: number; blocked: number; in_progress: number; ratio: number };
  children: string[];
  depth: number;
  agents: string[];
  threads: string[];
  position: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface PlanCardDetail extends PlanCard {
  ancestors: { id: string; kind: PlanCardKind; title: string }[];
  children_cards: PlanCard[];
}

export interface PlanContext {
  card_id: string;
  chain: { id: string; kind: PlanCardKind; title: string }[];
  block: string;
}

export interface PlanChildProposal {
  title: string;
  kind: PlanCardKind | null;
  intent: string;
  constraints: string[];
}

export interface PlanProposal {
  id: string;
  card_id: string;
  children: PlanChildProposal[];
  reason: string;
  state: "proposed" | "accepted" | "refused" | "stale";
  proposed_by: string;
  thread_id: string | null;
  bubble_id: string | null;
  created: string[];
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export type PlanCardInput = Partial<Pick<PlanCard, "title" | "kind" | "parent_id" | "project" | "intent" | "constraints" | "decisions" | "status" | "agents" | "position">>;

export interface PlanCardUpdatedEvent {
  type: "plan.card.updated";
  card: PlanCard;
}
export interface PlanCardDeletedEvent {
  type: "plan.card.deleted";
  id: string;
  lifted: string[];
}
export interface PlanProposalUpdatedEvent {
  type: "plan.proposal.updated";
  proposal: PlanProposal;
}

/** Bulle `plan_split` (posée par le noyau ; actions `accept` « Créer ces cartes » / `refuse` « Non »). */
export interface PlanSplitState {
  proposal_id: string;
  card_id: string;
  card_title: string;
  children: PlanChildProposal[];
  reason: string;
  state: PlanProposal["state"];
  created?: string[];
}

/** Bulle `brief` : le texte du brief du matin (Markdown simple). */
export interface BriefState {
  text: string;
  run_id: string;
  agent_id: string;
  date: string;
}

/** Libellés : l'anglais est la source, le français vient des tables `*_FR` (fonctions `…Label(x, lang)`). */
export const INCIDENT_STATE_LABEL: Record<IncidentState, string> = { open: "open", in_progress: "in progress", resolved: "resolved" };
export const PLAN_STATUS_LABEL: Record<PlanCardStatus, string> = { todo: "to do", in_progress: "in progress", blocked: "blocked", done: "done" };
export const PLAN_KIND_LABEL: Record<PlanCardKind, string> = { goal: "goal", milestone: "milestone", task: "task" };
export const INCIDENT_STATE_LABEL_FR: Record<IncidentState, string> = { open: "ouvert", in_progress: "en cours", resolved: "résolu" };
export const PLAN_STATUS_LABEL_FR: Record<PlanCardStatus, string> = { todo: "à faire", in_progress: "en cours", blocked: "bloqué", done: "fait" };
export const PLAN_KIND_LABEL_FR: Record<PlanCardKind, string> = { goal: "objectif", milestone: "lot", task: "tâche" };

export type OpsLang = "en" | "fr";
export const incidentStateLabel = (s: IncidentState, lang: OpsLang = "en"): string => (lang === "fr" ? INCIDENT_STATE_LABEL_FR : INCIDENT_STATE_LABEL)[s] ?? s;
export const planCardStatusLabel = (s: PlanCardStatus, lang: OpsLang = "en"): string => (lang === "fr" ? PLAN_STATUS_LABEL_FR : PLAN_STATUS_LABEL)[s] ?? s;
export const planCardKindLabel = (k: PlanCardKind, lang: OpsLang = "en"): string => (lang === "fr" ? PLAN_KIND_LABEL_FR : PLAN_KIND_LABEL)[k] ?? k;

/** Livraison du brief hors de l'app (§7.18.5) : choix de chaque personne, tout éteint par défaut. L'e-mail ne part
 * qu'après une carte forte (`brief_delivery_arm`) signée pour cette adresse et cette boîte. */
export interface BriefDelivery {
  telegram: { enabled: boolean; chats: number };
  email: { address: string | null; from: string | null; state: "off" | "pending" | "armed" | "not_armed"; approval_id: string | null };
  last: { at: string | number; telegram: "off" | "sent" | "failed" | "no_chat"; email: "off" | "sent" | "failed" | "not_armed" } | null;
}
