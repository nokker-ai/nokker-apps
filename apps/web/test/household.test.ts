import { describe, expect, it } from "vitest";
import { NokkerApiError } from "@nokker-apps/sdk";
import { TEXTS, capText, h, householdError, invitableProfiles, noteName, parseCap, quotaRows, seatsLeft } from "../src/household/model.js";
import { planCaps } from "../src/account/usage.js";

const err = (status: number, code?: string) => new NokkerApiError("x", status, code ? { error: { code, message: "x" } } : {});

describe("foyer : modèle de l'écran", () => {
  it("FR et EN ont les mêmes clés, et les variables sont remplacées", () => {
    expect(Object.keys(TEXTS.en).sort()).toEqual(Object.keys(TEXTS.fr).sort());
    expect(h("fr", "usedOf", { used: 45, cap: 110 })).toBe("45 / 110 tours");
    expect(h("en", "planLine", { plan: "Famille", size: 3, max: 6 })).toBe("Famille plan · 3 of 6 member(s)");
  });

  it("codes du noyau traduits, sinon par statut ; jamais le message brut", () => {
    expect(householdError("fr", err(409, "household_full"))).toMatch(/complet/);
    expect(householdError("en", err(409, "attestation_stale"))).toMatch(/changed/);
    expect(householdError("fr", err(403))).toBe(h("fr", "e_403"));
    expect(householdError("fr", err(500, "inconnu"))).toBe("Refus du serveur (500).");
    expect(householdError("fr", new Error("x"))).toBe(h("fr", "e_net"));
  });

  it("barres du quota : soft ne passe jamais au rouge", () => {
    const q = {
      tz: "Europe/Zurich",
      today: { used: 120, cap: 110, resets_at: "" },
      week: { used: 100, cap: 550, resets_at: "" },
    };
    expect(quotaRows({ quota: q, mode: "hard" }).map((r) => r.level)).toEqual(["full", "ok"]);
    expect(quotaRows({ quota: q, mode: "soft" })[0]!.level).toBe("warn");
  });

  it("plafond saisi : entier 0–1000, vide = rien", () => {
    expect(parseCap(" 25 ")).toBe(25);
    expect(parseCap("")).toBeNull();
    expect(parseCap("1001")).toBe("invalid");
    expect(parseCap("2.5")).toBe("invalid");
    expect(capText("fr", { cap: { turns_per_day: null, source: "none" } })).toBe("sans plafond (aucun)");
    expect(capText("en", { cap: { turns_per_day: 40, source: "default" } })).toBe("40 (default)");
  });

  it("profils proposés et places restantes", () => {
    expect(invitableProfiles({ minors: { enabled: false } })).toEqual(["adult"]);
    expect(invitableProfiles({})).toEqual(["adult"]);
    expect(invitableProfiles({ minors: { enabled: true } })).toEqual(["adult", "teen", "child"]);
    expect(seatsLeft({ max_members: 6, counted: 7 })).toBe(0);
  });

  it("nom de note lisible et accepté par le noyau", () => {
    const n = noteName("fact", "Allergies à l'école !", () => "ab12");
    expect(n).toBe("fact-allergies-a-l-ecole-ab12");
    expect(n).toMatch(/^[a-z0-9][a-z0-9_.-]{0,159}$/);
  });

  it("plafonds d'un palier : clés du noyau, ancienne forme en repli", () => {
    expect(
      planCaps({
        turns_per_day: 110,
        turns_per_week: 550,
        household_members: 6,
      }),
    ).toEqual({ day: 110, week: 550, seats: 6 });
    expect(planCaps({ turns: 40 })).toEqual({
      day: 40,
      week: null,
      seats: null,
    });
  });
});
