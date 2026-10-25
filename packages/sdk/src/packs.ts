/**
 * Packs d'agents (LOKKAL §7.30) : contenu livré avec le noyau seulement. Au web (drapeau `packs_web` de nokker.ai,
 * éteint : 404) ce qui n'exige pas la machine ; le reste va à la machine (relais X21, ou Lokkal). Lokkal : liste et
 * retrait par le jeton local (`/v1/local/packs`), l'installation passe par l'outil `pack_install` d'une session.
 * Erreurs web `{error: {code, message, …}}`.
 */

/** Ce qu'un modèle d'agent exige de la machine. */
export interface PackNeed {
  kind: "mcp" | "tool" | "gpu";
  name?: string;
}

export interface PackSplit {
  web: { skills: string[]; agents: string[] };
  machine: { skills: string[]; agents: { template: string; needs: PackNeed[] }[] };
}

export interface PackSummary {
  name: string;
  title: string;
  description: string;
  skills: string[];
  agents: string[];
  connectors: string[];
  mcp: string[];
  needs: Record<string, unknown>;
  installed: boolean;
  /** Web seulement : ce qui s'installe chez nokker.ai et ce qui reste à la machine. */
  web?: PackSplit["web"];
  machine?: PackSplit["machine"];
}

export interface PackSkill {
  name: string;
  family: string;
  description: string;
  /** `local` : exige la machine (fichiers, terminal, ssh, serveurs MCP ajoutés…). */
  locality: "local" | "both";
}

export interface PackAgentTemplate {
  id: string;
  name: string;
  role: string;
  trigger: Record<string, unknown>;
  auto_approve: string[];
  needs: Record<string, unknown>;
}

export interface PackMcpRole {
  role: string;
  purpose: string;
  examples: string[];
  optional: boolean;
  secrets: string[];
  tools: Record<string, { default: string; effect: string }>;
}

export interface PackDetail extends Omit<PackSummary, "skills" | "agents" | "mcp"> {
  skills: PackSkill[];
  agents: PackAgentTemplate[];
  mcp: PackMcpRole[];
  tools: string[];
  install?: { version: number; installed_at: number; skills: string[]; templates: string[]; proposed: { template: string; bubble_id: string }[]; bind: Record<string, string> };
  created_agents?: { id: string; name: string; status: string; armed: boolean; template: string | null }[];
}

/** Ce qui reste à la machine : machines liées, relais proposé (forme X21), et quoi faire sinon. */
export interface PackMachine {
  skills: string[];
  agents: { template: string; needs: PackNeed[] }[];
  linked: { machine_id: string; name: string; online: boolean }[];
  handoff: ({ machine_name?: string } & Record<string, unknown>) | null;
  next: string;
}

export interface PackInstallResult {
  installed: string;
  version: number;
  skills: string[];
  /** Cartes `agent_draft` posées dans le fil ; rien n'est créé ni armé. */
  proposed: { template: string; bubble_id: string }[];
  to_propose?: { template: string; needs: PackNeed[]; error?: string | null }[];
  armed: string[];
  partial: boolean;
  machine: PackMachine | null;
  note?: string;
  setup?: string[];
}

export interface PackRemoveResult {
  removed: string;
  skills: string[];
  already_removed: boolean;
  drafts_closed: string[];
  /** Agents créés depuis le pack, gardés tels quels (la carte `pack_agents` propose quoi en faire) ; null en Lokkal si inconnu. */
  agents: { id: string; name: string; status: string; armed: boolean }[] | null;
  card: string | null;
  note?: string;
  error?: string;
}

/** Bulle `pack_agents` (BUBBLES §9.6), posée par le noyau seulement ; actions disarm / delete / keep. */
export interface PackAgentsState {
  pack: string;
  agents: { id: string; name: string; status: string; armed: boolean }[];
  note?: string;
  owner?: string;
}
