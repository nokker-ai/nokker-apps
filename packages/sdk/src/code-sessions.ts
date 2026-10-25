/**
 * Sessions de code multi-utilisateur (LOKKAL §7.28, déploiement entreprise). Un COMPTE (`us_…`) ouvre une session dans
 * SON locataire : un espace de travail, un bac à sable libéré après `idle_ttl_s` sans appel (la session passe `idle`,
 * l'espace reste), un fil du hub dont l'id = celui de la session (`X-Session-Id`). Drapeau `code.enabled` : éteint,
 * aucune route `/v1/code/*` (404). Erreurs `{error: {code, message}}` ; la session d'un autre compte : 404.
 */

/** Modes d'ouverture possibles côté noyau ; ceux PERMIS sont `code.modes` de l'instance. */
export type CodeMode = "default" | "accept_edits" | "plan" | "auto";

export interface CodeSessionRepo {
  /** URL https propre (jamais d'identifiant dedans). */
  url: string;
  ref: string | null;
  /** NOM de l'identifiant de forge au coffre du locataire, jamais sa valeur. */
  credential: string | null;
}

export interface CodeSession {
  /** `cs_` + 16 hex. */
  id: string;
  /** = `id` : à passer en `X-Session-Id` (le fil de la session au hub). */
  thread_id: string;
  status: "active" | "idle";
  mode: CodeMode | string;
  /** Chemin dans le bac à sable (`/workspace`). */
  workspace: string;
  backend: "docker" | "kubernetes" | string;
  repo: CodeSessionRepo | null;
  created_at: string;
  last_used_at: string;
  /** Présent quand `code.hooks` est allumé (hors de ce lot côté web). */
  hooks?: unknown;
  /** Skills du dépôt (§7.28.13, drapeau `code.project_skills`) : invisibles tant que le propriétaire n'a pas fait
   * confiance à CET arbre ; `root` = chemin DANS le bac à sable. */
  skills?: CodeSessionSkills;
  /** Sous-agents (§7.28.14, `code.max_subagents` > 0) : vivants sur plafond. */
  subagents?: { limit: number; live: number };
}

export interface CodeSessionSkills {
  enabled: boolean;
  project: "absent" | "trusted" | "untrusted" | "invalid" | (string & {});
  root: string;
  /** Empreinte de l'arbre `.nokker/skills` ; `null` sans arbre lisible. */
  sha256: string | null;
  count: number;
  notice: string | null;
}

/** `POST /v1/code/sessions/{cs}/skills/trust` → 200. 404 `not_found` | `skills_absent`, 409 `skills_changed`. */
export interface CodeSkillsTrusted {
  thread_id: string;
  root: string;
  sha256: string;
  trusted: true;
}

export interface CodeSessionList {
  sessions: CodeSession[];
  /** `max_sessions_per_user` : sessions vivantes (active + idle) par compte. */
  limit: number;
  /** `code.modes` (dans l'ordre de la config) : les seuls modes acceptés à l'ouverture. */
  modes: string[];
  default_mode: string;
  /** Délai sans appel avant que le bac à sable soit libéré (la session passe `idle`, l'espace reste). */
  idle_ttl_s: number;
}

export interface CodeSessionCreate {
  repo?: { url: string; credential?: string; ref?: string; depth?: number };
  mode?: string;
}

export interface CodeSessionClosed {
  id: string;
  closed: true;
  purged: boolean;
}

export interface CodeCredential {
  name: string;
  updated_at: string | null;
}

/** Outils qu'un écran appelle hors tour sur SA session (`POST /v1/code/sessions/{cs}/tools/call`) : les points de retour
 * seulement (sinon 403 `tool_not_allowed`). `content` et réponses comme `callLocalTool` (`CheckpointInfo[]`,
 * `CheckpointDiff`, `CheckpointRestoreResult`). */
export type CodeToolName =
  | "checkpoint_list"
  | "checkpoint_diff"
  | "checkpoint_restore"
  /** Skills en lecture (§7.28.13) : `{skills: SkillInfo[], note?}` ; `skill_view {name, file?}`. */
  | "skill_list"
  | "skill_view"
  /** Sous-agents (§7.28.14) : `delegate_status` SANS `wait_s` (400 `bad_arguments`), `delegate_cancel {ids?}`. */
  | "delegate_status"
  | "delegate_cancel";
