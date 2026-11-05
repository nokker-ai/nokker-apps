import { describe, expect, it } from "vitest";
import { NokkerApiError } from "@nokker-apps/sdk";
import { speechCapability, speechErrorText, streamingSource } from "../src/voice/speech.js";

describe("« Écouter » une réponse", () => {
  it("lecture en flux seulement si MediaSource lit le MP3 (ManagedMediaSource d'abord, pour iOS)", () => {
    const yes = { isTypeSupported: (t: string) => t === "audio/mpeg" } as unknown as typeof MediaSource;
    const no = { isTypeSupported: () => false } as unknown as typeof MediaSource;
    expect(streamingSource({ MediaSource: yes })).toBe(yes);
    expect(streamingSource({ MediaSource: no, ManagedMediaSource: yes })).toBe(yes);
    expect(streamingSource({ MediaSource: no })).toBeNull();
    expect(streamingSource({})).toBeNull();
  });
  it("le bouton n'existe que si le noyau annonce la voix ; une erreur de la sonde le cache aussi", async () => {
    expect(await speechCapability({ getSpeechCapability: async () => null } as never)).toBeNull();
    expect(await speechCapability({ getSpeechCapability: async () => ({ available: false, max_chars: 0, format: "audio/mpeg" }) } as never)).toBeNull();
    expect(await speechCapability({ getSpeechCapability: async () => { throw new Error("x"); } } as never)).toBeNull();
    const ok = { available: true, max_chars: 4000, format: "audio/mpeg" };
    expect(await speechCapability({ getSpeechCapability: async () => ok } as never)).toEqual(ok);
  });
  it("messages des refus du contrat", () => {
    const err = (status: number, code?: string) => new NokkerApiError("x", status, code ? { error: { code } } : undefined);
    expect(speechErrorText(err(413, "too_long"))).toBe("This reply is too long to be read aloud.");
    expect(speechErrorText(err(429, "rate_limited"))).toBe("Too many readings just now: try again in a moment.");
    expect(speechErrorText(err(503, "tts_off"))).toBe("Reading aloud is not available.");
    expect(speechErrorText(err(502, "provider_failed"))).toBe("The voice could not be loaded. Try again.");
    expect(speechErrorText(new TypeError("network"))).toBe("The voice could not be loaded. Try again.");
  });
});
