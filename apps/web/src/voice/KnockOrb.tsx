/** Three knocks heard: the orb shows briefly (listening, then idle). Nothing when the orb flag is off. */
import React from "react";
import { Orb } from "./Orb.js";
import { useKnockFlash } from "./orbState.js";

export function KnockOrb(): React.ReactElement | null {
  const s = useKnockFlash();
  if (s === "off") return null;
  return (
    <div className="orb-knock" data-orb-knock>
      <Orb state={s} size="md" />
    </div>
  );
}
