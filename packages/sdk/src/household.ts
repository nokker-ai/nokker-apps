/**
 * X23 (LOKKAL §7.29) : le foyer, offre Famille ou Large. Un projet d'équipe de type `household` : le payeur (owner),
 * jusqu'à 5 autres membres, un quota commun, une mémoire commune ; chacun garde son locataire et sa mémoire de profil.
 * Drapeaux `household` (sinon 404 partout) et `household_minors` (profils adolescent / enfant). Erreurs `{error: {code,
 * message}}`. Le payeur voit la consommation de chacun, jamais le contenu.
 */

export type HouseholdProfile = "adult" | "teen" | "child";

export interface HouseholdWindow {
  used: number;
  cap: number | null;
  resets_at: string;
}

export interface HouseholdMember {
  account_id: string;
  email: string;
  payer: boolean;
  profile: HouseholdProfile;
  status: "active" | "suspended";
  joined_at: string;
  you: boolean;
  turns: { today: number; week: number };
  cap: { turns_per_day: number | null; source: "default" | "custom" | "none" };
}

export interface HouseholdInvitation {
  id: string;
  email: string;
  profile: HouseholdProfile;
  state: "pending" | "accepted" | "declined" | "revoked" | "expired";
  created_at: string;
  expires_at: string;
  decided_at: string | null;
}

export interface HouseholdPolicy {
  minor_connectors: string[];
  minor_agents: string[];
}

export interface Household {
  id: string;
  name: string;
  created_at: string;
  plan: string;
  mode: "soft" | "hard";
  max_members: number;
  size: number;
  counted: number;
  you: { account_id: string; payer: boolean; profile: HouseholdProfile };
  quota: { tz: string; today: HouseholdWindow; week: HouseholdWindow };
  /** Payeur : tous les membres ; membre : sa propre ligne. */
  members: HouseholdMember[];
  /** Payeur seulement. */
  invitations?: HouseholdInvitation[];
  policy?: HouseholdPolicy;
  minors?: { enabled: boolean };
}

export interface ReceivedHouseholdInvitation {
  id: string;
  household: { id: string; name: string };
  profile: HouseholdProfile;
  created_at: string;
  expires_at: string;
}

/** Texte d'attestation du représentant légal ; `version` = sha256 des octets du texte, renvoyée telle quelle. */
export interface HouseholdConsentText {
  version: string;
  lang: "fr" | "en";
  text: string;
}

export interface HouseholdAttestation {
  version: string;
  lang: "fr" | "en";
  legal_guardian: true;
}

export interface HouseholdConsentRecord {
  id: string;
  minor_email: string;
  profile: HouseholdProfile;
  version: string;
  lang: string;
  granted_at: string;
  revoked_at: string | null;
  active: boolean;
}

export interface HouseholdNote {
  name: string;
  kind: "rule" | "feedback" | "fact";
  deleted: boolean;
  sha: string;
  updated_at: string;
  author_account: string;
  seq: number;
  title?: string;
  text?: string;
}

export interface HouseholdQuarantined {
  id: string;
  name: string;
  title?: string;
  text?: string;
  sha: string;
  updated_at: string;
  author_account: string;
  replaced_by?: string | null;
}

/** Carte d'un membre mineur qui attend la décision du représentant (outil, arguments, motif ; jamais le fil). */
export interface HouseholdApproval {
  member: { account_id: string; email: string; profile: HouseholdProfile };
  approval: {
    id: string;
    tool_name: string;
    effect?: string;
    strength?: string;
    reason?: string;
    args?: Record<string, unknown>;
    status: string;
    created_at?: string;
    expires_at?: string;
  };
}

export const HOUSEHOLD_PROFILE_LABEL: Record<"fr" | "en", Record<HouseholdProfile, string>> = {
  fr: { adult: "adulte", teen: "adolescent", child: "enfant" },
  en: { adult: "adult", teen: "teen", child: "child" },
};

/** Paliers d'abonnement qui portent un foyer (miroir de `HOUSEHOLD_PLANS` du noyau). */
export const HOUSEHOLD_PLANS = ["famille", "large"] as const;
