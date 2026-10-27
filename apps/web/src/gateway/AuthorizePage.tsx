/**
 * Page `/gateway/authorize` de nokker.ai : le compte connecté ici ouvre sa passerelle `<nom>.nokker.app`. Le code
 * rendu ne vaut que pour cet hôte, ce défi PKCE et 60 s ; le noyau refuse (403) un hôte qui n'est pas une machine du
 * compte. Pas d'écran de confirmation : rien ne sort vers un tiers (l'hôte est forcément une passerelle du compte).
 */
import React, { useEffect, useState } from "react";
import { BRAND } from "@nokker-apps/brand";
import { NokkerApiError } from "@nokker-apps/sdk";
import { trIn } from "../i18n/index.js";
import { useNokker } from "../store.js";
import { Welcome } from "../welcome/Welcome.js";
import { uiLang } from "../components/ConnectorsTab.js";
import { callbackUrl, parseAuthorize } from "./authorize.js";

type Phase = { kind: "working" } | { kind: "bad" } | { kind: "foreign"; host: string } | { kind: "failed" };

export function AuthorizePage(): React.ReactElement {
  const store = useNokker();
  const L = uiLang();
  const devHost = import.meta.env?.VITE_NOKKER_GATEWAY === "1" ? location.host : null;
  const [req] = useState(() => parseAuthorize(location.search, devHost));
  const [phase, setPhase] = useState<Phase>(req ? { kind: "working" } : { kind: "bad" });
  const { client, access } = store;

  useEffect(() => {
    if (access !== "ready" || !req) return;
    let live = true;
    client.gatewayAuthorize(req.host, req.challenge).then(
      (r) => {
        const back = callbackUrl(r.redirect, req, { code: r.code });
        if (!live) return;
        if (back) location.replace(back);
        else setPhase({ kind: "failed" });
      },
      (err) => {
        if (!live) return;
        setPhase(err instanceof NokkerApiError && err.status === 403 ? { kind: "foreign", host: req.host } : { kind: "failed" });
      },
    );
    return () => {
      live = false;
    };
  }, [access, client, req]);

  if (access !== "ready" && access !== "booting") return <Welcome {...store} lang={L} />;

  const cancel = req ? callbackUrl(`${req.host.endsWith(".nokker.app") ? "https" : "http"}://${req.host}/auth/callback`, req, { error: "access_denied" }) : null;

  return (
    <div className="ob">
      <main className="ob-card wl-card" aria-labelledby="gw-title">
        <header className="wl-logo">
          <img className="only-light" src="/brand/nokker-emblem-light.svg" alt="" width={56} height={56} />
          <img className="only-dark" src="/brand/nokker-emblem-dark.svg" alt="" width={56} height={56} />
          <span className="ob-brand">{BRAND.productName}</span>
        </header>
        <h1 id="gw-title" className="ob-title">{trIn(L, "Open your machine")}</h1>
        {phase.kind === "working" ? (
          <p className="ob-status" role="status">
            {trIn(L, "Signing you in to {0}…", req!.host)}
          </p>
        ) : null}
        {phase.kind === "bad" ? (
          <p className="ob-error" role="alert">
            {trIn(L, "This sign-in link is invalid. Open your machine's address again.")}
          </p>
        ) : null}
        {phase.kind === "foreign" ? (
          <p className="ob-error" role="alert">
            {trIn(L, "{0} is not linked to this account. Sign in with the account that linked it, or link it from Lokkal.", phase.host)}
          </p>
        ) : null}
        {phase.kind === "failed" ? (
          <p className="ob-error" role="alert">
            {trIn(L, "Sign-in did not go through. Try again in a moment.")}
          </p>
        ) : null}
        {phase.kind !== "working" && cancel ? (
          <a className="ob-btn" href={cancel}>{trIn(L, "Back to the machine")}</a>
        ) : null}
      </main>
    </div>
  );
}
