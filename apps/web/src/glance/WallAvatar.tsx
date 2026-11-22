/**
 * V6 — l'avatar du titulaire sur le mur, qui lit l'annonce du matin (brief déjà affiché). Rien n'est chargé sans avatar
 * choisi, sans brief montré, ou la nuit. Il essaie de parler UNE fois à l'arrivée d'un nouveau brief le matin ; si le
 * navigateur refuse le son sans geste (audio_blocked), « Toucher pour écouter ». Sans WebGL ou en cas d'échec de
 * chargement : rien n'est affiché (le mur garde son rendu). 429 : on attend retry_after ; tts_off / no_brief : rien.
 */
import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { NokkerApiError, type NokkerClient, type TimedSpeech } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import { avatarUrlOf, morning } from "./views.js";

const TalkingAvatar = lazy(() => import("../avatar/TalkingAvatar.js").then((m) => ({ default: m.TalkingAvatar })));

export function WallAvatar({ client, avatar, lang, briefId, now, inline }: { client: NokkerClient; avatar: { id: string; version: number }; lang: string; briefId: string | null; now: Date; inline?: boolean }): React.ReactElement | null {
  const [speech, setSpeech] = useState<TimedSpeech | null>(null);
  const [failed, setFailed] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const notBefore = useRef(0);
  const played = useRef<string | null>(null);
  const play = useCallback(async (): Promise<void> => {
    if (busy || Date.now() < notBefore.current) return;
    setBusy(true);
    setBlocked(false);
    try {
      // Une nouvelle référence d'objet = l'avatar la redit.
      const s = await client.getGlanceBriefSpeech();
      setSpeech({ ...s });
    } catch (e) {
      if (e instanceof NokkerApiError && e.status === 429) notBefore.current = Date.now() + (e.retryAfterS ?? 600) * 1000;
    } finally {
      setBusy(false);
    }
  }, [client, busy]);
  // Le matin, une fois par brief : l'annonce se lance d'elle-même (soumise au geste : audio_blocked sinon).
  useEffect(() => {
    if (!briefId || played.current === briefId || !morning(now)) return;
    played.current = briefId;
    void play();
  }, [briefId, now, play]);
  if (failed) return null;
  return (
    <div className={`wall-avatar ${inline ? "inline" : ""}`} data-wall-avatar>
      <Suspense fallback={null}>
        <TalkingAvatar
          avatarUrl={avatarUrlOf(avatar)}
          lang={lang}
          framing="upper"
          speech={speech}
          onError={(code) => (code === "audio_blocked" ? setBlocked(true) : setFailed(true))}
          className="wall-avatar-3d"
        />
      </Suspense>
      {briefId ? (
        <button type="button" className="wall-avatar-play" onClick={() => void play()} disabled={busy} data-wall-avatar-play>
          {blocked ? tr("Tap to listen") : tr("Listen to the brief")}
        </button>
      ) : null}
    </div>
  );
}
