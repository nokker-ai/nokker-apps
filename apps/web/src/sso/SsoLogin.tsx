/** Accueil : « Connexion SSO de ton organisation » (LOKKAL §7.24). L'adresse professionnelle désigne la connexion par
 * son domaine prouvé ; un identifiant `sc_…` (lien donné par l'organisation, `/?sso=sc_…`) passe tel quel. */
import React, { useState } from "react";
import { isSsoConnectionId, type NokkerClient } from "@nokker-apps/sdk";
import { goSso } from "./browser.js";
import { ssoErrorCode } from "./flow.js";
import { ssoText } from "./text.js";
import "./sso.css";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function SsoLogin({ client, lang }: { client: NokkerClient; lang: string }): React.ReactElement {
  const preset = new URLSearchParams(location.search).get("sso") ?? "";
  const [open, setOpen] = useState(isSsoConnectionId(preset));
  const [value, setValue] = useState(isSsoConnectionId(preset) ? preset : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const T = (k: string): string => ssoText(lang, k);
  const v = value.trim();
  const valid = isSsoConnectionId(v) || EMAIL_RE.test(v);

  if (!open) {
    return (
      <div className="wl-links">
        <button type="button" className="wl-link" onClick={() => setOpen(true)}>
          {T("ssoLink")}
        </button>
      </div>
    );
  }
  const go = async (): Promise<void> => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await goSso(client, lang, isSsoConnectionId(v) ? { connection: v } : { email: v }, "/");
    } catch (e) {
      setError(T(ssoErrorCode(e)));
      setBusy(false);
    }
  };
  return (
    <section className="sso-login" aria-labelledby="sso-title">
      <h2 id="sso-title" className="ob-title">
        {T("ssoTitle")}
      </h2>
      <p>{T("ssoBody")}</p>
      <form
        className="wl-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <div className="ob-field">
          <label htmlFor="sso-who">{T("ssoField")}</label>
          <input id="sso-who" type="text" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        {error ? (
          <p className="ob-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="ob-btn primary" disabled={busy || !valid}>
          {busy ? T("ssoGoing") : T("ssoGo")}
        </button>
      </form>
      <div className="wl-links">
        <button type="button" className="wl-link" disabled={busy} onClick={() => setOpen(false)}>
          {T("ssoBack")}
        </button>
      </div>
    </section>
  );
}
