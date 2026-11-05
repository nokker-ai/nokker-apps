import { describe, expect, it } from "vitest";
import type { AccountModels } from "@nokker-apps/sdk";
import { byokItems, cloudByokName, droppedKeys, hostOf, validDefault } from "../src/account/ModelsCard.js";
import { httpsApiUrl } from "../src/onboarding/ByokForm.js";
import { byokName } from "../src/onboarding/localFlow.js";

const models = (over: Partial<AccountModels> = {}): AccountModels => ({ default: "router", effective: "router", entitled: true, byok: [], ...over });

describe("Mon compte → Modèles (BYOK cloud)", () => {
  it("nom accepté par le noyau, 32 caractères au plus", () => {
    const long = byokName("https://inference.a-very-long-provider-name.example.com/v1");
    expect(cloudByokName(long)).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/);
    expect(cloudByokName("api-example-com")).toBe("api-example-com");
  });
  it("https seulement", () => {
    expect(httpsApiUrl("https://api.example.com/v1")).toBe(true);
    expect(httpsApiUrl("http://api.example.com/v1")).toBe(false);
    expect(httpsApiUrl("api.example.com")).toBe(false);
  });
  it("hôte + port, et clés retirées par un changement d'hôte", () => {
    expect(hostOf("https://a.example.com/v1")).toBe("a.example.com:443");
    expect(hostOf("https://a.example.com:8443/v1")).toBe("a.example.com:8443");
    const before = [{ name: "k", base_url: "https://a.example.com", model: "m", hasKey: true }];
    const after = models({ byok: [{ name: "k", base_url: "https://b.example.com", model: "m", has_key: false, ok: true }] });
    expect(droppedKeys(before, after, new Set())).toEqual(["k"]);
    expect(droppedKeys(before, after, new Set(["k"]))).toEqual([]);
  });
  it("défaut valide et liste de l'écran", () => {
    expect(validDefault("byok:k", [{ name: "k", model: "m" }])).toBe("byok:k");
    expect(validDefault("byok:gone", [{ name: "k", model: "m" }])).toBe("router");
    // Formule byok (sans Router) : la première entrée qui a un modèle, sinon rien à envoyer.
    expect(validDefault("router", [{ name: "a", model: "" }, { name: "b", model: "m" }], false)).toBe("byok:b");
    expect(validDefault("router", [], false)).toBeNull();
    expect(byokItems(models({ byok: [{ name: "k", base_url: "https://a.example.com", model: null, has_key: null }] }))).toEqual([{ name: "k", base_url: "https://a.example.com", model: "", hasKey: false }]);
  });
});
