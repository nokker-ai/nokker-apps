/** Écran « Équipe » (X17, LOKKAL §7.15) : libellés et petites règles pures, testées à part. Le noyau décide ; ici on grise. */
import { NokkerApiError, canRole, type Project, type ProjectRole, type ProjectRules } from "@nokker-apps/sdk";
import { shellLang, tr } from "../i18n/index.js";

/** Libellé du rôle, dans la langue de l'interface au moment de l'appel. */
export function roleLabel(r: ProjectRole): string {
  switch (r) {
    case "viewer":
      return tr("read-only");
    case "member":
      return tr("member");
    case "maintainer":
      return tr("maintainer");
    case "owner":
      return tr("owner");
  }
}
/** Rôles qu'un propriétaire peut donner (un seul owner : le créateur, 409 `owner_fixed`). */
export const GRANTABLE_ROLES: ProjectRole[] = ["maintainer", "member", "viewer"];
export const RULE_MODES: NonNullable<ProjectRules["mode"]>[] = ["plan", "default", "accept_edits"];
export function modeLabel(m: NonNullable<ProjectRules["mode"]>): string {
  switch (m) {
    case "plan":
      return tr("plan (nothing is written)");
    case "default":
      return tr("default (cards)");
    case "accept_edits":
      return tr("edits accepted");
  }
}

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

function codeText(code: string | undefined): string | undefined {
  switch (code) {
    case "forbidden":
      return tr("Your role in this project does not allow this action.");
    case "rules_widen":
      return tr("A project's rules can only restrict: no “allow”, no auto mode.");
    case "secret_value_refused":
      return tr("A secret value never goes through nokker.ai: set it on your machine.");
    case "owner_fixed":
      return tr("The owner remains the project's creator.");
    case "mirror_off":
      return tr("This project is not mirrored: its notes stay on the machines.");
    case "rate":
      return tr("Too many writes at once: try again in a minute.");
    default:
      return undefined;
  }
}
export function teamError(e: unknown): string {
  const known = codeText(apiCode(e));
  if (known) return known;
  if (e instanceof NokkerApiError) {
    if (e.status === 404) return tr("This project does not exist, or you are no longer a member.");
    if (e.status === 429) return codeText("rate")!;
    const b = e.body as { error?: { message?: string } } | undefined;
    return b?.error?.message ?? tr("server refused ({0})", e.status);
  }
  return tr("nokker.ai is not responding.");
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
  if (!b) return tr("none");
  const parts = [b.daily !== undefined ? tr("{0} {1} / day", b.daily, b.currency) : "", b.monthly !== undefined ? tr("{0} {1} / month", b.monthly, b.currency) : ""].filter(Boolean);
  return parts.join(", ") || tr("none");
}

export function fmtWhen(v: string | number): string {
  const d = typeof v === "number" ? new Date(v * 1000) : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : new Intl.DateTimeFormat(shellLang() === "fr" ? "fr-CH" : "en-GB", { dateStyle: "medium" }).format(d);
}
