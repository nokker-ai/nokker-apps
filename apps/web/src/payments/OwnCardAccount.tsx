/**
 * « Ta carte » in My account (core PAY-AGENT §11, issuer `own_card`, Lokkal only): the person pays with THEIR card,
 * through their payment agent. Three parts:
 * 1. the passkey of THIS machine (WebAuthn, rpId localhost): it signs « to pay » cards here, nothing else;
 * 2. the card, typed in a password-like field outside the chat, sent once to the local payment agent, which writes it
 *    to the machine's vault — only the brand, last four digits and expiry come back;
 * 3. the security code: asked for each payment (default) or kept in the machine's vault.
 * Advice shown: a virtual card with a low limit, switched on when buying.
 */
import React, { useCallback, useEffect, useState } from "react";
import { NokkerApiError, type LocalPasskey, type NokkerClient, type OwnCard, type PayMethodView } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import { methodLabel } from "./model.js";
import "./payments.css";

const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(b.length));
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
};
const bytesToB64url = (buf: ArrayBuffer): string => {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Digits only, Luhn: the same check as the payment agent, before anything is sent. */
export function cardNumberOk(raw: string): boolean {
  const pan = raw.replace(/[\s-]/g, "");
  if (!/^\d{12,19}$/.test(pan)) return false;
  let total = 0;
  for (let i = 0; i < pan.length; i++) {
    let d = Number(pan[pan.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    total += d;
  }
  return total % 10 === 0;
}

/** « MM/AA » or « MM/AAAA » → [month, year], or null. */
export function parseExpiry(raw: string, now = new Date()): [number, number] | null {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{2}|\d{4})\s*$/.exec(raw);
  if (!m) return null;
  const month = Number(m[1]);
  const year = m[2]!.length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  if (month < 1 || month > 12 || year * 100 + month < now.getFullYear() * 100 + now.getMonth() + 1) return null;
  return [month, year];
}

async function createLocalPasskey(client: NokkerClient): Promise<LocalPasskey> {
  if (!window.PublicKeyCredential || !navigator.credentials?.create) throw new Error(tr("This browser cannot create a passkey."));
  const o = await client.localPasskeyOptions();
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: b64urlToBytes(o.challenge),
      rp: { id: o.rp_id, name: o.rp_name },
      user: { id: b64urlToBytes(o.user.id), name: o.user.name, displayName: o.user.display_name },
      pubKeyCredParams: o.pub_key_cred_params,
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      excludeCredentials: o.exclude_credentials.map((id) => ({ type: "public-key" as const, id: b64urlToBytes(id) })),
      timeout: o.timeout_ms ?? 120000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error(tr("No passkey was created."));
  const resp = cred.response as AuthenticatorAttestationResponse;
  const spki = resp.getPublicKey?.();
  const alg = resp.getPublicKeyAlgorithm?.();
  if (!spki || alg !== -7) throw new Error(tr("This passkey type is not supported here: use one with ES256 (most devices)."));
  return client.registerLocalPasskey({
    challenge: o.challenge,
    credential_id: bytesToB64url(cred.rawId),
    public_key_spki: bytesToB64url(spki),
    public_key_alg: alg,
    client_data_json: bytesToB64url(resp.clientDataJSON),
    name: tr("Passkey of this machine"),
  });
}

function apiMessage(e: unknown): string {
  if (e instanceof NokkerApiError) {
    const code = (e.body as { error?: { code?: string } } | undefined)?.error?.code ?? "";
    if (code === "card_number") return tr("This card number is not valid.");
    if (code === "card_expiry") return tr("The expiry date has passed or cannot be read.");
    if (code === "card_holder") return tr("Enter the name on the card.");
    if (code === "card_cvv") return tr("The security code has 3 or 4 digits.");
    if (code === "vault" || e.status === 503) return tr("The vault of this machine is not available: check that it is unsealed.");
    if (code === "proof_invalid") return tr("The passkey was refused: try again.");
    if (e.status >= 500) return tr("The payment agent is unavailable: try again later.");
  }
  if (e instanceof DOMException && e.name === "NotAllowedError") return tr("Passkey cancelled.");
  return e instanceof Error ? e.message : String(e);
}

export function OwnCardAccount({ client, view, onView }: { client: NokkerClient; view: PayMethodView; onView: (v: PayMethodView) => void }): React.ReactElement {
  const card = (view.method as OwnCard | null) ?? null;
  const [passkeys, setPasskeys] = useState<LocalPasskey[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [number, setNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [holder, setHolder] = useState("");
  const [keepCvv, setKeepCvv] = useState(false);
  const [cvv, setCvv] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const loadPasskeys = useCallback(async () => {
    try {
      setPasskeys((await client.listLocalPasskeys()).passkeys);
    } catch {
      setPasskeys([]);
    }
  }, [client]);
  useEffect(() => void loadPasskeys(), [loadPasskeys]);

  const act = async (f: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await f();
    } catch (e) {
      setErr(apiMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const reload = async (): Promise<void> => onView(await client.getPayMethod());
  const clearForm = (): void => {
    setNumber("");
    setExpiry("");
    setCvv("");
    setHolder("");
  };
  const save = (): Promise<void> =>
    act(async () => {
      if (!cardNumberOk(number)) throw new Error(tr("This card number is not valid."));
      const exp = parseExpiry(expiry);
      if (!exp) throw new Error(tr("The expiry date has passed or cannot be read."));
      if (!holder.trim()) throw new Error(tr("Enter the name on the card."));
      if (keepCvv && !/^\d{3,4}$/.test(cvv)) throw new Error(tr("The security code has 3 or 4 digits."));
      await client.putOwnCard({ number: number.replace(/[\s-]/g, ""), exp_month: exp[0], exp_year: exp[1], holder: holder.trim(), keep_cvv: keepCvv, ...(keepCvv ? { cvv } : {}) });
      clearForm(); // nothing of the card stays in the page
      setEditing(false);
      setNote(tr("Card saved in the vault of this machine."));
      await reload();
    });
  const remove = (): Promise<void> =>
    act(async () => {
      await client.deletePayMethod();
      setNote(tr("Card removed from this machine."));
      await reload();
    });
  const setCvvMode = (keep: boolean, code?: string): Promise<void> =>
    act(async () => {
      await client.ownCardCvvMode(keep, code);
      setCvv("");
      await reload();
    });

  return (
    <section className="ob-section pay-card" data-pay-method data-owncard={card ? "saved" : "none"}>
      <h3 className="ob-sub">{tr("Your card — paid through your payment agent")}</h3>
      <p className="fine">
        {tr("You pay with your own card. After you approve a “to pay” card with the passkey of this machine, your payment agent fills in the payment at that merchant, at most the approved amount. The card stays on this machine, in its vault; Nokker never uses it for itself.")}
      </p>
      <p className="fine pay-advice">{tr("Advice: use a virtual card with a low limit, switched on only when you buy.")}</p>

      <h4 className="pay-sub">{tr("Passkey of this machine")}</h4>
      {passkeys === null ? null : passkeys.length ? (
        <ul className="pay-passkeys">
          {passkeys.map((p) => (
            <li key={p.device_id}>
              <span>{p.name}</span>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void act(async () => (await client.deleteLocalPasskey(p.device_id), await loadPasskeys()))}>
                {tr("Remove")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="fine">{tr("No passkey yet: create one to approve payments on this machine.")}</p>
      )}
      <div className="pay-actions">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await createLocalPasskey(client);
              setNote(tr("Passkey created on this machine."));
              await loadPasskeys();
            })
          }
        >
          {passkeys?.length ? tr("Add another passkey") : tr("Create a passkey on this machine")}
        </button>
      </div>

      <h4 className="pay-sub">{tr("Card")}</h4>
      {card && !editing ? (
        <>
          <p className="pay-method">{methodLabel(card)}</p>
          <fieldset className="pay-cvv-mode">
            <legend className="fine">{tr("Security code (CVV)")}</legend>
            <label>
              <input type="radio" name="cvv-mode" checked={!card.cvv_kept} disabled={busy} onChange={() => void setCvvMode(false)} /> {tr("Ask me for each payment (recommended)")}
            </label>
            <label>
              <input type="radio" name="cvv-mode" checked={!!card.cvv_kept} disabled={busy} onChange={() => setKeepCvv(true)} /> {tr("Keep it in the vault of this machine")}
            </label>
            {keepCvv && !card.cvv_kept ? (
              <span className="pay-inline">
                <input aria-label={tr("Security code (CVV)")} type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={cvv} onChange={(e) => setCvv(e.target.value.replace(/\D/g, ""))} />
                <button type="button" className="btn" disabled={busy || !/^\d{3,4}$/.test(cvv)} onClick={() => void setCvvMode(true, cvv)}>
                  {tr("Keep")}
                </button>
              </span>
            ) : null}
          </fieldset>
          <div className="pay-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => (setNote(null), setEditing(true))}>
              {tr("Replace")}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void remove()}>
              {tr("Remove")}
            </button>
          </div>
        </>
      ) : (
        <form
          className="pay-editor"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <p className="fine">{tr("Typed here only, never in the conversation. It goes straight to the vault of this machine.")}</p>
          <div className="pay-grid">
            <label className="pay-field" htmlFor="own-number">
              <span>{tr("Card number")} *</span>
              <input id="own-number" type="password" inputMode="numeric" autoComplete="off" value={number} onChange={(e) => setNumber(e.target.value.replace(/[^\d\s-]/g, ""))} />
            </label>
            <label className="pay-field" htmlFor="own-expiry">
              <span>{tr("Expiry (MM/YY)")} *</span>
              <input id="own-expiry" type="text" inputMode="numeric" autoComplete="off" placeholder="MM/AA" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
            </label>
            <label className="pay-field" htmlFor="own-holder">
              <span>{tr("Name on the card")} *</span>
              <input id="own-holder" type="text" autoComplete="off" value={holder} onChange={(e) => setHolder(e.target.value)} />
            </label>
          </div>
          <label className="pay-check">
            <input type="checkbox" checked={keepCvv} onChange={(e) => setKeepCvv(e.target.checked)} /> {tr("Keep the security code in the vault of this machine (otherwise asked for each payment)")}
          </label>
          {keepCvv ? (
            <label className="pay-field" htmlFor="own-cvv">
              <span>{tr("Security code (CVV)")} *</span>
              <input id="own-cvv" type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={cvv} onChange={(e) => setCvv(e.target.value.replace(/\D/g, ""))} />
            </label>
          ) : null}
          <div className="pay-actions">
            <button type="submit" className="btn btn-brass" disabled={busy}>
              {tr("Save the card on this machine")}
            </button>
            {card ? (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => (clearForm(), setEditing(false))}>
                {tr("Cancel")}
              </button>
            ) : null}
          </div>
        </form>
      )}
      {note ? (
        <p className="fine" role="status">
          {note}
        </p>
      ) : null}
      {err ? (
        <p className="error" role="alert">
          {err}
        </p>
      ) : null}
    </section>
  );
}
