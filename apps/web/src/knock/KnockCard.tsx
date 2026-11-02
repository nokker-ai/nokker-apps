/**
 * « Knock to call » setting (My account). OFF by default; switching it on asks for the microphone (this click is the
 * gesture the browser needs). Optional 30 s calibration; « Mute » and « Forget the calibration ». When the browser
 * cannot listen (no AudioWorklet, no microphone API, page not secure), the switch is greyed with the reason.
 */
import React, { useEffect, useState, useSyncExternalStore } from "react";
import { tr } from "../i18n/index.js";
import "./knock.css";
import {
  calibrateKnock,
  finishKnockCalibration,
  forgetKnockCalibration,
  knockStore,
  knockUnsupported,
  muteKnock,
  setKnockEnabled,
  startKnock,
  type KnockSnapshot,
  type KnockUnsupported,
} from "./controller.js";

export function useKnock(): KnockSnapshot {
  return useSyncExternalStore(knockStore.subscribe, knockStore.get, knockStore.get);
}

export function unsupportedText(u: KnockUnsupported): string {
  switch (u) {
    case "insecure":
      return tr("The microphone needs a secure page (https).");
    case "nomedia":
      return tr("This browser does not give pages the microphone.");
    default:
      return tr("This browser cannot analyse sound in the page (AudioWorklet). On iPhone, iOS 14.5 or later is needed.");
  }
}

export function knockStateText(s: KnockSnapshot["state"]): string {
  switch (s) {
    case "starting":
      return tr("Opening the microphone…");
    case "listening":
      return tr("Listening for three knocks");
    case "muted":
      return tr("Microphone muted");
    case "calibrating":
      return tr("Calibrating: knock three times");
    case "error":
      return tr("The listening stopped");
    default:
      return tr("Not listening");
  }
}

function errorText(e: KnockSnapshot["error"]): string | null {
  switch (e) {
    case "denied":
      return tr("The microphone was refused. Allow it for this site in the browser, then switch on again.");
    case "nomic":
      return tr("No microphone was found.");
    case "failed":
      return tr("The listening could not start.");
    default:
      return null;
  }
}

const CAL_S = 30;

export function KnockCard(): React.ReactElement {
  const k = useKnock();
  const why = knockUnsupported();
  const [left, setLeft] = useState(0);
  const on = k.enabled && !why;
  const live = k.state !== "off" && k.state !== "error";

  useEffect(() => {
    if (k.state !== "calibrating") return setLeft(0);
    const until = Date.now() + CAL_S * 1000;
    const tick = (): void => setLeft(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [k.state]);

  const err = errorText(k.error);
  return (
    <section className="ob-conn knock-card" aria-labelledby="acc-knock" data-knock-card>
      <h3 id="acc-knock">{tr("Knock to call")}</h3>
      <p className="ob-note">{tr("Knock three times on the table: Nokker answers “yes?” and opens the message box. The sound stays in this page: nothing is sent or recorded.")}</p>
      <label className={`ob-check ${why ? "disabled" : ""}`}>
        <input type="checkbox" data-knock-toggle checked={on} disabled={!!why} aria-describedby={why ? "knock-why" : undefined} onChange={(e) => void setKnockEnabled(e.target.checked)} />
        <span>{tr("Knock to call")}</span>
      </label>
      {why ? (
        <p className="ob-note knock-why" id="knock-why" data-knock-unsupported={why}>
          {unsupportedText(why)}
        </p>
      ) : (
        <p className="ob-status" role="status" data-knock-state={k.state}>
          {on ? knockStateText(k.state) : tr("Off: the microphone is not used.")}
          {on && k.state === "calibrating" && left ? ` · ${tr("{0} s left", left)}` : ""}
        </p>
      )}
      {err && on ? (
        <p className="ob-error" role="alert">
          {err}
        </p>
      ) : null}
      {on ? (
        <div className="ob-actions knock-actions">
          {!live ? (
            <button type="button" className="ob-btn primary" onClick={() => void startKnock()}>
              {tr("Listen")}
            </button>
          ) : k.state === "calibrating" ? (
            <button type="button" className="ob-btn" onClick={finishKnockCalibration}>
              {tr("Finish now")}
            </button>
          ) : (
            <>
              <button type="button" className="ob-btn" data-knock-mute onClick={() => muteKnock(k.state !== "muted")}>
                {k.state === "muted" ? tr("Unmute the microphone") : tr("Mute the microphone")}
              </button>
              <button type="button" className="ob-btn" disabled={k.state !== "listening"} onClick={() => void calibrateKnock(CAL_S)}>
                {tr("Calibrate ({0} s)", CAL_S)}
              </button>
            </>
          )}
          {k.calibrated && k.state !== "calibrating" ? (
            <button type="button" className="ob-btn" onClick={forgetKnockCalibration}>
              {tr("Forget the calibration")}
            </button>
          ) : null}
        </div>
      ) : null}
      {on && k.lastCalibration ? (
        <p className="ob-note" role="status">
          {k.lastCalibration === "ok" ? tr("Calibrated on your three knocks. Only measurements are kept, never the sound.") : tr("Three knocks were not heard: the settings did not change.")}
        </p>
      ) : null}
    </section>
  );
}
