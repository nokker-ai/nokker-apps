import React, { useCallback, useEffect, useRef, useState } from "react";
import type { AccountExport, AccountInfo, AccountUsage, BillingStatus, Device, NokkerClient } from "@nokker-apps/sdk";
import { deleteOutcome, exportIssue, fmtSize, fmtWhen, signOutDevice, suspendedError, type ExportIssue } from "../account/lifecycle.js";
import { forgetDevice, readStoredDeviceKey } from "../auth.js";
import { billingView, fmtReset, monthTurns, planCaps, planLabel, softOver, STATUS_KEYS, todayRows, usageLevel, usagePct, weekRows, type UsageRow } from "../account/usage.js";
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

function ConsentCard({ client, lang, initial, locked }: { client: NokkerClient; lang: Lang; initial: boolean; locked: boolean }): React.ReactElement {
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
        <input type="checkbox" checked={on && !locked} disabled={busy || locked} data-consent="training" onChange={(e) => toggle(e.target.checked)} />
        <span>{t(lang, "accConsentLabel")}</span>
      </label>
      <p className="ob-status" role="status">
        {t(lang, locked ? "accConsentLocked" : on ? "accConsentOn" : "accConsentOff")}
      </p>
      <Fail lang={lang} err={err} />
    </section>
  );
}

function capsLine(lang: Lang, caps: Record<string, number>): string {
  const c = planCaps(caps);
  if (c.day === null) return "";
  const base = c.week === null ? t(lang, "accPlanCapsDay", { day: String(c.day) }) : t(lang, "accPlanCaps", { day: String(c.day), week: String(c.week) });
  return c.seats ? t(lang, "accPlanSeats", { caps: base, n: String(c.seats) }) : base;
}

/** X23 : membre d'un foyer — le quota commun (jour, semaine) et sa propre part du jour. */
function HouseholdUsage({ lang, hh }: { lang: Lang; hh: NonNullable<AccountUsage["household"]> }): React.ReactElement {
  const soft = hh.mode === "soft";
  const bar = (used: number, cap: number | null): UsageRow => {
    const pct = usagePct(used, cap);
    const level = usageLevel(pct);
    return { key: "turns", used, cap, pct, level: soft && level === "full" ? "warn" : level, over: cap !== null && used > cap };
  };
  const mine = hh.member;
  return (
    <div data-usage-household>
      <h4 className="ob-sub">{t(lang, "accHousehold")}</h4>
      <p className="ob-note">{t(lang, "accToday")}</p>
      <UsageBar lang={lang} r={bar(hh.today.used, hh.today.cap)} />
      <p className="ob-note">{t(lang, "accWeek")}</p>
      <UsageBar lang={lang} r={bar(hh.week.used, hh.week.cap)} />
      <p className="ob-note">
        {t(lang, "accHouseholdMine")} :{" "}
        {mine.cap === null
          ? t(lang, "accHouseholdNoCap", { used: String(mine.today) })
          : t(lang, "accHouseholdCap", { used: String(mine.today), cap: String(mine.cap), source: t(lang, mine.source === "custom" ? "accSrcCustom" : "accSrcDefault") })}
      </p>
    </div>
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
      {usage.household ? <HouseholdUsage lang={lang} hh={usage.household} /> : null}
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

/** Déconnexion de CET appareil : il est retiré du compte (sa clé ne vaut plus rien) puis oublié ici ; retour à l'accueil. */
function SignOutCard({ client, lang, onSignOut }: { client: NokkerClient; lang: Lang; onSignOut: () => void }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const go = async (): Promise<void> => {
    setBusy(true);
    await signOutDevice(client, readStoredDeviceKey, forgetDevice);
    onSignOut();
  };
  return (
    <section className="ob-conn" aria-labelledby="acc-signout">
      <h3 id="acc-signout">{t(lang, "accSignOut")}</h3>
      <p className="ob-muted">{t(lang, "accSignOutBody")}</p>
      <button type="button" className="ob-btn" disabled={busy} onClick={() => void go()}>
        {t(lang, "accSignOutBtn")}
      </button>
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
                  <div className="ob-note">{capsLine(lang, p.caps)}</div>
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

function saveFile(filename: string, json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ExportCard({ client, lang, onDownloaded }: { client: NokkerClient; lang: Lang; onDownloaded: () => void }): React.ReactElement {
  const [exp, setExp] = useState<AccountExport | null>(null);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<ExportIssue | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const fail = (e: unknown): void => {
    if (!alive.current) return;
    const i = exportIssue(e);
    setIssue(i);
    setErr(i.kind === "other" ? e : null);
    setBusy(false);
  };
  const start = (): void => {
    setIssue(null);
    setErr(null);
    setBusy(true);
    client.startAccountExport().then((r) => {
      if (!alive.current) return;
      setExp(r);
      setBusy(false);
    }, fail);
  };
  const download = (): void => {
    if (!exp) return;
    setIssue(null);
    setErr(null);
    setBusy(true);
    client.downloadAccountExport(exp.id).then((f) => {
      if (!alive.current) return;
      saveFile(f.filename, f.json);
      setBusy(false);
      onDownloaded();
    }, (e) => {
      if (exportIssue(e).kind === "expired") setExp({ ...exp, status: "expired", download: null });
      fail(e);
    });
  };
  const ready = exp?.status === "ready" && exp.download;
  return (
    <section className="ob-conn" id="acc-export-card" aria-labelledby="acc-export">
      <h3 id="acc-export">{t(lang, "accExport")}</h3>
      <p className="ob-note">{t(lang, "accExportIntro")}</p>
      <Fail lang={lang} err={err} />
      {issue?.kind === "limit" ? (
        <p className="ob-note" role="status" data-export-limit>
          {issue.retryAt ? t(lang, "accExportLimit", { when: fmtWhen(lang, issue.retryAt) }) : t(lang, "errExportLimit")}
        </p>
      ) : null}
      {ready && exp ? (
        <>
          <p className="ob-okline">{t(lang, "accExportReady", { size: fmtSize(lang, exp.size), when: fmtWhen(lang, exp.expires_at) })}</p>
          <button type="button" className="ob-btn primary" disabled={busy} onClick={download}>
            {t(lang, "accExportDownload")}
          </button>
        </>
      ) : exp || issue?.kind === "expired" ? (
        <>
          <p className="ob-muted">{t(lang, "accExportExpired")}</p>
          <button type="button" className="ob-btn" disabled={busy} onClick={start}>
            {t(lang, "accExportStart")}
          </button>
        </>
      ) : busy ? (
        <p className="ob-status" role="status">
          {t(lang, "accExportPending")}
        </p>
      ) : (
        <button type="button" className="ob-btn" onClick={start}>
          {t(lang, "accExportStart")}
        </button>
      )}
    </section>
  );
}

function DeleteCard({
  client,
  lang,
  pollMs,
  exported,
  subscribed,
  onGranted,
}: {
  client: NokkerClient;
  lang: Lang;
  pollMs: number;
  exported: boolean;
  subscribed: boolean;
  onGranted: () => void;
}): React.ReactElement {
  const [step, setStep] = useState<"idle" | "confirm" | "busy">("idle");
  const [ask, setAsk] = useState<{ id: string; expires_at: string } | null>(null);
  const [refused, setRefused] = useState<"dead" | "failed" | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Tant que la carte est en attente : on la relit ; accordée = compte suspendu, morte = on revient au début.
  useEffect(() => {
    if (!ask) return;
    let stop = false;
    const tick = (): void => {
      client.getApproval(ask.id).then(
        (a) => {
          if (stop) return;
          const o = deleteOutcome(a.status);
          if (o === "granted") onGranted();
          else if (o === "dead" || o === "failed") {
            setAsk(null);
            setStep("idle");
            setRefused(o);
          } else window.setTimeout(tick, pollMs);
        },
        (e) => {
          if (stop) return;
          if (suspendedError(e)) onGranted(); // compte suspendu : la carte a été accordée ailleurs
          else window.setTimeout(tick, pollMs);
        },
      );
    };
    const h = window.setTimeout(tick, pollMs);
    return () => {
      stop = true;
      window.clearTimeout(h);
    };
  }, [ask, client, pollMs, onGranted]);
  const send = (): void => {
    setErr(null);
    setRefused(null);
    setStep("busy");
    client.deleteAccount().then(
      (r) => alive.current && setAsk({ id: r.approval_id, expires_at: r.expires_at }),
      (e) => {
        if (!alive.current) return;
        setErr(e);
        setStep("idle");
      },
    );
  };
  const toExport = (): void => document.getElementById("acc-export-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
  return (
    <section className="ob-conn acc-danger" aria-labelledby="acc-delete">
      <h3 id="acc-delete">{t(lang, "accDelete")}</h3>
      <p className="ob-note">{t(lang, "accDeleteIntro")}</p>
      <Fail lang={lang} err={err} />
      {refused ? (
        <p className="ob-note" role="status" data-delete-refused={refused}>
          {t(lang, refused === "failed" ? "accDeleteFailed" : "accDeleteRefused")}
        </p>
      ) : null}
      {ask ? (
        <>
          <p className="ob-okline">{t(lang, "accDeleteSent", { when: fmtWhen(lang, ask.expires_at) })}</p>
          <a className="ob-btn primary" href={`/approvals/${encodeURIComponent(ask.id)}`}>
            {t(lang, "accDeleteOpen")}
          </a>
          <p className="ob-status" role="status">
            {t(lang, "accDeleteWaiting")}
          </p>
          <details className="acc-nostrong">
            <summary>{t(lang, "accDeleteNoStrong")}</summary>
            <p className="ob-note">{t(lang, "accDeleteNoStrongBody")}</p>
          </details>
        </>
      ) : step === "idle" ? (
        <button type="button" className="ob-btn danger" onClick={() => setStep("confirm")}>
          {t(lang, "accDeleteStart")}
        </button>
      ) : (
        <>
          {!exported ? (
            <div className="ob-note" data-export-first>
              <p>{t(lang, "accDeleteExportFirst")}</p>
              <button type="button" className="ob-btn" onClick={toExport}>
                {t(lang, "accDeleteExportFirstBtn")}
              </button>
            </div>
          ) : null}
          {subscribed ? (
            <p className="ob-note" data-delete-subscription>
              {t(lang, "accDeleteSubscription")}
            </p>
          ) : null}
          <div className="acc-actions">
            <button type="button" className="ob-btn danger" disabled={step === "busy"} onClick={send}>
              {t(lang, "accDeleteConfirm")}
            </button>
            <button type="button" className="ob-btn" disabled={step === "busy"} onClick={() => setStep("idle")}>
              {t(lang, "accDeleteCancel")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** Écran fixe après l'accord : le compte est suspendu, l'appareil est oublié (déconnexion) ; recharger mène à l'accueil. */
export function DeletingScreen({ lang }: { lang: Lang }): React.ReactElement {
  useEffect(() => {
    void forgetDevice().catch(() => undefined);
  }, []);
  return (
    <div className="ob ob-embedded">
      <div className="ob-card" role="status">
        <h2 className="ob-title">{t(lang, "accDeletingTitle")}</h2>
        <p>{t(lang, "accDeletingBody")}</p>
      </div>
    </div>
  );
}

export function AccountTab({
  client,
  lang,
  pollMs = 2000,
  onGone,
  onSignOut,
}: {
  client: NokkerClient;
  lang: Lang;
  pollMs?: number;
  onGone?: () => void;
  /** Absent (démo, passerelle, Lokkal local) : pas de déconnexion ici. */
  onSignOut?: () => void;
}): React.ReactElement {
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [deleting, setDeleting] = useState(false);
  const [exported, setExported] = useState(false);
  const granted = useCallback(() => (onGone ? onGone() : setDeleting(true)), [onGone]);

  useEffect(() => {
    let live = true;
    const fail = (e: unknown): void => {
      if (!live) return;
      setLoadErr(e);
    };
    client.getAccount().then((a) => live && setInfo(a), fail);
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
        {info?.consents ? <ConsentCard client={client} lang={lang} initial={info.consents.training} locked={info.consents.training_locked === "minor"} /> : null}
        {billing ? <SubscriptionCard client={client} lang={lang} billing={billing} /> : null}
        {usage ? <UsageCard lang={lang} usage={usage} /> : null}
        <DevicesCard client={client} lang={lang} />
        {onSignOut ? <SignOutCard client={client} lang={lang} onSignOut={onSignOut} /> : null}
        <h3 className="ob-sub">{t(lang, "tabConnectors")}</h3>
        <ConnectorsStep client={client} lang={lang} embedded />
        <TelegramStep client={client} lang={lang} embedded />
        <ExportCard client={client} lang={lang} onDownloaded={() => setExported(true)} />
        <DeleteCard client={client} lang={lang} pollMs={pollMs} exported={exported} subscribed={billing?.plan != null} onGranted={granted} />
      </div>
    </div>
  );
}
