/**
 * « Mon foyer » (X23, LOKKAL §7.29.6) : textes FR/EN et calculs purs de l'écran. Le noyau tranche tout (droits,
 * plafonds, attestation) ; ici on affiche, on grise, et on traduit ses codes d'erreur.
 */
import { NokkerApiError, type ConnectorKind, type Household, type HouseholdMember, type HouseholdProfile } from "@nokker-apps/sdk";
import { usageLevel, usagePct, type UsageLevel } from "../account/usage.js";

export type Lang = "fr" | "en";

const FR = {
  tab: "Foyer",
  title: "Mon foyer",
  loading: "Chargement…",
  noneLead: "Un foyer partage un abonnement Famille ou Large : jusqu'à 6 personnes, un quota commun, une mémoire commune. Chacun garde ses conversations pour lui.",
  createName: "Nom du foyer",
  createPh: "Famille Dupont",
  create: "Créer mon foyer",
  received: "Invitations reçues",
  receivedLine: "« {name} » t'invite (profil {profile}).",
  accept: "Accepter",
  decline: "Refuser",
  joined: "Tu rejoins « {name} ».",
  declined: "Invitation déclinée.",
  created: "Foyer « {name} » créé.",
  quota: "Quota commun",
  today: "Aujourd'hui",
  week: "Cette semaine",
  usedOf: "{used} / {cap} tours",
  usedNoCap: "{used} tours",
  resetsDay: "remise à zéro à {at}",
  resetsWeek: "remise à zéro {at}",
  softNote: "Le dépassement ne coupe rien pour l'instant : chacun reçoit un avertissement.",
  planLine: "Offre {plan} · {size} membre(s) sur {max}",
  members: "Membres",
  colMember: "Membre",
  colProfile: "Profil",
  colTurns: "Tours (jour · semaine)",
  colCap: "Plafond par jour",
  payer: "payeur",
  you: "toi",
  suspended: "suspendu",
  capDefault: "par défaut",
  capCustom: "personnalisé",
  capNone: "aucun",
  capNoneValue: "sans plafond",
  capChange: "Nouveau plafond",
  capSave: "Enregistrer",
  capReset: "Revenir au défaut",
  capUnlimited: "Sans plafond",
  capSaved: "Plafond de {email} : {cap}.",
  capInvalid: "Un nombre entier de 0 à 1000.",
  remove: "Retirer",
  removeConfirm: "Retirer {email} du foyer ? Ses conversations restent à lui.",
  removed: "{email} ne fait plus partie du foyer.",
  yes: "Oui",
  cancel: "Annuler",
  pending: "Invitations en attente",
  expires: "expire le {date}",
  revoke: "Annuler l'invitation",
  revoked: "Invitation annulée.",
  invite: "Inviter",
  inviteEmail: "Adresse e-mail",
  inviteProfile: "Profil",
  invited: "Invitation envoyée à {email}.",
  full: "Le foyer est complet (6 personnes, payeur et invitations en attente compris).",
  attestTitle: "Attestation du représentant légal",
  attestCheck: "Je suis son représentant légal et j'atteste ce qui précède.",
  attestNeeded: "Lis l'attestation et coche la case.",
  minorTools: "Profil mineur",
  revokeConsent: "Retirer mon consentement",
  revokeConsentConfirm: "Retirer ton consentement ? Le profil de {email} sera suspendu : plus aucun tour jusqu'au renouvellement.",
  consentRevoked: "Consentement retiré : profil suspendu.",
  renew: "Renouveler",
  renewed: "Attestation renouvelée : profil actif.",
  makeAdult: "Passer adulte",
  madeAdult: "{email} a désormais un profil adulte.",
  policy: "Ce que les profils mineurs peuvent utiliser",
  policyLead: "Rien n'est permis par défaut. Un envoi externe ou une action destructive attend toujours ta décision.",
  policyConnectors: "Connecteurs permis",
  policyAgents: "Agents permis (noms, séparés par des virgules)",
  policySave: "Enregistrer la liste",
  policySaved: "Liste enregistrée.",
  conn_mail: "E-mail",
  conn_calendar: "Agenda",
  approvals: "À décider pour un profil mineur",
  approvalsNone: "Aucune demande en attente.",
  approvalFrom: "{email} ({profile}) veut utiliser {tool}",
  approvalReason: "Motif : {reason}",
  approve: "Approuver",
  reject: "Refuser",
  signing: "Signature…",
  approved: "Approuvé : l'action part.",
  rejected: "Refusé : l'action n'a pas lieu.",
  noPasskey: "Aucun appareil enrôlé sur ce navigateur : décide depuis ton téléphone.",
  notes: "Mémoire du foyer",
  notesLead: "Ce que l'assistant sait pour tout le foyer (allergies, habitudes, règles). Chacun peut écrire ; la mémoire de chacun reste à lui.",
  notesNone: "Aucune note pour l'instant.",
  noteKind: "Type",
  kind_rule: "Règle",
  kind_fact: "Fait",
  kind_feedback: "Retour",
  noteTitle: "Titre",
  noteText: "Texte",
  noteAdd: "Ajouter une note",
  noteSave: "Enregistrer",
  noteEdit: "Modifier",
  noteForget: "Oublier",
  noteForgetConfirm: "Oublier « {title} » pour tout le foyer ?",
  noteSaved: "Note enregistrée.",
  noteConflict: "Quelqu'un l'a modifiée entre-temps : ta version est gardée, l'autre est dans l'historique.",
  noteRefused: "Note refusée : elle contient un secret ou un format interdit.",
  noteForgotten: "Note oubliée.",
  noteBy: "par {who}, {date}",
  noteOn: "le {date}",
  history: "Historique des versions",
  historyNone: "Aucune version remplacée.",
  restore: "Restaurer",
  restored: "Version restaurée.",
  leave: "Quitter le foyer",
  leaveConfirm: "Quitter « {name} » ? Tes conversations et ta mémoire restent à toi.",
  left: "Tu as quitté le foyer.",
  minorNoLeave: "Un profil mineur ne quitte pas le foyer seul : demande à ton représentant.",
  yourLine: "Ta consommation",
  yourCap: "Ton plafond : {cap} tours par jour",
  yourNoCap: "Pas de plafond personnel",
  privacy: "Le payeur voit la consommation de chacun, jamais le contenu des conversations.",
  danger: "Supprimer le foyer",
  deleteConfirm: "Supprimer « {name} » ? Chaque membre repasse sur son propre compte ; rien de ses conversations n'est effacé.",
  deleted: "Foyer supprimé.",
  // erreurs du noyau
  e_household_exists: "Tu fais déjà partie d'un foyer.",
  e_already_in_household: "Tu fais déjà partie d'un foyer : quitte-le d'abord.",
  e_household_full: "Le foyer est complet (6 personnes au plus, invitations en attente comprises).",
  e_already_member: "Cette personne fait déjà partie du foyer.",
  e_already_invited: "Une invitation attend déjà cette adresse.",
  e_minors_disabled: "Les profils mineurs ne sont pas encore ouverts.",
  e_attestation_required: "L'attestation du représentant légal est requise.",
  e_attestation_stale: "Le texte d'attestation a changé : relis-le et coche à nouveau.",
  e_payer_fixed: "Le payeur ne quitte pas le foyer : il le supprime.",
  e_minor_cannot_leave: "Un profil mineur ne quitte pas le foyer seul.",
  e_not_minor: "Ce profil n'est pas mineur.",
  e_plan_required: "Il faut un abonnement Famille ou Large pour créer un foyer.",
  e_strong_device_required: "À décider depuis un appareil de confiance (passkey ou Mini App).",
  e_strong_approval_required: "À décider depuis un appareil de confiance (passkey ou Mini App).",
  e_bad_note: "Note invalide.",
  e_rate: "Trop de changements d'un coup : réessaie dans une minute.",
  e_404: "Ce foyer n'existe plus, ou tu n'en fais plus partie.",
  e_403: "Réservé au payeur du foyer.",
  e_net: "nokker.ai ne répond pas.",
  e_other: "Refus du serveur ({status}).",
};
type Key = keyof typeof FR;

const EN: Record<Key, string> = {
  tab: "Household",
  title: "My household",
  loading: "Loading…",
  noneLead: "A household shares a Family or Large plan: up to 6 people, one shared quota, one shared memory. Everyone keeps their conversations to themselves.",
  createName: "Household name",
  createPh: "The Smiths",
  create: "Create my household",
  received: "Invitations received",
  receivedLine: "“{name}” invites you ({profile} profile).",
  accept: "Accept",
  decline: "Decline",
  joined: "You joined “{name}”.",
  declined: "Invitation declined.",
  created: "Household “{name}” created.",
  quota: "Shared quota",
  today: "Today",
  week: "This week",
  usedOf: "{used} / {cap} turns",
  usedNoCap: "{used} turns",
  resetsDay: "resets at {at}",
  resetsWeek: "resets {at}",
  softNote: "Going over cuts nothing for now: everyone gets a warning.",
  planLine: "{plan} plan · {size} of {max} member(s)",
  members: "Members",
  colMember: "Member",
  colProfile: "Profile",
  colTurns: "Turns (day · week)",
  colCap: "Daily cap",
  payer: "payer",
  you: "you",
  suspended: "suspended",
  capDefault: "default",
  capCustom: "custom",
  capNone: "none",
  capNoneValue: "no cap",
  capChange: "New cap",
  capSave: "Save",
  capReset: "Back to default",
  capUnlimited: "No cap",
  capSaved: "{email}'s cap: {cap}.",
  capInvalid: "A whole number from 0 to 1000.",
  remove: "Remove",
  removeConfirm: "Remove {email} from the household? Their conversations stay theirs.",
  removed: "{email} is no longer in the household.",
  yes: "Yes",
  cancel: "Cancel",
  pending: "Pending invitations",
  expires: "expires {date}",
  revoke: "Cancel invitation",
  revoked: "Invitation cancelled.",
  invite: "Invite",
  inviteEmail: "Email address",
  inviteProfile: "Profile",
  invited: "Invitation sent to {email}.",
  full: "The household is full (6 people, payer and pending invitations included).",
  attestTitle: "Legal guardian attestation",
  attestCheck: "I am their legal guardian and I attest the above.",
  attestNeeded: "Read the attestation and tick the box.",
  minorTools: "Minor profile",
  revokeConsent: "Withdraw my consent",
  revokeConsentConfirm: "Withdraw your consent? {email}'s profile will be suspended: no more turns until you renew it.",
  consentRevoked: "Consent withdrawn: profile suspended.",
  renew: "Renew",
  renewed: "Attestation renewed: profile active.",
  makeAdult: "Make adult",
  madeAdult: "{email} now has an adult profile.",
  policy: "What minor profiles may use",
  policyLead: "Nothing is allowed by default. An external send or a destructive action always waits for your decision.",
  policyConnectors: "Allowed connectors",
  policyAgents: "Allowed agents (names, comma separated)",
  policySave: "Save the list",
  policySaved: "List saved.",
  conn_mail: "Email",
  conn_calendar: "Calendar",
  approvals: "To decide for a minor profile",
  approvalsNone: "No pending request.",
  approvalFrom: "{email} ({profile}) wants to use {tool}",
  approvalReason: "Reason: {reason}",
  approve: "Approve",
  reject: "Reject",
  signing: "Signing…",
  approved: "Approved: the action goes ahead.",
  rejected: "Rejected: the action does not happen.",
  noPasskey: "No device enrolled in this browser: decide from your phone.",
  notes: "Household memory",
  notesLead: "What the assistant knows for the whole household (allergies, habits, rules). Everyone can write; each person's own memory stays theirs.",
  notesNone: "No notes yet.",
  noteKind: "Type",
  kind_rule: "Rule",
  kind_fact: "Fact",
  kind_feedback: "Feedback",
  noteTitle: "Title",
  noteText: "Text",
  noteAdd: "Add a note",
  noteSave: "Save",
  noteEdit: "Edit",
  noteForget: "Forget",
  noteForgetConfirm: "Forget “{title}” for the whole household?",
  noteSaved: "Note saved.",
  noteConflict: "Someone changed it meanwhile: your version is kept, the other one is in the history.",
  noteRefused: "Note refused: it contains a secret or a forbidden format.",
  noteForgotten: "Note forgotten.",
  noteBy: "by {who}, {date}",
  noteOn: "on {date}",
  history: "Version history",
  historyNone: "No replaced version.",
  restore: "Restore",
  restored: "Version restored.",
  leave: "Leave the household",
  leaveConfirm: "Leave “{name}”? Your conversations and memory stay yours.",
  left: "You left the household.",
  minorNoLeave: "A minor profile does not leave the household alone: ask your guardian.",
  yourLine: "Your usage",
  yourCap: "Your cap: {cap} turns a day",
  yourNoCap: "No personal cap",
  privacy: "The payer sees everyone's usage, never the content of conversations.",
  danger: "Delete the household",
  deleteConfirm: "Delete “{name}”? Every member goes back to their own account; none of their conversations is erased.",
  deleted: "Household deleted.",
  e_household_exists: "You are already in a household.",
  e_already_in_household: "You are already in a household: leave it first.",
  e_household_full: "The household is full (6 people at most, pending invitations included).",
  e_already_member: "This person is already in the household.",
  e_already_invited: "An invitation is already waiting for this address.",
  e_minors_disabled: "Minor profiles are not open yet.",
  e_attestation_required: "The legal guardian attestation is required.",
  e_attestation_stale: "The attestation text changed: read it again and tick the box.",
  e_payer_fixed: "The payer does not leave the household: they delete it.",
  e_minor_cannot_leave: "A minor profile does not leave the household alone.",
  e_not_minor: "This profile is not a minor.",
  e_plan_required: "A Family or Large plan is required to create a household.",
  e_strong_device_required: "Decide from a trusted device (passkey or Mini App).",
  e_strong_approval_required: "Decide from a trusted device (passkey or Mini App).",
  e_bad_note: "Invalid note.",
  e_rate: "Too many changes at once: try again in a minute.",
  e_404: "This household no longer exists, or you are no longer in it.",
  e_403: "Reserved for the household's payer.",
  e_net: "nokker.ai is not answering.",
  e_other: "Refused by the server ({status}).",
};

export const TEXTS: Record<Lang, Record<Key, string>> = { fr: FR, en: EN };
export type HKey = Key;

export function h(lang: Lang, key: Key, vars: Record<string, string | number> = {}): string {
  return TEXTS[lang][key].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export const PROFILE_LABEL: Record<Lang, Record<HouseholdProfile, string>> = {
  fr: {
    adult: "adulte",
    teen: "adolescent·e (13-17 ans)",
    child: "enfant (moins de 13 ans)",
  },
  en: { adult: "adult", teen: "teen (13-17)", child: "child (under 13)" },
};
/** Libellé court (cartes, phrases) : sans la tranche d'âge. */
export const PROFILE_SHORT: Record<Lang, Record<HouseholdProfile, string>> = {
  fr: { adult: "adulte", teen: "adolescent·e", child: "enfant" },
  en: { adult: "adult", teen: "teen", child: "child" },
};
export const isMinor = (p: HouseholdProfile): boolean => p === "teen" || p === "child";
export const POLICY_CONNECTORS = ["mail", "calendar"] as const satisfies readonly ConnectorKind[];

export function apiCode(e: unknown): string | undefined {
  if (!(e instanceof NokkerApiError)) return undefined;
  const b = e.body as { error?: string | { code?: string } } | undefined;
  return typeof b?.error === "string" ? b.error : b?.error?.code;
}

/** Code du noyau → texte ; sinon par statut ; jamais un message brut du serveur. */
export function householdError(lang: Lang, e: unknown): string {
  const c = apiCode(e);
  if (c && `e_${c}` in FR) return h(lang, `e_${c}` as Key);
  if (e instanceof NokkerApiError) {
    if (e.status === 404) return h(lang, "e_404");
    if (e.status === 403) return h(lang, "e_403");
    if (e.status === 429) return h(lang, "e_rate");
    return h(lang, "e_other", { status: e.status });
  }
  return h(lang, "e_net");
}

export interface QuotaRow {
  key: "today" | "week";
  used: number;
  cap: number | null;
  pct: number | null;
  level: UsageLevel;
  resets_at: string;
}
/** En mode `soft` la barre ne passe jamais au rouge (rien n'est coupé), comme « Mon compte ». */
export function quotaRows(hh: Pick<Household, "quota" | "mode">): QuotaRow[] {
  return (["today", "week"] as const).map((key) => {
    const w = hh.quota[key];
    const pct = usagePct(w.used, w.cap);
    const level = usageLevel(pct);
    return {
      key,
      used: w.used,
      cap: w.cap,
      pct,
      level: hh.mode === "soft" && level === "full" ? "warn" : level,
      resets_at: w.resets_at,
    };
  });
}

export function capText(lang: Lang, m: Pick<HouseholdMember, "cap">): string {
  const src = h(lang, m.cap.source === "default" ? "capDefault" : m.cap.source === "custom" ? "capCustom" : "capNone");
  return m.cap.turns_per_day === null ? `${h(lang, "capNoneValue")} (${src})` : `${m.cap.turns_per_day} (${src})`;
}

/** Valeur saisie du plafond : entier 0–1000, ou `null` (vide = pas de changement). */
export function parseCap(v: string): number | null | "invalid" {
  const s = v.trim();
  if (!s) return null;
  if (!/^\d{1,4}$/.test(s)) return "invalid";
  const n = Number(s);
  return n <= 1000 ? n : "invalid";
}

/** Profils proposés à l'invitation : adulte seul tant que les mineurs sont fermés. */
export function invitableProfiles(hh: Pick<Household, "minors">): HouseholdProfile[] {
  return hh.minors?.enabled ? ["adult", "teen", "child"] : ["adult"];
}

/** Places restantes : 6 au plus, payeur et invitations en attente compris (`counted` du noyau). */
export function seatsLeft(hh: Pick<Household, "max_members" | "counted">): number {
  return Math.max(0, hh.max_members - hh.counted);
}

/** Nom de note stable et lisible (`<type>-<titre>-<4 hex>`), comme les notes d'équipe. */
export function noteName(kind: string, title: string, rand: () => string = () => Math.random().toString(16).slice(2, 6).padEnd(4, "0")): string {
  const slug = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${kind}-${slug || "note"}-${rand()}`;
}

export const agentsFromText = (s: string): string[] =>
  [
    ...new Set(
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ].slice(0, 50);
