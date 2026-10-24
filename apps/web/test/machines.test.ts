import { describe, expect, it } from "vitest";
import { gatewayHref, seenLabel } from "../src/machines/model.js";

describe("mes machines : libellés", () => {
  const now = 1_800_000_000;
  it("dernier contact", () => {
    expect(seenLabel(null, now)).toMatchObject({ key: "mcSeenNever", online: false });
    expect(seenLabel(now - 10, now)).toMatchObject({ key: "mcOnline", online: true });
    expect(seenLabel(now + 5, now)).toMatchObject({ key: "mcOnline" });
    expect(seenLabel(now - 600, now)).toEqual({ key: "mcSeenMin", vars: { n: "10" }, online: false });
    expect(seenLabel(now - 3 * 3600, now)).toMatchObject({ key: "mcSeenHours", vars: { n: "3" } });
    expect(seenLabel(now - 2 * 86400, now)).toMatchObject({ key: "mcSeenDays", vars: { n: "2" } });
  });
  it("lien de passerelle : seulement un hôte de passerelle", () => {
    expect(gatewayHref("atelier.nokker.app")).toBe("https://atelier.nokker.app");
    expect(gatewayHref("evil.com")).toBeNull();
    expect(gatewayHref("a.nokker.app.evil.com")).toBeNull();
    expect(gatewayHref("javascript:alert(1)")).toBeNull();
  });
});
