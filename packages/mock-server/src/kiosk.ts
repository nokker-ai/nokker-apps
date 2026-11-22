/**
 * Kiosque HDMI d'un Lokkal — mock de `nokker/kiosk.py` : `GET /v1/local/kiosk`, jeton local du titulaire (boucle
 * locale) seulement, lecture seule. Données fictives : météo du jour, deux départs, les deux aides de test de la maison.
 */
import { LOCAL_OWNER } from "./state.js";
import { SCREEN_PREVIEW_HTML, screenFrameUrl } from "./screens.js";

type Send = (status: number, payload: unknown, headers?: Record<string, string>) => void;

export function handleKiosk(user: string | null, method: string, path: string, send: Send): boolean {
  if (path !== "/v1/local/kiosk") return false;
  if (user !== LOCAL_OWNER) return send(401, { error: { message: "jeton local requis" } }), true;
  if (method !== "GET") return send(405, { error: { code: "method", message: "lecture seule" } }), true;
  send(200, {
    now: new Date().toISOString(),
    tz: "Europe/Zurich",
    weather: { now_c: null, code: "partly", hi_c: 11, lo_c: 4, summary: "Éclaircies" },
    departures: [
      { stop: "Gare", line: "F", to: "Centre", minutes: 4 },
      { stop: "Gare", line: "64", to: "Aéroport", minutes: 11 },
    ],
    ha: [
      { entity_id: "input_boolean.nokker_test_lampe", name: "Lampe (test)", state: "off", domain: "input_boolean" },
      { entity_id: "input_boolean.nokker_test_prise", name: "Prise (test)", state: "off", domain: "input_boolean" },
    ],
    presenter: { slot: true },
    night: true,
    // MOCK_KIOSK_SCREEN=1 : un écran V7 publié (page servie comme celle du noyau, signée) ; sinon `null`.
    // MOCK_KIOSK_HOUSEHOLD=1 : le foyer démo du noyau (`kiosk.household_demo`), prénoms fictifs ; sinon absent (vue d'avant).
    ...(process.env.MOCK_KIOSK_HOUSEHOLD === "1" ? { household: demoHousehold() } : {}),
    screen: process.env.MOCK_KIOSK_SCREEN === "1" ? { id: "scr_demo", version: 2, title: "Kitchen", frame_url: screenFrameUrl(SCREEN_PREVIEW_HTML) } : null,
  }, { "Cache-Control": "no-store" });
  return true;
}

const day = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

function demoHousehold(): Record<string, unknown> {
  return {
    demo: true,
    guest: false,
    members: [
      { id: "m1", name: "Léa", color: "#c8553d", initials: "L" },
      { id: "m2", name: "Hugo", color: "#3d7ea6", initials: "H" },
      { id: "m3", name: "Charlie", color: "#6a994e", initials: "C" },
    ],
    agenda: [{ id: "e1", member_id: "m1", start: `${day(1)}T17:30:00+01:00`, end: `${day(1)}T18:30:00+01:00`, all_day: false, title: "Dentiste (démo)" }],
    tasks: [
      { id: "t1", member_id: "m2", title: "Sortir les poubelles", done: false, due: day(0) },
      { id: "t2", member_id: "m3", title: "Ranger sa chambre", done: true },
    ],
    meals: [{ date: day(0), dinner: "Gratin de courgettes" }],
    shopping: [{ id: "s1", text: "Lait", done: false }, { id: "s2", text: "Pain", done: true }],
    projects: [{ id: "p1", title: "Cabane au fond du jardin", progress: 0.4, next_step: "Poncer les planches", next_due: day(5) }],
    at: new Date().toISOString(),
  };
}
