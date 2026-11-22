/**
 * Bulle « navigateur » (V3, l'agent qui montre ; BROWSER-LIVE v3) : la capture en direct de l'onglet de l'agent avec
 * le curseur tête de lion, la frise de ses actions (vignettes aux frames), la carte d'approbation ancrée sur la frame
 * où elle est née, et la reprise en main (2FA, connexion, CAPTCHA : « Je prends la main », puis « J'ai fini »).
 *
 * Vie privée : une frame `sensitive` n'a PAS d'image (le noyau ne l'a pas capturée) : un cache neutre la remplace. Le
 * texte saisi n'arrive jamais ici (« texte saisi (n car.) »). Les URL de capture sont signées, courtes (60 s) et
 * jamais gardées : une capture expirée (410) relit l'état de la session.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BrowserAction, BrowserBubbleState, BrowserFrame, BrowserHandoffReason } from "@nokker-apps/sdk";
import { useStore } from "../context.js";
import { ApprovalCard } from "../bubbles/kinds.js";
import { Icon, type IconName } from "../icons.js";
import { useBrowserLive } from "./useBrowserLive.js";
import { NinaPresenter } from "./NinaPresenter.js";
import { presenterEnabled, presenterView, type PresenterView } from "./presenter.js";
import { shellLang, tr } from "../i18n/index.js";
import "./browser.css";

const reduceMotion = (): boolean => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function browserStatusLabel(s: BrowserBubbleState["state"]): string {
  return s === "handoff" ? tr("your turn") : s === "ended" ? tr("finished") : tr("live now");
}

function handoffText(r: BrowserHandoffReason): string {
  switch (r) {
    case "2fa":
      // Le noyau laisse passer les LECTURES pendant la passation : on ne promet que l'absence d'image (relecture des textes, 07.11).
      return tr("The site asks for a verification code. Take over to enter it: Nina waits and takes no picture while you type.");
    case "login":
      return tr("The site asks you to sign in. Take over to do it yourself: Nina waits.");
    case "captcha":
      return tr("The site asks for a check that only a person can do. Take over: Nina never solves it.");
    default:
      return tr("The site needs you. Take over: Nina waits.");
  }
}

function endText(r: string): string {
  switch (r) {
    case "done":
      return tr("Finished.");
    case "cancelled":
      return tr("Stopped: nothing more was done on the site.");
    case "timeout":
      return tr("Stopped: the session lasted too long.");
    default:
      return tr("Stopped after an error.");
  }
}

const KIND_ICON: Record<BrowserAction["kind"], IconName> = { navigate: "link", click: "pointer", type: "page", scroll: "chevronDown", read: "search", wait: "timer" };

/** Cadenas (frame non capturée) : icône de la marque, jamais un emoji. */
function Lock(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function actionLabel(a: BrowserAction): string {
  switch (a.kind) {
    case "navigate":
      return tr("Opened: {0}", a.url_host);
    case "click":
      return tr("Clicked: {0}", a.target_label);
    case "type":
      return tr("Typed: {0}", a.target_label);
    case "scroll":
      return tr("Scrolled: {0}", a.target_label);
    case "read":
      return tr("Read: {0}", a.target_label);
    default:
      return tr("Waited: {0}", a.target_label);
  }
}

/** La capture courante (la dernière frame) avec le curseur lion à la position de la dernière action ; un toucher
 * l'agrandit en plein écran (le curseur suit). */
function LiveView({ frame, cursor, status, onExpired, big, onToggle, presenter }: { frame: BrowserFrame | null; cursor: { x: number; y: number } | null; status: string; onExpired: () => void; big?: boolean; onToggle?: () => void; presenter?: PresenterView | null }): React.ReactElement {
  const store = useStore();
  const src = frame?.frame_url ? store.client.resolveUrl(frame.frame_url) : null;
  const ratio = frame?.w && frame.h ? `${frame.w} / ${frame.h}` : "16 / 10";
  return (
    <figure className={`brw-live ${big ? "big" : ""}`} style={{ aspectRatio: ratio }} data-brw-live={frame ? (frame.sensitive ? "sensitive" : "frame") : "empty"}>
      {frame && frame.sensitive ? (
        <div className="brw-veil" role="img" aria-label={tr("Hidden: a password, card or code field is in use. Nothing is captured.")}>
          <Lock />
          <span>{tr("Hidden: a password, card or code field is in use. Nothing is captured.")}</span>
        </div>
      ) : src ? (
        <button type="button" className="brw-zoom" onClick={onToggle} aria-label={big ? tr("Close the large view") : tr("Show larger")} data-brw-zoom={big ? "close" : "open"}>
          <img src={src} alt={tr("What Nina sees on {0}", frame!.url_host)} referrerPolicy="no-referrer" onError={onExpired} draggable={false} />
        </button>
      ) : (
        <div className="brw-veil brw-wait">
          <span>{tr("Opening the browser…")}</span>
        </div>
      )}
      {presenter && frame ? <NinaPresenter variant={big ? "stage" : "bubble"} point={presenter.target} bubbles={presenter.bubbles} state={status === "running" ? "speaking" : "idle"} lang={shellLang()} /> : null}
      {cursor && frame && !frame.sensitive && !presenter ? (
        <span className={`brw-cursor ${reduceMotion() ? "jump" : ""}`} style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22">
            <path d="M3 2l7 19 2.6-7.4L20 11z" fill="var(--brw-cursor, #e2574c)" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
          <img src="/brand/nokker-emblem-small-light.svg" alt="" width="18" height="18" />
        </span>
      ) : null}
      {frame ? (
        <figcaption>
          <span className={`brw-dot ${status}`} aria-hidden="true" />
          <span className="brw-host">{frame.url_host}</span>
          <span className="brw-title">{frame.title}</span>
        </figcaption>
      ) : null}
    </figure>
  );
}

export function BrowserBody({ state, readOnly }: { state: BrowserBubbleState; readOnly: boolean }): React.ReactElement {
  const store = useStore();
  const { live, cards, reload, resume } = useBrowserLive(state.session_id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const status = live.ended ? "ended" : live.status;
  // Présentatrice (drapeau browser_live_presenter, éteint par défaut) : rien ne change sans elle.
  const presenter = useMemo(() => (presenterEnabled() ? presenterView(live, cards) : null), [live, cards]);
  const frame = live.frames[live.frames.length - 1] ?? null;
  const lastCursor = useMemo(() => [...live.actions].reverse().find((a) => a.cursor && (!frame || a.seq <= frame.seq + 1))?.cursor ?? null, [live.actions, frame]);
  // Frise : actions et vignettes dans l'ordre des `seq` ; chaque carte s'ancre après la vignette de SA frame.
  const items = useMemo(() => {
    const list: ({ k: "a"; a: BrowserAction } | { k: "f"; f: BrowserFrame })[] = [...live.actions.map((a) => ({ k: "a" as const, a })), ...live.frames.map((f) => ({ k: "f" as const, f }))];
    return list.sort((x, y) => (x.k === "a" ? x.a.seq : x.f.seq) - (y.k === "a" ? y.a.seq : y.f.seq));
  }, [live.actions, live.frames]);
  const strip = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (reduceMotion()) return;
    const el = strip.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [items.length]);
  const anchored = new Set(cards.map((c) => c.id));
  const seqs = new Set(live.frames.map((f) => f.seq));
  const floating = cards.filter((c) => !seqs.has(c.seq)); // frame déjà sortie de la fenêtre des 20 : carte sous la frise
  // « Je prends la main » : la fenêtre s'ouvre DANS le geste (sinon bloquée), puis le code à usage unique est échangé
  // (Bearer) contre le cookie de reprise et l'URL de l'écran ; un lien nu ne marche pas, c'est voulu.
  const takeOver = async (): Promise<void> => {
    if (!live.handoff) return;
    setErr(null);
    const w = window.open("", "_blank");
    try {
      const t = await store.client.takeOverBrowser(live.handoff.takeover_url);
      const url = store.client.resolveUrl(t.screen_url);
      if (w && url) {
        w.opener = null;
        w.location.replace(url);
      }
    } catch {
      w?.close();
      setErr(tr("The tab could not be opened: the link may have been used already. Ask Nina again."));
      reload();
    }
  };
  const [big, setBig] = useState(false);
  useEffect(() => {
    if (!big) return;
    const k = (e: KeyboardEvent): void => void (e.key === "Escape" && setBig(false));
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [big]);
  const done = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await resume();
    } catch {
      setErr(tr("Nina could not take the tab back. Try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bubble-body brw" data-brw-session={state.session_id} data-brw-state={status}>
      {state.task ? <p className="brw-task">{state.task}</p> : null}
      <LiveView frame={frame} cursor={lastCursor} status={status} onExpired={reload} onToggle={() => setBig(true)} presenter={presenter} />
      {big ? createPortal(
        <div className="brw-lightbox" role="dialog" aria-modal="true" aria-label={tr("What Nina sees on {0}", frame?.url_host ?? "")} onClick={() => setBig(false)} data-brw-lightbox>
          <div onClick={(e) => e.stopPropagation()}>
            <LiveView frame={frame} cursor={lastCursor} status={status} onExpired={reload} big onToggle={() => setBig(false)} presenter={presenter} />
          </div>
        </div>,
        document.body,
      ) : null}
      {live.handoff && !readOnly ? (
        <div className="brw-handoff" role="alert" data-brw-handoff={live.handoff.reason}>
          <p>{handoffText(live.handoff.reason)}</p>
          <div className="brw-handoff-actions">
            <button type="button" className="ob-btn" onClick={() => void takeOver()} data-brw-takeover>
              {tr("I'll take over")}
            </button>
            <button type="button" className="ob-btn ob-btn-ghost" onClick={() => void done()} disabled={busy} data-brw-resume>
              {tr("I'm done")}
            </button>
          </div>
          {err ? <p className="error">{err}</p> : null}
        </div>
      ) : null}
      {live.ended ? (
        <p className="brw-ended" role="status" data-brw-ended={live.ended.reason}>
          {endText(live.ended.reason)}
        </p>
      ) : null}
      {items.length ? (
        <ol className="brw-strip" ref={strip} aria-label={tr("What Nina did")}>
          {items.map((it) =>
            it.k === "a" ? (
              <li key={`a${it.a.seq}`} className={`brw-step k-${it.a.kind}`} data-brw-action={it.a.kind}>
                <span className="brw-ico" aria-hidden="true">
                  <Icon name={KIND_ICON[it.a.kind]} />
                </span>
                <span className="brw-lbl">{actionLabel(it.a)}</span>
              </li>
            ) : (
              <li key={`f${it.f.seq}`} className="brw-step brw-thumb" data-brw-frame={it.f.seq}>
                {it.f.sensitive || !it.f.frame_url ? (
                  <span className="brw-mini veil" role="img" aria-label={tr("Hidden capture")}>
                    <Lock />
                  </span>
                ) : (
                  <img className="brw-mini" src={store.client.resolveUrl(it.f.frame_url) ?? undefined} alt="" referrerPolicy="no-referrer" onError={(e) => ((e.currentTarget.style.visibility = "hidden"), undefined)} />
                )}
                {cards
                  .filter((c) => c.seq === it.f.seq)
                  .map((c) => (
                    <span key={c.id} className="brw-pin" aria-hidden="true" title={tr("A card is waiting here")}>
                      !
                    </span>
                  ))}
              </li>
            ),
          )}
        </ol>
      ) : null}
      {cards.map((c) =>
        anchored.has(c.id) ? (
          <div key={c.id} className={`brw-card ${floating.includes(c) ? "" : "anchored"}`} data-brw-card={c.id} data-brw-card-seq={c.seq}>
            <ApprovalCard approvalId={c.id} uid={`brw-${c.id}`} />
          </div>
        ) : null,
      )}
    </div>
  );
}
