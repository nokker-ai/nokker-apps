/**
 * Lokkal opened without its local key (docs/LOKKAL.md §7.1): the page is served on 127.0.0.1 / localhost by the
 * machine itself, so the nokker.ai sign-in (private beta, « Apply ») is the wrong door. This explains how to open it
 * with the key: the link the installer prints (`/setup#token=…`), or the key file pasted here. A pasted key is checked
 * against this core (`GET /v1/local/setup`), kept like a key from the fragment (localStorage), then the page reloads:
 * to `/setup` while the first-launch setup is not done, to the app otherwise.
 */
import React, { useEffect, useState } from "react";
import { BRAND } from "@nokker-apps/brand";
import { NokkerApiError } from "@nokker-apps/sdk";
import { createClient } from "../api.js";
import { uiLang } from "../components/ConnectorsTab.js";
import { writeJson } from "../viewState.js";
import { t, type Lang } from "./i18n.js";
import { keepLocalToken } from "./localToken.js";
import { applyStoredTheme } from "./theme.js";

/** Default key file of the installer (`--dir` defaults to ~/.nokker). */
export const LOCAL_KEY_FILE = "~/.nokker/state/local-token";

type Check = "idle" | "checking" | "wrong" | "unreachable";

/** Where to go once the pasted key opened this core. */
export function afterLocalKey(setupDone: boolean): string {
  return setupDone ? "/" : "/setup";
}

export function LocalKeyHelp({ lang: L, origin, onOpened }: { lang: Lang; origin: string; onOpened: (setupDone: boolean) => void }): React.ReactElement {
  const [key, setKey] = useState("");
  const [check, setCheck] = useState<Check>("idle");

  async function open(): Promise<void> {
    const k = key.trim();
    if (!k) return;
    setCheck("checking");
    try {
      const c = createClient();
      c.setToken(k);
      const setup = await c.getLocalSetup();
      keepLocalToken(k);
      onOpened(setup.done);
    } catch (err) {
      setCheck(err instanceof NokkerApiError && (err.status === 401 || err.status === 403) ? "wrong" : "unreachable");
    }
  }

  return (
    <div className="lk-key" data-local-key>
      <ol className="lk-key-steps">
        <li>{t(L, "lkKeyStepLink", { url: `${origin}/setup` })}</li>
        <li>
          {t(L, "lkKeyStepFile", { file: LOCAL_KEY_FILE })}
          <code className="imp-cmd">cat {LOCAL_KEY_FILE}</code>
          <span className="ob-note">{t(L, "lkKeyDirNote")}</span>
        </li>
      </ol>
      <form
        className="wl-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void open();
        }}
      >
        <div className="ob-field">
          <label htmlFor="lk-key-input">{t(L, "lkKeyLabel")}</label>
          <input
            id="lk-key-input"
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={key}
            aria-describedby="lk-key-privacy"
            onChange={(e) => {
              setKey(e.target.value);
              if (check === "wrong" || check === "unreachable") setCheck("idle");
            }}
          />
        </div>
        <p className="ob-note" id="lk-key-privacy">{t(L, "lkKeyPrivacy")}</p>
        {check === "wrong" || check === "unreachable" ? (
          <p className="ob-error" role="alert" data-local-key-error={check}>
            {t(L, check === "wrong" ? "lkKeyWrong" : "lkKeyUnreachable")}
          </p>
        ) : null}
        <button type="submit" className="ob-btn primary" disabled={check === "checking" || !key.trim()}>
          {check === "checking" ? t(L, "lkKeyChecking") : t(L, "lkKeyOpen")}
        </button>
      </form>
    </div>
  );
}

/** Whole page, shown by the app instead of the nokker.ai sign-in when a Lokkal has no local key in this tab. */
export function LocalKeyPage(): React.ReactElement {
  useEffect(applyStoredTheme, []);
  const [L, setL] = useState<Lang>(uiLang());
  useEffect(() => {
    document.title = `${t(L, "lkKeyPageTitle")} · ${BRAND.productName}`;
    document.documentElement.lang = L;
  }, [L]);
  return (
    <div className="ob">
      <main className="ob-card" aria-labelledby="ob-title" data-local-key-page>
        <header className="ob-head">
          <img className="ob-mark only-light" src="/brand/nokker-emblem-light.svg" alt="" width={36} height={36} />
          <img className="ob-mark only-dark" src="/brand/nokker-emblem-dark.svg" alt="" width={36} height={36} />
          <span className="ob-brand">{BRAND.productName}</span>
          <div className="ob-lang lk-lang" role="group" aria-label="Langue / Language">
            {(["fr", "en"] as const).map((l) => (
              <button
                key={l}
                type="button"
                className={"ob-chip" + (L === l ? " on" : "")}
                aria-pressed={L === l}
                onClick={() => {
                  setL(l);
                  writeJson("lang", l);
                }}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        </header>
        <section>
          <h1 id="ob-title" className="ob-title">{t(L, "lkKeyPageTitle")}</h1>
          <p>{t(L, "lkKeyIntro")}</p>
          <LocalKeyHelp lang={L} origin={location.origin} onOpened={(done) => location.assign(afterLocalKey(done))} />
        </section>
      </main>
    </div>
  );
}
