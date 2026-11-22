/**
 * Nina, avatar 2D en calques (illustration Ninabot) : respiration, balancement de la tête, clignements, et une bouche
 * qui suit la parole (mots horodatés + amplitude réelle de l'audio, `rigMouth.ts`). Sans WebGL, sans bibliothèque :
 * six images WebP (~140 Ko) servies sous `avatarUrl` (dossier qui finit par « / »). Mêmes props que `<TalkingAvatar>`.
 */
import React, { useEffect, useRef, useState } from "react";
import type { TimedSpeech } from "@nokker-apps/sdk";
import { base64ToArrayBuffer, type AvatarErrorCode, type AvatarFraming } from "./engine.js";
import { mouthAt, rms, type RigMouth } from "./rigMouth.js";
import "./nina-rig.css";

export interface NinaRigProps {
  avatarUrl: string;
  speech?: TimedSpeech | null;
  framing?: AvatarFraming;
  /** Sans parole horodatée : la bouche s'anime tant que c'est vrai (repli de Nina en direct). */
  talking?: boolean;
  onSpeechEnd?: () => void;
  onError?: (code: AvatarErrorCode) => void;
  className?: string;
}

const RESUME_WAIT_MS = 400;

export function NinaRig(props: NinaRigProps): React.ReactElement | null {
  const { avatarUrl, speech, framing = "head", talking = false, className } = props;
  // Au repos (idle, écoute) : le sourire du calque tête (« open », aucune bouche superposée). Les bouches fermée et
  // mi-ouverte ne servent que PENDANT la parole ; 300 ms après la fin, retour progressif au sourire.
  const [mouth, setMouth] = useState<RigMouth>("open");
  const [settling, setSettling] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [blink, setBlink] = useState(false);
  const [failed, setFailed] = useState(false);
  const cbs = useRef(props);
  cbs.current = props;
  const ctx = useRef<AudioContext | null>(null);
  const stop = useRef<() => void>(() => undefined);

  // Clignements : ~130 ms toutes les 2,8 à 6 s ; aucun si l'utilisateur réduit les animations.
  useEffect(() => {
    if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let alive = true;
    let t = 0;
    const next = (): void => {
      t = window.setTimeout(() => {
        if (!alive) return;
        setBlink(true);
        window.setTimeout(() => alive && setBlink(false), 130);
        next();
      }, 2800 + Math.random() * 3200);
    };
    next();
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, []);

  const smileTimer = useRef(0);
  const backToSmile = (): void => {
    window.clearTimeout(smileTimer.current);
    smileTimer.current = window.setTimeout(() => {
      setSettling(true);
      setMouth("open");
      window.setTimeout(() => setSettling(false), 350);
    }, 300);
  };

  // Parole : audio décodé localement (base64, aucune requête), analysé pour l'amplitude, bouche suivie à chaque image.
  useEffect(() => {
    if (!speech) return;
    let cancelled = false;
    stop.current();
    void (async () => {
      try {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) throw new Error("no audio");
        const ac = (ctx.current ??= new Ctor());
        if (ac.state !== "running") {
          const ok = await Promise.race([ac.resume().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), RESUME_WAIT_MS))]);
          if (!ok || (ac.state as string) !== "running") return void cbs.current.onError?.("audio_blocked");
        }
        const buf = await ac.decodeAudioData(base64ToArrayBuffer(speech.audio));
        if (cancelled) return;
        const src = ac.createBufferSource();
        src.buffer = buf;
        const an = ac.createAnalyser();
        an.fftSize = 1024;
        src.connect(an);
        an.connect(ac.destination);
        const data = new Uint8Array(an.fftSize);
        const t0 = ac.currentTime;
        let raf = 0;
        const tick = (): void => {
          an.getByteTimeDomainData(data);
          setMouth(mouthAt(speech, (ac.currentTime - t0) * 1000, rms(data)));
          raf = requestAnimationFrame(tick);
        };
        const end = (): void => {
          cancelAnimationFrame(raf);
          setSpeaking(false);
          backToSmile();
        };
        src.onended = () => {
          end();
          if (!cancelled) cbs.current.onSpeechEnd?.();
        };
        stop.current = () => {
          src.onended = null;
          try {
            src.stop();
          } catch {
            /* pas démarré */
          }
          end();
        };
        setSpeaking(true);
        src.start();
        raf = requestAnimationFrame(tick);
      } catch {
        setSpeaking(false);
        cbs.current.onError?.("audio_blocked");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [speech]);

  // Repli sans audio : bouche animée au rythme de la parole tant que `talking` (aucun son, aucune requête).
  useEffect(() => {
    if (!talking || speech) return;
    const seq: RigMouth[] = ["open", "half", "open", "closed", "half", "open", "half", "closed"];
    let i = 0;
    setSpeaking(true);
    const t = window.setInterval(() => setMouth(seq[i++ % seq.length]!), 120);
    return () => {
      window.clearInterval(t);
      setSpeaking(false);
      backToSmile();
    };
  }, [talking, speech]);

  useEffect(
    () => () => {
      window.clearTimeout(smileTimer.current);
      stop.current();
      void ctx.current?.close().catch(() => undefined);
      ctx.current = null;
    },
    [],
  );

  if (failed) return null;
  const src = (n: string): string => `${avatarUrl}${n}.webp`;
  const onImgError = (): void => {
    setFailed(true);
    cbs.current.onError?.("load_failed");
  };
  return (
    <div className={`nk-avatar nk-nina fr-${framing}` + (settling ? " nk-nina-settle" : "") + (className ? " " + className : "")} aria-hidden="true">
      <div className="nk-nina-breathe">
        <img src={src("body")} alt="" draggable={false} onError={onImgError} />
        <div className={`nk-nina-head ${speaking ? "st-speaking" : "st-idle"}`}>
          <img src={src("head")} alt="" draggable={false} onError={onImgError} />
          <img src={src("mouth-half")} alt="" draggable={false} style={{ opacity: mouth === "half" ? 1 : 0 }} />
          <img src={src("mouth-closed")} alt="" draggable={false} style={{ opacity: mouth === "closed" ? 1 : 0 }} />
          <img src={src("eyelid-left")} alt="" draggable={false} style={{ opacity: blink ? 1 : 0 }} />
          <img src={src("eyelid-right")} alt="" draggable={false} style={{ opacity: blink ? 1 : 0 }} />
        </div>
      </div>
    </div>
  );
}
