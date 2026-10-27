import React, { useEffect, useRef } from "react";
import type { TransferMode } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";

/** Après un dépôt sur une session du tiroir : Déplacer / Copier / Annuler. */
export function DropMenu({
  bubbleTitle,
  threadTitle,
  top,
  left,
  onPick,
  onCancel,
}: {
  bubbleTitle: string;
  threadTitle: string;
  top: number;
  left: number;
  onPick: (mode: TransferMode) => void;
  onCancel: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="popover drop-menu" role="dialog" aria-label={tr("Drop the bubble into the session {0}", threadTitle)} style={{ top, left }} ref={ref}>
      <span className="drop-title">
        {tr("Bubble")} <strong>{bubbleTitle}</strong> → {tr("session")} <strong className="brass">{threadTitle}</strong>
      </span>
      <div className="drop-actions">
        <button type="button" className="btn" onClick={() => onPick("move")}>
          {tr("Move")}
        </button>
        <button type="button" className="btn btn-brass" onClick={() => onPick("copy")}>
          {tr("Copy")}
        </button>
        <button type="button" className="icon-btn" aria-label={tr("Cancel")} onClick={onCancel}>
          ✕
        </button>
      </div>
    </div>
  );
}
