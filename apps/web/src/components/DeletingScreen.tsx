/** Shown instead of the shell once the account is suspended (deletion granted): eager, outside the lazy account tab. */
import React, { useEffect } from "react";
import { forgetDevice } from "../auth.js";
import { t, type Lang } from "../onboarding/i18n.js";

/** Écran fixe après l'accord : le compte est suspendu, l'appareil est oublié (déconnexion) ; recharger mène à l'accueil. */
export function DeletingScreen({ lang }: { lang: Lang }): React.ReactElement {
  useEffect(() => {
    void forgetDevice().catch(() => undefined);
  }, []);
  return (
    <div className="ob ob-embedded">
      <div className="ob-card" role="status">
        <h2 className="ob-title">{t(lang, "accDeletingTitle")}</h2>
        <p>{t(lang, "accDeletingBody")}</p>
      </div>
    </div>
  );
}
