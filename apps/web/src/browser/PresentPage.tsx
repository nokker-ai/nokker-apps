/**
 * `/present/{session}` — grand écran 16:9 (AirPlay depuis l'iPhone ou le Mac, ou cast) : la page que Nina parcourt en
 * fond, Nina en plan taille à droite, ses bulles d'explication derrière elle, et les sous-titres. On continue de lui
 * parler depuis le téléphone ou l'ordinateur (même session) : cet écran n'a pas de composeur et n'ouvre le micro que
 * si l'opérateur le demande (`?listen=1`, micro de la régie). Nina en direct (<NinaLive>, drapeau `nina_live`) : une
 * salle Runway n'a qu'UN participant — sans micro, elle réagit seulement à ce qui lui est dit ici ; ses sous-titres
 * (onCaption) remplacent alors la phrase du geste. Drapeau `browser_live_presenter` (éteint : la page le dit).
 */
import React, { useEffect, useMemo, useState } from "react";
import { NinaLive, type NinaLiveError } from "../avatar/NinaLive.js";
import { StoreContext, useStore } from "../context.js";
import { useNokker } from "../store.js";
import { uiLang } from "../components/ConnectorsTab.js";
import { Welcome } from "../welcome/Welcome.js";
import { onPresentScreen } from "../kiosk/scope.js";
import { shellLang, tr } from "../i18n/index.js";
import { useBrowserLive } from "./useBrowserLive.js";
import { NinaPresenter } from "./NinaPresenter.js";
import { NINA_LIVE_TEXT } from "../ninaLive/text.js";
import { capability } from "../capabilities.js";
import { Orb } from "../voice/Orb.js";
import { useNarration } from "./narration.js";
import { useFollow } from "./follow.js";
import { type LiveState, ninaLiveEnabled, presentLayout, presentLiveEnabled, presenterEnabled, presenterView, stageFrameBox, toStage, vignetteOrigin, vignetteSpot } from "./presenter.js";
import "./presenter.css";

export function presentSessionFromPath(path: string): string | null {
  return /^\/present\/(bs_[A-Za-z0-9]+)\/?$/.exec(path)?.[1] ?? null;
}

/** Sans vignette (Nina live indisponible), le faisceau part du bas du bloc de bulles qui narre la cible (0–1 de la scène). */
const BUBBLES_ORIGIN = { x: 0.8, y: 0.45 };

function Stage({ sessionId }: { sessionId: string }): React.ReactElement {
  const store = useStore();
  const { live, cards, reload } = useBrowserLive(sessionId);
  const view = useMemo(() => presenterView(live, cards), [live, cards]);
  const frame = live.frames[live.frames.length - 1] ?? null;
  const src = frame?.frame_url ? store.client.resolveUrl(frame.frame_url) : null;
  const status = live.ended ? "ended" : live.status;
  // Nina en direct dans le fil de la bulle (le noyau vérifie l'appartenance au fil).
  const [threadId, setThreadId] = useState<string | null>(null);
  const [spoken, setSpoken] = useState<{ text: string; at: number } | null>(null);
  const listen = new URLSearchParams(location.search).get("listen") === "1";
  const liveOn = ninaLiveEnabled();
  // Mode démo : Nina live en vignette (un seul <NinaLive>, monté pour la présentation, démonté à la fin).
  const demo = presentLiveEnabled();
  const ptt = new URLSearchParams(location.search).get("ptt") === "1";
  const [liveState, setLiveState] = useState<LiveState>("connecting");
  const [mic, setMic] = useState(false);
  const [held, setHeld] = useState(false);
  const [floor, setFloor] = useState<"nina" | "you">("you");
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    // Push-to-talk au clavier (barre d'espace), seulement une fois le micro demandé par la personne.
    if (!demo || !ptt || !mic) return;
    const down = (e: KeyboardEvent): void => {
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setHeld(true);
      }
    };
    const up = (e: KeyboardEvent): void => {
      if (e.code === "Space") setHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      setHeld(false);
    };
  }, [demo, ptt, mic]);
  useEffect(() => {
    if (!liveOn) return;
    let ok = true;
    void store.client.getBrowserSession(sessionId).then(
      (v) => (v.bubble_id ? store.client.getBubble(v.bubble_id) : null),
    ).then(
      (b) => {
        if (!ok) return;
        if (b) setThreadId(b.thread_id);
        else setLiveState("unavailable"); // pas de fil : pas de salle
      },
      () => ok && setLiveState("unavailable"),
    );
    return () => {
      ok = false;
    };
  }, [liveOn, sessionId, store.client]);
  // L'échange au micro : la vignette Nina live n'existe que pendant lui (jamais un visage muet sur la voix de la narration).
  const exchange = mic || listen;
  // Narration vocale des cibles (mode démo) : une seule source audio à la fois, coupée quand Nina live parle.
  const narr = useNarration({ client: store.client, sessionId, points: live.points ?? [], enabled: demo && capability("browser_narration") !== false, suspended: floor === "nina" && exchange && liveState !== "unavailable", lang: shellLang() });
  const narrating = narr.phase === "speaking";
  const caption = narrating && narr.text ? narr.text : spoken && Date.now() - spoken.at < 12_000 ? spoken.text : view.caption;
  const fb = stageFrameBox(frame?.w && frame.h ? frame.w / frame.h : 1.6);
  const pos = { left: `${fb.x * 100}%`, top: `${fb.y * 100}%`, width: `${fb.w * 100}%`, height: `${fb.h * 100}%` };
  const layout = presentLayout({ demo, liveOn, live: liveState });
  const showVignette = layout.vignette && exchange && !live.ended; // montée pendant l'échange au micro, démontée après
  const presence = demo && (layout.vignette || narr.available !== false); // le coin de Nina : orbe (narration) ou vignette (échange)
  const spot = vignetteSpot([toStage(fb, view.target), fb]); // un coin libre, jamais sur la cible ni sur la page
  const T = NINA_LIVE_TEXT[uiLang() === "en" ? "en" : "fr"];
  const onLiveError = (c: NinaLiveError): void => {
    if (c === "audio_blocked") setBlocked(true);
    else if (c === "live_unavailable" || c === "session_ended") setLiveState("unavailable");
  };
  return (
    <main className="present" data-present={status} data-present-session={sessionId} data-narration={narr.phase}>
      <div className="present-stage">
        {src ? <img className="present-frame" style={pos} src={src} alt={tr("What Nina sees on {0}", frame!.url_host)} referrerPolicy="no-referrer" onError={reload} /> : <div className="present-frame present-wait" style={pos}>{frame?.sensitive ? tr("Hidden: a password, card or code field is in use. Nothing is captured.") : tr("Opening the browser…")}</div>}
        {frame ? (
          <p className="present-host">
            <strong>{frame.url_host}</strong> {frame.title}
          </p>
        ) : null}
        <NinaPresenter
          variant="stage"
          bare={demo}
          origin={demo ? (presence ? vignetteOrigin(spot) : BUBBLES_ORIGIN) : null}
          point={toStage(fb, view.target)}
          bubbles={view.bubbles}
          state={status === "running" ? "speaking" : "idle"}
          lang={shellLang()}
          live={!demo && liveOn && threadId ? <NinaLive client={store.client} threadId={threadId} listen={listen} framing="upper" className="np-avatar" onCaption={(text) => setSpoken({ text, at: Date.now() })} /> : undefined}
        />
        {presence ? (
          <aside className="pl-vignette" style={{ left: `${spot.x * 100}%`, top: `${spot.y * 100}%`, width: `${spot.w * 100}%` }} data-pl-presence data-pl-vignette={showVignette ? "" : undefined} data-pl-orb-box={showVignette ? undefined : ""} data-pl-state={liveState}>
            <div className="pl-thumb">
              {showVignette && threadId ? (
                <NinaLive client={store.client} threadId={threadId} framing="head" muted={narrating} listen={!narrating} pushToTalk={ptt} talkHeld={held && !narrating} echoTailMs={600}
                  className="pl-live" onFloor={setFloor} onReady={() => setLiveState("live")} onError={onLiveError} onCaption={(text) => setSpoken({ text, at: Date.now() })} />
              ) : null}
              {!showVignette ? (
                <div className="pl-orb" data-pl-orb-state={narrating ? "speaking" : narr.phase === "loading" ? "thinking" : "idle"}>
                  <Orb state={narrating ? "speaking" : narr.phase === "loading" ? "thinking" : "idle"} size="lg" />
                </div>
              ) : null}
              <span className="pl-name">{tr("Nina")}</span>
            </div>
            {showVignette && (mic || listen) ? (
              <p className={"pl-floor pl-floor-" + (narrating ? "nina" : floor)} role="status" aria-live="polite" data-pl-floor={narrating ? "nina" : floor}>
                {narrating || floor === "nina" ? T.ninaSpeaks : ptt ? (held ? T.listening : T.holdHint) : T.yourTurn}
              </p>
            ) : null}
            <div className="pl-actions">
              {blocked || narr.blocked ? (
                <button type="button" className="pl-btn" data-pl-sound onClick={() => { setBlocked(false); narr.unlock(); document.querySelectorAll("audio").forEach((a) => void a.play().catch(() => undefined)); }}>
                  {T.sound}
                </button>
              ) : null}
              {showVignette && ptt && mic ? (
                <button type="button" className={"pl-btn pl-hold" + (held ? " held" : "")} aria-pressed={held} disabled={floor === "nina" || narrating}
                  onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setHeld(true); }} onPointerUp={() => setHeld(false)} onPointerCancel={() => setHeld(false)}>
                  {T.hold}
                </button>
              ) : null}
              {liveOn && liveState !== "unavailable" && !listen ? (
                <button type="button" className="pl-btn" onClick={() => setMic((x) => !x)} data-pl-mic>
                  {mic ? T.stop : T.talk}
                </button>
              ) : null}
            </div>
          </aside>
        ) : null}
        {caption ? (
          <p className="present-caption" aria-live="polite" data-present-caption>
            {caption}
          </p>
        ) : null}
        {live.handoff ? <p className="present-note">{tr("Nina is waiting: the site needs a person. The rest happens on the phone.")}</p> : null}
        {live.ended ? <p className="present-note">{tr("Finished.")}</p> : null}
      </div>
    </main>
  );
}

/** /present sans identifiant (mode démo) : l'attente, puis la session navigateur en cours, puis l'attente. */
function Follow(): React.ReactElement {
  const id = useFollow();
  if (id) return <Stage key={id} sessionId={id} />;
  return (
    <main className="present" data-present="waiting" data-present-wait>
      <div className="present-stage present-waiting">
        <img className="present-lion" src="/brand/nokker-emblem-small-light.svg" alt="" width="72" height="72" />
        <div className="present-wait-orb">
          <Orb state="idle" size="lg" label={false} />
        </div>
        <p className="present-wait-text" role="status" aria-live="polite">{tr("Nina will show you here what she's doing.")}</p>
      </div>
    </main>
  );
}

export function PresentPage({ sessionId }: { sessionId: string | null }): React.ReactElement {
  const store = useNokker();
  // Écran de démo lancé par la machine : sans jeton valide (12 h fixes écoulées, ou lien déjà servi), personne n'est là pour
  // coller une clé. Il le dit et ne propose rien d'autre.
  if (store.access !== "ready" && store.access !== "booting") {
    return onPresentScreen() ? <main className="present-expired" role="alert" data-present-expired><p>{tr("Demo session expired: restart the kiosk.")}</p></main> : <Welcome {...store} lang={uiLang()} />;
  }
  const off = <p className="fine" style={{ padding: 24 }}>{tr("The big screen view is not turned on for this account.")}</p>;
  return (
    <StoreContext.Provider value={store}>
      {!store.ready ? <div className="boot fine">{store.status}</div> : !presenterEnabled() ? off : sessionId ? <Stage key={sessionId} sessionId={sessionId} /> : presentLiveEnabled() ? <Follow /> : off}
    </StoreContext.Provider>
  );
}
