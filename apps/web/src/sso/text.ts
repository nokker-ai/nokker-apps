/** Textes du SSO (connexion : FR/EN comme l'accueil ; réglages et équipe : FR comme l'onglet Équipe). */
import type { SsoRole } from "@nokker-apps/sdk";

type L = "fr" | "en";
const T: Record<string, Record<L, string>> = {
  // erreurs du parcours de connexion (§7.24) et de start
  invalid_state: {
    fr: "Cette connexion SSO n'est plus valable (lien périmé, déjà utilisé, ou ouvert dans un autre onglet). Recommence.",
    en: "This SSO sign-in is no longer valid (expired, already used, or opened in another tab). Start again.",
  },
  binding_invalid: { fr: "Cette connexion n'a pas été lancée depuis ce navigateur. Recommence depuis ici.", en: "This sign-in was not started from this browser. Start again from here." },
  idp_error: { fr: "Le fournisseur d'identité de ton organisation a refusé la connexion.", en: "Your organisation's identity provider refused the sign-in." },
  token_invalid: { fr: "La réponse du fournisseur d'identité n'a pas pu être vérifiée. Préviens l'administrateur du SSO.", en: "The identity provider's answer could not be verified. Tell your SSO administrator." },
  email_unverified: { fr: "Ton fournisseur d'identité ne garantit pas ton adresse e-mail : la connexion est refusée.", en: "Your identity provider does not vouch for your e-mail address: sign-in refused." },
  domain_refused: { fr: "Ton adresse n'appartient pas aux domaines de cette connexion SSO.", en: "Your address is not in this SSO connection's domains." },
  account_conflict: {
    fr: "Ce compte est déjà lié à une autre identité de ce fournisseur. Préviens l'administrateur du SSO.",
    en: "This account is already linked to another identity at this provider. Tell your SSO administrator.",
  },
  account_inactive: { fr: "Ce compte est suspendu ou effacé.", en: "This account is suspended or deleted." },
  unknown_connection: { fr: "Aucune connexion SSO pour cette adresse ou cet identifiant.", en: "No SSO connection for this address or identifier." },
  not_configured: { fr: "La connexion SSO de ton organisation n'est pas terminée (secret du client absent).", en: "Your organisation's SSO connection is not finished (client secret missing)." },
  idp_unavailable: { fr: "Le fournisseur d'identité ne répond pas. Réessaie dans un instant.", en: "The identity provider is not answering. Try again in a moment." },
  invalid_key: { fr: "Ce navigateur n'a pas pu créer sa clé d'appareil.", en: "This browser could not create its device key." },
  insecure_context: { fr: "Ouvre Nokker en https pour te connecter.", en: "Open Nokker over https to sign in." },
  missing_code: { fr: "Le fournisseur d'identité n'a rien renvoyé. Recommence.", en: "The identity provider sent nothing back. Start again." },
  rate: { fr: "Trop de tentatives : réessaie dans une minute.", en: "Too many attempts: try again in a minute." },
  network: { fr: "nokker.ai ne répond pas.", en: "nokker.ai is not answering." },
  generic: { fr: "La connexion SSO a échoué.", en: "SSO sign-in failed." },
  // écrans
  ssoLink: { fr: "Connexion SSO de ton organisation", en: "Sign in with your organisation's SSO" },
  ssoTitle: { fr: "Connexion SSO", en: "SSO sign-in" },
  ssoBody: { fr: "Ton adresse professionnelle suffit : elle désigne la connexion de ton organisation.", en: "Your work address is enough: it points to your organisation's connection." },
  ssoField: { fr: "Adresse professionnelle (ou identifiant sc_…)", en: "Work address (or sc_… identifier)" },
  ssoGo: { fr: "Continuer chez mon fournisseur", en: "Continue with my provider" },
  ssoGoing: { fr: "Redirection…", en: "Redirecting…" },
  ssoBack: { fr: "Masquer", en: "Hide" },
  ssoChecking: { fr: "Vérification de la connexion SSO…", en: "Checking the SSO sign-in…" },
  ssoRetry: { fr: "Recommencer", en: "Start again" },
  ssoHome: { fr: "Accueil", en: "Home" },
  ssoNewDevice: {
    fr: "Connecté. Un nouvel appareil a été enregistré pour ce navigateur ; l'ancien reste actif, tu peux le retirer dans Mon compte › Appareils.",
    en: "Signed in. A new device was registered for this browser; the previous one stays active, you can remove it in My account › Devices.",
  },
  ssoContinue: { fr: "Continuer", en: "Continue" },
};

export function ssoText(lang: string, key: string): string {
  const row = T[key] ?? T.generic!;
  return row[lang === "en" ? "en" : "fr"];
}

export const SSO_ROLE_LABEL: Record<SsoRole, string> = { maintainer: "mainteneur", member: "membre", viewer: "lecture" };

/** Âges proposés pour « SSO obligatoire » (bornes du noyau : 300 s … 7 j ; défaut 12 h). */
export const MAX_AGE_CHOICES: { s: number; label: string }[] = [
  { s: 3600, label: "1 h" },
  { s: 4 * 3600, label: "4 h" },
  { s: 12 * 3600, label: "12 h (défaut)" },
  { s: 86400, label: "24 h" },
  { s: 3 * 86400, label: "3 jours" },
  { s: 7 * 86400, label: "7 jours" },
];

export function maxAgeLabel(s: number): string {
  const hit = MAX_AGE_CHOICES.find((c) => c.s === s);
  if (hit) return hit.label;
  return s % 3600 === 0 ? `${s / 3600} h` : `${Math.round(s / 60)} min`;
}

/** Journal (`sso_audit`) en clair. */
export const AUDIT_LABEL: Record<string, string> = {
  connection_created: "connexion créée",
  connection_changed: "connexion modifiée",
  connection_deleted: "connexion supprimée",
  client_secret_set: "secret du client posé",
  domain_added: "domaine ajouté",
  domain_verified: "domaine prouvé",
  domain_removed: "domaine retiré",
  binding_set: "lien projet posé",
  binding_removed: "lien projet retiré",
  login_ok: "connexion réussie",
  login_refused: "connexion refusée",
  account_created: "compte créé",
  account_linked: "compte relié",
  member_added: "membre ajouté",
  role_changed: "rôle changé",
  role_removed: "rôle retiré",
  member_limit: "plafond de membres atteint",
  idp_unavailable: "fournisseur injoignable",
};

/** Erreurs des réglages (propriétaire), en clair. */
export const SETTINGS_ERROR: Record<string, string> = {
  secret_value_refused: "Une valeur de secret ne passe que par « Poser la valeur » (écriture seule).",
  bad_issuer: "Issuer : une URL https, sans requête ni identifiants.",
  bad_name: "Nom du secret : lettres, chiffres, « _ », « . », « - » (64 au plus).",
  bad_value: "Le secret : 4096 caractères au plus, sans espace autour.",
  bad_domain: "Domaine illisible (ex. example.com).",
  bad_role: "Rôle : mainteneur, membre ou lecture.",
  owner_not_mappable: "Le rôle propriétaire ne s'obtient jamais par le SSO.",
  not_verified: "L'enregistrement TXT n'est pas (encore) visible : vérifie sa valeur, puis réessaie dans quelques minutes.",
  domain_claimed: "Ce domaine est déjà prouvé par une autre connexion SSO.",
  dns_unavailable: "La vérification DNS est indisponible pour le moment.",
  too_many: "Plafond atteint (5 connexions, 20 domaines, 100 correspondances).",
  forbidden: "Seul le propriétaire du projet règle son SSO.",
  rate: "Trop d'écritures d'un coup : réessaie dans une minute.",
};
