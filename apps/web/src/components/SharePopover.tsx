import React, { useEffect, useRef, useState } from "react";
import type { Bubble, Thread } from "@nokker-apps/sdk";
import { Icon } from "../icons.js";
import { useStore } from "../context.js";
import { tr } from "../i18n/index.js";

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* repli ci-dessous */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function bubbleLink(b: Bubble, currentThread: string | null): string {
  const t = b.thread_id ?? currentThread ?? "";
  return `${window.location.origin}${window.location.pathname}#/t/${t}/b/${b.id}`;
}

/** Partager : membres (personnes), sessions (fils), copier le lien. Remplace la liste côté serveur (§2). */
export function SharePopover({
  bubble,
  threads,
  currentThread,
  onShare,
  onClose,
}: {
  bubble: Bubble;
  threads: Thread[];
  currentThread: string | null;
  onShare: (req: { members: string[]; threads: string[] }) => void;
  onClose: () => void;
}): React.ReactElement {
  const [copied, setCopied] = useState<"ok" | "ko" | null>(null);
  const { members } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const sh = bubble.shared_with;

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (list: string[], v: string): string[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <div className="popover share-pop" role="dialog" aria-label={tr("Share the bubble {0}", bubble.title)} ref={ref} onPointerDown={(e) => e.stopPropagation()}>
      <span className="eyebrow">{tr("Members")}</span>
      <div className="pick-list">
        {members.map((m) => {
          const on = sh.members.includes(m.id);
          return (
            <button key={m.id} type="button" className="pick" aria-pressed={on} onClick={() => onShare({ members: toggle(sh.members, m.id), threads: sh.threads })}>
              <span className="avatar-sm" style={{ background: m.color }} aria-hidden="true">
                {m.initials}
              </span>
              <span className="pick-name">{m.name}</span>
              {on ? <Icon name="check" className="pick-on" /> : null}
            </button>
          );
        })}
      </div>
      <span className="eyebrow sep">{tr("Sessions")}</span>
      <div className="pick-list">
        {threads
          .filter((t) => t.id !== bubble.thread_id)
          .map((t) => {
            const on = sh.threads.includes(t.id);
            return (
              <button key={t.id} type="button" className="pick" aria-pressed={on} onClick={() => onShare({ members: sh.members, threads: toggle(sh.threads, t.id) })}>
                <span className="pick-dot" aria-hidden="true" />
                <span className="pick-name">{t.title}</span>
                {on ? <Icon name="check" className="pick-on" /> : null}
              </button>
            );
          })}
      </div>
      <button
        type="button"
        className="btn btn-ghost copy-link"
        onClick={async () => {
          setCopied((await copyText(bubbleLink(bubble, currentThread))) ? "ok" : "ko");
          setTimeout(() => setCopied(null), 1800);
        }}
      >
        <Icon name="link" />
        {copied === "ok" ? tr("Link copied") : copied === "ko" ? tr("Copy failed") : tr("Copy link")}
      </button>
    </div>
  );
}
