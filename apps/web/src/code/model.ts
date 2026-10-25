/**
 * Sessions de code (LOKKAL §7.28) : textes FR/EN et calculs purs de l'onglet Code. Le noyau tranche tout (modes permis,
 * plafond, forges, portes) ; ici on affiche, on grise, et on traduit ses codes d'erreur.
 */
import { NokkerApiError, parseToolJson, type CheckpointInfo, type CodeSession, type CodeSessionList, type LocalToolOutcome } from "@nokker-apps/sdk";

export type Lang = "fr" | "en";

const FR = {
  tab: "Code",
  title: "Sessions de code",
  loading: "Chargement…",
  lead: "Une session de code travaille dans un dossier à toi, sur le serveur de ton organisation. Tu lui parles dans son fil ; elle lit, écrit et lance des commandes dans un bac à sable.",
  count: "{n} session(s) ouverte(s) sur {limit}",
  idleRule: "Sans activité pendant {min} min, le bac à sable est libéré : la session passe en veille, ses fichiers restent.",
  open: "Ouvrir une session",
  repoUrl: "Dépôt (https, facultatif)",
  repoPh: "https://git.example.org/équipe/projet.git",
  repoTip: "Sans dépôt, la session démarre dans un dossier vide.",
  ref: "Branche ou étiquette",
  refPh: "main",
  credential: "Identifiant de forge",
  credentialNone: "aucun (dépôt public)",
  mode: "Mode",
  openBtn: "Ouvrir",
  opening: "Ouverture… (clone du dépôt)",
  opened: "Session ouverte.",
  full: "Plafond atteint : ferme une session pour en ouvrir une autre.",
  none: "Aucune session ouverte.",
  noRepo: "sans dépôt",
  active: "active",
  idle: "en veille",
  idleHint: "bac à sable libéré ; il se rouvre au prochain message ou au prochain retour en arrière",
  created: "ouverte {at}",
  lastUsed: "dernière activité {at}",
  resume: "Reprendre",
  resumeHint: "Ouvre le fil de la session : ton prochain message la réveille.",
  points: "Points de retour",
  hidePoints: "Masquer les points",
  close: "Fermer",
  closeConfirm: "Fermer la session ? Le bac à sable est libéré et la session quitte cette liste ; ses fichiers et ses points de retour restent sur le serveur.",
  closed: "Session fermée.",
  erase: "Effacer",
  eraseConfirm: "Effacer la session ? Son dossier de travail et ses points de retour sont supprimés du serveur, sans retour possible.",
  erased: "Session effacée : dossier de travail et points de retour supprimés.",
  yes: "Oui",
  cancel: "Annuler",
  pointsLoading: "Lecture des points…",
  pointsNone: "Aucun point de retour pour l'instant : un point est pris avant chaque écriture.",
  pointLine: "{files} fichier(s)",
  diff: "Voir les changements",
  hideDiff: "Masquer",
  diffEmpty: "Aucun changement depuis ce point.",
  restore: "Revenir ici",
  restoreConfirm: "Revenir au point {hash} ? Les fichiers que tu as modifiés toi-même depuis ne sont pas écrasés. Un point « avant retour » est pris d'abord.",
  restorePending: "En attente de ta signature : la carte « checkpoint_restore » s'approuve sur ton appareil.",
  restoreSign: "Décider la carte",
  reject: "Refuser",
  restored: "Retour effectué.",
  restoredSkipped: "Retour effectué ; {n} fichier(s) modifié(s) par toi gardé(s) tel(s) quel(s).",
  restoreRefused: "Retour refusé : {why}",
  restoreRejected: "Retour refusé.",
  restoreExpired: "La carte a expiré : relance le retour.",
  restoreFailed: "Le retour a échoué.",
  creds: "Identifiants de forge",
  credsLead: "Pour cloner un dépôt privé. La valeur (jeton, ou utilisateur:jeton) part au coffre de ton organisation et n'est jamais relue ; seul son nom sert ensuite.",
  credsNone: "Aucun identifiant.",
  credName: "Nom",
  credNamePh: "FORGE_EQUIPE",
  credValue: "Valeur",
  credValuePh: "jeton ou utilisateur:jeton",
  credSave: "Ranger",
  credSaved: "Identifiant {name} rangé.",
  credDelete: "Supprimer",
  credDeleted: "Identifiant {name} supprimé.",
  credUpdated: "mis à jour {at}",
  skills: "Skills du dépôt",
  skillsUntrusted: "Ce dépôt apporte {count} skill(s) dans {root}/.nokker/skills. Ils restent invisibles pour l'agent tant que tu ne leur fais pas confiance.",
  skillsSha: "empreinte {sha}",
  skillsNoPreview: "Leur contenu ne se lit qu'après la confiance : fais-la seulement si tu connais ce dépôt. Une modification de l'arbre retire la confiance.",
  skillsTrust: "Faire confiance",
  skillsTrusted: "Skills du dépôt approuvés : l'agent de la session peut les utiliser.",
  skillsChanged: "L'arbre des skills a changé depuis la lecture : relis l'empreinte avant de faire confiance.",
  skillsInvalid: "Skills du dépôt refusés",
  skillsAbsent: "Pas de skills dans ce dépôt.",
  skillsList: "Skills disponibles",
  skillsNone: "Aucun skill disponible.",
  skillsView: "Lire",
  skillsHide: "Masquer",
  skillsFiles: "Fichiers liés : {files}",
  skillsChip: "{n} skill(s) à approuver",
  sub: "Sous-agents",
  subLive: "{live} vivant(s) sur {limit}",
  subNone: "Aucun sous-agent pour l'instant : l'agent en lance quand une tâche se découpe.",
  subRefresh: "Actualiser",
  subStop: "Arrêter",
  subStopAll: "Tout arrêter",
  subStopped: "{n} sous-agent(s) arrêté(s).",
  subElapsed: "{s} s",
  subBranch: "branche {branch}",
  subCards: "Cartes des sous-agents à décider",
  subStatus_queued: "en file",
  subStatus_running: "en cours",
  subStatus_stopping: "en arrêt",
  subStatus_completed: "terminé",
  subStatus_failed: "en échec",
  subStatus_interrupted: "interrompu",
  subChip: "{live} sous-agent(s)",
  e_account_required: "Les sessions de code demandent un compte : connecte-toi avec ton compte (ou par SSO).",
  e_minor_not_allowed: "Les sessions de code ne sont pas disponibles pour un profil mineur.",
  e_session_limit: "Plafond atteint : ferme une session pour en ouvrir une autre.",
  e_bad_mode: "Ce mode n'est pas permis sur ce serveur.",
  e_bad_repo: "Dépôt illisible.",
  e_bad_ref: "Branche ou étiquette invalide.",
  e_bad_depth: "Profondeur de clone invalide.",
  e_https_required: "Le dépôt doit être en https.",
  e_host_not_allowed: "Cette forge n'est pas autorisée par ton organisation.",
  e_credentials_in_url: "Pas d'identifiant dans l'adresse : range-le dans « Identifiants de forge » et choisis son nom.",
  e_bad_url: "Adresse de dépôt invalide (ni requête, ni fragment, ni « .. »).",
  e_credential_missing: "Cet identifiant n'existe plus dans le coffre.",
  e_secret_value_refused: "Une valeur secrète n'entre jamais dans la demande : range-la dans « Identifiants de forge ».",
  e_clone_failed: "Le clone a échoué (dépôt introuvable, accès refusé ou délai dépassé) ; rien n'est resté sur le serveur.",
  e_git_missing: "git manque sur le serveur : préviens ton administrateur.",
  e_vault_unavailable: "Le coffre des identifiants est indisponible pour l'instant.",
  e_workspace_refused: "Le dossier de travail a été refusé par le serveur.",
  e_bad_name: "Nom invalide : lettres, chiffres, « _ », « . » ou « - », sans espace.",
  e_bad_value: "Valeur vide ou trop longue (64 Kio au plus).",
  e_tool_not_allowed: "Cet outil ne s'appelle pas depuis l'écran.",
  e_bad_arguments: "Arguments refusés.",
  e_turn_running: "Un tour est en cours dans le fil de la session : attends sa fin.",
  e_skills_absent: "Pas d'arbre de skills à approuver dans cette session (absent ou refusé).",
  e_skills_changed: "L'arbre des skills a changé depuis la lecture : relis l'empreinte avant de faire confiance.",
  e_not_found: "Cette session n'existe plus.",
  e_404: "Introuvable.",
  e_403: "Refusé.",
  e_rate: "Trop de demandes : réessaie dans un instant.",
  e_other: "Refus du serveur ({status}).",
  e_net: "Le serveur ne répond pas.",
};
type Key = keyof typeof FR;

const EN: Record<Key, string> = {
  tab: "Code",
  title: "Code sessions",
  loading: "Loading…",
  lead: "A code session works in a folder of your own, on your organisation's server. You talk to it in its thread; it reads, writes and runs commands in a sandbox.",
  count: "{n} of {limit} session(s) open",
  idleRule: "After {min} min without activity the sandbox is released: the session goes idle, its files stay.",
  open: "Open a session",
  repoUrl: "Repository (https, optional)",
  repoPh: "https://git.example.org/team/project.git",
  repoTip: "Without a repository, the session starts in an empty folder.",
  ref: "Branch or tag",
  refPh: "main",
  credential: "Forge credential",
  credentialNone: "none (public repository)",
  mode: "Mode",
  openBtn: "Open",
  opening: "Opening… (cloning the repository)",
  opened: "Session open.",
  full: "Limit reached: close a session to open another one.",
  none: "No open session.",
  noRepo: "no repository",
  active: "active",
  idle: "idle",
  idleHint: "sandbox released; it reopens with your next message or your next rollback",
  created: "opened {at}",
  lastUsed: "last activity {at}",
  resume: "Resume",
  resumeHint: "Opens the session's thread: your next message wakes it up.",
  points: "Checkpoints",
  hidePoints: "Hide checkpoints",
  close: "Close",
  closeConfirm: "Close the session? The sandbox is released and the session leaves this list; its files and checkpoints stay on the server.",
  closed: "Session closed.",
  erase: "Erase",
  eraseConfirm: "Erase the session? Its working folder and checkpoints are deleted from the server, for good.",
  erased: "Session erased: working folder and checkpoints deleted.",
  yes: "Yes",
  cancel: "Cancel",
  pointsLoading: "Reading checkpoints…",
  pointsNone: "No checkpoint yet: one is taken before every write.",
  pointLine: "{files} file(s)",
  diff: "Show changes",
  hideDiff: "Hide",
  diffEmpty: "No change since this checkpoint.",
  restore: "Roll back here",
  restoreConfirm: "Roll back to checkpoint {hash}? Files you changed yourself since then are not overwritten. A “before rollback” checkpoint is taken first.",
  restorePending: "Waiting for your signature: the “checkpoint_restore” card is approved on your device.",
  restoreSign: "Decide the card",
  reject: "Reject",
  restored: "Rolled back.",
  restoredSkipped: "Rolled back; {n} file(s) you changed yourself kept as they are.",
  restoreRefused: "Rollback refused: {why}",
  restoreRejected: "Rollback rejected.",
  restoreExpired: "The card expired: start the rollback again.",
  restoreFailed: "The rollback failed.",
  creds: "Forge credentials",
  credsLead: "To clone a private repository. The value (token, or user:token) goes to your organisation's vault and is never read back; only its name is used afterwards.",
  credsNone: "No credential.",
  credName: "Name",
  credNamePh: "TEAM_FORGE",
  credValue: "Value",
  credValuePh: "token or user:token",
  credSave: "Store",
  credSaved: "Credential {name} stored.",
  credDelete: "Delete",
  credDeleted: "Credential {name} deleted.",
  credUpdated: "updated {at}",
  skills: "Repository skills",
  skillsUntrusted: "This repository brings {count} skill(s) in {root}/.nokker/skills. The agent cannot see them until you trust them.",
  skillsSha: "fingerprint {sha}",
  skillsNoPreview: "Their content can only be read after trusting: do it only if you know this repository. Any change to the tree withdraws the trust.",
  skillsTrust: "Trust",
  skillsTrusted: "Repository skills approved: the session's agent can use them.",
  skillsChanged: "The skills tree changed since it was read: check the fingerprint again before trusting.",
  skillsInvalid: "Repository skills refused",
  skillsAbsent: "No skills in this repository.",
  skillsList: "Available skills",
  skillsNone: "No skill available.",
  skillsView: "Read",
  skillsHide: "Hide",
  skillsFiles: "Linked files: {files}",
  skillsChip: "{n} skill(s) to approve",
  sub: "Subagents",
  subLive: "{live} live of {limit}",
  subNone: "No subagent yet: the agent starts some when a task splits up.",
  subRefresh: "Refresh",
  subStop: "Stop",
  subStopAll: "Stop all",
  subStopped: "{n} subagent(s) stopped.",
  subElapsed: "{s} s",
  subBranch: "branch {branch}",
  subCards: "Subagent cards to decide",
  subStatus_queued: "queued",
  subStatus_running: "running",
  subStatus_stopping: "stopping",
  subStatus_completed: "completed",
  subStatus_failed: "failed",
  subStatus_interrupted: "interrupted",
  subChip: "{live} subagent(s)",
  e_account_required: "Code sessions need an account: sign in with your account (or through SSO).",
  e_minor_not_allowed: "Code sessions are not available for a minor's profile.",
  e_session_limit: "Limit reached: close a session to open another one.",
  e_bad_mode: "This mode is not allowed on this server.",
  e_bad_repo: "Unreadable repository.",
  e_bad_ref: "Invalid branch or tag.",
  e_bad_depth: "Invalid clone depth.",
  e_https_required: "The repository must use https.",
  e_host_not_allowed: "Your organisation does not allow this forge.",
  e_credentials_in_url: "No credential in the address: store it under “Forge credentials” and pick its name.",
  e_bad_url: "Invalid repository address (no query, no fragment, no “..”).",
  e_credential_missing: "This credential is no longer in the vault.",
  e_secret_value_refused: "A secret value never goes into the request: store it under “Forge credentials”.",
  e_clone_failed: "The clone failed (repository not found, access denied or timeout); nothing was left on the server.",
  e_git_missing: "git is missing on the server: tell your administrator.",
  e_vault_unavailable: "The credential vault is unavailable right now.",
  e_workspace_refused: "The server refused the working folder.",
  e_bad_name: "Invalid name: letters, digits, “_”, “.” or “-”, no spaces.",
  e_bad_value: "Empty or too long value (64 KiB at most).",
  e_tool_not_allowed: "This tool cannot be called from the screen.",
  e_bad_arguments: "Arguments refused.",
  e_turn_running: "A turn is running in the session's thread: wait for it to finish.",
  e_skills_absent: "No skills tree to approve in this session (absent or refused).",
  e_skills_changed: "The skills tree changed since it was read: check the fingerprint again before trusting.",
  e_not_found: "This session no longer exists.",
  e_404: "Not found.",
  e_403: "Refused.",
  e_rate: "Too many requests: try again in a moment.",
  e_other: "Server refusal ({status}).",
  e_net: "The server does not answer.",
};

export const TEXTS: Record<Lang, Record<Key, string>> = { fr: FR, en: EN };

export function c(lang: Lang, key: Key, vars: Record<string, string | number> = {}): string {
  return TEXTS[lang][key].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Libellé d'un mode du noyau (un mode inconnu s'affiche tel quel). */
const MODES: Record<Lang, Record<string, string>> = {
  fr: { default: "demander avant d'écrire", accept_edits: "écrire sans demander", plan: "plan (lecture seule)", auto: "auto" },
  en: { default: "ask before writing", accept_edits: "write without asking", plan: "plan (read only)", auto: "auto" },
};
export function modeLabel(lang: Lang, mode: string): string {
  return MODES[lang][mode] ?? mode;
}

export function apiCode(e: unknown): string | undefined {
  if (!(e instanceof NokkerApiError)) return undefined;
  const err = (e.body as { error?: { code?: unknown } } | undefined)?.error;
  return typeof err?.code === "string" ? err.code : undefined;
}

export function codeError(lang: Lang, e: unknown): string {
  const k = apiCode(e);
  if (k && `e_${k}` in FR) return c(lang, `e_${k}` as Key);
  if (e instanceof NokkerApiError) {
    if (e.status === 404) return c(lang, "e_404");
    if (e.status === 403) return c(lang, "e_403");
    if (e.status === 429) return c(lang, "e_rate");
    return c(lang, "e_other", { status: e.status });
  }
  return c(lang, "e_net");
}

/** Le formulaire d'ouverture : corps de `POST /v1/code/sessions` (champs vides omis, URL rognée). */
export function openBody(f: { url: string; ref: string; credential: string; mode: string }): { repo?: { url: string; ref?: string; credential?: string }; mode?: string } {
  const url = f.url.trim();
  const ref = f.ref.trim();
  return {
    ...(url ? { repo: { url, ...(ref ? { ref } : {}), ...(f.credential ? { credential: f.credential } : {}) } } : {}),
    ...(f.mode ? { mode: f.mode } : {}),
  };
}

export function isFull(l: Pick<CodeSessionList, "sessions" | "limit">): boolean {
  return l.sessions.length >= l.limit;
}

/** Plus récente activité d'abord. */
export function sortSessions(s: CodeSession[]): CodeSession[] {
  return [...s].sort((a, b) => b.last_used_at.localeCompare(a.last_used_at));
}

/** `content` de `checkpoint_list` : la liste, ou null si ce n'en est pas une (erreur de l'outil en texte). */
export function parsePoints(content: string): CheckpointInfo[] | null {
  const v = parseToolJson<unknown>(content);
  return Array.isArray(v) ? (v as CheckpointInfo[]) : null;
}

/** Nom court du dépôt : `équipe/projet` depuis l'URL propre. */
export function repoName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\/+|\.git$/g, "") || url;
  } catch {
    return url;
  }
}

export function fmtWhen(lang: Lang, iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const min = Math.round((now - t) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  if (Math.abs(min) < 60) return rtf.format(-min, "minute");
  if (Math.abs(min) < 24 * 60) return rtf.format(-Math.round(min / 60), "hour");
  return new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(t);
}

/** Issue d'un `checkpoint_restore` : la porte de la session décide — carte (202), exécuté (200), ou refusé (200
 * `is_error`, par exemple « refusé par le noyau (…) » ou un échec de l'outil). */
export type RestoreOutcome = { kind: "card"; approvalId: string } | { kind: "done"; text: string } | { kind: "refused"; text: string };
export function restoreOutcome(lang: Lang, o: LocalToolOutcome): RestoreOutcome {
  if ("approval_id" in o) return { kind: "card", approvalId: o.approval_id };
  const r = parseToolJson<{ success?: boolean; error?: string; reason?: string; skipped_user_edits?: string[] }>(o.content);
  if (o.is_error || (r && r.success === false)) {
    const why = (r && typeof r === "object" ? r.error || r.reason : null) || o.content || "?";
    return { kind: "refused", text: c(lang, "restoreRefused", { why: String(why).slice(0, 300) }) };
  }
  const skipped = r?.skipped_user_edits?.length ?? 0;
  return { kind: "done", text: skipped ? c(lang, "restoredSkipped", { n: skipped }) : c(lang, "restored") };
}

/** Libellé de l'état d'un sous-agent (un état inconnu s'affiche tel quel). */
export function subStatus(lang: Lang, st: string): string {
  const k = `subStatus_${st}`;
  return k in FR ? c(lang, k as Key) : st;
}
