/**
 * Lokkal opened without its local key (docs/LOKKAL.md §7.1): the page is served on 127.0.0.1 / localhost by the
 * machine itself, so the nokker.ai sign-in (private beta, « Apply ») is the wrong door. This explains how to open it
 * with a one-time code: the link the installer prints (`/setup#code=…`), or the code of `nokker open --code` pasted here. The
 * local key never enters a browser. A pasted code is exchanged for a session key of its own (revocable), checked against this
 * core (`GET /v1/local/setup`), then the page reloads:
 * to `/setup` while the first-launch setup is not done, to the app otherwise.
 */
import React, { useEffect, useState } from "react";
import { BRAND } from "@nokker-apps/brand";
import { NokkerApiError } from "@nokker-apps/sdk";
import { SERVER_URL, createClient } from "../api.js";
import { uiLang } from "../components/ConnectorsTab.js";
import { writeJson } from "../viewState.js";
import { t, type Lang } from "./i18n.js";
import { takeLocalToken } from "./localToken.js";
import { redeemSessionCode, takeCodeNote, type CodeFailure } from "./sessionCode.js";
import { applyStoredTheme } from "./theme.js";

type Check = "idle" | "checking" | "wrong" | "unreachable";

/** Where to go once the pasted key opened this core. */
export function afterLocalKey(setupDone: boolean): string {
  return setupDone ? "/" : "/setup";
}

export function LocalKeyHelp({ lang: L, origin, onOpened }: { lang: Lang; origin: string; onOpened: (setupDone: boolean) => void }): React.ReactElement {
  const [key, setKey] = useState("");
  const [check, setCheck] = useState<Check>("idle");
  // Le lien `#code=` qui vient d'échouer (déjà servi, périmé…) : dit une fois, avec le moyen d'en obtenir un autre.
  const [codeNote] = useState<CodeFailure | null>(() => takeCodeNote());

  async function open(): Promise<void> {
    const k = key.trim();
    if (!k) return;
    // La page ne prend QUE le code d'ouverture (« nokker open --code ») : la clé locale n'entre jamais dans un navigateur. Une
    // saisie qui n'a pas la forme d'un code (la clé locale collée par habitude, par exemple) est refusée ici, avant tout réseau.
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(k)) return void setCheck("wrong");
    setCheck("checking");
    try {
      if (!(await redeemSessionCode(SERVER_URL, k, { persistent: true }))) {
        const why = takeCodeNote();
        return void setCheck(why === "unreachable" || why === null ? "unreachable" : "wrong");
      }
      const token = takeLocalToken() ?? ""; // la clé de SESSION que l'échange vient de garder
      const c = createClient();
      c.setToken(token);
      const setup = await c.getLocalSetup();
      onOpened(setup.done);
    } catch (err) {
      setCheck(err instanceof NokkerApiError && (err.status === 401 || err.status === 403) ? "wrong" : "unreachable");
    }
  }

  return (
    <div className="lk-key" data-local-key>
      {codeNote ? (
        <p className="ob-error" role="alert" data-code-note={codeNote}>
          {t(L, codeNote === "used" ? "lkCodeUsed" : codeNote === "expired" ? "lkCodeExpired" : codeNote === "limited" ? "lkCodeLimited" : codeNote === "scope" ? "lkCodeScope" : "lkCodeUnreachable")}
        </p>
      ) : null}
      <ol className="lk-key-steps">
        <li>{t(L, "lkKeyStepLink", { url: `${origin}/setup` })}</li>
        <li>
          {t(L, "lkKeyStepCode")}
          <code className="imp-cmd">nokker open --code</code>
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
            type="text"
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
