/**
 * Sites connectés (nokker docs/CONNECTED-SITES.md §4, §15, noyau bb936b3 ; routes Lokkal `/v1/local/sites*`, voir
 * packages/sdk/src/sites.ts). Pensé pour un parent non technique, sur téléphone d'abord :
 *   Ajouter un site → tuile du site → avertissement (4 cases, une fois par site) → identifiant + mot de passe → Valider
 *   → suivi en direct jusqu'à « Connecté ✓ ». Ce que le site demande ensuite (code, lien reçu par e-mail, validation
 *   dans son application, vérification) se règle ICI ou sur Telegram ; une connexion lancée depuis le chat apparaît
 *   dans la liste et se reprend d'ici.
 * Le noyau n'accepte jamais de mot de passe dans l'ajout : il ouvre une demande `password` avec une clé de machine
 * éphémère. Le mot de passe tapé au formulaire est gardé dans une référence (jamais dans l'état React, jamais dans le
 * DOM après Valider), scellé pour CETTE demande (`sealValue`) dès qu'elle s'ouvre, puis effacé ; à défaut (2 min),
 * l'écran le redemande. Aucun mot technique à l'écran.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NokkerApiError, sealValue, type NokkerClient, type SiteCard, type SiteCatalogEntry, type SiteState, type SitesListing } from "@nokker-apps/sdk";
import { errorCode } from "../onboarding/errors.js";
import { t, type Key, type Lang } from "../onboarding/i18n.js";
import { Icon } from "../icons.js";
import "./sites.css";

const MONOGRAM: Record<string, { text: string; bg: string }> = {
  linkedin: { text: "in", bg: "#0a66c2" },
  instagram: { text: "IG", bg: "#c13584" },
  facebook: { text: "f", bg: "#1877f2" },
  x: { text: "X", bg: "#111111" },
};

export function SiteMark({ site, size = 40 }: { site: string; size?: number }): React.ReactElement {
  const m = MONOGRAM[site];
  return (
    <span className="st-mark" style={{ width: size, height: size, background: m?.bg ?? "var(--muted)", fontSize: size * 0.42 }} aria-hidden="true">
      {m ? m.text : <Icon name="link" size={Math.round(size * 0.5)} />}
    </span>
  );
}

/** États où la connexion avance ou attend la personne : l'écran se rafraîchit. */
const LIVE: ReadonlySet<SiteState> = new Set(["connecting", "expired", "needs_password", "needs_link", "needs_code", "needs_app_approval", "needs_you"]);

const fmtDate = (lang: Lang, sec?: number | null): string => {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return lang === "fr" ? `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}` : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

/** Raison d'une pause ou d'un abandon (`signal`, table du §15), dans la langue de l'écran. */
const SIGNALS: ReadonlySet<string> = new Set(["password_timeout", "code_timeout", "wrong_code", "code_rejected", "approval_timeout", "link_timeout", "link_other_site", "handoff_timeout", "captcha", "unknown_screen", "unusual_activity", "bad_credentials", "too_many_logins", "too_many_steps", "login_page_changed", "cancelled", "browser_missing", "busy", "internal"]);
/** Code vide ou inconnu : « raison non précisée », jamais le code brut (comme `signal_text` du noyau, df8d8bc). */
export function signalText(lang: Lang, signal?: string | null): string {
  return t(lang, (signal && SIGNALS.has(signal) ? `stSig_${signal}` : "stSig_none") as Key);
}

/** Texte de l'état, par état et par langue (mêmes sens que `state_text` du noyau, qui n'existe qu'en français). */
export function stateText(lang: Lang, s: Pick<SiteCard, "state" | "paused_until" | "signal">): string {
  return t(lang, `stS_${s.state}` as Key, { until: fmtDate(lang, s.paused_until), signal: signalText(lang, s.signal) });
}

const tone = (st: SiteState): "ok" | "busy" | "warn" | "bad" =>
  st === "connected" ? "ok" : st === "connecting" || st === "expired" ? "busy" : st === "suspended" || st === "failed" ? "bad" : "warn";

const QUOTA_SHOWN = ["pages", "searches", "profiles", "messages", "invitations"];
/** « 12 pages sur 150 · 1 recherche sur 25 » — ce qui est déjà pris aujourd'hui (les compteurs à zéro sont tus). */
export function quotaLine(lang: Lang, s: Pick<SiteCard, "quotas">): string {
  return QUOTA_SHOWN.filter((k) => s.quotas?.[k] && (k === "pages" || s.quotas[k]!.used > 0))
    .map((k) => t(lang, `stQ_${k}` as Key, { used: String(s.quotas[k]!.used), max: String(s.quotas[k]!.max) }))
    .join(" · ");
}

export function ConnectedSites({ client, lang: L }: { client: NokkerClient; lang: Lang }): React.ReactElement | null {
  const [data, setData] = useState<SitesListing | null>(null);
  // 404 (noyau sans ces routes : le cloud) ou 403 `minor` (la fonction n'est pas proposée à un mineur, §4.1) : rien.
  const [absent, setAbsent] = useState(false);
  const [sheet, setSheet] = useState<{ follow?: string; consentFor?: string } | null>(null);
  const refresh = useCallback(async () => {
    try {
      setData(await client.listSites());
      setAbsent(false);
    } catch (e) {
      if (e instanceof NokkerApiError && (e.status === 404 || e.status === 403)) setAbsent(true);
    }
  }, [client]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Une connexion en cours : la liste suit en direct (1,5 s). Sinon toutes les 10 s et au retour sur la page, pour
  // qu'une connexion lancée ailleurs (le chat, Telegram) apparaisse ici (flux SSE du noyau : lot suivant).
  const live = data?.sites?.some((s) => LIVE.has(s.state)) ?? false;
  useEffect(() => {
    if (absent) return;
    const id = setInterval(() => document.visibilityState === "visible" && void refresh(), live ? 1500 : 10_000);
    const onVis = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [live, absent, refresh]);

  const head = (
    <div className="ob-conn-head">
      <h3 id="st-title">{t(L, "stTitle")}</h3>
    </div>
  );
  if (absent || !data) return null;
  // Fonction éteinte sur la machine, ou pas de machine liée : une phrase, jamais un 404 muet (§15).
  if (!data.enabled) {
    return (
      <article className="ob-conn st" aria-labelledby="st-title" data-sites={data.reason ?? "off"}>
        {head}
        <p className="ob-note">{t(L, data.reason === "no_machine" ? "stNoMachine" : "stDisabled")}</p>
      </article>
    );
  }
  return (
    <article className="ob-conn st" aria-labelledby="st-title" data-sites="on">
      {head}
      <p className="ob-note">{t(L, "stIntro")}</p>
      {data.sites.length ? (
        <ul className="st-list">
          {(data.sites ?? []).map((s) => (
            <SiteRow
              key={s.id}
              s={s}
              client={client}
              lang={L}
              many={data.sites.filter((x) => x.site === s.site).length > 1}
              onOpen={() => setSheet({ follow: s.id, ...(s.state === "needs_consent" ? { consentFor: s.site } : {}) })}
              onChanged={refresh}
            />
          ))}
        </ul>
      ) : null}
      <div className="ob-actions inline st-add">
        <button type="button" className="ob-btn primary" data-site-add onClick={() => setSheet({})}>
          <Icon name="plus" size={16} /> {t(L, "stAdd")}
        </button>
      </div>
      {sheet ? (
        <AddSiteSheet
          client={client}
          lang={L}
          data={data}
          follow={sheet.follow}
          consentFor={sheet.consentFor}
          onClose={() => {
            setSheet(null);
            void refresh();
          }}
          onChanged={refresh}
        />
      ) : null}
    </article>
  );
}

function SiteRow(props: { s: SiteCard; client: NokkerClient; lang: Lang; many: boolean; onOpen: () => void; onChanged: () => Promise<void> }): React.ReactElement {
  const { s, client, lang: L } = props;
  const [menu, setMenu] = useState(false);
  const [panel, setPanel] = useState<null | "rename" | "delete">(null);
  const [forget, setForget] = useState(true);
  const [error, setError] = useState<Key | undefined>();
  const act = async (fn: () => Promise<unknown>, after?: () => void): Promise<void> => {
    setError(undefined);
    try {
      await fn();
      setPanel(null);
      setMenu(false);
      after?.();
      await props.onChanged();
    } catch (e) {
      const c = errorCode(e);
      setError(c === "label_taken" ? "errLabelTaken" : c === "bad_label" || c === "invalid_label" ? "errBadLabel" : "stErrGeneric");
    }
  };
  const owner = s.access === "owner";
  const k = s.state;
  const primary: { key: Key; run: () => void } | null = !owner
    ? null
    : k === "needs_password" || k === "needs_code" ? { key: "stEnterHere", run: props.onOpen }
    : k === "needs_link" ? (s.request ? { key: "stPasteHere", run: props.onOpen } : null)
    : k === "needs_app_approval" ? { key: "stDone", run: props.onOpen }
    : k === "needs_you" ? { key: "stSee", run: props.onOpen }
    : k === "needs_consent" ? { key: "stAcceptRead", run: props.onOpen }
    : k === "paused" ? { key: "stLift", run: () => void act(() => client.liftSitePause(s.id)) }
    : k === "suspended" ? { key: "stNewPassword", run: props.onOpen }
    : k === "disconnected" ? { key: "stReconnect", run: () => void act(() => client.connectSite(s.id), props.onOpen) }
    : k === "failed" ? { key: "stRetry", run: () => void act(() => client.connectSite(s.id), props.onOpen) }
    : k === "absent" ? { key: "stConnect", run: () => void act(() => client.connectSite(s.id), props.onOpen) }
    : null;
  const ql = k === "connected" ? quotaLine(L, s) : "";
  return (
    <li className="st-row" data-site={s.id} data-site-state={k}>
      <div className="st-row-main">
        <SiteMark site={s.site} />
        <div className="st-row-text">
          <div className="st-row-title">
            <strong>{s.label}</strong>
            {props.many && s.default ? <span className="ob-badge ok">{t(L, "cmDefault")}</span> : null}
          </div>
          <p className="ob-muted st-account">{[s.account_name, s.username].filter(Boolean).join(" · ") || s.site_name}</p>
          <p className={`st-state st-${tone(k)}`} data-state-text>
            {tone(k) === "busy" ? <span className="st-spin" aria-hidden="true" /> : tone(k) === "ok" ? <Icon name="check" size={14} /> : <Icon name="alert" size={14} />}
            <span>{stateText(L, s).replace(/\s*✓$/, "")}</span>
          </p>
          {ql ? <p className="ob-muted st-quota">{t(L, "stToday")} {ql}</p> : null}
          {k === "connected" && s.last_auto_login_at ? <p className="ob-muted st-quota">{t(L, "stAutoAgain", { date: fmtDate(L, s.last_auto_login_at) })}</p> : null}
        </div>
      </div>
      {error ? <p className="ob-error" role="alert">{t(L, error)}</p> : null}
      {panel === "rename" ? (
        <form
          className="ob-form cm-inline"
          onSubmit={(e) => {
            e.preventDefault();
            const l = String(new FormData(e.currentTarget).get("label") ?? "").trim();
            if (l) void act(() => client.patchSite(s.id, { label: l }));
          }}
        >
          <div className="ob-field">
            <label htmlFor={`st-rn-${s.id}`}>{t(L, "cmLabelField")}</label>
            <input id={`st-rn-${s.id}`} name="label" defaultValue={s.label} maxLength={40} required autoComplete="off" />
          </div>
          <div className="ob-actions inline">
            <button type="submit" className="ob-btn primary">{t(L, "cmRenameSave")}</button>
            <button type="button" className="ob-btn" onClick={() => setPanel(null)}>{t(L, "cancel")}</button>
          </div>
        </form>
      ) : panel === "delete" ? (
        <div className="st-confirm" data-site-delete>
          <p className="ob-note">{t(L, "stDeleteNote", { site: s.site_name })}</p>
          {s.credentials?.stored ? (
            <label className="st-agree">
              <input type="checkbox" checked={forget} onChange={(e) => setForget(e.target.checked)} />
              <span>{t(L, "stForget")}</span>
            </label>
          ) : null}
          <p className="ob-muted">{t(L, "stDeleteCheck", { site: s.site_name })}</p>
          <div className="ob-actions inline">
            <button type="button" className="ob-btn danger" onClick={() => void act(() => client.deleteSite(s.id, forget))}>{t(L, "stDeleteConfirm")}</button>
            <button type="button" className="ob-btn" onClick={() => setPanel(null)}>{t(L, "cancel")}</button>
          </div>
        </div>
      ) : owner ? (
        <div className="st-row-actions">
          {primary ? <button type="button" className="ob-btn primary small" data-site-primary={primary.key} onClick={primary.run}>{t(L, primary.key)}</button> : null}
          <button type="button" className="ob-btn small" aria-expanded={menu} aria-haspopup="menu" data-site-more onClick={() => setMenu((m) => !m)}>{t(L, "stMore")}</button>
          {menu ? (
            <div className="st-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setMenu(false); setPanel("rename"); }}>{t(L, "cmRename")}</button>
              {props.many && !s.default ? <button type="button" role="menuitem" onClick={() => void act(() => client.patchSite(s.id, { default: true }))}>{t(L, "cmMakeDefault")}</button> : null}
              {k === "connected" ? <button type="button" role="menuitem" onClick={() => void act(() => client.connectSite(s.id))}>{t(L, "stReconnect")}</button> : null}
              {LIVE.has(k) && k !== "expired" ? <button type="button" role="menuitem" data-site-cancel onClick={() => void act(() => client.cancelSite(s.id))}>{t(L, "stCancel")}</button> : null}
              <button type="button" role="menuitem" className="danger" onClick={() => { setMenu(false); setPanel("delete"); }}>{t(L, "stDelete")}</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

type Step = "pick" | "consent" | "creds" | "progress";
// Avertissement du §4.1 : les quatre points visibles, UNE case (décision du 06.11, objectif 7 gestes jusqu'à « Connecté »).
const CONSENTS: Array<[Key, "alert" | "user" | "shield"]> = [["stConsent1", "alert"], ["stConsent2", "alert"], ["stConsent3", "user"], ["stConsent4", "shield"]];

function AddSiteSheet(props: { client: NokkerClient; lang: Lang; data: SitesListing; follow?: string; consentFor?: string; onClose: () => void; onChanged: () => Promise<void> }): React.ReactElement {
  const { client, lang: L, data } = props;
  const following = data.sites.find((s) => s.id === props.follow);
  const [step, setStep] = useState<Step>(props.consentFor ? "consent" : following ? "progress" : "pick");
  const [pick, setPick] = useState<SiteCatalogEntry | null>(() => data.catalog.find((c) => c.site === (following?.site ?? props.consentFor)) ?? null);
  const [siteId, setSiteId] = useState<string | undefined>(following?.id);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | undefined>();
  // Mot de passe tapé au formulaire, en attente de la demande `password` du noyau (jamais dans l'état React).
  const held = useRef<{ value: string; until: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const name = pick?.name ?? following?.site_name ?? "";

  useEffect(() => () => void (held.current = null), []);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>("h2")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, props]);

  // Le consentement est par (profil, site) : un site déjà présent dans la liste l'a eu.
  const known = (site: string) => (data.consents ?? []).includes(site);
  const choose = (c: SiteCatalogEntry): void => {
    setPick(c);
    setError(undefined);
    setStep(known(c.site) ? "creds" : "consent");
  };
  const accept = async (): Promise<void> => {
    if (!pick) return;
    setBusy(true);
    try {
      await client.acceptSiteConsent(pick.site, data.consent_version);
      if (following) {
        await client.connectSite(following.id);
        setStep("progress");
        await props.onChanged();
      } else setStep("creds");
    } catch {
      setError("stErrGeneric");
    } finally {
      setBusy(false);
    }
  };
  const submit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (!pick) return;
    const form = e.currentTarget;
    const d = new FormData(form);
    const username = String(d.get("username") ?? "").trim();
    const pw = form.elements.namedItem("password") as HTMLInputElement | null;
    const password = pw?.value ?? "";
    if (pw) pw.value = "";
    if (!username || !password) return void setError("errFieldsRequired");
    held.current = { value: password, until: Date.now() + 120_000 };
    setBusy(true);
    setError(undefined);
    try {
      const label = String(d.get("label") ?? "").trim();
      // answer_here : le mot de passe est déjà là ; la demande Telegram attend 30 s (et ne part pas s'il est donné).
      const add = () => client.addSite({ site: pick.site, username, answer_here: true, ...(label ? { label } : {}) });
      const s = await add().catch(async (err) => {
        // Avertissement pas encore enregistré pour ce site (accepté ailleurs, ou liste en retard) : on le montre.
        if (errorCode(err) === "consent_required") {
          setStep("consent");
          return null;
        }
        throw err;
      });
      if (!s) return;
      setSiteId(s.id);
      setStep("progress");
      await props.onChanged();
    } catch (err) {
      held.current = null;
      const c = errorCode(err);
      setError(c === "label_taken" ? "errLabelTaken" : c === "bad_label" || c === "invalid_label" ? "errBadLabel" : c === "too_many" ? "stErrTooMany" : "stErrGeneric");
    } finally {
      setBusy(false);
    }
  };

  const back = step === "creds" || step === "consent" ? (): void => setStep(step === "creds" && pick && !known(pick.site) ? "consent" : "pick") : null;
  // Portail sur <body> : la feuille sort du contexte d'empilement de l'écran, au-dessus du bouton des sessions.
  return createPortal(
    <div className="st-backdrop" onClick={props.onClose}>
      <div ref={box} className="st-sheet" role="dialog" aria-modal="true" aria-labelledby="st-sheet-title" data-site-sheet={step} onClick={(e) => e.stopPropagation()}>
        <div className="st-sheet-head">
          {back && !following ? <button type="button" className="icon-btn" aria-label={t(L, "stBack")} onClick={back}><Icon name="back" size={18} /></button> : <span />}
          <button type="button" className="icon-btn" aria-label={t(L, "stClose")} onClick={props.onClose}><Icon name="close" size={18} /></button>
        </div>
        {step === "pick" ? (
          <>
            <h2 id="st-sheet-title" tabIndex={-1}>{t(L, "stPickTitle")}</h2>
            <div className="st-grid" role="list">
              {data.catalog.map((c) => (
                <button key={c.site} type="button" role="listitem" className="st-tile" data-site-pick={c.site} onClick={() => choose(c)}>
                  <SiteMark site={c.site} size={48} />
                  <span>{c.name}</span>
                </button>
              ))}
            </div>
          </>
        ) : step === "consent" ? (
          <>
            <h2 id="st-sheet-title" tabIndex={-1}>{t(L, "stConsentTitle", { site: name })}</h2>
            {following ? <p className="ob-note">{t(L, "stAskConsent", { site: name })}</p> : null}
            <p className="ob-muted">{t(L, "stConsentLead")}</p>
            <ul className="st-consent st-points">
              {CONSENTS.map(([k, icon]) => (
                <li key={k}>
                  <Icon name={icon} size={18} />
                  <span>{t(L, k, { site: name })}</span>
                </li>
              ))}
            </ul>
            <label className="st-agree st-agree-one">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-site-agree />
              <span>{t(L, "stConsentAgree", { site: name })}</span>
            </label>
            {error ? <p className="ob-error" role="alert">{t(L, error)}</p> : null}
            <button type="button" className="ob-btn primary st-wide" data-site-consent disabled={!agreed || busy} onClick={() => void accept()}>{t(L, "stConsentOk")}</button>
          </>
        ) : step === "creds" ? (
          <form onSubmit={(e) => void submit(e)} autoComplete="off" data-site-creds>
            <div className="st-creds-head">
              <SiteMark site={pick?.site ?? ""} size={44} />
              <h2 id="st-sheet-title" tabIndex={-1}>{t(L, "stCredsTitle", { site: name })}</h2>
            </div>
            <div className="ob-field">
              <label htmlFor="st-user">{t(L, "stUsername")}</label>
              <input id="st-user" name="username" autoComplete="off" autoCapitalize="none" spellCheck={false} inputMode="email" required />
            </div>
            <PasswordField lang={L} id="st-pass" />
            <div className="ob-field">
              <label htmlFor="st-label">{t(L, "stLabel")}</label>
              <input id="st-label" name="label" maxLength={40} placeholder={name} autoComplete="off" aria-describedby="st-label-hint" />
              <p id="st-label-hint" className="ob-note">{t(L, "stLabelHint", { site: name })}</p>
            </div>
            <p className="ob-note st-lock"><Icon name="shield" size={14} /> {t(L, "stSealed")}</p>
            {error ? <p className="ob-error" role="alert">{t(L, error)}</p> : null}
            <button type="submit" className="ob-btn primary st-wide" disabled={busy}>{busy ? t(L, "stSending") : t(L, "stValidate")}</button>
          </form>
        ) : siteId ? (
          <Progress client={client} lang={L} siteId={siteId} name={name} held={held} onClose={props.onClose} onChanged={props.onChanged} />
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function PasswordField({ lang: L, id, label = "stPassword" }: { lang: Lang; id: string; label?: Key }): React.ReactElement {
  const [show, setShow] = useState(false);
  return (
    <div className="ob-field">
      <label htmlFor={id}>{t(L, label)}</label>
      <div className="st-pass">
        <input id={id} name="password" type={show ? "text" : "password"} autoComplete="off" required />
        <button type="button" className="ob-btn small" aria-pressed={show} aria-controls={id} onClick={() => setShow((v) => !v)}>{t(L, show ? "stHide" : "stShow")}</button>
      </div>
    </div>
  );
}

/** Suivi en direct d'une connexion (lancée ici, ou depuis le chat), et réponse aux demandes du site. */
function Progress(props: { client: NokkerClient; lang: Lang; siteId: string; name: string; held: React.MutableRefObject<{ value: string; until: number } | null>; onClose: () => void; onChanged: () => Promise<void> }): React.ReactElement {
  const { client, lang: L, siteId, held } = props;
  const [s, setS] = useState<SiteCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | undefined>();
  const [now, setNow] = useState(Date.now());
  // Demandes déjà répondues (id → sorte) : on ne les remontre pas pendant que le noyau avance.
  const answered = useRef<Map<string, string>>(new Map());
  const tick = useCallback(() => client.getSite(siteId).then(setS, () => undefined), [client, siteId]);
  useEffect(() => {
    void tick();
    const id = setInterval(() => {
      void tick();
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [tick]);

  const send = useCallback(
    async (rid: string, value: string | null): Promise<void> => {
      setBusy(true);
      setError(undefined);
      try {
        if (value === null) await client.answerSiteRequest(rid, { done: true });
        else {
          const r = await client.getSiteRequest(rid);
          if (!r.machine_key) throw new Error("no key");
          await client.answerSiteRequest(rid, { sealed: await sealValue(r.machine_key, rid, value) });
        }
        answered.current.set(rid, s?.request?.kind ?? "");
        await tick();
        void props.onChanged();
      } catch (e) {
        const c = errorCode(e);
        if (c === "answered") answered.current.set(rid, s?.request?.kind ?? "");
        setError(c === "expired" ? "stErrExpired" : c === "answered" ? undefined : "stErrGeneric");
      } finally {
        setBusy(false);
      }
    },
    [client, tick, props, s],
  );

  const req = s?.request && !answered.current.has(s.request.id) ? s.request : null;
  // Le mot de passe du formulaire part dès que le noyau ouvre la demande ; il n'est gardé que 2 minutes.
  useEffect(() => {
    if (!req || req.kind !== "password" || busy) return;
    const h = held.current;
    if (!h) return;
    held.current = null;
    if (h.until > Date.now()) void send(req.id, h.value);
  }, [req, busy, held, send]);
  // Nouvelle demande de code parce que le site a refusé le précédent (signal du noyau).
  const codeAgain = req?.kind === "code" && s?.signal === "wrong_code";

  const state = s?.state ?? "connecting";
  const name = s?.site_name ?? props.name;
  const left = req ? Math.max(0, Math.round(req.expires_at - now / 1000)) : null;
  const leftText = left !== null && left < 3600 ? t(L, "stTimeLeft", { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` }) : "";
  const done = state === "connected";
  const order = state === "connected" ? 3 : state === "connecting" && !s?.last_ok_at && !answered.current.size ? 0 : 1;
  const phase = (i: number): "done" | "now" | "todo" => (order > i ? "done" : order === i ? "now" : "todo");
  const ask = (kind: "password" | "code" | "link", title: Key, label: Key, extra?: React.ReactNode) => (
    <form
      className="st-ask"
      data-site-ask={kind}
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        const f = e.currentTarget;
        const input = f.elements.namedItem(kind === "password" ? "password" : "value") as HTMLInputElement;
        const v = kind === "code" ? input.value.replace(/\s+/g, "") : input.value.trim();
        input.value = "";
        if (v && req) void send(req.id, v);
      }}
    >
      <p className="st-ask-title">{t(L, title, { site: name })}</p>
      {extra}
      {kind === "password" ? (
        <PasswordField lang={L} id="st-ask-pass" />
      ) : (
        <div className="ob-field st-code">
          <label htmlFor={`st-ask-${kind}`}>{t(L, label)}</label>
          <input
            id={`st-ask-${kind}`}
            name="value"
            required
            autoCapitalize="none"
            spellCheck={false}
            {...(kind === "code" ? { inputMode: "numeric" as const, autoComplete: "one-time-code", maxLength: 12 } : { inputMode: "url" as const, autoComplete: "off" })}
          />
        </div>
      )}
      <button type="submit" className="ob-btn primary st-wide" disabled={busy}>{busy ? t(L, "stSending") : t(L, "stSend")}</button>
      {leftText ? <p className="ob-muted">{leftText}</p> : null}
    </form>
  );

  return (
    <div className="st-progress" data-site-progress={state} aria-live="polite">
      <div className="st-creds-head">
        <SiteMark site={s?.site ?? ""} size={44} />
        <h2 id="st-sheet-title" tabIndex={-1}>{done ? t(L, "stTitleDone", { site: name }) : t(L, "stTitleConnecting", { site: name })}</h2>
      </div>
      {state !== "suspended" && state !== "failed" ? (
        <ol className="st-steps">
          {(["stStepOpen", "stStepSign", "stStepCheck"] as const).map((k, i) => (
            <li key={k} data-step={phase(i)}>
              <span className="st-dot">{phase(i) === "done" ? <Icon name="check" size={12} /> : phase(i) === "now" ? <span className="st-spin" /> : null}</span>
              {t(L, k, { site: name })}
            </li>
          ))}
        </ol>
      ) : null}
      {error ? <p className="ob-error" role="alert">{t(L, error)}</p> : null}
      {state === "needs_password" && req?.kind === "password" && !busy && !held.current ? (
        ask("password", "stAskPassword", "stPassword", <p className="ob-note st-lock"><Icon name="shield" size={14} /> {t(L, "stSealed")}</p>)
      ) : state === "needs_code" && req?.kind === "code" ? (
        ask("code", "stAskCode", "stCodeLabel", <p className="ob-note">{t(L, codeAgain ? "stCodeAgain" : "stCodeWhere")}</p>)
      ) : state === "needs_link" && req?.kind === "link" ? (
        ask("link", "stAskLink", "stLinkLabel", <p className="ob-note">{t(L, "stLinkHow")}</p>)
      ) : state === "needs_link" ? (
        <p className="ob-muted" data-site-ask="link-auto">{t(L, "stLinkAuto", { site: name })}</p>
      ) : state === "needs_app_approval" && req?.kind === "app_approval" ? (
        <div className="st-ask" data-site-ask="app">
          <p className="st-ask-title">{t(L, "stAskPhone", { site: name })}</p>
          <button type="button" className="ob-btn primary st-wide" disabled={busy} onClick={() => void send(req.id, null)}>{t(L, "stDone")}</button>
          {leftText ? <p className="ob-muted">{leftText}</p> : null}
        </div>
      ) : state === "needs_you" ? (
        <div className="st-ask" data-site-ask="human">
          <p className="st-ask-title">{t(L, "stAskHuman", { site: name })}</p>
          {s?.handoff_url ? (
            <>
              <p className="ob-note">{t(L, "stHumanHow2")}</p>
              <a className="ob-btn primary st-wide" href={s.handoff_url} target="_blank" rel="noopener" data-site-handoff>{t(L, "stOpenScreen")}</a>
            </>
          ) : (
            <p className="ob-note">{t(L, "stHumanUsed")}</p>
          )}
        </div>
      ) : state === "suspended" && s ? (
        <div className="st-ask bad" data-site-ask="refused">
          <p className="st-ask-title">{t(L, "stAskRefused", { site: name })}</p>
          <button type="button" className="ob-btn primary st-wide" disabled={busy} onClick={() => void client.replaceSitePassword(s.id).then(tick, () => setError("stErrGeneric"))}>{t(L, "stNewPassword")}</button>
        </div>
      ) : state === "failed" && s ? (
        <div className="st-ask bad" data-site-ask="failed">
          <p className="st-ask-title">{t(L, "stAskFailed", { site: name })}</p>
          <p className="ob-note" data-site-signal={s.signal ?? ""}>{stateText(L, s)}</p>
          <button type="button" className="ob-btn primary st-wide" disabled={busy} onClick={() => void client.connectSite(s.id).then(tick, () => setError("stErrGeneric"))}>{t(L, "stRetry")}</button>
        </div>
      ) : done ? (
        <div className="st-ask ok" data-site-ask="done">
          <p className="st-ask-title"><Icon name="check" size={18} /> {t(L, "stConnectedAs", { name: s?.account_name || s?.username || name })}</p>
          <button type="button" className="ob-btn primary st-wide" data-site-finish onClick={props.onClose}>{t(L, "stFinish")}</button>
        </div>
      ) : null}
      {!done && state !== "suspended" && state !== "failed" ? <p className="ob-muted">{t(L, "stYouCanClose")}</p> : null}
      {s && LIVE.has(state) && state !== "expired" ? (
        <button type="button" className="ob-btn small st-cancel" data-site-cancel disabled={busy} onClick={() => void client.cancelSite(s.id).then(tick, () => setError("stErrGeneric"))}>{t(L, "stCancel")}</button>
      ) : null}
    </div>
  );
}
