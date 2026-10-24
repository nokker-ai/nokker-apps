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

export interface RemoteApproval {
  approval_id: string;
  title: string;
  /** Caviardé par le Lokkal, ≤ 600 caractères. */
  reason: string;
  strength: string;
  expires_at: string;
  challenge: string;
  status: RemoteApprovalStatus;
}

/** Même preuve qu'une décision locale, sur `<challenge>.<decision>` : passkey (WebAuthn, uv exigé pour une carte
 * forte, challenge de l'assertion = sha256 du message) OU clé d'appareil (ECDSA P1363). */
export type RemoteDecisionProof =
  | { device_id: string; webauthn_client_data_json: string; webauthn_authenticator_data: string; webauthn_signature: string }
  | { device_id: string; signature: string };

export type RemoteDecision = "approve" | "reject";
