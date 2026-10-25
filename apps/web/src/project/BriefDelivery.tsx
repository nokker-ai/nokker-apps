/** Livraison du brief hors de l'app (§7.18.5), dans le réglage « Brief du matin » : Telegram, et e-mail derrière une
 * carte forte signée pour cette adresse et cette boîte. Choix de chaque personne, tout éteint par défaut. */
import React, { useEffect, useState } from "react";
import { NokkerApiError, type BriefDelivery as Delivery, type NokkerClient } from "@nokker-apps/sdk";
import "./project.css";

type Toast = (text: string, tone?: "ok" | "error") => void;

const EMAIL_STATE: Record<Delivery["email"]["state"], string> = { off: "coupée", pending: "en attente de ta signature", armed: "active", not_armed: "à signer de nouveau" };
const LAST: Record<string, string> = { off: "coupé", sent: "envoyé", failed: "en échec", no_chat: "aucun chat relié", not_armed: "non signé" };

export function deliveryError(e: unknown): string {
  if (e instanceof NokkerApiError) {
    const err = (e.body as { error?: { code?: string; message?: string } | string } | undefined)?.error;
    const code = typeof err === "string" ? err : err?.code;
    if (code === "no_telegram") return "Relie Telegram d'abord (onglet Connecteurs).";
    if (code === "no_mail_connector") return "Relie d'abord une boîte mail : le brief part depuis ta boîte.";
    if (code === "approvals_unavailable") return "Les approbations fortes ne sont pas disponibles ici : pas de livraison par e-mail.";
    if (code === "invalid") return "Adresse illisible.";
    return (typeof err === "object" && err?.message) || `refus du serveur (${e.status})`;
  }
  return "le serveur ne répond pas";
}

/** « dernière livraison : … Telegram envoyé, e-mail en échec ». */
export function lastLine(last: Delivery["last"]): string {
  if (!last) return "aucune livraison pour l'instant";
  const at = typeof last.at === "number" ? new Date(last.at * 1000) : new Date(last.at);
  return `dernière livraison le ${Number.isNaN(at.getTime()) ? String(last.at) : at.toLocaleString("fr-CH")} : Telegram ${LAST[last.telegram] ?? last.telegram}, e-mail ${LAST[last.email] ?? last.email}`;
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
      toast(r.email.state === "pending" && "email" in req && req.email ? "Signe la carte pour activer l'envoi par e-mail." : ok, "ok");
    } catch (e) {
      toast(deliveryError(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const noChat = d.telegram.chats === 0;
  return (
    <div className="brief-delivery">
      <label className="bd-check" title={noChat ? "relie Telegram d'abord" : undefined}>
        <input type="checkbox" checked={d.telegram.enabled} disabled={busy || (noChat && !d.telegram.enabled)} onChange={(e) => void put({ telegram: e.target.checked }, e.target.checked ? "Brief envoyé aussi sur Telegram." : "Plus d'envoi sur Telegram.")} /> Sur
        Telegram
        {noChat ? <span className="fine"> (relie Telegram d'abord)</span> : null}
      </label>
      <form
        className="team-inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void put({ email: email.trim() || null }, email.trim() ? "Adresse enregistrée." : "Plus d'envoi par e-mail.");
        }}
      >
        <label className="bd-check">
          <input type="checkbox" checked={d.email.state !== "off"} disabled={busy} onChange={(e) => (e.target.checked ? undefined : void put({ email: null }, "Plus d'envoi par e-mail."))} /> Par e-mail
        </label>
        <input type="email" aria-label="Adresse de livraison du brief" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="adresse@exemple.ch" />
        <button type="submit" className="btn btn-sm" disabled={busy || email.trim() === (d.email.address ?? "")}>
          Enregistrer
        </button>
      </form>
      {d.email.state !== "off" ? (
        <p className="fine">
          {d.email.from ? `Depuis ta boîte ${d.email.from} · ` : ""}
          {EMAIL_STATE[d.email.state]}
          {d.email.state === "pending" && d.email.approval_id ? (
            <>
              {" "}
              — <a href={`/approvals/${encodeURIComponent(d.email.approval_id)}`}>signer la carte</a>
            </>
          ) : null}
        </p>
      ) : null}
      <p className="fine">{lastLine(d.last)}</p>
    </div>
  );
}
