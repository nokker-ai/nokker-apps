import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NokkerApiError } from "@nokker-apps/sdk";
import { isFinal, miniAppApproveUrl, minutesLeftUntil, raText, remoteTargetFrom, signBlocker } from "../src/approvals/remote.js";
import { OpenElsewhere } from "../src/approvals/OpenElsewhere.js";
import { MiniAppBlock } from "../src/approvals/MiniAppBlock.js";
import { DeviceNotApprovedError, deviceRefusal } from "../src/auth.js";

const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const IPHONE_WEBVIEW = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IPHONE_INSTAGRAM = `${IPHONE_WEBVIEW} Instagram 350.0.0.0 (iPhone15,2; iOS 18_1; fr_CH)`;
const ANDROID_WEBVIEW = "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36";
const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1";

describe("approbation à distance", () => {
  it("lien de notification et lien de passerelle", () => {
    expect(remoteTargetFrom("/approve/mc_0123abcd/ap_1", "")).toEqual({ kind: "id", machineId: "mc_0123abcd", approvalId: "ap_1" });
    expect(remoteTargetFrom("/approve", "?host=Atelier.nokker.app&approval=ap_1")).toEqual({ kind: "host", host: "atelier.nokker.app", approvalId: "ap_1" });
    expect(remoteTargetFrom("/approve/mc_x/../etc", "")).toBeNull();
    expect(remoteTargetFrom("/approve/mc%2Fx/ap", "")).toBeNull();
    expect(remoteTargetFrom("/approve", "?host=a.nokker.app")).toBeNull();
    expect(remoteTargetFrom("/approvals/x", "")).toBeNull();
  });
  it("statuts et délai", () => {
    expect(isFinal("forwarded")).toBe(false);
    expect(isFinal("expired")).toBe(true);
    expect(minutesLeftUntil(new Date(90_000).toISOString(), 0)).toBe(2);
    expect(minutesLeftUntil(new Date(0).toISOString(), 5)).toBe(0);
  });

  it("navigateur intégré ou sans WebAuthn : la passkey n'y marche pas, on le dit", () => {
    expect(signBlocker({ ua: IPHONE_SAFARI, webauthn: true, telegram: true })).toEqual({ kind: "in_app", app: "Telegram" });
    expect(signBlocker({ ua: IPHONE_INSTAGRAM, webauthn: true, telegram: false })).toEqual({ kind: "in_app", app: "Instagram" });
    expect(signBlocker({ ua: `${ANDROID_CHROME} LinkedInApp`, webauthn: true, telegram: false })).toEqual({ kind: "in_app", app: "LinkedIn" });
    expect(signBlocker({ ua: IPHONE_WEBVIEW, webauthn: true, telegram: false })).toEqual({ kind: "in_app", app: null });
    expect(signBlocker({ ua: ANDROID_WEBVIEW, webauthn: true, telegram: false })).toEqual({ kind: "in_app", app: null });
    expect(signBlocker({ ua: IPHONE_SAFARI, webauthn: true, telegram: false })).toBeNull();
    expect(signBlocker({ ua: IPHONE_CHROME, webauthn: true, telegram: false })).toBeNull();
    expect(signBlocker({ ua: ANDROID_CHROME, webauthn: true, telegram: false })).toBeNull();
    expect(signBlocker({ ua: ANDROID_CHROME, webauthn: false, telegram: false })).toEqual({ kind: "no_webauthn" });
  });

  it("écran « ouvre ce lien ailleurs » : FR et EN, geste iOS ou Android, bouton de copie", () => {
    const fr = renderToStaticMarkup(createElement(OpenElsewhere, { lang: "fr", blocker: { kind: "in_app", app: "Telegram" }, ua: IPHONE_WEBVIEW }));
    expect(fr).toContain("Ouvre ce lien dans Safari ou Chrome");
    expect(fr).toContain("Telegram ouvre les liens dans son propre navigateur");
    expect(fr).toContain("Ouvrir dans Safari");
    expect(fr).toContain("Copier le lien");
    const en = renderToStaticMarkup(createElement(OpenElsewhere, { lang: "en", blocker: { kind: "in_app", app: null }, ua: ANDROID_WEBVIEW }));
    expect(en).toContain("Open this link in Safari or Chrome");
    expect(en).toContain("This in-app browser cannot use your passkey.");
    expect(en).toContain("Open in Chrome");
    expect(en).toContain("Copy the link");
    const old = renderToStaticMarkup(createElement(OpenElsewhere, { lang: "en", blocker: { kind: "no_webauthn" }, ua: ANDROID_CHROME }));
    expect(old).toContain("does not support passkeys");
    expect(old).not.toContain("Open in Chrome");
  });

  it("appareil sans passkey (session par code mail) : chemin vers un appareil de confiance, jamais « ouvre sur ton téléphone »", () => {
    for (const lang of ["fr", "en"] as const) {
      for (const key of ["loginOnly", "noDevice"] as const) {
        const txt = raText(lang, key);
        expect(txt).toMatch(lang === "fr" ? /Mini App Telegram/ : /Telegram Mini App/);
        expect(txt).toMatch(/passkey/);
        expect(txt).not.toMatch(/sur ton téléphone|on your phone/);
      }
    }
  });

  it("refus du défi de session : codes stables du noyau", () => {
    const err = (status: number, error: unknown): NokkerApiError => new NokkerApiError("x", status, { error });
    expect(deviceRefusal(err(404, { message: "d", code: "device_unknown" }))).toBe("forget");
    const pending = deviceRefusal(err(400, { message: "m", code: "device_not_approved", device_status: "pending" }));
    expect(pending).toBeInstanceOf(DeviceNotApprovedError);
    expect((pending as DeviceNotApprovedError).deviceStatus).toBe("pending");
    expect((deviceRefusal(err(400, { message: "m", code: "device_not_approved", device_status: "revoked" })) as DeviceNotApprovedError).deviceStatus).toBe("revoked");
    // Ancien noyau, sans code : 401/403/404 oublient la clé comme avant ; une autre erreur remonte telle quelle.
    expect(deviceRefusal(err(403, { message: "m" }))).toBe("forget");
    expect(deviceRefusal(err(400, { message: "m" }))).toBeNull();
    expect(deviceRefusal(new Error("réseau"))).toBeNull();
  });

  it("carte forte sans passkey : renvoi vers la Mini App Telegram, FR et EN (lien du noyau à venir : message du bot)", () => {
    const t = { machineId: "mc_atelier", approvalId: "ap_1" };
    expect(miniAppApproveUrl(t)).toBeNull();
    const fr = renderToStaticMarkup(createElement(MiniAppBlock, { lang: "fr", target: t }));
    expect(fr).toContain("Signe dans Telegram");
    expect(fr).toContain("Mini App Telegram de Nokker");
    expect(fr).toContain("touche « Approuver »");
    expect(fr).not.toContain("<a ");
    const en = renderToStaticMarkup(createElement(MiniAppBlock, { lang: "en", target: t, heading: true }));
    expect(en).toContain('id="ra-title"');
    expect(en).toContain("Sign in Telegram");
    for (const lang of ["fr", "en"] as const) expect(raText(lang, "noDevice")).not.toMatch(/invitation/);
  });
});
