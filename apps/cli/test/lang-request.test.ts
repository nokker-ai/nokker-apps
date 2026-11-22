import { afterEach, describe, expect, it } from "vitest";
import { NokkerClient } from "@nokker-apps/sdk";
import { requestLanguage, setLang } from "../src/i18n/index.js";

afterEach(() => setLang("en"));

describe("Accept-Language : la langue de la personne, ou rien", () => {
  it("en_US → en, fr_FR.UTF-8 → fr, de_DE@euro → de ; LC_ALL l'emporte sur LANG", () => {
    expect(requestLanguage({ LANG: "en_US.UTF-8" })).toBe("en");
    expect(requestLanguage({ LANG: "fr_FR.UTF-8" })).toBe("fr");
    expect(requestLanguage({ LANG: "de_DE@euro" })).toBe("de");
    expect(requestLanguage({ LC_ALL: "fr_CH.UTF-8", LANG: "en_US.UTF-8" })).toBe("fr");
  });
  it("sous C/POSIX ou sans locale : AUCUN en-tête (le noyau détecte la langue du message)", () => {
    expect(requestLanguage({})).toBeUndefined();
    expect(requestLanguage({ LANG: "C" })).toBeUndefined();
    expect(requestLanguage({ LANG: "C.UTF-8" })).toBeUndefined();
    expect(requestLanguage({ LC_ALL: "POSIX" })).toBeUndefined();
    expect(requestLanguage({ LANG: "" })).toBeUndefined();
  });
  it("NOKKER_LANG est toujours envoyée, même sous LANG=C ; --lang aussi", () => {
    expect(requestLanguage({ NOKKER_LANG: "fr", LANG: "C" })).toBe("fr");
    setLang("fr", true); // --lang fr
    expect(requestLanguage({ LANG: "C" })).toBe("fr");
  });
  it("le SDK n'envoie pas l'en-tête quand la langue est inconnue", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const fetchImpl = (async (_u: string, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers);
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}", json: async () => ({}) };
    }) as never;
    await new NokkerClient({ baseUrl: "http://x", fetchImpl, language: () => undefined }).healthz();
    await new NokkerClient({ baseUrl: "http://x", fetchImpl, language: () => "fr" }).healthz();
    expect(seen[0]?.["Accept-Language"]).toBeUndefined();
    expect(seen[1]?.["Accept-Language"]).toBe("fr");
  });
});
