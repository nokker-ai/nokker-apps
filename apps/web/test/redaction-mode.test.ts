import { describe, expect, it } from "vitest";
import { redactionMode } from "../src/components/useRedaction.js";

describe("masquage : mode (fail-closed dans la coque)", () => {
  it("web pur : rien à masquer ; coque sans Vault ou règles refusées : indisponible ; en attente ; prêt", () => {
    expect(redactionMode(false, false, null)).toBe("web");
    expect(redactionMode(true, false, null)).toBe("unavailable");
    expect(redactionMode(true, true, false)).toBe("unavailable");
    expect(redactionMode(true, true, null)).toBe("pending");
    expect(redactionMode(true, true, true)).toBe("ready");
  });
});
