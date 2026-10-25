/**
 * Choix du déclencheur d'un agent (BUBBLES §9.5) : à la demande, planifié, une fois, alerte, webhook, ou à la réception
 * d'un mail (`mail:<filtre>`, relève du courrier). Le filtre est contrôlé ici avant l'envoi ; le noyau reste seul juge
 * (relève absente, boîte non reliée : il refuse à la création, au PATCH et à l'armement). Aussi : « Nouvel agent » et
 * l'état de la relève (`mail_watch`).
 */
import React, { useState } from "react";
import { NokkerApiError, type Agent, type AgentMailWatch, type AgentTrigger, type NokkerClient } from "@nokker-apps/sdk";
import { checkMailFilter, filterReason, m, mailTriggerError, watchLines, whenText, type Lang } from "./mail.js";
import { cw } from "./i18n.js";
import "./mail.css";

type Kind = "manual" | "schedule" | "once" | "alert" | "webhook" | "mail";
const KINDS: Kind[] = ["manual", "schedule", "once", "alert", "webhook", "mail"];

interface Draft {
  kind: Kind;
  cron: string;
  tz: string;
  at: string;
  alert: string;
  webhook: string;
  filter: string;
  any: boolean;
}

/** Le brouillon du formulaire à partir d'un déclencheur existant. */
export function draftOf(t: AgentTrigger | undefined): Draft {
  const d: Draft = { kind: "manual", cron: "", tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", at: "", alert: "", webhook: "", filter: "", any: false };
  if (!t || t.kind === "manual") return d;
  if (t.kind === "schedule") return { ...d, kind: "schedule", cron: t.cron, tz: t.tz };
  if (t.kind === "once") return { ...d, kind: "once", at: toLocalInput(t.at) };
  const i = t.event.indexOf(":");
  const src = t.event.slice(0, i);
  const rest = t.event.slice(i + 1);
  if (src === "mail") return { ...d, kind: "mail", filter: rest === "*" ? "" : rest, any: rest === "*" };
  if (src === "webhook") return { ...d, kind: "webhook", webhook: rest };
  return { ...d, kind: "alert", alert: rest };
}

function toLocalInput(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}`;
}

/** Le déclencheur à envoyer, ou le texte de ce qui manque (rien n'est envoyé). */
export function triggerOf(lang: Lang, d: Draft): { trigger: AgentTrigger } | { error: string } {
  const need = (v: string): string | null => (v.trim() ? null : m(lang, "e_required"));
  switch (d.kind) {
    case "manual":
      return { trigger: { kind: "manual" } };
    case "schedule":
      return need(d.cron) ? { error: need(d.cron)! } : { trigger: { kind: "schedule", cron: d.cron.trim(), tz: d.tz.trim() || "UTC" } };
    case "once": {
      const t = new Date(d.at);
      return Number.isNaN(t.getTime()) ? { error: m(lang, "e_required") } : { trigger: { kind: "once", at: t.toISOString() } };
    }
    case "alert":
      return need(d.alert) ? { error: need(d.alert)! } : { trigger: { kind: "event", event: `alert:${d.alert.trim()}` } };
    case "webhook":
      return need(d.webhook) ? { error: need(d.webhook)! } : { trigger: { kind: "event", event: `webhook:${d.webhook.trim()}` } };
    case "mail": {
      const c = checkMailFilter(d.any ? "*" : d.filter);
      return c.ok ? { trigger: { kind: "event", event: `mail:${c.filter}` } } : { error: m(lang, "e_filter", { why: filterReason(lang, c) }) };
    }
  }
}

export function errorText(lang: Lang, e: unknown): string {
  const mail = mailTriggerError(lang, e);
  if (mail) return mail;
  if (e instanceof NokkerApiError) {
    const msg = (e.body as { error?: { message?: string } } | undefined)?.error?.message;
    return msg ?? cw(lang, "serverRefused", { status: e.status });
  }
  return cw(lang, "noServer");
}

export function TriggerFields({ lang, d, set, idp }: { lang: Lang; d: Draft; set: (p: Partial<Draft>) => void; idp: string }): React.ReactElement {
  const live = d.kind === "mail" && !d.any && d.filter.trim() ? checkMailFilter(d.filter) : null;
  return (
    <div className="trig-fields">
      <label htmlFor={`${idp}-kind`}>{m(lang, "kind")}</label>
      <select id={`${idp}-kind`} value={d.kind} onChange={(e) => set({ kind: e.target.value as Kind })}>
        {KINDS.map((k) => (
          <option key={k} value={k}>
            {m(lang, k)}
          </option>
        ))}
      </select>
      {d.kind === "schedule" ? (
        <div className="trig-row">
          <span>
            <label htmlFor={`${idp}-cron`}>{m(lang, "cron")}</label>
            <input id={`${idp}-cron`} className="mono" spellCheck={false} placeholder={m(lang, "cronPh")} value={d.cron} onChange={(e) => set({ cron: e.target.value })} />
          </span>
          <span>
            <label htmlFor={`${idp}-tz`}>{m(lang, "tz")}</label>
            <input id={`${idp}-tz`} spellCheck={false} value={d.tz} onChange={(e) => set({ tz: e.target.value })} />
          </span>
        </div>
      ) : null}
      {d.kind === "once" ? (
        <>
          <label htmlFor={`${idp}-at`}>{m(lang, "at")}</label>
          <input id={`${idp}-at`} type="datetime-local" value={d.at} onChange={(e) => set({ at: e.target.value })} />
        </>
      ) : null}
      {d.kind === "alert" ? (
        <>
          <label htmlFor={`${idp}-alert`}>{m(lang, "alertName")}</label>
          <input id={`${idp}-alert`} spellCheck={false} placeholder={m(lang, "alertPh")} value={d.alert} onChange={(e) => set({ alert: e.target.value })} />
        </>
      ) : null}
      {d.kind === "webhook" ? (
        <>
          <label htmlFor={`${idp}-wh`}>{m(lang, "webhookId")}</label>
          <input id={`${idp}-wh`} spellCheck={false} placeholder={m(lang, "webhookPh")} value={d.webhook} onChange={(e) => set({ webhook: e.target.value })} />
        </>
      ) : null}
      {d.kind === "mail" ? (
        <>
          <label className="trig-check">
            <input type="checkbox" checked={d.any} onChange={(e) => set({ any: e.target.checked })} /> {m(lang, "anyMail")}
          </label>
          {!d.any ? (
            <>
              <label htmlFor={`${idp}-filter`}>{m(lang, "filter")}</label>
              <input
                id={`${idp}-filter`}
                className="mono"
                autoCapitalize="none"
                spellCheck={false}
                placeholder={m(lang, "filterPh")}
                value={d.filter}
                onChange={(e) => set({ filter: e.target.value })}
                aria-describedby={`${idp}-filter-help`}
                aria-invalid={live && !live.ok ? true : undefined}
              />
              {live && !live.ok ? (
                <p className="fine error" role="alert">
                  {filterReason(lang, live)}
                </p>
              ) : null}
              <p id={`${idp}-filter-help`} className="fine">
                {m(lang, "filterHelp")}
              </p>
            </>
          ) : null}
          <p className="fine">{m(lang, "filterNote")}</p>
        </>
      ) : null}
    </div>
  );
}

/** « Modifier le déclencheur » dans la fiche d'un agent : PATCH `{trigger}`. */
export function TriggerEdit({ agent, client, lang, toast }: { agent: Agent; client: NokkerClient; lang: Lang; toast: (t: string, tone?: "ok" | "error") => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState<Draft>(() => draftOf(agent.trigger));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setD(draftOf(agent.trigger)), setError(null), setOpen(true))}>
        {m(lang, "edit")}
      </button>
    );
  const save = async (): Promise<void> => {
    const t = triggerOf(lang, d);
    if ("error" in t) return setError(t.error);
    setBusy(true);
    setError(null);
    try {
      const a = await client.patchAgent(agent.id, { trigger: t.trigger });
      toast(m(lang, a.status === "paused" && t.trigger.kind !== "manual" ? "savedPaused" : "saved"), "ok");
      setOpen(false);
    } catch (e) {
      setError(errorText(lang, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="trig-edit">
      <TriggerFields lang={lang} d={d} set={(p) => setD((x) => ({ ...x, ...p }))} idp={`trig-${agent.id}`} />
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <span className="crew-actions">
        <button type="button" className="btn btn-brass" disabled={busy} onClick={() => void save()}>
          {m(lang, "save")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          {m(lang, "cancel")}
        </button>
      </span>
    </div>
  );
}

/** « Nouvel agent » en tête du Crew : nom, mission, déclencheur (POST /v1/agents). */
export function NewAgent({ client, lang, toast, onDone }: { client: NokkerClient; lang: Lang; toast: (t: string, tone?: "ok" | "error") => void; onDone: () => void }): React.ReactElement {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [d, setD] = useState<Draft>(() => draftOf(undefined));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const t = triggerOf(lang, d);
    if ("error" in t) return setError(t.error);
    setBusy(true);
    setError(null);
    try {
      const a = await client.createAgent({ name: name.trim(), role: role.trim(), instructions: role.trim(), trigger: t.trigger });
      toast(m(lang, a.status === "paused" ? "createdPaused" : "created", { name: a.name }), "ok");
      onDone();
    } catch (e2) {
      setError(errorText(lang, e2));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="trig-new-wrap">
      <form className="trig-new" onSubmit={(e) => void submit(e)} aria-label={m(lang, "newAgent")}>
        <label htmlFor="na-name">{m(lang, "name")}</label>
        <input id="na-name" required placeholder={m(lang, "namePh")} value={name} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="na-role">{m(lang, "role")}</label>
        <textarea id="na-role" required rows={2} placeholder={m(lang, "rolePh")} value={role} onChange={(e) => setRole(e.target.value)} />
        <TriggerFields lang={lang} d={d} set={(p) => setD((x) => ({ ...x, ...p }))} idp="na" />
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <span className="crew-actions">
          <button type="submit" className="btn btn-brass" disabled={busy || !name.trim() || !role.trim()}>
            {m(lang, "create")}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onDone}>
            {m(lang, "cancel")}
          </button>
        </span>
      </form>
    </div>
  );
}

/** État de la relève du courrier d'un agent `mail:` (`mail_watch`), sans identifiant. */
export function MailWatchView({ lang, w }: { lang: Lang; w: AgentMailWatch }): React.ReactElement {
  const [head, ...rest] = watchLines(lang, w, (iso) => whenText(lang, iso));
  return (
    <span className={`mail-watch mw-${w.state}`}>
      <strong>{head}</strong>
      {rest.map((l) => (
        <span key={l} className="fine">
          {l}
        </span>
      ))}
      {w.state === "error" && w.error ? (
        <span className="error" role="alert">
          {w.error}
        </span>
      ) : null}
    </span>
  );
}
