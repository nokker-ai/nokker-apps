/**
 * Pages par le téléphone dans le fil (LOKKAL-PHONE §4.5, lot P11). Sur la réponse d'un `web_fetch` refusé, le noyau
 * joint une OFFRE quand la personne a un téléphone dont `egress` est allumé : le bouton « Ouvrir par mon téléphone » est
 * le GESTE de la personne (le modèle ne choisit jamais le téléphone). Le geste crée un tour de la personne ; la réponse
 * dit « page ouverte par ton téléphone (hôte) ».
 */
import React, { useState } from "react";
import { NokkerApiError, type NokkerClient, type PhoneFetched, type PhoneFetchOffer, type PhoneTaskNote } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";

const codeOf = (e: unknown): string | undefined => (e instanceof NokkerApiError ? (e.body as { error?: { code?: string } } | undefined)?.error?.code : undefined);

export function PhoneFetchOffers({ client, threadId, offers }: { client: NokkerClient; threadId: string; offers: PhoneFetchOffer[] }): React.ReactElement {
  const [state, setState] = useState<Record<string, "busy" | "sent" | string>>({});
  const open = async (o: PhoneFetchOffer): Promise<void> => {
    setState((s) => ({ ...s, [o.call_id]: "busy" }));
    try {
      await client.phoneFetch(threadId, { url: o.url, call_id: o.call_id });
      setState((s) => ({ ...s, [o.call_id]: "sent" }));
    } catch (e) {
      setState((s) => ({ ...s, [o.call_id]: codeOf(e) ?? "error" }));
    }
  };
  return (
    <div className="phone-fetch-offers" data-phone-fetch-offers>
      {offers.map((o) => {
        const st = state[o.call_id];
        return (
          <div key={o.call_id} className="phone-fetch-offer" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, margin: "8px 0" }}>
            <button type="button" className="btn btn-ghost btn-sm" disabled={st === "busy" || st === "sent" || st === "offer_used"} onClick={() => void open(o)} data-phone-fetch={o.call_id}>
              {tr("Open through my phone ({0})", o.host)}
            </button>
            {st === "sent" ? (
              <span className="fine" role="status">{tr("Requested from your phone.")}</span>
            ) : st === "no_phone_egress" ? (
              <span className="fine" role="alert">{tr("Your phone is not reachable: open the app and allow pages in My account → This phone.")}</span>
            ) : st === "offer_used" ? (
              <span className="fine" role="status">{tr("Already opened through your phone.")}</span>
            ) : st && st !== "busy" ? (
              <span className="fine" role="alert">{tr("The page could not be requested. Try again.")}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Phrase de la table du noyau (nokker/cloud/egress.py, REASONS) pour le code BRUT de `phone_fetched.error`. */
export function fetchErrorText(code: string | undefined): string {
  switch (code) {
    case "blocked_address":
      return tr("address refused (local or private network)");
    case "dns_failed":
      return tr("domain name not found");
    case "tls_failed":
      return tr("secure connection refused");
    case "timeout":
      return tr("time limit exceeded");
    case "too_large":
      return tr("page too heavy (over 768 KiB)");
    case "unsupported_type":
      return tr("content type not readable");
    case "too_many_redirects":
      return tr("too many redirects");
    case "redirect_not_allowed":
      return tr("redirect refused");
    case "scheme_not_allowed":
      return tr("address that is neither http nor https");
    case "port_not_allowed":
      return tr("port refused");
    case "host_not_allowed":
      return tr("site not in the list allowed on the phone");
    case "egress_off":
      return tr("phone web access turned off in the app");
    case "metered_cap":
      return tr("mobile data limit reached");
    case "constrained":
      return tr("data saving mode active on the phone");
    case "no_network":
      return tr("phone without network");
    case "rate":
      return tr("too many pages opened by the phone, try again later");
    case "grant_invalid":
      return tr("authorisation expired, tap \"Open through my phone\" again");
    case "phone_timeout":
      return tr("the phone did not answer (app closed or offline)");
    case "cellular_off":
      return tr("phone on mobile data, not allowed to open pages (setting \"Also on mobile data\" in the Nokker app)");
    case "low_battery":
      return tr("phone battery too low (under 20 %, not charging)");
    default:
      return tr("reason not specified");
  }
}

export function PhoneFetchedNote({ items }: { items: PhoneFetched[] }): React.ReactElement {
  return (
    <div className="phone-fetched fine" data-phone-fetched>
      {items.map((f, i) => (
        <p key={i} data-ok={f.ok ? "1" : "0"}>
          {f.ok ? tr("Page opened by your phone ({0})", f.host) : tr("Your phone could not open {0}: {1}", f.host, fetchErrorText(f.error))}
        </p>
      ))}
    </div>
  );
}

/** P7b : libellé d'une opération du téléphone (mêmes noms que `OP_LABELS` du noyau), première lettre en majuscule. */
export function phoneOpLabel(op: string): string {
  switch (op) {
    case "zone.state":
      return tr("Zone state");
    case "ocr.image":
      return tr("Text from an image");
    case "calendar.list":
      return tr("Calendar");
    default:
      return op;
  }
}

/** Nom du téléphone dans la bulle (relecture des textes, 06.11) : espaces normalisés, coupé à 40 caractères avec « … ». */
export function phoneNameShort(name: string): string {
  const n = name.split(/\s+/).filter(Boolean).join(" ");
  return n.length > 40 ? `${n.slice(0, 40)}…` : n;
}

/** Texte figé à la relecture des textes (06.11) pour un état de la bulle `phone_task`, espaces ordinaires ; test `phone-tasks.test.ts`. */
export function phoneTaskText(t: Pick<PhoneTaskNote, "op" | "name" | "status">): string {
  const op = phoneOpLabel(t.op);
  const name = phoneNameShort(t.name);
  switch (t.status) {
    case "pending":
      return tr("{0}: request sent to your phone {1}…", op, name);
    case "done":
      return tr("{0}: result received from your phone {1}", op, name);
    case "failed":
      return tr("{0}: did not complete on your phone {1}", op, name);
    case "expired":
      return tr("{0}: your phone {1} did not answer in time", op, name);
    default:
      return tr("{0}: request cancelled", op);
  }
}

/** P7b : tâches du téléphone qui ont dépassé les 20 s du tour (`phone_tasks`). L'état se relit avec le fil ; la suite
 * vient dans un tour du noyau (`origin: "phone_continue"`, jamais rendu). Pas d'annulation par la personne ici. */
export function PhoneTaskNotes({ items }: { items: PhoneTaskNote[] }): React.ReactElement {
  return (
    <div className="phone-fetched fine" data-phone-tasks>
      {items.map((t) => (
        <p key={t.task_id} data-phone-task={t.status}>
          {phoneTaskText(t)}
        </p>
      ))}
    </div>
  );
}
