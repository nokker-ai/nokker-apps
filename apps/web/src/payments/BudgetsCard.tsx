/**
 * « Spending » card in My account (core PAYMENTS §5): the budgets the agent's « to pay » cards are checked against —
 * the payer sees and sets every member's line, a member sees their own — and the last « to pay » cards. Hidden when
 * the core does not serve payments (404: flag off).
 */
import React, { useCallback, useEffect, useState } from "react";
import { NokkerApiError, type BudgetLine, type BudgetsView, type NokkerClient, type PayCard } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import { draftError, draftOf, fmt, mandateStatusLabel, memberLabel, roleLabel, spendState, type BudgetDraft } from "./model.js";
import "./payments.css";
import { off as offCap } from "../capabilities.js";

function apiMessage(e: unknown): string {
  if (e instanceof NokkerApiError) {
    const b = (e.body as { error?: { code?: string; message?: string } } | undefined)?.error;
    if (b?.code === "payer_only") return tr("Only the payer of the household sets budgets.");
    if (b?.code === "rate") return tr("Too many changes: try again in a minute.");
    if (b?.message) return b.message;
  }
  return e instanceof Error ? e.message : String(e);
}

function Meter({ label, spent, cap, currency }: { label: string; spent: number; cap: number; currency: string }): React.ReactElement {
  const pct = cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 0;
  return (
    <div className="pay-meter" data-level={pct >= 100 ? "full" : pct >= 80 ? "warn" : "ok"}>
      <div className="pay-meter-head">
        <span>{label}</span>
        <span className="pay-num">{tr("{0} of {1}", fmt(spent, currency), fmt(cap, currency))}</span>
      </div>
      <div className="acc-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="acc-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Editor({ line, onSave, onReset, onCancel, busy }: { line: BudgetLine; onSave: (d: BudgetDraft) => void; onReset: () => void; onCancel: () => void; busy: boolean }): React.ReactElement {
  const [d, setD] = useState<BudgetDraft>(() => draftOf(line));
  const problem = draftError(d);
  const id = `pay-${line.account}`;
  const field = (k: "per_purchase" | "per_day" | "per_month", label: string): React.ReactElement => (
    <label className="pay-field" htmlFor={`${id}-${k}`}>
      <span>{label}</span>
      <input id={`${id}-${k}`} inputMode="decimal" value={d[k]} onChange={(e) => setD({ ...d, [k]: e.target.value })} />
    </label>
  );
  return (
    <form
      className="pay-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) onSave(d);
      }}
    >
      <div className="pay-fields">
        <label className="pay-field pay-cur" htmlFor={`${id}-cur`}>
          <span>{tr("Currency")}</span>
          <input id={`${id}-cur`} maxLength={3} value={d.currency} onChange={(e) => setD({ ...d, currency: e.target.value.toUpperCase() })} />
        </label>
        {field("per_purchase", tr("Per purchase"))}
        {field("per_day", tr("Per day"))}
        {field("per_month", tr("Per month"))}
      </div>
      {line.role === "minor" ? (
        <label className="pay-check">
          <input type="checkbox" checked={d.minor_allowed} onChange={(e) => setD({ ...d, minor_allowed: e.target.checked })} />
          <span>{tr("Allow this minor to spend (each card comes to you to approve)")}</span>
        </label>
      ) : null}
      {problem ? <p className="ob-note">{problem}</p> : null}
      <div className="ob-actions">
        <button type="submit" className="ob-btn primary" disabled={busy || !!problem}>
          {tr("Save")}
        </button>
        {line.source === "set" ? (
          <button type="button" className="ob-btn" disabled={busy} onClick={onReset}>
            {line.role === "payer" ? tr("Back to the default budget") : tr("Remove the budget")}
          </button>
        ) : null}
        <button type="button" className="ob-btn" disabled={busy} onClick={onCancel}>
          {tr("Cancel")}
        </button>
      </div>
    </form>
  );
}

export function BudgetsCard({ client }: { client: NokkerClient }): React.ReactElement | null {
  const [view, setView] = useState<BudgetsView | null | "off">(null);
  const [cards, setCards] = useState<PayCard[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [me, setMe] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (offCap("pay")) return setView("off");
    client.getPaymentBudgets().then(setView, (e) => setView(e instanceof NokkerApiError && e.status === 404 ? "off" : (setError(apiMessage(e)), null)));
    client.listPayCards().then((r) => setCards(r.mandates.slice(0, 5)), () => undefined);
  }, [client]);
  useEffect(load, [load]);
  // Labels of the household (when there is one): the budget lines only carry account ids.
  useEffect(() => {
    if (!view || view === "off") return;
    if (view.members.length < 2) return setMe(view.members[0]?.account ?? null);
    client.getHousehold().then(
      (h) => {
        setMe(h.you.account_id);
        setNames(new Map((h.members ?? []).filter((x) => !x.you && x.email).map((x) => [x.account_id, x.email])));
      },
      () => setMe(view.members.length === 1 ? view.members[0]!.account : view.members.find((l) => l.role === "payer" && view.is_payer)?.account ?? null),
    );
  }, [client, view]);

  if (view === "off") return null;
  const save = async (line: BudgetLine, d: BudgetDraft): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await client.putPaymentBudget(line.account, { currency: d.currency.trim().toUpperCase(), per_purchase: d.per_purchase.trim(), per_day: d.per_day.trim(), per_month: d.per_month.trim(), ...(line.role === "minor" ? { minor_allowed: d.minor_allowed } : {}) });
      setEditing(null);
      load();
    } catch (e) {
      setError(apiMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const reset = async (line: BudgetLine): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await client.resetPaymentBudget(line.account);
      setEditing(null);
      load();
    } catch (e) {
      setError(apiMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ob-conn pay-card" aria-labelledby="acc-spending">
      <h3 id="acc-spending">{tr("Spending")}</h3>
      <p className="ob-muted">{tr("Nokker can prepare a purchase; you always pay it yourself after approving with your passkey. Each card is checked against these budgets first, and a waiting card reserves its amount.")}</p>
      {error ? (
        <p className="ob-error" role="alert">
          {error}
        </p>
      ) : null}
      {view === null ? null : (
        <>
          {!view.is_payer ? <p className="ob-note">{tr("Only the payer of the household sets budgets.")}</p> : null}
          <ul className="acc-list pay-lines">
            {view.members.map((line, i) => {
              const b = line.budget;
              return (
                <li key={line.account} data-budget={line.account} data-can-spend={line.can_spend ? "yes" : "no"}>
                  <div className="pay-line">
                    <div className="pay-line-head">
                      <strong>{memberLabel(line, me, names, i)}</strong>
                      <span className="chip">{roleLabel(line.role)}</span>
                      <span className={`chip ${line.can_spend ? "ok" : "ko"}`}>{spendState(line)}</span>
                    </div>
                    {b ? (
                      <>
                        <p className="ob-note">{tr("{0} per purchase · {1} per day · {2} per month", fmt(b.per_purchase_minor, b.currency), fmt(b.per_day_minor, b.currency), fmt(b.per_month_minor, b.currency))}</p>
                        <Meter label={tr("Today")} spent={line.spent_today_minor ?? 0} cap={b.per_day_minor} currency={b.currency} />
                        <Meter label={tr("This month")} spent={line.spent_month_minor ?? 0} cap={b.per_month_minor} currency={b.currency} />
                      </>
                    ) : null}
                    {editing === line.account ? <Editor line={line} busy={busy} onSave={(d) => void save(line, d)} onReset={() => void reset(line)} onCancel={() => setEditing(null)} /> : null}
                  </div>
                  {view.is_payer && editing !== line.account ? (
                    <button type="button" className="ob-btn" onClick={() => setEditing(line.account)} aria-label={tr("Set the budget of {0}", memberLabel(line, me, names, i))}>
                      {b ? tr("Change") : tr("Set a budget")}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {cards.length ? (
            <>
              <h4 className="pay-sub">{tr("Last “to pay” cards")}</h4>
              <ul className="acc-list pay-history">
                {cards.map((c) => (
                  <li key={c.mandate_id} data-mandate={c.status}>
                    <span>{c.merchant}</span>
                    <span className="pay-num">{c.amount}</span>
                    <span className={`chip ${c.status === "signed" ? "ok" : c.status === "pending" ? "" : "ko"}`}>{mandateStatusLabel(c.status)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
