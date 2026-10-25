import { describe, expect, it } from "vitest";
import { NokkerApiError, type NokkerClient } from "@nokker-apps/sdk";
import { pagesPublic, publishError, versionsLine } from "../src/publish/PublishPanel.js";

describe("publication d'une page (§7.26)", () => {
  it("version publiée et version en cours", () => {
    expect(versionsLine({ version: 3, public_version: 3 })).toBe("version 3 publiée");
    expect(versionsLine({ version: 4, public_version: 3 })).toBe("version 3 publiée, version 4 en cours");
    expect(versionsLine({ version: 1, public_version: null })).toBe("");
  });

  it("les refus du noyau en clair", () => {
    expect(publishError(new NokkerApiError("x", 409, { error: { code: "local_page", message: "m" } }))).toMatchObject({ code: "local_page", text: expect.stringMatching(/épinglée/) });
    expect(publishError(new NokkerApiError("x", 409, { error: { code: "not_linked", message: "m" } })).text).toMatch(/lie d'abord/);
    expect(publishError(new NokkerApiError("x", 403, { error: { code: "pages_public_not_allowed", message: "m" } })).text).toMatch(/abonnés/);
    expect(publishError(new NokkerApiError("x", 400, { error: { message: "index : booléen" } }))).toEqual({ code: null, text: "index : booléen" });
  });

  it("droit de publier : lu dans le statut du lien, une fois par client ; inconnu si illisible", async () => {
    let calls = 0;
    const mk = (r: () => Promise<unknown>) => ({ getLocalLinkStatus: () => (calls++, r()) }) as unknown as NokkerClient;
    const yes = mk(async () => ({ state: "approved", pages_public: true }));
    expect(await pagesPublic(yes)).toBe(true);
    expect(await pagesPublic(yes)).toBe(true);
    expect(calls).toBe(1);
    expect(await pagesPublic(mk(async () => ({ state: "approved" })))).toBeNull(); // noyau plus ancien : on essaie
    expect(await pagesPublic(mk(async () => ({ state: "unlinked" })))).toBe(false); // pas de passerelle : pas de publication
    expect(await pagesPublic(mk(async () => Promise.reject(new Error("401"))))).toBeNull();
  });
});
