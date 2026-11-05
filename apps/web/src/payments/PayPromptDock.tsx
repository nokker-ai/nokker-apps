/**
 * What the bank asks the person during a payment made with THEIR card (core PAY-AGENT §11, own_card, Lokkal):
 * - `cvv`: the security code for this payment (when it is not kept on the machine) — kept in memory by the payment
 *   agent for this payment only;
 * - `otp`: « Enter the code from your bank » — the payment agent's component types it in the bank's page itself; it
 *   never goes into the conversation, and the model never sees it;
 * - `bank_app`: « Confirm in your bank's app » — the payment agent waits without touching anything.
 * A banner on top of every screen, with a countdown; read again on every `payment.agent` event and at start.
 */
import React, { useCallback, useEffect, useState } from "react";
import { formatMoneyMinor, NokkerApiError, type NokkerClient, type PayCard } from "@nokker-apps/sdk";
import { shellLang, tr } from "../i18n/index.js";
import { merchantLabel } from "./model.js";
import { timeLeft } from "./ThreeDSConfirm.js";
import "./payments.css";

function Prompt({ client, card, onDone }: { client: NokkerClient; card: PayCard; onDone: () => void }): React.ReactElement | null {
  const p = card.agent?.prompt;
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  if (!p) return null;
  const expired = p.expires_at * 1000 <= now;
  const what = `${formatMoneyMinor(card.amount_minor, card.currency, shellLang())} · ${merchantLabel(card.merchant)}`;
  const send = async (): Promise<void> => {
    const kind: "cvv" | "otp" | null = p.kind === "cvv" ? "cvv" : p.kind === "otp" ? "otp" : null;
    if (kind === null) return;
    setBusy(true);
    setErr(null);
    try {
      await client.providePaymentValue(card.mandate_id, kind, value.trim());
      setValue(""); // rien ne reste dans la page
      setSent(true);
      onDone();
    } catch (e) {
      setErr(
        e instanceof NokkerApiError && e.status === 404
          ? tr("Nothing is asked any more for this payment.")
          : e instanceof NokkerApiError && e.status === 400
            ? p.kind === "cvv"
              ? tr("The security code has 3 or 4 digits.")
              : tr("Check the code: digits or letters, as sent by your bank.")
            : e instanceof Error
              ? e.message
              : String(e),
      );
    } finally {
      setBusy(false);
    }
  };
  const title = p.kind === "cvv" ? tr("Security code for this payment") : p.kind === "otp" ? tr("Enter the code from your bank") : tr("Confirm in your bank's app");
  return (
    <section className="pay-3ds pay-prompt" data-prompt={p.kind} aria-labelledby={`prompt-${card.mandate_id}`}>
      <h4 className="pay-3ds-title" id={`prompt-${card.mandate_id}`}>
        {title}
      </h4>
      <p className="fine">{what}</p>
      {p.kind === "bank_app" ? (
        <p className="fine">{tr("Your bank sent a request to its app. Confirm it there; your payment agent waits and touches nothing.")}</p>
      ) : sent ? (
        <p className="pay-next" role="status">
          {tr("Given to your payment agent.")}
        </p>
      ) : expired ? (
        <p className="pay-next" role="status">
          {tr("Expired: the payment did not go on. You can pay yourself on the merchant's page.")}
        </p>
      ) : (
        <form
          className="pay-inline"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            aria-label={title}
            type="password"
            inputMode={p.kind === "cvv" ? "numeric" : "text"}
            autoComplete={p.kind === "otp" ? "one-time-code" : "off"}
            maxLength={p.kind === "cvv" ? 4 : 10}
            value={value}
            onChange={(e) => setValue(p.kind === "cvv" ? e.target.value.replace(/\D/g, "") : e.target.value.replace(/\s/g, ""))}
          />
          <button type="submit" className="btn btn-brass" disabled={busy || !value.trim()}>
            {tr("Give it to my payment agent")}
          </button>
        </form>
      )}
      {!sent && !expired ? (
        <p className="fine pay-3ds-left" aria-live="off">
          {tr("Time left: {0}", timeLeft(p.expires_at, now))}
        </p>
      ) : null}
      <p className="fine">
        {p.kind === "otp"
          ? tr("Your payment agent types it in your bank's page itself. It never appears in the conversation.")
          : p.kind === "cvv"
            ? tr("Kept in memory for this payment only, never saved.")
            : null}
      </p>
      {err ? (
        <p className="error" role="alert">
          {err}
        </p>
      ) : null}
    </section>
  );
}

export function PayPromptDock({ client, rev }: { client: NokkerClient; rev: number }): React.ReactElement | null {
  const [cards, setCards] = useState<PayCard[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    client.listPayCards().then(
      (r) => live && setCards(r.mandates.filter((m) => m.agent?.kind === "own_card" && m.agent.prompt)),
      () => live && setCards([]),
    );
    return () => {
      live = false;
    };
  }, [client, rev, tick]);
  const done = useCallback(() => window.setTimeout(() => setTick((n) => n + 1), 2500), []);
  const shown = cards.filter((c) => !hidden.includes(`${c.mandate_id}:${c.agent?.prompt?.kind}`));
  if (!shown.length) return null;
  return (
    <div className="pay-3ds-dock pay-prompt-dock" role="region" aria-label={tr("Your bank asks")}>
      {shown.map((c) => (
        <div key={`${c.mandate_id}:${c.agent?.prompt?.kind}`} className="pay-3ds-card">
          <Prompt client={client} card={c} onDone={done} />
          <button type="button" className="btn btn-ghost pay-3ds-close" aria-label={tr("Hide")} onClick={() => setHidden((h) => [...h, `${c.mandate_id}:${c.agent?.prompt?.kind}`])}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
