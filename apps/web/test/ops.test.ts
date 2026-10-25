import { describe, expect, it } from "vitest";
import { NokkerApiError, type Incident, type PlanCard } from "@nokker-apps/sdk";
import { ago, cronHuman, lines, opsError, planTree, sortIncidents } from "../src/ops/model.js";

const inc = (id: string, state: Incident["state"], last: string): Incident => ({ id, state, last_seen_at: last }) as Incident;
const card = (id: string, parent: string | null, children: string[] = [], position = 0): PlanCard => ({ id, parent_id: parent, children, position }) as PlanCard;

describe("incidents et plan (X18)", () => {
  it("le plus urgent d'abord : ouvert, en cours, résolu ; puis le plus récent", () => {
    const l = sortIncidents([inc("a", "resolved", "2026-10-25T10:00:00Z"), inc("b", "in_progress", "2026-10-25T09:00:00Z"), inc("c", "open", "2026-10-25T08:00:00Z"), inc("d", "open", "2026-10-25T11:00:00Z")]);
    expect(l.map((i) => i.id)).toEqual(["d", "c", "b", "a"]);
  });

  it("l'arbre suit children ; une carte dont la mère manque devient racine", () => {
    const t = planTree([card("g", null, ["m2", "m1"]), card("m1", "g"), card("m2", "g"), card("x", "absente", [], 1)]);
    expect(t.roots.map((c) => c.id)).toEqual(["g", "x"]);
    expect(t.kids(t.roots[0]!).map((c) => c.id)).toEqual(["m2", "m1"]);
  });

  it("textes : âge, cron courant en clair, lignes", () => {
    const now = Date.parse("2026-10-25T12:00:00Z");
    expect(ago("2026-10-25T11:58:00Z", now)).toBe("il y a 2 min");
    expect(ago(null)).toBe("—");
    expect(cronHuman("30 7 * * 1-5")).toBe("en semaine à 07:30");
    expect(cronHuman("0 8 * * *")).toBe("chaque jour à 08:00");
    expect(cronHuman("*/5 * * * *")).toBe("*/5 * * * *");
    expect(lines(" a\n\n b \n")).toEqual(["a", "b"]);
  });

  it("une mère refuse un statut : la phrase le dit", () => {
    expect(opsError(new NokkerApiError("x", 400, { error: { code: "computed", message: "…" } }))).toMatch(/se calcule/);
    expect(opsError(new NokkerApiError("x", 409, { error: { code: "resolved" } }))).toMatch(/Déjà fait/);
  });
});
