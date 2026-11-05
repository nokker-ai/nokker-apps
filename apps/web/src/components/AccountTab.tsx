import React, { useCallback, useEffect, useRef, useState } from "react";
import { NokkerApiError, type AccountExport, type AccountInfo, type AccountUsage, type BillingStatus, type Device, type NokkerClient, type VoucherCheck } from "@nokker-apps/sdk";
import { deleteOutcome, exportIssue, fmtSize, fmtWhen, signOutDevice, suspendedError, type ExportIssue } from "../account/lifecycle.js";
import { forgetDevice, readStoredDeviceKey } from "../auth.js";
import { DeletingScreen } from "./DeletingScreen.js";
import { shortVersion, termsVersionLabel } from "../account/terms.js";
import { forgetVoucher, recallVoucher, type BillingReturn } from "../account/links.js";
import { ModelsCard } from "../account/ModelsCard.js";
import { GlassesCard } from "../glance/GlassesCard.js";
import { BudgetsCard } from "../payments/BudgetsCard.js";
import { PayMethodCard, type SignChallenge } from "../payments/PayMethodCard.js";
import { KnockCard } from "../knock/KnockCard.js";
import { billingView, subscriptionNote, fmtAmount, fmtReset, monthTurns, planCaps, planLabel, softOver, STATUS_KEYS, todayRows, usageLevel, usagePct, weekRows, type UsageRow } from "../account/usage.js";
import { ConnectorsStep, TelegramStep } from "../onboarding/Connectors.js";
import { errorCode, errorKey } from "../onboarding/errors.js";
import { t, type Key, type Lang } from "../onboarding/i18n.js";
import { off as offCap } from "../capabilities.js";

const fmtDate = (lang: Lang, iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(lang, { dateStyle: "long" }).format(d);
};

// Dates de l'essai : jour civil de Zurich (le premier débit tombe à 23:59 heure de Zurich), quel que soit le fuseau.
const fmtZurich = (lang: Lang, iso: string): string => {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(lang, { dateStyle: "long", timeZone: "Europe/Zurich" }).format(d);
};

const VOUCHER_ERRORS: Record<string, Key> = {
  code_invalid: "accCodeInvalid",
  code_expired: "accCodeExpired",
  code_exhausted: "accCodeExhausted",
  code_used: "accCodeUsed",
  code_customer: "accCodeCustomer",
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

function capsLine(lang: Lang, id: string, caps: Record<string, number>): string {
  if (id === "byok") return t(lang, "accPlanByok");
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

function ProfileCard({ client, lang, info }: { client: NokkerClient; lang: Lang; info: AccountInfo }): React.ReactElement {
  // Version lisible : lue dans le texte courant, seulement si l'empreinte acceptée est la sienne.
  const [termsLabel, setTermsLabel] = useState<string | null>(null);
  const accepted = info.terms?.version ?? null;
  const termsLang = info.terms_current?.lang ?? info.lang;
  useEffect(() => {
    if (!accepted || info.terms_outdated) return;
    let live = true;
    client.getCurrentTerms(termsLang).then(
      (c) => live && setTermsLabel(c.version === accepted ? termsVersionLabel(c.text) : null),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, accepted, termsLang, info.terms_outdated]);
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
        <dd data-terms-line>
          {!info.terms
            ? t(lang, "accTermsNone")
            : info.terms_outdated
              ? t(lang, "accTermsPrevious", { date: fmtDate(lang, info.terms.accepted_at) })
              : t(lang, "accTermsLine", { version: termsLabel ?? shortVersion(info.terms.version), date: fmtDate(lang, info.terms.accepted_at) })}
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
  // L'appareil de ce navigateur (clé rangée dans IndexedDB) : marqué et listé en premier.
  const [thisId, setThisId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    readStoredDeviceKey().then(
      (k) => live && setThisId(k?.deviceId ?? null),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  const load = useCallback(() => {
    client.listDevices().then(setDevices, setErr);
  }, [client]);
  useEffect(load, [load]);
  const ordered = [...(devices ?? [])].sort((a, b) => Number(b.id === thisId) - Number(a.id === thisId));
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
        {ordered.map((d) => (
          <li key={d.id} data-device={d.id} data-this-device={d.id === thisId ? "" : undefined}>
            <div>
              <strong>{d.name}</strong>
              {d.id === thisId ? <span className="chip acc-this-device">{t(lang, "accDeviceThis")}</span> : null}
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
  // Se déconnecter de CET appareil ne révoque pas les lunettes (décision de dev, 02.11) : on le dit quand il y en a.
  const [glasses, setGlasses] = useState(0);
  useEffect(() => {
    if (offCap("glance")) return;
    let live = true;
    client.listGlanceDevices().then(
      (r) => live && setGlasses(r.devices.filter((d) => d.paired && !d.revoked).length),
      () => undefined, // 404 : pas de lunettes servies, rien à dire
    );
    return () => {
      live = false;
    };
  }, [client]);
  const go = async (): Promise<void> => {
    setBusy(true);
    await signOutDevice(client, readStoredDeviceKey, forgetDevice);
    onSignOut();
  };
  return (
    <section className="ob-conn" aria-labelledby="acc-signout">
      <h3 id="acc-signout">{t(lang, "accSignOut")}</h3>
      <p className="ob-muted">{t(lang, "accSignOutBody")}</p>
      {glasses > 0 ? <p className="ob-muted">{t(lang, "accSignOutGlasses")}</p> : null}
      <button type="button" className="ob-btn" disabled={busy} onClick={() => void go()}>
        {t(lang, "accSignOutBtn")}
      </button>
    </section>
  );
}

function SubscriptionCard({ client, lang, billing }: { client: NokkerClient; lang: Lang; billing: BillingStatus }): React.ReactElement {
  const view = billingView(billing);
  const note = subscriptionNote(view);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // Code d'essai : caché derrière « J'ai un code » (l'essai n'est pas une offre publique sans code), ouvert d'emblée si
  // un code vient d'un lien de campagne.
  const [code, setCode] = useState<string>(() => recallVoucher());
  const [codeOpen, setCodeOpen] = useState<boolean>(() => recallVoucher() !== "");
  const [voucher, setVoucher] = useState<VoucherCheck | null>(null);
  const [checking, setChecking] = useState(false);
  // Noyau sans codes d'essai (route en 404, noyau d'avant r38) : ni champ ni « J'ai un code », le code d'un lien est oublié.
  const [vouchersOff, setVouchersOff] = useState(false);
  const trial = voucher?.ok ? voucher : null;
  const check = useCallback(
    (raw: string): void => {
      const c = raw.trim();
      if (!c) return;
      setChecking(true);
      setErr(null);
      client.checkVoucher(c).then(
        (r) => {
          setVoucher(r);
          setChecking(false);
        },
        (e) => {
          setChecking(false);
          if (e instanceof NokkerApiError && e.status === 404) {
            forgetVoucher();
            setVoucher(null);
            setCodeOpen(false);
            setVouchersOff(true);
          } else setErr(e);
        },
      );
    },
    [client],
  );
  useEffect(() => {
    if (view.kind === "none" && code) check(code);
    // vérifié une fois à l'arrivée (code venu d'un lien) ; ensuite seulement sur demande
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
          {note ? (
            <p className="ob-note" data-trial-end={note.zurich ? note.at : undefined} data-cancelling={view.cancelling ? "" : undefined}>
              {t(lang, note.key, { date: note.zurich ? fmtZurich(lang, note.at) : fmtDate(lang, note.at) })}
            </p>
          ) : null}
          <button type="button" className="ob-btn" disabled={busy} onClick={() => go(client.billingPortal())}>
            {busy ? t(lang, "accRedirecting") : t(lang, "accPortal")}
          </button>
        </>
      ) : (
        <>
          <p>{t(lang, "accPlanFree")}</p>
          <h4 className="ob-sub">{t(lang, trial ? "accChooseTrialPlan" : "accChoosePlan")}</h4>
          {trial ? (
            <p className="ob-okline" role="status" data-voucher="ok">
              {t(lang, "accCodeOk", { date: fmtZurich(lang, trial.first_charge_on) })}
            </p>
          ) : null}
          <ul className="acc-list">
            {billing.plans.map((p) => (
              <li key={p.id} data-plan={p.id}>
                <div>
                  <strong>{planLabel(p.id)}</strong>
                  {p.price ? (
                    <span className="acc-price">
                      {" · "}
                      {trial
                        ? t(lang, "accTrialThen", { amount: fmtAmount(lang, p.price), date: fmtZurich(lang, trial.first_charge_on) })
                        : t(lang, p.price.interval === "year" ? "accPricePerYear" : "accPricePerMonth", { amount: fmtAmount(lang, p.price) })}
                    </span>
                  ) : null}
                  <div className="ob-note">{capsLine(lang, p.id, p.caps)}</div>
                </div>
                <button
                  type="button"
                  className="ob-btn primary"
                  disabled={busy}
                  onClick={() => {
                    if (trial) forgetVoucher();
                    go(client.billingCheckout(p.id, trial ? code.trim() : undefined));
                  }}
                >
                  {t(lang, trial ? "accStartTrial" : "accSubscribe", { plan: planLabel(p.id) })}
                </button>
              </li>
            ))}
          </ul>
          {vouchersOff ? null : codeOpen ? (
            <form
              className="acc-code ob-field"
              onSubmit={(e) => {
                e.preventDefault();
                check(code);
              }}
            >
              <label htmlFor="acc-code-in">{t(lang, "accCodeLabel")}</label>
              <div className="acc-code-row">
                <input
                  id="acc-code-in"
                  value={code}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={40}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setVoucher(null);
                  }}
                  aria-describedby={voucher && !voucher.ok ? "acc-code-err" : undefined}
                />
                <button type="submit" className="ob-btn" disabled={checking || !code.trim()}>
                  {t(lang, checking ? "accCodeChecking" : "accCodeCheck")}
                </button>
              </div>
              {voucher && !voucher.ok ? (
                <p id="acc-code-err" className="ob-error" role="alert" data-voucher={voucher.error}>
                  {t(lang, VOUCHER_ERRORS[voucher.error] ?? "accCodeInvalid")}
                </p>
              ) : null}
            </form>
          ) : (
            <button type="button" className="acc-code-open" onClick={() => setCodeOpen(true)}>
              {t(lang, "accHaveCode")}
            </button>
          )}
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

function ExportCard({ client, lang, onDownloaded, onReady }: { client: NokkerClient; lang: Lang; onDownloaded: () => void; onReady?: (ready: boolean) => void }): React.ReactElement {
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
  useEffect(() => onReady?.(!!ready), [ready, onReady]);
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
  exportReady = false,
  subscribed,
  onGranted,
}: {
  client: NokkerClient;
  lang: Lang;
  pollMs: number;
  exported: boolean;
  /** Un export est prêt dans la carte d'export mais n'a pas été téléchargé. */
  exportReady?: boolean;
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
              <p>{t(lang, exportReady ? "accDeleteExportReady" : "accDeleteExportFirst")}</p>
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

export function AccountTab({
  client,
  lang,
  pollMs = 2000,
  onGone,
  onSignOut,
  signDecision = null,
  billingReturn = null,
}: {
  client: NokkerClient;
  lang: Lang;
  pollMs?: number;
  onGone?: () => void;
  /** Passkey of this device (payment method of the payment agent); null in demo / TOTP-only sessions. */
  signDecision?: SignChallenge | null;
  /** Absent (démo, passerelle, Lokkal local) : pas de déconnexion ici. */
  onSignOut?: () => void;
  /** Retour de Stripe Checkout (`?billing=`) : message en tête de page. */
  billingReturn?: BillingReturn | null;
}): React.ReactElement {
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [deleting, setDeleting] = useState(false);
  const [exported, setExported] = useState(false);
  const [exportReady, setExportReady] = useState(false);
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
    if (!offCap("billing")) client.getBillingStatus().then((b) => live && setBilling(b), () => undefined);
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
        {billingReturn ? (
          <p className={billingReturn === "success" ? "ob-okline" : "ob-note"} role="status" data-billing-return={billingReturn}>
            {t(lang, billingReturn === "success" ? "accBillingSuccess" : "accBillingCancel")}
          </p>
        ) : null}
        {info ? <ProfileCard client={client} lang={lang} info={info} /> : null}
        {info?.consents ? <ConsentCard client={client} lang={lang} initial={info.consents.training} locked={info.consents.training_locked === "minor"} /> : null}
        {billing ? <SubscriptionCard client={client} lang={lang} billing={billing} /> : null}
        <ModelsCard client={client} lang={lang} />
        {usage ? <UsageCard lang={lang} usage={usage} /> : null}
        <DevicesCard client={client} lang={lang} />
        <GlassesCard client={client} />
        <BudgetsCard client={client} />
        <PayMethodCard client={client} signDecision={signDecision} />
        <KnockCard />
        {onSignOut ? <SignOutCard client={client} lang={lang} onSignOut={onSignOut} /> : null}
        <h3 className="ob-sub">{t(lang, "tabConnectors")}</h3>
        <ConnectorsStep client={client} lang={lang} embedded />
        <TelegramStep client={client} lang={lang} embedded />
        <ExportCard client={client} lang={lang} onDownloaded={() => setExported(true)} onReady={setExportReady} />
        <DeleteCard client={client} lang={lang} pollMs={pollMs} exported={exported} exportReady={exportReady} subscribed={billing?.plan != null} onGranted={granted} />
      </div>
    </div>
  );
}

// Kept here for existing imports; the shell imports it from its own file so it never waits for the account chunk.
export { DeletingScreen };
