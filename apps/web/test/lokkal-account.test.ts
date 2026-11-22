import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { nokkerAccountUrl } from "../src/gateway/auth.js";
import { RemoteAccountCard } from "../src/account/RemoteAccountCard.js";
import { chipTone } from "../src/bubbles/kinds.js";

describe("Lokkal : le compte est sur nokker.ai", () => {
  it("l'adresse vient de la base du cloud de l'installation (celle de la connexion), jamais d'une page locale", () => {
    expect(nokkerAccountUrl()).toBe("https://app.nokker.ai/account"); // base par défaut : le cloud de production
    expect(nokkerAccountUrl("https://preprod.example.test/gateway/authorize")).toBe("https://preprod.example.test/account"); // une autre installation
  });
  it("la carte renvoie vers nokker.ai (nouvel onglet, sans opener), en français et en anglais", () => {
    const fr = renderToStaticMarkup(createElement(RemoteAccountCard, { lang: "fr" }));
    expect(fr).toContain(`href="${nokkerAccountUrl()}"`);
    expect(fr).toMatch(/rel="noopener noreferrer"/);
    expect(fr).toContain("Ouvrir mon compte nokker.ai");
    expect(renderToStaticMarkup(createElement(RemoteAccountCard, { lang: "en" }))).toContain("Open my nokker.ai account");
  });
});

describe("pastille « en cours »", () => {
  it("sa classe n'est plus `run` (déjà la ligne d'une exécution : grille et marges qui la décentraient)", () => {
    expect(chipTone("executing")).toBe("running");
    expect(chipTone("executing")).not.toBe("run");
  });
});
