/** The Guide's cards and lists: pure rendering from the core's codes, worded here (fr/en). No state of its own but « copied ». */
import React, { useState } from "react";
import type { GuideAskFeature, GuideFeature } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import { Icon } from "../icons.js";
import { actionable, canOpenScreen, canShowMe, featureText, groupedFeatures, statusLabel, usageText } from "./model.js";

export interface CardEnv {
  /** Views the web serves (ViewId). */
  served: readonly string[];
  /** Core flag `show_me` of the view. */
  coreShowMe: boolean;
  /** Web flag `VITE_NOKKER_SHOW_ME`. */
  webShowMe: boolean;
  onOpen: (screen: string) => void;
  onShowMe: (ui: string) => void;
}

function CommandCode({ command }: { command: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    try {
      void navigator.clipboard?.writeText(command).then(() => setCopied(true), () => undefined);
    } catch {
      /* clipboard unavailable: the command stays visible and selectable */
    }
  };
  return (
    <span className="guide-cmd">
      <code>{command}</code>
      <button type="button" className="guide-copy" onClick={copy} aria-label={tr("Copy {0}", command)}>
        {copied ? tr("Copied") : tr("Copy")}
      </button>
    </span>
  );
}

export function FeatureCard({ f, env, used }: { f: GuideAskFeature; env: CardEnv; used?: number }): React.ReactElement {
  const text = featureText(f.id);
  const ok = actionable(f);
  const open = canOpenScreen(f, env.served);
  const show = canShowMe(f, { show_me: env.coreShowMe }, env.webShowMe);
  return (
    <article className={`guide-card status-${f.status}`} data-feature={f.id} data-status={f.status}>
      <header className="guide-card-head">
        <h4>{text.name}</h4>
        <span className={`guide-chip ${f.status}`}>{statusLabel(f.status)}</span>
      </header>
      {text.purpose ? <p className="guide-purpose">{text.purpose}</p> : null}
      {f.status === "setup" && text.how ? (
        <p className="guide-how">
          <strong>{tr("To turn it on:")}</strong> {text.how}
        </p>
      ) : f.status === "on" && text.how ? (
        <p className="guide-how fine">{text.how}</p>
      ) : null}
      {ok && f.command ? <CommandCode command={f.command} /> : null}
      {open || show ? (
        <div className="guide-actions">
          {open ? (
            <button type="button" className="btn" onClick={() => env.onOpen(f.screen!)}>
              {tr("Open")}
            </button>
          ) : null}
          {show ? (
            <button type="button" className="btn" onClick={() => env.onShowMe(f.ui!)}>
              <Icon name="pointer" size={14} /> {tr("Show me")}
            </button>
          ) : null}
        </div>
      ) : null}
      {used !== undefined && ok ? <p className="guide-usage fine">{usageText(used)}</p> : null}
    </article>
  );
}

export function Cards({ features, env, usage }: { features: GuideAskFeature[]; env: CardEnv; usage?: Record<string, number> }): React.ReactElement {
  return (
    <div className="guide-cards">
      {features.map((f) => (
        <FeatureCard key={f.id} f={f} env={env} {...(usage && f.id in usage ? { used: usage[f.id]! } : {})} />
      ))}
    </div>
  );
}

/** « What I can do », grouped by status. */
export function CapabilityList({ features, env }: { features: GuideFeature[]; env: CardEnv }): React.ReactElement {
  return (
    <div className="guide-list">
      {groupedFeatures(features).map((g) => (
        <section key={g.status} className="guide-group" data-group={g.status}>
          <h3>{g.title}</h3>
          <Cards features={g.features} env={env} usage={Object.fromEntries(g.features.map((f) => [f.id, f.used]))} />
        </section>
      ))}
    </div>
  );
}
