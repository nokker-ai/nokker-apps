import { describe, expect, it } from "vitest";
import {
  NokkerApiError,
  NokkerClient,
  applyBubbleEvent,
  parseTurnId,
  renderBubbleForContext,
  type Bubble,
  type FetchLike,
  type RequestInitLike,
} from "../src/index.js";

function bubble(over: Partial<Bubble> = {}): Bubble {
  return {
    id: "bu_000000000001",
    thread_id: "th_aaaaaaaaaaaa",
    kind: "monitor",
    title: "Disque host-1",
    status: "working",
    state: { target: "host-1:/", metric: "disk_used", value: 91, unit: "%", max: 100 },
    actions: [],
    origin: null,
    shared_with: { members: [], threads: [] },
    created_by: "nina",
    created_at: "2026-10-18T20:00:00Z",
    updated_at: "2026-10-18T20:00:00Z",
    closed_at: null,
    version: 1,
    ...over,
  } as Bubble;
}

function fakeFetch(reply: (url: string, init: RequestInitLike) => { status?: number; json: unknown }) {
  const calls: { url: string; init: RequestInitLike }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, json } = reply(url, init);
    const bytes = new TextEncoder().encode(JSON.stringify(json));
    return {
      ok: status < 400,
      status,
      body: {
        async *[Symbol.asyncIterator]() {
          yield bytes;
        },
      },
    };
  };
  return { impl, calls };
}

describe("client bulles — routes et corps du contrat BUBBLES.md", () => {
  it("transferBubble poste {to_thread, mode} sur /v1/bubbles/{id}/transfer", async () => {
    const { impl, calls } = fakeFetch(() => ({
      json: { bubble_id: "bu_1", new_bubble_id: "bu_2", from_thread: "th_a", to_thread: "th_b", mode: "copy", bubble: bubble({ id: "bu_2" }) },
    }));
    const c = new NokkerClient({ baseUrl: "http://x/", token: "t", fetchImpl: impl });
    const res = await c.transferBubble("bu_1", "th_b", "copy");
    expect(calls[0]!.url).toBe("http://x/v1/bubbles/bu_1/transfer");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ to_thread: "th_b", mode: "copy" });
    expect(calls[0]!.init.headers!.Authorization).toBe("Bearer t");
    expect(res.bubble.id).toBe("bu_2");
    expect(res.new_bubble_id).toBe("bu_2");
  });

  it("shareBubble, patchBubble (if_version), closeBubble, bubbleAction, listBubbles, getPreview", async () => {
    const { impl, calls } = fakeFetch(() => ({ json: bubble() }));
    const c = new NokkerClient({ baseUrl: "http://x", token: "t", fetchImpl: impl });
    await c.shareBubble("bu_1", { members: ["bob"], threads: ["th_c"] });
    await c.patchBubble("bu_1", { status: "done", if_version: 3 });
    await c.closeBubble("bu_1");
    await c.bubbleAction("bu_1", "activate");
    await c.listBubbles("th_a", { includeClosed: true });
    await c.getPreview("https://example.org/a?b=c");
    await c.sendSessionMessage("th_b", { from_thread: "th_a", text: "salut", ask: true });
    expect(calls.map((x) => `${x.init.method ?? "GET"} ${x.url.replace("http://x", "")}`)).toEqual([
      "POST /v1/bubbles/bu_1/share",
      "PATCH /v1/bubbles/bu_1",
      "POST /v1/bubbles/bu_1/close",
      "POST /v1/bubbles/bu_1/actions/activate",
      "GET /v1/threads/th_a/bubbles?include_closed=1",
      "GET /v1/previews?url=https%3A%2F%2Fexample.org%2Fa%3Fb%3Dc",
      "POST /v1/threads/th_b/messages",
    ]);
    expect(JSON.parse(calls[1]!.init.body!)).toEqual({ status: "done", if_version: 3 });
    expect(JSON.parse(calls[6]!.init.body!)).toEqual({ from_thread: "th_a", text: "salut", ask: true });
  });

  it("un 409 de version remonte en NokkerApiError.status avec current_version", async () => {
    const { impl } = fakeFetch(() => ({ status: 409, json: { error: { message: "version", current_version: 7 } } }));
    const c = new NokkerClient({ baseUrl: "http://x", token: "t", fetchImpl: impl });
    await expect(c.patchBubble("bu_1", { if_version: 1 })).rejects.toMatchObject({ status: 409 });
    const err = await c.patchBubble("bu_1", { if_version: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NokkerApiError);
    expect((err as NokkerApiError).currentVersion).toBe(7);
    expect((err as NokkerApiError).serverMessage).toBe("version");
  });

  it("resolveUrl préfixe les chemins relatifs du noyau", () => {
    const c = new NokkerClient({ baseUrl: "http://x/", fetchImpl: fakeFetch(() => ({ json: {} })).impl });
    expect(c.resolveUrl("/v1/previews/img/abc")).toBe("http://x/v1/previews/img/abc");
    expect(c.resolveUrl(null)).toBeNull();
  });
});

describe("subscribeEvents — forme SSE du noyau", () => {
  it("prend le type dans la ligne event: et repose Last-Event-ID à la reconnexion", async () => {
    const seen: string[] = [];
    const headers: Record<string, string>[] = [];
    let n = 0;
    const impl: FetchLike = async (_url, init) => {
      headers.push({ ...(init.headers ?? {}) });
      n += 1;
      const text =
        n === 1
          ? 'id: 41\nevent: bubble.closed\ndata: {"bubble_id":"bu_1","thread_id":"th_a"}\n\nid: 42\nevent: turn.delta\ndata: {"thread_id":"th_a","turn_id":"th_a:3","text":"ok"}\n\n'
          : "";
      const bytes = new TextEncoder().encode(text);
      return {
        ok: n <= 2,
        status: n <= 2 ? 200 : 503,
        body: {
          async *[Symbol.asyncIterator]() {
            yield bytes;
          },
        },
      };
    };
    const c = new NokkerClient({ baseUrl: "http://x", token: "t", fetchImpl: impl });
    const sub = c.subscribeEvents({ onEvent: (e) => seen.push(e.type) });
    await new Promise((r) => setTimeout(r, 1200));
    sub.close();
    expect(seen).toEqual(["bubble.closed", "turn.delta"]);
    expect(headers[0]!["Last-Event-ID"]).toBeUndefined();
    expect(headers[1]!["Last-Event-ID"]).toBe("42");
  });

  it("parseTurnId découpe <fil>:<index>", () => {
    expect(parseTurnId("th_abc:12")).toEqual({ thread_id: "th_abc", index: 12 });
    expect(parseTurnId("x")).toBeNull();
  });
});

describe("applyBubbleEvent", () => {
  const cur = "th_aaaaaaaaaaaa";
  it("ajoute, remplace, retire", () => {
    let list: Bubble[] = [];
    list = applyBubbleEvent(list, { type: "bubble.created", bubble: bubble() }, cur);
    expect(list).toHaveLength(1);
    list = applyBubbleEvent(list, { type: "bubble.updated", bubble: bubble({ status: "done", version: 2 }) }, cur);
    expect(list[0]!.status).toBe("done");
    list = applyBubbleEvent(list, { type: "bubble.closed", bubble_id: "bu_000000000001", thread_id: cur }, cur);
    expect(list).toHaveLength(0);
  });
  it("un move vers un autre fil la fait disparaître du fil courant", () => {
    const list = [bubble()];
    const out = applyBubbleEvent(list, { type: "bubble.updated", bubble: bubble({ thread_id: "th_other" }) }, cur);
    expect(out).toHaveLength(0);
  });
  it("garde les notify sans fil et les bulles partagées avec le fil courant", () => {
    let list: Bubble[] = [];
    list = applyBubbleEvent(list, { type: "bubble.created", bubble: bubble({ id: "bu_n", thread_id: null }) }, cur);
    list = applyBubbleEvent(
      list,
      { type: "bubble.created", bubble: bubble({ id: "bu_s", thread_id: "th_x", shared_with: { members: [], threads: [cur] } }) },
      cur,
    );
    list = applyBubbleEvent(list, { type: "bubble.created", bubble: bubble({ id: "bu_z", thread_id: "th_x" }) }, cur);
    expect(list.map((b) => b.id)).toEqual(["bu_n", "bu_s"]);
  });
  it("les cartes d'un sous-agent (`<fil>/sa-<id>`) se montrent dans le fil racine, pas dans un autre", () => {
    let list: Bubble[] = [];
    list = applyBubbleEvent(list, { type: "bubble.created", bubble: bubble({ id: "bu_k", thread_id: `${cur}/sa-sa1` }) }, cur);
    list = applyBubbleEvent(list, { type: "bubble.created", bubble: bubble({ id: "bu_o", thread_id: "th_other/sa-sa1" }) }, cur);
    list = applyBubbleEvent(list, { type: "bubble.created", bubble: bubble({ id: "bu_p", thread_id: `${cur}x/sa-1` }) }, cur);
    expect(list.map((b) => b.id)).toEqual(["bu_k"]);
  });
});

describe("renderBubbleForContext", () => {
  it("suit le gabarit §3 et borne le résumé à 600 caractères", () => {
    const b = bubble({
      kind: "search",
      title: "Libérer de l'espace",
      state: {
        query: "x".repeat(2000),
        took_ms: 120,
        engines: ["démo"],
        results: [],
      },
    } as Partial<Bubble>);
    const out = renderBubbleForContext(b, "Infra");
    expect(out.startsWith("[Bulle reçue de « Infra » — search « Libérer de l'espace »] ")).toBe(true);
    const summary = out.slice(out.indexOf("] ") + 2);
    expect(summary.length).toBeLessThanOrEqual(600);
  });
});
