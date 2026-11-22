import { describe, expect, it } from "vitest";
import { NokkerApiError } from "@nokker-apps/sdk";
import { cleanCode, countdown, deviceName, groupFingerprint, pairErrorCode, pairErrorText, sortDevices, spelled, validCode, when } from "../src/accord/model.js";
import { navViews, type NavFlags, type NavLabels } from "../src/nav/views.js";
import { setShellLang } from "../src/i18n/index.js";

const apiErr = (status: number, code?: string): NokkerApiError => new NokkerApiError(`/v1/local/accord/pair → ${status}`, status, code ? { error: { code, message: code } } : undefined);

describe("ACCORD · empreintes à comparer", () => {
  it("8 caractères en deux groupes de 4, en minuscules ; lus un à un", () => {
    expect(groupFingerprint("9F2C41D7A85E3B60")).toEqual(["9f2c", "41d7"]);
    expect(groupFingerprint("7d429100")).toEqual(["7d42", "9100"]);
    expect(spelled("9f2c41d7aaaa")).toBe("9, f, 2, c, 4, 1, d, 7");
  });
});

describe("ACCORD · compte à rebours et code", () => {
  it("m:ss, jamais négatif", () => {
    expect(countdown(120)).toBe("2:00");
    expect(countdown(102.9)).toBe("1:42");
    expect(countdown(9)).toBe("0:09");
    expect(countdown(-4)).toBe("0:00");
    expect(countdown(600)).toBe("10:00");
  });
  it("6 chiffres exactement (espaces ôtés), rien d'autre", () => {
    expect(validCode("123456")).toBe(true);
    expect(validCode("123 456")).toBe(true);
    expect(cleanCode(" 123 456 ")).toBe("123456");
    for (const bad of ["", "12345", "1234567", "12a456", "abcdef"]) expect(validCode(bad)).toBe(false);
  });
});

describe("ACCORD · erreurs d'appairage (4 états + réseau)", () => {
  it("reconnaît les codes du noyau", () => {
    for (const c of ["bad_code", "pairing_closed", "pairing_locked", "ambiguous"] as const) expect(pairErrorCode(apiErr(400, c))).toBe(c);
    expect(pairErrorCode(apiErr(500))).toBeNull();
    expect(pairErrorCode(new Error("x"))).toBeNull();
  });
  it("chaque état se dit en clair, en anglais comme en français", () => {
    setShellLang("en");
    expect(pairErrorText(apiErr(400, "bad_code"))).toMatch(/Wrong code/);
    expect(pairErrorText(apiErr(423, "pairing_locked"), 540)).toMatch(/blocked for 9:00/);
    expect(pairErrorText(apiErr(423, "pairing_locked"))).toMatch(/blocked for 10:00/); // sans durée connue : celle du noyau
    expect(pairErrorText(apiErr(409, "pairing_closed"))).toMatch(/window is closed/);
    expect(pairErrorText(apiErr(409, "ambiguous"))).toMatch(/Several devices/);
    expect(pairErrorText(new TypeError("fetch failed"))).toMatch(/not responding/);
    setShellLang("fr");
    expect(pairErrorText(apiErr(400, "bad_code"))).toMatch(/Code incorrect/);
    expect(pairErrorText(apiErr(423, "pairing_locked"), 540)).toMatch(/bloqué pendant 9:00/);
    expect(pairErrorText(apiErr(409, "pairing_closed"))).toMatch(/fenêtre d'appairage est fermée/);
    expect(pairErrorText(apiErr(409, "ambiguous"))).toMatch(/Plusieurs appareils/);
    setShellLang(null);
  });
});

describe("ACCORD · liste des appareils", () => {
  it("actifs d'abord (récents en tête), révoqués ensuite ; nom générique sans nom", () => {
    const d = (id: string, at: number, revoked = false) => ({ device_id: id, key8: "00000000", paired_at: at, revoked, revoked_at: revoked ? at + 1 : null });
    expect(sortDevices([d("old", 1), d("rev", 9, true), d("new", 5)]).map((x) => x.device_id)).toEqual(["new", "old", "rev"]);
    setShellLang("en");
    expect(deviceName({})).toBe("ACCORD device");
    expect(deviceName({ name: " Bureau " })).toBe("Bureau");
    setShellLang(null);
  });
  it("date dans la langue de l'interface", () => {
    expect(when(1_700_000_000, "en")).toMatch(/2023/);
    expect(when(1_700_000_000, "fr")).toMatch(/2023/);
  });
});

describe("ACCORD · Réglages → Appareils", () => {
  const flags = (over: Partial<NavFlags> = {}): NavFlags => ({ agents: 0, liveIncidents: null, plan: false, teamInvites: null, householdInvites: null, packs: false, code: false, local: true, learning: null, house: false, ...over });
  const labels: NavLabels = { team: "Team", household: "Home", connectors: "Connectors", account: "Account", incidents: () => "", invitations: () => "", learning: "Learning", waiting: () => "", house: "Home", devices: "Devices" };
  it("la vue n'existe que si l'API répond (drapeau éteint : absente), dans les réglages", () => {
    expect(navViews(flags(), labels).some((v) => v.id === "devices")).toBe(false);
    const on = navViews(flags({ accord: true }), labels).find((v) => v.id === "devices");
    expect(on).toMatchObject({ group: "settings", label: "Devices" });
  });
});
