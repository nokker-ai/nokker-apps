/**
 * « Frapper pour appeler » sur le NŒUD MAISON (décision produit du 06.11). L'écoute est NATIVE
 * (ios/App/App/NokkerKnock.swift) : la page n'a toujours pas le micro en mode maison. Éteint par défaut ; allumer
 * demande Face ID, Touch ID ou le code de l'appareil (dans le natif) ; éteindre ne demande rien. Textes gelés à la
 * relecture des textes le 06.11 (1, 2, 3 et 5). Destination des trois coups : la voix du foyer (wall_voice), jamais la session
 * complète ; tant qu'elle n'est pas prête, le natif rend `available: false` et ce réglage reste caché.
 */
import React, { useState } from "react";
import { tr } from "../i18n/index.js";
import type { NodePlugin, NodeStatus } from "../platform/node.js";

export type KnockNativeState = "off" | "listening" | "cut" | "background" | "held" | "denied" | "unavailable";

/** Phrase de l'état natif ; null quand il n'y a rien à dire. */
export function knockHomeStateText(s: KnockNativeState): string | null {
  switch (s) {
    case "listening":
      return tr("Listening for three knocks. Nothing is recorded.");
    case "cut":
      return tr("Listening off. The owner can turn it back on in the home node settings.");
    case "background":
      return tr("Listening off: Nokker is no longer in the foreground. It resumes when you come back to the app.");
    case "denied":
      return tr("The microphone is not allowed for Nokker. Allow it in the Settings of this device, under Nokker.");
    case "unavailable":
      return tr("The listening could not start.");
    default:
      return null;
  }
}

/** Refus de l'allumage (codes du natif). */
export function knockHomeError(code: string | undefined): string {
  switch (code) {
    case "denied":
      return tr("The microphone is not allowed for Nokker. Allow it in the Settings of this device, under Nokker.");
    case "auth_failed":
      return tr("Not turned on: the owner of this device must confirm with Face ID, Touch ID or the passcode.");
    case "no_passcode":
      return tr("Cannot turn on: this device has no passcode. Set one in Settings, so that only the owner can turn on the listening.");
    case "not_home":
      return tr("Only available when this device serves as a home node.");
    default:
      return tr("The setting could not be saved. Try again.");
  }
}

const codeOf = (e: unknown): string | undefined => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : e instanceof Error ? e.message : undefined);

export function KnockHomeSettings({ plugin, st, setSt }: { plugin: NodePlugin; st: NodeStatus; setSt: (s: NodeStatus) => void }): React.ReactElement | null {
  const k = st.knock;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Caché tant que la voix du foyer (wall_voice) n'est pas prête pour ce nœud : les trois coups n'iront jamais dans la
  // session complète du titulaire en mode maison.
  if (!plugin.setKnock || !k?.available || !st.home?.on) return null;
  const set = async (on: boolean): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      setSt(await plugin.setKnock!({ on }));
    } catch (e) {
      setNote(knockHomeError(codeOf(e)));
    } finally {
      setBusy(false);
    }
  };
  const text = knockHomeStateText(k.state);
  return (
    <div className="phone-knock" data-home-knock={k.on ? "on" : "off"} data-home-knock-state={k.state}>
      <h4>{tr("Knock to call")}</h4>
      <p className="ob-muted">
        {tr(
          "Off by default. When on, this device listens to the room to recognise three knocks, and nothing else. The sound is analysed on this device then erased at once: it is neither recorded nor sent, and nothing leaves before the three knocks. A banner shows it while it is on. Turning it on asks for Face ID, Touch ID or the passcode of this device.",
        )}
      </p>
      {text ? (
        <p className={k.state === "denied" ? "ob-note" : "ob-muted"} role="status" data-home-knock-text>
          {text}
        </p>
      ) : null}
      <button type="button" className={k.on ? "ob-btn ob-btn-ghost" : "ob-btn"} disabled={busy} onClick={() => void set(!k.on)} data-home-knock-toggle>
        {k.on ? tr("Turn off") : tr("Turn on")}
      </button>
      {note ? (
        <p className="ob-note" role="alert" data-home-knock-error>
          {note}
        </p>
      ) : null}
    </div>
  );
}
