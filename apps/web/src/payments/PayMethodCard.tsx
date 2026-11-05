/**
 * « Payment method » card in My account (core docs/PAY-AGENT.md §8): the ONE method the payment agent may use, typed
 * into Stripe's Payment Element (never into Nokker), then confirmed with the account's passkey — the payment agent
 * checks that signature itself. Hidden when the core does not serve the payment agent (404: flag off).
 */
import React, { useEffect, useRef, useState } from "react";
import { NokkerApiError, type NokkerClient, type PayMethod, type PayMethodView } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import { methodLabel } from "./model.js";
import { SETUP_OPTIONS, stripeFor, type StripeElement, type StripeElements, type StripeLike } from "./stripe.js";
import { OwnCardAccount } from "./OwnCardAccount.js";
import { WiseAccount } from "./WiseAccount.js";
import "./payments.css";
import { off as offCap } from "../capabilities.js";

export type SignChallenge = (
  challenge: string,
  decision: "approve" | "reject",
) => Promise<{ device_id: string; webauthn?: { client_data_json: string; authenticator_data: string; signature: string } }>;

function apiMessage(e: unknown): string {
  if (e instanceof NokkerApiError) {
    const code = (e.body as { error?: { code?: string } } | undefined)?.error?.code;
    if (e.status === 403) return tr("Your passkey signature was refused: try again from an enrolled device.");
    if (code === "stripe" || e.status === 400) return tr("This payment method was refused.");
    if (e.status >= 500) return tr("The payment agent is unavailable: try again later.");
  }
  return e instanceof Error ? e.message : String(e);
}

function Entry({ pk, onReady, onCancel, busy }: { pk: string; onReady: (s: StripeLike, el: StripeElements) => void; onCancel: () => void; busy: boolean }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ s: StripeLike; els: StripeElements } | null>(null);
  useEffect(() => {
    let el: StripeElement | null = null;
    let live = true;
    stripeFor(pk).then(
      (s) => {
        if (!live || !host.current) return;
        const els = s.elements({ ...SETUP_OPTIONS });
        el = els.create("payment", { layout: "accordion" });
        el.mount(host.current);
        setCtx({ s, els });
      },
      () => live && setErr(tr("Stripe could not be loaded: check your connection.")),
    );
    return () => {
      live = false;
      el?.destroy();
    };
  }, [pk]);
  return (
    <form
      className="pay-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (ctx) onReady(ctx.s, ctx.els);
      }}
    >
      <div ref={host} className="pay-element" aria-busy={ctx ? "false" : "true"} />
      {err ? <p className="error" role="alert">{err}</p> : null}
      <p className="fine">{tr("Your card details go to Stripe only; Nokker never sees them. You confirm with your passkey.")}</p>
      <div className="pay-actions">
        <button type="submit" className="btn" disabled={!ctx || busy}>
          {tr("Save with my passkey")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          {tr("Cancel")}
        </button>
      </div>
    </form>
  );
}

export function PayMethodCard({ client, signDecision }: { client: NokkerClient; signDecision: SignChallenge | null }): React.ReactElement | null {
  const [view, setView] = useState<PayMethodView | null | "off">(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (offCap("pay_agent")) return setView("off");
    let live = true;
    client.getPayMethod().then(
      (v) => live && setView(v),
      (e) => live && (e instanceof NokkerApiError && e.status === 404 ? setView("off") : (setErr(apiMessage(e)), setView("off"))),
    );
    return () => {
      live = false;
    };
  }, [client]);
  if (view === "off" && !err) return null;
  if (view === null) return <section className="ob-section" data-pay-method aria-busy="true" />;
  // Émetteur wise (PAY-AGENT §10) : compte Wise ouvert par l'agent, au lieu du Payment Element de Stripe.
  if (view !== "off" && view.issuer === "wise") return <WiseAccount client={client} view={view} signDecision={signDecision} onView={setView} />;
  // « Ta carte » (PAY-AGENT §11, Lokkal) : la carte de la personne dans le coffre de la machine, passkey locale.
  if (view !== "off" && view.issuer === "own_card") return <OwnCardAccount client={client} view={view} onView={setView} />;

  const save = async (s: StripeLike, els: StripeElements): Promise<void> => {
    if (!signDecision) return;
    setBusy(true);
    setErr(null);
    try {
      const sub = await els.submit();
      if (sub.error) throw new Error(sub.error.message ?? tr("Check the card details."));
      const prep = await s.preparePaymentMethod({ elements: els });
      if (prep.error || !prep.paymentMethod) throw new Error(prep.error?.message ?? tr("Check the card details."));
      const pm = prep.paymentMethod.id;
      const { challenge } = await client.payMethodChallenge(pm);
      const signed = await signDecision(challenge, "approve");
      if (!signed.webauthn) throw new Error(tr("A passkey is needed to save a payment method."));
      const { method } = await client.putPayMethod(pm, { challenge, device_id: signed.device_id, ...signed.webauthn });
      setView({ ...(view as PayMethodView), method });
      setEditing(false);
      setNote(tr("Payment method saved."));
    } catch (e) {
      setErr(apiMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await client.deletePayMethod();
      setView({ ...(view as PayMethodView), method: null });
      setNote(tr("Payment method removed. Unused payment tokens are revoked."));
    } catch (e) {
      setErr(apiMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const v = view === "off" ? null : view;
  const m: PayMethod | null = v?.method ?? null;
  return (
    <section className="ob-section pay-card" data-pay-method>
      <h3 className="ob-sub">{tr("Payment method")}</h3>
      <p className="fine">
        {tr("Nokker's payment agent can pay with this method, only after you approve a “to pay” card with your passkey, within your budgets, at merchants that accept it. Elsewhere, you pay yourself.")}
      </p>
      {m ? <p className="pay-method">{methodLabel(m)}</p> : <p className="fine">{tr("No payment method saved.")}</p>}
      {editing && v?.publishable_key ? (
        <Entry pk={v.publishable_key} busy={busy} onReady={(s, els) => void save(s, els)} onCancel={() => setEditing(false)} />
      ) : v ? (
        <div className="pay-actions">
          {!signDecision ? (
            <p className="fine">{tr("Sign in with a passkey on this device to add a payment method.")}</p>
          ) : v.publishable_key ? (
            <button type="button" className="btn" disabled={busy} onClick={() => (setNote(null), setEditing(true))}>
              {m ? tr("Replace") : tr("Add a payment method")}
            </button>
          ) : null}
          {m ? (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void remove()}>
              {tr("Remove")}
            </button>
          ) : null}
        </div>
      ) : null}
      {note ? <p className="fine" role="status">{note}</p> : null}
      {err ? <p className="error" role="alert">{err}</p> : null}
    </section>
  );
}
