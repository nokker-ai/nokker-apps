/**
 * Pages des liens des sites connectés (nokker docs/CONNECTED-SITES.md §15, noyau bb936b3), servies par le web à
 * `https://<origine>/…` (passerelle de la machine, ou app.nokker.ai) :
 *  - `/sites/r/<rid>` — saisie sécurisée d'une demande (lien de `sites_connect` et des demandes Telegram) : lit
 *    `GET /v1/local/sites/requests/{rid}`, scelle la valeur dans la page (`sealValue`) et répond ; « Fait » pour une
 *    validation dans l'application du site. Le champ est vidé à l'envoi, jamais pré-rempli.
 *  - `/sites/h/<jeton>` — vérification humaine : échange le jeton (usage unique, 15 min) contre l'adresse de l'écran du
 *    navigateur du site et y va tout de suite.
 * Connexion requise (la demande est à la personne) : sinon l'accueil habituel.
 */
import React, { useEffect, useRef, useState } from "react";
import { BRAND } from "@nokker-apps/brand";
import { NokkerApiError, sealValue, type NokkerClient, type SiteRequest } from "@nokker-apps/sdk";
import { useNokker } from "../store.js";
import { uiLang } from "../components/ConnectorsTab.js";
import { Welcome } from "../welcome/Welcome.js";
import { DeletingScreen } from "../components/DeletingScreen.js";
import { errorCode } from "../onboarding/errors.js";
import { t, type Key, type Lang } from "../onboarding/i18n.js";
import { Icon } from "../icons.js";
import { readJson } from "../viewState.js";
import "./sites.css";


function Shell({ lang, children }: { lang: Lang; children: React.ReactNode }): React.ReactElement {
  return (
    <main className="st-page" aria-labelledby="sp-title">
      <p className="st-page-brand">{BRAND.productName}</p>
      {children}
      <p className="fine">
        <a href="/account/connectors">{t(lang, "srBackToSites")}</a>
      </p>
    </main>
  );
}

function useGate(): { store: ReturnType<typeof useNokker>; gate: React.ReactElement | null; lang: Lang } {
  const store = useNokker();
  // Thème choisi dans l'app (App.tsx ne tourne pas sur ces pages) : sombre seulement sur réglage explicite.
  useEffect(() => {
    if (readJson<"light" | "dark">("theme", "light") === "dark") document.documentElement.setAttribute("data-theme", "dark");
  }, []);
  const lang = uiLang();
  if (store.accountGone) return { store, lang, gate: <DeletingScreen lang={lang} /> };
  if (store.access !== "ready" && store.access !== "booting") return { store, lang, gate: <Welcome {...store} lang={lang} /> };
  return { store, lang, gate: null };
}

const failKey = (e: unknown): Key => {
  const c = errorCode(e);
  return c === "expired" ? "srExpired" : c === "answered" ? "srAnswered" : c === "not_found" || (e instanceof NokkerApiError && e.status === 404) ? "srUnknown" : "stErrGeneric";
};

export function SiteRequestPage({ rid }: { rid: string }): React.ReactElement {
  const { store, gate, lang } = useGate();
  if (gate) return gate;
  return <Shell lang={lang}>{store.ready ? <RequestForm client={store.client} rid={rid} lang={lang} /> : <div className="boot fine">{store.status}</div>}</Shell>;
}

function RequestForm({ client, rid, lang: L }: { client: NokkerClient; rid: string; lang: Lang }): React.ReactElement {
  const [req, setReq] = useState<SiteRequest | null>(null);
  const [state, setState] = useState<"load" | "ask" | "sent" | Key>("load");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    client.getSiteRequest(rid).then(
      (r) => {
        setReq(r);
        setState(r.expires_at * 1000 < Date.now() ? "srExpired" : "ask");
      },
      (e) => setState(failKey(e)),
    );
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [client, rid]);
  const answer = async (value: string | null): Promise<void> => {
    if (!req) return;
    setBusy(true);
    try {
      if (value === null) await client.answerSiteRequest(req.id, { done: true });
      else await client.answerSiteRequest(req.id, { sealed: await sealValue(req.machine_key!, req.id, value) });
      setState("sent");
    } catch (e) {
      setState(failKey(e));
    } finally {
      setBusy(false);
    }
  };
  const left = req ? Math.max(0, Math.round(req.expires_at - now / 1000)) : 0;
  if (state === "load") return <div className="boot fine" />;
  if (state === "sent")
    return (
      <div className="st-ask ok" data-sr="sent">
        <h1 id="sp-title" className="st-ask-title"><Icon name="check" size={18} /> {t(L, "srSent")}</h1>
      </div>
    );
  if (state !== "ask" || !req || left === 0)
    return (
      <div className="st-ask bad" data-sr="error">
        <h1 id="sp-title" className="st-ask-title">{t(L, state === "ask" ? "srExpired" : (state as Key))}</h1>
      </div>
    );
  const title: Key = req.kind === "password" ? "srPassword" : req.kind === "code" ? "srCode" : req.kind === "link" ? "srLink" : "srApp";
  const time = t(L, "stTimeLeft", { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` });
  if (req.kind === "app_approval")
    return (
      <div className="st-ask" data-sr="app_approval">
        <h1 id="sp-title" className="st-ask-title">{t(L, title, { label: req.label })}</h1>
        <button type="button" className="ob-btn primary st-wide" disabled={busy} onClick={() => void answer(null)}>{t(L, "stDone")}</button>
        <p className="ob-muted">{time}</p>
      </div>
    );
  return <SealedForm lang={L} kind={req.kind} title={t(L, title, { label: req.label })} time={time} busy={busy} onValue={(v) => void answer(v)} />;
}

function SealedForm(props: { lang: Lang; kind: "password" | "code" | "link"; title: string; time: string; busy: boolean; onValue: (v: string) => void }): React.ReactElement {
  const { lang: L, kind } = props;
  const [show, setShow] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const label: Key = kind === "password" ? "stPassword" : kind === "code" ? "stCodeLabel" : "stLinkLabel";
  return (
    <form
      className="st-ask"
      data-sr={kind}
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        const el = input.current;
        if (!el) return;
        const v = kind === "code" ? el.value.replace(/\s+/g, "") : kind === "link" ? el.value.trim() : el.value;
        el.value = "";
        if (v) props.onValue(v);
      }}
    >
      <h1 id="sp-title" className="st-ask-title">{props.title}</h1>
      {kind === "link" ? <p className="ob-note">{t(L, "stLinkHow")}</p> : kind === "code" ? <p className="ob-note">{t(L, "stCodeWhere")}</p> : null}
      <p className="ob-note st-lock"><Icon name="shield" size={14} /> {t(L, "stSealed")}</p>
      <div className="ob-field">
        <label htmlFor="sr-value">{t(L, label)}</label>
        <div className={kind === "password" ? "st-pass" : "st-code"}>
          <input
            ref={input}
            id="sr-value"
            name="value"
            required
            autoCapitalize="none"
            spellCheck={false}
            {...(kind === "password" ? { type: show ? "text" : "password", autoComplete: "off" } : kind === "code" ? { inputMode: "numeric" as const, autoComplete: "one-time-code", maxLength: 12 } : { inputMode: "url" as const, autoComplete: "off" })}
          />
          {kind === "password" ? (
            <button type="button" className="ob-btn small" aria-pressed={show} aria-controls="sr-value" onClick={() => setShow((v) => !v)}>{t(L, show ? "stHide" : "stShow")}</button>
          ) : null}
        </div>
      </div>
      <button type="submit" className="ob-btn primary st-wide" disabled={props.busy}>{props.busy ? t(L, "stSending") : t(L, "stSend")}</button>
      <p className="ob-muted">{props.time}</p>
    </form>
  );
}

export function SiteHandoffPage({ token }: { token: string }): React.ReactElement {
  const { store, gate, lang } = useGate();
  if (gate) return gate;
  return <Shell lang={lang}>{store.ready ? <Handoff client={store.client} token={token} lang={lang} /> : <div className="boot fine">{store.status}</div>}</Shell>;
}

function Handoff({ client, token, lang: L }: { client: NokkerClient; token: string; lang: Lang }): React.ReactElement {
  const [gone, setGone] = useState<Key | null>(null);
  const once = useRef(false);
  useEffect(() => {
    // Usage unique : un seul échange, même en double rendu (StrictMode).
    if (once.current) return;
    once.current = true;
    client.openSiteHandoff(token).then(
      ({ screen_url }) => location.replace(client.resolveUrl(screen_url) ?? screen_url),
      (e) => setGone(errorCode(e) === "handoff_gone" ? "shGone" : "stErrGeneric"),
    );
  }, [client, token]);
  return gone ? (
    <div className="st-ask bad" data-sh="gone">
      <h1 id="sp-title" className="st-ask-title">{t(L, gone)}</h1>
    </div>
  ) : (
    <p className="ob-muted" data-sh="opening" aria-live="polite">
      <span id="sp-title">{t(L, "shOpening")}</span>
    </p>
  );
}
