import { describe, expect, it } from "vitest";
import { matches, navViews, settingsAttention, type NavFlags } from "../src/nav/views.js";

const labels = {
  team: "Team",
  household: "Household",
  connectors: "Connectors",
  account: "My account",
  incidents: (n: number) => `${n} live`,
  invitations: (n: number) => `${n} invitations`,
  learning: "Learning",
  waiting: (n: number) => `${n} waiting`,
};
const off: NavFlags = { agents: 0, liveIncidents: null, plan: false, teamInvites: null, householdInvites: null, packs: false, code: false, local: false, learning: null };

describe("navigation de la coque", () => {
  it("drapeaux éteints : Crew dans le tiroir, Connecteurs et Mon compte dans le menu, rien d'autre", () => {
    const v = navViews(off, labels);
    expect(v.map((x) => [x.id, x.group])).toEqual([
      ["crew", "work"],
      ["connectors", "settings"],
      ["account", "settings"],
    ]);
  });

  it("tous les drapeaux : 4 vues de travail, 6 réglages, « Mon compte » en dernier ; aucune vue perdue", () => {
    const v = navViews({ agents: 4, liveIncidents: 2, plan: true, teamInvites: 1, householdInvites: 0, packs: true, code: true, local: true, learning: null }, labels);
    expect(v.filter((x) => x.group === "work").map((x) => x.id)).toEqual(["crew", "code", "incidents", "plan"]);
    expect(v.filter((x) => x.group === "settings").map((x) => x.id)).toEqual(["team", "household", "packs", "connectors", "machine", "account"]);
    expect(v.find((x) => x.id === "crew")?.count).toBe(4);
    expect(v.find((x) => x.id === "incidents")).toMatchObject({ count: 2, countLabel: "2 live", attention: true });
    // Un foyer sans invitation : pas de pastille.
    expect(v.find((x) => x.id === "household")?.count).toBeUndefined();
  });

  it("la pastille du menu additionne ce qui attend dans les réglages (pas les incidents du tiroir)", () => {
    const v = navViews({ ...off, liveIncidents: 3, teamInvites: 2, householdInvites: 1 }, labels);
    expect(settingsAttention(v)).toBe(3);
    expect(settingsAttention(navViews(off, labels))).toBe(0);
  });

  it("recherche de la palette : chaque mot, sans casse ni accents", () => {
    expect(matches("crew", "Crew")).toBe(true);
    expect(matches("equipe", "Équipe")).toBe(true);
    expect(matches("mon cpt", "Mon compte")).toBe(false);
    expect(matches("comp mon", "Mon compte")).toBe(true);
    expect(matches("", "n'importe quoi")).toBe(true);
    expect(matches("theme", "Passer au thème sombre", "theme dark light")).toBe(true);
  });
});


describe("apprentissage dans la navigation", () => {
  it("absente si les drapeaux sont éteints ; dans le menu des réglages avec une pastille d'attention", () => {
    expect(navViews(off, labels).some((v) => v.id === "learning")).toBe(false);
    const v = navViews({ ...off, learning: 3 }, labels).find((x) => x.id === "learning")!;
    expect(v).toMatchObject({ group: "settings", count: 3, countLabel: "3 waiting", attention: true });
    expect(settingsAttention(navViews({ ...off, learning: 3 }, labels))).toBeGreaterThan(0);
    expect(navViews({ ...off, learning: 0 }, labels).find((x) => x.id === "learning")!.attention).toBeUndefined();
  });
});
