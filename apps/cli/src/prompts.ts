/**
 * Textes FIXES envoyés au modèle par la CLI (pas des libellés d'interface : hors catalogue i18n, jamais traduits).
 * En français, entre balises fixes seules sur leur ligne, comme les blocs du noyau : forme validée par l'équipe
 * d'entraînement le 01.11.2026. Toute modification change ce que le modèle reçoit : la faire valider avant, et la
 * noter dans le commit.
 *
 * - `/btw`  : `btwPrompt` (question annexe, fil séparé) ;
 * - `/goal` : `goalCheckPrompt` (vérification, réponse avec un marqueur fixe) et `goalContinuePrompt` (relance) ;
 *             marqueurs `GOAL_DONE_MARKER` / `GOAL_CONTINUE_MARKER` (anglais, identiques) ;
 * - `/loop` : `loopPrompt` (bloc d'une exécution planifiée autour du prompt de l'utilisateur).
 * Chaque tour de contrôle part aussi avec `metadata.cli_control` (`CliControl`) dans le corps de /v1/chat/completions.
 */

/** Nature d'un tour envoyé par la CLI elle-même (`metadata.cli_control`) ; absent pour un tour tapé. */
export type CliControl = "btw" | "goal_check" | "goal_continue" | "loop";

/** Titre du fil séparé de `/btw` (visible dans la liste des fils). */
export const BTW_THREAD_TITLE = "annexe";

/** `/btw <question>` : question annexe, envoyée dans un fil à part ; seul un résumé court du contexte (dossier et
 * titre du fil courant) l'accompagne, jamais l'historique. La question reste telle que tapée. */
export function btwPrompt(ctx: { cwd: string | null; threadTitle: string | null }, question: string): string {
  const where = [ctx.cwd ? `dossier de travail ${ctx.cwd}` : null, ctx.threadTitle ? `fil « ${ctx.threadTitle} »` : null].filter(Boolean).join(", ");
  return [
    "[Question annexe]",
    "Question posée par l'utilisateur pendant une autre session ; elle ne fait pas partie de la tâche de cette session.",
    where ? `Contexte de cette session : ${where}. Tu n'as pas son historique.` : "Contexte de cette session : aucun.",
    "Réponds brièvement et directement. Ne modifie aucun fichier et ne lance aucune commande pour cette question.",
    "",
    question,
    "[/Question annexe]",
  ].join("\n");
}

// -- /goal ------------------------------------------------------------------------------------------------------

/** Marqueurs fixes attendus dans la réponse au tour de vérification (dernière occurrence retenue). */
export const GOAL_DONE_MARKER = "GOAL: DONE";
export const GOAL_CONTINUE_MARKER = "GOAL: CONTINUE";

/** Tour court envoyé à la fin de chaque tour tant que le but est actif. */
export function goalCheckPrompt(goal: string): string {
  return [
    "[Vérification du but]",
    "But de la session :",
    goal,
    "",
    "En te fondant uniquement sur le travail déjà fait dans cette session, ce but est-il entièrement atteint ?",
    "N'utilise aucun outil et ne commence aucun nouveau travail dans cette réponse. Réponds en deux phrases au plus,",
    `puis termine par une dernière ligne qui est exactement ${GOAL_DONE_MARKER} si le but est entièrement atteint, ou ${GOAL_CONTINUE_MARKER} s'il reste du travail.`,
    "[/Vérification du but]",
  ].join("\n");
}

/** Relance après `GOAL: CONTINUE`. */
export function goalContinuePrompt(goal: string): string {
  return [
    "[Relance du but]",
    "Continue vers le but de la session :",
    goal,
    "",
    "Choisis la prochaine étape concrète et fais-la. À la fin de ce tour, dis en une ou deux phrases ce que tu as fait et ce qui reste.",
    "[/Relance du but]",
  ].join("\n");
}

// -- /loop ------------------------------------------------------------------------------------------------------

/** Intervalle écrit pour le modèle : « 30 s », « 5 min », « 1 h », « 1 min 30 s ». */
export function intervalFr(ms: number): string {
  let s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return [h ? `${h} h` : "", m ? `${m} min` : "", s ? `${s} s` : ""].filter(Boolean).join(" ") || "0 s";
}

/** Bloc d'une exécution de `/loop` ; le prompt tapé par l'utilisateur y est repris tel quel. */
export function loopPrompt(prompt: string, run: number, maxRuns: number, everyMs: number): string {
  return [
    `[Exécution planifiée ${run}/${maxRuns}, toutes les ${intervalFr(everyMs)}]`,
    "Pars de l'état actuel ; si rien n'a changé depuis la dernière exécution, dis-le en une ligne.",
    "",
    prompt,
    "[/Exécution planifiée]",
  ].join("\n");
}

/** En-têtes des blocs ci-dessus, sans crochets : controltext.ts reconnaît ainsi un titre de fil né d'un tour de contrôle.
 * Aucun texte envoyé au modèle n'en dépend. */
export const CONTROL_HEADERS = ["Exécution planifiée", "Vérification du but", "Relance du but", "Question annexe"] as const;
