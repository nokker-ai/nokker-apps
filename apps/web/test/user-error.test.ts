import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError } from "@nokker-apps/sdk";
import { errorKind, userErrorText } from "../src/errors/userError.js";
import { setShellLang } from "../src/i18n/index.js";

afterEach(() => setShellLang(null));

describe("userErrorText", () => {
  it("names the cause in plain words, never the route", () => {
    setShellLang("en");
    expect(userErrorText(new TypeError("Failed to fetch"))).toBe("Cannot reach Nokker: check your connection.");
    expect(errorKind(new NokkerApiError("/v1/chat/completions → 429", 429, ""))).toBe("rate_limited");
    expect(userErrorText(new NokkerApiError("/v1/x → 401", 401, ""))).toBe("Your session has ended: sign in again.");
    expect(userErrorText(new NokkerApiError("/v1/chat/completions → 502", 502, "<html>bad gateway</html>"))).toBe("Nokker had a problem (502). Try again in a moment.");
    expect(userErrorText(new NokkerApiError("/v1/chat/completions → 500", 500, '{"error":{"message":"budget reached"}}'))).toBe("Nokker had a problem: budget reached");
    expect(userErrorText(new NokkerApiError("x", 500, { error: { message: "line1\nline2" } }))).toBe("Nokker had a problem (500). Try again in a moment.");
    expect(userErrorText(new NokkerApiError("/v1/x → 409", 409, { error: { code: "turn_running", message: "a turn is running" } }))).toBe("a turn is running");
    expect(userErrorText(new NokkerApiError("/v1/x → 404", 404, ""))).toBe("Request refused (404).");
    for (const t of [userErrorText(new TypeError("x")), userErrorText(new NokkerApiError("/v1/chat/completions → 503", 503, ""))]) expect(t).not.toMatch(/\/v1\//);
  });
  it("speaks French with the interface", () => {
    setShellLang("fr");
    expect(userErrorText(new TypeError("Failed to fetch"))).toBe("Nokker est injoignable : vérifie ta connexion.");
  });
});
