import React, { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { BRAND } from "@nokker-apps/brand";
import { createClient } from "../api.js";
import { writeJson } from "../viewState.js";
import { acceptAndLogin } from "../auth.js";
import { InstallCard } from "../pwa/InstallCard.js";
import { Markdown } from "../Markdown.js";
import { ConnectorsStep, ErrorLine, TelegramStep } from "./Connectors.js";
import { errorCode, errorKey, invitationFailure } from "./errors.js";
import { canSubmit, initialState, reduce, type FlowState, type Step } from "./flow.js";
import { normLang, t, type Key, type Lang } from "./i18n.js";

const STEPS: { step: Step; label: Key }[] = [
  { step: "terms", label: "stepTerms" },
  { step: "connectors", label: "stepConnectors" },
  { step: "telegram", label: "stepTelegram" },
  { step: "done", label: "stepDone" },
];

function inviteToken(): string {
  try {
    return new URLSearchParams(location.search).get("t") ?? "";
  } catch {
    return "";
  }
}

export function Onboarding(): React.ReactElement {
  const client = useMemo(createClient, []);
  const [s, dispatch] = useReducer(reduce, undefined, () => initialState(inviteToken()));
  const [terms, setTerms] = useState<string | null>(null);
  const L = s.lang;

  useEffect(() => {
    document.title = `${t(L, "title")} · ${BRAND.productName}`;
    document.documentElement.lang = L;
  }, [L]);

  useEffect(() => {
    if (s.step === "connectors") writeJson("lang", L);
  }, [s.step, L]);

  // 1. Invitation (ne consomme rien).
  useEffect(() => {
    if (s.step !== "invitation") return;
    if (!s.token) return void dispatch({ type: "invitation_invalid" });
    let off = false;
    client
      .getInvitation(s.token)
      .then((inv) => {
        if (off) return;
        if (inv.valid) dispatch({ type: "invitation_ok", lang: normLang(inv.lang), prenom: inv.prenom });
        else dispatch({ type: "invitation_invalid" });
      })
      .catch((err) => {
        if (!off) dispatch({ type: invitationFailure(err) === "invalid" ? "invitation_invalid" : "invitation_unreachable" });
      });
    return () => {
      off = true;
    };
  }, [client, s.step, s.token]);

  // 2. Conditions, dans la langue choisie ; une nouvelle version invalide l'acceptation.
  const needTerms = s.step === "terms" && !s.termsSha;
  useEffect(() => {
    if (!needTerms) return;
    let off = false;
    setTerms(null);
    client
      .getTerms(L)
      .then((doc) => {
        if (off) return;
        setTerms(doc.text);
        dispatch({ type: "terms_loaded", sha: doc.sha256, lang: normLang(doc.lang) });
      })
      .catch((err) => {
        if (!off) dispatch({ type: "accept_failed", error: errorKey(err) });
      });
    return () => {
      off = true;
    };
  }, [client, needTerms, L]);

  const accept = useCallback(async () => {
    if (!canSubmit(s) || !s.termsSha) return;
    dispatch({ type: "submit" });
    try {
      await acceptAndLogin(client, { token: s.token, termsSha256: s.termsSha, trainingConsent: s.training, name: `web-${navigator.platform || "navigateur"}` });
      dispatch({ type: "accept_ok" });
    } catch (err) {
      const code = errorCode(err);
      dispatch({ type: "accept_failed", error: errorKey(err), resetTerms: code === "terms_mismatch", invalid: code === "invalid_token" });
    }
  }, [client, s]);

  const inFlow = STEPS.some((x) => x.step === s.step);

  return (
    <div className="ob">
      <main className="ob-card" aria-labelledby="ob-title">
        <header className="ob-head">
          <img className="ob-mark only-light" src="/brand/nokker-emblem-light.svg" alt="" width={36} height={36} />
          <img className="ob-mark only-dark" src="/brand/nokker-emblem-dark.svg" alt="" width={36} height={36} />
          <span className="ob-brand">{BRAND.productName}</span>
        </header>
        {inFlow && <Progress step={s.step} lang={L} />}
        {s.step === "invitation" && <p className="ob-status" role="status">{t(L, "loading")}</p>}
        {s.step === "invalid" && (
          <section aria-live="polite">
            <h1 id="ob-title" className="ob-title">{t(L, "invalidTitle")}</h1>
            <p>{t(L, "invalidBody")}</p>
          </section>
        )}
        {s.step === "unreachable" && (
          <section aria-live="polite">
            <h1 id="ob-title" className="ob-title">{t(L, "inviteNetworkTitle")}</h1>
            <p>{t(L, "inviteNetworkBody")}</p>
            <button className="ob-btn primary" onClick={() => dispatch({ type: "retry" })}>{t(L, "retry")}</button>
          </section>
        )}
        {s.step === "terms" && <TermsStep s={s} lang={L} terms={terms} dispatch={dispatch} onAccept={accept} />}
        {s.step === "connectors" && (
          <ConnectorsStep
            client={client}
            lang={L}
            anyLinked={s.connectorsLinked.mail || s.connectorsLinked.calendar}
            onLinked={(kind, linked) => dispatch({ type: "connector_linked", kind, linked })}
            onNext={() => dispatch({ type: "next" })}
          />
        )}
        {s.step === "telegram" && (
          <TelegramStep client={client} lang={L} onGenerated={() => dispatch({ type: "telegram_generated" })} onNext={() => dispatch({ type: "next" })} />
        )}
        {s.step === "done" && <DoneStep s={s} lang={L} />}
      </main>
    </div>
  );
}

function Progress({ step, lang }: { step: Step; lang: Lang }): React.ReactElement {
  return <StepsNav steps={STEPS} current={step} lang={lang} />;
}

/** Fil d'étapes du parcours, partagé avec la page `/setup` de Lokkal. */
export function StepsNav<S extends string>({ steps, current, lang }: { steps: { step: S; label: Key }[]; current: S; lang: Lang }): React.ReactElement {
  const idx = steps.findIndex((x) => x.step === current);
  return (
    <nav className="ob-steps" aria-label={t(lang, "steps")}>
      <ol>
        {steps.map((x, i) => (
          <li key={x.step} className={i < idx ? "done" : i === idx ? "now" : ""} aria-current={i === idx ? "step" : undefined}>
            <span className="ob-dot" aria-hidden="true">{i < idx ? "✓" : i + 1}</span>
            <span className="ob-steplabel">{t(lang, x.label)}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function TermsStep(props: {
  s: FlowState;
  lang: Lang;
  terms: string | null;
  dispatch: React.Dispatch<Parameters<typeof reduce>[1]>;
  onAccept: () => void;
}): React.ReactElement {
  const { s, lang: L, terms, dispatch, onAccept } = props;
  return (
    <section>
      <h1 id="ob-title" className="ob-title">{s.prenom ? t(L, "hello", { prenom: s.prenom }) : t(L, "helloAnon")}</h1>
      <h2 className="ob-sub">{t(L, "termsTitle")}</h2>
      <p>{t(L, "termsIntro")}</p>
      <div className="ob-lang" role="group" aria-label={t(L, "termsLang")}>
        {(["fr", "en"] as const).map((l) => (
          <button key={l} type="button" className={"ob-chip" + (L === l ? " on" : "")} aria-pressed={L === l} disabled={s.submitting} onClick={() => dispatch({ type: "set_lang", lang: l })}>
            {l.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="ob-terms" tabIndex={0} role="region" aria-label={t(L, "termsTitle")} aria-busy={terms === null}>
        {terms === null ? <p className="ob-status">{t(L, "termsLoading")}</p> : <Markdown text={terms} />}
      </div>
      <label className="ob-check">
        <input type="checkbox" checked={s.accepted} disabled={!s.termsSha || s.submitting} aria-describedby="ob-terms-err" onChange={(e) => dispatch({ type: "toggle_accept", value: e.target.checked })} />
        <span>{t(L, "termsAccept")}</span>
      </label>
      <label className="ob-check">
        <input type="checkbox" checked={s.training} disabled={!s.termsSha || s.submitting} aria-describedby="ob-training-note" onChange={(e) => dispatch({ type: "toggle_training", value: e.target.checked })} />
        <span>{t(L, "termsTraining")}</span>
      </label>
      <p className="ob-note" id="ob-training-note">{t(L, "termsTrainingNote")}</p>
      <p className="ob-note">{t(L, "deviceNote")}</p>
      <ErrorLine id="ob-terms-err" lang={L} k={s.error} />
      <div className="ob-actions">
        <button type="button" className="ob-btn primary" disabled={!canSubmit(s)} aria-disabled={!canSubmit(s)} onClick={onAccept}>
          {s.submitting ? t(L, "entering") : t(L, "enter")}
        </button>
      </div>
      {!s.accepted && s.termsSha && <p className="ob-hint">{t(L, "termsRequired")}</p>}
    </section>
  );
}

// -- Fin --------------------------------------------------------------------

function DoneStep({ s, lang: L }: { s: FlowState; lang: Lang }): React.ReactElement {
  const rows: [Key, boolean][] = [
    ["doneMail", s.connectorsLinked.mail],
    ["doneCalendar", s.connectorsLinked.calendar],
    ["doneTelegram", s.telegramGenerated],
  ];
  return (
    <section>
      <h1 id="ob-title" className="ob-title">{t(L, "doneTitle")}</h1>
      <p>{t(L, "doneBody")}</p>
      <ul className="ob-summary">
        {rows.map(([k, on]) => (
          <li key={k} className={on ? "on" : ""}>
            <span>{t(L, k)}</span>
            <span>{on ? t(L, k === "doneTelegram" ? "doneCodeSent" : "doneLinked") : t(L, "doneSkipped")}</span>
          </li>
        ))}
      </ul>
      <div className="ob-actions">
        <a className="ob-btn primary" href="/">{t(L, "doneOpen")}</a>
      </div>
      <InstallCard lang={L} bare />
    </section>
  );
}
