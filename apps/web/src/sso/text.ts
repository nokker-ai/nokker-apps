/** Textes du SSO (connexion : FR/EN comme l'accueil ; réglages et équipe : FR comme l'onglet Équipe). */
import type { SsoRole } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";

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

export function ssoRoleLabel(role: SsoRole): string {
  return { maintainer: tr("maintainer"), member: tr("member"), viewer: tr("read-only") }[role];
}

/** Âges proposés pour « SSO obligatoire » (bornes du noyau : 300 s … 7 j ; défaut 12 h). */
export function maxAgeChoices(): { s: number; label: string }[] {
  return [
    { s: 3600, label: "1 h" },
    { s: 4 * 3600, label: "4 h" },
    { s: 12 * 3600, label: tr("12 h (default)") },
    { s: 86400, label: "24 h" },
    { s: 3 * 86400, label: tr("3 days") },
    { s: 7 * 86400, label: tr("7 days") },
  ];
}

export function maxAgeLabel(s: number): string {
  const hit = maxAgeChoices().find((c) => c.s === s);
  if (hit) return hit.label;
  return s % 3600 === 0 ? `${s / 3600} h` : `${Math.round(s / 60)} min`;
}

/** Journal (`sso_audit`) en clair ; le code brut si l'événement est inconnu. */
export function auditLabel(kind: string): string {
  switch (kind) {
    case "connection_created": return tr("connection created");
    case "connection_changed": return tr("connection changed");
    case "connection_deleted": return tr("connection deleted");
    case "client_secret_set": return tr("client secret set");
    case "domain_added": return tr("domain added");
    case "domain_verified": return tr("domain verified");
    case "domain_removed": return tr("domain removed");
    case "binding_set": return tr("project link set");
    case "binding_removed": return tr("project link removed");
    case "login_ok": return tr("sign-in succeeded");
    case "login_refused": return tr("sign-in refused");
    case "account_created": return tr("account created");
    case "account_linked": return tr("account linked");
    case "member_added": return tr("member added");
    case "role_changed": return tr("role changed");
    case "role_removed": return tr("role removed");
    case "member_limit": return tr("member limit reached");
    case "idp_unavailable": return tr("provider unreachable");
    default: return kind;
  }
}

/** Erreurs des réglages (propriétaire), en clair ; `undefined` si le code est inconnu. */
export function settingsError(code: string): string | undefined {
  switch (code) {
    case "secret_value_refused": return tr("A secret value only goes through “Set the value” (write-only).");
    case "bad_issuer": return tr("Issuer: an https URL, with no query or credentials.");
    case "bad_name": return tr("Secret name: letters, digits, “_”, “.”, “-” (64 at most).");
    case "bad_value": return tr("The secret: 4096 characters at most, no surrounding spaces.");
    case "bad_domain": return tr("Unreadable domain (e.g. example.com).");
    case "bad_role": return tr("Role: maintainer, member or read-only.");
    case "owner_not_mappable": return tr("The owner role is never obtained through SSO.");
    case "not_verified": return tr("The TXT record is not (yet) visible: check its value, then try again in a few minutes.");
    case "domain_claimed": return tr("This domain is already proven by another SSO connection.");
    case "dns_unavailable": return tr("DNS verification is unavailable for now.");
    case "too_many": return tr("Limit reached (5 connections, 20 domains, 100 mappings).");
    case "forbidden": return tr("Only the project owner manages its SSO.");
    case "rate": return tr("Too many writes at once: try again in a minute.");
    default: return undefined;
  }
}
