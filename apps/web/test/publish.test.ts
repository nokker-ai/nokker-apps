import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, type NokkerClient } from "@nokker-apps/sdk";
import { pagesPublic, publishError, versionsLine } from "../src/publish/PublishPanel.js";
import { setShellLang } from "../src/i18n/index.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModerationNotice, moderationDate } from "../src/publish/ModerationNotice.js";

afterEach(() => setShellLang(null));

describe("publication d'une page (§7.26)", () => {
  it("version publiée et version en cours", () => {
    expect(versionsLine({ version: 3, public_version: 3 })).toBe("version 3 published");
    expect(versionsLine({ version: 4, public_version: 3 })).toBe("version 3 published, version 4 in progress");
    expect(versionsLine({ version: 1, public_version: null })).toBe("");
  });

  it("les refus du noyau en clair", () => {
    expect(publishError(new NokkerApiError("x", 409, { error: { code: "local_page", message: "m" } }))).toMatchObject({ code: "local_page", text: expect.stringMatching(/pinned/) });
    expect(publishError(new NokkerApiError("x", 409, { error: { code: "not_linked", message: "m" } })).text).toMatch(/first link this machine/);
    expect(publishError(new NokkerApiError("x", 403, { error: { code: "pages_public_not_allowed", message: "m" } })).text).toMatch(/subscribers/);
    expect(publishError(new NokkerApiError("x", 400, { error: { message: "index : booléen" } }))).toEqual({ code: null, text: "index : booléen" });
  });

  it("en français", () => {
    setShellLang("fr");
    expect(versionsLine({ version: 4, public_version: 3 })).toBe("version 3 publiée, version 4 en cours");
    expect(publishError(new NokkerApiError("x", 409, { error: { code: "local_page", message: "m" } })).text).toMatch(/épinglée/);
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

  it("page retirée par la modération : date, motif, recours de nokker.ai, identifiant à citer ; FR et EN", () => {
    const appeal = { fr: "Pour contester ce retrait, répondez à moderation@nokker.ai en citant l'identifiant de la page.", en: "To contest this removal, reply to moderation@nokker.ai quoting the page identifier." };
    const at = Date.UTC(2026, 9, 26, 12) / 1000;
    const s = { page_id: "pg_0123456789abcdef", moderated_at: at, moderation: { at, reason: "contenu trompeur", appeal } };
    expect(moderationDate(at, "fr")).toBe("26 octobre 2026");
    expect(moderationDate(at, "en")).toBe("26 October 2026");
    const en = renderToStaticMarkup(createElement(ModerationNotice, { s }));
    expect(en).toContain("Removed by nokker.ai moderation on 26 October 2026.");
    expect(en).toContain("Reason: contenu trompeur");
    expect(en).toContain(appeal.en);
    expect(en).toContain("pg_0123456789abcdef");
    setShellLang("fr");
    const fr = renderToStaticMarkup(createElement(ModerationNotice, { s }));
    expect(fr).toContain("Retirée par la modération de nokker.ai le 26 octobre 2026.");
    expect(fr).toContain("Motif : contenu trompeur");
    expect(fr).toContain("moderation@nokker.ai");
    // Sans motif encore communiqué : on le dit, le recours reste là.
    const bare = renderToStaticMarkup(createElement(ModerationNotice, { s: { page_id: "pg_x", moderated_at: at } }));
    expect(bare).toContain("Le motif n");
    expect(bare).toContain("moderation@nokker.ai");
    expect(publishError(new NokkerApiError("x", 403, { error: { code: "page_moderated", message: "m" } })).text).toMatch(/modération de nokker.ai/);
  });
});
