import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
afterEach(async () => {
  await mock.close();
});

describe("pièces texte reconnues sur l'appareil (P9)", () => {
  it("OCR et transcription : rangées avec le message, relues par id ; dictée = texte du message ; limites", async () => {
    mock = await startMockServer({ speed: 0.01 });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const t = await c.createThread("Factures");
    let reply = "";
    await c.streamChatCompletion(t.id, [{ role: "user", content: "Résume" }], (ch) => (reply += ch.choices?.[0]?.delta?.content ?? ""), "nokker", {
      attachments: [
        { kind: "text", source: "device_ocr", name: "Texte lu sur facture.png", text: "Total 89.90 CHF" },
        { kind: "text", source: "device_stt", name: "Transcription (0:42)", text: "réunion de lundi", duration_s: 42 },
      ],
    });
    const v = await c.getThread(t.id);
    const u = v.messages.find((m) => m.role === "user")!;
    expect(u.attachments?.map((a) => [a.source, a.name, a.chars])).toEqual([["device_ocr", "Texte lu sur facture.png", 15], ["device_stt", "Transcription (0:42)", 16]]);
    expect((await c.getAttachment(t.id, u.attachments![0]!.id)).text).toBe("Total 89.90 CHF");
    expect(v.messages.find((m) => m.role === "assistant")!.content).toMatch(/Attachment received: Texte lu sur facture\.png \(15 characters\)/);
    // Dictée : le message de la personne, quand le champ est vide.
    await c.streamChatCompletion(t.id, [{ role: "user", content: "" }], () => undefined, "nokker", { attachments: [{ kind: "text", source: "device_dictation", name: "Dictée", text: "rappelle-moi le pain" }] });
    const v2 = await c.getThread(t.id);
    expect(v2.messages.filter((m) => m.role === "user").at(-1)!.content).toBe("rappelle-moi le pain");
    const big = await c.streamChatCompletion(t.id, [{ role: "user", content: "x" }], () => undefined, "nokker", { attachments: [{ kind: "text", source: "device_ocr", name: "n", text: "x".repeat(20_001) }] }).catch((e) => (e as NokkerApiError).status);
    expect(big).toBe(400);
  });
});
