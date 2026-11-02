/**
 * The Guide's panel (persona « Guide », core docs/GUIDE.md): opened by « Discover » (account menu, palette) or by
 * `/guide [question]` in the composer. First opening: the welcome tour (up to three cards) and « Got it ». Then: « Try
 * next », « What I can do » by status, and a question field (`POST /v1/guide/ask`, six messages of local history).
 * Read only: it activates nothing; « Open » goes to a screen, « Show me » points an arrow at an element.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { GuideView, NokkerClient } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import { Icon } from "../icons.js";
import { showMeEnabled } from "../showme/model.js";
import { CapabilityList, Cards, FeatureCard, type CardEnv } from "./GuideCards.js";
import { askErrorText, featureText, historyOf, introPicks, withAnswer, type GuideMessage } from "./model.js";
import "./guide.css";

export function GuidePanel({
  client,
  served,
  initialQuestion,
  onClose,
  onOpenView,
  onShowMe,
}: {
  client: NokkerClient;
  served: readonly string[];
  initialQuestion?: string;
  onClose: () => void;
  onOpenView: (screen: string) => void;
  onShowMe: (ui: string) => void;
}): React.ReactElement {
  const [view, setView] = useState<GuideView | null>(null);
  const [failed, setFailed] = useState(false);
  const [tourDone, setTourDone] = useState(false);
  const [messages, setMessages] = useState<GuideMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<GuideMessage[]>([]);
  messagesRef.current = messages;

  useEffect(() => {
    let live = true;
    client.getGuide().then(
      (v) => live && setView(v),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client]);

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const ask = useCallback(
    async (q: string) => {
      const text = q.trim();
      if (!text || busy) return;
      setBusy(true);
      setError(null);
      setDraft("");
      try {
        const a = await client.guideAsk(text, historyOf(messagesRef.current));
        setMessages((m) => withAnswer(m, text, a));
      } catch (e) {
        setError(askErrorText(e));
        setDraft(text);
      } finally {
        setBusy(false);
      }
    },
    [client, busy],
  );

  // `/guide <question>`: asked once the panel is loaded (a first-time person sees the tour above it).
  useEffect(() => {
    if (view && initialQuestion && !asked.current) {
      asked.current = true;
      void ask(initialQuestion);
    }
  }, [view, initialQuestion, ask]);

  const env: CardEnv | null = view
    ? { served, coreShowMe: view.show_me, webShowMe: showMeEnabled(), onOpen: onOpenView, onShowMe }
    : null;

  const understood = (): void => {
    setTourDone(true);
    client.guideIntroSeen().then(
      () => setView((v) => (v ? { ...v, intro: { ...v.intro, seen: true } } : v)),
      () => undefined,
    );
  };

  const tour = !!view && !view.intro.seen && !tourDone;
  const next = view?.next ? view.features.find((f) => f.id === view.next) : undefined;
  return (
    <section className="guide-panel" role="dialog" aria-label={tr("Guide")} aria-modal="false">
      <header className="guide-head">
        <span className="guide-avatar" aria-hidden="true">
          <Icon name="bot" size={18} />
        </span>
        <h2>{tr("Guide")}</h2>
        <button type="button" className="icon-btn" aria-label={tr("Close the Guide")} onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="guide-body">
        {failed ? <p className="error" role="alert">{tr("The Guide is not reachable right now.")}</p> : null}
        {!view && !failed ? <p className="fine">{tr("loading…")}</p> : null}
        {view && env && tour ? (
          <div className="guide-tour" data-part="tour">
            <p className="guide-say">{tr("Hello, I am the Guide. Here are a few things Nokker can do for you.")}</p>
            <Cards features={introPicks(view.intro.picks, view.features)} env={env} />
            <button type="button" className="btn primary guide-ok" onClick={understood}>
              {tr("Got it")}
            </button>
          </div>
        ) : null}
        {view && env && !tour ? (
          <>
            {next ? (
              <div className="guide-next" data-part="next">
                <p className="guide-say">
                  {tr("Try next:")} <strong>{featureText(next.id).name}</strong>
                </p>
                <FeatureCard f={next} env={env} />
              </div>
            ) : null}
            {messages.map((m, i) => (
              <div key={i} className={`guide-msg ${m.role}`}>
                {/* The reply is text: React escapes it, there is no HTML path. */}
                <p>{m.text}</p>
                {m.features?.length ? <Cards features={m.features} env={env} /> : null}
              </div>
            ))}
            {busy ? <p className="fine" role="status">{tr("The Guide is thinking…")}</p> : null}
            <details className="guide-all" open={messages.length === 0}>
              <summary>{tr("What I can do")}</summary>
              <CapabilityList features={view.features} env={env} />
            </details>
          </>
        ) : null}
      </div>
      {view && !tour ? (
        <form
          className="guide-ask"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(draft);
          }}
        >
          {error ? <p className="error" role="alert">{error}</p> : null}
          <label htmlFor="nk-guide-q" className="sr-only">
            {tr("Ask the Guide")}
          </label>
          <input ref={field} id="nk-guide-q" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={tr("What can you do? How do I…")} autoComplete="off" maxLength={1000} />
          <button type="submit" className="icon-btn send" aria-label={tr("Ask")} disabled={busy || !draft.trim()}>
            <Icon name="send" size={18} />
          </button>
        </form>
      ) : null}
    </section>
  );
}
