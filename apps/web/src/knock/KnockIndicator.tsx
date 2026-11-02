/**
 * Top-bar indicator of « Knock to call » (product rule: visible while the listener is not `off`). One button:
 * listening → mute the microphone; muted → unmute. Enabled but not listening (after a reload the browser needs a new
 * gesture): « Listen » starts again. Nothing is shown when the setting is off.
 */
import React from "react";
import { Icon } from "../icons.js";
import { tr } from "../i18n/index.js";
import { knockUnsupported, muteKnock, startKnock } from "./controller.js";
import { knockStateText, useKnock } from "./KnockCard.js";

export function KnockIndicator(): React.ReactElement | null {
  const k = useKnock();
  if (!k.enabled || knockUnsupported()) return null;
  if (k.state === "off" || k.state === "error") {
    return (
      <button type="button" className="knock-pill paused" data-knock-indicator="off" onClick={() => void startKnock()} title={tr("Knock to call is paused: listen again")} aria-label={tr("Knock to call is paused: listen again")}>
        <Icon name="micOff" size={16} />
        <span className="knock-pill-label">{tr("Listen")}</span>
      </button>
    );
  }
  const muted = k.state === "muted";
  const label = muted ? tr("Unmute the microphone") : tr("Mute the microphone");
  return (
    <button
      type="button"
      className={`knock-pill ${muted ? "muted" : "live"}`}
      data-knock-indicator={k.state}
      disabled={k.state === "starting"}
      aria-pressed={muted}
      onClick={() => muteKnock(!muted)}
      title={`${knockStateText(k.state)} · ${label}`}
      aria-label={`${knockStateText(k.state)}. ${label}`}
    >
      <Icon name={muted ? "micOff" : "mic"} size={16} />
      <span className="knock-pill-label">{muted ? tr("Muted") : tr("Listening")}</span>
    </button>
  );
}
