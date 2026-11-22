import { describe, expect, it } from "vitest";
import { NokkerApiError } from "@nokker-apps/sdk";
import { defaultDeviceName, deviceName, lastSeenText, pairErrorText, validName } from "../src/accord/model.js";
import { setShellLang } from "../src/i18n/index.js";

describe("ACCORD · nom de l'appareil", () => {
  it("nom par défaut « ACCORD <key8> » ; le nom servi par le noyau est montré tel quel", () => {
    expect(defaultDeviceName("7d429100")).toBe("ACCORD 7d429100");
    expect(deviceName({ name: "Bureau" })).toBe("Bureau");
    expect(deviceName({ name: "  Cuisine  " })).toBe("Cuisine");
  });
  it("saisie : 40 caractères au plus (visibles, pas octets), sans caractère de contrôle ; vide permis (retour au défaut)", () => {
    expect(validName("")).toBe(true);
    expect(validName("Bureau de Nina")).toBe(true);
    expect(validName("é".repeat(40))).toBe(true);
    expect(validName("a".repeat(41))).toBe(false);
    expect(validName("😀".repeat(40))).toBe(true); // 40 caractères, pas 160 octets
    expect(validName("ligne\nsuivante")).toBe(false);
    expect(validName("tab\there")).toBe(false);
    expect(validName("é".repeat(20))).toBe(true); // NFC : 20 caractères
  });
  it("erreur bad_name lisible, en anglais et en français", () => {
    const e = new NokkerApiError("/v1/local/accord/devices/acc_x → 400", 400, { error: { code: "bad_name", message: "bad_name" } });
    setShellLang("en");
    expect(pairErrorText(e)).toBe("Name refused: 40 characters at most, no control characters.");
    setShellLang("fr");
    expect(pairErrorText(e)).toBe("Nom refusé : 40 caractères au plus, sans caractère de contrôle.");
    setShellLang(null);
  });
});

describe("ACCORD · dernière connexion", () => {
  const now = Date.UTC(2026, 10, 18, 12, 0, 0);
  const sec = (minAgo: number): number => (now - minAgo * 60_000) / 1000;
  it("relative : à l'instant, il y a 3 min, 2 h, 2 j ; jamais connecté", () => {
    setShellLang("en");
    expect(lastSeenText({ last_seen_at: null }, now)).toBe("Never connected");
    expect(lastSeenText({}, now)).toBe("Never connected"); // noyau d'avant : pas de champ
    expect(lastSeenText({ last_seen_at: sec(0.2) }, now)).toBe("Last seen just now");
    expect(lastSeenText({ last_seen_at: sec(3) }, now)).toBe("Last seen 3 min ago");
    expect(lastSeenText({ last_seen_at: sec(120) }, now)).toBe("Last seen 2 h ago");
    expect(lastSeenText({ last_seen_at: sec(2 * 24 * 60) }, now)).toBe("Last seen 2 d ago");
    setShellLang("fr");
    expect(lastSeenText({ last_seen_at: null }, now)).toBe("Jamais connecté");
    expect(lastSeenText({ last_seen_at: sec(3) }, now)).toBe("Dernière connexion il y a 3 min");
    setShellLang(null);
  });
});
