import React, { useCallback, useEffect, useRef, useState } from "react";
import type { AccountExportStatus, AccountInfo, AccountUsage, BillingStatus, Device, NokkerClient } from "@nokker-apps/sdk";
import { billingView, fmtReset, monthTurns, planLabel, softOver, STATUS_KEYS, todayRows, weekRows, type UsageRow } from "../account/usage.js";
import { ConnectorsStep, TelegramStep } from "../onboarding/Connectors.js";
import { errorCode, errorKey } from "../onboarding/errors.js";
import { t, type Key, type Lang } from "../onboarding/i18n.js";

const fmtDate = (lang: Lang, iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(lang, { dateStyle: "long" }).format(d);
};

const USAGE_LABEL: Record<"turns" | "browser", Key> = { turns: "accTurns", browser: "accBrowser" };

function Fail({ lang, err }: { lang: Lang; err: unknown }): React.ReactElement | null {
  return err ? (
    <p className="ob-error" role="alert">
      {t(lang, errorKey(err))}
    </p>
  ) : null;
}

function UsageBar({ lang, r }: { lang: Lang; r: UsageRow }): React.ReactElement {
  const text =
    r.cap === null ? t(lang, "accNoCap", { used: String(r.used) }) : t(lang, "accUsedOf", { used: String(r.used), cap: String(r.cap) });
  return (
    <div className="acc-usage" data-level={r.level} data-over={r.over} data-usage={r.key}>
      <div className="acc-usage-head">
        <span>{t(lang, USAGE_LABEL[r.key])}</span>
        <span className="acc-usage-n">{text}</span>
      </div>
      {r.pct !== null ? (
        <div className="acc-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={r.pct} aria-label={t(lang, USAGE_LABEL[r.key])}>
          <div className="acc-bar-fill" style={{ width: `${r.pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function ConsentCard({ client, lang, initial }: { client: NokkerClient; lang: Lang; initial: boolean }): React.ReactElement {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const toggle = (next: boolean): void => {
    setErr(null);
    setBusy(true);
    client.setAccountConsent("training", next).then(
      (r) => {
        setOn(r.granted);
        setBusy(false);
      },
      (e) => {
        setErr(e);
        setBusy(false);
      },
    );
  };
  return (
    <section className="ob-conn" aria-labelledby="acc-consent">
      <h3 id="acc-consent">{t(lang, "accConsent")}</h3>
      <p className="ob-note">{t(lang, "accConsentIntro")}</p>
      <label className="ob-check">
        <input type="checkbox" checked={on} disabled={busy} data-consent="training" onChange={(e) => toggle(e.target.checked)} />
        <span>{t(lang, "accConsentLabel")}</span>
      </label>
      <p className="ob-status" role="status">
        {t(lang, on ? "accConsentOn" : "accConsentOff")}
      </p>
      <Fail lang={lang} err={err} />
    </section>
  );
}

function ProfileCard({ lang, info }: { lang: Lang; info: AccountInfo }): React.ReactElement {
  return (
    <section className="ob-conn" aria-labelledby="acc-profile">
      <h3 id="acc-profile">{t(lang, "accProfile")}</h3>
      <dl className="acc-dl">
        <dt>{t(lang, "accEmail")}</dt>
        <dd className="ob-account">{info.email}</dd>
        <dt>{t(lang, "accLang")}</dt>
        <dd>{info.lang.toUpperCase()}</dd>
        <dt>{t(lang, "accSince")}</dt>
        <dd>{fmtDate(lang, info.created_at)}</dd>
        <dt>{t(lang, "accTerms")}</dt>
        <dd>
          {info.terms
            ? t(lang, "accTermsLine", { version: info.terms.version, date: fmtDate(lang, info.terms.accepted_at) })
            : t(lang, "accTermsNone")}
        </dd>
      </dl>
    </section>
  );
}

function UsageCard({ lang, usage }: { lang: Lang; usage: AccountUsage }): React.ReactElement {
  const week = weekRows(usage);
  const month = monthTurns(usage);
  const dayReset = fmtReset(lang, usage.today.resets_at, false);
  const weekReset = fmtReset(lang, usage.week?.resets_at, true);
  return (
    <section className="ob-conn" aria-labelledby="acc-usage">
      <h3 id="acc-usage">{t(lang, "accUsage")}</h3>
      <h4 className="ob-sub">{t(lang, "accToday")}</h4>
      {todayRows(usage).map((r) => (
        <UsageBar key={r.key} lang={lang} r={r} />
      ))}
      {dayReset ? <p className="ob-note">{t(lang, "accReset", { when: dayReset })}</p> : null}
      {week.length ? (
        <>
          <h4 className="ob-sub">{t(lang, "accWeek")}</h4>
          {week.map((r) => (
            <UsageBar key={r.key} lang={lang} r={r} />
          ))}
          {weekReset ? <p className="ob-note">{t(lang, "accResetWeek", { when: weekReset })}</p> : null}
        </>
      ) : null}
      {softOver(usage) ? (
        <p className="ob-note" role="status" data-usage-soft>
          {t(lang, "accOverSoft")}
        </p>
      ) : null}
      {month !== null ? (
        <>
          <h4 className="ob-sub">{t(lang, "accMonth")}</h4>
          <div className="acc-usage" data-usage-month="turns">
            <div className="acc-usage-head">
              <span>{t(lang, "accTurns")}</span>
              <span className="acc-usage-n">{t(lang, "accUsedOnly", { used: String(month) })}</span>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}

function DevicesCard({ client, lang }: { client: NokkerClient; lang: Lang }): React.ReactElement {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const load = useCallback(() => {
    client.listDevices().then(setDevices, setErr);
  }, [client]);
  useEffect(load, [load]);
  const revoke = (id: string): void => {
    setErr(null);
    client.deleteDevice(id).then(() => {
      setConfirm(null);
      load();
    }, setErr);
  };
  return (
    <section className="ob-conn" aria-labelledby="acc-devices">
      <h3 id="acc-devices">{t(lang, "accDevices")}</h3>
      <Fail lang={lang} err={err} />
      {devices && devices.length === 0 ? <p className="ob-muted">{t(lang, "accDevicesNone")}</p> : null}
      <ul className="acc-list">
        {(devices ?? []).map((d) => (
          <li key={d.id} data-device={d.id}>
            <div>
              <strong>{d.name}</strong>
              <div className="ob-note">
                {t(lang, "accDeviceCode", { code: d.code })} · {t(lang, "accDeviceSince", { date: fmtDate(lang, d.created_at) })}
              </div>
            </div>
            {confirm === d.id ? (
              <button type="button" className="ob-btn danger" onClick={() => revoke(d.id)}>
                {t(lang, "revokeConfirm")}
              </button>
            ) : (
              <button type="button" className="ob-btn" onClick={() => setConfirm(d.id)}>
                {t(lang, "revoke")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SubscriptionCard({ client, lang, billing }: { client: NokkerClient; lang: Lang; billing: BillingStatus }): React.ReactElement {
  const view = billingView(billing);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const go = (p: Promise<{ url: string }>): void => {
    setErr(null);
    setBusy(true);
    p.then(
      ({ url }) => window.location.assign(url),
      (e) => {
        setErr(e);
        setBusy(false);
      },
    );
  };
  return (
    <section className="ob-conn" aria-labelledby="acc-sub">
      <div className="ob-conn-head">
        <h3 id="acc-sub">{t(lang, "accSub")}</h3>
        {view.kind === "subscribed" ? (
          <span className={`ob-badge ${view.status === "active" || view.status === "trialing" ? "ok" : "unverified"}`}>
            {STATUS_KEYS[view.status as keyof typeof STATUS_KEYS] ? t(lang, STATUS_KEYS[view.status as keyof typeof STATUS_KEYS]) : view.status}
          </span>
        ) : null}
      </div>
      <Fail lang={lang} err={err} />
      {view.kind === "subscribed" ? (
        <>
          <p>{t(lang, "accPlanName", { plan: planLabel(view.plan) })}</p>
          {view.periodEnd ? (
            <p className="ob-note">{t(lang, view.cancelling ? "accCancelsAt" : "accPeriodEnd", { date: fmtDate(lang, view.periodEnd) })}</p>
          ) : null}
          <button type="button" className="ob-btn" disabled={busy} onClick={() => go(client.billingPortal())}>
            {busy ? t(lang, "accRedirecting") : t(lang, "accPortal")}
          </button>
        </>
      ) : (
        <>
          <p>{t(lang, "accPlanFree")}</p>
          <h4 className="ob-sub">{t(lang, "accChoosePlan")}</h4>
          <ul className="acc-list">
            {billing.plans.map((p) => (
              <li key={p.id} data-plan={p.id}>
                <div>
                  <strong>{planLabel(p.id)}</strong>
                  <div className="ob-note">{t(lang, "accPlanCaps", { turns: String(p.caps.turns ?? "?"), deep: String(p.caps.deep ?? "?") })}</div>
                </div>
                <button type="button" className="ob-btn primary" disabled={busy} onClick={() => go(client.billingCheckout(p.id))}>
                  {t(lang, "accSubscribe", { plan: planLabel(p.id) })}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ExportCard({ client, lang, pollMs }: { client: NokkerClient; lang: Lang; pollMs: number }): React.ReactElement {
  const [state, setState] = useState<"idle" | "pending" | AccountExportStatus>("idle");
  const [err, setErr] = useState<unknown>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const poll = useCallback(
    (id: string): void => {
      client.getAccountExport(id).then(
        (s) => {
          if (!alive.current) return;
          if (s.status === "pending") window.setTimeout(() => alive.current && poll(id), pollMs);
          else setState(s);
        },
        (e) => {
          if (!alive.current) return;
          setErr(e);
          setState("idle");
        },
      );
    },
    [client, pollMs],
  );
  const start = (): void => {
    setErr(null);
    setState("pending");
    client.startAccountExport().then(
      (r) => alive.current && poll(r.id),
      (e) => {
        if (!alive.current) return;
        setErr(e);
        setState("idle");
      },
    );
  };
  return (
    <section className="ob-conn" aria-labelledby="acc-export">
      <h3 id="acc-export">{t(lang, "accExport")}</h3>
      <p className="ob-note">{t(lang, "accExportIntro")}</p>
      <Fail lang={lang} err={err} />
      {state === "idle" ? (
        <button type="button" className="ob-btn" onClick={start}>
          {t(lang, "accExportStart")}
        </button>
      ) : state === "pending" ? (
        <p className="ob-status" role="status">
          {t(lang, "accExportPending")}
        </p>
      ) : state.status === "ready" && state.download_url ? (
        <>
          <p className="ob-okline">{t(lang, "accExportReady")}</p>
          <a className="ob-btn primary" href={state.download_url} rel="noopener noreferrer">
            {t(lang, "accExportDownload")}
          </a>
        </>
      ) : (
        <>
          <p className="ob-muted">{t(lang, "accExportExpired")}</p>
          <button type="button" className="ob-btn" onClick={start}>
            {t(lang, "accExportStart")}
          </button>
        </>
      )}
    </section>
  );
}

function DeleteCard({ client, lang }: { client: NokkerClient; lang: Lang }): React.ReactElement {
  const [step, setStep] = useState<"idle" | "confirm" | "busy">("idle");
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const send = (): void => {
    setErr(null);
    setStep("busy");
    client.deleteAccount().then(
      (r) => setApprovalId(r.approval_id),
      (e) => {
        setErr(e);
        setStep("idle");
      },
    );
  };
  return (
    <section className="ob-conn acc-danger" aria-labelledby="acc-delete">
      <h3 id="acc-delete">{t(lang, "accDelete")}</h3>
      <p className="ob-note">{t(lang, "accDeleteIntro")}</p>
      <Fail lang={lang} err={err} />
      {approvalId ? (
        <>
          <p className="ob-okline">{t(lang, "accDeleteSent")}</p>
          <a className="ob-btn primary" href={`/approvals/${encodeURIComponent(approvalId)}`}>
            {t(lang, "accDeleteOpen")}
          </a>
        </>
      ) : step === "idle" ? (
        <button type="button" className="ob-btn danger" onClick={() => setStep("confirm")}>
          {t(lang, "accDeleteStart")}
        </button>
      ) : (
        <div className="acc-actions">
          <button type="button" className="ob-btn danger" disabled={step === "busy"} onClick={send}>
            {t(lang, "accDeleteConfirm")}
          </button>
          <button type="button" className="ob-btn" disabled={step === "busy"} onClick={() => setStep("idle")}>
            {t(lang, "accDeleteCancel")}
          </button>
        </div>
      )}
    </section>
  );
}

export function DeletingScreen({ lang }: { lang: Lang }): React.ReactElement {
  return (
    <div className="ob ob-embedded">
      <div className="ob-card" role="status">
        <h2 className="ob-title">{t(lang, "accDeletingTitle")}</h2>
        <p>{t(lang, "accDeletingBody")}</p>
      </div>
    </div>
  );
}

export function AccountTab({ client, lang, pollMs = 2000 }: { client: NokkerClient; lang: Lang; pollMs?: number }): React.ReactElement {
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let live = true;
    const fail = (e: unknown): void => {
      if (!live) return;
      if (errorCode(e) === "account_deleting") setDeleting(true);
      else setLoadErr(e);
    };
    client.getAccount().then((a) => live && (a.status === "deleting" ? setDeleting(true) : setInfo(a)), fail);
    client.getAccountUsage().then((u) => live && setUsage(u), fail);
    // 404 = abonnement non activé côté noyau : la section n'existe pas, ce n'est pas une erreur.
    client.getBillingStatus().then((b) => live && setBilling(b), () => undefined);
    return () => {
      live = false;
    };
  }, [client]);

  if (deleting) return <DeletingScreen lang={lang} />;
  return (
    <div className="ob ob-embedded" data-account-tab>
      <div className="ob-card">
        <h2 className="ob-title">{t(lang, "accTitle")}</h2>
        <Fail lang={lang} err={loadErr} />
        {info ? <ProfileCard lang={lang} info={info} /> : null}
        {info?.consents ? <ConsentCard client={client} lang={lang} initial={info.consents.training} /> : null}
        {billing ? <SubscriptionCard client={client} lang={lang} billing={billing} /> : null}
        {usage ? <UsageCard lang={lang} usage={usage} /> : null}
        <DevicesCard client={client} lang={lang} />
        <h3 className="ob-sub">{t(lang, "tabConnectors")}</h3>
        <ConnectorsStep client={client} lang={lang} embedded />
        <TelegramStep client={client} lang={lang} embedded />
        <ExportCard client={client} lang={lang} pollMs={pollMs} />
        <DeleteCard client={client} lang={lang} />
      </div>
    </div>
  );
}
