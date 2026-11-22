/**
 * `<TalkingAvatar>` : un avatar qui parle. Réutilisable : l'onboarding s'en sert pour l'aperçu, le mur l'intègre.
 * - URL qui finit par « / » : **Nina en calques 2D** (`NinaRig`, sans WebGL, ~140 Ko) — l'avatar du catalogue ;
 * - sinon : un modèle 3D (TalkingHead, MIT, sur three.js), moteur et modèle chargés à la demande.
 * Si le chargement échoue (ou sans WebGL pour la 3D) : `onError` et plus rien n'est rendu, le parent garde son rendu.
 */
import React, { useEffect, useRef, useState } from "react";
import type { TimedSpeech } from "@nokker-apps/sdk";
import { AvatarController, type AvatarErrorCode, type AvatarFraming, type AvatarMood } from "./engine.js";
import { AvatarClip, type AvatarClipSource } from "./AvatarClip.js";
import { NinaRig } from "./NinaRig.js";
import { isRigUrl } from "./rigMouth.js";
import "./avatar.css";

export type { TimedSpeech } from "@nokker-apps/sdk";
export type { AvatarErrorCode } from "./engine.js";
export type { AvatarClipSource } from "./AvatarClip.js";

export interface TalkingAvatarProps {
  /** URL du catalogue : dossier de calques 2D (« …/ ») ou modèle 3D (.gltf/.glb). */
  avatarUrl: string;
  /** Langue de synchro labiale de TalkingHead (fr, en…) ; une langue sans module retombe sur l'anglais. */
  lang: "fr" | "en" | string;
  /** Quand il change, l'avatar le dit une fois. */
  speech?: TimedSpeech | null;
  mood?: AvatarMood;
  framing?: AvatarFraming;
  onSpeechEnd?: () => void;
  onError?: (code: AvatarErrorCode) => void;
  className?: string;
  /** Clip pré-rendu (mp4/webm + poster), joué une fois à la place de `speech` ; repli : le rendu temps réel. */
  clip?: AvatarClipSource | null;
  /** Boucle de repos muette pré-rendue, montrée hors parole à la place du rendu temps réel. */
  idleClip?: AvatarClipSource | null;
  /** Rig 2D sans parole horodatée : anime la bouche tant que c'est vrai. */
  talking?: boolean;
}

export function TalkingAvatar(props: TalkingAvatarProps): React.ReactElement | null {
  const live = isRigUrl(props.avatarUrl) ? <NinaRig {...props} /> : <TalkingAvatar3D {...props} />;
  if (!props.clip && !props.idleClip) return live;
  return (
    <AvatarClip clip={props.clip} idleClip={props.idleClip} fallback={live} onSpeechEnd={props.onSpeechEnd}
      onError={props.onError} className={props.className} />
  );
}

function TalkingAvatar3D(props: TalkingAvatarProps): React.ReactElement | null {
  const { avatarUrl, lang, speech, mood = "neutral", framing = "head", className } = props;
  const node = useRef<HTMLDivElement>(null);
  const ctl = useRef<AvatarController | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  // Rappels lus au moment de l'appel : en changer ne remonte pas l'avatar.
  const cbs = useRef(props);
  cbs.current = props;
  const live = useRef({ mood, framing, speech });
  live.current = { mood, framing, speech };

  useEffect(() => {
    const el = node.current;
    if (!el) return;
    setState("loading");
    const c = new AvatarController(el, avatarUrl, { lang, mood: live.current.mood, framing: live.current.framing }, {
      onReady: () => setState("ready"),
      onSpeechEnd: () => cbs.current.onSpeechEnd?.(),
      onError: (code) => {
        if (code !== "audio_blocked") setState("failed");
        cbs.current.onError?.(code);
      },
    });
    ctl.current = c;
    // Une parole donnée avant le montage est dite dès que l'avatar est prêt.
    if (live.current.speech) void c.say(live.current.speech);
    void c.start();
    return () => {
      c.dispose();
      if (ctl.current === c) ctl.current = null;
    };
  }, [avatarUrl, lang]);

  const first = useRef(true);
  useEffect(() => {
    // Au premier rendu, la parole est déjà passée au pilote par l'effet de montage.
    if (first.current) return void (first.current = false);
    if (speech) void ctl.current?.say(speech);
  }, [speech]);

  useEffect(() => ctl.current?.setMood(mood), [mood]);
  useEffect(() => ctl.current?.setFraming(framing), [framing]);

  if (state === "failed") return null;
  return <div ref={node} className={"nk-avatar" + (className ? " " + className : "")} data-state={state} aria-hidden="true" />;
}
