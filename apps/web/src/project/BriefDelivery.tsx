/** Livraison du brief hors de l'app (§7.18.5), dans le réglage « Brief du matin » : Telegram, et e-mail derrière une
 * carte forte signée pour cette adresse et cette boîte. Choix de chaque personne, tout éteint par défaut. */
import React, { useEffect, useState } from "react";
import { NokkerApiError, type BriefDelivery as Delivery, type NokkerClient } from "@nokker-apps/sdk";
import { shellLang, tr } from "../i18n/index.js";
import "./project.css";

type Toast = (text: string, tone?: "ok" | "error") => void;

function emailState(s: Delivery["email"]["state"]): string {
  switch (s) {
    case "off":
      return tr("off");
    case "pending":
      return tr("waiting for your signature");
    case "armed":
      return tr("active");
    case "not_armed":
      return tr("to be signed again");
  }
}
function lastState(s: string): string {
  switch (s) {
    case "off":
      return tr("off");
    case "sent":
      return tr("sent");
    case "failed":
      return tr("failed");
    case "no_chat":
      return tr("no chat linked");
    case "not_armed":
      return tr("not signed");
    default:
      return s;
  }
}

export function deliveryError(e: unknown): string {
  if (e instanceof NokkerApiError) {
    const err = (e.body as { error?: { code?: string; message?: string } | string } | undefined)?.error;
    const code = typeof err === "string" ? err : err?.code;
    if (code === "no_telegram") return tr("Link Telegram first (Connectors tab).");
    if (code === "no_mail_connector") return tr("Link a mailbox first: the brief is sent from your mailbox.");
    if (code === "approvals_unavailable") return tr("Strong approvals are not available here: no email delivery.");
    if (code === "invalid") return tr("Unreadable address.");
    return (typeof err === "object" && err?.message) || tr("server refused ({0})", e.status);
  }
  return tr("the server is not responding");
}

/** « last delivery: … Telegram sent, email failed ». */
export function lastLine(last: Delivery["last"]): string {
  if (!last) return tr("no delivery yet");
  const at = typeof last.at === "number" ? new Date(last.at * 1000) : new Date(last.at);
  return tr(
    "last delivery on {0}: Telegram {1}, email {2}",
    Number.isNaN(at.getTime()) ? String(last.at) : at.toLocaleString(shellLang() === "fr" ? "fr-CH" : "en-GB"),
    lastState(last.telegram),
    lastState(last.email),
  );
}

export function BriefDelivery({ client, toast }: { client: NokkerClient; toast: Toast }): React.ReactElement | null {
  const [d, setD] = useState<Delivery | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    client.getBriefDelivery().then(
      (r) => {
        setD(r);
        setEmail(r.email.address ?? "");
      },
      () => setD(null),
    );
  }, [client]);
  if (!d) return null;
  const put = async (req: { telegram?: boolean; email?: string | null }, ok: string): Promise<void> => {
    setBusy(true);
    try {
      const r = await client.putBriefDelivery(req);
      setD(r);
      setEmail(r.email.address ?? "");
      toast(r.email.state === "pending" && "email" in req && req.email ? tr("Sign the card to enable email delivery.") : ok, "ok");
    } catch (e) {
      toast(deliveryError(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const noChat = d.telegram.chats === 0;
  return (
    <div className="brief-delivery">
      <label className="bd-check" title={noChat ? tr("link Telegram first") : undefined}>
        <input type="checkbox" checked={d.telegram.enabled} disabled={busy || (noChat && !d.telegram.enabled)} onChange={(e) => void put({ telegram: e.target.checked }, e.target.checked ? tr("Brief also sent on Telegram.") : tr("No more sending on Telegram."))} />{" "}
        {tr("On Telegram")}
        {noChat ? <span className="fine"> ({tr("link Telegram first")})</span> : null}
      </label>
      <form
        className="team-inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void put({ email: email.trim() || null }, email.trim() ? tr("Address saved.") : tr("No more sending by email."));
        }}
      >
        <label className="bd-check">
          <input type="checkbox" checked={d.email.state !== "off"} disabled={busy} onChange={(e) => (e.target.checked ? undefined : void put({ email: null }, tr("No more sending by email.")))} />{" "}
          {tr("By email")}
        </label>
        <input type="email" aria-label={tr("Brief delivery address")} value={email} onChange={(e) => setEmail(e.target.value)} placeholder={tr("address@example.com")} />
        <button type="submit" className="btn btn-sm" disabled={busy || email.trim() === (d.email.address ?? "")}>
          {tr("Save")}
        </button>
      </form>
      {d.email.state !== "off" ? (
        <p className="fine">
          {d.email.from ? tr("From your mailbox {0} · ", d.email.from) : ""}
          {emailState(d.email.state)}
          {d.email.state === "pending" && d.email.approval_id ? (
            <>
              {" "}
              — <a href={`/approvals/${encodeURIComponent(d.email.approval_id)}`}>{tr("sign the card")}</a>
            </>
          ) : null}
        </p>
      ) : null}
      <p className="fine">{lastLine(d.last)}</p>
    </div>
  );
}
