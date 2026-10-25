import React, { useEffect, useRef, useState } from "react";
import { NokkerApiError } from "@nokker-apps/sdk";
import { BRAND } from "@nokker-apps/brand";
import { loginWithEmailCode, loginWithGoogleTicket } from "../auth.js";
import { t, type Lang } from "../onboarding/i18n.js";
import { takeLinkReturn } from "../link/code.js";
import { InstallCard } from "../pwa/InstallCard.js";
import { SsoLogin } from "../sso/SsoLogin.js";
import type { NokkerStore } from "../store.js";

export const BETA_URL = "https://nokker.ai/beta";
const GOOGLE_ENABLED = import.meta.env?.VITE_NOKKER_GOOGLE === "1";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type Props = Pick<NokkerStore, "client" | "access" | "status" | "retryAccess"> & { lang: Lang };

function failureKey(err: unknown): "loginBadCode" | "loginRateLimited" | "loginInsecure" | "loginGeneric" {
  if (err instanceof Error && err.message === "insecure_context") return "loginInsecure";
  if (err instanceof NokkerApiError) {
    if (err.status === 429) return "loginRateLimited";
    if (err.status === 401) return "loginBadCode";
  }
  return "loginGeneric";
}

/** Retour de la connexion Google : `/auth/callback#ticket=…` ou `#error=…`. */
function readGoogleReturn(): { ticket?: string; error?: string } | null {
  if (location.pathname !== "/auth/callback") return null;
  const p = new URLSearchParams(location.hash.replace(/^#/, ""));
  return { ticket: p.get("ticket") ?? undefined, error: p.get("error") ?? undefined };
}

/** Écran d'un visiteur sans session, connexion par code e-mail. Pas de création de compte :
 * le code ne part que pour une adresse déjà invitée, et la réponse est la même dans tous les cas. */
export function Welcome({ client, access, status, retryAccess, lang: L }: Props): React.ReactElement {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const googleDone = useRef(false);

  useEffect(() => {
    const back = readGoogleReturn();
    if (!back || googleDone.current) return;
    googleDone.current = true;
    history.replaceState(null, "", "/");
    if (back.ticket) {
      setBusy(true);
      loginWithGoogleTicket(client, back.ticket)
        .then(() => {
          const to = takeLinkReturn();
          if (to) location.replace(to);
          else retryAccess();
        })
        .catch((err) => setError(t(L, failureKey(err))))
        .finally(() => setBusy(false));
    } else if (back.error) {
      setError(t(L, back.error === "no_account" ? "loginGoogleNoAccount" : "loginGeneric"));
    }
  }, [client, retryAccess, L]);

  const sendCode = async (resend: boolean): Promise<void> => {
    const addr = email.trim();
    if (!EMAIL_RE.test(addr)) return setError(t(L, "loginBadEmail"));
    setBusy(true);
    setError(null);
    try {
      await client.startEmailLogin(addr, L);
      setEmail(addr);
      setCode("");
      setStep("code");
      setInfo(resend ? t(L, "loginResent") : null);
    } catch (err) {
      setError(t(L, err instanceof NokkerApiError && err.status === 429 ? "loginRateLimited" : "loginGeneric"));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await loginWithEmailCode(client, email, code.trim());
      retryAccess();
    } catch (err) {
      setError(t(L, failureKey(err)));
      setBusy(false);
    }
  };

  return (
    <div className="ob">
      <main className="ob-card wl-card" aria-labelledby="wl-title">
        <header className="wl-logo">
          <img className="only-light" src="/brand/nokker-emblem-light.svg" alt="" width={56} height={56} />
          <img className="only-dark" src="/brand/nokker-emblem-dark.svg" alt="" width={56} height={56} />
          <span className="ob-brand">{BRAND.productName}</span>
        </header>
        {access === "booting" ? <p className="ob-status" role="status">{t(L, "bootLoading")}</p> : null}
        {access === "error" ? (
          <section aria-live="polite">
            <h1 id="wl-title" className="ob-title">{t(L, "inviteNetworkTitle")}</h1>
            <p>{t(L, "inviteNetworkBody")}</p>
            <p className="ob-hint">{status}</p>
            <button type="button" className="ob-btn primary" onClick={retryAccess}>{t(L, "retry")}</button>
          </section>
        ) : null}
        {access === "signed-out" && step === "email" ? (
          <section>
            <h1 id="wl-title" className="ob-title">{t(L, "loginTitle")}</h1>
            {GOOGLE_ENABLED ? (
              <>
                <a className="ob-btn" href="/v1/auth/google/start">{t(L, "loginGoogle")}</a>
                <div className="wl-or" aria-hidden="true">{t(L, "loginOr")}</div>
              </>
            ) : null}
            <form
              className="wl-form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void sendCode(false);
              }}
            >
              <div className="ob-field">
                <label htmlFor="wl-email">{t(L, "loginEmail")}</label>
                <input id="wl-email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              {error ? <p className="ob-error" role="alert">{error}</p> : null}
              <button type="submit" className="ob-btn primary" disabled={busy || !email.trim()}>
                {busy ? t(L, "loginSending") : t(L, "loginEmailGo")}
              </button>
            </form>
            <SsoLogin client={client} lang={L} />
          </section>
        ) : null}
        {access === "signed-out" && step === "code" ? (
          <section>
            <h1 id="wl-title" className="ob-title">{t(L, "loginCodeTitle")}</h1>
            <p>{t(L, "loginCodeBody", { email })}</p>
            <form
              className="wl-form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim().length === 6) void verify();
              }}
            >
              <div className="ob-field">
                <label htmlFor="wl-code">{t(L, "loginCodeLabel")}</label>
                <input
                  id="wl-code"
                  className="wl-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={6}
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                />
              </div>
              {info && !error ? <p className="ob-note" role="status">{info}</p> : null}
              {error ? <p className="ob-error" role="alert">{error}</p> : null}
              <button type="submit" className="ob-btn primary" disabled={busy || code.length !== 6}>{t(L, "loginCodeGo")}</button>
            </form>
            <div className="wl-links">
              <button type="button" className="wl-link" disabled={busy} onClick={() => void sendCode(true)}>{t(L, "loginResend")}</button>
              <button type="button" className="wl-link" disabled={busy} onClick={() => { setStep("email"); setError(null); setInfo(null); }}>{t(L, "loginChangeEmail")}</button>
            </div>
          </section>
        ) : null}
        {access === "signed-out" ? (
          <>
            <p className="wl-foot">
              {t(L, "loginNoAccount")} <a href={BETA_URL}>{t(L, "loginApply")}</a>
            </p>
            <InstallCard lang={L} bare />
          </>
        ) : null}
      </main>
    </div>
  );
}
