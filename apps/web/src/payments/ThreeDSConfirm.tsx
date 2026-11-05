/**
 * « Confirm this payment » (core PAY-AGENT §10.3, issuer `wise`): the bank asks for a 3-D Secure confirmation on a
 * purchase the payment agent is making with the card reserved to it. The person sees what the BANK sent (amount,
 * merchant, its address when the bank gave one), then confirms with a SECOND passkey on exactly those details — the
 * mandate's signature never answers a bank — or refuses. After the bank's delay the answer no longer counts (410).
 */
import React, { useEffect, useState } from "react";
import { formatMoneyMinor, NokkerApiError, type NokkerClient, type ThreeDSPending } from "@nokker-apps/sdk";
import { shellLang, tr } from "../i18n/index.js";
import { merchantLabel } from "./model.js";
import type { SignChallenge } from "./PayMethodCard.js";
import "./payments.css";

type Phase = "loading" | "open" | "busy" | "approved" | "declined" | "expired" | "gone" | "error";

/** « 2:05 » left before the bank's deadline (never negative). */
export function timeLeft(expiresAt: number, nowMs: number): string {
  const s = Math.max(0, Math.floor(expiresAt - nowMs / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const hostOf = (u: string | null): string | null => {
  if (!u) return null;
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
};

export function ThreeDSConfirm({ client, mandateId, signDecision, onSettled }: {
  client: NokkerClient;
  mandateId: string;
  signDecision: SignChallenge | null;
  /** Called once the confirmation is answered, refused, expired or already gone. */
  onSettled?: (phase: "approved" | "declined" | "expired" | "gone") => void;
}): React.ReactElement | null {
  const [p, setP] = useState<ThreeDSPending | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    client.getThreeDS(mandateId).then(
      (v) => live && (setP(v), setPhase(v.expires_at * 1000 <= Date.now() ? "expired" : "open")),
      (e) => live && (e instanceof NokkerApiError && e.status === 404 ? setPhase("gone") : (setErr(String(e)), setPhase("error"))),
    );
    return () => {
      live = false;
    };
  }, [client, mandateId]);

  useEffect(() => {
    if (phase !== "open" && phase !== "busy") return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [phase]);

  useEffect(() => {
    if (p && (phase === "open" || phase === "busy") && p.expires_at * 1000 <= now) setPhase("expired");
  }, [p, phase, now]);

  useEffect(() => {
    if (phase === "approved" || phase === "declined" || phase === "expired" || phase === "gone") onSettled?.(phase);
  }, [phase, onSettled]);

  const answer = async (confirm: boolean): Promise<void> => {
    if (!p) return;
    setPhase("busy");
    setErr(null);
    try {
      if (confirm) {
        if (!signDecision) throw new Error(tr("A passkey on this device is needed to confirm a payment."));
        const signed = await signDecision(p.challenge, "approve");
        if (!signed.webauthn) throw new Error(tr("A passkey on this device is needed to confirm a payment."));
        await client.answerThreeDS(mandateId, p.challenge_id, { proof: { challenge: p.challenge, device_id: signed.device_id, ...signed.webauthn } });
        setPhase("approved");
      } else {
        await client.answerThreeDS(mandateId, p.challenge_id, { decline: true });
        setPhase("declined");
      }
    } catch (e) {
      if (e instanceof NokkerApiError && e.status === 410) return setPhase("expired");
      if (e instanceof NokkerApiError && e.status === 404) return setPhase("gone");
      setErr(
        e instanceof NokkerApiError && e.status === 403
          ? tr("Your passkey signature was refused: try again from an enrolled device.")
          : e instanceof NokkerApiError && e.status >= 500
            ? tr("The bank did not take the answer: the payment will not go through.")
            : e instanceof Error
              ? e.message
              : String(e),
      );
      setPhase("open");
    }
  };

  if (phase === "loading") return <div className="pay-3ds" aria-busy="true" />;
  if (phase === "gone") return <p className="fine pay-3ds-done">{tr("No bank confirmation is waiting.")}</p>;
  if (phase === "error") return <p className="error" role="alert">{err}</p>;
  if (!p) return null;
  const host = hostOf(p.merchant_url);
  const done = phase === "approved" || phase === "declined" || phase === "expired";
  return (
    <section className="pay-3ds" data-3ds={phase} aria-labelledby={`pay3ds-${p.challenge_id}`}>
      <h4 className="pay-3ds-title" id={`pay3ds-${p.challenge_id}`}>
        {tr("Confirm this payment")}
      </h4>
      <p className="fine">{tr("Your bank asks you to confirm this purchase. The details below are the bank's.")}</p>
      <div className="pay-head">
        <span className="pay-merchant">{merchantLabel(p.merchant)}</span>
        <span className="pay-amount">{formatMoneyMinor(p.amount_minor, p.currency, shellLang())}</span>
      </div>
      {host ? (
        <p className={`fine pay-3ds-match ${p.merchant_match === "host" ? "ok" : "ko"}`}>
          {p.merchant_match === "host" ? tr("{0} — the merchant you approved.", host) : tr("{0} — check that it is the merchant you approved.", host)}
        </p>
      ) : (
        <p className="fine pay-3ds-match ko">{tr("The bank did not give the merchant's address: check the name.")}</p>
      )}
      {done ? (
        <p className="pay-next" role="status">
          {phase === "approved"
            ? tr("Payment confirmed with your passkey.")
            : phase === "declined"
              ? tr("Payment refused: nothing is charged.")
              : tr("Expired: the bank's delay has passed, the payment does not go through.")}
        </p>
      ) : (
        <>
          <p className="fine pay-3ds-left" aria-live="off">
            {tr("Time left: {0}", timeLeft(p.expires_at, now))}
          </p>
          <div className="pay-actions">
            <button type="button" className="btn btn-brass" disabled={phase === "busy" || !signDecision} onClick={() => void answer(true)}>
              {tr("Confirm with my passkey")}
            </button>
            <button type="button" className="btn" disabled={phase === "busy"} onClick={() => void answer(false)}>
              {tr("Refuse")}
            </button>
          </div>
          {!signDecision ? <p className="fine">{tr("A passkey on this device is needed to confirm a payment.")}</p> : null}
        </>
      )}
      {err ? (
        <p className="error" role="alert">
          {err}
        </p>
      ) : null}
    </section>
  );
}
