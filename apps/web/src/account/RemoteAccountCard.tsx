import React from "react";
import { nokkerAccountUrl } from "../gateway/auth.js";
import { t, type Lang } from "../onboarding/i18n.js";

/** Lokkal : ce qui se gère sur le compte nokker.ai (formule, usage, connecteurs, export, suppression). */
export function RemoteAccountCard({ lang }: { lang: Lang }): React.ReactElement {
  return (
    <section className="ob-conn" aria-labelledby="acc-remote" data-account-remote>
      <h3 id="acc-remote">{t(lang, "accRemoteTitle")}</h3>
      <p className="ob-note">{t(lang, "accRemoteBody")}</p>
      <a className="ob-btn primary" href={nokkerAccountUrl()} target="_blank" rel="noopener noreferrer" data-account-remote-link>
        {t(lang, "accRemoteOpen")}
      </a>
    </section>
  );
}
