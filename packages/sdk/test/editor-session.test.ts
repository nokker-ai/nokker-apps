import { describe, expect, it } from "vitest";
import { NokkerClient } from "../src/client.js";
import { EDITOR_TEXTS_FR, EditorSession, LocalEventHub, rootThreadOf, suffixAfter } from "../src/editor-session.js";
import type { FetchLike, ResponseLike } from "../src/events.js";

function sse(frames: string[], hold = false): ResponseLike {
  const enc = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: {
      async *[Symbol.asyncIterator]() {
        for (const f of frames) yield enc.encode(f);
        if (hold) await new Promise(() => {});
      },
    },
  };
}
const chunk = (content: string, nokker?: Record<string, boolean>): string =>
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content }, finish_reason: null }], ...(nokker ? { nokker } : {}) })}\n\n`;

describe("EditorSession : texte rendu en ajouts seulement", () => {
  it("reset = nouveau paragraphe ; le chunk final ne complète que ce qui manque", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith("/v1/events")) return sse([": ping\n\n"], true);
      return sse([chunk("Je lis le fichier."), chunk("", { reset: true }), chunk("Voilà"), chunk("Voilà la réponse.", { reset: true, final: true }), "data: [DONE]\n\n"]);
    };
    const client = new NokkerClient({ baseUrl: "http://127.0.0.1:1", token: "t", fetchImpl });
    const hub = new LocalEventHub(client);
    const s = new EditorSession(client, hub, "th_1", "/w", { read: async () => null });
    s.attach();
    const parts: string[] = [];
    const out = await s.prompt("bonjour", { onText: (t) => parts.push(t) });
    expect(parts.join("")).toBe("Je lis le fichier.\n\nVoilà la réponse.");
    expect(out.reply).toBe("Voilà la réponse.");
    expect(out.stopReason).toBe("end_turn");
    s.dispose();
    hub.close();
  }, 10_000);

  it("sans jetons en direct : le chunk final seul donne tout le texte", async () => {
    const fetchImpl: FetchLike = async (url) =>
      url.endsWith("/v1/events") ? sse([], true) : sse([chunk("Réponse complète.", { reset: true, final: true }), "data: [DONE]\n\n"]);
    const client = new NokkerClient({ baseUrl: "http://127.0.0.1:1", token: "t", fetchImpl });
    const hub = new LocalEventHub(client);
    const s = new EditorSession(client, hub, "th_2", "/w", { read: async () => null });
    const parts: string[] = [];
    await s.prompt("x", { onText: (t) => parts.push(t) });
    expect(parts).toEqual(["Réponse complète."]);
    hub.close();
  }, 10_000);

  it("fil de sous-agent rattaché à son fil racine", () => {
    expect(rootThreadOf("th_a/sa-1")).toBe("th_a");
    expect(rootThreadOf("th_a")).toBe("th_a");
  });
});


describe("suffixAfter : le chunk final complète le texte affiché aux blancs près", () => {
  it("cas usuels", () => {
    expect(suffixAfter("Bonjour le monde.", "Bonjour le ")).toBe("monde.");
    expect(suffixAfter("Bonjour le monde.", "Bonjour")).toBe(" le monde.");
    expect(suffixAfter("J'ai corrigé le test.", "J'ai corrigé le test. ")).toBe("");
    expect(suffixAfter("a\n\nb", "a b")).toBe("");
    expect(suffixAfter("Autre réponse", "Je lis")).toBeNull();
    expect(suffixAfter("x", "")).toBe("x");
  });
});

describe("EditorSession : carte forte, où elle attend (LOKKAL.md §7.3)", () => {
  const strong = (forwarded: boolean) => ({
    id: "ap_1", thread_id: "th_s", turn_index: 0, channel: "local", tool_name: "terminal", arguments: { command: "rm -rf build" },
    args_sha256: "x", effect: "destructive", rule: "effect:destructive", reason: "supprime build/", advice: null, strength: "strong",
    status: "pending", created_at: "", expires_at: "", decided_by: null, decided_via: null, decided_at: null,
    result_summary: null, error: null, suggested_rules: [], forwarded,
  });
  const ev = (type: string, data: unknown): string => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

  async function run(listed: boolean, then: string[]): Promise<Array<{ forwarded: boolean; choices: unknown }>> {
    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith("/v1/events")) return sse([ev("approval.requested", { approval: { ...strong(false), forwarded: undefined } }), ...then], true);
      return sse([JSON.stringify({ approvals: [strong(listed)] })]);
    };
    const client = new NokkerClient({ baseUrl: "http://127.0.0.1:1", token: "t", fetchImpl });
    const hub = new LocalEventHub(client);
    const s = new EditorSession(client, hub, "th_s", "/w", { read: async () => null });
    const seen: Array<{ forwarded: boolean; choices: unknown }> = [];
    s.setSink({ onApproval: (c) => seen.push({ forwarded: c.forwarded, choices: c.choices }), onApprovalUpdate: (c) => seen.push({ forwarded: c.forwarded, choices: c.choices }) });
    s.attach();
    await hub.ready();
    const t0 = Date.now();
    while (Date.now() - t0 < 2000 && seen.length < (then.length ? 2 : 1)) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    s.dispose();
    hub.close();
    return seen;
  }

  it("machine non liée : la carte reste « au terminal »", async () => {
    expect(await run(false, [])).toEqual([{ forwarded: false, choices: null }]);
  }, 10_000);

  it("déposée chez nokker.ai après coup : approval.forwarded met la carte à jour, une fois", async () => {
    const fwd = ev("approval.forwarded", { approval_id: "ap_1", thread_id: "th_s" });
    expect(await run(false, [fwd, fwd])).toEqual([{ forwarded: false, choices: null }, { forwarded: true, choices: null }]);
  }, 10_000);

  it("déjà déposée à la lecture : « téléphone » d'emblée", async () => {
    expect(await run(true, [])).toEqual([{ forwarded: true, choices: null }]);
  }, 10_000);
});

describe("LocalEventHub.listenAll et textes de l'éditeur", () => {
  const frame = (id: number, data: Record<string, unknown>): string => `id: ${id}\nevent: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`;

  it("listenAll reçoit les événements de tous les fils ; listen seulement les siens", async () => {
    const fetchImpl: FetchLike = async () =>
      sse(
        [
          frame(1, { type: "turn.started", thread_id: "th_a", turn_id: "th_a:0" }),
          frame(2, { type: "turn.started", thread_id: "th_b", turn_id: "th_b:0" }),
          frame(3, { type: "approval.decided", approval_id: "ap_1", decision: "approved", by: "x", via: "local" }),
        ],
        true,
      );
    const client = new NokkerClient({ baseUrl: "http://127.0.0.1:1", token: "t", fetchImpl });
    const hub = new LocalEventHub(client);
    const all: string[] = [];
    const mine: string[] = [];
    const off = hub.listenAll((e) => all.push(`${e.type}:${(e as { thread_id?: string }).thread_id ?? "-"}`));
    hub.listen("th_a", (e) => mine.push(e.type));
    await hub.ready();
    for (let i = 0; i < 100 && all.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    expect(all).toEqual(["turn.started:th_a", "turn.started:th_b", "approval.decided:-"]);
    expect(mine).toEqual(["turn.started", "approval.decided"]);
    off();
    hub.close();
  });

  it("les notices de la session passent par les textes fournis (défaut : français)", async () => {
    const fetchImpl: FetchLike = async (url) =>
      url.endsWith("/v1/events")
        ? sse([frame(1, { type: "subagent.started", thread_id: "th_c", parent_turn: "th_c:0", child_id: "sa-1", goal: "lire" })], true)
        : sse([chunk("ok", { reset: true, final: true }), "data: [DONE]\n\n"]);
    const client = new NokkerClient({ baseUrl: "http://127.0.0.1:1", token: "t", fetchImpl });
    const hub = new LocalEventHub(client);
    const texts = { ...EDITOR_TEXTS_FR, subagentStarted: (g: string) => `Sub-agent started: ${g}` };
    const s = new EditorSession(client, hub, "th_c", "/w", { read: async () => null }, texts);
    const notices: string[] = [];
    s.setSink({ onNotice: (t) => notices.push(t) });
    s.attach();
    await hub.ready();
    for (let i = 0; i < 100 && !notices.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(notices).toEqual(["Sub-agent started: lire"]);
    expect(EDITOR_TEXTS_FR.subagentFinished("ok", 2)).toBe("Sous-agent terminé (ok) : 2 commit(s)");
    s.dispose();
    hub.close();
  });
});
