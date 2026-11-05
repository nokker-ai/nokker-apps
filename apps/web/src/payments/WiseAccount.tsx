/**
 * « Link my Wise account » in My account (core PAY-AGENT §10.1, issuer `wise`). Three steps:
 * 1. open — the person's identity goes once to Wise through the payment agent (which keeps none of it);
 * 2. verify — Wise checks the identity on its own page (the link lasts a few minutes; Wise brings the person back);
 * 3. activate — once Wise says PASSED, the person's passkey confirms that the payment agent may issue cards reserved
 *    to ONE purchase from this account. The core names the account it opened: the web never chooses one.
 * Then: the balance at Wise, and « Remove » (the agent blocks every live card).
 */
import React, { useCallback, useContext, useEffect, useState } from "react";
import { formatMoneyMinor, NokkerApiError, type NokkerClient, type PayBalance, type PayLinkPerson, type PayMethodView } from "@nokker-apps/sdk";
import { shellLang, tr } from "../i18n/index.js";
import { StoreContext } from "../context.js";
import type { SignChallenge } from "./PayMethodCard.js";
import "./payments.css";

export const KYC_DONE = ["PASSED", "PASSED_WITH_REQUIREMENTS"];

/** The Wise verification state in words. */
export function linkStateLabel(state: string | undefined): string {
  switch (state) {
    case "PASSED":
      return tr("Identity verified by Wise.");
    case "PASSED_WITH_REQUIREMENTS":
      return tr("Identity verified by Wise; Wise asks for more documents.");
    case "PROCESSING":
      return tr("Wise is checking your documents.");
    case "WAITING_CUSTOMER_INPUT":
      return tr("Wise is waiting for you to verify your identity.");
    default:
      return tr("Wise is preparing your verification.");
  }
}

/** Empty when the form can be sent, else the first problem — same rules as the payment agent. */
export function personError(p: PayLinkPerson): string | null {
  for (const k of ["first_name", "last_name", "address_line", "city"] as const) if (!p[k].trim()) return tr("Fill in every field marked as required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date_of_birth)) return tr("Date of birth: YYYY-MM-DD.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(p.email.trim())) return tr("Check the e-mail address.");
  if (!/^\+[1-9]\d{6,14}$/.test(p.phone.replace(/[\s.-]/g, ""))) return tr("Phone: international format, +41…");
  if (!/^[a-z]{3}$/.test(p.country_iso3)) return tr("Choose a country.");
  return null;
}

// Clés littérales (le catalogue ne connaît que des `tr("…")` écrits en toutes lettres).
const COUNTRIES: [string, () => string][] = [
  ["che", () => tr("Switzerland")],
  ["lie", () => tr("Liechtenstein")],
  ["fra", () => tr("France")],
  ["deu", () => tr("Germany")],
  ["ita", () => tr("Italy")],
  ["aut", () => tr("Austria")],
  ["bel", () => tr("Belgium")],
  ["lux", () => tr("Luxembourg")],
  ["nld", () => tr("Netherlands")],
  ["esp", () => tr("Spain")],
  ["prt", () => tr("Portugal")],
  ["gbr", () => tr("United Kingdom")],
];

const EMPTY: PayLinkPerson = { first_name: "", last_name: "", date_of_birth: "", address_line: "", city: "", post_code: "", country_iso3: "che", email: "", phone: "" };

function apiMessage(e: unknown): string {
  if (e instanceof NokkerApiError) {
    const code = (e.body as { error?: { code?: string } } | undefined)?.error?.code;
    if (e.status === 403) return tr("Your passkey signature was refused: try again from an enrolled device.");
    if (code === "kyc" || code === "kyc_pending" || code === "kyc_no_link") return tr("Wise has not finished preparing the verification: try again in a moment.");
    if (e.status === 400) return tr("Wise refused these details: check them.");
    if (e.status >= 500) return tr("The payment agent is unavailable: try again later.");
  }
  return e instanceof Error ? e.message : String(e);
}

function Field({ id, label, value, onChange, type = "text", autoComplete, required = true }: { id: string; label: string; value: string; onChange: (v: string) => void; type?: string; autoComplete?: string; required?: boolean }): React.ReactElement {
  return (
    <label className="pay-field" htmlFor={id}>
      <span>
        {label}
        {required ? " *" : ""}
      </span>
      <input id={id} type={type} value={value} autoComplete={autoComplete} required={required} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function WiseAccount({ client, view, signDecision: sign, onView }: { client: NokkerClient; view: PayMethodView; signDecision: SignChallenge | null; onView: (v: PayMethodView) => void }): React.ReactElement {
  // Only a passkey (WebAuthn) activates the payment agent: a device key signed in by mail code has none.
  const store = useContext(StoreContext);
  const signDecision = store && store.authMode !== "passkey" ? null : sign;
  const [person, setPerson] = useState<PayLinkPerson>(EMPTY);
  const [opening, setOpening] = useState(false);
  const [holder, setHolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(() => {
    // Retour de Wise : l'adresse de retour (configurée côté noyau) porte `wise=kyc`, Wise ajoute `status`.
    const q = new URLSearchParams(window.location.search);
    if (!q.has("wise")) return null;
    return q.get("status") === "success" ? tr("Back from Wise: the verification is being checked.") : tr("The verification at Wise was not finished.");
  });
  const [balances, setBalances] = useState<PayBalance[] | null>(null);
  const link = view.link ?? null;
  const method = view.method;
  const done = !!link && KYC_DONE.includes(link.state);

  const reload = useCallback(async () => {
    try {
      onView(await client.getPayMethod());
    } catch (e) {
      setErr(apiMessage(e));
    }
  }, [client, onView]);

  // The « back from Wise » note says the check is running: it goes once Wise has said it is done.
  useEffect(() => {
    if (done) setNote((n) => (n === tr("Back from Wise: the verification is being checked.") ? null : n));
  }, [done]);

  // Wise works on its side: read the state again while it is not finished.
  useEffect(() => {
    if (!link || done) return;
    const t = window.setInterval(() => void reload(), 5000);
    return () => window.clearInterval(t);
  }, [link, done, reload]);

  useEffect(() => {
    if (!link) return;
    let live = true;
    client.payBalance().then(
      (r) => live && setBalances(r.balances),
      () => live && setBalances(null),
    );
    return () => {
      live = false;
    };
  }, [client, link, method]);

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
  const open = (): Promise<void> =>
    act(async () => {
      const p = { ...person, phone: person.phone.replace(/[\s.-]/g, ""), email: person.email.trim() };
      const bad = personError(p);
      if (bad) throw new Error(bad);
      await client.startPayLink(p);
      setOpening(false);
      setPerson(EMPTY);
      await reload();
    });
  const verify = (): Promise<void> =>
    act(async () => {
      const { url } = await client.payLinkUrl();
      window.location.assign(url);
    });
  const activate = (): Promise<void> =>
    act(async () => {
      if (!signDecision) throw new Error(tr("A passkey is needed to save a payment method."));
      if (!holder.trim()) throw new Error(tr("Name on the cards: as on your identity document."));
      const { challenge, payment_method } = await client.payMethodChallenge();
      if (!payment_method) throw new Error(tr("The payment agent is unavailable: try again later."));
      const signed = await signDecision(challenge, "approve");
      if (!signed.webauthn) throw new Error(tr("A passkey is needed to save a payment method."));
      await client.putPayMethod(payment_method, { challenge, device_id: signed.device_id, ...signed.webauthn }, holder.trim());
      setNote(tr("Payment agent activated with your Wise account."));
      await reload();
    });
  const remove = (): Promise<void> =>
    act(async () => {
      await client.deletePayMethod();
      setNote(tr("Payment agent stopped: every card it issued is blocked."));
      await reload();
    });
  const set = (k: keyof PayLinkPerson) => (v: string) => setPerson((p) => ({ ...p, [k]: v }));

  return (
    <section className="ob-section pay-card" data-pay-method data-wise={method ? "active" : link ? link.state : "none"}>
      <h3 className="ob-sub">{tr("Payment agent — Wise account")}</h3>
      <p className="fine">
        {tr("The payment agent pays from an account in your name at Wise: for each purchase you approve with your passkey, it gets a card reserved to that purchase, capped to its amount. Wise holds the money and checks your identity; Nokker never sees a card number.")}
      </p>

      {!link ? (
        opening ? (
          <form
            className="pay-editor pay-person"
            onSubmit={(e) => {
              e.preventDefault();
              void open();
            }}
          >
            <p className="fine">{tr("These details go to Wise to open your account; the payment agent keeps none of them.")}</p>
            <div className="pay-grid">
              <Field id="wise-first" label={tr("First name")} value={person.first_name} onChange={set("first_name")} autoComplete="given-name" />
              <Field id="wise-last" label={tr("Last name")} value={person.last_name} onChange={set("last_name")} autoComplete="family-name" />
              <Field id="wise-dob" label={tr("Date of birth")} type="date" value={person.date_of_birth} onChange={set("date_of_birth")} autoComplete="bday" />
              <Field id="wise-email" label={tr("E-mail")} type="email" value={person.email} onChange={set("email")} autoComplete="email" />
              <Field id="wise-phone" label={tr("Mobile phone")} type="tel" value={person.phone} onChange={set("phone")} autoComplete="tel" />
              <Field id="wise-line" label={tr("Address")} value={person.address_line} onChange={set("address_line")} autoComplete="address-line1" />
              <Field id="wise-pc" label={tr("Postcode")} value={person.post_code ?? ""} onChange={set("post_code")} autoComplete="postal-code" required={false} />
              <Field id="wise-city" label={tr("City")} value={person.city} onChange={set("city")} autoComplete="address-level2" />
              <label className="pay-field" htmlFor="wise-country">
                <span>{tr("Country")} *</span>
                <select id="wise-country" value={person.country_iso3} onChange={(e) => set("country_iso3")(e.target.value)}>
                  {COUNTRIES.map(([code, name]) => (
                    <option key={code} value={code}>
                      {name()}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="pay-actions">
              <button type="submit" className="btn" disabled={busy}>
                {tr("Open my Wise account")}
              </button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setOpening(false)}>
                {tr("Cancel")}
              </button>
            </div>
          </form>
        ) : (
          <div className="pay-actions">
            <button type="button" className="btn" onClick={() => (setNote(null), setOpening(true))}>
              {tr("Link my Wise account")}
            </button>
          </div>
        )
      ) : (
        <>
          <p className="pay-state">
            <span className={`chip ${done ? "ok" : ""}`}>{done ? tr("verified") : tr("verification")}</span>
            <span>{linkStateLabel(link.state)}</span>
          </p>
          {link.state === "PASSED_WITH_REQUIREMENTS" && link.required_by ? (
            <p className="fine">{tr("Before {0}, or Wise may suspend the account.", new Date(link.required_by).toLocaleDateString())}</p>
          ) : null}
          {link.state === "WAITING_CUSTOMER_INPUT" || link.state === "PASSED_WITH_REQUIREMENTS" ? (
            <div className="pay-actions">
              <button type="button" className="btn" disabled={busy} onClick={() => void verify()}>
                {tr("Continue the verification at Wise")}
              </button>
            </div>
          ) : null}
          {balances && balances.length ? (
            <ul className="pay-balances" aria-label={tr("Balance at Wise")}>
              {balances.map((b) => (
                <li key={b.currency}>
                  <span className="fine">{tr("Balance at Wise")}</span> <strong>{formatMoneyMinor(b.amount_minor, b.currency, shellLang())}</strong>
                </li>
              ))}
            </ul>
          ) : null}
          {done && !method ? (
            <form
              className="pay-editor"
              onSubmit={(e) => {
                e.preventDefault();
                void activate();
              }}
            >
              <Field id="wise-holder" label={tr("Name on the cards")} value={holder} onChange={setHolder} autoComplete="name" />
              {!signDecision ? <p className="fine">{tr("Sign in with a passkey on this device to add a payment method.")}</p> : null}
              <div className="pay-actions">
                <button type="submit" className="btn btn-brass" disabled={busy || !signDecision}>
                  {tr("Activate with my passkey")}
                </button>
              </div>
            </form>
          ) : null}
          {method ? (
            <>
              <p className="pay-method">{tr("Active: the payment agent may issue cards from this account.")}</p>
              <div className="pay-actions">
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void remove()}>
                  {tr("Stop the payment agent")}
                </button>
              </div>
            </>
          ) : null}
        </>
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
