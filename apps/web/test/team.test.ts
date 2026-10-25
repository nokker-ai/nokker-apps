import { describe, expect, it } from "vitest";
import { NokkerApiError } from "@nokker-apps/sdk";
import { abilities, badRules, parseRuleLines, teamError, validSecretName, validSkillName, validSkillSource } from "../src/team/model.js";

const apiErr = (status: number, code?: string, message?: string): NokkerApiError =>
  new NokkerApiError(`http ${status}`, status, code ? { error: { code, message } } : undefined);

describe("écran Équipe (X17)", () => {
  it("les droits suivent le tableau des rôles", () => {
    expect(abilities("viewer")).toEqual({ edit: false, owner: false, attachAgents: false });
    expect(abilities("member")).toEqual({ edit: false, owner: false, attachAgents: true });
    expect(abilities("maintainer")).toEqual({ edit: true, owner: false, attachAgents: true });
    expect(abilities("owner")).toEqual({ edit: true, owner: true, attachAgents: true });
  });

  it("une règle par ligne, vides et doublons retirés ; une ligne illisible est signalée", () => {
    const l = parseRuleLines(" terminal(git push*)\n\nterminal(git push*)\nweb_fetch\n");
    expect(l).toEqual(["terminal(git push*)", "web_fetch"]);
    expect(badRules([...l, "rm -rf /", "x("])).toEqual(["rm -rf /", "x("]);
  });

  it("les codes du noyau deviennent des phrases ; un 404 ne dit pas si le projet existe", () => {
    expect(teamError(apiErr(400, "rules_widen"))).toMatch(/restreindre/);
    expect(teamError(apiErr(400, "secret_value_refused"))).toMatch(/machine/);
    expect(teamError(apiErr(403, "forbidden"))).toMatch(/rôle/);
    expect(teamError(apiErr(404, "not_found"))).toMatch(/n'existe pas, ou tu n'en fais plus partie/);
    expect(teamError(apiErr(400, "bad_rule", "règle illisible : 'x('"))).toBe("règle illisible : 'x('");
    expect(teamError(new Error("réseau"))).toMatch(/ne répond pas/);
  });

  it("noms et sources dans les formes du noyau", () => {
    expect(validSecretName("CLE_API_METEO")).toBe(true);
    expect(validSecretName("cle.meteo-2")).toBe(true);
    expect(validSecretName("_CLE")).toBe(false);
    expect(validSecretName("CLE API")).toBe(false);
    expect(validSkillName("revue-a11y")).toBe(true);
    expect(validSkillName("Revue")).toBe(false);
    for (const s of ["github:owner/repo", "github:owner/repo/skills/a11y", "https://exemple.ch/skill.md", "official/docs/pdf"]) expect(validSkillSource(s)).toBe(true);
    for (const s of ["github:owner", "https://moi:pass@exemple.ch/x", "http://exemple.ch/x", "official/docs"]) expect(validSkillSource(s)).toBe(false);
  });
});
