import React, { useEffect, useRef } from "react";
import type { TransferMode } from "@nokker-apps/sdk";

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
    <div className="popover drop-menu" role="dialog" aria-label={`Déposer la bulle dans la session ${threadTitle}`} style={{ top, left }} ref={ref}>
      <span className="drop-title">
        Bulle <strong>{bubbleTitle}</strong> → session <strong className="brass">{threadTitle}</strong>
      </span>
      <div className="drop-actions">
        <button type="button" className="btn" onClick={() => onPick("move")}>
          Déplacer
        </button>
        <button type="button" className="btn btn-brass" onClick={() => onPick("copy")}>
          Copier
        </button>
        <button type="button" className="icon-btn" aria-label="Annuler" onClick={onCancel}>
          ✕
        </button>
      </div>
    </div>
  );
}
