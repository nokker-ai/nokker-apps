/**
 * Ce que l'utilisateur ne doit pas voir des textes de contrôle de la CLI (prompts.ts) : ils sont écrits pour le modèle.
 * - Titre de fil : le noyau titre un fil d'après son premier message ; un fil ouvert par /loop (ou /goal) prend donc
 *   « [Exécution planifiée 1/50, tout… ». `isControlTitle` le reconnaît, `loopThreadTitle` donne le titre à poser à la place.
 * - Historique relu : `shownUserText` affiche un bloc de contrôle sous sa forme courte.
 * - Marqueur `GOAL: DONE` / `GOAL: CONTINUE` d'une vérification /goal : lu par goal.ts, masqué à l'affichage
 *   (`hideGoalMarker`), y compris pendant le streaming (préfixe partiel en fin de texte).
 */
import { t } from "./i18n/index.js";
import { CONTROL_HEADERS, GOAL_CONTINUE_MARKER, GOAL_DONE_MARKER } from "./prompts.js";

const CONTROL_TITLE = new RegExp(`^\\s*\\[(?:${CONTROL_HEADERS.join("|")})\\b`);

export function isControlTitle(title: string | null | undefined): boolean {
  return !!title && CONTROL_TITLE.test(title);
}

/** Titre lisible d'un fil ouvert par /loop : « /loop <texte tapé> », 60 caractères au plus ; `null` si le texte est vide. */
export function loopThreadTitle(prompt: string): string | null {
  const typed = prompt.replace(/\s+/g, " ").trim();
  if (!typed) return null;
  const full = `/loop ${typed}`;
  return full.length > 60 ? full.slice(0, 59).trimEnd() + "…" : full;
}

/** Message utilisateur d'un historique relu (reprise de session) : un bloc de contrôle s'affiche sous sa forme courte,
 * comme pendant la session (« (loop) tic », « (goal) is the goal reached? ») ; tout autre texte, tel quel. */
export function shownUserText(content: string): string {
  const m = /^\s*\[([^\]\n]+)\]\n([\s\S]*)\n\[\/([^\]\n]+)\]\s*$/.exec(content);
  if (!m || m[3] === undefined) return content;
  const header = m[1]!;
  const name = CONTROL_HEADERS.find((h) => header === h || header.startsWith(`${h} `));
  if (!name || name !== m[3]) return content;
  const body = m[2]!;
  // Le texte tapé est le dernier paragraphe du bloc (loopPrompt, btwPrompt) ; le but suit « But de la session : ».
  const lastPara = body.split(/\n\s*\n/).pop()!.trim();
  if (name === CONTROL_HEADERS[0]) return t("(loop) {0}", lastPara);
  if (name === CONTROL_HEADERS[3]) return t("(by the way) {0}", lastPara);
  if (name === CONTROL_HEADERS[1]) return t("(goal) is the goal reached?");
  return t("(goal) continue toward the goal");
}

const MARKERS = [GOAL_DONE_MARKER, GOAL_CONTINUE_MARKER];

/** Retire le marqueur final d'une réponse de vérification /goal (ligne seule ou fin de ligne), et, pendant le streaming
 * (`streaming`), un début de marqueur en toute fin de texte (« GOAL: D »). Le reste du texte est rendu tel quel. */
export function hideGoalMarker(text: string, streaming = false): string {
  const out = text.replace(/\s+$/, "");
  for (const m of MARKERS) {
    const re = new RegExp(`(?:^|\\s)${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
    if (re.test(out)) return out.replace(re, "").replace(/\s+$/, "");
  }
  // Début de marqueur en fin de texte (streaming) : dernière « ligne » = préfixe strict d'un marqueur, d'au moins 2 caractères.
  const lastLine = out.slice(out.lastIndexOf("\n") + 1).trim().toUpperCase();
  if (streaming && lastLine.length >= 2 && MARKERS.some((m) => m.startsWith(lastLine) && lastLine !== m)) {
    return out.slice(0, out.lastIndexOf("\n") + 1).replace(/\s+$/, "");
  }
  return out;
}
