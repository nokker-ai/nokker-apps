/**
 * `<NinaLive>` : Nina en direct (vidéo temps réel Runway, voix de Nina, texte produit par Nokker). Le noyau ouvre la
 * session pour le titulaire (`POST /v1/nina-live/session`) et ne rend que le jeton éphémère de la salle LiveKit ; ce
 * composant rejoint la salle, montre la vidéo et joue la voix.
 *
 * - **Repli** : tant que la vidéo n'est pas là, et pour de bon si la session échoue ou tarde plus de 8 s, c'est le rig
 *   2D de Nina (`<TalkingAvatar>` sur `/avatars/nina-v1/`, piloté par `state` et `talking`) — mêmes props.
 * - **Semi-duplex** (décision produit) : le micro est coupé pendant que Nina parle, puis rouvert à la fin de sa phrase,
 *   après `echoTailMs` (décalage d'une télé : 2 à 4 s) ou, si fourni, quand `waitPlayback()` se résout (signal « lecture
 *   terminée » du cast). `onFloor("nina" | "you")` donne la parole à afficher ; `pushToTalk` : micro ouvert seulement
 *   tant que `talkHeld` est vrai.
 * - **Son et micro séparés** : `muted` coupe la voix de Nina ; seul `listen` ouvre le micro (après permission). Par
 *   défaut le micro ne s'ouvre JAMAIS.
 * - **Sous-titres** : `onCaption(text)` reçoit ce que Nina dit (texte de Nokker, sans balises d'expression).
 * - **Préchauffage** : `prewarmNinaLive(client, threadId)` ouvre la session et la salle à l'avance (≈ 7 s de démarrage).
 */
import React, { useEffect, useRef, useState } from "react";
import type { NinaLiveSession, NokkerClient } from "@nokker-apps/sdk";
import { TalkingAvatar } from "./TalkingAvatar.js";
import "./nina-live.css";

export type NinaLiveState = "idle" | "listening" | "thinking" | "speaking";
export type NinaLiveError = "live_unavailable" | "audio_blocked" | "mic_denied" | "session_ended";

export interface NinaLiveProps {
  client: NokkerClient;
  state?: NinaLiveState;
  talking?: boolean;
  emotion?: "neutral" | "happy" | "concerned";
  framing?: "upper" | "head";
  /** Coupe la voix de Nina (bulle sans geste). */
  muted?: boolean;
  /** Ouvre le micro de CET appareil (après permission). Faux par défaut : jamais de micro sans le demander. */
  listen?: boolean;
  /** Délai après la fin de la phrase de Nina avant de rouvrir le micro (ms ; écho d'une télé). Défaut 600. */
  echoTailMs?: number;
  /** Si fourni : attendu après la phrase de Nina (« lecture terminée sur la télé »), plafonné à 8 s, à la place du délai. */
  waitPlayback?: () => Promise<void>;
  /** Micro ouvert seulement tant que `talkHeld` (appui pour parler). */
  pushToTalk?: boolean;
  talkHeld?: boolean;
  /** Qui a la parole : « nina » (micro coupé) ou « you » (à toi). */
  onFloor?: (who: "nina" | "you") => void;
  /** Fil où Nina parle (sinon le fil `nina-live` du titulaire). */
  threadId?: string;
  className?: string;
  onReady?: () => void;
  onError?: (code: NinaLiveError) => void;
  onCaption?: (text: string) => void;
}

const FALLBACK_AFTER_MS = 8000;
const RIG_URL = "/avatars/nina-v1/";

type Live = { session: NinaLiveSession; room: import("livekit-client").Room; client: NokkerClient; key: string };
let warm: Promise<Live> | null = null;

async function connect(client: NokkerClient, threadId?: string): Promise<Live> {
  const session = await client.openNinaLive(threadId ? { threadId } : {});
  const { Room } = await import("livekit-client");
  const room = new Room({ adaptiveStream: true, dynacast: false });
  try {
    await room.connect(session.livekit.url, session.livekit.token, { autoSubscribe: true });
  } catch (e) {
    void client.endNinaLive(session.session_id).catch(() => undefined);
    throw e;
  }
  return { session, room, client, key: threadId ?? "" };
}

/** Ouvre la session et la salle avant d'en avoir besoin ; le prochain `<NinaLive>` du même fil la reprend. */
export function prewarmNinaLive(client: NokkerClient, threadId?: string): void {
  if (warm) return;
  warm = connect(client, threadId);
  warm.catch(() => (warm = null));
}

async function end(live: Live): Promise<void> {
  try {
    await live.room.disconnect();
  } finally {
    await endSession(live);
  }
}

/** Fin de session côté noyau, en `keepalive` : un démontage dû à la fermeture de l'onglet ne doit pas la couper. */
export function endSession(live: Pick<Live, "client" | "session">): Promise<unknown> {
  return live.client.endNinaLive(live.session.session_id, { keepalive: true }).catch(() => undefined);
}

/** Piste « silence » synthétique (bruit très faible), publiée à la place du micro : l'agent vocal ne démarre la
 * conversation qu'avec une entrée audio continue. Aucune permission, aucun son capté. */
function silenceTrack(): { track: MediaStreamTrack; stop: () => void } | null {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ac = new Ctor();
    const buf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.0012;
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const dest = ac.createMediaStreamDestination();
    src.connect(dest);
    src.start();
    void ac.resume().catch(() => undefined);
    const track = dest.stream.getAudioTracks()[0];
    if (!track) return null;
    return { track, stop: () => { src.stop(); track.stop(); void ac.close().catch(() => undefined); } };
  } catch {
    return null;
  }
}

/** Balises d'expression d'ElevenLabs v3 (« [cheerfully] ») retirées des sous-titres. */
export function captionText(raw: string): string {
  return raw.replace(/\[[a-z ]{2,24}\]\s*/gi, "").replace(/\s+/g, " ").trim();
}

export function NinaLive(props: NinaLiveProps): React.ReactElement {
  const { client, state = "idle", talking = false, framing = "upper", muted = false, listen = false, threadId, className } = props;
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const live = useRef<Live | null>(null);
  const [mode, setMode] = useState<"connecting" | "live" | "fallback">("connecting");
  const [speaking, setSpeaking] = useState(false);
  // Parole de Nina + traîne (écho, cast) : tant que c'est vrai, le micro reste coupé.
  const [floorNina, setFloorNina] = useState(false);
  const cbs = useRef(props);
  cbs.current = props;

  useEffect(() => {
    let gone = false;
    let gotVideo = false;
    const fail = (code: NinaLiveError): void => {
      if (gone) return;
      setMode("fallback");
      cbs.current.onError?.(code);
    };
    const timer = setTimeout(() => !gotVideo && fail("live_unavailable"), FALLBACK_AFTER_MS);
    void (async () => {
      let l: Live;
      try {
        const pre = warm;
        warm = null;
        l = pre ? await pre : await connect(client, threadId);
        if (pre && l.key !== (threadId ?? "")) {
          void end(l);
          l = await connect(client, threadId);
        }
      } catch {
        return fail("live_unavailable");
      }
      if (gone) return void end(l);
      live.current = l;
      const { RoomEvent, Track } = await import("livekit-client");
      const attach = (track: import("livekit-client").RemoteTrack): void => {
        if (track.kind === Track.Kind.Video && video.current) {
          const v = video.current;
          track.attach(v);
          gotVideo = true;
          clearTimeout(timer);
          // Le flux démarre flou (≈ 556 px) puis monte en ≈ 1 s : on garde le rig jusque-là.
          const shown = Date.now();
          const reveal = (): void => {
            if (gone) return;
            if (v.videoWidth >= 1000 || Date.now() - shown > 1500) {
              setMode("live");
              cbs.current.onReady?.();
            } else window.setTimeout(reveal, 100);
          };
          reveal();
        } else if (track.kind === Track.Kind.Audio && audio.current) {
          track.attach(audio.current);
          audio.current.muted = cbs.current.muted ?? false;
          audio.current.play().catch(() => cbs.current.onError?.("audio_blocked"));
        }
      };
      for (const p of l.room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) if (pub.track) attach(pub.track as import("livekit-client").RemoteTrack);
      }
      l.room.on(RoomEvent.TrackSubscribed, (track) => attach(track));
      l.room.on(RoomEvent.DataReceived, (payload, _p, _k, topic) => {
        try {
          const msg = JSON.parse(new TextDecoder().decode(payload)) as { type?: string; role?: string; text?: string; state?: string };
          if (import.meta.env.DEV || (window as { __nkLiveDebug?: boolean }).__nkLiveDebug) console.info("NKNL data", topic ?? "", msg.type, msg.role ?? "");
          if (msg.type === "transcription" && msg.role === "assistant" && msg.text) cbs.current.onCaption?.(captionText(msg.text));
          if (msg.type === "assistant_audio_state") setSpeaking(msg.state === "started");
        } catch {
          /* message d'un autre type */
        }
      });
      l.room.on(RoomEvent.Disconnected, () => !gone && fail("session_ended"));
    })();
    // Fermeture ou navigation hors de la page : React ne démonte rien, il faut le dire au noyau ici (pagehide couvre
    // aussi iOS Safari, où `beforeunload` ne part pas).
    const onHide = (): void => {
      if (live.current) void endSession(live.current);
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      gone = true;
      clearTimeout(timer);
      window.removeEventListener("pagehide", onHide);
      if (live.current) void end(live.current);
      live.current = null;
    };
  }, [client, threadId]);

  // Son de Nina : coupé ou non, sans rouvrir la session.
  useEffect(() => {
    if (audio.current) audio.current.muted = muted;
  }, [muted]);

  // Semi-duplex : la parole passe à Nina dès qu'elle parle ; elle revient à la personne après la traîne.
  useEffect(() => {
    if (speaking) {
      setFloorNina(true);
      return;
    }
    let gone = false;
    const wait = cbs.current.waitPlayback;
    const tail = new Promise<void>((ok) => window.setTimeout(ok, wait ? 8000 : Math.max(0, cbs.current.echoTailMs ?? 600)));
    void (wait ? Promise.race([wait().catch(() => undefined), tail]) : tail).then(() => !gone && setFloorNina(false));
    return () => {
      gone = true;
    };
  }, [speaking]);
  useEffect(() => cbs.current.onFloor?.(floorNina ? "nina" : "you"), [floorNina]);

  // Micro réel : coupé (mute) pendant la parole de Nina, et hors appui en mode « appuyer pour parler ».
  const micOpen = listen && !floorNina && (!props.pushToTalk || !!props.talkHeld);
  useEffect(() => {
    const room = live.current?.room;
    if (!room || mode !== "live" || !listen) return;
    void (async () => {
      const { Track } = await import("livekit-client");
      const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (!pub?.track) return;
      if (micOpen) await pub.unmute().catch(() => undefined);
      else await pub.mute().catch(() => undefined);
    })();
  }, [micOpen, listen, mode]);

  // Entrée audio : le vrai micro seulement si `listen` (après permission ; refus = `mic_denied`), sinon une piste de
  // silence synthétique pour que la conversation démarre. Jamais de micro par défaut.
  useEffect(() => {
    const room = live.current?.room;
    if (!room || mode !== "live") return;
    let silence: ReturnType<typeof silenceTrack> = null;
    let gone = false;
    void (async () => {
      const { Track } = await import("livekit-client");
      if (listen) {
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
        } catch {
          cbs.current.onError?.("mic_denied");
        }
        return;
      }
      await room.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
      silence = silenceTrack();
      if (silence && !gone) await room.localParticipant.publishTrack(silence.track, { source: Track.Source.Microphone, name: "silence" }).catch(() => undefined);
    })();
    return () => {
      gone = true;
      if (silence) {
        void room.localParticipant.unpublishTrack(silence.track).catch(() => undefined);
        silence.stop();
      }
    };
  }, [listen, mode]);

  const rigState = mode === "live" ? (speaking ? "speaking" : state) : state;
  return (
    <div className={"nk-nina-live" + (className ? " " + className : "")} data-mode={mode}>
      {mode !== "live" && (
        <TalkingAvatar avatarUrl={RIG_URL} lang="fr" framing={framing} className="nk-nina-live-rig"
          speech={null} talking={talking || rigState === "speaking"} />
      )}
      <video ref={video} className="nk-nina-live-video" playsInline muted autoPlay aria-hidden="true" />
      <audio ref={audio} autoPlay />
    </div>
  );
}
