import { describe, expect, it } from "vitest";
import { shortVersion, termsVersionLabel } from "../src/account/terms.js";
import { cleanAccountUrl, readBillingReturn, ACCOUNT_PATHS } from "../src/account/links.js";
import { chfOnly } from "../src/account/cost.js";
import { formatCostLine } from "@nokker-apps/sdk";

describe("version lisible des conditions", () => {
  it("lit la ligne « **Version … ** » en tête du texte", () => {
    expect(termsVersionLabel("# Nokker — Conditions\n\n**Version 2 — 28 octobre 2026**\n\n## 1. Qui")).toBe("2 — 28 octobre 2026");
    expect(termsVersionLabel("# Nokker — Private beta terms\n\n**Version 2 — 28 October 2026**\n")).toBe("2 — 28 October 2026");
  });
  it("rien sans ligne de version ; empreinte raccourcie", () => {
    expect(termsVersionLabel("# Titre\n\nTexte sans version.")).toBeNull();
    expect(shortVersion("f1f2588c4bfebe4eb941d3d0f2a74ca688012d9624cff33b5d01bad64859cf7d")).toBe("f1f2588c…");
    expect(shortVersion("v2")).toBe("v2");
  });
});

describe("liens vers Mon compte", () => {
  it("reconnaît le retour de Stripe", () => {
    expect(readBillingReturn("?billing=cancel")).toBe("cancel");
    expect(readBillingReturn("?billing=success")).toBe("success");
    expect(readBillingReturn("?billing=other")).toBeNull();
    expect(readBillingReturn("")).toBeNull();
    expect(ACCOUNT_PATHS.has("/account") && ACCOUNT_PATHS.has("/pricing")).toBe(true);
  });
  it("revient à « / » sans billing, garde le reste et le hash", () => {
    expect(cleanAccountUrl("?billing=cancel", "")).toBe("/");
    expect(cleanAccountUrl("?billing=success&wise=kyc", "#/t/th_1")).toBe("/?wise=kyc#/t/th_1");
  });
});

describe("coût du tour en CHF sur nokker.ai", () => {
  it("garde le CHF, n'affiche pas un montant dans une autre devise", () => {
    expect(formatCostLine(chfOnly({ total_tokens: 6200, cost: { USD: 0.004 } }), "fr")).toBe("6,2 k jetons");
    expect(formatCostLine(chfOnly({ total_tokens: 6200, cost: { USD: 0.004, CHF: 0.03 } }), "fr")).toBe("6,2 k jetons · 0.03\u00a0CHF");
    expect(formatCostLine(chfOnly({ total_tokens: 6200, cost: null }), "fr")).toBe("6,2 k jetons");
    // Noyau 6aaccb4 : cost_chf calculé par le noyau ; null = pas de taux.
    expect(formatCostLine(chfOnly({ total_tokens: 6200, cost: { USD: 0.04 }, cost_chf: 0.0356 }), "fr")).toBe("6,2 k jetons · 0.04\u00a0CHF");
    expect(formatCostLine(chfOnly({ total_tokens: 6200, cost: { EUR: 0.04 }, cost_chf: null }), "fr")).toBe("6,2 k jetons");
  });
});
