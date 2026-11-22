/**
 * Mode clip pré-rendu de `<TalkingAvatar>` : une vidéo haute qualité faite à l'avance (mp4 ou webm, avec poster) est
 * jouée une fois, avec son son, puis l'avatar revient à son repos. Le repos est une boucle vidéo muette (`idleClip`)
 * si elle existe, sinon le rendu temps réel (rig 2D ou 3D) que le parent fournit en `fallback`.
 * Lecture avec son bloquée par le navigateur : le poster reste, `onError("audio_blocked")`, au parent de proposer un
 * geste. Clip illisible : `onError("load_failed")` et retour au repos.
 */
import React, { useEffect, useRef, useState } from "react";
import type { AvatarErrorCode } from "./engine.js";

export interface AvatarClipSource {
  src: string;
  /** mime facultatif (video/mp4, video/webm) ; deviné par le navigateur sinon. */
  type?: string;
  poster?: string;
}

export interface AvatarClipProps {
  /** Clip parlé : chaque nouvelle valeur est jouée une fois. */
  clip?: AvatarClipSource | null;
  /** Boucle de repos muette (facultative). */
  idleClip?: AvatarClipSource | null;
  fallback: React.ReactNode;
  onSpeechEnd?: () => void;
  onError?: (code: AvatarErrorCode) => void;
  className?: string;
}

export function AvatarClip(props: AvatarClipProps): React.ReactElement {
  const { clip, idleClip, fallback, className } = props;
  const [playing, setPlaying] = useState<AvatarClipSource | null>(null);
  const [idleBroken, setIdleBroken] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const cbs = useRef(props);
  cbs.current = props;

  useEffect(() => setPlaying(clip ?? null), [clip]);

  useEffect(() => {
    const v = video.current;
    if (!playing || !v) return;
    v.currentTime = 0;
    v.muted = false;
    v.play().catch(() => cbs.current.onError?.("audio_blocked"));
  }, [playing]);

  const done = (): void => {
    setPlaying(null);
    cbs.current.onSpeechEnd?.();
  };
  const cls = "nk-avatar nk-clip" + (className ? " " + className : "");
  if (playing) {
    return (
      <div className={cls} aria-hidden="true">
        <video
          ref={video}
          poster={playing.poster}
          playsInline
          preload="auto"
          onEnded={done}
          onError={() => {
            setPlaying(null);
            cbs.current.onError?.("load_failed");
          }}
        >
          <source src={playing.src} type={playing.type} />
        </video>
      </div>
    );
  }
  if (idleClip && !idleBroken) {
    return (
      <div className={cls} aria-hidden="true">
        <video poster={idleClip.poster} autoPlay loop muted playsInline preload="auto" onError={() => setIdleBroken(true)}>
          <source src={idleClip.src} type={idleClip.type} />
        </video>
      </div>
    );
  }
  return <>{fallback}</>;
}
