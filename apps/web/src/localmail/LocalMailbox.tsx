/**
 * Boîte mail de la machine (LOKKAL §7.25), onglet Machine d'un Lokkal (jeton local) : UNE boîte IMAP/SMTP du
 * propriétaire local, de localité `local` (rien ne quitte la machine). Le mot de passe n'apparaît jamais ici : on choisit
 * le NOM d'un secret déjà rangé dans le coffre (section du dessus) ; le noyau teste IMAP puis SMTP avant de ranger.
 * Envoyer et mettre à la corbeille depuis cette boîte demandent toujours une carte forte.
 */
import React, { useCallback, useEffect, useState } from "react";
import { NokkerApiError, type LocalMailCard, type MailSettings, type NokkerClient } from "@nokker-apps/sdk";
import { shellLang, tr } from "../i18n/index.js";
import "./localmail.css";

type Toast = (text: string, tone?: "ok" | "error") => void;

/** Texte en clair d'un code d'erreur des connecteurs (dans la langue de l'interface, lu à l'appel). */
function codeText(code: string): string | undefined {
  switch (code) {
    case "auth_failed":
      return tr("Credentials refused by the mail server: check the address, the user and the chosen secret.");
    case "unreachable":
      return tr("Mail server unreachable from this machine.");
    case "tls_failed":
      return tr("The encrypted connection to the mail server failed.");
    case "protocol_error":
      return tr("The mail server answered unexpectedly.");
    case "port_not_allowed":
      return tr("Port refused: IMAP 993 or 143, SMTP 465 or 587.");
    case "host_blocked":
      return tr("This host is not reachable by Nokker (private or reserved address).");
    case "not_configured":
      return tr("No mailbox linked.");
    case "key_missing":
      return tr("The machine's vault is unavailable or sealed.");
    default:
      return undefined;
  }
}

/** Message d'une erreur des connecteurs (`{error: <code>, message}`) : celui du noyau tel quel, sinon le code en clair. */
export function mailError(e: unknown): string {
  if (e instanceof NokkerApiError) {
    const b = e.body as { error?: string | { message?: string }; message?: string } | undefined;
    if (e.status === 403) return tr("The machine's mailbox is set up on the machine only, never through the gateway.");
    if (typeof b?.message === "string" && b.message) return b.message;
    const code = typeof b?.error === "string" ? b.error : undefined;
    const known = code ? codeText(code) : undefined;
    if (known) return known;
    if (typeof b?.error === "object" && b.error?.message) return b.error.message;
    return tr("machine refused ({0})", e.status);
  }
  return tr("the machine is not responding");
}

const PRESET_LABEL: Record<string, string> = { gmail: "Gmail", icloud: "iCloud", infomaniak: "Infomaniak", fastmail: "Fastmail" };
const presetLabel = (p: string): string | undefined => (p === "custom" ? tr("Other server (IMAP/SMTP)") : PRESET_LABEL[p]);

export function LocalMailbox({ client, toast }: { client: NokkerClient; toast: Toast }): React.ReactElement | null {
  const [card, setCard] = useState<LocalMailCard | null>(null);
  const [presets, setPresets] = useState<string[]>([]);
  const [names, setNames] = useState<string[] | null>(null);
  const [absent, setAbsent] = useState(false);
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState("gmail");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    try {
      const l = await client.listLocalConnectors();
      setCard(l.connectors.find((c) => c.kind === "mail") ?? { kind: "mail", state: "absent", locality: "local" });
      setPresets(l.presets.mail);
      setAbsent(false);
    } catch (e) {
      if (e instanceof NokkerApiError && e.status === 404) setAbsent(true); // connecteurs locaux non pris en charge
      else setError(mailError(e));
    }
    try {
      setNames((await client.listLocalSecrets()).secrets.map((s) => s.name));
    } catch {
      setNames(null); // coffre illisible : le nom se tape à la main
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);

  if (absent) return null;
  if (!card)
    return error ? (
      <div className="machine-section local-mail">
        <h2>{tr("The machine's mailbox")}</h2>
        <p className="error" role="alert">
          {error}
        </p>
        <button type="button" className="btn" onClick={() => (setError(null), void load())}>
          {tr("Retry")}
        </button>
      </div>
    ) : null;
  const linked = card.state !== "absent";
  const s = card.settings ?? {};

  const save = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const get = (k: string): string => String(d.get(k) ?? "").trim();
    const settings: MailSettings =
      preset === "custom"
        ? { preset: "custom", address: get("address"), ...(get("username") ? { username: get("username") } : {}), imap_host: get("imap_host"), imap_port: Number(get("imap_port")), smtp_host: get("smtp_host"), smtp_port: Number(get("smtp_port")) }
        : { preset, address: get("address"), ...(get("username") ? { username: get("username") } : {}) };
    setBusy("save");
    setError(null);
    try {
      const c = await client.putLocalMail({ settings, secret: get("secret") });
      setCard(c);
      setOpen(false);
      toast(c.message ? tr("Mailbox linked: {0}.", c.message) : tr("Mailbox linked."), "ok");
    } catch (er) {
      setError(mailError(er));
    } finally {
      setBusy(null);
    }
  };
  const test = async (): Promise<void> => {
    setBusy("test");
    setError(null);
    try {
      const r = await client.testLocalMail();
      if (r.ok) toast(tr("Mailbox verified: {0}.", r.message), "ok");
      else setError((r.code && codeText(r.code)) || r.message);
      await load();
    } catch (er) {
      setError(mailError(er));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (): Promise<void> => {
    setBusy("remove");
    setConfirm(false);
    try {
      await client.deleteLocalMail();
      toast(tr("Mailbox removed from the machine. If a mailbox is linked on nokker.ai, its tools take over again."), "ok");
      await load();
    } catch (er) {
      setError(mailError(er));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="machine-section local-mail">
      <h2>{tr("The machine's mailbox")}</h2>
      <p className="fine">
        {tr(
          "A mailbox linked here stays on the machine: its messages never go through nokker.ai, and turns that read it do not go to the mirror. Sending or moving to trash always needs your approval (strong card). If a mailbox is also linked on nokker.ai, your sessions use the machine's.",
        )}
      </p>
      {linked ? (
        <div className="local-mail-card">
          <p>
            <strong>{String(s.address ?? "")}</strong> <span className={`chip ${card.state === "ok" ? "role-member" : ""}`}>{card.state === "ok" ? tr("verified") : tr("not verified yet")}</span> <span className="chip">{tr("stays on the machine")}</span>
          </p>
          <p className="fine">
            {presetLabel(String(s.preset)) ?? String(s.preset ?? "")} · IMAP <code>{String(s.imap_host ?? "")}</code> · SMTP <code>{String(s.smtp_host ?? "")}</code>
            {s.username && s.username !== s.address ? (
              <>
                {" "}
                · {tr("user")} <code>{String(s.username)}</code>
              </>
            ) : null}
          </p>
          <p className="fine">
            {tr("Password: vault secret")} <code>{card.secret ?? "—"}</code>
            {card.last_ok_at ? tr(" · last successful test on {0}", new Date(card.last_ok_at).toLocaleString(shellLang() === "fr" ? "fr-CH" : "en-GB")) : ""}
          </p>
        </div>
      ) : (
        <p className="fine">{tr("No mailbox linked to the machine.")}</p>
      )}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {!open ? (
        <span className="team-row-actions">
          <button type="button" className="btn" disabled={busy !== null} onClick={() => (setOpen(true), setError(null), setPreset(String(s.preset ?? presets[0] ?? "gmail")), void load())}>
            {linked ? tr("Edit") : tr("Link a mailbox")}
          </button>
          {linked ? (
            <>
              <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => void test()}>
                {busy === "test" ? tr("Testing…") : tr("Test")}
              </button>
              {confirm ? (
                <>
                  <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => void remove()}>
                    {tr("Yes, remove")}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setConfirm(false)}>
                    {tr("Cancel")}
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => setConfirm(true)}>
                  {tr("Remove")}
                </button>
              )}
            </>
          ) : null}
        </span>
      ) : (
        <form className="secret-form local-mail-form" autoComplete="off" onSubmit={(e) => void save(e)}>
          <label htmlFor="lm-preset">{tr("Provider")}</label>
          <select id="lm-preset" value={preset} onChange={(e) => setPreset(e.target.value)}>
            {[...presets, "custom"].map((p) => (
              <option key={p} value={p}>
                {presetLabel(p) ?? p}
              </option>
            ))}
          </select>
          <label htmlFor="lm-address">{tr("Address")}</label>
          <input id="lm-address" name="address" type="email" required autoCapitalize="none" spellCheck={false} defaultValue={linked ? String(s.address ?? "") : ""} />
          <label htmlFor="lm-user">{tr("User")}</label>
          <input id="lm-user" name="username" autoCapitalize="none" spellCheck={false} placeholder={tr("the address, by default")} defaultValue={linked && s.username !== s.address ? String(s.username ?? "") : ""} />
          {preset === "custom" ? (
            <>
              <label htmlFor="lm-imap">{tr("IMAP server")}</label>
              <input id="lm-imap" name="imap_host" required autoCapitalize="none" spellCheck={false} defaultValue={linked ? String(s.imap_host ?? "") : ""} />
              <label htmlFor="lm-imap-port">{tr("IMAP port")}</label>
              <select id="lm-imap-port" name="imap_port" defaultValue="993">
                <option value="993">993 (TLS)</option>
                <option value="143">143 (STARTTLS)</option>
              </select>
              <label htmlFor="lm-smtp">{tr("SMTP server")}</label>
              <input id="lm-smtp" name="smtp_host" required autoCapitalize="none" spellCheck={false} defaultValue={linked ? String(s.smtp_host ?? "") : ""} />
              <label htmlFor="lm-smtp-port">{tr("SMTP port")}</label>
              <select id="lm-smtp-port" name="smtp_port" defaultValue="587">
                <option value="465">465 (TLS)</option>
                <option value="587">587 (STARTTLS)</option>
              </select>
            </>
          ) : null}
          <label htmlFor="lm-secret">{tr("Password (vault secret)")}</label>
          {names === null ? (
            <input id="lm-secret" name="secret" required autoCapitalize="none" spellCheck={false} placeholder={tr("secret NAME")} aria-describedby="lm-secret-tip" />
          ) : names.length ? (
            <select id="lm-secret" name="secret" required defaultValue={card.secret ?? ""} aria-describedby="lm-secret-tip">
              <option value="" disabled>
                {tr("choose a name…")}
              </option>
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          ) : (
            <p id="lm-secret" className="fine">
              {tr("The vault is empty.")}
            </p>
          )}
          <p id="lm-secret-tip" className="fine local-mail-tip">
            {tr("The password is never typed here: store it first in the vault above (or")} <code>nokker secret set NAME</code>
            {tr("), then choose its name. For Gmail and iCloud, an app password.")}
          </p>
          <span className="team-row-actions local-mail-actions">
            <button type="submit" className="btn btn-brass" disabled={busy !== null || names?.length === 0}>
              {busy === "save" ? tr("Testing the mailbox…") : tr("Test and link")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => (setOpen(false), setError(null))}>
              {tr("Cancel")}
            </button>
          </span>
        </form>
      )}
    </div>
  );
}
