/**
 * « Caméra de veille » du nœud maison (LOKKAL-PHONE §4.4, lot P10c ; conditions de dev du 06.11). La détection se
 * fait sur cet appareil ; le noyau ne reçoit que du texte ; les images restent ici 24 h. « Personne » est une classe,
 * jamais une identité : aucune reconnaissance de visage. Un bandeau « Caméra de veille active » reste visible tant
 * qu'elle tourne. Coupée par défaut.
 */
import React, { useState } from "react";
import { tr } from "../i18n/index.js";
import type { NodePlugin, NodeStatus } from "../platform/node.js";

export function CameraSettings({ plugin, st, setSt }: { plugin: NodePlugin; st: NodeStatus; setSt: (s: NodeStatus) => void }): React.ReactElement | null {
  const cam = st.home?.camera;
  const [name, setName] = useState(cam?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!plugin.setCamera || !cam) return null;
  const set = async (o: Parameters<NonNullable<NodePlugin["setCamera"]>>[0]): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      setSt(await plugin.setCamera!(o));
    } catch {
      setNote(tr("The setting could not be saved. Try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="phone-camera" data-phone-camera={cam.on ? "on" : "off"} data-camera-cap={cam.cap}>
      <h4>{tr("Watch camera")}</h4>
      <label className="ob-check">
        <input type="checkbox" checked={cam.on} disabled={busy} onChange={(e) => void set({ on: e.target.checked })} data-camera-toggle />
        <span>{tr("Detect movement with the camera of this device")}</span>
      </label>
      <p className="ob-muted">{tr("Detection runs on this device, without sound. Nina only receives a line of text (the time, movement or person, and the camera name); images stay on this device for 24 hours and you can only see them from the home Wi-Fi.")}</p>
      <p className="ob-muted">{tr("No face recognition: \"a person\" means that a human figure was seen, never who it is.")}</p>
      <p className="ob-note" data-camera-inform>{tr("Tell the people who live here and your visitors that a camera is filming, and do not point it at the street or at the neighbours.")}</p>
      {cam.on ? (
        <>
          {cam.permission === "denied" ? (
            <p className="ob-note" role="alert" data-camera-denied>
              {tr("The camera is not allowed for Nokker. Allow it in the settings of this device.")}
            </p>
          ) : (
            <p className="ob-muted" data-camera-state={cam.cap}>
              {cam.cap === "on" ? tr("Watching. A banner stays on the screen while the camera watches.") : tr("Paused: the camera only watches when this device is plugged in, in home mode and with the app open.")}
            </p>
          )}
          <form
            className="ob-field"
            style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              const n = name.trim();
              if (!n || n.length > 40) return setNote(tr("Give the camera a short name, such as Entrance (40 characters at most)."));
              void set({ name: n });
            }}
          >
            <input type="text" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 0 }} placeholder={tr("Entrance")} aria-label={tr("Camera name")} data-camera-name />
            <button type="submit" className="ob-btn" disabled={busy} data-camera-name-save>
              {tr("Save")}
            </button>
          </form>
          <label className="ob-field">
            <span>{tr("Sensitivity")}</span>
            <select value={cam.sensitivity} disabled={busy} onChange={(e) => void set({ sensitivity: e.target.value as "low" | "medium" | "high" })} data-camera-sensitivity>
              <option value="low">{tr("Low")}</option>
              <option value="medium">{tr("Medium")}</option>
              <option value="high">{tr("High")}</option>
            </select>
          </label>
          <label className="ob-field">
            <span>{tr("Camera")}</span>
            <select value={cam.position} disabled={busy} onChange={(e) => void set({ position: e.target.value as "back" | "front" })} data-camera-position>
              <option value="back">{tr("Back camera")}</option>
              <option value="front">{tr("Front camera")}</option>
            </select>
          </label>
          <p className="ob-muted" data-camera-stored>{cam.events === 0 ? tr("No detection kept on this device (24 hours).") : cam.events === 1 ? tr("1 detection kept on this device (24 hours).") : tr("{0} detections kept on this device (24 hours).", cam.events)}</p>
        </>
      ) : null}
      {note ? (
        <p className="ob-note" role="alert">
          {note}
        </p>
      ) : null}
    </div>
  );
}
