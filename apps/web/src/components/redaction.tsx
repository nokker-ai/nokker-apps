/**
 * Démasquage à l'AFFICHAGE (P9b) : seuls les marqueurs émis par cet appareil dans ce fil (dictionnaire du Vault)
 * s'affichent en clair ; tout autre marqueur reste visible, avec la note « valeur masquée sur ton téléphone ».
 */
import React, { createContext, useContext } from "react";
import { unmaskForDisplay, type RedactDict } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";

export const RedactContext = createContext<RedactDict>({});

export function MaskedText({ text }: { text: string }): React.ReactElement {
  const dict = useContext(RedactContext);
  if (!text.includes("⟦")) return <>{text}</>;
  return (
    <>
      {unmaskForDisplay(text, dict).map((p, i) =>
        "text" in p ? (
          <React.Fragment key={i}>{p.text}</React.Fragment>
        ) : p.value !== null ? (
          <span key={i} className="redact-unmasked" title={tr("Unmasked on this device only")} data-marker={p.marker} style={{ textDecoration: "underline dotted", textUnderlineOffset: "3px" }}>
            {p.value}
          </span>
        ) : (
          <span key={i} className="redact-marker" title={tr("Value masked on your phone")} data-marker={p.marker} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.9em", padding: "0 4px", borderRadius: 6, border: "1px solid rgba(127,127,127,0.4)" }}>
            {p.marker}
            <span className="sr-only"> ({tr("Value masked on your phone")})</span>
          </span>
        ),
      )}
    </>
  );
}
