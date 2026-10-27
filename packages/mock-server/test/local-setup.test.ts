import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient } from "@nokker-apps/sdk";
import { LOCAL_TOKEN, startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let c: NokkerClient;
beforeEach(async () => {
  mock = await startMockServer({ speed: 0.01 });
  c = new NokkerClient({ baseUrl: mock.url, token: LOCAL_TOKEN });
});
afterEach(async () => {
  await mock.close();
});

const setMock = (body: Record<string, unknown>) =>
  fetch(`${mock.url}/v1/dev/local-mock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("Lokkal — GET /v1/local/setup", () => {
  it("premier lancement : pas fait, Router non lié, Ollama détecté, aucun défaut, connecteurs vides comme le noyau", async () => {
    const s = await c.getLocalSetup();
    expect(s.done).toBe(false);
    expect(s.default).toBeNull();
    expect(s.models.router).toEqual({ linked: false, account: null, model: "qwen/qwen3.5-397b-a17b" });
    expect(s.models.byok).toEqual([]);
    expect(s.models.local[0]).toMatchObject({ runtime: "ollama", url: "http://host.docker.internal:11434" });
    expect(s.connectors).toEqual([]);
    expect(s.channels).toEqual([{ kind: "telegram", state: "absent" }]);
  });

  it("l'état de démo est réglable : sans Ollama, Router déjà lié", async () => {
    await setMock({ ollama: false, linked: true });
    const s = await c.getLocalSetup();
    expect(s.models.local).toEqual([]);
    expect(s.models.router.linked).toBe(true);
    expect(s.models.router.account).toBeTruthy();
  });
});

describe("Lokkal — models/test", () => {
  it("http(s) + hôte : ok avec la liste des modèles", async () => {
    for (const u of ["https://api.exemple.test/v1", "http://localhost:1234/v1"]) {
      const r = await c.testLocalModel({ base_url: u, api_key: "sk-bonne" });
      expect(r.ok).toBe(true);
      expect(r.models.length).toBeGreaterThan(0);
      expect(r.latency_ms).toBeGreaterThan(0);
      expect(r.error ?? null).toBeNull();
    }
  });

  it.each(["https://", "https:///v1", "api.exemple.test", "ftp://x", ""])("URL %s : « base_url http(s) requise », latence nulle, réponse 200", async (u) => {
    const r = await c.testLocalModel({ base_url: u, api_key: "sk-x" });
    expect(r).toEqual({ ok: false, models: [], latency_ms: null, error: "base_url http(s) requise" });
  });

  it("hôte injoignable : nom d'exception ; clé refusée : « HTTP 401 »", async () => {
    expect(await c.testLocalModel({ base_url: "https://nulle-part.invalid" })).toEqual({ ok: false, models: [], latency_ms: null, error: "ConnectError" });
    const r = await c.testLocalModel({ base_url: "https://api.exemple.test", api_key: "bad-key-123" });
    expect(r).toMatchObject({ ok: false, error: "HTTP 401", models: [] });
    expect(r.latency_ms).toBeGreaterThan(0);
  });
});

describe("Lokkal — réglage des modèles", () => {
  it("done est sans condition ; le défaut local porte le modèle (local:<url>|<modèle>)", async () => {
    expect(await c.finishLocalSetup()).toEqual({ done: true });
    const s = await c.putLocalModels({ default: "local:http://host.docker.internal:11434|llama3.1:8b" });
    expect(s.default).toBe("local:http://host.docker.internal:11434|llama3.1:8b");
    expect((await c.getLocalSetup()).done).toBe(true);
  });

  it("défaut invalide : 400 au format {error:{message}} ; un byok:<nom> ou router sont acceptés tels quels", async () => {
    const e = await c.putLocalModels({ default: "nimporte" }).catch((x) => x);
    expect(e.status).toBe(400);
    expect(e.body).toEqual({ error: { message: expect.stringContaining("router | byok:<nom> | local:") } });
    expect((await c.putLocalModels({ default: "router" })).default).toBe("router");
  });

  it("la vue BYOK porte model, ok et has_key, jamais la clé ni une liste de modèles", async () => {
    // Construite à l'exécution : une fausse clé écrite telle quelle ressemble à une vraie pour les scanners.
    const fake = ["sk", "secret-unique-42"].join("-");
    const s = await c.putLocalModels({ default: "byok:exemple", byok: [{ name: "exemple", base_url: "http://api.exemple.test", model: "large-model", ok: true, api_key: fake }] });
    expect(s.models.byok).toEqual([{ name: "exemple", base_url: "http://api.exemple.test", model: "large-model", ok: true, has_key: true }]);
    expect(JSON.stringify(s)).not.toContain(fake);
  });

  it("byok REMPLACE la liste ; une clé omise reste au coffre ; sans byok la liste est gardée", async () => {
    await c.putLocalModels({ byok: [{ name: "a", base_url: "https://a.test", model: "m", ok: true, api_key: "ka" }, { name: "b", base_url: "https://b.test", ok: true }] });
    let s = await c.putLocalModels({ default: "byok:a" });
    expect(s.models.byok.map((x) => [x.name, x.has_key])).toEqual([["a", true], ["b", false]]);
    s = await c.putLocalModels({ byok: [{ name: "a", base_url: "https://a.test", model: "m2", ok: true }] });
    expect(s.models.byok).toEqual([{ name: "a", base_url: "https://a.test", model: "m2", ok: true, has_key: true }]);
  });

  it("entrée byok sans nom ou sans http(s) : 400", async () => {
    for (const entry of [{ name: "", base_url: "https://x.test" }, { name: "x", base_url: "ftp://x" }, { name: "x", base_url: "" }]) {
      const e = await c.putLocalModels({ byok: [entry] }).catch((x) => x);
      expect(e.status).toBe(400);
      expect(e.body).toEqual({ error: { message: "byok : name et base_url http(s) requis" } });
    }
  });

  it("coffre sans NOKKER_LOCAL_SECRET_KEY : 503", async () => {
    await setMock({ vault: "missing" });
    const e = await c.putLocalModels({ default: "router" }).catch((x) => x);
    expect(e.status).toBe(503);
    expect(e.body.error.message).toContain("NOKKER_LOCAL_SECRET_KEY");
  });
});

describe("Lokkal — flux d'appareil", () => {
  it("la vue porte router.model", async () => {
    expect((await c.getLocalSetup()).models.router.model).toBe("qwen/qwen3.5-397b-a17b");
  });

  it("sans flux ni clé : {state:\"unlinked\"}", async () => {
    expect(await c.getLocalLinkStatus()).toEqual({ state: "unlinked" });
  });

  it("code + lien, pending N fois, puis approved ; Router lié et devenu le défaut s'il n'y en avait pas", async () => {
    await setMock({ approve_after: 2 });
    const start = await c.startLocalLink();
    expect(start.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(start.verification_uri).toBe("https://app.nokker.ai/link");
    expect(start.expires_in).toBeGreaterThan(0);
    expect(start.interval).toBeGreaterThan(0);
    expect((await c.getLocalLinkStatus()).state).toBe("pending");
    expect((await c.getLocalLinkStatus()).state).toBe("pending");
    const ok = await c.getLocalLinkStatus();
    expect(ok.state).toBe("approved");
    expect(ok.account).toBeTruthy();
    const s = await c.getLocalSetup();
    expect(s.models.router.linked).toBe(true);
    expect(s.default).toBe("router");
    expect((await c.getLocalLinkStatus()).state).toBe("approved");
  });

  it("approve_after 0 : approuvé au premier sondage ; issues denied et expired réglables", async () => {
    await setMock({ approve_after: 0 });
    await c.startLocalLink();
    expect((await c.getLocalLinkStatus()).state).toBe("approved");
    for (const outcome of ["denied", "expired"] as const) {
      await setMock({ approve_after: 0, link_outcome: outcome });
      await c.startLocalLink();
      expect((await c.getLocalLinkStatus()).state).toBe(outcome);
      expect((await c.getLocalSetup()).models.router.linked).toBe(false);
    }
  });

  it("service de lien nokker.ai absent : 502 « service de lien nokker.ai indisponible » sur start et status", async () => {
    await setMock({ link_service: "down" });
    const e1 = await c.startLocalLink().catch((x) => x);
    expect(e1.status).toBe(502);
    expect(e1.body).toEqual({ error: { message: "service de lien nokker.ai indisponible" } });
    await setMock({ link_service: "up" });
    await c.startLocalLink();
    await setMock({ link_service: "down" });
    expect(((await c.getLocalLinkStatus().catch((x) => x)) as NokkerApiError).status).toBe(502);
  });

  it("approbation avec un coffre sans clé de chiffrement : 503", async () => {
    await setMock({ approve_after: 0, vault: "missing" });
    await c.startLocalLink();
    expect(((await c.getLocalLinkStatus().catch((x) => x)) as NokkerApiError).status).toBe(503);
  });
});

describe("Lokkal — la clé n'apparaît jamais", () => {
  it("ni dans une réponse (test, PUT, GET, erreurs), ni dans un journal", async () => {
    const secret = ["sk", "ultra", "secret", "9f3a1c"].join("-");
    const badSecret = ["bad", "ultra", "secret", "77e1"].join("-");
    const logs: string[] = [];
    const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    for (const k of Object.keys(orig) as Array<keyof typeof orig>) console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    const seen: string[] = [];
    try {
      const raw = async (method: string, path: string, body?: unknown) => {
        const r = await fetch(`${mock.url}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
        seen.push(await r.text());
      };
      await raw("POST", "/v1/local/setup/models/test", { base_url: "https://api.exemple.test", api_key: secret });
      await raw("POST", "/v1/local/setup/models/test", { base_url: "https://api.exemple.test", api_key: badSecret });
      await raw("POST", "/v1/local/setup/models/test", { base_url: "pas-une-url", api_key: secret });
      await raw("PUT", "/v1/local/setup/models", { default: "byok:exemple", byok: [{ name: "exemple", base_url: "https://api.exemple.test", model: "m", ok: true, api_key: secret }] });
      await raw("PUT", "/v1/local/setup/models", { default: "byok:nope", byok: [{ name: "x", base_url: "mauvais", api_key: secret }] });
      await raw("GET", "/v1/local/setup");
      await raw("POST", "/v1/local/setup/done");
    } finally {
      Object.assign(console, orig);
    }
    expect(seen.length).toBe(7);
    for (const body of [...seen, ...logs]) {
      expect(body).not.toContain(secret);
      expect(body).not.toContain(badSecret);
    }
  });
});

describe("Lokkal — canaux", () => {
  it("créer un appairage Telegram (le jeton local vaut session) passe le canal en pending", async () => {
    await setMock({});
    expect((await c.getLocalSetup()).channels[0]!.state).toBe("absent");
    await c.createTelegramPairing();
    expect((await c.getLocalSetup()).channels[0]!.state).toBe("pending");
  });
});

describe("Lokkal — jeton local et Host (docs/LOKKAL.md §7.1)", () => {
  it("sans jeton ou avec un mauvais jeton : 401 « jeton local requis » sur toutes les routes /v1/local/*", async () => {
    for (const [method, path] of [["GET", "/v1/local/setup"], ["POST", "/v1/local/link/start"], ["DELETE", "/v1/local/link"]] as const) {
      for (const headers of [{}, { Authorization: "Bearer autre" }]) {
        const r = await fetch(`${mock.url}${path}`, { method, headers });
        expect(r.status, `${method} ${path}`).toBe(401);
        expect(await r.json()).toEqual({ error: { message: "jeton local requis" } });
      }
    }
  });

  it.each(["evil.example", "127.0.0.1", "localhost:1", "[::1]"])("Host %s (DNS rebinding, port absent ou faux) : refusé même avec le bon jeton", async (host) => {
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(mock.url);
      const req = http.request({ host: u.hostname, port: u.port, path: "/v1/local/setup", headers: { Host: host, Authorization: `Bearer ${LOCAL_TOKEN}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("Host localhost:<port> accepté", async () => {
    const u = new URL(mock.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: u.hostname, port: u.port, path: "/v1/local/setup", headers: { Host: `localhost:${u.port}`, Authorization: `Bearer ${LOCAL_TOKEN}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
  });

  it("le jeton local ne se lit nulle part dans les réponses", async () => {
    const r = await fetch(`${mock.url}/v1/local/setup`, { headers: { Authorization: `Bearer ${LOCAL_TOKEN}` } });
    expect(await r.text()).not.toContain(LOCAL_TOKEN);
  });
});

describe("Lokkal — DELETE /v1/local/link", () => {
  it("délie : Router non lié, défaut « router » effacé, clé retirée du coffre", async () => {
    await setMock({ linked: true });
    await c.putLocalModels({ default: "router" });
    expect(await c.unlinkLocal()).toEqual({ state: "unlinked" });
    const s = await c.getLocalSetup();
    expect(s.models.router).toEqual({ linked: false, account: null, model: "qwen/qwen3.5-397b-a17b" });
    expect(s.default).toBeNull();
  });
});
