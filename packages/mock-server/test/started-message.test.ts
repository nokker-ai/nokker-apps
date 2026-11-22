import { describe, expect, it } from "vitest";
import { startedMessage } from "../src/server.js";

describe("turn.started.user_message (noyau 1ce737f1)", () => {
  it("le texte tel quel ; rien s'il est vide", () => {
    expect(startedMessage("bonjour")).toEqual({ user_message: "bonjour" });
    expect(startedMessage("   ")).toEqual({});
  });
  it("16 Kio d'octets UTF-8 au plus, truncated au-delà, jamais un caractère coupé en deux", () => {
    const text = "é".repeat(9000); // 18 000 octets
    const r = startedMessage(text);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.user_message!, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(r.user_message).not.toContain("�");
    expect(startedMessage("a".repeat(16 * 1024))).toEqual({ user_message: "a".repeat(16 * 1024) });
  });
});
