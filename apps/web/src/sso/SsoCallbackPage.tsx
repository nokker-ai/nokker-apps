/** `/sso/callback` (= `redirect_uri` de nokker.ai) : retour du fournisseur d'identité. Le `state` doit être celui que
 * ce navigateur a gardé ; puis signature, `callback`, appareil rangé, et retour à la page de départ où la session
 * s'ouvre par le défi habituel. */
import React, { useEffect, useRef, useState } from "react";
import { BRAND } from "@nokker-apps/brand";
import { createClient } from "../api.js";
import { uiLang } from "../components/ConnectorsTab.js";
import { browserSsoDeps } from "./browser.js";
import { completeSso, ssoErrorCode } from "./flow.js";
import { ssoText } from "./text.js";

export function SsoCallbackPage(): React.ReactElement {
  const L = uiLang();
  const [error, setError] = useState<string | null>(null);
  const [replaced, setReplaced] = useState<string | null>(null); // retour, après le rappel du nouvel appareil
  const once = useRef(false); // StrictMode relance l'effet : le `state` est à usage unique
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const search = location.search;
    history.replaceState(null, "", "/sso/callback"); // ni code ni state dans l'historique
    completeSso(browserSsoDeps(createClient(), L), search).then(
      ({ back, replaced: had }) => (had ? setReplaced(back) : location.replace(back)),
      (e: unknown) => setError(ssoText(L, ssoErrorCode(e))),
    );
  }, [L]);
  return (
    <div className="ob">
      <main className="ob-card wl-card" aria-labelledby="sso-cb-title">
        <header className="wl-logo">
          <img className="only-light" src="/brand/nokker-emblem-light.svg" alt="" width={56} height={56} />
          <img className="only-dark" src="/brand/nokker-emblem-dark.svg" alt="" width={56} height={56} />
          <span className="ob-brand">{BRAND.productName}</span>
        </header>
        <h1 id="sso-cb-title" className="ob-title">
          {ssoText(L, "ssoTitle")}
        </h1>
        {replaced !== null ? (
          <>
            <p className="ob-note" role="status">
              {ssoText(L, "ssoNewDevice")}
            </p>
            <a className="ob-btn primary" href={replaced}>
              {ssoText(L, "ssoContinue")}
            </a>
          </>
        ) : error ? (
          <>
            <p className="ob-error" role="alert">
              {error}
            </p>
            <a className="ob-btn primary" href="/">
              {ssoText(L, "ssoHome")}
            </a>
          </>
        ) : (
          <p className="ob-status" role="status">
            {ssoText(L, "ssoChecking")}
          </p>
        )}
      </main>
    </div>
  );
}
