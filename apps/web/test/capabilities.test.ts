import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, type Capabilities, type NokkerClient } from "@nokker-apps/sdk";
import { capability, known, loadCapabilities, off, setCapabilities } from "../src/capabilities.js";

const caps = (features: Record<string, boolean>): Capabilities => ({ version: 1, mode: "cloud", features });
afterEach(() => setCapabilities(null));

describe("capacités du noyau", () => {
  it("noyau d'avant (404) : rien de connu, chaque écran sonde", async () => {
    const client = { getCapabilities: () => Promise.reject(new NokkerApiError("not found", 404, null)) } as unknown as NokkerClient;
    expect(await loadCapabilities(client)).toBeNull();
    expect(known()).toBe(false);
    expect(capability("house")).toBeNull();
    expect(off("house")).toBe(false);
  });
  it("lues : vrai, faux, et une clé absente vaut faux", async () => {
    const client = { getCapabilities: () => Promise.resolve(caps({ speech: true, house: false })) } as unknown as NokkerClient;
    await loadCapabilities(client);
    expect(known()).toBe(true);
    expect(capability("speech")).toBe(true);
    expect(off("house")).toBe(true);
    expect(off("local_cost")).toBe(true);
    expect(off("speech")).toBe(false);
  });
  it("Lokkal : le web suit la capacité, sans règle propre au mode (r37 : pay vrai avec le service de paiement)", () => {
    setCapabilities({ version: 1, mode: "lokkal", features: { local: true, local_cost: true, pay: false, pay_agent: false } });
    expect(off("pay")).toBe(true);
    expect(off("pay_agent")).toBe(true);
    setCapabilities({ version: 1, mode: "lokkal", features: { local: true, pay: true, pay_agent: false } });
    expect(off("pay")).toBe(false);
    expect(off("pay_agent")).toBe(true);
  });
});
