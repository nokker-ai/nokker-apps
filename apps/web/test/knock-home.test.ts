import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __resetKnock, knockStore, setKnockBlocked } from "../src/knock/controller.js";
import { knockHomeError, knockHomeStateText } from "../src/components/KnockHomeSettings.js";
import { setShellLang } from "../src/i18n/index.js";
import { createHash } from "node:crypto";
import { FR_KNOCK } from "../src/i18n/fr-knock.js";

afterEach(() => {
  setShellLang(null);
  __resetKnock();
});

const ios = join(__dirname, "..", "..", "mobile", "ios", "App", "App");

describe("knock to call on the home node (native listening)", () => {
  it("the page stays blocked in home mode; the native setting is only reported", () => {
    setKnockBlocked("home", true, true);
    expect(knockStore.get()).toMatchObject({ blocked: "home", nativeOn: true, nativeAvailable: true, state: "off" });
    setKnockBlocked("home", false);
    expect(knockStore.get().nativeOn).toBe(false);
    setKnockBlocked(null, true);
    expect(knockStore.get()).toMatchObject({ blocked: null, nativeOn: false, nativeAvailable: false });
  });

  it("frozen texts (relecture des textes, 06.11)", () => {
    setShellLang("fr");
    expect(knockHomeStateText("listening")).toBe("À l'écoute de trois coups frappés. Rien n'est enregistré.");
    expect(knockHomeStateText("cut")).toBe("Écoute coupée. Le propriétaire peut la rallumer dans les réglages du nœud maison.");
    expect(knockHomeStateText("background")).toBe("Écoute coupée : Nokker n'est plus au premier plan. Elle reprend quand tu reviens dans l'app.");
    expect(knockHomeError("denied")).toBe("Le micro n'est pas autorisé pour Nokker. Autorise-le dans les Réglages de cet appareil, rubrique Nokker.");
    expect(knockHomeStateText("off")).toBeNull();
    expect(knockHomeError("no_passcode")).toBe("Impossible d'allumer : cet appareil n'a pas de code. Définis-en un dans les Réglages, pour que seul le propriétaire puisse allumer l'écoute.");
    expect(knockHomeError("not_home")).toBe("Disponible seulement quand cet appareil sert de nœud maison.");
  });

  it("frozen fingerprint of the 8 home node texts (relecture des textes, 06.11)", () => {
    const keys = [
      "Off by default. When on, this device listens to the room to recognise three knocks, and nothing else. The sound is analysed on this device then erased at once: it is neither recorded nor sent, and nothing leaves before the three knocks. A banner shows it while it is on. Turning it on asks for Face ID, Touch ID or the passcode of this device.",
      "Turn on",
      "Turn off",
      "Listening for three knocks. Nothing is recorded.",
      "Listening off. The owner can turn it back on in the home node settings.",
      "Listening off: Nokker is no longer in the foreground. It resumes when you come back to the app.",
      "The microphone is not allowed for Nokker. Allow it in the Settings of this device, under Nokker.",
      "Off on this device, which serves as a home node in a shared room. Its owner can turn it on in the home node settings.",
    ];
    // Même sérialisation que json.dumps(ensure_ascii=False, sort_keys=True) de Python.
    const d = Object.fromEntries(keys.sort().map((k) => [k, FR_KNOCK[k]]));
    const json = "{" + Object.entries(d).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ") + "}";
    expect(createHash("sha256").update(json).digest("hex")).toBe("98ddd01df607ea5c3e27898e5ba6a5a0003105a484f1bd7d0fb367158c9f746d");
  });

  it("native: same banner texts, mute without authentication, owner check to switch on, page guard unchanged", () => {
    const k = readFileSync(join(ios, "NokkerKnock.swift"), "utf8");
    expect(k).toContain("À l'écoute de trois coups frappés. Rien n'est enregistré.");
    expect(k).toContain("Écoute coupée. Le propriétaire peut la rallumer dans les réglages du nœud maison.");
    expect(k).toMatch(/static func turnOn[\s\S]*deviceOwnerAuthentication/);
    expect(k).not.toMatch(/static func turnOff[\s\S]{0,400}LAContext/);
    expect(k).toContain('appendingPathComponent("public/knock")');
    expect(k).toContain("Allumer l'écoute des trois coups sur ce nœud maison");
    // Destination = voix du foyer (wall_voice) : indisponible tant qu'elle n'existe pas, jamais la session complète.
    expect(k).toContain("static var available: Bool { false }");
    expect(k).toMatch(/static func shouldRun\(\) -> Bool \{\s*available && on/);
    const plist = readFileSync(join(ios, "Info.plist"), "utf8");
    expect(plist).toContain("Nokker utilise le micro pour reconnaître trois coups frappés, quand c'est allumé, et pour la dictée. La reconnaissance se fait sur cet appareil : le son n'est ni enregistré ni envoyé, seul le texte dicté part.");
    const guard = readFileSync(join(ios, "NokkerViewController.swift"), "utf8");
    expect(guard).toContain("static func pageMayCapture(home: Bool, wall: Bool) -> Bool { !(home || wall) }");
  });
});
