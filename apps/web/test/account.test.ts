import { describe, expect, it } from "vitest";
import type { AccountUsage, BillingStatus } from "@nokker-apps/sdk";
import { billingView, fmtReset, monthTurns, planLabel, softOver, STATUS_KEYS, todayRows, usageLevel, usagePct, weekRows } from "../src/account/usage.js";
import { NokkerApiError } from "@nokker-apps/sdk";
import { errorCode, keyForCode } from "../src/onboarding/errors.js";
import { deletionGranted, suspendedError } from "../src/account/lifecycle.js";
import { t } from "../src/onboarding/i18n.js";
import { deleteOutcome, exportIssue, fmtSize, signOutDevice } from "../src/account/lifecycle.js";

const usage = (over: Partial<AccountUsage> = {}): AccountUsage => ({
  mode: "soft",
  today: { day: "2026-10-28", turns: { used: 37, cap: 50 } },
  ...over,
});

describe("usage vs plafonds", () => {
  it("pourcentage borné, plafond nul = plein, sans plafond = null", () => {
    expect(usagePct(37, 50)).toBe(74);
    expect(usagePct(80, 50)).toBe(100);
    expect(usagePct(0, 0)).toBe(100);
    expect(usagePct(12, null)).toBeNull();
  });

  it("seuils : ok < 80 %, warn dès 80 %, full à 100 %", () => {
    expect(usageLevel(79)).toBe("ok");
    expect(usageLevel(80)).toBe("warn");
    expect(usageLevel(100)).toBe("full");
    expect(usageLevel(null)).toBe("ok");
  });

  it("tolère l'absence de browser, de week et de month, et un cap null (locataire interne)", () => {
    expect(todayRows(usage()).map((r) => r.key)).toEqual(["turns"]);
    expect(weekRows(usage())).toEqual([]);
    expect(monthTurns(usage())).toBeNull();
    const internal = todayRows(usage({ today: { day: "d", turns: { used: 3, cap: null }, browser: { used: 1, cap: null } } }));
    expect(internal.map((r) => r.key)).toEqual(["turns", "browser"]);
    expect(internal.every((r) => r.pct === null && r.level === "ok" && !r.over)).toBe(true);
    expect(monthTurns(usage({ month: { turns: { used: 412 } } }))).toBe(412);
  });

  it("mode soft : le dépassement ne passe jamais au rouge et se signale ; mode hard : plein = rouge", () => {
    const over = usage({ today: { day: "d", turns: { used: 61, cap: 50, over: true, hard_cap: 150 } } });
    expect(todayRows(over)[0]).toMatchObject({ pct: 100, over: true, level: "warn" });
    expect(softOver(over)).toBe(true);
    expect(softOver(usage())).toBe(false);
    const hard = { ...over, mode: "hard" as const };
    expect(todayRows(hard)[0].level).toBe("full");
    expect(softOver(hard)).toBe(false);
  });

  it("semaine : mêmes règles, over déduit de used > cap si le noyau ne l'envoie pas", () => {
    const w = usage({ week: { starts: "2026-10-26", resets_at: "2026-11-02T00:00:00+01:00", turns: { used: 260, cap: 250 } } });
    expect(weekRows(w)[0]).toMatchObject({ over: true, pct: 100 });
  });
})

describe("échéances de remise à zéro", () => {
  it("heure de Zurich, avec le jour pour la semaine, rien sans échéance", () => {
    expect(fmtReset("fr", "2026-10-26T12:00:00Z", false)).toBe("13:00");
    expect(fmtReset("fr", "2026-11-02T06:00:00Z", true)).toMatch(/lundi.*07:00/);
    expect(fmtReset("fr", undefined, false)).toBeNull();
    expect(fmtReset("fr", "pas une date", true)).toBeNull();
  });
});

describe("abonnement", () => {
  const base: BillingStatus = { plan: null, status: null, current_period_end: null, cancel_at_period_end: false, plans: [] };
  it("sans formule vivante → none ; sinon formule, statut, échéance", () => {
    expect(billingView(base)).toEqual({ kind: "none" });
    expect(billingView({ ...base, plan: "solo", status: "past_due", current_period_end: "2026-11-20T00:00:00Z", cancel_at_period_end: true })).toEqual({
      kind: "subscribed",
      plan: "solo",
      status: "past_due",
      periodEnd: "2026-11-20T00:00:00Z",
      cancelling: true,
    });
  });

  it("libellé de formule et statuts connus traduits dans les deux langues", () => {
    expect(planLabel("essentiel")).toBe("Essentiel");
    for (const key of new Set(Object.values(STATUS_KEYS))) {
      expect(t("fr", key)).not.toBe("");
      expect(t("en", key)).not.toBe("");
    }
  });
});

describe("suppression : ce que dit le noyau", () => {
  it("carte account_delete accordée = executed, ou approved encore en file ; jamais une autre carte", () => {
    expect(deletionGranted({ tool_name: "account_delete", status: "executed" })).toBe(true);
    expect(deletionGranted({ tool_name: "account_delete", status: "approved" })).toBe(true);
    expect(deletionGranted({ tool_name: "account_delete", status: "failed" })).toBe(false);
    expect(deletionGranted({ tool_name: "mail_send", status: "executed" })).toBe(false);
  });
  it("compte suspendu = n'importe quel 403 (forbidden, sans code dédié)", () => {
    expect(suspendedError(new NokkerApiError("x", 403, { error: { message: "forbidden" } }))).toBe(true);
    expect(suspendedError(new NokkerApiError("x", 401, {}))).toBe(false);
  });
});

describe("erreurs du compte", () => {
  it("lit la forme chaîne et la forme objet {error:{message}} ; un texte libre n'est pas un code", () => {
    expect(errorCode(new NokkerApiError("x", 429, { error: "export_limit" }))).toBe("export_limit");
    expect(errorCode(new NokkerApiError("x", 403, { error: { message: "strong_device_required" } }))).toBe("strong_device_required");
    expect(errorCode(new NokkerApiError("x", 500, { error: { message: "signature d'image invalide" } }))).toBe("http_500");
  });

  it("codes du noyau → messages, jamais le texte brut", () => {
    for (const code of ["strong_device_required", "already_subscribed", "no_customer", "export_limit", "export_expired", "export_disabled"]) {
      expect(keyForCode(code)).not.toBe("errGeneric");
    }
  });
});

describe("export et suppression", () => {
  it("export_limit porte retry_at, export_expired (410) a son état, le reste est « autre »", () => {
    const limit = new NokkerApiError("x", 429, { error: "export_limit", retry_at: "2026-10-30T09:00:00Z" });
    expect(exportIssue(limit)).toEqual({ kind: "limit", retryAt: "2026-10-30T09:00:00Z" });
    expect(exportIssue(new NokkerApiError("x", 410, { error: "export_expired" }))).toEqual({ kind: "expired" });
    expect(exportIssue(new NokkerApiError("x", 503, { error: "export_disabled" }))).toEqual({ kind: "other" });
    expect(exportIssue(new TypeError("fetch"))).toEqual({ kind: "other" });
    expect(keyForCode(errorCode(new NokkerApiError("x", 503, { error: "export_disabled" })))).toBe("errExportDisabled");
  });

  it("strong_device_required se lit sur le CODE, pas sur le texte", () => {
    const weak = new NokkerApiError("x", 403, { error: { message: "preuve trop faible", code: "strong_device_required" } });
    expect(errorCode(weak)).toBe("strong_device_required");
    expect(keyForCode(errorCode(weak))).toBe("errStrongDevice");
  });

  it("carte de suppression : accordée, en attente, ou morte", () => {
    expect(deleteOutcome("executed")).toBe("granted");
    expect(deleteOutcome("approved")).toBe("granted");
    expect(deleteOutcome("pending")).toBe("waiting");
    for (const s of ["rejected", "expired"] as const) expect(deleteOutcome(s)).toBe("dead");
    expect(deleteOutcome("failed")).toBe("failed");
  });

  it("taille lisible", () => {
    expect(fmtSize("fr", 48_213)).toMatch(/^48,2\s?Ko$/);
    expect(fmtSize("en", 512)).toBe("512 B");
  });
});

describe("se déconnecter", () => {
  const spy = () => {
    const calls: string[] = [];
    return { calls, client: { deleteDevice: async (id: string) => void calls.push(`delete:${id}`) }, forget: async () => void calls.push("forget") };
  };
  it("retire l'appareil du compte puis oublie sa clé", async () => {
    const s = spy();
    await signOutDevice(s.client, async () => ({ deviceId: "dev_1" }), s.forget);
    expect(s.calls).toEqual(["delete:dev_1", "forget"]);
  });
  it("oublie la clé même si le serveur ne répond pas", async () => {
    const calls: string[] = [];
    await signOutDevice({ deleteDevice: () => Promise.reject(new Error("offline")) }, async () => ({ deviceId: "dev_1" }), async () => void calls.push("forget"));
    expect(calls).toEqual(["forget"]);
  });
  it("sans appareil rangé : rien à retirer, on oublie quand même", async () => {
    const s = spy();
    await signOutDevice(s.client, async () => undefined, s.forget);
    expect(s.calls).toEqual(["forget"]);
  });
  it("textes FR/EN présents", () => {
    for (const l of ["fr", "en"] as const) for (const k of ["accSignOut", "accSignOutBody", "accSignOutBtn"] as const) expect(t(l, k)).not.toBe(k);
  });
});
