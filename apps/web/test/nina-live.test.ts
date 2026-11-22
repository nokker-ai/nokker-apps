import { describe, expect, it } from "vitest";
import { captionText } from "../src/avatar/NinaLive.js";

describe("Nina en direct", () => {
  it("retire les balises d'expression des sous-titres", () => {
    expect(captionText("[cheerfully] Bonjour !  Aujourd'hui… [seriously] le gâteau.")).toBe("Bonjour ! Aujourd'hui… le gâteau.");
    expect(captionText("Rien à retirer [1] ici")).toBe("Rien à retirer [1] ici");
  });
});

describe("fin de session à la fermeture de la page", () => {
  it("endSession passe keepalive au client (l'appel survit à la fermeture de l'onglet) et n'échoue jamais", async () => {
    const { endSession } = await import("../src/avatar/NinaLive.js");
    const calls: unknown[][] = [];
    const ok = { endNinaLive: async (...a: unknown[]) => void calls.push(a) } as never;
    await endSession({ client: ok, session: { session_id: "nl_1" } as never });
    expect(calls).toEqual([["nl_1", { keepalive: true }]]);
    const ko = { endNinaLive: async () => { throw new Error("coupé"); } } as never;
    await expect(endSession({ client: ko, session: { session_id: "nl_2" } as never })).resolves.toBeUndefined();
  });
  it("le client SDK envoie keepalive:true à fetch", async () => {
    const { NokkerClient } = await import("@nokker-apps/sdk");
    let seen: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init: Record<string, unknown>) => { seen = init; return { ok: true, status: 200, text: async () => "{}", headers: { get: () => null } }; }) as never;
    const c = new NokkerClient({ baseUrl: "http://x", token: "t", fetchImpl });
    await c.endNinaLive("nl_1", { keepalive: true });
    expect(seen.keepalive).toBe(true);
    await c.endNinaLive("nl_1");
    expect(seen.keepalive).toBeUndefined();
  });
});
