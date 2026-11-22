import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NokkerClient, acceptLanguageOf } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
beforeAll(async () => {
  mock = await startMockServer({ port: 0, seed: false, speed: 0.01 });
});
afterAll(async () => {
  await mock.close();
});

describe("X-Nokker-Surface sur les appels de chat", () => {
  it("chaque surface pose sa valeur fixe (flux et non-flux) ; sans surface, l'en-tête est omis", async () => {
    mock.state.chatSurfaces.length = 0;
    for (const surface of ["web", "pwa", "cli", "vscode", "acp"] as const) {
      const c = new NokkerClient({ baseUrl: mock.url, token: mock.localToken!, surface });
      await c.streamChatCompletion(`th_s_${surface}`, [{ role: "user", content: "bonjour" }], () => undefined);
      await c.chatCompletion(`th_n_${surface}`, [{ role: "user", content: "bonjour" }]);
    }
    expect(mock.state.chatSurfaces).toEqual(["web", "web", "pwa", "pwa", "cli", "cli", "vscode", "vscode", "acp", "acp"]);
    mock.state.chatSurfaces.length = 0;
    const none = new NokkerClient({ baseUrl: mock.url, token: mock.localToken! });
    await none.streamChatCompletion("th_s_none", [{ role: "user", content: "bonjour" }], () => undefined);
    expect(mock.state.chatSurfaces).toEqual([null]); // rien ne casse : le noyau omet simplement la ligne « Canal »
  });
  it("Accept-Language : la langue de la personne (en_US.UTF-8 → en), relue à chaque appel ; sans langue, celle du runtime", async () => {
    mock.state.chatLanguages.length = 0;
    let l = "en_US.UTF-8";
    const c = new NokkerClient({ baseUrl: mock.url, token: mock.localToken!, language: () => l });
    await c.streamChatCompletion("th_l1", [{ role: "user", content: "hello" }], () => undefined);
    l = "fr-CH";
    await c.chatCompletion("th_l2", [{ role: "user", content: "bonjour" }]);
    l = "C"; // C / POSIX : anglais
    await c.streamChatCompletion("th_l3", [{ role: "user", content: "hi" }], () => undefined);
    expect(mock.state.chatLanguages).toEqual(["en", "fr", "en"]);
    expect(acceptLanguageOf("de_DE.UTF-8@euro")).toBe("de");
    expect(acceptLanguageOf("n'importe quoi !")).toBe("en");
    mock.state.chatLanguages.length = 0;
    const none = new NokkerClient({ baseUrl: mock.url, token: mock.localToken! });
    await none.streamChatCompletion("th_l4", [{ role: "user", content: "hello" }], () => undefined);
    expect(["*", null]).toContain(mock.state.chatLanguages[0]); // sans réglage : celui du runtime (« * » sous Node), pas une langue
  });
  it("l'en-tête est autorisé par le pré-vol CORS (le web parle à d'autres origines)", async () => {
    const r = await fetch(`${mock.url}/v1/chat/completions`, { method: "OPTIONS", headers: { Origin: "https://app.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-nokker-surface" } });
    expect(r.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-nokker-surface");
  });
});
