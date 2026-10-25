import { describe, expect, it } from "vitest";
import { NokkerApiError } from "@nokker-apps/sdk";
import { TEXTS, checkMailFilter, filterReason, mailTriggerError, watchLines } from "../src/crew/mail.js";
import { triggerLabel } from "../src/crew/model.js";
import { draftOf, errorText, triggerOf } from "../src/crew/TriggerEditor.js";

// Textes exacts du noyau (nokker/agents/spec.py NO_MAIL_TRIGGER, nokker/agents/mailwatch.py NO_MAILBOX, train 30886a3).
const NO_MAIL_TRIGGER =
  "trigger.event mail:<filtre> : pas disponible (aucune relève du courrier ne déclenche un agent, il ne tournerait jamais) — à la place : un déclencheur schedule dont la mission lit la boîte (mail_search), ou webhook:<id> appelé par le service de courrier";
const NO_MAILBOX = "trigger.event mail:<filtre> : aucune boîte mail reliée à ce compte — relier la boîte d'abord (Connecteurs), la relève lit celle-là";

const err400 = (message: string, code?: string) => new NokkerApiError("x", 400, { error: { message, ...(code ? { code } : {}) } });

describe("déclencheur mail: (Crew) : modèle de l'écran", () => {
  it("FR et EN ont les mêmes clés", () => {
    expect(Object.keys(TEXTS.en).sort()).toEqual(Object.keys(TEXTS.fr).sort());
  });

  it("le contrôle local tranche comme parse_mail_filter du noyau, et normalise pareil", () => {
    // [filtre saisi, filtre normalisé par le noyau | null = refusé en 400]
    const cases: [string, string | null][] = [
      ["*", "*"],
      ["from:factures@example.com", "from:factures@example.com"],
      ['  subject:"facture octobre"   -is:read  ', 'subject:"facture octobre" -is:read'],
      ["urgent -from:robot@example.com is:unread", "urgent -from:robot@example.com is:unread"],
      ["", null],
      ["after:2026-10-01", null],
      ["label:travail", null],
      ["a OR b", null],
      ["(a)", null],
      ['subject:"oops', null],
      ["is:flagged", null],
      ["a b c d e f g h i", null],
      ["x * y", null],
      ["size:10", null],
      ["to:", null],
      ["\u0007bip", null],
    ];
    for (const [f, kernel] of cases) {
      const local = checkMailFilter(f);
      expect(local.ok ? local.filter : null, JSON.stringify(f)).toBe(kernel);
    }
  });

  it("raisons du refus local, dans les deux langues", () => {
    const r = checkMailFilter("in:archive");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(filterReason("fr", r)).toContain("boîte de réception");
      expect(filterReason("en", r)).toContain("inbox");
    }
  });

  it("refus du noyau reconnus par leur code (train 5fe8785) et traduits", () => {
    // Le code prime : même un message reformulé est reconnu.
    expect(mailTriggerError("fr", err400("autre texte", "no_mail_trigger"))).toBe(TEXTS.fr.e_no_trigger);
    expect(mailTriggerError("en", err400("autre texte", "mailbox_unlinked"))).toBe(TEXTS.en.e_no_mailbox);
    expect(mailTriggerError("fr", err400("trigger.event mail:<filtre> : 8 termes au plus", "bad_mail_filter"))).toBe("Filtre refusé : 8 termes au plus");
    expect(mailTriggerError("en", err400(NO_MAILBOX, "mailbox_unlinked"))).toBe(TEXTS.en.e_no_mailbox);
    // Un autre code n'est pas un refus du déclencheur mail, même si le texte y ressemble.
    expect(mailTriggerError("fr", err400(NO_MAILBOX, "other_code"))).toBeNull();
  });

  it("repli : noyau d'avant les codes, refus reconnus à leur texte", () => {
    expect(mailTriggerError("fr", err400(NO_MAIL_TRIGGER))).toBe(TEXTS.fr.e_no_trigger);
    expect(mailTriggerError("en", err400(NO_MAIL_TRIGGER))).toBe(TEXTS.en.e_no_trigger);
    expect(mailTriggerError("fr", err400(NO_MAILBOX))).toBe(TEXTS.fr.e_no_mailbox);
    expect(mailTriggerError("en", err400(`${NO_MAILBOX} (imap_auth)`))).toBe(TEXTS.en.e_no_mailbox);
    expect(mailTriggerError("fr", err400("trigger.event mail:<filtre> : guillemet non fermé"))).toBe("Filtre refusé : guillemet non fermé");
    expect(mailTriggerError("fr", err400("trigger invalide"))).toBeNull();
    expect(mailTriggerError("fr", new NokkerApiError("x", 409, { error: { message: NO_MAILBOX } }))).toBeNull();
    expect(errorText("fr", err400("trigger invalide"))).toBe("trigger invalide");
  });

  it("brouillon ↔ déclencheur, pour chaque genre", () => {
    const t = (x: Parameters<typeof draftOf>[0]) => triggerOf("fr", draftOf(x));
    expect(t({ kind: "event", event: "mail:from:a@example.com is:unread" })).toEqual({ trigger: { kind: "event", event: "mail:from:a@example.com is:unread" } });
    expect(t({ kind: "event", event: "mail:*" })).toEqual({ trigger: { kind: "event", event: "mail:*" } });
    expect(t({ kind: "event", event: "webhook:facturation" })).toEqual({ trigger: { kind: "event", event: "webhook:facturation" } });
    expect(t({ kind: "event", event: "alert:DiskAlmostFull" })).toEqual({ trigger: { kind: "event", event: "alert:DiskAlmostFull" } });
    expect(t({ kind: "schedule", cron: "0 7 * * 1-5", tz: "Europe/Zurich" })).toEqual({ trigger: { kind: "schedule", cron: "0 7 * * 1-5", tz: "Europe/Zurich" } });
    expect(t({ kind: "manual" })).toEqual({ trigger: { kind: "manual" } });
    const once = t({ kind: "once", at: "2026-11-02T07:00:00Z" });
    expect("trigger" in once && once.trigger.kind === "once" && Date.parse(once.trigger.at)).toBe(Date.parse("2026-11-02T07:00:00Z"));
    // Rien n'est envoyé quand il manque quelque chose : le texte dit quoi.
    expect(triggerOf("fr", { ...draftOf(undefined), kind: "mail", filter: "", any: false })).toEqual({ error: "Filtre refusé : filtre vide (* = tout nouveau message)" });
    expect(triggerOf("en", { ...draftOf(undefined), kind: "schedule", cron: " " })).toEqual({ error: "Required field." });
  });

  it("libellé et état de la relève", () => {
    expect(triggerLabel({ kind: "event", event: "mail:*" }, "fr")).toBe("à chaque mail reçu");
    expect(triggerLabel({ kind: "event", event: "mail:from:a@example.com" }, "en")).toBe("when a mail arrives (from:a@example.com)");
    const at = (iso: string) => iso.slice(11, 16);
    expect(watchLines("fr", { state: "off", folder: "INBOX", poll_s: 120, max_runs_per_hour: 12 }, at)).toEqual(["à l'arrêt (agent au repos)", "toutes les 120 s, INBOX"]);
    expect(
      watchLines("en", { state: "ok", folder: "INBOX", poll_s: 120, max_runs_per_hour: 12, runs_last_hour: 2, pending: 3, held: "un passage est en cours", last_poll_at: "2026-10-25T10:00:00Z", next_poll_at: "2026-10-25T10:02:00Z" }, at),
    ).toEqual(["running", "every 120 s, INBOX", "last check 10:00", "next 10:02", "3 message(s) waiting (un passage est en cours)", "2 of 12 run(s) this hour"]);
  });
});

describe("onglet Crew en anglais", () => {
  it("FR et EN ont les mêmes clés ; libellés d'état et de passage", async () => {
    const { CREW_TEXTS, statusLabel } = await import("../src/crew/i18n.js");
    const { cronLabel, runCost, runStatusLabel, triggerLabel } = await import("../src/crew/model.js");
    const { ageLabel, loadSummary, moveTargets, sessionStateLabel } = await import("../src/crew/deckModel.js");
    expect(Object.keys(CREW_TEXTS.en).sort()).toEqual(Object.keys(CREW_TEXTS.fr).sort());
    expect(statusLabel("fr", "paused")).toBe("Au repos");
    expect(statusLabel("en", "failed")).toBe("Failing");
    expect(cronLabel("0 7 * * 1-5", "en")).toBe("every workday at 07:00");
    expect(cronLabel("0 9 * * 1", "en")).toBe("every Monday at 09:00");
    expect(cronLabel("0 8 1 * *", "en")).toBe("on day 1 of every month at 08:00");
    expect(triggerLabel({ kind: "event", event: "alert:disk-full" }, "en")).toBe("on alert “disk-full”");
    expect(triggerLabel(undefined, "en")).toBe("on demand");
    expect(runStatusLabel("waiting_approval", "en")).toBe("waiting for your go-ahead");
    expect(runCost({ cost: { tokens_in: 1, tokens_out: 1, amount: 0.5, currency: "EUR", calls: 1 } }, "en")).toBe("0.50 EUR · 1 call");
    expect(ageLabel(150, "en")).toBe("2 min ago");
    expect(sessionStateLabel("awaiting_approval", "en")).toBe("waiting for a decision");
    expect(moveTargets([{ machine_id: "mc_b", name: "Laptop", online: false }], null, "en").map((t) => t.label)).toEqual(["Automatic (the least loaded machine)", "Laptop (offline)"]);
    const l = loadSummary({ ram: { total_mb: 32768, free_mb: 8192 }, cpu: { count: 16, load1: 8, rel: 0.5 }, gpus: [], sessions: 1, active_turns: 0 }, "en");
    expect(l?.text).toBe("8.0 GB free of 32 · CPU 50 %");
  });
});
