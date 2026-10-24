import { describe, expect, it, vi } from "vitest";
import { NokkerApiError, NokkerClient, applyChatChunk } from "../src/client.js";
import type { FetchLike, ResponseLike } from "../src/events.js";
import type { ChatCompletionChunk } from "../src/types.js";

/** Corps SSE découpé en morceaux arbitraires (coupures au milieu d'une trame, comme le réseau). */
function body(raw: string, piece = 11): ResponseLike["body"] {
  return {
    async *[Symbol.asyncIterator]() {
      const bytes = new TextEncoder().encode(raw);
      for (let i = 0; i < bytes.length; i += piece) yield bytes.slice(i, i + piece);
    },
  };
}

const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "nokker", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;

/** Flux tel que l'émet le noyau avec l'opt-in : pings, deltas, reset (appel fini en outils), deltas, final. */
const NOYAU_STREAM =
  ": ping\n\n" +
  chunk({ role: "assistant" }) +
  ": ping\n\n" +
  chunk({ content: "Je regarde " }) +
  chunk({ content: "l'agenda… " }) +
  chunk({}, { nokker: { reset: true } }) +
  ": ping\n\n" +
  chunk({ content: "Rien aujourd'hui, " }) +
  chunk({ content: "Rien aujourd'hui, journée libre." }, { nokker: { reset: true, final: true }, usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }) +
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "nokker", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
  "data: [DONE]\n\n";

function client(raw: string, seen: { headers?: Record<string, string> } = {}): NokkerClient {
  const fetchImpl: FetchLike = vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
    seen.headers = init?.headers;
    return { ok: true, status: 200, body: body(raw) };
  }) as unknown as FetchLike;
  return new NokkerClient({ baseUrl: "http://mock", token: "tok", fetchImpl });
}

describe("streamChatCompletion — jetons en direct", () => {
  it("pose X-Nokker-Stream-Tokens: 1, ignore les `: ping`, applique reset puis la réponse finale", async () => {
    const seen: { headers?: Record<string, string> } = {};
    const c = client(NOYAU_STREAM, seen);
    const texts: string[] = [];
    const chunks: ChatCompletionChunk[] = [];
    let text = "";
    await c.streamChatCompletion("th_1", [{ role: "user", content: "agenda ?" }], (ch) => {
      chunks.push(ch);
      text = applyChatChunk(text, ch);
      texts.push(text);
    });
    expect(seen.headers?.["X-Nokker-Stream-Tokens"]).toBe("1");
    expect(seen.headers?.["X-Session-Id"]).toBe("th_1");
    expect(chunks).toHaveLength(7); // aucun ping remonté comme chunk
    expect(texts).toEqual([
      "",
      "Je regarde ",
      "Je regarde l'agenda… ",
      "", // reset : texte de l'appel en outils retiré
      "Rien aujourd'hui, ",
      "Rien aujourd'hui, journée libre.", // final : remplace, ne s'ajoute pas
      "Rien aujourd'hui, journée libre.",
    ]);
  });

  it("liveTokens: false n'envoie pas l'en-tête", async () => {
    const seen: { headers?: Record<string, string> } = {};
    await client(chunk({ content: "x" }) + "data: [DONE]\n\n", seen).streamChatCompletion("th_1", [], () => {}, "nokker", { liveTokens: false });
    expect(seen.headers?.["X-Nokker-Stream-Tokens"]).toBeUndefined();
  });

  it("un flux fait uniquement de pings puis de la réponse (sans opt-in côté serveur) se lit comme avant", async () => {
    let text = "";
    const raw = ": ping\n\n: ping\n\n" + chunk({ role: "assistant" }) + chunk({ content: "Bonjour." }) + "data: [DONE]\n\n";
    await client(raw).streamChatCompletion("th_1", [], (ch) => {
      text = applyChatChunk(text, ch);
    });
    expect(text).toBe("Bonjour.");
  });

  it("une erreur du tour dans le flux lève NokkerApiError", async () => {
    const raw = ": ping\n\n" + `data: ${JSON.stringify({ error: { message: "panne interne" } })}\n\n`;
    await expect(client(raw).streamChatCompletion("th_1", [], () => {})).rejects.toBeInstanceOf(NokkerApiError);
    await expect(client(raw).streamChatCompletion("th_1", [], () => {})).rejects.toThrow("panne interne");
  });
});
