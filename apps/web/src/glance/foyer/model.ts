/** F1 — vue « Foyer » du mur : fonctions pures (ce qui est montré, groupé, trié). Le noyau a déjà filtré. */
import type { GlanceHousehold, HouseholdEvent, WallMember } from "@nokker-apps/sdk";
import { tr } from "../../i18n/index.js";

const dateOf = (e: HouseholdEvent): Date => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.start);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(e.start);
};
const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const loc = (lang: string): string => (lang === "fr" ? "fr-CH" : "en-GB");

export function hhmm(iso: string, lang: string): string {
  return new Date(iso).toLocaleTimeString(loc(lang), { hour: "2-digit", minute: "2-digit" });
}

/** Ligne d'un créneau : « 14:00 Foot », journée entière, ou « occupé » sans titre. */
export function eventText(e: HouseholdEvent, lang: string): string {
  const what = e.title?.trim() || tr("busy");
  return e.all_day ? tr("All day: {0}", what) : `${hhmm(e.start, lang)} ${what}`;
}

/** Créneaux d'aujourd'hui (en cours compris), triés ; puis les jours suivants regroupés par jour. */
export function splitAgenda(h: Pick<GlanceHousehold, "agenda">, now: Date): { today: HouseholdEvent[]; later: { day: Date; events: HouseholdEvent[] }[] } {
  const sorted = [...h.agenda].sort((a, b) => dateOf(a).getTime() - dateOf(b).getTime());
  const today = sorted.filter((e) => sameDay(dateOf(e), now) && (e.all_day || !e.end || new Date(e.end) > now));
  const later: { day: Date; events: HouseholdEvent[] }[] = [];
  for (const e of sorted) {
    const d = dateOf(e);
    if (sameDay(d, now) || d < now) continue;
    const g = later.find((x) => sameDay(x.day, d));
    if (g) g.events.push(e);
    else later.push({ day: new Date(d.getFullYear(), d.getMonth(), d.getDate()), events: [e] });
  }
  return { today, later: later.slice(0, 3) };
}

export function dayName(d: Date, now: Date, lang: string): string {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (sameDay(d, tomorrow)) return tr("Tomorrow");
  return d.toLocaleDateString(loc(lang), { weekday: "long" });
}

export const memberOf = (members: WallMember[], id: string | null): WallMember | null => (id ? (members.find((m) => m.id === id) ?? null) : null);

/** Repas d'aujourd'hui (le menu du jour), puis le suivant. */
export function mealsAhead(h: Pick<GlanceHousehold, "meals">, now: Date): GlanceHousehold["meals"] {
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return h.meals.filter((m) => m.date >= key).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 2);
}

export function haText(s: { domain: string; state: string; unit?: string }): string {
  if (s.domain === "light" || s.domain === "switch") return s.state === "on" ? tr("switched on") : tr("switched off");
  if (s.domain === "binary_sensor") return s.state === "on" ? tr("open") : tr("closed");
  return `${s.state}${s.unit ? ` ${s.unit}` : ""}`;
}

const WEATHER_ICON = { clear: "sun", partly: "cloudSun", cloudy: "cloud", rain: "rain", snow: "snow", storm: "storm", fog: "fog" } as const;
/** Icône de la marque (jeu de icons.tsx, jamais un emoji) pour un code météo. */
type WeatherIcon = (typeof WEATHER_ICON)[keyof typeof WEATHER_ICON];
/** Le noyau envoie le pictogramme MétéoSuisse (chiffres) et son texte officiel : l'icône se lit dans le texte. */
export function weatherIcon(code: string, summary = ""): WeatherIcon {
  if (code in WEATHER_ICON) return WEATHER_ICON[code as keyof typeof WEATHER_ICON];
  const t = summary.toLowerCase();
  if (/orage|gewitter|thunder|temporal/.test(t)) return "storm";
  if (/neige|schnee|snow|neve/.test(t)) return "snow";
  if (/pluie|averse|regen|rain|shower|pioggia/.test(t)) return "rain";
  if (/brouillard|nebel|fog|nebbia/.test(t)) return "fog";
  if (/\u00e9claircie|eclaircie|partiel|teilweise|partly|parzial/.test(t)) return "cloudSun";
  if (/ensoleill|soleil|sonnig|sunny|sereno/.test(t)) return "sun";
  return "cloud";
}

/** Avancement d'un projet, borné et arrondi. */
export const pct = (p: number): number => Math.round(Math.max(0, Math.min(1, p)) * 100);

/** Titre d'un jour de menu : « Aujourd'hui », « Demain » ou le jour de la semaine. */
export function mealDay(date: string, now: Date, lang: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(y!, (m ?? 1) - 1, d ?? 1);
  return sameDay(day, now) ? tr("Today") : dayName(day, now, lang);
}
