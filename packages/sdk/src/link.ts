/** Flux d'appareil (Lokkal → nokker.ai) côté page `/link` : voir `GET /v1/link/pending` et `POST /v1/link/approve`. */

/** Alphabet des codes `XXXX-XXXX` : sans voyelles ni caractères ambigus. */
export const LINK_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";

export interface LinkPending {
  machine_name: string;
  /** Secondes avant l'expiration du code. */
  expires_in: number;
}

export type LinkDecision = "approve" | "deny";

export interface LinkApproveResult {
  state: "approved" | "denied";
  machine_id?: string;
  host?: string;
}

/** « Mes machines » : une machine Lokkal liée au compte (`GET /v1/link/machines`, contrat proposé à dev le 24.10). */
export interface LinkedMachine {
  machine_id: string;
  name: string;
  /** `<nom>.nokker.app` : la passerelle de la machine. */
  host: string;
  /** Secondes epoch. */
  created_at: number;
  /** Dernier contact du relais (secondes epoch), `null` si jamais vu ou inconnu. */
  last_seen_at: number | null;
}

export interface LinkedMachines {
  machines: LinkedMachine[];
}

/** Carte FORTE d'une machine liée, déposée sur nokker.ai pour être signée par un appareil du compte (LOKKAL §7.3).
 * nokker.ai ne décide jamais : `forwarded` = preuve transmise, le statut final vient du Lokkal qui l'a vérifiée. */
export type RemoteApprovalStatus = "pending" | "forwarded" | "approved" | "rejected" | "expired";

/** LOKKAL §7.12 point 8 (X20c) : ce que nokker.ai a lu des arguments déposés. */
export interface ApprovalSummaryLine {
  key: string;
  label: string;
  value: string;
  /** Adresses une par une (destinataires, invités), jusqu'à 20. */
  items?: string[];
  count?: number;
  /** Extrait coupé (280 car.) et sa longueur totale. */
  truncated?: boolean;
  length?: number;
  /** La valeur contenait un secret caviardé. */
  redacted?: boolean;
}

export interface ApprovalSummary {
  tool: string;
  class: "read" | "internal_write" | "external_send" | "destructive" | null;
  headline: string | null;
  lines: ApprovalSummaryLine[];
  /** Après la décision ou l'expiration : lignes effacées. */
  erased: boolean;
}

export interface RemoteApproval {
  approval_id: string;
  /** Texte de la MACHINE : au second plan, jamais en titre, jamais interprété (HTML, Markdown). */
  title: string;
  /** Caviardé par le Lokkal, ≤ 600 caractères. */
  reason: string;
  strength: string;
  /** ISO 8601. */
  expires_at: string;
  challenge: string;
  status: RemoteApprovalStatus;
  /** X20c : `nokker.ai` = arguments déposés et vérifiés ; `machine` = carte locale ou déposée sans arguments. */
  summary_source?: "nokker.ai" | "machine";
  summary?: ApprovalSummary;
  args_sha256?: string;
  /** X10 : preuve refusée par la machine (retour à `pending`) : re-signer. */
  error?: string | null;
  /** X10 : issue de l'exécution sur la machine. */
  outcome?: "executed" | "failed" | null;
  /** Avis du juge (vide tant que X8 n'est pas branché). */
  advice?: string | null;
}

/** Même preuve qu'une décision locale, sur `<challenge>.<decision>` : passkey (WebAuthn, uv exigé pour une carte
 * forte, challenge de l'assertion = sha256 du message) OU clé d'appareil (ECDSA P1363). */
export type RemoteDecisionProof =
  | { device_id: string; webauthn_client_data_json: string; webauthn_authenticator_data: string; webauthn_signature: string }
  | { device_id: string; signature: string };

export type RemoteDecision = "approve" | "reject";

/** X15 (LOKKAL §7.19 point 5) : le deck de toutes les machines du compte. Dates en secondes epoch ; des noms et des
 * états seulement (ni mission, ni compte rendu, ni message). */
export interface DeckLoad {
  ram: { total_mb: number; free_mb: number };
  cpu: { count: number; load1: number; rel: number };
  gpus: { name: string; memory_total_mb: number; memory_free_mb: number; util_pct: number }[];
  sessions: number;
  active_turns: number;
}

export interface DeckSession {
  thread_id: string;
  /** Nom du dossier de la session sur la machine. */
  name: string;
  state: "idle" | "working" | "awaiting_approval";
  title: string | null;
}

export interface DeckAgent {
  id: string;
  name: string;
  status: "paused" | "armed" | "running" | "failed";
  placement: { machine: string } | null;
  trigger: string;
  next_run_at: number | string | null;
  last_run: { status: string; ended_at: number | string | null } | null;
  live_run: { run_id: string; status: string; machine_id: string | null } | null;
  defined_at: "nokker.ai" | "machine";
}

export interface DeckMachine {
  machine_id: string;
  name: string;
  host: string;
  online: boolean;
  load_age_s: number | null;
  load: DeckLoad | null;
  deck_at: number | null;
  deck_age_s: number | null;
  sessions: DeckSession[];
  agents: DeckAgent[];
  pending_approvals: number;
  strong_approvals: { approval_id: string; expires_at: string; url: string }[];
}

export interface DeckView {
  at: number;
  machines: DeckMachine[];
  web: { engine: boolean; agents: DeckAgent[] };
  auto: { agents: DeckAgent[] };
}

/** 409 d'un déménagement : ce qu'il faut poser à destination. */
export interface MoveMissing {
  kind: "secret" | "repo" | "host" | "connector" | "mcp" | "gpu" | "machine" | "engine" | "offer" | (string & {});
  name?: string;
  machine_id?: string;
  message: string;
}
