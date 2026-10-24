import { describe, expect, it } from "vitest";
import { decodeUtf8Stream, parseJsonData, parseSSEFrames } from "../src/sse.js";

async function* gen(chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c;
}

describe("parseSSEFrames", () => {
  it("parse un frame event+data standard", async () => {
    const frames = [];
    for await (const f of parseSSEFrames(gen(['event: turn.delta\ndata: {"a":1}\n\n']))) frames.push(f);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ event: "turn.delta", data: '{"a":1}', id: undefined });
  });

  it("parse plusieurs frames répartis sur plusieurs chunks réseau (découpe arbitraire)", async () => {
    const full = 'event: tool.call\ndata: {"name":"x"}\n\nevent: tool.result\ndata: {"ok":true}\n\n';
    // Découpe au milieu d'une ligne, comme le ferait un vrai flux TCP.
    const chunks = [full.slice(0, 10), full.slice(10, 25), full.slice(25)];
    const frames = [];
    for await (const f of parseSSEFrames(gen(chunks))) frames.push(f);
    expect(frames).toHaveLength(2);
    expect(frames[0].event).toBe("tool.call");
    expect(frames[1].event).toBe("tool.result");
  });

  it("joint plusieurs lignes data: d'un même frame avec \\n", async () => {
    const frames = [];
    for await (const f of parseSSEFrames(gen(["data: ligne1\ndata: ligne2\n\n"]))) frames.push(f);
    expect(frames[0].data).toBe("ligne1\nligne2");
  });

  it("ignore les lignes de commentaire (keep-alive ': ...')", async () => {
    const frames = [];
    for await (const f of parseSSEFrames(gen([": keep-alive\n\ndata: x\n\n"]))) frames.push(f);
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe("x");
  });

  it("supporte /v1/chat/completions (data: seule, sans event:, terminé par [DONE])", async () => {
    const frames = [];
    for await (const f of parseSSEFrames(
      gen(['data: {"choices":[{"delta":{"content":"a"}}]}\n\n', "data: [DONE]\n\n"]),
    ))
      frames.push(f);
    expect(frames).toHaveLength(2);
    expect(frames[0].event).toBeUndefined();
    expect(parseJsonData(frames[1])).toBeNull();
  });

  it("rend le dernier frame même sans ligne vide finale (tolérance flux coupé)", async () => {
    const frames = [];
    for await (const f of parseSSEFrames(gen(['data: {"x":1}']))) frames.push(f);
    expect(frames).toHaveLength(1);
  });
});

describe("decodeUtf8Stream", () => {
  it("décode un flux d'octets UTF-8 découpé au milieu d'un caractère multi-octets", async () => {
    const text = "café ☕ événement";
    const bytes = new TextEncoder().encode(text);
    async function* byteGen(): AsyncGenerator<Uint8Array> {
      // Coupe exprès au milieu d'un caractère multi-octets pour vérifier le mode `stream: true`.
      yield bytes.slice(0, 5);
      yield bytes.slice(5, 9);
      yield bytes.slice(9);
    }
    let out = "";
    for await (const chunk of decodeUtf8Stream(byteGen())) out += chunk;
    expect(out).toBe(text);
  });
});

describe("parseJsonData", () => {
  it("renvoie null sur un JSON malformé plutôt que de lever", () => {
    expect(parseJsonData({ event: undefined, data: "{not json", id: undefined })).toBeNull();
  });
});
