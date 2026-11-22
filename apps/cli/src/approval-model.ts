/**
 * Logique pure de la carte d'approbation locale (LOKKAL-CLI.md §2.2) — testée sans Ink.
 */
import { STRONG_PHONE_TEXT, cardTarget, localChoices, rulePrefix, strongCardText, type Approval, type ApprovalScope, type LocalChoice } from "@nokker-apps/sdk";
import { t } from "./i18n/index.js";
import { displayPath, effectName, toolTarget, type ToolLine } from "./toolview.js";

// Choix de la carte : partagés avec l'extension VS Code et le pont ACP (SDK, `approval-choices.ts`).
export { TEST_COMMAND_RE, choiceToDecision, isTestCommand, localChoices } from "@nokker-apps/sdk";
export type { LocalChoice, LocalChoiceId } from "@nokker-apps/sdk";

/** Choix de la carte du terminal : toujours `1. Une fois · 2. … pour cette session · 3/3b. Toujours… · 4. Refuser`, même
 * pour une commande de test (comme l'extension VS Code et le pont ACP, qui suivent le même ordre). Chaque
 * lettre de la légende désigne ainsi toujours le même numéro : a = 1, s = 2, r = 4. */
export function cardChoices(a: Pick<Approval, "tool_name" | "arguments" | "strength" | "suggested_rules" | "suggested_rule_kinds">): LocalChoice[] {
  return localChoices(a, { sessionFirstForTests: false });
}

/** Lettre d'un choix (`a` une fois, `s` cette session, `r` refuser) ; « Toujours » n'a que son numéro (3, 3b). */
export function choiceLetter(c: Pick<LocalChoice, "id">): string | null {
  return c.id === "once" ? "a" : c.id === "session" ? "s" : c.id === "reject" ? "r" : null;
}

/** Légende de la carte, construite d'après les choix affichés : « 1/a une fois · 2/s cette session · 3 toujours ·
 * 4/r refuser ». */
export function choicesLegend(choices: readonly Pick<LocalChoice, "id" | "key">[], remaining: string): string {
  const parts: string[] = [];
  const always = choices.filter((c) => c.id === "always").map((c) => c.key);
  for (const c of choices) {
    if (c.id === "always") {
      if (c.key === always[0]) parts.push(`${always.join("/")} ${t("always")}`);
      continue;
    }
    const letter = choiceLetter(c);
    const name = c.id === "once" ? t("once") : c.id === "session" ? t("this session") : t("reject");
    parts.push(`${c.key}${letter ? `/${letter}` : ""} ${name}`);
  }
  // Deux lignes : la légende des touches, puis Entrée et le compte à rebours (une seule ligne débordait à 100 colonnes).
  return `${t("choose: {0}", parts.join(" · "))}\n${t("or ↑/↓; then Enter · expires in {0}", remaining)}`;
}

/**
 * Motif de la carte en clair. Le noyau écrit son motif interne (`nokker/qa/permissions.py`, `_decide_rest`) :
 * « mode accept_edits : écriture demandée », « mode default : écriture sur le bureau demandée », « règle ask
 * terminal(git push*) ». Ces formes connues sont reformulées pour la personne (affichage seulement : le motif n'est
 * jamais renvoyé au modèle par la CLI) ; tout autre motif est montré tel quel.
 */
export function reasonText(reason: string | null | undefined, toolName: string): string {
  const raw = (reason ?? "").trim();
  const mode = /^mode (\w+) : \u00e9criture demand\u00e9e$/.exec(raw);
  if (mode) {
    if (mode[1] === "accept_edits") {
      return toolName === "terminal"
        ? t("File edits go through without asking, but a command that can change files waits for your OK.")
        : t("This action changes something: it waits for your OK.");
    }
    if (mode[1] === "default") return t("In this mode, every change and every command waits for your OK.");
    return t("This action changes something: it waits for your OK.");
  }
  if (/^mode \w+ : \u00e9criture sur le bureau demand\u00e9e$/.test(raw)) return t("An action in an app on your desktop always waits for your OK.");
  const ask = /^r\u00e8gle ask (.+)$/.exec(raw);
  if (ask) return t("Your settings ask for your OK on {0}.", ask[1]!);
  return raw;
}

/** Outils qui exécutent du code ou une commande : le noyau les classe « destructif » par prudence, ce que le mot dit mal. */
const CODE_TOOLS = /^(terminal|python|exec|execute_code|run_code|code_run|shell|bash)$/i;
/** Outils de la maison (noms exacts : un motif attraperait des outils MCP d'hôte sans rapport). */
const DEVICE_TOOLS = new Set(["maison", "maison_action_forte"]);
/** Une commande qui supprime, écrase ou réécrit l'historique : là, « destructif » est juste. */
const DESTRUCTIVE_COMMAND = /\b(rm|rmdir|shred|mkfs|dd|truncate|unlink)\b|git\s+(reset\s+--hard|clean|push\s+.*--force|branch\s+-D)|\bdrop\s+(table|database)\b|--force\b|>\s*\/dev\/|\bformat\b/i;

/** Libellé d'effet d'une carte. « destructif » seulement quand c'est vrai : un code qui s'exécute se dit « exécute du
 * code », une commande sur un appareil « agit sur un appareil ». */
export function effectLabel(effect: string | null, toolName?: string | null, args?: unknown): string {
  if (effect === "destructive" && toolName) {
    if (CODE_TOOLS.test(toolName)) {
      const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      const cmd = typeof a.command === "string" ? a.command : typeof a.code === "string" ? a.code : "";
      if (!DESTRUCTIVE_COMMAND.test(cmd)) return t("runs code");
    } else if (DEVICE_TOOLS.has(toolName)) {
      return t("acts on a device");
    }
  }
  return (effect && effectName(effect)) || effect || t("unknown");
}

/** Libellé d'un choix de carte dans la langue de l'interface (mêmes choix et même ordre que `localChoices` du SDK). */
export function choiceLabel(c: Pick<LocalChoice, "id" | "key"> & Partial<Pick<LocalChoice, "ruleKind" | "rule" | "scopeRule">>, toolName: string): string {
  const file = toolName !== "terminal";
  switch (c.id) {
    case "once":
      return t("Once");
    case "session":
      // Noyau du 01.11 : ce que couvre la règle (`suggested_rule_kinds`) ; sinon le libellé d'avant.
      switch (c.ruleKind) {
        case "tool":
          return t("This tool for this session");
        case "file":
          return t("This file for this session");
        case "dir":
          return t("This folder for this session");
        case "prefix":
          return t("Commands starting with “{0}” for this session", displayPath(rulePrefix(c.scopeRule)));
        case "exact":
          return t("This exact command for this session");
      }
      return t("For this session");
    case "always":
      switch (c.ruleKind) {
        case "tool":
          return t("Always this tool");
        case "file":
          return t("Always this file");
        case "dir":
          return t("Always this folder");
        case "prefix":
          return t("Always commands starting with “{0}”", displayPath(rulePrefix(c.rule)));
        case "exact":
          return t("Always this exact command");
      }
      if (c.key === "3b") return file ? t("Always this folder (rule)") : t("Always commands starting with this prefix");
      return file ? t("Always this file (rule)") : t("Always this command");
    case "reject":
      return t("Reject");
  }
}

/** Texte d'une carte forte qu'un éditeur ne décide pas : téléphone si le noyau l'a déposée chez nokker.ai, sinon le
 * terminal (`strongCardText` du SDK décide). */
export function strongText(a: Pick<Approval, "forwarded">): string {
  return strongCardText(a) === STRONG_PHONE_TEXT ? t("Strong action: it waits for your phone.") : t("Strong action: decide it in the terminal (`nokker`).");
}

/** La cible de la carte : celle du noyau (`target`, lisible et caviardée) quand il la donne, sinon la logique locale (repli). */
export function approvalTarget(a: Approval): string {
  return cardTarget(a) || toolTarget(a.tool_name, a.arguments);
}

/** Secondes restantes avant `expires_at` (jamais négatif). */
export function remainingSeconds(a: Approval, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(a.expires_at) - now) / 1000));
}

/** Ligne résumé laissée dans le fil une fois la carte fermée. */
export function decisionSummary(a: Approval, outcome: "approved" | "rejected" | "expired", scope?: ApprovalScope, rule?: string): string {
  const what = `${a.tool_name} ${approvalTarget(a)}`.trim();
  if (outcome === "expired") return t("⌛ Approval expired — rejected: {0}", what);
  if (outcome === "rejected") return t("✗ Rejected: {0}", what);
  if (scope === "session") return t("✓ Approved (for this session): {0}", what);
  if (scope === "always") return rule ? t("✓ Approved (rule {0} saved): {1}", rule, what) : t("✓ Approved (rule saved): {0}", what);
  return t("✓ Approved: {0}", what);
}

const sameArgs = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  const norm = (o: Record<string, unknown>): string => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  return norm(a) === norm(b);
};

/** Effet d'une carte dont `effect` est null côté noyau : celui du `tool.call` de même outil et mêmes arguments (sinon le
 * dernier appel en cours du même outil), sinon déduit de `rule` (`permissions:accept_edits` → écriture, `effect:xxx` →
 * xxx). `null` en dernier recours seulement. */
export function resolveEffect(a: Approval, lines: ToolLine[]): string | null {
  if (a.effect) return a.effect;
  const same = lines.filter((l) => l.name === a.tool_name && l.effect);
  const hit = [...same].reverse().find((l) => sameArgs(l.args, a.arguments)) ?? [...same].reverse().find((l) => l.ok === null);
  if (hit?.effect) return hit.effect;
  const rule = a.rule ?? "";
  if (/accept_edits/.test(rule)) return "write";
  const m = rule.match(/^effect:(\w+)/);
  return m ? m[1]! : null;
}

/** « 24 h » au-delà d'une heure, « 59 min » sous l'heure, « m:ss » sous 10 min. */
export function formatRemaining(seconds: number): string {
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} h`;
  if (seconds >= 600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Rouge seulement pour un effet réellement destructif ; « exécute du code » / « agit sur un appareil » : jaune. */
export function effectColorFor(effect: string | null, toolName?: string | null, args?: unknown): string {
  return effect === "destructive" && effectLabel(effect, toolName, args) !== effectLabel(effect) ? "yellow" : "redBright";
}
