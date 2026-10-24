/** Page `/link` : l'utilisateur connecté approuve (ou refuse) la liaison d'une machine Lokkal à son compte. */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { BRAND } from "@nokker-apps/brand";
import { uiLang } from "../components/ConnectorsTab.js";
import { t } from "../onboarding/i18n.js";
import { useNokker } from "../store.js";
import { Welcome } from "../welcome/Welcome.js";
import { codeFromSearch, formatCode, isCompleteCode, keyForIssue, linkIssue, minutesLeft, rememberLinkReturn, type LinkIssue } from "./code.js";

type Phase = "entry" | "checking" | "confirm" | "sending" | "approved" | "denied";

export function LinkPage(): React.ReactElement {
  const store = useNokker();
  const L = uiLang();
  const [code, setCode] = useState(() => formatCode(new URLSearchParams(location.search).get("code") ?? ""));
  const [phase, setPhase] = useState<Phase>("entry");
  const [machine, setMachine] = useState("");
  const [minutes, setMinutes] = useState(1);
  const [issue, setIssue] = useState<LinkIssue | null>(null);
  const auto = useRef(codeFromSearch(location.search));

  const { client, access } = store;

  useEffect(() => {
    if (access === "signed-out" && isCompleteCode(code)) rememberLinkReturn(code);
  }, [access, code]);

  const check = useCallback(
    async (value: string): Promise<void> => {
      setPhase("checking");
      setIssue(null);
      try {
        const p = await client.getLinkPending(value);
        setMachine(p.machine_name);
        setMinutes(minutesLeft(p.expires_in));
        setPhase("confirm");
        history.replaceState(null, "", `/link?code=${encodeURIComponent(value)}`);
      } catch (err) {
        setIssue(linkIssue(err));
        setPhase("entry");
      }
    },
    [client],
  );

  useEffect(() => {
    if (access !== "ready" || !auto.current) return;
    const v = auto.current;
    auto.current = "";
    void check(v);
  }, [access, check]);

  const decide = async (decision: "approve" | "deny"): Promise<void> => {
    setPhase("sending");
    setIssue(null);
    try {
      const r = await client.decideLink(code, decision);
      setPhase(r.state === "approved" ? "approved" : "denied");
    } catch (err) {
      setIssue(linkIssue(err));
      setPhase(linkIssue(err) === "unknown" ? "entry" : "confirm");
    }
  };

  if (access !== "ready" && access !== "booting") return <Welcome {...store} lang={L} />;

  const restart = (): void => {
    setCode("");
    setIssue(null);
    setPhase("entry");
    history.replaceState(null, "", "/link");
  };
  const failure = issue ? (
    <p className="ob-error" role="alert" data-link-issue={issue}>
      {t(L, keyForIssue(issue))}
    </p>
  ) : null;

  return (
    <div className="ob">
      <main className="ob-card wl-card" aria-labelledby="lk-title">
        <header className="wl-logo">
          <img className="only-light" src="/brand/nokker-emblem-light.svg" alt="" width={56} height={56} />
          <img className="only-dark" src="/brand/nokker-emblem-dark.svg" alt="" width={56} height={56} />
          <span className="ob-brand">{BRAND.productName}</span>
        </header>

        {access === "booting" ? <p className="ob-status" role="status">{t(L, "bootLoading")}</p> : null}

        {access === "ready" && (phase === "entry" || phase === "checking") ? (
          <section>
            <h1 id="lk-title" className="ob-title">{t(L, "linkTitle")}</h1>
            <p>{t(L, "linkIntro")}</p>
            <form
              className="wl-form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (isCompleteCode(code)) void check(code);
              }}
            >
              <div className="ob-field">
                <label htmlFor="lk-code">{t(L, "linkCode")}</label>
                <input
                  id="lk-code"
                  className="lk-code"
                  value={code}
                  onChange={(e) => setCode(formatCode(e.target.value))}
                  inputMode="text"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={9}
                  placeholder="XXXX-XXXX"
                  autoFocus
                />
              </div>
              {failure}
              <button type="submit" className="ob-btn primary" disabled={phase === "checking" || !isCompleteCode(code)}>
                {phase === "checking" ? t(L, "linkChecking") : t(L, "linkCheck")}
              </button>
            </form>
          </section>
        ) : null}

        {phase === "confirm" || phase === "sending" ? (
          <section>
            <h1 id="lk-title" className="ob-title">{t(L, "linkTitle")}</h1>
            <p className="lk-machine">{t(L, "linkAsk", { machine })}</p>
            <p className="lk-codeshow" aria-label={t(L, "linkCode")}>{code}</p>
            <p className="ob-hint">{t(L, "linkWarn", { min: String(minutes) })}</p>
            {failure}
            <div className="lk-actions">
              <button type="button" className="ob-btn primary" disabled={phase === "sending"} onClick={() => void decide("approve")}>
                {phase === "sending" ? t(L, "linkWorking") : t(L, "linkApprove")}
              </button>
              <button type="button" className="ob-btn danger" disabled={phase === "sending"} onClick={() => void decide("deny")}>
                {t(L, "linkDeny")}
              </button>
            </div>
          </section>
        ) : null}

        {phase === "approved" ? (
          <section aria-live="polite">
            <h1 id="lk-title" className="ob-title">{t(L, "linkDoneTitle")}</h1>
            <p>{t(L, "linkDoneBody", { machine })}</p>
            <div className="lk-actions">
              <a className="ob-btn primary" href="/machines">{t(L, "linkSeeMachines")}</a>
              <a className="ob-btn" href="/">{t(L, "linkHome")}</a>
            </div>
          </section>
        ) : null}

        {phase === "denied" ? (
          <section aria-live="polite">
            <h1 id="lk-title" className="ob-title">{t(L, "linkDeniedTitle")}</h1>
            <p>{t(L, "linkDeniedBody")}</p>
            <button type="button" className="ob-btn" onClick={restart}>{t(L, "linkAnother")}</button>
          </section>
        ) : null}
      </main>
    </div>
  );
}
