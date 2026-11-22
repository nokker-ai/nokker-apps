import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, type PersonaCatalog } from "@nokker-apps/sdk";
import { errorCode } from "../src/onboarding/errors.js";
import {
  initialState,
  personaErrorKey,
  personaRequest,
  reduce,
  setOnboardingAvatarForTests,
  stepsFor,
  validPersonaName,
  type Action,
  type FlowState,
} from "../src/onboarding/flow.js";
import { t } from "../src/onboarding/i18n.js";

const run = (s: FlowState, ...a: Action[]) => a.reduce(reduce, s);

const CATALOG: PersonaCatalog = {
  voices: [
    { id: "voice-a", label: "Voix A", langs: ["fr", "en"] },
    { id: "voice-b", label: "Voix B", langs: ["en"] },
  ],
  avatars: [
    { id: "avatar-one", version: 1, label: "One", url: "/avatars/avatar-one-v1.glb", thumb: "/avatars/avatar-one-v1.webp" },
    { id: "avatar-two", version: 2, label: "Two", url: "/avatars/avatar-two-v2.glb", thumb: "/avatars/avatar-two-v2.webp" },
  ],
  name: { min: 1, max: 24 },
  defaults: { name: "Alice", voice_id: "voice-a", avatar: { id: "avatar-one", version: 1 } },
};

/** Du début jusqu'aux connecteurs, avec l'état du drapeau au moment où le parcours commence. */
function atConnectors(flag: boolean): FlowState {
  setOnboardingAvatarForTests(flag);
  return run(
    initialState("tok"),
    { type: "invitation_ok", lang: "fr", prenom: "Bob" },
    { type: "terms_loaded", sha: "abc", lang: "fr" },
    { type: "toggle_accept", value: true },
    { type: "submit" },
    { type: "accept_ok" },
  );
}
const atPersona = (): FlowState => run(atConnectors(true), { type: "next" }, { type: "persona_loaded", catalog: CATALOG });

afterEach(() => setOnboardingAvatarForTests(false));

describe("drapeau onboarding_avatar éteint : parcours inchangé", () => {
  it("éteint par défaut ; connecteurs → Telegram → fin, sans étape persona ni état persona", () => {
    setOnboardingAvatarForTests(false);
    let s = atConnectors(false);
    expect(s.avatarStep).toBe(false);
    const seen = [s.step];
    s = run(s, { type: "next" });
    seen.push(s.step);
    s = run(s, { type: "next" });
    seen.push(s.step);
    expect(seen).toEqual(["connectors", "telegram", "done"]);
    expect(s.persona).toBeUndefined();
    expect(stepsFor(false).map((x) => x.step)).toEqual(["terms", "connectors", "telegram", "done"]);
  });

  it("les actions persona n'ont aucun effet hors de l'étape", () => {
    const s = atConnectors(false);
    for (const a of [
      { type: "persona_loaded", catalog: CATALOG },
      { type: "persona_skip" },
      { type: "persona_submit" },
      { type: "persona_saved" },
      { type: "persona_name", value: "Bob" },
    ] as Action[])
      expect(reduce(s, a)).toBe(s);
  });
});

describe("drapeau onboarding_avatar allumé : étape « Ton Nokker »", () => {
  it("connecteurs → persona (catalogue en lecture) → Telegram ; le fil d'étapes la montre avant Telegram", () => {
    const s = run(atConnectors(true), { type: "next" });
    expect(s.step).toBe("persona");
    expect(s.persona?.status).toBe("loading");
    expect(stepsFor(true).map((x) => x.step)).toEqual(["terms", "connectors", "persona", "telegram", "done"]);
    expect(t("fr", "stepPersona")).toBeTruthy();
    expect(t("en", "stepPersona")).toBeTruthy();
  });

  it("le catalogue pose les valeurs par défaut ; un choix déjà fait est repris", () => {
    expect(atPersona().persona).toMatchObject({ status: "ready", name: "Alice", voiceId: "voice-a", avatar: { id: "avatar-one", version: 1 } });
    const s = run(atConnectors(true), { type: "next" }, {
      type: "persona_loaded",
      catalog: CATALOG,
      current: { name: "Bob", voice_id: "voice-b", avatar: { id: "avatar-two", version: 2 }, defaulted: false },
    });
    expect(s.persona).toMatchObject({ name: "Bob", voiceId: "voice-b", avatar: { id: "avatar-two", version: 2 } });
  });

  it("catalogue illisible (noyau sans la route) : l'étape est sautée, jamais bloquante", () => {
    const s = run(atConnectors(true), { type: "next" }, { type: "persona_unavailable" });
    expect(s.step).toBe("telegram");
    expect(s.persona).toBeUndefined();
  });

  it("Passer : Telegram, sans PUT (aucun envoi en cours), même pendant le chargement", () => {
    const s = run(atPersona(), { type: "persona_name", value: "Bob" }, { type: "persona_skip" });
    expect(s.step).toBe("telegram");
    expect(s.persona?.status).toBe("ready");
    expect(run(atConnectors(true), { type: "next" }, { type: "persona_skip" }).step).toBe("telegram");
  });

  it("Continuer : corps du PUT, puis Telegram une fois enregistré", () => {
    let s = run(atPersona(), { type: "persona_name", value: "  Zoé-Anne d'Arc " }, { type: "persona_voice", id: "voice-b" }, { type: "persona_avatar", avatar: { id: "avatar-two", version: 2 } });
    expect(personaRequest(s.persona!)).toEqual({ name: "Zoé-Anne d'Arc", voice_id: "voice-b", avatar: { id: "avatar-two", version: 2 } });
    s = reduce(s, { type: "persona_submit" });
    expect(s.persona?.status).toBe("saving");
    expect(reduce(s, { type: "persona_skip" })).toBe(s);
    expect(reduce(s, { type: "persona_name", value: "x" })).toBe(s);
    s = reduce(s, { type: "persona_saved" });
    expect(s.step).toBe("telegram");
  });

  it("une voix ou un avatar hors catalogue est ignoré", () => {
    const s = atPersona();
    expect(reduce(s, { type: "persona_voice", id: "inconnue" })).toBe(s);
    expect(reduce(s, { type: "persona_avatar", avatar: { id: "avatar-two", version: 1 } })).toBe(s);
  });

  it("nom invalide : pas d'envoi, erreur sur le champ", () => {
    const s = run(atPersona(), { type: "persona_name", value: "R2-D2" }, { type: "persona_submit" });
    expect(s.persona).toMatchObject({ status: "ready", error: "personaErrName", field: "name" });
  });

  it.each([
    ["bad_name", "name", "personaErrName"],
    ["bad_voice", "voice", "personaErrVoice"],
    ["bad_avatar", "avatar", "personaErrAvatar"],
  ] as const)("refus 400 %s : on reste sur l'étape, champ %s signalé", (code, field, key) => {
    const err = new NokkerApiError("/v1/persona → 400", 400, { error: { code } });
    const c = errorCode(err);
    expect(c).toBe(code);
    const s = run(atPersona(), { type: "persona_submit" }, { type: "persona_failed", code: c, error: personaErrorKey(c) });
    expect(s.step).toBe("persona");
    expect(s.persona).toMatchObject({ status: "ready", error: key, field });
    expect(t("fr", key)).not.toBe(t("en", key));
    // Corriger le champ efface l'erreur.
    expect(reduce(s, { type: "persona_name", value: "Alice" }).persona?.error).toBeUndefined();
  });

  it("429 et réseau : message générique de l'onboarding, aucun champ signalé", () => {
    const c = errorCode(new NokkerApiError("x", 429, undefined));
    expect(personaErrorKey(c)).toBe("errRate");
    expect(personaErrorKey("network")).toBe("errNetwork");
    expect(personaErrorKey("http_500")).toBe("errGeneric");
    const s = run(atPersona(), { type: "persona_submit" }, { type: "persona_failed", code: c, error: personaErrorKey(c) });
    expect(s.persona?.field).toBeUndefined();
  });
});

describe("nom de l'assistant", () => {
  it.each(["Alice", "Zoé", "Jean-Luc", "D'Artagnan", "Anne Marie", "A", "Ångström", "x".repeat(24)])("accepte %s", (n) => expect(validPersonaName(n)).toBe(true));
  it.each(["", "   ", "x".repeat(25), "R2D2", "Bob!", "-", "'", "alice@example.com", "<b>"])("refuse %j", (n) => expect(validPersonaName(n)).toBe(false));
  it("suit les bornes du catalogue", () => {
    expect(validPersonaName("Bob", { min: 1, max: 2 })).toBe(false);
    expect(validPersonaName("Bo", { min: 1, max: 2 })).toBe(true);
  });
});
