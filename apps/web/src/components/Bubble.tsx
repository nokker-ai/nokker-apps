import React, { useLayoutEffect, useRef } from "react";
import type { Bubble as BubbleT, Thread, TransferMode } from "@nokker-apps/sdk";
import { bubbleTheme } from "@nokker-apps/brand";
import { Icon } from "../icons.js";
import { BubbleBody, bubbleLabel, statusLabel, useNow } from "../bubbles/kinds.js";
import { tr } from "../i18n/index.js";
import { useStore } from "../context.js";
import { SharePopover } from "./SharePopover.js";
import { SendToMenu } from "./SendToMenu.js";

export type Popover = "share" | "send" | null;

export interface BubbleProps {
  bubble: BubbleT;
  threads: Thread[];
  currentThread: string | null;
  collapsed: boolean;
  entering: boolean;
  leaving: boolean;
  flying: boolean;
  dragging: boolean;
  focused: boolean;
  draggable: boolean;
  style?: React.CSSProperties;
  popover: Popover;
  onPopover: (p: Popover) => void;
  onToggle: () => void;
  onClose: () => void;
  onShare: (req: { members: string[]; threads: string[] }) => void;
  onSendTo: (threadId: string, mode: TransferMode) => void;
  onGripDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  /** Clic n'importe où sur la bulle : elle passe devant (ordre z). */
  onActivate?: () => void;
}

/** Une bulle : en-tête (poignée, type, titre, statut, Réduire · Partager · Envoyer vers · Fermer), corps, pied partagé. */
export function Bubble(p: BubbleProps): React.ReactElement {
  const b = p.bubble;
  const theme = bubbleTheme(b.kind);
  const working = b.status === "working";
  const now = useNow(b.kind === "timer" && b.status !== "done");
  const ref = useRef<HTMLElement>(null);
  const readOnly = b.shared === true;
  const { members } = useStore();

  // Vol vers l'onglet Crew : on calcule la translation au moment où la bulle part.
  useLayoutEffect(() => {
    if (!p.flying || !p.leaving || !ref.current) return;
    const tab = document.querySelector("[data-crew-tab]");
    if (!tab) return;
    const r = ref.current.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    ref.current.style.setProperty("--fx", `${t.left + t.width / 2 - (r.left + r.width / 2)}px`);
    ref.current.style.setProperty("--fy", `${t.top + t.height / 2 - (r.top + r.height / 2)}px`);
  }, [p.flying, p.leaving]);

  useLayoutEffect(() => {
    if (p.focused) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [p.focused]);

  const cls = [
    "bubble",
    `k-${b.kind}`,
    working ? "working" : "",
    p.entering ? "enter" : "",
    p.leaving ? (p.flying ? "fly" : "leave") : "",
    p.dragging ? "dragging" : "",
    p.collapsed ? "collapsed" : "",
    p.focused ? "focused" : "",
    readOnly ? "readonly" : "",
  ].join(" ");

  // Couleur du type : profonde sur clair (`light`), vive sur sombre (`color`) — le CSS choisit selon le thème.
  const style = { ...p.style, "--k-l": theme.light, "--krgb-l": theme.lightRgb, "--k-d": theme.color, "--krgb-d": theme.rgb } as React.CSSProperties;
  // Sur une notify, `shared_with.members` = ses destinataires (noyau §8), pas un partage : on ne l'affiche pas.
  const sharedMembers = b.kind === "notify" ? [] : members.filter((m) => b.shared_with.members.includes(m.id));
  const sharedThreads = p.threads.filter((t) => b.shared_with.threads.includes(t.id));
  const fromTitle = readOnly ? p.threads.find((t) => t.id === b.thread_id)?.title : null;

  return (
    <article ref={ref} className={cls} style={style} aria-label={tr("Bubble {0}: {1}, {2}", bubbleLabel(b.kind), b.title, statusLabel(b, now))} data-bubble-id={b.id} onPointerDownCapture={p.onActivate}>
      <div className={`bubble-head ${p.draggable ? "grab" : ""}`} onPointerDown={p.draggable ? p.onGripDown : undefined}>
      <div className="bubble-bar">
        {p.draggable ? (
          <span className="grip" aria-hidden="true">
            <Icon name="grip" size={14} />
          </span>
        ) : null}
        <span className="kind-chip">
          <Icon name={theme.icon} size={14} />
          {bubbleLabel(b.kind)}
        </span>
        <span className={`bubble-status ${working ? "live" : ""}`}>{statusLabel(b, now)}</span>
        <div className="bubble-tools" onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" className="tool" onClick={p.onToggle} aria-label={p.collapsed ? tr("Expand the bubble") : tr("Collapse the bubble")} aria-expanded={!p.collapsed}>
            <Icon name={p.collapsed ? "chevronUp" : "chevronDown"} size={15} stroke={2} />
          </button>
          {!readOnly && b.kind !== "notify" ? (
            <>
              <button
                type="button"
                className={`tool ${p.popover === "share" ? "active" : ""}`}
                onClick={() => p.onPopover(p.popover === "share" ? null : "share")}
                aria-label={tr("Share the bubble")}
                aria-expanded={p.popover === "share"}
                aria-haspopup="dialog"
              >
                <Icon name="share" size={15} stroke={2} />
              </button>
              <button
                type="button"
                className={`tool ${p.popover === "send" ? "active" : ""}`}
                onClick={() => p.onPopover(p.popover === "send" ? null : "send")}
                aria-label={tr("Send the bubble to another session")}
                aria-expanded={p.popover === "send"}
                aria-haspopup="dialog"
              >
                <Icon name="arrowRight" size={15} stroke={2} />
              </button>
            </>
          ) : null}
          <button type="button" className="tool" onClick={p.onClose} aria-label={readOnly ? tr("Hide the shared bubble") : tr("Close the bubble")}>
            <Icon name="close" size={14} stroke={2} />
          </button>
        </div>
      </div>
      <h3 className="bubble-title">{b.kind === "notify" ? tr("{0} is writing to you", b.title) : b.title}</h3>
      </div>

      {p.popover === "share" ? (
        <SharePopover bubble={b} threads={p.threads} currentThread={p.currentThread} onShare={p.onShare} onClose={() => p.onPopover(null)} />
      ) : null}
      {p.popover === "send" ? <SendToMenu bubble={b} threads={p.threads} onPick={p.onSendTo} onClose={() => p.onPopover(null)} /> : null}

      {!p.collapsed ? <BubbleBody b={b} readOnly={readOnly} /> : null}

      {sharedMembers.length || sharedThreads.length || fromTitle || b.origin ? (
        <div className="bubble-foot">
          {fromTitle ? <span className="eyebrow">{tr("Shared from {0} · read-only", fromTitle)}</span> : null}
          {b.origin && !fromTitle ? (
            <span className="eyebrow">
              {b.origin.mode === "copy"
                ? tr("Copied from {0}", p.threads.find((t) => t.id === b.origin!.thread_id)?.title ?? tr("another session"))
                : tr("Came from {0}", p.threads.find((t) => t.id === b.origin!.thread_id)?.title ?? tr("another session"))}
            </span>
          ) : null}
          {sharedMembers.length || sharedThreads.length ? <span className="eyebrow">{tr("Shared")}</span> : null}
          {sharedMembers.map((m) => (
            <span key={m.id} className="avatar-sm" role="img" aria-label={tr("Shared with {0}", m.name)} title={m.name} style={{ background: m.color }}>
              {m.initials}
            </span>
          ))}
          {sharedThreads.map((t) => (
            <span key={t.id} className="session-pill">
              <span aria-hidden="true" />
              {t.title}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}
