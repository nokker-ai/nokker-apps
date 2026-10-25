import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NokkerApiError, type LocalSetup } from "@nokker-apps/sdk";
import { localErrorKey, testErrorKind } from "../src/onboarding/errors.js";
import {
  byokName,
  canContinueModels,
  defaultOptions,
  initialLocalState,
  missingWithoutRouter,
  reduceLocal,
  validApiUrl,
  type LocalAction,
  type LocalFlowState,
} from "../src/onboarding/localFlow.js";
import { DefaultPicker, RouterCard } from "../src/onboarding/SetupParts.js";
import { t, type Key } from "../src/onboarding/i18n.js";

const run = (s: LocalFlowState, ...a: LocalAction[]) => a.reduce(reduceLocal, s);

const OLLAMA = { runtime: "ollama" as const, url: "http://host.docker.internal:11434", models: ["llama3.1:8b"] };
function setup(over: Partial<LocalSetup["models"]> & { default?: string | null } = {}): LocalSetup {
  return {
    done: false,
    models: { router: over.router ?? { linked: false, account: null }, byok: over.byok ?? [], local: over.local ?? [] },
    default: over.default ?? null,
    connectors: [],
    channels: [{ kind: "telegram", state: "absent" }],
  };
}
const loaded = (o?: Parameters<typeof setup>[0]) => run(initialLocalState("fr"), { type: "setup_loaded", setup: setup(o) });

describe("Lokkal /setup — machine à états", () => {
  it("chargement → Modèles ; injoignable → écran dédié, réessayer recharge", () => {
    expect(loaded().step).toBe("models");
    const u = run(initialLocalState("fr"), { type: "setup_failed" });
    expect(u.step).toBe("unreachable");
    expect(reduceLocal(u, { type: "retry" }).step).toBe("loading");
  });

  it("sans jeton local (ou 401) : écran « ouvre depuis Lokkal », sans réessai", () => {
    const l = run(initialLocalState("fr"), { type: "setup_locked" });
    expect(l.step).toBe("locked");
    expect(reduceLocal(l, { type: "retry" }).step).toBe("locked");
  });

  it("sans aucun modèle : pas de défaut, on ne peut ni continuer ni enregistrer", () => {
    const s = loaded();
    expect(s.chosen).toBeNull();
    expect(canContinueModels(s)).toBe(false);
    expect(run(s, { type: "models_submit" }).submitting).toBe(false);
    expect(run(s, { type: "choose", value: "router" }).chosen).toBeNull(); // Router non lié : refusé
    expect(run(s, { type: "next" }).step).toBe("models");
    expect(run(s, { type: "finish_submit" }).submitting).toBe(false);
  });

  it("un modèle local détecté devient le défaut (local:<url>|<modèle>), et on peut continuer", () => {
    const s = loaded({ local: [OLLAMA] });
    expect(s.chosen).toBe(`local:${OLLAMA.url}|llama3.1:8b`);
    expect(canContinueModels(s)).toBe(true);
  });

  it("un runtime local sans modèle ne propose rien ; un par modèle sinon", () => {
    expect(loaded({ local: [{ ...OLLAMA, models: [] }] }).chosen).toBeNull();
    const two = loaded({ local: [{ ...OLLAMA, models: ["a", "b"] }] });
    expect(defaultOptions(two).map((o) => o.value)).toEqual([`local:${OLLAMA.url}|a`, `local:${OLLAMA.url}|b`]);
  });

  it("le défaut du noyau est repris ; un défaut devenu indisponible est remplacé", () => {
    expect(loaded({ local: [OLLAMA], default: "local:http://autre|x" }).chosen).toBe(`local:${OLLAMA.url}|llama3.1:8b`);
    const keep = `local:${OLLAMA.url}|llama3.1:8b`;
    expect(loaded({ router: { linked: true, account: "a@b.c" }, local: [OLLAMA], default: keep }).chosen).toBe(keep);
  });

  it("vue du noyau : compte null toléré, clé sans modèle ou essai raté non reprise, clé relue avec has_key", () => {
    const s = loaded({
      router: { linked: true, account: null },
      byok: [
        { name: "a", base_url: "https://a.test", model: "m", ok: true, has_key: true },
        { name: "b", base_url: "https://b.test", model: null, ok: true, has_key: true },
        { name: "c", base_url: "https://c.test", model: "m", ok: false, has_key: false },
        { name: "d", base_url: "http://d.test", model: "m", ok: null, has_key: false },
      ],
    });
    expect(s.account).toBeUndefined();
    expect(s.byok.map((b) => [b.name, b.model, b.hasKey, b.pending])).toEqual([["a", "m", true, false], ["d", "m", false, false]]);
  });

  it("flux d'appareil : start → code affiché → pending ne change rien → approved lie le Router et le choisit", () => {
    let s = loaded();
    s = run(s, { type: "link_start" });
    expect(s.link.phase).toBe("starting");
    expect(run(s, { type: "link_start" })).toBe(s); // pas de double départ
    s = run(s, { type: "link_started", code: "KMRT-4829", uri: "https://app.nokker.ai/link", expiresAt: 1, interval: 2 });
    expect(s.link).toMatchObject({ phase: "waiting", code: "KMRT-4829" });
    expect(run(s, { type: "link_status", state: "pending" })).toBe(s);
    s = run(s, { type: "link_status", state: "approved", account: "camille@example.com" });
    expect(s).toMatchObject({ routerLinked: true, account: "camille@example.com", chosen: "router", link: { phase: "idle" } });
    expect(canContinueModels(s)).toBe(true);
  });

  it("flux d'appareil : expiré, refusé, erreur ; on peut recommencer", () => {
    for (const st of ["expired", "denied"] as const) {
      let s = run(loaded(), { type: "link_start" }, { type: "link_started", code: "AAAA-BBBB", uri: "u", expiresAt: 1, interval: 1 });
      s = run(s, { type: "link_status", state: st });
      expect(s.link.phase).toBe(st);
      expect(s.routerLinked).toBe(false);
      expect(run(s, { type: "link_start" }).link.phase).toBe("starting");
    }
    expect(run(loaded(), { type: "link_start" }, { type: "link_failed" }).link.phase).toBe("error");
  });

  it("sondage qui répond « unlinked » (noyau redémarré, plus de flux) : retour à « non relié », on peut recommencer", () => {
    let s = run(loaded(), { type: "link_start" }, { type: "link_started", code: "AAAA-BBBB", uri: "u", expiresAt: 1, interval: 1 });
    s = run(s, { type: "link_status", state: "unlinked" });
    expect(s.link.phase).toBe("idle");
    expect(s.routerLinked).toBe(false);
    expect(run(s, { type: "link_start" }).link.phase).toBe("starting");
  });

  it("service de lien nokker.ai absent (502) : écran de repli, pendant le départ comme pendant le sondage ; on peut réessayer", () => {
    const afterStart = run(loaded(), { type: "link_start" }, { type: "link_unavailable" });
    expect(afterStart.link.phase).toBe("unavailable");
    expect(afterStart.routerLinked).toBe(false);
    expect(run(afterStart, { type: "link_start" }).link.phase).toBe("starting");
    const midPoll = run(loaded(), { type: "link_start" }, { type: "link_started", code: "AAAA-BBBB", uri: "u", expiresAt: 1, interval: 1 }, { type: "link_unavailable" });
    expect(midPoll.link.phase).toBe("unavailable");
    expect(run(loaded(), { type: "link_vault" }).link.phase).toBe("idle"); // rien ne part sans départ
    expect(run(loaded(), { type: "link_start" }, { type: "link_vault" }).link.phase).toBe("vault");
  });

  it("sans Router, le repli (ma clé ou modèle local) mène quand même au bout", () => {
    let s = run(loaded({ local: [OLLAMA] }), { type: "link_start" }, { type: "link_unavailable" });
    expect(canContinueModels(s)).toBe(true);
    s = run(loaded(), { type: "link_start" }, { type: "link_unavailable" }, { type: "byok_added", name: "k", base_url: "https://k.test", model: "m", hasKey: true });
    expect(s.chosen).toBe("byok:k");
    expect(canContinueModels(s)).toBe(true);
  });

  it("ma propre clé ajoutée avec son modèle : disponible et choisie sans écraser un choix existant ; le nom vient de l'hôte", () => {
    const s = run(loaded(), { type: "byok_added", name: "api-exemple-test", base_url: "https://api.exemple.test/v1", model: "m", hasKey: true });
    expect(s.chosen).toBe("byok:api-exemple-test");
    expect(s.byok[0]).toMatchObject({ pending: true, model: "m", hasKey: true });
    const withLocal = run(loaded({ local: [OLLAMA] }), { type: "byok_added", name: "x", base_url: "https://x.test", model: "m", hasKey: false });
    expect(withLocal.chosen).toBe(`local:${OLLAMA.url}|llama3.1:8b`); // le choix existant reste
    expect(run(withLocal, { type: "choose", value: "byok:x" }).chosen).toBe("byok:x");
    expect(byokName("https://API.Exemple.test:8443/v1")).toBe("api-exemple-test");
    expect(byokName("pas une url")).toBe("pas-une-url");
    expect(byokName("")).toBe("cle");
  });

  it("sans modèle, pas d'ajout ; la même clé ajoutée deux fois remplace l'entrée ; retirée, le défaut se repositionne", () => {
    expect(run(loaded(), { type: "byok_added", name: "x", base_url: "https://x.test", model: "", hasKey: true }).byok).toEqual([]);
    const a = run(loaded(), { type: "byok_added", name: "x", base_url: "https://x.test", model: "a", hasKey: true }, { type: "byok_added", name: "x", base_url: "https://x.test", model: "b", hasKey: true });
    expect(a.byok).toHaveLength(1);
    expect(a.byok[0]!.model).toBe("b");
    const gone = run(a, { type: "byok_removed", name: "x" });
    expect(gone.byok).toEqual([]);
    expect(gone.chosen).toBeNull();
    const fallback = run(loaded({ local: [OLLAMA] }), { type: "byok_added", name: "x", base_url: "https://x.test", model: "a", hasKey: true }, { type: "choose", value: "byok:x" }, { type: "byok_removed", name: "x" });
    expect(fallback.chosen).toBe(`local:${OLLAMA.url}|llama3.1:8b`);
  });

  it("enchaînement complet : modèles → connecteurs → canaux → terminé, puis done", () => {
    let s = loaded({ local: [OLLAMA] });
    s = run(s, { type: "models_submit" });
    expect(s.submitting).toBe(true);
    s = run(s, { type: "models_saved", setup: setup({ local: [OLLAMA], default: `local:${OLLAMA.url}|llama3.1:8b` }) });
    expect(s.step).toBe("connectors");
    expect(run(s, { type: "models_submit" })).toBe(s); // plus de retour en arrière
    s = run(s, { type: "next" });
    expect(s.step).toBe("channels");
    s = run(s, { type: "telegram_started" }, { type: "next" });
    expect(s).toMatchObject({ step: "done", telegramStarted: true });
    s = run(s, { type: "finish_submit" });
    expect(s.submitting).toBe(true);
    expect(run(s, { type: "finish_submit" })).toBe(s);
    expect(run(s, { type: "finish_failed", error: "errGeneric" })).toMatchObject({ submitting: false, error: "errGeneric", finished: false });
    expect(run(s, { type: "finish_ok" }).finished).toBe(true);
  });

  it("échec de l'enregistrement des modèles : on reste sur l'étape avec l'erreur", () => {
    const s = run(loaded({ local: [OLLAMA] }), { type: "models_submit" }, { type: "models_failed", error: "lkErrNoDefault" });
    expect(s).toMatchObject({ step: "models", submitting: false, error: "lkErrNoDefault" });
  });

  it("l'état ne porte jamais de clé d'API", () => {
    const s = run(loaded(), { type: "byok_added", name: "x", base_url: "https://x.test", model: "m", hasKey: true });
    expect(JSON.stringify(s)).not.toMatch(/api_key|secret/i);
  });

  it("la phrase de ce qui manque ne dépend que du Router", () => {
    expect(missingWithoutRouter(loaded())).toBe(true);
    expect(missingWithoutRouter(loaded({ router: { linked: true } }))).toBe(false);
  });

  it("adresses d'API : http(s) et hôte non vide", () => {
    for (const u of ["https://api.exemple.test/v1", "http://localhost:1234/v1"]) expect(validApiUrl(u)).toBe(true);
    for (const u of ["ftp://x.test", "https://", "https:///v1", "http://:80", "x.test", ""]) expect(validApiUrl(u)).toBe(false);
  });

  it("ordre des choix : Router, mes clés, modèle local", () => {
    const s = run(loaded({ router: { linked: true }, local: [OLLAMA] }), { type: "byok_added", name: "k", base_url: "https://k.test", model: "m", hasKey: true });
    expect(defaultOptions(s).map((o) => o.kind)).toEqual(["router", "byok", "local"]);
  });
});

describe("Lokkal /setup — rendu", () => {
  it("carte Router en attente : code, lien, minuteur et statut annoncé aux lecteurs d'écran", () => {
    const html = renderToStaticMarkup(
      createElement(RouterCard, { lang: "fr", routerLinked: false, link: { phase: "waiting", code: "KMRT-4829", uri: "https://app.nokker.ai/link", expiresAt: 600_000, interval: 2 }, onStart: () => {}, now: 0 }),
    );
    expect(html).toContain("KMRT-4829");
    expect(html).toContain('href="https://app.nokker.ai/link"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("10:00");
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("Relier mon compte"); // le bouton disparaît pendant l'attente
  });

  it("carte Router : bouton au repos, compte lié ensuite", () => {
    const idle = renderToStaticMarkup(createElement(RouterCard, { lang: "fr", routerLinked: false, link: { phase: "idle" }, onStart: () => {} }));
    expect(idle).toContain("Relier mon compte");
    const linked = renderToStaticMarkup(createElement(RouterCard, { lang: "fr", routerLinked: true, account: "camille@example.com", link: { phase: "idle" }, onStart: () => {} }));
    expect(linked).toContain("camille@example.com");
    expect(linked).not.toContain("Relier mon compte");
  });

  it("carte Router sans service de lien (502) : texte de repli « ma clé ou un modèle local », bouton réessayer, pas d'alerte rouge", () => {
    const html = renderToStaticMarkup(createElement(RouterCard, { lang: "fr", routerLinked: false, link: { phase: "unavailable" }, onStart: () => {} }));
    expect(html).toContain("pas encore disponible");
    expect(html).toContain("propre clé ou un modèle local");
    expect(html).toContain("Réessayer");
    expect(html).not.toContain('role="alert"');
    const en = renderToStaticMarkup(createElement(RouterCard, { lang: "en", routerLinked: false, link: { phase: "unavailable" }, onStart: () => {} }));
    expect(en).toContain("not available yet");
  });

  it("libellés des choix : la clé et le modèle local disent leur modèle", () => {
    const s = run(loaded({ local: [OLLAMA] }), { type: "byok_added", name: "k", base_url: "https://k.test", model: "grand", hasKey: true });
    const html = renderToStaticMarkup(createElement(DefaultPicker, { lang: "fr", options: defaultOptions(s), chosen: s.chosen, onChoose: () => {} }));
    expect(html).toContain("Ma clé · k · grand");
    expect(html).toContain("Ollama · llama3.1:8b · cette machine");
  });

  it("choix du défaut : boutons radio natifs, l'élu coché ; sans option, une aide", () => {
    const s = run(loaded({ router: { linked: true }, local: [OLLAMA] }));
    const html = renderToStaticMarkup(createElement(DefaultPicker, { lang: "fr", options: defaultOptions(s), chosen: s.chosen, onChoose: () => {} }));
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toMatch(/value="router"[^>]*checked|checked[^>]*value="router"/);
    expect(renderToStaticMarkup(createElement(DefaultPicker, { lang: "fr", options: [], chosen: null, onChoose: () => {} }))).toContain("apparaîtra ici");
  });
});

describe("Lokkal /setup — textes", () => {
  const keys: Key[] = ["lkTitle", "lkMissing", "lkRouterBody", "lkByokBody", "lkRouterScope", "lkModelsIntro", "lkChannelsIntro", "lkDoneBody", "lkUnreachableBody"];
  it("aucun texte ne parle de la pile interne", () => {
    for (const lang of ["fr", "en"] as const) for (const k of keys) expect(t(lang, k)).not.toMatch(/h[e]rmes|open[c]law|lite[l]lm/i);
  });
  it("une seule phrase pour ce qui manque, en français et en anglais", () => {
    for (const lang of ["fr", "en"] as const) expect(t(lang, "lkMissing").split(/[.!?]\s/).length).toBe(1);
  });
});

describe("Lokkal /setup — erreurs du noyau (sans code, par statut)", () => {
  const e = (status: number) => new NokkerApiError("texte du noyau", status, { error: { message: "texte du noyau" } });
  it("400, 401, 403, 502, 503 ont chacun leur message ; le texte du noyau n'est jamais repris", () => {
    expect([400, 401, 403, 502, 503, 500].map((st) => localErrorKey(e(st)))).toEqual(["lkErrInput", "errUnauthorized", "lkErrHost", "lkErrUpstream", "lkErrVault", "errGeneric"]);
    expect(localErrorKey(new TypeError("fetch failed"))).toBe("errNetwork");
    expect(t("fr", "lkErrVault")).toContain("NOKKER_LOCAL_SECRET_KEY");
  });

  it("texte d'essai : HTTP 401/403 = clé refusée, base_url = adresse, le reste = injoignable", () => {
    expect(testErrorKind("HTTP 401")).toBe("invalid_key");
    expect(testErrorKind("HTTP 403")).toBe("invalid_key");
    expect(testErrorKind("HTTP 404")).toBe("unreachable");
    expect(testErrorKind("base_url http(s) requise")).toBe("url");
    expect(testErrorKind("ConnectError")).toBe("unreachable");
    expect(testErrorKind(null)).toBe("unreachable");
  });
});
