import { afterEach, describe, expect, it } from "vitest";
import type { GlanceView } from "@nokker-apps/sdk";
import { setShellLang } from "../src/i18n/index.js";
import { burnInShift, cardsLine, isNight, nextEventLine, wallData } from "../src/glance/wall.js";

afterEach(() => setShellLang(null));
const at = (h: number, m = 0) => new Date(2026, 10, 6, h, m);
const base: GlanceView = { brief: null, brief_last_run: null, approvals: [], incidents: [], unavailable: ["brief"], at: "", approvals_count: 2, surface: "wall", show_brief: false };

describe("écran mural (P10b)", () => {
  it("nuit de 22:00 incluse à 07:00 exclue, comme le natif", () => {
    expect([22, 23, 0, 6].map((h) => isNight(at(h)))).toEqual([true, true, true, true]);
    expect([7, 12, 21].map((h) => isNight(at(h, 59)))).toEqual([false, false, false]);
  });
  it("décalage anti-marquage : petit, borné, change avec les minutes", () => {
    const seen = new Set<string>();
    for (let m = 0; m < 60; m++) {
      const s = burnInShift(at(10, m));
      expect(Math.abs(s.x)).toBeLessThanOrEqual(6);
      expect(Math.abs(s.y)).toBeLessThanOrEqual(6);
      seen.add(`${s.x},${s.y}`);
    }
    expect(seen.size).toBeGreaterThan(5);
  });
  it("cartes : le nombre seulement, jamais le contenu", () => {
    setShellLang("fr");
    expect(cardsLine({ approvals_count: 0, approvals: [] })).toBe("Rien à décider.");
    expect(cardsLine({ approvals_count: 1, approvals: [] })).toBe("1 carte à décider dans l'app Nokker.");
    expect(cardsLine({ approvals_count: 3, approvals: [] })).toBe("3 cartes à décider dans l'app Nokker.");
  });
  it("prochain rendez-vous : heure seule sans titre ; demain ; en cours ; journée entière", () => {
    setShellLang("fr");
    const now = at(10);
    expect(nextEventLine({ next_event: { start: at(14, 30).toISOString(), all_day: false } }, now, "fr")).toBe("Prochain rendez-vous à 14:30");
    expect(nextEventLine({ next_event: { start: new Date(2026, 10, 7, 9, 0).toISOString(), all_day: false } }, now, "fr")).toBe("Prochain rendez-vous demain à 09:00");
    expect(nextEventLine({ next_event: { start: at(9, 30).toISOString(), all_day: false } }, now, "fr")).toBe("Rendez-vous en cours");
    expect(nextEventLine({ next_event: { start: at(0).toISOString(), all_day: true, title: "Congé" } }, now, "fr")).toBe("Événement toute la journée aujourd'hui — Congé");
    expect(nextEventLine({ next_event: { start: at(14, 30).toISOString(), all_day: false, title: "Dentiste" } }, now, "fr")).toBe("Prochain rendez-vous à 14:30 — Dentiste");
    expect(nextEventLine({}, now, "fr")).toBeNull();
    // Journée entière : date seule (noyau), lue en heure locale, jamais décalée au jour d'avant.
    expect(nextEventLine({ next_event: { start: "2026-11-07", all_day: true } }, now, "fr")).toBe("Événement toute la journée demain");
    expect(nextEventLine({ next_event: { start: "2026-11-06", all_day: true } }, now, "fr")).toBe("Événement toute la journée aujourd'hui");
  });
  it("brief : rien sans show_brief, même si un résumé arrivait ; incidents par titre", () => {
    setShellLang("fr");
    const run = { summary: "(demo) 3 mails importants", ended_at: "", status: "succeeded" } as unknown as GlanceView["brief_last_run"];
    const off = wallData({ ...base, brief_last_run: run, incidents: [{ id: "in_1", title: "NAS hors ligne" }] as GlanceView["incidents"] }, at(10), "fr");
    expect(off).toMatchObject({ brief: null, cards: "2 cartes à décider dans l'app Nokker.", incidents: ["NAS hors ligne"], event: null });
    expect(wallData({ ...base, show_brief: true, brief_last_run: run }, at(10), "fr").brief).toBe("3 mails importants");
  });
});
