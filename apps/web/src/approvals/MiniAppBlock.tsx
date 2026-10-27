/** Carte forte d'une machine : elle se signe dans la Mini App Telegram (Face ID), pas dans ce navigateur sans passkey. */
import React from "react";
import { miniAppApproveUrl, raText, type RaLang } from "./remote.js";

export function MiniAppBlock({ lang, target, heading = false }: { lang: RaLang; target: { machineId?: string; host?: string; approvalId: string }; heading?: boolean }): React.ReactElement {
  const url = miniAppApproveUrl(target);
  return (
    <section className="ra-elsewhere" aria-labelledby={heading ? "ra-title" : undefined}>
      {heading ? (
        <h1 id="ra-title" className="ob-title">
          {raText(lang, "miniTitle")}
        </h1>
      ) : (
        <h3>{raText(lang, "miniTitle")}</h3>
      )}
      <p>{raText(lang, "miniBody")}</p>
      {url ? (
        <a className="ob-btn primary" href={url}>
          {raText(lang, "miniOpen")}
        </a>
      ) : (
        <p className="ob-hint">{raText(lang, "miniNoLink")}</p>
      )}
    </section>
  );
}
