import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { installMode, type InstallEnv } from "../src/pwa/install.js";

const base: InstallEnv = { ua: "", platform: "", maxTouchPoints: 0, standalone: false, hasPrompt: false };
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_INAPP = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";

describe("installMode", () => {
  it("app déjà installée", () => expect(installMode({ ...base, ua: IPHONE_SAFARI, standalone: true })).toBe("installed"));
  it("invite native quand beforeinstallprompt a été reçu", () => expect(installMode({ ...base, ua: ANDROID, hasPrompt: true })).toBe("prompt"));
  it("iOS Safari : geste guidé", () => expect(installMode({ ...base, ua: IPHONE_SAFARI })).toBe("ios"));
  it("iOS navigateur intégré (Telegram) : passer par Safari", () => expect(installMode({ ...base, ua: IPHONE_INAPP })).toBe("ios-inapp"));
  it("iPad en mode bureau", () => expect(installMode({ ...base, ua: IPHONE_SAFARI.replace("iPhone", "Macintosh"), platform: "MacIntel", maxTouchPoints: 5 })).toBe("ios"));
  it("Android sans invite : menu du navigateur", () => expect(installMode({ ...base, ua: ANDROID })).toBe("android-menu"));
  it("bureau sans invite : rien", () => expect(installMode({ ...base, ua: "Mozilla/5.0 (X11; Linux x86_64) Chrome/126", platform: "Linux" })).toBe("none"));
});

describe("service worker", () => {
  const sw = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  it("exclut /v1/ de tout cache (isolation entre testeurs)", () => {
    expect(sw).toMatch(/NEVER = \[[^\]]*\\\/v1\\\//);
    expect(sw).not.toMatch(/PRECACHE[^\n]*\/v1/);
  });
  it("ne traite que les GET de même origine", () => {
    expect(sw).toContain('req.method !== "GET"');
    expect(sw).toContain("url.origin !== self.location.origin");
  });
  it("porte l'identifiant de build à remplacer", () => expect(sw).toContain('"__BUILD_ID__"'));
});

describe("manifest", () => {
  const m = JSON.parse(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  it("installable : standalone, start_url, icônes 192/512 et maskable", () => {
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/");
    const sizes = m.icons.map((i: { sizes: string; purpose?: string }) => `${i.sizes}${i.purpose ? ":" + i.purpose : ""}`);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512", "192x192:maskable", "512x512:maskable"]));
  });
});
