import { describe, expect, it } from "vitest";
import type { MultiConnector } from "@nokker-apps/sdk";
import { buildCreateRequest, grantLine, labelProblem, levelKey, mineOf, passwordLabelKey, providerLabel, sharedWithMe } from "../src/connectors/ConnectorsMulti.js";

const c = (o: Partial<MultiConnector>): MultiConnector => ({ id: "mb_aaaaaaaaaa", kind: "mail", label: "x", default: false, state: "ok", access: "owner", ...o });

describe("connecteurs multiples (écran)", () => {
  it("mes boîtes : le défaut d'abord, puis par nom ; partagées à part", () => {
    const list = [c({ id: "1", label: "zeta" }), c({ id: "2", label: "alpha" }), c({ id: "3", label: "pro", default: true }), c({ id: "4", label: "famille", access: "read", owner: { account_id: "a", name: "Camille" } }), c({ id: "5", kind: "calendar", label: "Agenda", default: true })];
    expect(mineOf(list, "mail").map((x) => x.label)).toEqual(["pro", "alpha", "zeta"]);
    expect(mineOf(list, "calendar").map((x) => x.label)).toEqual(["Agenda"]);
    expect(sharedWithMe(list).map((x) => x.label)).toEqual(["famille"]);
  });

  it("niveaux et ligne d'un partage (en attente, montée en attente)", () => {
    expect(levelKey("mail", "send")).toBe("cmLevelMailSend");
    expect(levelKey("calendar", "write")).toBe("cmLevelCalWrite");
    expect(grantLine("fr", "mail", { account_id: "s", name: "Sam", level: "send", status: "pending" })).toBe("Sam · lecture et envoi — en attente d'approbation");
    expect(grantLine("fr", "mail", { account_id: "s", name: "Sam", level: "read", status: "active", pending_level: "send" })).toBe("Sam · lecture seule — passage à « lecture et envoi » en attente d'approbation");
    expect(grantLine("en", "calendar", { account_id: "s", name: "Sam", level: "write", status: "active" })).toBe("Sam · read and write");
  });

  it("corps du POST : libellé facultatif, région Zoho, iCal nommé par le libellé", () => {
    const f = (o: Record<string, string>) => (n: string) => o[n] ?? "";
    expect(buildCreateRequest("mail", f({ preset: "zoho", address: "a@b.example", secret: "s", region: "com" }))).toEqual({ kind: "mail", settings: { preset: "zoho", address: "a@b.example", region: "com" }, secret: "s" });
    expect(buildCreateRequest("mail", f({ label: "pro", preset: "bluewin", address: "a@b.example", secret: "s" }))).toEqual({ kind: "mail", label: "pro", settings: { preset: "bluewin", address: "a@b.example" }, secret: "s" });
    expect(buildCreateRequest("mail", f({ preset: "gmail", address: "a@b.example" }))).toBeNull();
    expect(buildCreateRequest("calendar", f({ label: "École", mode: "ical", secret: "https://x/y.ics" }))).toEqual({ kind: "calendar", label: "École", settings: { mode: "ical", label: "École" }, secret: "https://x/y.ics" });
    expect(providerLabel("bluewin")).toMatch(/Swisscom/);
  });

  it("nom refusé d'avance ; « Mot de passe » sauf mot de passe d'application ; mineur dans la ligne", () => {
    for (const bad of ["a/b", "a|b", "a·b", "x".repeat(41), "mb_7f3k2q9xa4", "MB_0000000000", "ca_abcdefghij"]) expect(labelProblem(bad)).toBe("errBadLabel");
    expect(labelProblem("pro")).toBeNull();
    expect(labelProblem("  pro   perso ")).toBeNull();
    expect(labelProblem("")).toBeNull();
    expect(passwordLabelKey("bluewin", true)).toBe("cmPassword");
    expect(passwordLabelKey("gmail", true)).toBe("mailPassword");
    expect(passwordLabelKey("custom", false)).toBe("mailPassword");
    expect(grantLine("fr", "mail", { account_id: "s", name: "sam", minor: true, level: "read", status: "active" })).toBe("sam (mineur·e) · lecture seule");
  });
});
