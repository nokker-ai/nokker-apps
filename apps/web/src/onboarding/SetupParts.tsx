import React, { useEffect, useState } from "react";
import { t, type Key, type Lang } from "./i18n.js";
import { RUNTIME_LABEL, type DefaultOption, type LinkPhase } from "./localFlow.js";

/** Morceaux présentationnels de la page `/setup` (aucun accès réseau : testables par rendu statique). */

function secondsUntil(ms: number, now: number): number {
  return Math.max(0, Math.ceil((ms - now) / 1000));
}

function fmt(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Carte « compte nokker.ai » : flux d'appareil (code + lien + attente). Présentationnelle, sans réseau. */
export function RouterCard(props: {
  lang: Lang;
  routerLinked: boolean;
  account?: string;
  link: LinkPhase;
  onStart: () => void;
  now?: number;
}): React.ReactElement {
  const { lang: L, link } = props;
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (link.phase !== "waiting") return;
    setTick(Date.now());
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [link.phase]);
  const now = props.now ?? tick;
  const unavailable = link.phase === "unavailable";
  const failed = link.phase === "expired" || link.phase === "denied" || link.phase === "error" || link.phase === "vault";
  const failKey: Key =
    link.phase === "expired" ? "lkRouterExpired" : link.phase === "denied" ? "lkRouterDenied" : link.phase === "vault" ? "lkErrVault" : "lkRouterError";
  return (
    <article className="ob-conn" aria-labelledby="lk-router">
      <div className="ob-conn-head">
        <h3 id="lk-router">{t(L, "lkRouterTitle")}</h3>
        <span className={"ob-badge " + (props.routerLinked ? "ok" : "absent")}>{props.routerLinked ? t(L, "lkRouterLinked") : t(L, "stateAbsent")}</span>
      </div>
      {props.routerLinked ? (
        <>
          {props.account && (
            <p className="ob-account">
              <span className="ob-muted">{t(L, "lkRouterAccount")} · </span>
              <span className="mono">{props.account}</span>
            </p>
          )}
          <p className="ob-note">{t(L, "lkRouterScope")}</p>
        </>
      ) : (
        <>
          <p className="ob-note">{t(L, "lkRouterBody")}</p>
          <div aria-live="polite">
            {link.phase === "waiting" && (
              <div className="ob-pair">
                <p className="ob-note">{t(L, "lkRouterOpen")}</p>
                <p>
                  <a href={link.uri} target="_blank" rel="noopener noreferrer" className="mono lk-uri">{link.uri}</a>
                </p>
                <p className="ob-pair-label">{t(L, "lkRouterCode")}</p>
                <p className="ob-code mono" aria-label={`${t(L, "lkRouterCode")} ${link.code.replace("-", " ").split("").join(" ")}`}>{link.code}</p>
                <p className="ob-timer" role="timer" aria-live="off">
                  {t(L, "lkRouterWaiting")} · {t(L, "expiresIn", { time: fmt(secondsUntil(link.expiresAt, now)) })}
                </p>
              </div>
            )}
            {failed && <p className="ob-error" role="alert">{t(L, failKey)}</p>}
            {unavailable && <p className="ob-note lk-unavailable" role="status">{t(L, "lkRouterUnavailable")}</p>}
          </div>
          {link.phase !== "waiting" && (
            <div className="ob-actions inline">
              <button type="button" className={"ob-btn" + (failed || unavailable ? "" : " primary")} disabled={link.phase === "starting"} onClick={props.onStart}>
                {link.phase === "starting" ? t(L, "lkRouterStarting") : unavailable ? t(L, "lkRouterAgain") : failed ? t(L, "lkRouterRetry") : t(L, "lkRouterLink")}
              </button>
            </div>
          )}
        </>
      )}
    </article>
  );
}

export function optionLabel(lang: Lang, o: DefaultOption): string {
  if (o.kind === "router") return t(lang, "lkDefaultRouter");
  if (o.kind === "byok") return t(lang, "lkDefaultByok", { name: o.name, model: o.model ?? "" });
  return t(lang, "lkDefaultLocal", { runtime: RUNTIME_LABEL[o.name as keyof typeof RUNTIME_LABEL] ?? o.name, model: o.model ?? "" });
}

/** Choix du modèle par défaut : boutons radio natifs (flèches du clavier, un seul arrêt de tabulation). */
export function DefaultPicker(props: { lang: Lang; options: DefaultOption[]; chosen: string | null; disabled?: boolean; onChoose: (value: string) => void }): React.ReactElement {
  const L = props.lang;
  return (
    <fieldset className="lk-default">
      <legend className="ob-sub">{t(L, "lkDefaultTitle")}</legend>
      {props.options.length === 0 && <p className="ob-note">{t(L, "lkDefaultNone")}</p>}
      {props.options.map((o) => (
        <label key={o.value} className={"ob-check lk-opt" + (props.chosen === o.value ? " on" : "")}>
          <input type="radio" name="lk-default" value={o.value} checked={props.chosen === o.value} disabled={props.disabled} onChange={() => props.onChoose(o.value)} />
          <span>{optionLabel(L, o)}</span>
        </label>
      ))}
    </fieldset>
  );
}

