import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient, sealValue, type SiteCard } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";
// @ts-expect-error — module JS de référence du noyau (copie), sans types
import { sealValue as coreSeal } from "./fixtures/core-sealed.js";

let mock: MockServerHandle;
let c: NokkerClient;
const saved = { on: process.env.MOCK_SITES, ms: process.env.MOCK_SITES_STEP_MS };
beforeEach(async () => {
  process.env.MOCK_SITES = "1";
  process.env.MOCK_SITES_STEP_MS = "20";
  mock = await startMockServer({ speed: 0.01 });
  c = new NokkerClient({ baseUrl: mock.url });
  await c.demoSessionMockExtension();
});
afterEach(async () => {
  await mock.close();
  for (const [k, v] of [["MOCK_SITES", saved.on], ["MOCK_SITES_STEP_MS", saved.ms]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const code = (e: unknown): unknown => (e instanceof NokkerApiError ? (e.body as { error?: { code?: unknown } })?.error?.code : undefined);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(id: string, ok: (s: SiteCard) => boolean): Promise<SiteCard> {
  for (let i = 0; i < 150; i++) {
    const s = await c.getSite(id);
    if (ok(s)) return s;
    await wait(15);
  }
  throw new Error(`état jamais atteint : ${JSON.stringify(await c.getSite(id))}`);
}
async function answer(s: SiteCard, value: string, seal = sealValue): Promise<void> {
  const r = await c.getSiteRequest(s.request!.id);
  await c.answerSiteRequest(r.id, { sealed: await seal(r.machine_key!, r.id, value) });
}
async function add(username: string, label?: string): Promise<SiteCard> {
  const l = await c.listSites();
  await c.acceptSiteConsent("linkedin", l.consent_version);
  return c.addSite({ site: "linkedin", username, ...(label ? { label } : {}) });
}

describe("sites connectés (faux noyau des routes /v1/local/sites*)", () => {
  it("avertissement d'abord ; jamais de secret en clair ; mot de passe scellé par demande ; connecté", async () => {
    const l = await c.listSites();
    expect(l).toMatchObject({ enabled: true, sites: [], consents: [], consent_version: "2026-11-05", catalog: [{ site: "linkedin", name: "LinkedIn", recipe: true }] });
    expect(code(await c.addSite({ site: "linkedin", username: "alex@example.org" }).catch((e) => e))).toBe("consent_required");
    await c.acceptSiteConsent("linkedin", l.consent_version);
    expect((await c.listSites()).consents).toEqual(["linkedin"]);
    const plain = await fetch(`${mock.url}/v1/local/sites`, { method: "POST", headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ site: "linkedin", username: "a", password: "p" }) });
    expect([plain.status, ((await plain.json()) as { error: { code: string } }).error.code]).toEqual([400, "no_plain_secret"]);
    const s = await c.addSite({ site: "linkedin", username: "alex@example.org" });
    expect(s).toMatchObject({ label: "LinkedIn", default: true, flow: "connecting", username: "alex@example.org" });
    const asked = await until(s.id, (x) => x.state === "needs_password" && !!x.request);
    expect(asked.state_text).toBe("Mot de passe demandé sur Telegram");
    const r = await c.getSiteRequest(asked.request!.id);
    expect(r).toMatchObject({ kind: "password", label: "LinkedIn", machine_key: { kty: "EC", crv: "P-256" } });
    // Une valeur en clair, ou scellée pour une AUTRE demande, est refusée.
    expect(code(await c.answerSiteRequest(r.id, { value: "x" } as never).catch((e) => e))).toBe("no_plain_secret");
    expect(code(await c.answerSiteRequest(r.id, { sealed: await sealValue(r.machine_key!, "rq_autre", "secret") }).catch((e) => e))).toBe("bad_sealed");
    await answer(asked, "secret-de-test");
    expect(code(await c.answerSiteRequest(r.id, { sealed: await sealValue(r.machine_key!, r.id, "x") }).catch((e) => e))).toBe("answered");
    const done = await until(s.id, (x) => x.state === "connected");
    expect(done).toMatchObject({ state_text: "Connecté ✓", account_name: "Alex Martin", credentials: { stored: true }, quotas: { pages: { used: 12, max: 150 } } });
    expect(JSON.stringify(done)).not.toMatch(/secret-de-test/);
    expect(done.request).toBeUndefined();
  });

  it("le scellé du SDK et celui de la référence du noyau (sealed.js) s'ouvrent tous deux", async () => {
    const a = await until((await add("ref@example.org")).id, (x) => x.state === "needs_password");
    await answer(a, "secret", coreSeal as typeof sealValue);
    await until(a.id, (x) => x.state === "connected");
  });

  it("code : faux puis bon ; validation dans l'appli ; lien à coller ; identifiant refusé ; deux comptes d'un site", async () => {
    const a = await until((await add("code@example.org", "LinkedIn pro")).id, (x) => x.state === "needs_password");
    await answer(a, "pw");
    const asked = await until(a.id, (x) => x.state === "needs_code" && !!x.request);
    expect((await c.getSiteRequest(asked.request!.id)).kind).toBe("code");
    await answer(asked, "000000");
    const again = await until(a.id, (x) => x.state === "needs_code" && !!x.request && x.request.id !== asked.request!.id);
    expect(again.signal).toBe("wrong_code");
    await answer(again, "123456");
    await until(a.id, (x) => x.state === "connected");

    const b = await until((await c.addSite({ site: "linkedin", username: "phone@example.org", label: "LinkedIn perso" })).id, (x) => x.state === "needs_password");
    expect(b.default).toBe(false);
    await answer(b, "pw");
    const ph = await until(b.id, (x) => x.state === "needs_app_approval" && !!x.request);
    const pr = await c.getSiteRequest(ph.request!.id);
    expect(pr.machine_key).toBeNull();
    expect(code(await c.answerSiteRequest(pr.id, { sealed: {} as never }).catch((e) => e))).toBe("bad_answer");
    await c.answerSiteRequest(pr.id, { done: true });
    await until(b.id, (x) => x.state === "connected");

    const p = await until((await c.addSite({ site: "linkedin", username: "paste@example.org", label: "Lien" })).id, (x) => x.state === "needs_password");
    await answer(p, "pw");
    await answer(await until(p.id, (x) => x.state === "needs_link" && !!x.request), "https://www.linkedin.com/login/magic?t=x");
    await until(p.id, (x) => x.state === "connected");

    const w = await until((await c.addSite({ site: "linkedin", username: "wrong@example.org", label: "Refusé" })).id, (x) => x.state === "needs_password");
    await answer(w, "pw");
    const sus = await until(w.id, (x) => x.state === "suspended");
    expect(sus).toMatchObject({ state_text: "Identifiant refusé : à remplacer", signal: "bad_credentials", credentials: { stored: false } });
    const { request } = await c.replaceSitePassword(w.id);
    expect((await c.getSite(w.id)).state).toBe("needs_password");
    await c.answerSiteRequest(request.id, { sealed: await sealValue(request.machine_key!, request.id, "nouveau") });

    expect(code(await c.addSite({ site: "linkedin", username: "x@example.org", label: "linkedin pro" }).catch((e) => e))).toBe("label_taken");
    expect(code(await c.patchSite(a.id, { label: "a/b" }).catch((e) => e))).toBe("bad_label");
    await c.patchSite(b.id, { default: true });
    expect((await c.listSites()).sites.filter((x) => x.default).map((x) => x.id)).toEqual([b.id]);
  });

  it("depuis le chat (avertissement à accepter), vérification, expiration, pause, abandon, suppression, éteint", async () => {
    const dev = (body: object) => fetch(`${mock.url}/v1/dev/sites-mock`, { method: "POST", headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await dev({ chat: { site: "linkedin", username: "robot@example.org" } });
    const chat = (await c.listSites()).sites[0]!;
    expect(chat).toMatchObject({ state: "needs_consent", state_text: "Conditions d'utilisation du site à accepter" });
    await c.acceptSiteConsent("linkedin", "2026-11-05");
    expect((await c.connectSite(chat.id)).status).toBe("connecting");
    await answer(await until(chat.id, (x) => x.state === "needs_password"), "pw");
    const you = await until(chat.id, (x) => x.state === "needs_you" && !!x.handoff_url);
    expect(you).toMatchObject({ signal: "captcha", state_text: "Vérification à faire sur l'écran du navigateur" });
    const tok = you.handoff_url!.split("/sites/h/")[1]!;
    const { screen_url } = await c.openSiteHandoff(tok);
    expect(code(await c.openSiteHandoff(tok).catch((e) => e))).toBe("handoff_gone");
    expect((await c.getSite(chat.id)).handoff_url).toBeUndefined();
    expect(await (await fetch(`${mock.url}${screen_url}`)).text()).toMatch(/data-screen=/);
    expect((await fetch(`${mock.url}${screen_url}/done`, { method: "POST" })).status).toBe(200);
    await until(chat.id, (x) => x.state === "connected");

    await dev({ expire: chat.id });
    expect((await c.getSite(chat.id)).state_text).toBe("Connexion expirée : reconnexion…");
    expect((await until(chat.id, (x) => x.state === "connected")).last_auto_login_at).toBeTruthy();
    await dev({ pause: chat.id });
    const paused = await c.getSite(chat.id);
    expect(paused.state_text).toMatch(/^En pause jusqu'au \d\d\.\d\d \d\d:\d\d \(activité inhabituelle signalée par le site\)$/);
    expect((await c.liftSitePause(chat.id)).state).toBe("connected");

    const t = await until((await c.addSite({ site: "linkedin", username: "late@example.org", label: "Tard" })).id, (x) => x.state === "needs_password");
    await dev({ timeout: t.id });
    expect(await c.getSite(t.id)).toMatchObject({ signal: "password_timeout", state_text: "Connexion abandonnée : mot de passe non donné à temps" });
    expect(code(await c.cancelSite(t.id).catch((e) => e))).toBe("not_connecting");
    const k = await c.addSite({ site: "linkedin", username: "code2@example.org", label: "Annulé", answer_here: true });
    await until(k.id, (x) => x.state === "needs_password");
    expect(await c.cancelSite(k.id)).toEqual({ status: "cancelling" });
    expect(await c.getSite(k.id)).toMatchObject({ state: "failed", signal: "cancelled", state_text: "Connexion abandonnée : annulée à la demande" });
    // Code refusé deux fois par le site : abandon, rien n'est rejoué.
    const z = await until((await c.addSite({ site: "linkedin", username: "code3@example.org", label: "Deux faux" })).id, (x) => x.state === "needs_password");
    await answer(z, "pw");
    await answer(await until(z.id, (x) => x.state === "needs_code" && !!x.request), "111111");
    await answer(await until(z.id, (x) => x.signal === "wrong_code" && !!x.request), "222222");
    expect((await until(z.id, (x) => x.state === "failed")).signal).toBe("code_rejected");
    expect(await c.deleteSite(t.id, false)).toEqual({ deleted: true });
    expect(code(await c.addSite({ url: "https://exemple.org", username: "a" }).catch((e) => e))).toBe("unsupported");

    await dev({ off: true });
    expect(await c.listSites()).toMatchObject({ enabled: false, reason: "disabled" });
    expect(code(await c.getSite(chat.id).catch((e) => e))).toBe("disabled");
    await dev({ off: false, no_machine: true });
    expect(await c.listSites()).toMatchObject({ enabled: false, reason: "no_machine" });
    await dev({ no_machine: false, minor: true });
    expect(code(await c.listSites().catch((e) => e))).toBe("minor");
  });
});
