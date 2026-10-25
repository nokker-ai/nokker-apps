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
  budget: { monthly: number; currency: "EUR" | "CHF" | "USD" } | null;
  rules: ProjectRules;
  mirror: boolean;
  created_at: string | number;
  updated_at: string | number;
}

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


/** Ce que chaque rôle peut faire (miroir de `Team._gate`, pour griser l'interface ; le noyau décide). */
export const ROLE_RANK: Record<ProjectRole, number> = { viewer: 0, member: 1, maintainer: 2, owner: 3 };
export const canRole = (role: ProjectRole, need: ProjectRole): boolean => ROLE_RANK[role] >= ROLE_RANK[need];
