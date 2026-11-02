/**
 * Body of a `pointer` bubble (core docs/SHOW-ME.md §3-4): the sign (step, caption), the target, and the answers.
 * Image target: the thread's image with a big arrow on the point. Browser target: the element's label (no shared view
 * of the browser). Interface target: the overlay draws the arrow over the app itself; « Show me where » replays it.
 * Caption, label and name are untrusted text: rendered as text, never HTML.
 */
import React, { useEffect, useRef, useState } from "react";
import type { BubbleBase, NokkerClient, PointerTarget } from "@nokker-apps/sdk";
import { useStore } from "../context.js";
import { Icon } from "../icons.js";
import { tr } from "../i18n/index.js";
import { pct, signSide, uiName } from "./model.js";
import { Arrow } from "./Arrow.js";
import { replayOverlay } from "./ShowMeOverlay.js";
import "./showme.css";

function PointerImage({ client, threadId, target }: { client: NokkerClient; threadId: string; target: Extract<PointerTarget, { kind: "image" }> }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    client.getThreadImage(threadId, target.sha256).then(
      (blob) => {
        made = URL.createObjectURL(blob);
        if (live) setUrl(made);
        else URL.revokeObjectURL(made);
      },
      () => live && setUrl(null),
    );
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [client, threadId, target.sha256]);
  const x = pct(target.x);
  const y = pct(target.y);
  if (url === null) return <p className="fine">{tr("image unavailable")}</p>;
  return (
    <figure className="showme-shot">
      {url ? <img src={url} alt={target.name || tr("attached image")} /> : <span className="showme-shot-wait">{tr("loading…")}</span>}
      {url ? (
        <span className={`showme-at side-${signSide(x, y)}`} style={{ left: `${x}%`, top: `${y}%` }} role="img" aria-label={tr("Arrow at {0} % across, {1} % down", Math.round(x), Math.round(y))}>
          <span className="showme-dot" />
          <Arrow />
        </span>
      ) : null}
    </figure>
  );
}

export function PointerBody({ b, readOnly }: { b: BubbleBase<"pointer">; readOnly: boolean }): React.ReactElement {
  const store = useStore();
  const st = b.state;
  const t = st?.target;
  const root = useRef<HTMLDivElement>(null);
  // Phone: the bubble strip is short and may hold other bubbles; at each step, bring the answers into view in it.
  useEffect(() => {
    const el = root.current;
    if (el?.closest(".bubble-inline")) el.querySelector(".bubble-actions, .showme-wait")?.scrollIntoView({ block: "nearest" });
  }, [b.version]);
  const actions = !readOnly ? (
    <div className="bubble-actions">
      <button type="button" className="btn btn-brass" disabled={!!st?.waiting} onClick={() => void store.runAction(b, "done")}>
        <Icon name="check" size={14} /> {tr("Done")}
      </button>
      <button type="button" className="btn" disabled={!!st?.waiting} onClick={() => void store.runAction(b, "lost")}>
        {tr("I can't find it")}
      </button>
    </div>
  ) : null;
  // Order: what to do, the answers, then where (the answers stay visible in the phone's short bubble strip).
  return (
    <div className="bubble-body pointer" ref={root}>
      <p className="showme-caption">{st?.caption || tr("Look where the arrow points.")}</p>
      {st?.waiting ? (
        <p className="fine showme-wait" role="status">
          {st.answer === "lost" ? tr("Nina is looking for another way…") : tr("Nina prepares the next step…")}
        </p>
      ) : (
        actions
      )}
      {t?.kind === "image" && b.thread_id ? (
        <PointerImage client={store.client} threadId={b.thread_id} target={t} />
      ) : t?.kind === "browser" ? (
        <p className="showme-where">
          <Icon name="pointer" size={14} /> {tr("On the page:")} <strong className="showme-label">{t.label}</strong> <code>{t.ref}</code>
        </p>
      ) : t?.kind === "ui" ? (
        <p className="showme-where">
          <Icon name="pointer" size={14} /> {uiName(t.ui)}
          <button type="button" className="btn btn-sm btn-ghost showme-replay" onClick={() => replayOverlay()}>
            {tr("Show me where")}
          </button>
        </p>
      ) : null}
    </div>
  );
}

export function pointerStatusLabel(b: BubbleBase<"pointer">): string {
  return b.state?.waiting ? tr("waiting for Nina") : tr("your turn");
}
