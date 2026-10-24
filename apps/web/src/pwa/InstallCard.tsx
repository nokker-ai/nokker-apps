import React, { useState, useSyncExternalStore } from "react";
import { t, type Lang } from "../onboarding/i18n.js";
import { currentInstallMode, promptInstall, subscribeInstall } from "./install.js";
import { isUpdateReady, subscribeUpdate } from "./register.js";

/** `bare` : sans cadre propre, pour s'insérer dans une carte existante (accueil, fin du parcours /invite). */
export function InstallCard({ lang, bare = false }: { lang: Lang; bare?: boolean }): React.ReactElement | null {
  const mode = useSyncExternalStore(subscribeInstall, currentInstallMode, () => "none" as const);
  const [busy, setBusy] = useState(false);
  if (mode === "none") return null;
  return (
    <div className={bare ? "ob-install" : "ob-card"} data-install={mode}>
      {bare ? <h2 className="ob-sub">{t(lang, "installTitle")}</h2> : <h2 className="ob-title">{t(lang, "installTitle")}</h2>}
      {mode === "installed" ? <p className="ob-sub">{t(lang, "installDone")}</p> : null}
      {mode === "prompt" ? (
        <>
          <p className="ob-sub">{t(lang, "installIntro")}</p>
          <button
            type="button"
            className="ob-btn primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void promptInstall().finally(() => setBusy(false));
            }}
          >
            {t(lang, "installButton")}
          </button>
        </>
      ) : null}
      {mode === "ios" ? (
        <>
          <p className="ob-sub">{t(lang, "installIntro")}</p>
          <ol className="ob-note">
            <li>{t(lang, "installIosShare")}</li>
            <li>{t(lang, "installIosAdd")}</li>
            <li>{t(lang, "installIosOpen")}</li>
          </ol>
        </>
      ) : null}
      {mode === "ios-inapp" ? <p className="ob-sub">{t(lang, "installIosSafari")}</p> : null}
      {mode === "android-menu" ? (
        <>
          <p className="ob-sub">{t(lang, "installIntro")}</p>
          <p className="ob-note">{t(lang, "installAndroidMenu")}</p>
        </>
      ) : null}
    </div>
  );
}

export function UpdateBanner({ lang }: { lang: Lang }): React.ReactElement | null {
  const ready = useSyncExternalStore(subscribeUpdate, isUpdateReady, () => false);
  if (!ready) return null;
  return (
    <div className="pwa-update" role="status">
      <span>{t(lang, "updateReady")}</span>
      <button type="button" className="ob-btn primary" onClick={() => location.reload()}>
        {t(lang, "updateReload")}
      </button>
    </div>
  );
}
