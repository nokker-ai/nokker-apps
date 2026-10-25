/** Écran « Équipe » (X17, LOKKAL §7.15) : libellés et petites règles pures, testées à part. Le noyau décide ; ici on grise. */
import { NokkerApiError, canRole, type Project, type ProjectRole, type ProjectRules } from "@nokker-apps/sdk";

export const ROLE_LABEL: Record<ProjectRole, string> = { viewer: "lecture", member: "membre", maintainer: "mainteneur", owner: "propriétaire" };
/** Rôles qu'un propriétaire peut donner (un seul owner : le créateur, 409 `owner_fixed`). */
export const GRANTABLE_ROLES: ProjectRole[] = ["maintainer", "member", "viewer"];
export const MODE_LABEL: Record<NonNullable<ProjectRules["mode"]>, string> = { plan: "plan (rien ne s'écrit)", default: "par défaut (cartes)", accept_edits: "éditions acceptées" };

/** Ce que le rôle permet, pour griser l'écran (miroir du tableau du §7.15). */
export function abilities(role: ProjectRole): { edit: boolean; owner: boolean; attachAgents: boolean } {
  return { edit: canRole(role, "maintainer"), owner: role === "owner", attachAgents: canRole(role, "member") };
}

/** Une règle par ligne (`outil` ou `outil(motif)`), vides et doublons retirés. */
export function parseRuleLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (l && !out.includes(l)) out.push(l);
  }
  return out;
}
const RULE_RE = /^[A-Za-z_][\w.:-]*(\(.+\))?$/;
export const badRules = (lines: string[]): string[] => lines.filter((l) => !RULE_RE.test(l));

export function apiCode(e: unknown): string | undefined {
  if (!(e instanceof NokkerApiError)) return undefined;
  const b = e.body as { error?: string | { code?: string } } | undefined;
  return typeof b?.error === "string" ? b.error : b?.error?.code;
}

const CODE_TEXT: Record<string, string> = {
  forbidden: "Ton rôle dans ce projet ne permet pas ce geste.",
  rules_widen: "Les règles d'un projet ne peuvent que restreindre : pas d'« allow », pas de mode auto.",
  secret_value_refused: "Une valeur de secret ne passe jamais par nokker.ai : pose-la sur ta machine.",
  owner_fixed: "Le propriétaire reste le créateur du projet.",
  mirror_off: "Ce projet n'est pas en miroir : ses notes restent sur les machines.",
  rate: "Trop d'écritures d'un coup : réessaie dans une minute.",
};
export function teamError(e: unknown): string {
  const c = apiCode(e);
  const known = c ? CODE_TEXT[c] : undefined;
  if (known) return known;
  if (e instanceof NokkerApiError) {
    if (e.status === 404) return "Ce projet n'existe pas, ou tu n'en fais plus partie.";
    if (e.status === 429) return CODE_TEXT.rate!;
    const b = e.body as { error?: { message?: string } } | undefined;
    return b?.error?.message ?? `refus du serveur (${e.status})`;
  }
  return "nokker.ai ne répond pas.";
}

/** Même forme que le coffre (`NAME_RE` du noyau). */
const SECRET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const validSecretName = (n: string): boolean => SECRET_NAME_RE.test(n);
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const validSkillName = (n: string): boolean => SKILL_NAME_RE.test(n);
const SKILL_SOURCE_RE = /^(github:[\w.-]+\/[\w.-]+(\/[\w./-]+)?|https:\/\/[^\s@/]+(\/\S*)?|official\/[\w-]+(\/[\w.-]+)+)$/;
/** `github:<owner>/<repo>[/<chemin>]`, une URL https sans identifiants, ou `official/<famille>/<nom>`. */
export const validSkillSource = (s: string): boolean => SKILL_SOURCE_RE.test(s);

export function budgetLabel(b: Project["budget"]): string {
  if (!b) return "aucun";
  const parts = [b.daily !== undefined ? `${b.daily} ${b.currency} / jour` : "", b.monthly !== undefined ? `${b.monthly} ${b.currency} / mois` : ""].filter(Boolean);
  return parts.join(", ") || "aucun";
}

export function fmtWhen(v: string | number): string {
  const d = typeof v === "number" ? new Date(v * 1000) : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : new Intl.DateTimeFormat("fr-CH", { dateStyle: "medium" }).format(d);
}
