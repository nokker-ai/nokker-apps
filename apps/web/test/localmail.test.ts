import { describe, expect, it } from "vitest";
import { NokkerApiError } from "@nokker-apps/sdk";
import { mailError } from "../src/localmail/LocalMailbox.js";

describe("boîte mail de la machine (§7.25)", () => {
  it("le message du noyau s'affiche tel quel ; sinon le code en clair ; la passerelle est dite", () => {
    expect(mailError(new NokkerApiError("x", 400, { error: "bad_settings", message: "secret : le NOM d'un secret du coffre local est attendu" }))).toBe("secret : le NOM d'un secret du coffre local est attendu");
    expect(mailError(new NokkerApiError("x", 422, { error: "auth_failed" }))).toMatch(/Identifiants refusés/);
    expect(mailError(new NokkerApiError("x", 403, { error: { message: "passerelle" } }))).toMatch(/jamais par la passerelle/);
    expect(mailError(new Error("réseau"))).toBe("la machine ne répond pas");
  });
});
