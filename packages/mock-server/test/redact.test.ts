import { afterEach, describe, expect, it } from "vitest";
import { checkVectors, maskText, NokkerClient, REDACT_RULES_SNAPSHOT, type RedactDict } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
afterEach(async () => {
  await mock.close();
});

describe("masquage sur l'appareil (P9b) — faux noyau", () => {
  it("règles publiées avec leurs vecteurs (ETag) ; compteurs gardés ; jamais de valeur", async () => {
    mock = await startMockServer({ speed: 0.01 });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const rules = await c.getRedactRules();
    expect(rules.version).toBe(REDACT_RULES_SNAPSHOT.version);
    expect(checkVectors(rules)).toEqual([]);
    const tok = (c as unknown as { token: string }).token;
    const first = await fetch(`${mock.url}/v1/redact/rules`, { headers: { Authorization: `Bearer ${tok}` } });
    const etag = first.headers.get("etag")!;
    expect((await fetch(`${mock.url}/v1/redact/rules`, { headers: { Authorization: `Bearer ${tok}`, "If-None-Match": etag } })).status).toBe(304);

    const t = await c.createThread("Banque");
    const dict: RedactDict = {};
    const ocr = maskText("Virement IBAN CH93 0076 2011 6238 5295 7, tél. 079 123 45 67", rules, dict);
    Object.assign(dict, ocr.added);
    const typed = maskText("Rappelle le 079 123 45 67", rules, dict);
    await c.streamChatCompletion(t!.id, [{ role: "user", content: typed.text }], () => undefined, "nokker", {
      redaction: typed.meta,
      attachments: [{ kind: "text", source: "device_ocr", name: "Texte lu sur releve.png", text: ocr.text, redaction: ocr.meta }],
    });
    const v = await c.getThread(t!.id);
    const u = v.messages.find((m) => m.role === "user")!;
    expect(u.content).toBe("Rappelle le ⟦PHONE-1⟧");
    expect(u.redaction).toEqual({ rules_version: rules.version, counts: { PHONE: 2, IBAN: 1 } });
    // La réponse recopie les marqueurs reçus, et cite un marqueur de tiers que l'appareil n'a jamais émis.
    const a = v.messages.find((m) => m.role === "assistant")!;
    expect(a.content).toMatch(/Noted ⟦PHONE-1⟧, ⟦IBAN-1⟧\. A page also mentioned ⟦IBAN-9⟧/);
    expect(JSON.stringify(v)).not.toContain("079 123");
    expect(JSON.stringify(v)).not.toContain("CH93");
  });

  it("garde masked_value : un envoi externe dont les arguments portent un marqueur ne pose pas de carte", async () => {
    mock = await startMockServer({ speed: 0.01 });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const t = await c.createThread("Mail");
    await c.streamChatCompletion(t!.id, [{ role: "user", content: "envoie un mail à ⟦EMAIL-1⟧" }], () => undefined, "nokker");
    const v = await c.getThread(t!.id);
    expect(v.messages.at(-1)!.content).toBe(
      "(demo) masked_value : send_email_bulk reçoit une valeur masquée sur l'appareil de la personne (⟦EMAIL-1⟧) ; rien n'a été fait ; si cette valeur est nécessaire, demande-lui de la donner en clair.",
    );
    expect((await c.listApprovals()).filter((x) => x.status === "pending" && x.thread_id === t!.id)).toHaveLength(0);
    // Persistance hors du fil : refusée avec le texte figé à la relecture des textes (vrais noms d'outils du noyau).
    const last = async (text: string) => {
      await c.streamChatCompletion(t!.id, [{ role: "user", content: text }], () => undefined, "nokker");
      return (await c.getThread(t!.id)).messages.at(-1)!.content;
    };
    expect(await last("retiens que mon numéro est ⟦PHONE-1⟧")).toBe(
      "(demo) masked_value : memory_write garderait une valeur masquée sur l'appareil de la personne (⟦PHONE-1⟧) au-delà de ce fil ; rien n'a été enregistré ; si cette valeur doit être retenue, demande-lui de la donner en clair.",
    );
    // Ordre du noyau : un brouillon de mail (WRITE) qui serait aussi un envoi rend le texte de PERSISTANCE.
    expect(await last("envoie un brouillon à ⟦EMAIL-1⟧")).toMatch(/^\(demo\) masked_value : mail_draft garderait/);
    // Saisie dans une page tierce : texte d'ENVOI, avant même la persistance.
    expect(await last("remplis le formulaire de la page avec ⟦IBAN-1⟧ et retiens-le")).toMatch(/^\(demo\) masked_value : browser_fill reçoit une valeur masquée/);
    // todo et delegate restent dans le fil : pas de refus.
    expect(await last("ajoute ⟦IBAN-1⟧ à ma todo")).not.toMatch(/masked_value/);
    // Sans marqueur, la démo d'approbation reste celle d'avant.
    await c.streamChatCompletion(t!.id, [{ role: "user", content: "envoie un mail à l'équipe" }], () => undefined, "nokker");
    expect((await c.listApprovals()).filter((x) => x.status === "pending" && x.thread_id === t!.id)).toHaveLength(1);
  });
});
