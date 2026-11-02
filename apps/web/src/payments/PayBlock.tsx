/**
 * « To pay » block of an approval card (core PAYMENTS §5): merchant, amount, items, link, validity — and, once the
 * passkey sealed the mandate, what the person does next (the browser is handed to them, or e-banking for a QR-bill).
 * The agent never pays and the client never takes a card number: there is no field for one here.
 */
import React, { useEffect, useState } from "react";
import { NokkerApiError, type MandateVerification, type NokkerClient, type PayCard } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import { mandateStatusLabel } from "./model.js";
import "./payments.css";

const safeHttp = (u: string | null | undefined): string | null => {
  if (!u) return null;
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:" ? x.href : null;
  } catch {
    return null;
  }
};

export function PayBlock({ client, approvalId, rev }: { client: NokkerClient; approvalId: string; rev: number }): React.ReactElement {
  const [card, setCard] = useState<PayCard | null | "none">(null);
  const [check, setCheck] = useState<MandateVerification | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    client.listPayCards().then(
      (r) => live && setCard(r.mandates.find((m) => m.approval_id === approvalId) ?? "none"),
      (e) => live && setCard(e instanceof NokkerApiError && e.status === 404 ? "none" : (setErr(String(e)), "none")),
    );
    return () => {
      live = false;
    };
  }, [client, approvalId, rev]);
  if (card === null) return <div className="pay-block" aria-busy="true" />;
  if (card === "none") return <div className="pay-block">{err ? <span className="error">{err}</span> : <p className="fine">{tr("Purchase details unavailable.")}</p>}</div>;
  const link = safeHttp(card.url);
  const verify = async (): Promise<void> => {
    setErr(null);
    try {
      setCheck(await client.verifyMandate(card.mandate_id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="pay-block" data-pay={card.status}>
      <div className="pay-head">
        <span className="pay-merchant">{card.merchant}</span>
        <span className="pay-amount">{card.amount}</span>
      </div>
      {card.items.length ? (
        <ul className="pay-items">
          {card.items.map((it, i) => (
            <li key={i}>
              <span>
                {it.quantity > 1 ? `${it.quantity} × ` : ""}
                {it.name}
              </span>
              {it.unit_price !== undefined ? <span className="mono">{String(it.unit_price)}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {card.reference ? <p className="fine">{tr("Reference {0}", card.reference)}</p> : null}
      {link ? (
        <p className="fine pay-link">
          <a href={link} target="_blank" rel="noopener noreferrer">
            {new URL(link).host}
          </a>
        </p>
      ) : null}
      <p className="pay-state">
        <span className={`chip ${card.status === "signed" ? "ok" : card.status === "pending" ? "" : "ko"}`}>{mandateStatusLabel(card.status)}</span>
        {card.status === "pending" && card.valid_until ? <span className="fine">{tr("valid until {0}", new Date(card.valid_until).toLocaleString())}</span> : null}
      </p>
      {card.status === "pending" ? (
        <p className="fine pay-note">{tr("Only a passkey approves a “to pay” card. Then you pay yourself: Nokker never pays and never sees a card number.")}</p>
      ) : card.status === "signed" ? (
        <>
          <p className="pay-next">
            {card.handoff.kind === "browser"
              ? tr("Approved with your passkey. The browser is handed to you: pay on the merchant's page.")
              : tr("Approved with your passkey. Pay it from your e-banking.")}
          </p>
          {card.handoff.kind === "browser" && link ? (
            <p>
              <a className="btn" href={link} target="_blank" rel="noopener noreferrer">
                {tr("Open the merchant's page")}
              </a>
            </p>
          ) : null}
          {check ? (
            <p className={`fine pay-verify ${check.valid ? "ok" : "ko"}`} role="status">
              {check.valid ? tr("Mandate valid: signed by your passkey{0}.", check.checks.device_key_trusted ? tr(", enrolled device") : "") : tr("Mandate not valid: {0}", check.errors.join(" · "))}
              {check.valid && check.expired ? ` ${tr("(its validity has passed)")}` : ""}
            </p>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => void verify()}>
              {tr("Check the mandate")}
            </button>
          )}
        </>
      ) : card.status === "rejected" ? (
        <p className="fine">{tr("Refused: the amount is no longer reserved.")}</p>
      ) : (
        <p className="fine">{tr("Expired: ask again if you still want it.")}</p>
      )}
      {err ? (
        <span className="error" role="alert">
          {err}
        </span>
      ) : null}
    </div>
  );
}
