/**
 * Bubble `screen` (core docs/SCREENS.md §4, lot V7): a screen composed for the wall from Nokker's closed catalog.
 * The preview is static HTML rendered by the core (no script, own CSP `default-src 'none'`), WITHOUT household data,
 * shown in `<iframe sandbox="">` (no allow-scripts, no allow-same-origin). Publishing is the person's gesture: the
 * `publish` action asks for a strong card; nothing reaches the wall before it is approved.
 */
import React, { useEffect, useState } from "react";
import { NokkerApiError, type Bubble } from "@nokker-apps/sdk";
import { useStore } from "../context.js";
import { tr } from "../i18n/index.js";
import "./screen.css";

type ScreenBubble = Extract<Bubble, { kind: "screen" }>;

export function screenStatusLabel(status: ScreenBubble["state"]["status"]): string {
  return status === "published" ? tr("on the wall") : status === "pending" ? tr("waiting for the card") : tr("draft");
}

export function ScreenBody({ b, readOnly }: { b: ScreenBubble; readOnly: boolean }): React.ReactElement {
  const store = useStore();
  const st = b.state;
  const note =
    st.status === "pending"
      ? tr("Approve the card to put this screen on the wall: everyone who sees the wall will see it.")
      : st.status === "published"
        ? tr("This version is on the wall.")
        : st.published_version
          ? tr("The wall still shows version {0}: publish this one to replace it.", st.published_version)
          : tr("Preview: nothing is on the wall before you publish it.");
  return (
    <div className="bubble-body screen">
      <p className="fine screen-note">{note}</p>
      {st.html ? (
        <ScreenFrame screenId={st.screen_id} version={st.version} html={st.html} title={tr("Preview of the wall screen: {0}", st.title)} />
      ) : st.html_too_large ? (
        <p className="fine">{tr("The screen is too large to preview here.")}</p>
      ) : null}
      {!readOnly && st.actions?.length ? (
        <div className="bubble-actions">
          {st.actions.map((a) => (
            <button key={a.id} type="button" className={`btn ${a.primary ? "btn-brass" : ""}`} onClick={() => void store.runAction(b, a.id)}>
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The preview, served by the core under ITS OWN CSP (sandbox without scripts, default-src 'none'): a `srcdoc` page would
 * inherit the web's CSP, whose `style-src 'self'` blocks the screen's style. A new signed URL per version. Fallback to
 * `srcdoc` only for an older core (404 / 401 / 403 on frame-url). Never allow-scripts, never allow-same-origin. */
function ScreenFrame({ screenId, version, html, title }: { screenId: string; version: number; html: string; title: string }) {
  const store = useStore();
  const [src, setSrc] = useState<{ v: number; url: string | null; fallback: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    store.client.screenFrameUrl(screenId).then(
      (r) => live && setSrc({ v: version, url: store.client.resolveUrl(r.url), fallback: false }),
      (e) => {
        if (!live) return;
        const status = e instanceof NokkerApiError ? e.status : 0;
        setSrc({ v: version, url: null, fallback: status === 404 || status === 401 || status === 403 });
      },
    );
    return () => {
      live = false;
    };
  }, [store.client, screenId, version]);
  if (!src || src.v !== version) return null;
  if (src.url) return <iframe key={src.url} className="screen-frame" title={title} sandbox="" src={src.url} referrerPolicy="no-referrer" />;
  return src.fallback ? <iframe className="screen-frame" title={title} sandbox="" srcDoc={html} referrerPolicy="no-referrer" /> : null;
}
