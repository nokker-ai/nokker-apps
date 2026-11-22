import { describe, expect, it } from "vitest";
import { sitesLink } from "../src/sites/links.js";
import { quotaLine, signalText, stateText } from "../src/sites/ConnectedSites.js";

// Table des signaux du §15 (noyau bb936b3, nokker/sites/model.py SIGNAL_TEXT).
const SIGNALS = ["password_timeout", "code_timeout", "wrong_code", "code_rejected", "approval_timeout", "link_timeout", "link_other_site", "handoff_timeout", "captcha", "unknown_screen", "unusual_activity", "bad_credentials", "too_many_logins", "too_many_steps", "login_page_changed", "cancelled", "browser_missing", "busy", "internal"];
const BANNED = /\b(cookies?|sessions?|captcha|2fa|vnc|jetons?|tokens?)\b/i;

describe("sites connectés (web)", () => {
  it("liens /sites/r/<rid> et /sites/h/<jeton> ; rien d'autre", () => {
    expect(sitesLink("/sites/r/rq_abc123def456")).toEqual({ kind: "request", id: "rq_abc123def456" });
    expect(sitesLink("/sites/h/abcdefghij0123456789wxyz/")).toEqual({ kind: "handoff", id: "abcdefghij0123456789wxyz" });
    for (const p of ["/sites/r/", "/sites/x/abcdefgh", "/sites/r/a%2Fb", "/sites/r/ab", "/sites/r/abcdefgh/extra"]) expect(sitesLink(p)).toBeNull();
  });
  it("chaque signal a son texte, en français et en anglais, sans mot technique", () => {
    for (const sig of SIGNALS) {
      for (const L of ["fr", "en"] as const) {
        const txt = signalText(L, sig);
        expect(txt, `${L} ${sig}`).not.toMatch(/^stSig_/);
        expect(txt).not.toMatch(BANNED);
      }
    }
    expect(signalText("fr", "")).toBe("raison non précisée");
    expect(signalText("en", "code_inconnu")).toBe("reason not given");
    expect(stateText("fr", { state: "failed", signal: "cancelled", paused_until: null })).toBe("Connexion abandonnée : annulée à la demande");
    expect(stateText("en", { state: "paused", signal: "unusual_activity", paused_until: 1_800_000_000 })).toMatch(/^Paused until .* \(unusual activity reported by the site\)$/);
  });
  it("quotas du jour : les pages toujours, les autres compteurs seulement s'ils servent", () => {
    const q = { pages: { used: 12, max: 150 }, searches: { used: 0, max: 25 }, messages: { used: 2, max: 20 }, logins: { used: 1, max: 2 } };
    expect(quotaLine("fr", { quotas: q })).toBe("Pages : 12 sur 150 · Messages : 2 sur 20");
  });
});
