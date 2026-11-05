/**
 * The speaker button of a reply (the Guide says « Bouton haut-parleur d'une réponse », core guide catalog `voice`):
 * shown only when the core says reading aloud is available. Click: listen; while playing: pause; paused: resume;
 * after an error: try again. One reading at a time in the whole page.
 */
import { useEffect, useRef, useState } from "react";
import type { NokkerClient } from "@nokker-apps/sdk";
import { Icon } from "../icons.js";
import { shellLang, tr } from "../i18n/index.js";
import { releaseTurn, SpeechReading, takeTurn, type SpeechState } from "./speech.js";
import "./listen.css";

export function ListenButton({ client, threadId, index }: { client: Pick<NokkerClient, "speechStream">; threadId: string; index: number }) {
  const [state, setState] = useState<SpeechState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const reading = useRef<SpeechReading | null>(null);
  useEffect(
    () => () => {
      if (reading.current) {
        reading.current.stop();
        releaseTurn(reading.current);
      }
    },
    [],
  );

  const click = (): void => {
    const r = reading.current;
    if (state === "playing" && r) return r.pause();
    if (state === "paused" && r) return r.resume();
    if (state === "loading") return;
    r?.stop();
    setError(null);
    const next = new SpeechReading((s, err) => {
      setState(s);
      setMode(next.mode);
      if (s === "error") setError(err ?? null);
      if (s === "idle" || s === "error") releaseTurn(next);
    });
    reading.current = next;
    takeTurn(next, () => setState("idle"));
    void next.start(client, threadId, index, shellLang());
  };

  const label =
    state === "loading" ? tr("Loading the voice…") : state === "playing" ? tr("Pause") : state === "paused" ? tr("Resume") : state === "error" ? tr("Try again") : tr("Listen");
  return (
    <span className="listen" data-listen={state} data-listen-mode={mode ?? undefined}>
      <button
        type="button"
        className="listen-btn"
        onClick={click}
        aria-label={state === "idle" ? tr("Listen to this reply") : label}
        aria-pressed={state === "playing" || state === "paused"}
        aria-busy={state === "loading"}
        title={tr("Listen to this reply")}
      >
        <Icon name={state === "playing" ? "pause" : "soundOn"} size={14} />
        <span>{label}</span>
      </button>
      {error ? (
        <span className="listen-error fine" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
