/**
 * « Mon compte » : profil, usage, export, suppression (`/v1/account*`, contrat final de Nokker dev du 22.10.2026)
 * et abonnement (`/v1/billing/*`, nokker/billing). Ces dernières répondent 404 tant que `billing_enabled` est faux.
 * Sur un compte en cours d'effacement, toutes les autres routes répondent 403 `{"error":"account_deleting"}`.
 */

export interface AccountInfo {
  email: string;
  lang: string;
  created_at: string;
  /** `deleting` : entre l'approbation de la suppression et l'effacement ; l'UI affiche alors un écran fixe. */
  status: "active" | "deleting";
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

/** `POST /v1/account/delete` : l'effacement attend la décision sur une carte d'approbation (appareil fort). */
export interface AccountDeleteResult {
  approval_id: string;
}

/** Export asynchrone : `POST /v1/account/export` → 202 (ou 200 si un export est déjà en cours), puis sondage. */
export interface AccountExportStart {
  id: string;
  status: "pending" | "ready" | "expired";
}

export interface AccountExportStatus {
  status: "pending" | "ready" | "expired";
  /** Lien valable 24 h, à usage unique. */
  download_url?: string;
  expires_at?: string;
}
