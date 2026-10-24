import { describe, expect, it, vi } from "vitest";
import { subscribeEvents } from "../src/events.js";
import type { FetchLike, ResponseLike } from "../src/events.js";
import type { NokkerEvent } from "../src/types.js";

function sseBody(frames: string[], hang: boolean): ResponseLike["body"] {
  return {
    async *[Symbol.asyncIterator]() {
      const encoder = new TextEncoder();
      for (const f of frames) {
        yield encoder.encode(f);
      }
      if (hang) {
        // Simule une connexion SSE qui reste ouverte sans rien envoyer de plus — ne doit jamais
        // résoudre d'elle-même (on la referme depuis le test avec `subscription.close()`).
        await new Promise<void>(() => {});
      }
      // sinon : le générateur se termine, ce qui doit déclencher une reconnexion côté client.
    },
  };
}

describe("subscribeEvents", () => {
  it("retente après une erreur HTTP, puis reconnecte après une coupure de flux (backoff court en test)", async () => {
    let call = 0;
    const events: NokkerEvent[] = [];
    const errors: unknown[] = [];
    let reconnectedCount = 0;

    const fetchImpl: FetchLike = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        // 1er essai : le serveur répond en erreur.
        return { ok: false, status: 500, body: null };
      }
      if (call === 2) {
        // 2e essai : connecte, livre un événement, puis le flux se termine (coupure réseau).
        return {
          ok: true,
          status: 200,
          body: sseBody(['event: turn.started\ndata: {"type":"turn.started","threadId":"t1","turnIndex":0,"channel":"cli"}\n\n'], false),
        };
      }
      // 3e essai et suivants : reconnecte, livre un 2e événement, puis reste ouvert (on referme nous-mêmes).
      return {
        ok: true,
        status: 200,
        body: sseBody(['event: tool.call\ndata: {"type":"tool.call","threadId":"t1","name":"x","arguments":{},"effect":"READ"}\n\n'], true),
      };
    });

    const sub = subscribeEvents({
      baseUrl: "http://mock",
      token: "tok",
      fetchImpl,
      backoff: { initialMs: 5, maxMs: 20, factor: 1.5 },
      onEvent: (e) => events.push(e),
      onError: (e) => errors.push(e),
      onReconnected: () => {
        reconnectedCount += 1;
      },
    });

    // Attend que les 3 appels aient eu lieu et que les 2 événements soient arrivés.
    const deadline = Date.now() + 2000;
    while ((events.length < 2 || call < 3) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    sub.close();

    expect(call).toBeGreaterThanOrEqual(3);
    expect(errors.length).toBeGreaterThanOrEqual(1); // l'échec HTTP du 1er essai a été signalé
    expect(events.map((e) => e.type)).toEqual(["turn.started", "tool.call"]);
    // onReconnected ne doit se déclencher qu'APRÈS une première connexion réussie (pas au 1er connect).
    expect(reconnectedCount).toBe(1);
  });

  it("close() arrête la boucle de reconnexion (plus aucun appel après)", async () => {
    let call = 0;
    const fetchImpl: FetchLike = vi.fn(async () => {
      call += 1;
      return { ok: false, status: 503, body: null };
    });
    const sub = subscribeEvents({
      baseUrl: "http://mock",
      token: "tok",
      fetchImpl,
      backoff: { initialMs: 5, maxMs: 10, factor: 1 },
      onEvent: () => {},
    });
    await new Promise((r) => setTimeout(r, 40));
    sub.close();
    const callsAtClose = call;
    await new Promise((r) => setTimeout(r, 60));
    expect(call).toBe(callsAtClose);
  });
});
