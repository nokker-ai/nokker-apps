import { describe, expect, it } from "vitest";
import { NokkerApiError } from "@nokker-apps/sdk";
import { errorCode, errorKey, invitationFailure, keyForCode } from "../src/onboarding/errors.js";
import {
  buildCalendarRequest,
  buildMailRequest,
  canSubmit,
  formatCountdown,
  initialState,
  needsAppPassword,
  orderPresets,
  reduce,
  secondsLeft,
  type Action,
  type FlowState,
} from "../src/onboarding/flow.js";
import { normLang, t } from "../src/onboarding/i18n.js";

const run = (s: FlowState, ...a: Action[]) => a.reduce(reduce, s);
const atTerms = (): FlowState =>
  run(initialState("tok"), { type: "invitation_ok", lang: "fr", prenom: "Camille" }, { type: "terms_loaded", sha: "abc", lang: "fr" });

describe("machine à états du parcours", () => {
  it("invitation valide → conditions, avec langue et prénom", () => {
    const s = run(initialState("tok"), { type: "invitation_ok", lang: "en", prenom: "Sam" });
    expect(s).toMatchObject({ step: "terms", lang: "en", prenom: "Sam" });
  });

  it("jeton invalide ou injoignable → écrans dédiés ; réessayer revient à la vérification", () => {
    expect(run(initialState("x"), { type: "invitation_invalid" }).step).toBe("invalid");
    const s = run(initialState("x"), { type: "invitation_unreachable" });
    expect(s.step).toBe("unreachable");
    expect(reduce(s, { type: "retry" }).step).toBe("invitation");
  });

  it("la case est la condition d'entrée : pas d'envoi sans elle, ni sans empreinte chargée", () => {
    const s = atTerms();
    expect(canSubmit(s)).toBe(false);
    expect(reduce(s, { type: "submit" }).submitting).toBe(false);
    const ok = reduce(s, { type: "toggle_accept", value: true });
    expect(canSubmit(ok)).toBe(true);
    expect(canSubmit({ ...ok, termsSha: undefined })).toBe(false);
    expect(canSubmit(reduce(ok, { type: "submit" }))).toBe(false);
  });

  it("acceptation réussie → connecteurs, puis Telegram, puis fin ; chaque étape est facultative", () => {
    let s = run(atTerms(), { type: "toggle_accept", value: true }, { type: "submit" }, { type: "accept_ok" });
    expect(s.step).toBe("connectors");
    s = run(s, { type: "next" });
    expect(s.step).toBe("telegram");
    s = run(s, { type: "next" });
    expect(s.step).toBe("done");
    expect(s.connectorsLinked).toEqual({ mail: false, calendar: false });
    expect(reduce(s, { type: "next" }).step).toBe("done");
  });

  it("accept_ok sans envoi en cours est ignoré (pas de saut d'étape)", () => {
    expect(reduce(atTerms(), { type: "accept_ok" }).step).toBe("terms");
  });

  it("conditions périmées : l'acceptation tombe et les conditions sont rechargées", () => {
    const s = run(atTerms(), { type: "toggle_accept", value: true }, { type: "submit" }, { type: "accept_failed", error: "errTermsMismatch", resetTerms: true });
    expect(s).toMatchObject({ step: "terms", accepted: false, submitting: false, error: "errTermsMismatch", termsSha: undefined });
  });

  it("jeton déjà utilisé pendant l'acceptation → écran invalide", () => {
    const s = run(atTerms(), { type: "toggle_accept", value: true }, { type: "submit" }, { type: "accept_failed", error: "x", invalid: true });
    expect(s.step).toBe("invalid");
  });

  it("changer de langue redemande les conditions et décoche la case ; une autre empreinte aussi", () => {
    let s = run(atTerms(), { type: "toggle_accept", value: true }, { type: "set_lang", lang: "en" });
    expect(s).toMatchObject({ lang: "en", accepted: false, termsSha: undefined });
    s = run(s, { type: "terms_loaded", sha: "def", lang: "en" }, { type: "toggle_accept", value: true });
    expect(s.accepted).toBe(true);
    expect(reduce(s, { type: "terms_loaded", sha: "def", lang: "en" }).accepted).toBe(true);
    expect(reduce(s, { type: "terms_loaded", sha: "ghi", lang: "en" }).accepted).toBe(false);
  });

  it("garde la trace des connecteurs reliés pour l'écran final", () => {
    const s = run(initialState("t"), { type: "connector_linked", kind: "mail", linked: true }, { type: "telegram_generated" });
    expect(s.connectorsLinked.mail).toBe(true);
    expect(s.telegramGenerated).toBe(true);
  });
});

describe("erreurs {error: code} → messages français", () => {
  const api = (status: number, body: unknown) => new NokkerApiError("x", status, body);

  it.each([
    ["auth_failed", "errAuthFailed", "Identifiants refusés"],
    ["host_blocked", "errHostBlocked", "pas autorisée"],
    ["port_not_allowed", "errPortNotAllowed", "port"],
    ["unreachable", "errUnreachable", "injoignable"],
    ["tls_failed", "errTlsFailed", "TLS"],
    ["rate", "errRate", "Trop d'essais"],
    ["terms_mismatch", "errTermsMismatch", "conditions"],
    ["invalid_token", "errInvalidToken", "invitation"],
    ["account_exists", "errAccountExists", "beta@nokker.ai"],
    ["front_unavailable", "errFrontUnavailable", "indisponible"],
    ["internal", "errInternal", "interne"],
    ["key_missing", "errKeyMissing", "coffre des identifiants est indisponible"],
    ["protocol_error", "errProtocol", "inattendue"],
    ["unsupported", "errUnsupported", "pas prise en charge"],
  ])("%s", (code, key, fragment) => {
    const err = api(400, { error: code, message: "raw server text" });
    expect(errorCode(err)).toBe(code);
    expect(errorKey(err)).toBe(key);
    expect(t("fr", errorKey(err))).toContain(fragment);
    expect(t("fr", errorKey(err))).not.toContain("raw server text");
  });

  it("repli par statut HTTP, réseau, contexte non sécurisé ; jamais de texte brut", () => {
    expect(errorKey(api(429, {}))).toBe("errRate");
    expect(errorKey(api(401, null))).toBe("errUnauthorized");
    expect(errorKey(api(503, null))).toBe("errFrontUnavailable");
    expect(errorKey(api(500, { error: { message: "boom" } }))).toBe("errGeneric");
    expect(errorKey(new TypeError("Failed to fetch"))).toBe("errNetwork");
    expect(errorKey(new Error("insecure_context"))).toBe("errInsecure");
    expect(keyForCode(null)).toBe("errGeneric");
  });

  it("toutes les clés existent dans les deux langues", () => {
    for (const code of ["auth_failed", "rate", "unreachable", "account_exists", "key_missing"]) expect(t("en", keyForCode(code))).not.toBe(t("fr", keyForCode(code)));
    expect(t("fr", "expiresIn", { time: "9:59" })).toBe("Expire dans 9:59");
    expect(normLang("en-GB")).toBe("en");
    expect(normLang(undefined)).toBe("fr");
  });
});

describe("échec du GET invitation", () => {
  const api = (status: number, body: unknown) => new NokkerApiError("x", status, body);
  it("seul un jeton refusé est « invalide » ; 429, 503, réseau → service injoignable", () => {
    expect(invitationFailure(api(410, { error: "invalid_token" }))).toBe("invalid");
    expect(invitationFailure(api(400, { error: "invalid_token" }))).toBe("invalid");
    expect(invitationFailure(api(429, { error: "rate_limited" }))).toBe("unreachable");
    expect(invitationFailure(api(503, { error: "front_unavailable" }))).toBe("unreachable");
    expect(invitationFailure(api(500, null))).toBe("unreachable");
    expect(invitationFailure(new TypeError("Failed to fetch"))).toBe("unreachable");
  });
});

describe("formulaires de connecteurs", () => {
  it("mail par fournisseur : preset + adresse, secret à part", () => {
    expect(buildMailRequest({ preset: "gmail", address: " a@gmail.com ", secret: " pw " })).toEqual({
      settings: { preset: "gmail", address: "a@gmail.com" },
      secret: "pw",
    });
    expect(buildMailRequest({ preset: "gmail", address: "", secret: "pw" })).toBeNull();
    expect(buildMailRequest({ preset: "gmail", address: "a@gmail.com", secret: "" })).toBeNull();
  });

  it("mail personnalisé : hôtes et ports numériques obligatoires", () => {
    const f = { preset: "custom", address: "a@x.org", secret: "pw", imapHost: "imap.x.org", imapPort: "993", smtpHost: "smtp.x.org", smtpPort: "587" };
    expect(buildMailRequest(f)?.settings).toEqual({ preset: "custom", address: "a@x.org", imap_host: "imap.x.org", imap_port: 993, smtp_host: "smtp.x.org", smtp_port: 587 });
    expect(buildMailRequest({ ...f, imapPort: "abc" })).toBeNull();
    expect(buildMailRequest({ ...f, smtpHost: "" })).toBeNull();
  });

  it("agenda iCal et CalDAV", () => {
    expect(buildCalendarRequest({ mode: "ical", label: "Perso", secret: "https://x/cal.ics" })).toEqual({ settings: { mode: "ical", label: "Perso" }, secret: "https://x/cal.ics" });
    expect(buildCalendarRequest({ mode: "caldav", url: "https://dav", username: "u", secret: "pw" })?.settings).toEqual({ mode: "caldav", url: "https://dav", username: "u" });
    expect(buildCalendarRequest({ mode: "caldav", url: "", username: "u", secret: "pw" })).toBeNull();
  });

  it("le conseil de mot de passe d'application ne vise que Gmail et iCloud", () => {
    expect(needsAppPassword("gmail")).toBe(true);
    expect(needsAppPassword("icloud")).toBe(true);
    expect(needsAppPassword("infomaniak")).toBe(false);
  });
});

describe("fournisseurs de mail", () => {
  it("Gmail et iCloud passent devant, les inconnus à la fin", () => {
    expect(orderPresets(["fastmail", "zoho", "icloud", "gmail", "infomaniak"])).toEqual(["gmail", "icloud", "infomaniak", "fastmail", "zoho"]);
  });
});

describe("compte à rebours Telegram", () => {
  it("décompte, plancher à zéro, date illisible = expiré", () => {
    const now = Date.parse("2026-10-21T10:00:00Z");
    expect(secondsLeft("2026-10-21T10:10:00Z", now)).toBe(600);
    expect(secondsLeft("2026-10-21T09:59:00Z", now)).toBe(0);
    expect(secondsLeft("n'importe quoi", now)).toBe(0);
    expect(formatCountdown(599)).toBe("9:59");
    expect(formatCountdown(5)).toBe("0:05");
  });

  it("le consentement à l'entraînement n'est jamais pré-coché, facultatif, et retombe avec une nouvelle version", () => {
    const base = atTerms();
    expect(base.training).toBe(false);
    expect(canSubmit(reduce(base, { type: "toggle_accept", value: true }))).toBe(true); // refuser l'entraînement n'empêche pas d'entrer
    const on = run(atTerms(), { type: "toggle_training", value: true });
    expect(on.training).toBe(true);
    expect(run(on, { type: "set_lang", lang: "en" }).training).toBe(false);
    expect(run(on, { type: "toggle_accept", value: true }, { type: "submit" }, { type: "accept_failed", error: "x", resetTerms: true }).training).toBe(false);
  });
});
