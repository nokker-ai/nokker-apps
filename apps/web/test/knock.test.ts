import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { knockStore, knockUnsupported } from "../src/knock/controller.js";
import { knockStateText, unsupportedText } from "../src/knock/KnockCard.js";
import { setShellLang } from "../src/i18n/index.js";

afterEach(() => setShellLang(null));
const pub = join(__dirname, "..", "public");
type W = Parameters<typeof knockUnsupported>[0];
const win = (o: Record<string, unknown>): W => ({ isSecureContext: true, navigator: { mediaDevices: { getUserMedia: () => undefined } }, AudioContext: function () {}, AudioWorkletNode: function () {}, ...o }) as unknown as W;

describe("knock to call (KNOCK.md §7)", () => {
  it("off by default, nothing listening", () => {
    expect(knockStore.get()).toMatchObject({ enabled: false, state: "off", error: null });
  });

  it("says why the browser cannot listen (greyed setting)", () => {
    expect(knockUnsupported(win({}))).toBeNull();
    expect(knockUnsupported(win({ isSecureContext: false }))).toBe("insecure");
    expect(knockUnsupported(win({ navigator: {} }))).toBe("nomedia");
    expect(knockUnsupported(win({ AudioWorkletNode: undefined }))).toBe("noworklet");
    setShellLang("fr");
    expect(unsupportedText("noworklet")).toContain("iOS 14.5");
    expect(knockStateText("listening")).toBe("À l'écoute de trois coups");
  });

  it("the core's module is served as-is, with its weights and the dataset attribution", () => {
    for (const f of ["knock.js", "knock-worklet.js", "cnn.json", "triple.json", "cnn-ATTRIBUTION.csv", "triple-ATTRIBUTION.csv"]) expect(existsSync(join(pub, "knock", f))).toBe(true);
    for (const f of ["cnn-ATTRIBUTION.csv", "triple-ATTRIBUTION.csv"]) expect(readFileSync(join(pub, "knock", f), "utf8")).toMatch(/FSD50K/);
    expect(existsSync(join(pub, "sounds", "nokker-yes.wav"))).toBe(true);
    // The module sends nothing: its only network reads are its two weight files.
    const js = readFileSync(join(pub, "knock", "knock.js"), "utf8");
    expect(js.match(/fetch\(/g)).toHaveLength(2);
    expect(js).not.toMatch(/XMLHttpRequest|sendBeacon|WebSocket/);
  });
});
