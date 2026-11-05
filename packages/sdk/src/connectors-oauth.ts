/**
 * Connexions OAuth (core docs/CONNECTORS-OAUTH.md, p2/connectors-oauth 5cf31ef ; `features.connectors_oauth`) : le
 * navigateur suit l'URL du fournisseur et revient par un 302 sur `/account/connectors?oauth=done|error…`. Aucun jeton
 * côté navigateur, SAUF le jeton du sélecteur Google (`drive.file` seul, ≤ 10 min, en mémoire le temps du sélecteur ;
 * décision du 05.11).
 */
import type { MultiKind } from "./connectors-multi.js";

export interface OAuthStartRequest {
  services: MultiKind[];
  label?: string;
  /** Ajouter des services à un compte déjà relié (consentement incrémental). */
  oauth_account?: string;
}

export interface OAuthStartResult {
  url: string;
  expires_at: string;
}

export type OAuthReturnError = "denied" | "expired" | "scope_missing" | "provider_error" | "already_linked_elsewhere";

/** Retour du fournisseur lu dans l'adresse (`?oauth=…`), ou `null`. */
export interface OAuthReturn {
  status: "done" | "error";
  provider: string | null;
  code: OAuthReturnError | string | null;
  account: string | null;
  missing: MultiKind[];
}

/** `POST /v1/connectors/{id}/picker` : jeton du sélecteur Google (drive.file seul), jamais rangé. */
export interface PickerGrant {
  access_token: string;
  expires_in: number;
  developer_key: string;
  app_id: string;
  /** Mock seulement (`developer_key: "mock-picker"`) : fichiers que propose le sélecteur simulé. */
  mock_files?: Array<{ id: string; name: string }>;
}

export interface PickedFile {
  id: string;
  name: string;
  mime?: string;
  picked_at?: string;
}
