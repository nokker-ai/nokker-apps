import type { Agent } from "./bubbles.js";

/** X17 (LOKKAL §7.15) : projets d'équipe. Erreurs `{error: {code, message}}` ; non-membre = 404 partout. */


export type ProjectRole = "viewer" | "member" | "maintainer" | "owner";

export interface ProjectRules {
  mode?: "plan" | "default" | "accept_edits";
  ask: string[];
  deny: string[];
}

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  role: ProjectRole;
  owner_account: string;
  repos: { key: string; memory_project: string }[];
  secret_names: { name: string; description?: string | null }[];
  budget: ProjectBudgetCap | null;
  rules: ProjectRules;
  mirror: boolean;
  created_at: string | number;
  updated_at: string | number;
}

/** Projet « SSO obligatoire » (§7.24) vu sans connexion SSO assez récente : le nom et le chemin de connexion,
 * rien du contenu ; toute route `/v1/projects/{id}*` répond alors 403 `sso_required`. */
export interface GatedProject {
  id: string;
  name: string;
  role: ProjectRole;
  created_at: string | number;
  sso: { required: true; connection: string };
}

export type ProjectEntry = Project | GatedProject;
export const isGatedProject = (p: ProjectEntry): p is GatedProject => "sso" in p && !!(p as GatedProject).sso?.required;

export interface ProjectMember {
  account_id: string;
  email: string;
  role: ProjectRole;
  added_at: string | number;
  you: boolean;
}

export interface ProjectInvitation {
  id: string;
  email: string;
  role: ProjectRole;
  state: "pending" | "accepted" | "declined" | "revoked" | "expired";
  created_at: string | number;
  expires_at: string | number;
  decided_at: string | number | null;
}

export interface MyInvitation {
  id: string;
  project: { id: string; name: string };
  role: ProjectRole;
  created_at: string | number;
  expires_at: string | number;
}

export interface ProjectSkill {
  name: string;
  source: string;
  description?: string | null;
  requires_local: boolean;
  added_by: string;
  added_at: string | number;
}

export interface ProjectNote {
  name: string;
  kind: string;
  deleted: boolean;
  sha: string;
  updated_at: string | number;
  author_account: string;
  seq: number;
  title?: string;
  text?: string;
}


/** Plafond d'un projet (§7.27) : jour et/ou mois CIVILS, heure suisse ; montants au centime, 0 … 1 000 000. */
export interface ProjectBudgetCap {
  daily?: number;
  monthly?: number;
  currency: "EUR" | "CHF" | "USD";
}

export interface BudgetWindow {
  spent: number;
  cap: number | null;
  ratio: number | null;
  /** none : pas de plafond ; warning : 80 % passé ; over : atteint (les tours du projet sont refusés). */
  state: "none" | "ok" | "warning" | "over";
  resets_at: string;
}

/** `GET /v1/projects/{id}/budget`. `counted: false` : plafond rangé, pas encore décompté sur cette instance. */
export interface ProjectBudgetView {
  project_id: string;
  budget: ProjectBudgetCap | null;
  counted: boolean;
  currency?: string;
  tz?: string;
  today?: BudgetWindow;
  month?: BudgetWindow;
  /** Owner et maintainer : une ligne par membre (anciens compris) ; les autres : leur ligne seulement. */
  members?: { account_id: string; email: string | null; role: ProjectRole | null; you: boolean; today: number; month: number; former?: boolean }[];
  /** Devises sans taux : le budget refuse les tours par prudence. */
  unconverted?: string[];
  unpriced_models?: string[];
}

/** Agent d'un autre membre vu dans le projet : ni mission, ni secrets, ni règles, ni fil (§7.27.2). */
/** Mon agent dans le projet : sa carte complète, plus le propriétaire. */
export type ProjectOwnAgent = Agent & { owner: { account_id: string; email: string }; mine: true; can_disarm: boolean };
export type ProjectAgentEntry = ProjectOwnAgent | ProjectOtherAgent;

export interface ProjectOtherAgent {
  id: string;
  name: string;
  status: string;
  trigger: Record<string, unknown> | null;
  last_run: { status: string; ended_at: string | null } | null;
  owner: { account_id: string; email: string };
  mine: false;
  can_disarm: boolean;
}

export interface ProjectAuditEvent {
  id: number | string;
  at: string | null;
  actor_account: string;
  event: "budget_set" | "budget_removed" | "note_restored" | "agent_disarmed" | (string & {});
  detail: Record<string, unknown>;
}

/** Ce que chaque rôle peut faire (miroir de `Team._gate`, pour griser l'interface ; le noyau décide). */
export const ROLE_RANK: Record<ProjectRole, number> = { viewer: 0, member: 1, maintainer: 2, owner: 3 };
export const canRole = (role: ProjectRole, need: ProjectRole): boolean => ROLE_RANK[role] >= ROLE_RANK[need];
