/** Page `/approve` ouverte là où la passkey ne marche pas (navigateur intégré d'une appli, ou sans WebAuthn). */
import React, { useState } from "react";
import { isIOS, raText, type RaLang, type signBlocker } from "./remote.js";

/** Navigateur intégré ou sans WebAuthn : ouvrir le lien ailleurs (copie du lien, geste iOS / Android). */
export function OpenElsewhere({
  lang,
  blocker,
  ua = navigator.userAgent,
  secondary = false,
}: {
  lang: RaLang;
  blocker: NonNullable<ReturnType<typeof signBlocker>>;
  ua?: string;
  /** Sous un autre titre (la Mini App d'abord) : titre de second niveau, sans l'id de la page. */
  secondary?: boolean;
}): React.ReactElement {
  const [note, setNote] = useState<string | null>(null);
  const href = typeof location !== "undefined" ? location.href : "";
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(href);
      setNote(raText(lang, "copied"));
    } catch {
      setNote(raText(lang, "copyFailed"));
    }
  };
  return (
    <section className="ra-elsewhere" role="alert">
      {secondary ? (
        <h3>{raText(lang, blocker.kind === "in_app" ? "openTitle" : "noWebauthn")}</h3>
      ) : (
        <h1 id="ra-title" className="ob-title">
          {raText(lang, blocker.kind === "in_app" ? "openTitle" : "noWebauthn")}
        </h1>
      )}
      {blocker.kind === "in_app" ? <p>{blocker.app ? raText(lang, "inAppNamed", { app: blocker.app }) : raText(lang, "inAppAnon")}</p> : null}
      {blocker.kind === "in_app" ? <p className="ob-hint">{raText(lang, isIOS(ua) ? "iosHint" : "androidHint")}</p> : null}
      <p className="ra-link">
        <a href={href}>{href}</a>
      </p>
      <button type="button" className="ob-btn primary" onClick={() => void copy()}>
        {raText(lang, "copy")}
      </button>
      {note ? (
        <p className="ob-status" role="status">
          {note}
        </p>
      ) : null}
    </section>
  );
}
