import React from "react";
import type { SignaturePrefs } from "@nokker-apps/brand";
import { Icon } from "../icons.js";
import { knock } from "../sound.js";
import { tr } from "../i18n/index.js";

/** Interrupteur du toc toc toc — coupé par défaut (DEFAULT_PREFS), toujours visible. */
export function SoundToggle({ prefs, onChange }: { prefs: SignaturePrefs; onChange: (p: SignaturePrefs) => void }): React.ReactElement {
  const on = prefs.sound;
  return (
    <button
      type="button"
      className={`sound-toggle ${on ? "on" : ""}`}
      aria-pressed={on}
      aria-label={on ? tr("Bubble sound on — turn off") : tr("Bubble sound off — turn on")}
      title={on ? tr("Knock knock knock: on") : tr("Knock knock knock: off")}
      onClick={() => {
        const next = { ...prefs, sound: !on };
        onChange(next);
        if (next.sound) knock("bubble", { ...next, coalesceMs: 0 });
      }}
    >
      <Icon name={on ? "soundOn" : "soundOff"} size={18} />
      <span className="sound-label">{on ? tr("Sound") : tr("Muted")}</span>
    </button>
  );
}
