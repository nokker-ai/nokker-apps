/**
 * « Mon compte » : profil, usage, export, suppression (`/v1/account*`, contrat final de Nokker dev du 22.10.2026)
 * et abonnement (`/v1/billing/*`, nokker/billing). Ces dernières répondent 404 tant que `billing_enabled` est faux.
 * Après l'accord de la carte de suppression, le compte et son locataire sont `suspended` : toute requête, `GET /v1/account`
 * compris, répond 403 `{"error":{"message":"forbidden"}}` (aucun code dédié).
 */

export interface AccountInfo {
  email: string;
  lang: string;
  created_at: string;
  /** Toujours `active` en pratique : un compte suspendu ne lit plus `GET /v1/account` (403). */
  status: string;
  terms: { version: string; accepted_at: string } | null;
  /** Consentement d'usage des conversations pour améliorer les modèles (facultatif, révocable). */
  consents: { training: boolean; /** X23 : profil mineur, le consentement d'entraînement est verrouillé à non. */ training_locked?: "minor" };
}

/** `PUT /v1/account/consent` — 400 `invalid` si la portée ou le booléen est faux, 503 `consents_disabled` si non configuré. */
export interface AccountConsentResult {
  scope: "training";
  granted: boolean;
}

/** `cap` ou `hard_cap` à `null` : pas de limite (locataire interne). `over` = used > cap ; en mode `soft` le tour passe quand même. */
export interface UsageCounter {
  used: number;
  cap: number | null;
  over?: boolean;
  hard_cap?: number | null;
}

/** Fenêtres décidées le 22.10 : jour de midi UTC à midi UTC, semaine du lundi 06:00 UTC au lundi suivant ; `starts` et `resets_at` sont des horodatages ISO. Pas de compteur `deep`. */
export interface AccountUsage {
  tz?: string;
  mode?: "soft" | "hard";
  plan?: string | null;
  today: { day: string; resets_at?: string; turns: UsageCounter; browser?: UsageCounter };
  week?: { starts: string; resets_at: string; turns: UsageCounter; browser?: UsageCounter };
  month?: { turns: { used: number } };
  /** X23 : membre d'un foyer — quota commun et sa propre part (plafond et sa source). */
  household?: {
    id: string;
    mode: "soft" | "hard";
    today: { used: number; cap: number | null; resets_at: string };
    week: { used: number; cap: number | null; resets_at: string };
    member: { today: number; cap: number | null; source: "default" | "custom" | "none" };
  };
}

export interface BillingPlanInfo {
  id: string;
  caps: Record<string, number>;
}

/** `GET /v1/billing/plan` : `plan` n'est posé que si l'abonnement est vivant (actif, essai, impayé en relance). */
export interface BillingStatus {
  plan: string | null;
  status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  plans: BillingPlanInfo[];
}

/** `POST /v1/account/delete` : 202, carte d'approbation FORTE (une seule en attente : la même est rendue).
 * Elle se décide par `/v1/approvals/{id}/challenge` puis `/decision` avec un appareil fort ; une preuve trop faible
 * rend 403 `code: "strong_device_required"` et la carte reste en attente jusqu'à `expires_at`. */
export interface AccountDeleteResult {
  approval_id: string;
  strength: "strong";
  expires_at: string;
  reason: string;
}

/** Export synchrone : `POST /v1/account/export` → 202, construit tout de suite et gardé 24 h (un par 24 h).
 * 429 `export_limit` (avec `retry_at`), 503 `export_disabled`. `download` est un chemin d'API authentifié
 * (`/v1/account/exports/{id}/download`), `null` une fois expiré ; le télécharger avec `downloadAccountExport`. */
export interface AccountExport {
  id: string;
  status: "ready" | "expired";
  created_at: string;
  expires_at: string;
  size: number;
  download: string | null;
}

/** Fichier JSON d'un export, prêt à être proposé au téléchargement. */
export interface AccountExportFile {
  filename: string;
  json: string;
}
