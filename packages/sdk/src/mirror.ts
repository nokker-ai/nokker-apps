/**
 * Miroir abonné vu de la machine (LOKKAL §7.23, jeton local) : état par canal, pages gardées en ligne machine
 * éteinte, choix des projets mémoire ; et, côté nokker.ai, l'historique des versions remplacées d'un projet d'équipe.
 * Les heures de la machine sont des secondes epoch.
 */

export type MirrorChannel = "turns_push" | "turns_pull" | "notes" | "team_notes" | "pages" | "resync";
export const MIRROR_CHANNELS: MirrorChannel[] = ["turns_push", "turns_pull", "notes", "team_notes", "pages", "resync"];

export interface MirrorChannelState {
  last_ok_at: number | null;
  failures: number;
  last_error: { at: number; kind: string; message: string } | null;
  /** Secondes avant le prochain essai (0 : maintenant). */
  retry_in_s: number;
}

export interface MirrorSpace {
  used: number;
  quota: number;
}

export interface LocalMirrorStatus {
  /** `false` seul : miroir non actif sur cette machine (drapeau `local.mirror` éteint, le défaut de l'install). */
  enabled: boolean;
  paused?: boolean;
  push_cursor?: number | null;
  pull_cursor?: number | null;
  last_sent_at?: number | null;
  /** Secondes depuis le dernier envoi réussi quand quelque chose attend ; 0 rien n'attend ; null rien n'est jamais parti. */
  behind_s?: number | null;
  pending?: { turns: number; notes?: number; team_notes?: number; pages?: number };
  channels?: Partial<Record<MirrorChannel, MirrorChannelState>>;
  resync?: { requested: boolean; last_at: number | null };
  pages_space?: MirrorSpace | null;
  /** Notes d'équipe : clés `pj_…|p-…` ; erreurs par projet (`pj_…`) ou par note (`pj_…/nom`). */
  team?: {
    /** `name` : nom du projet d'équipe, connu après le premier passage de synchro (null ou absent avant). */
    projects: Record<string, { cursor: number | string | null; notes: number; name?: string | null }>;
    errors: Record<string, { op?: string; status: number; code: string; message: string; at: number }>;
  };
}

export type MirrorPageState = "off" | "pending" | "sent" | "quota" | "refused";

export interface LocalMirrorPage {
  page_id: string;
  title: string;
  version: number;
  size: number;
  mirror: boolean;
  state: MirrorPageState;
  error: string | null;
}

export interface LocalMirrorProject {
  /** Projet mémoire local `p-…` (nom opaque). */
  project: string;
  label: string;
  mirror: boolean;
}

/** Version remplacée ou oubliée d'une note de projet d'équipe (`GET /v1/projects/{id}/notes/quarantine`, maintainer). */
export interface QuarantinedNote {
  /** Identifiant de la ligne (`POST …/notes/quarantine/{id}/restore`). */
  id: number | string;
  project_id?: string;
  name: string;
  kind: string;
  title: string;
  text: string;
  sha: string;
  updated_at: string | number | null;
  author_account: string;
  author_machine?: string;
  reason: string;
  quarantined_at: string | number | null;
  /** Remise en place depuis (la ligne reste listée : rien n'est effacé). */
  restored_at?: string | null;
  restored_by?: string | null;
}

/** Projets mémoire `p-…` reliés à un projet d'équipe (clés `pj_…|p-…` de `team.projects`) → nom du projet d'équipe
 * (null tant que la synchro ne l'a pas appris). */
export function teamMemoryProjects(status: LocalMirrorStatus | null | undefined): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const [k, v] of Object.entries(status?.team?.projects ?? {})) {
    const p = k.split("|")[1];
    if (p && !out.get(p)) out.set(p, v.name || null);
  }
  return out;
}
