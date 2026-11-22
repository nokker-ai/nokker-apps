/**
 * Écran mural (LOKKAL-PHONE §4.4, lot P10b) : ce que la page murale montre, en fonctions pures. Le mur est dans une
 * pièce commune : le noyau n'envoie que le minimum (nombre de cartes, titres d'incidents, brief et titre de
 * l'événement seulement si le titulaire l'a permis) ; ces fonctions ne montrent rien de plus que ce qu'elles reçoivent.
 */
import type { GlanceView } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import { cleanSummary } from "./model.js";

export const NIGHT_FROM = 22;
export const NIGHT_TO = 7;

/** Même règle que le natif (NokkerWall.isNight) : 22:00 incluse → 07:00 exclue, heure de l'appareil. */
export function isNight(at: Date): boolean {
  const h = at.getHours();
  return h >= NIGHT_FROM || h < NIGHT_TO;
}

/** Décalage contre le marquage de l'écran : quelques pixels, qui changent chaque minute, en boucle. */
export function burnInShift(at: Date): { x: number; y: number } {
  const m = at.getHours() * 60 + at.getMinutes();
  return { x: (m % 5) * 3 - 6, y: (Math.floor(m / 5) % 5) * 3 - 6 };
}

const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function hhmm(d: Date, lang: string): string {
  return d.toLocaleTimeString(lang === "fr" ? "fr-CH" : "en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** Ligne du prochain événement (titre seulement s'il est reçu) ; null sans événement. */
export function nextEventLine(v: Pick<GlanceView, "next_event">, now: Date, lang: string): string | null {
  const e = v.next_event;
  if (!e) return null;
  // Journée entière : le noyau envoie une DATE (AAAA-MM-JJ), lue en heure locale (pas minuit UTC).
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.start);
  const start = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(e.start);
  if (Number.isNaN(start.getTime())) return null;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const today = sameDay(start, now) || start < now;
  let when: string;
  if (e.all_day) when = today ? tr("All-day event today") : tr("All-day event tomorrow");
  else if (start <= now) when = tr("Appointment in progress");
  else if (today) when = tr("Next appointment at {0}", hhmm(start, lang));
  else if (sameDay(start, tomorrow)) when = tr("Next appointment tomorrow at {0}", hhmm(start, lang));
  else when = tr("Next appointment at {0}", hhmm(start, lang));
  const title = e.title?.trim();
  return title ? `${when} — ${title}` : when;
}

/** Nombre de cartes à décider, jamais leur contenu. */
export function cardsLine(v: Pick<GlanceView, "approvals_count" | "approvals">): string {
  const n = v.approvals_count ?? v.approvals.length;
  return n === 0 ? tr("Nothing to decide.") : n === 1 ? tr("1 card to decide in the Nokker app.") : tr("{0} cards to decide in the Nokker app.", n);
}

export interface WallData {
  event: string | null;
  cards: string;
  incidents: string[];
  /** Résumé du brief : seulement si le titulaire l'a permis (le noyau ne l'envoie pas sinon). */
  brief: string | null;
}

export function wallData(v: GlanceView, now: Date, lang: string): WallData {
  const summary = v.show_brief !== false ? v.brief_last_run?.summary : null;
  return {
    event: nextEventLine(v, now, lang),
    cards: cardsLine(v),
    incidents: v.unavailable.includes("incidents") ? [] : v.incidents.map((i) => i.title).filter(Boolean),
    brief: summary ? cleanSummary(summary) : null,
  };
}
