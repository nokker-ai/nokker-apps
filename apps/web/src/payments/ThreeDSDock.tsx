/**
 * Dock of « Confirm this payment » cards (core PAY-AGENT §10.3): shown above everything, wherever the person is, while
 * the bank of a card issued by the payment agent waits for a 3-D Secure confirmation. It reads the mandates again on
 * every `payment.agent` event (and once at start, so a reload does not lose a waiting confirmation). Nothing shows
 * when the core has no payments or no payment agent (404), or when nothing waits.
 */
import React, { useCallback, useEffect, useState } from "react";
import { NokkerApiError, type NokkerClient } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import type { SignChallenge } from "./PayMethodCard.js";
import { ThreeDSConfirm } from "./ThreeDSConfirm.js";
import "./payments.css";

export function ThreeDSDock({ client, rev, signDecision }: { client: NokkerClient; rev: number; signDecision: SignChallenge | null }): React.ReactElement | null {
  const [waiting, setWaiting] = useState<string[]>([]);
  const [closed, setClosed] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    client.listPayCards().then(
      // Merged, never dropped here: a card answered stays readable until it settles (or is hidden), even though
      // the agent's event already says it is no longer waiting. One answered elsewhere says so (« gone »), then leaves.
      (r) => {
        if (!live) return;
        const now = r.mandates.filter((m) => m.agent?.status === "requires_action" && m.agent.threeds).map((m) => m.mandate_id);
        setWaiting((cur) => [...cur, ...now.filter((m) => !cur.includes(m))]);
      },
      (e) => void (e instanceof NokkerApiError && e.status === 404), // no payments here: nothing to show
    );
    return () => {
      live = false;
    };
  }, [client, rev]);
  const settle = useCallback((mid: string) => {
    // the answer stays readable a moment, then the card leaves
    window.setTimeout(() => setClosed((c) => (c.includes(mid) ? c : [...c, mid])), 4000);
  }, []);
  const shown = waiting.filter((m) => !closed.includes(m));
  if (!shown.length) return null;
  return (
    <div className="pay-3ds-dock" role="region" aria-label={tr("Payments to confirm")}>
      {shown.map((mid) => (
        <div key={mid} className="pay-3ds-card">
          <ThreeDSConfirm client={client} mandateId={mid} signDecision={signDecision} onSettled={() => settle(mid)} />
          <button type="button" className="btn btn-ghost pay-3ds-close" aria-label={tr("Hide")} onClick={() => setClosed((c) => [...c, mid])}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
