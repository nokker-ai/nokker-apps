import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient, type Agent } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";
import { NO_MAIL_TRIGGER, NO_MAILBOX, parseMailFilter } from "../src/mailwatch.js";

let mock: MockServerHandle;
afterEach(async () => {
  await mock?.close();
});
async function boot(crewMail?: "on" | "off" | "nobox"): Promise<NokkerClient> {
  mock = await startMockServer({ speed: 0.01, ...(crewMail ? { crewMail } : {}) });
  const c = new NokkerClient({ baseUrl: mock.url });
  await c.demoSessionMockExtension();
  return c;
}
const refusal = async (p: Promise<unknown>): Promise<{ status: number; message?: string; code?: unknown }> => {
  try {
    await p;
    return { status: 200 };
  } catch (e) {
    if (!(e instanceof NokkerApiError)) return { status: -1 };
    const err = (e.body as { error?: { message?: string; code?: unknown } }).error;
    return { status: e.status, message: err?.message, code: err?.code };
  }
};
const dev = (body: Record<string, unknown>): Promise<Response> =>
  fetch(`${mock.url}/v1/dev/crew-mail`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const mailAgent = (c: NokkerClient, event = "mail:from:factures@example.com subject:facture"): Promise<Agent> =>
  c.createAgent({ name: "Tri des factures", role: "Classe les factures reçues.", trigger: { kind: "event", event } });

describe("déclencheur mail: du Crew (BUBBLES §9.5 « Courrier »)", () => {
  it("filtre : le sous-ensemble sûr du noyau, normalisé, refus avec la raison", () => {
    expect(parseMailFilter("  from:a@example.com   subject:\"facture octobre\"  -is:read ")).toBe('from:a@example.com subject:"facture octobre" -is:read');
    expect(parseMailFilter("*")).toBe("*");
    const why = (f: string): string => {
      try {
        parseMailFilter(f);
        return "accepté";
      } catch (e) {
        return (e as Error).message.replace("trigger.event mail:<filtre> : ", "");
      }
    };
    expect(why("")).toBe("filtre vide (mail:* = tout nouveau message)");
    expect(why("after:2026-10-01")).toContain("« after: » refusé");
    expect(why("in:archive")).toContain("INBOX");
    expect(why("from:a OR from:b")).toContain("pas de OR");
    expect(why("(facture)")).toContain("parenthèse");
    expect(why('subject:"facture')).toBe("guillemet non fermé");
    expect(why("is:flagged")).toContain("is:unread, is:read ou is:starred");
    expect(why("a b c d e f g h i")).toBe("8 termes au plus");
    expect(why("x * y")).toBe("* s'emploie seul (mail:*)");
    expect(why("size:10")).toContain("hors du sous-ensemble");
  });

  it("création : filtre normalisé, au repos ; mail_watch off puis waiting à l'armement", async () => {
    const c = await boot();
    const a = await mailAgent(c, "mail:  from:factures@example.com   is:unread ");
    expect(a.trigger).toEqual({ kind: "event", event: "mail:from:factures@example.com is:unread" });
    expect(a.status).toBe("paused");
    expect(a.mail_watch).toMatchObject({ state: "off", folder: "INBOX", poll_s: 120, max_runs_per_hour: 12 });
    const armed = (await c.armAgent(a.id)) as Agent;
    expect(armed.status).toBe("armed");
    expect(armed.mail_watch).toMatchObject({ state: "waiting", runs_last_hour: 0, pending: 0, error: null });
    // Pas de mail_watch pour un autre déclencheur.
    const other = await c.createAgent({ name: "Veille", role: "Lit les alertes.", trigger: { kind: "event", event: "alert:DiskAlmostFull" } });
    expect(other.mail_watch).toBeUndefined();
  });

  it("relève : ok avec un passage déclenché par le mail, erreur caviardée, désarmer l'arrête", async () => {
    const c = await boot();
    const a = await mailAgent(c);
    await c.armAgent(a.id);
    await dev({ agent: a.id, state: "ok", fire: true });
    const runs = (await c.listAgentRuns(a.id)).runs;
    expect(runs[0]).toMatchObject({ trigger: "event", event: "mail:from:factures@example.com subject:facture" });
    const ok = await c.getAgent(a.id);
    expect(ok.mail_watch).toMatchObject({ state: "ok", runs_last_hour: 1 });
    expect(ok.mail_watch?.last_poll_at).toBeTruthy();
    await dev({ agent: a.id, state: "error" });
    const ko = await c.getAgent(a.id);
    expect(ko.mail_watch?.state).toBe("error");
    expect(ko.mail_watch?.error).toMatch(/^imap_auth/);
    // Le passage de démo se termine (≈ 30 ms à cette vitesse) avant le désarmement.
    for (let i = 0; i < 50 && (await c.getAgent(a.id)).status === "running"; i++) await new Promise((r) => setTimeout(r, 20));
    const off = await c.disarmAgent(a.id);
    expect(off.mail_watch?.state).toBe("off");
  });

  it("refus du noyau au mot près, avec leur code stable : filtre, relève absente, boîte non reliée", async () => {
    const c = await boot();
    const bad = await refusal(mailAgent(c, "mail:label:travail"));
    expect(bad).toMatchObject({ status: 400, message: expect.stringMatching(/^trigger\.event mail:<filtre> : critère « label: » refusé/) });
    expect(bad.code).toBe("bad_mail_filter");
    await dev({ watch: "off" });
    expect(await refusal(mailAgent(c))).toEqual({ status: 400, message: NO_MAIL_TRIGGER, code: "no_mail_trigger" });
    await dev({ watch: "nobox" });
    expect(await refusal(mailAgent(c))).toEqual({ status: 400, message: NO_MAILBOX, code: "mailbox_unlinked" });
    // Les autres 400 des agents n'ont pas de code.
    expect((await refusal(c.createAgent({ name: "x", role: "y", trigger: { kind: "event", event: "nope" } }))).code).toBeUndefined();
  });

  it("PATCH vers mail: vérifié comme la création ; armer re-vérifie la relève", async () => {
    const c = await boot();
    const a = await c.createAgent({ name: "Tri", role: "Classe.", trigger: { kind: "manual" } });
    const p = await c.patchAgent(a.id, { trigger: { kind: "event", event: "mail:*" } });
    expect(p.trigger).toEqual({ kind: "event", event: "mail:*" });
    expect(p.status).toBe("paused");
    expect((await refusal(c.patchAgent(a.id, { trigger: { kind: "event", event: "mail:a OR b" } }))).message).toContain("pas de OR");
    await dev({ watch: "nobox" });
    expect(await refusal(c.armAgent(a.id))).toEqual({ status: 400, message: NO_MAILBOX, code: "mailbox_unlinked" });
  });

  it("écriture levée refusée pour un agent déclenché par un mail", async () => {
    const c = await boot();
    const r = await refusal(c.createAgent({ name: "Répond", role: "Répond aux mails.", auto_approve: ["mail_send"], trigger: { kind: "event", event: "mail:*" } }));
    expect(r.status).toBe(400);
  });
});
