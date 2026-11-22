/**
 * F1 — vue « Foyer » du mur, mock du contrat dev 07.11 : `GET /v1/glance/household` (nkg_ d'un mur, ETag/304), coches
 * de tâches et de courses depuis le mur (sans effet externe, 30/h, idempotentes), mode invité (allumé sans
 * authentification, éteint après le code de l'appareil, expire seul au bout de 4 h ; le FILTRAGE est fait ici, comme le
 * noyau). Données de démonstration relatives à aujourd'hui, stables pour un même mock.
 */
import { createHash } from "node:crypto";
import type { GlanceHousehold, HouseholdEvent, HouseholdTask, ShoppingItem } from "@nokker-apps/sdk";
import type { MockState } from "./state.js";

export const GUEST_MS = 4 * 3600_000;
const TICKS_PER_HOUR = 30;

interface H {
  tasks: HouseholdTask[];
  shopping: ShoppingItem[];
  ticks: Map<string, number[]>;
}
const all = new WeakMap<MockState, H>();

const day = (offset: number): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
};
const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const at = (offset: number, h: number, m = 0): string => {
  const d = day(offset);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

function h(state: MockState): H {
  let x = all.get(state);
  if (!x) {
    x = {
      tasks: [
        { id: "tk_dishes", member_id: "m_sam", title: "Vider le lave-vaisselle", done: false },
        { id: "tk_plants", member_id: "m_zoe", title: "Arroser les plantes", done: false },
        { id: "tk_bins", member_id: "m_camille", title: "Sortir les poubelles", done: true },
        { id: "tk_homework", member_id: "m_leo", title: "Devoirs de maths", done: false, due: at(0, 18) },
        { id: "tk_parcel", member_id: null, title: "Récupérer le colis à la poste", done: false },
      ],
      shopping: [
        { id: "sh_milk", text: "Lait", done: false },
        { id: "sh_bread", text: "Pain complet", done: false },
        { id: "sh_apples", text: "Pommes (1 kg)", done: true },
        { id: "sh_coffee", text: "Café", done: false },
      ],
      ticks: new Map(),
    };
    all.set(state, x);
  }
  return x;
}

/** La vue du mur, filtrée comme le noyau : invité → ni titres, ni tâches, ni menus, ni courses, ni projets. */
export function householdView(state: MockState, guest: boolean, guestUntil: number | null, showTitles: boolean): GlanceHousehold {
  const x = h(state);
  const agenda: HouseholdEvent[] = [
    { id: "ev1", member_id: "m_camille", start: at(0, 9), end: at(0, 10), all_day: false, title: "Dentiste" },
    { id: "ev2", member_id: "m_leo", start: at(0, 14), end: at(0, 16), all_day: false, title: "Foot" },
    { id: "ev3", member_id: "m_sam", start: at(0, 18, 30), end: at(0, 19, 30), all_day: false, title: "Réunion de parents" },
    { id: "ev4", member_id: "m_zoe", start: at(0, 16, 30), end: at(0, 17, 30), all_day: false },
    { id: "ev5", member_id: null, start: ymd(day(1)), all_day: true, title: "Anniversaire de Mamie" },
    { id: "ev6", member_id: "m_camille", start: at(1, 8), end: at(1, 12), all_day: false, title: "Télétravail" },
    { id: "ev7", member_id: "m_leo", start: at(2, 10), end: at(2, 11), all_day: false, title: "Piano" },
    { id: "ev8", member_id: "m_sam", start: at(3, 19), end: at(3, 22), all_day: false, title: "Cinéma" },
    // Titres partagés avec le foyer, sauf en mode invité ; ev4 est un événement PRIVÉ (jamais de titre) : « occupé ».
  ].map((e) => (guest ? { ...e, title: undefined } : e)).map((e) => JSON.parse(JSON.stringify(e)) as HouseholdEvent);
  void showTitles;
  return {
    members: [
      { id: "m_camille", name: "Camille", color: "#e2574c", initials: "C" },
      { id: "m_sam", name: "Sam", color: "#3a7bd5", initials: "S" },
      { id: "m_leo", name: "Léo", color: "#2f9e6b", initials: "L" },
      { id: "m_zoe", name: "Zoé", color: "#b26ad6", initials: "Z" },
    ],
    guest,
    agenda,
    tasks: guest ? [] : x.tasks.map((t) => ({ ...t })),
    meals: guest
      ? []
      : [
          { date: ymd(day(0)), lunch: "Salade de lentilles", dinner: "Gratin de courge" },
          { date: ymd(day(1)), dinner: "Raclette (anniversaire)" },
          { date: ymd(day(2)), lunch: "Restes", dinner: "Soupe et tartines" },
        ],
    shopping: guest ? [] : x.shopping.map((s) => ({ ...s })),
    // Comme le noyau : MétéoSuisse ne publie que le jour (min, max, pictogramme) → `now_c` toujours null.
    weather: { now_c: null, code: "partly", hi_c: 12, lo_c: 4, summary: "Éclaircies, vent faible" },
    departures: [
      { stop: "Gare", line: "S1", to: "Centre", minutes: 6 },
      { stop: "Gare", line: "12", to: "Hôpital", minutes: 14 },
    ],
    projects: guest
      ? []
      : [
          { id: "pj_bday", title: "Anniversaire de Léo", progress: 0.6, next_due: ymd(day(5)), next_step: "Commander le gâteau" },
          { id: "pj_move", title: "Rangement du grenier", progress: 0.25, next_step: "Trier les cartons de livres" },
        ],
    ha: [
      { entity_id: "sensor.salon_temperature", name: "Salon", state: "21.4", unit: "°C", domain: "sensor" },
      { entity_id: "light.cuisine", name: "Cuisine", state: "on", domain: "light" },
      { entity_id: "binary_sensor.fenetre_chambre", name: "Fenêtre chambre", state: "off", domain: "binary_sensor" },
    ],
    at: new Date().toISOString(),
  };
}

export const etagOf = (v: GlanceHousehold): string => `"${createHash("sha256").update(JSON.stringify({ ...v, at: undefined })).digest("hex").slice(0, 20)}"`;

/** Coche depuis le mur : 404 hors du partage (ou en mode invité), 429 au-delà de 30/h, idempotente. */
export function tick(state: MockState, deviceId: string, guest: boolean, kind: "tasks" | "shopping", id: string, done: boolean): { status: number; body: unknown } {
  const x = h(state);
  const now = Date.now();
  const list = (x.ticks.get(deviceId) ?? []).filter((t) => now - t < 3600_000);
  if (list.length >= TICKS_PER_HOUR) return { status: 429, body: { error: { code: "wall_rate", message: `at most ${TICKS_PER_HOUR} per hour`, retry_after: 60 } } };
  const items = kind === "tasks" ? x.tasks : x.shopping;
  const it = guest ? undefined : items.find((t) => t.id === id);
  if (!it) return { status: 404, body: { error: { code: "not_found", message: "not shared with this wall" } } };
  if (it.done !== done) {
    it.done = done;
    list.push(now);
    x.ticks.set(deviceId, list);
  }
  return { status: 200, body: { id: it.id, done: it.done } };
}
