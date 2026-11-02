/**
 * File de prompts CÔTÉ CLIENT — pur, sans Ink. Un message tapé pendant un tour n'est pas envoyé au noyau : il attend ici
 * et part à la fin du tour en cours (un seul envoi à la fois, donc un seul AbortController côté session). Les tours
 * relancés par `/loop` passent par la même file.
 */
import type { ChatAttachment } from "@nokker-apps/sdk";
import { t } from "./i18n/index.js";

/** Origine d'un tour : tapé, `/init`, relance de `/loop`, vérification ou relance de `/goal`. */
export type TurnKind = "user" | "init" | "loop" | "goalCheck" | "goalContinue";

export interface QueuedPrompt {
  /** Texte envoyé au modèle (références @ déjà développées). */
  text: string;
  /** Texte affiché (la ligne tapée). */
  shown: string;
  attachments?: ChatAttachment[];
  kind: TurnKind;
  /** `/loop` : identifiant de la boucle qui l'a mis en file. */
  loopId?: number;
}

export function clip(text: string, max = 40): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Ligne au-dessus du champ : « queued (2): first… · second… » (vide si la file est vide). */
export function queueLine(queue: readonly QueuedPrompt[], max = 3): string {
  if (queue.length === 0) return "";
  const shown = queue.slice(0, max).map((q) => clip(q.shown, 30));
  return `${t("queued ({0})", queue.length)}: ${shown.join(" · ")}${queue.length > max ? " · …" : ""}`;
}

/** `/queue` : la file entière, numérotée. */
export function formatQueue(queue: readonly QueuedPrompt[]): string {
  if (queue.length === 0) return t("The queue is empty.");
  return [t("Queued messages ({0}), sent one by one after the turn in progress:", queue.length), ...queue.map((q, i) => `  ${i + 1}. ${clip(q.shown, 80)}${q.kind === "loop" ? ` ${t("(loop)")}` : ""}`)].join("\n");
}
