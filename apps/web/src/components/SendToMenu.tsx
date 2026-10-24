import React, { useEffect, useRef } from "react";
import type { Bubble, Thread, TransferMode } from "@nokker-apps/sdk";

/** Alternative clavier (et tactile) au glisser-déposer : « Envoyer vers… » une autre session. */
export function SendToMenu({
  bubble,
  threads,
  onPick,
  onClose,
}: {
  bubble: Bubble;
  threads: Thread[];
  onPick: (threadId: string, mode: TransferMode) => void;
  onClose: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const from = bubble.thread_id ?? (bubble.kind === "notify" ? bubble.state.from_thread : null);
  return (
    <div className="popover send-pop" role="dialog" aria-label={`Envoyer la bulle ${bubble.title} vers une session`} ref={ref} onPointerDown={(e) => e.stopPropagation()}>
      <span className="eyebrow">Envoyer vers…</span>
      {threads
        .filter((t) => t.id !== from)
        .map((t) => (
          <div key={t.id} className="send-row">
            <span className="pick-name">{t.title}</span>
            <button type="button" className="btn btn-sm" onClick={() => onPick(t.id, "move")} aria-label={`Déplacer vers ${t.title}`}>
              Déplacer
            </button>
            <button type="button" className="btn btn-sm btn-brass" onClick={() => onPick(t.id, "copy")} aria-label={`Copier vers ${t.title}`}>
              Copier
            </button>
          </div>
        ))}
    </div>
  );
}
