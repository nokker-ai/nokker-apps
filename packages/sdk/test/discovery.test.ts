import { describe, expect, it } from "vitest";
import { filterDiscovered, PHONE_OP_CAP, PHONE_OPS } from "../src/index.js";

const idOf = (t: string, n: string) => `${t}|${n}`;
describe("découverte du réseau local (P10d)", () => {
  it("types fermés, ordinateurs et téléphones personnels écartés par le TXT, préfixe matériel RAOP retiré, dédoublonnage par nom", () => {
    const got = filterDiscovered(
      [
        { type: "_googlecast._tcp", name: "TV Salon" },
        { type: "_raop._tcp", name: "A1B2C3D4E5F6@TV Salon", txt: { am: "AppleTV11,1" } },
        { type: "_airplay._tcp", name: "MacBook de Marie", txt: { model: "MacBookPro18,1" } },
        { type: "_raop._tcp", name: "0011223344AA@iPad de Léo", txt: { am: "iPad13,4" } },
        { type: "_airplay._tcp", name: "iPhone de Paul", txt: { model: "iPhone14,2" } },
        { type: "_companion-link._tcp", name: "iPhone de Paul" },
        { type: "_ssh._tcp", name: "nas" },
        { type: "_home-assistant._tcp", name: "Home" },
        { type: "_sonos._tcp", name: "Cuisine" },
      ],
      idOf,
    );
    expect(got).toEqual([
      { id: "_googlecast._tcp|TV Salon", type: "_googlecast._tcp", types: ["_googlecast._tcp", "_raop._tcp"], name: "TV Salon" },
      { id: "_home-assistant._tcp|Home", type: "_home-assistant._tcp", types: ["_home-assistant._tcp"], name: "Home" },
      { id: "_sonos._tcp|Cuisine", type: "_sonos._tcp", types: ["_sonos._tcp"], name: "Cuisine" },
    ]);
    expect(JSON.stringify(got)).not.toMatch(/Marie|Léo|Paul|A1B2C3D4E5F6/);
  });
  it("op de la file : capacité lan_home", () => {
    expect(PHONE_OPS.has("lan.discover")).toBe(true);
    expect(PHONE_OP_CAP["lan.discover"]).toBe("lan_home");
  });
});
