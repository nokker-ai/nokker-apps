/**
 * Page `/nina-live` (drapeau web VITE_NOKKER_NINA_LIVE=1, noyau `nina_live`) : Nina en direct en plein cadre, pour la
 * répétition et la démo du titulaire. Sous-titres de ce que dit Nina ; son et micro séparés (le micro ne s'ouvre que
 * sur « Parler à Nina », jamais par défaut). Repli automatique sur le rig 2D. Indicateur de parole « Nina parle… / À toi »
 * (semi-duplex : micro coupé pendant que Nina parle) ; `?ptt=1` : appuyer pour parler (bouton maintenu ou barre d'espace).
 */
import React, { useEffect, useState } from "react";
import { NinaLive, type NinaLiveError } from "../avatar/NinaLive.js";
import { uiLang } from "../components/ConnectorsTab.js";
import { useNokker } from "../store.js";
import { Welcome } from "../welcome/Welcome.js";
import { NINA_LIVE_TEXT as TEXT } from "./text.js";
import "./nina-live-page.css";


export function NinaLivePage(): React.ReactElement {
  const store = useNokker();
  const L = uiLang();
  const T = TEXT[L === "en" ? "en" : "fr"];
  const [listen, setListen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [caption, setCaption] = useState("");
  const [err, setErr] = useState<NinaLiveError | null>(null);
  const [floor, setFloor] = useState<"nina" | "you">("you");
  const [held, setHeld] = useState(false);
  const ptt = new URLSearchParams(location.search).get("ptt") === "1";
  useEffect(() => {
    if (!ptt || !listen) return;
    const down = (e: KeyboardEvent): void => { if (e.code === "Space" && !e.repeat) { e.preventDefault(); setHeld(true); } };
    const up = (e: KeyboardEvent): void => { if (e.code === "Space") setHeld(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); setHeld(false); };
  }, [ptt, listen]);
  if (store.access !== "ready" && store.access !== "booting") return <Welcome {...store} lang={L} />;
  if (store.access === "booting") return <main className="nl-page" aria-busy="true" />; // session pas encore prête
  return (
    <main className="nl-page">
      <div className="nl-frame">
        <NinaLive client={store.client} framing="upper" muted={muted} listen={listen}
          pushToTalk={ptt} talkHeld={held} onFloor={setFloor}
          onCaption={setCaption} onReady={() => setErr(null)} onError={(c) => (c === "audio_blocked" ? setBlocked(true) : setErr(c))} />
      </div>
      {listen ? (
        <p className={"nl-floor nl-floor-" + floor} role="status" aria-live="polite">
          {floor === "nina" ? T.ninaSpeaks : ptt ? (held ? T.listening : T.holdHint) : T.yourTurn}
        </p>
      ) : null}
      {caption ? <p className="nl-caption" aria-live="polite">{caption}</p> : null}
      {err === "live_unavailable" || err === "session_ended" ? <p className="nl-note">{T.fallback}</p> : null}
      <div className="nl-actions">
        {blocked ? (
          <button type="button" className="ob-btn primary" onClick={() => { setBlocked(false); setMuted(false); document.querySelectorAll("audio").forEach((a) => void a.play().catch(() => undefined)); }}>
            {T.sound}
          </button>
        ) : null}
        {ptt && listen ? (
          <button type="button" className={"ob-btn primary nl-hold" + (held ? " held" : "")} aria-pressed={held}
            disabled={floor === "nina"}
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setHeld(true); }}
            onPointerUp={() => setHeld(false)} onPointerCancel={() => setHeld(false)}>
            {T.hold}
          </button>
        ) : null}
        <button type="button" className={"ob-btn" + (listen ? "" : " primary")} onClick={() => setListen((x) => !x)}>
          {listen ? T.stop : T.talk}
        </button>
      </div>
    </main>
  );
}
