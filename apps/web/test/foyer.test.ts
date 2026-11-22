import { afterEach, describe, expect, it } from "vitest";
import type { GlanceHousehold } from "@nokker-apps/sdk";
import { eventText, haText, mealDay, pct, splitAgenda, weatherIcon } from "../src/glance/foyer/model.js";
import { setShellLang } from "../src/i18n/index.js";

afterEach(() => setShellLang(null));
const now = new Date(2026, 10, 7, 12, 0);
const iso = (d: number, h: number) => new Date(2026, 10, 7 + d, h, 0).toISOString();

describe("wall household view (F1)", () => {
  it("today keeps ongoing and later events, then the next days grouped", () => {
    const agenda: GlanceHousehold["agenda"] = [
      { id: "past", member_id: null, start: iso(0, 8), end: iso(0, 9), all_day: false, title: "Gone" },
      { id: "now", member_id: null, start: iso(0, 11), end: iso(0, 13), all_day: false },
      { id: "later", member_id: null, start: iso(0, 18), end: iso(0, 19), all_day: false, title: "Parents" },
      { id: "tmr", member_id: null, start: "2026-11-08", all_day: true, title: "Birthday" },
    ];
    const s = splitAgenda({ agenda }, now);
    expect(s.today.map((e) => e.id)).toEqual(["now", "later"]);
    expect(s.later).toHaveLength(1);
    expect(s.later[0]!.events[0]!.id).toBe("tmr");
  });

  it("an event without a title says busy; states and percentages", () => {
    setShellLang("fr");
    expect(eventText({ id: "x", member_id: null, start: iso(0, 14), all_day: false }, "fr")).toMatch(/14:00 occupé/);
    expect(eventText({ id: "y", member_id: null, start: "2026-11-08", all_day: true }, "fr")).toBe("Toute la journée : occupé");
    expect(haText({ domain: "light", state: "on" })).toBe("allumé");
    expect(haText({ domain: "binary_sensor", state: "off" })).toBe("fermé");
    expect(haText({ domain: "sensor", state: "21.4", unit: "°C" })).toBe("21.4 °C");
    expect(pct(1.4)).toBe(100);
    expect(weatherIcon("6", "Averses de pluie")).toBe("rain");
    expect(weatherIcon("2", "Assez ensoleillé")).toBe("sun");
    expect(weatherIcon("partly")).toBe("cloudSun");
    expect(mealDay("2026-11-07", now, "fr")).toBe("Aujourd'hui");
    expect(mealDay("2026-11-08", now, "fr")).toBe("Demain");
  });
});
