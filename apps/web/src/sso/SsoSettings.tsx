/**
 * Réglages SSO du propriétaire (LOKKAL §7.24), dans l'onglet Équipe : connexions OIDC de son organisation,
 * `redirect_uri` à recopier chez le fournisseur, secret du client en écriture seule (le NOM est rangé ; la valeur part
 * au coffre du noyau et ne revient jamais), domaines prouvés par TXT, journal. Absent si nokker.ai n'a pas le drapeau
 * `sso` (404).
 */
import React, { useCallback, useEffect, useState } from "react";
import type { NokkerClient, SsoAuditEvent, SsoConnection, SsoConnectionInput, SsoTokenAuth } from "@nokker-apps/sdk";
import { shellLang, tr } from "../i18n/index.js";
import { Icon } from "../icons.js";
import "./sso.css";
import { fmtWhen, teamError } from "../team/model.js";
import { ssoErrorCode } from "./flow.js";
import { auditLabel, settingsError as settingsErrorText } from "./text.js";

type Toast = (text: string, tone?: "ok" | "error") => void;

export function settingsError(e: unknown): string {
  return settingsErrorText(ssoErrorCode(e)) ?? teamError(e);
}

/** Bouton d'entrée dans la colonne des projets ; rien si le SSO est éteint. */
export function SsoEntry({ client, on, onOpen }: { client: NokkerClient; on: boolean; onOpen: () => void }): React.ReactElement | null {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    client.listSsoConnections().then(
      () => live && setEnabled(true),
      () => live && setEnabled(false),
    );
    return () => {
      live = false;
    };
  }, [client]);
  if (!enabled) return null;
  return (
    <button type="button" className={`team-item sso-entry ${on ? "on" : ""}`} aria-current={on ? "true" : undefined} onClick={onOpen}>
      <strong>{tr("Organisation SSO")}</strong>
      <span className="chip">OIDC</span>
    </button>
  );
}

export function SsoSettings({ client, toast }: { client: NokkerClient; toast: Toast }): React.ReactElement {
  const [conns, setConns] = useState<SsoConnection[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setConns((await client.listSsoConnections()).connections);
      setErr(null);
    } catch (e) {
      setErr(settingsError(e));
      setConns((c) => c ?? []);
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  const replace = (c: SsoConnection): void => setConns((cur) => (cur ?? []).map((x) => (x.id === c.id ? c : x)));

  return (
    <div className="team-project sso-settings">
      <header className="team-head">
        <div>
          <h2>{tr("Organisation SSO")}</h2>
          <p className="fine">
            {tr(
              "Your members sign in through your organisation's identity provider (OIDC). An address only opens the sign-in if its domain is proven here. Each project then chooses its connection and what the groups grant (in the project, “SSO” section).",
            )}
          </p>
        </div>
      </header>
      {err ? (
        <p className="error" role="alert">
          {err}
        </p>
      ) : null}
      {conns === null ? <p className="fine">{tr("Loading…")}</p> : conns.map((c) => <ConnectionCard key={c.id} client={client} c={c} toast={toast} onChanged={replace} onGone={() => void load()} />)}
      <NewConnection
        client={client}
        toast={toast}
        onCreated={(c) => {
          toast(tr("Connection “{0}” created. Now set the client secret value.", c.name), "ok");
          setConns((cur) => [...(cur ?? []), c]);
        }}
      />
    </div>
  );
}

const EMPTY: SsoConnectionInput = { name: "", issuer: "https://", client_id: "", client_secret_name: "", groups_claim: "groups", token_auth: "client_secret_basic" };

function ConnectionFields({ v, set, idp }: { v: SsoConnectionInput; set: (v: SsoConnectionInput) => void; idp: string }): React.ReactElement {
  const f = (k: keyof SsoConnectionInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => set({ ...v, [k]: e.target.value });
  return (
    <div className="sso-grid">
      <label htmlFor={`${idp}-name`}>{tr("Name")}</label>
      <input id={`${idp}-name`} value={v.name} maxLength={80} onChange={f("name")} placeholder={tr("Team directory")} />
      <label htmlFor={`${idp}-iss`}>Issuer</label>
      <input id={`${idp}-iss`} value={v.issuer} onChange={f("issuer")} placeholder="https://idp.example.com" spellCheck={false} />
      <label htmlFor={`${idp}-cid`}>client_id</label>
      <input id={`${idp}-cid`} value={v.client_id} onChange={f("client_id")} spellCheck={false} />
      <label htmlFor={`${idp}-sn`}>{tr("Client secret name")}</label>
      <input id={`${idp}-sn`} value={v.client_secret_name} onChange={f("client_secret_name")} placeholder="SSO_CLIENT" spellCheck={false} />
      <label htmlFor={`${idp}-gc`}>{tr("Groups claim")}</label>
      <input id={`${idp}-gc`} value={v.groups_claim ?? "groups"} onChange={f("groups_claim")} spellCheck={false} />
      <label htmlFor={`${idp}-ta`}>{tr("Token authentication")}</label>
      <select id={`${idp}-ta`} value={v.token_auth ?? "client_secret_basic"} onChange={f("token_auth")}>
        {(["client_secret_basic", "client_secret_post"] as SsoTokenAuth[]).map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
    </div>
  );
}

function NewConnection({ client, toast, onCreated }: { client: NokkerClient; toast: Toast; onCreated: (c: SsoConnection) => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<SsoConnectionInput>(EMPTY);
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        <Icon name="plus" size={14} /> {tr("New SSO connection")}
      </button>
    );
  const ok = v.name.trim() && v.issuer.startsWith("https://") && v.issuer.length > 8 && v.client_id.trim() && v.client_secret_name.trim();
  return (
    <form
      className="machine-section"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          onCreated(await client.createSsoConnection({ ...v, name: v.name.trim(), client_id: v.client_id.trim(), client_secret_name: v.client_secret_name.trim() }));
          setV(EMPTY);
          setOpen(false);
        } catch (er) {
          toast(settingsError(er), "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>{tr("New connection")}</h3>
      <ConnectionFields v={v} set={setV} idp="sso-new" />
      <p className="fine">{tr("Only the secret NAME here. Its value is set afterwards, write-only.")}</p>
      <span className="team-row-actions">
        <button type="submit" className="btn btn-brass" disabled={busy || !ok}>
          {tr("Create")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          {tr("Cancel")}
        </button>
      </span>
    </form>
  );
}

function Copy({ text, label }: { text: string; label: string }): React.ReactElement {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost"
      aria-label={tr("Copy {0}", label)}
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(
          () => setDone(true),
          () => undefined,
        )
      }
    >
      {done ? tr("Copied") : tr("Copy")}
    </button>
  );
}

function ConnectionCard({ client, c, toast, onChanged, onGone }: { client: NokkerClient; c: SsoConnection; toast: Toast; onChanged: (c: SsoConnection) => void; onGone: () => void }): React.ReactElement {
  const [edit, setEdit] = useState<SsoConnectionInput | null>(null);
  const [secret, setSecret] = useState("");
  const [domain, setDomain] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast(settingsError(e), "error");
    } finally {
      setBusy(null);
    }
  };
  const refresh = async (): Promise<void> => onChanged(await client.getSsoConnection(c.id));
  const idp = `sso-${c.id}`;

  return (
    <section className="machine-section sso-conn" aria-label={tr("Connection {0}", c.name)}>
      <header className="team-head">
        <div>
          <h3>{c.name}</h3>
          <p className="fine">
            <code>{c.issuer}</code> · client_id <code>{c.client_id}</code> · <code>{c.id}</code>
          </p>
        </div>
        <span className="team-row-actions">
          {edit ? null : (
            <button type="button" className="btn btn-ghost" onClick={() => setEdit({ name: c.name, issuer: c.issuer, client_id: c.client_id, client_secret_name: c.client_secret.name, groups_claim: c.groups_claim, token_auth: c.token_auth })}>
              {tr("Edit")}
            </button>
          )}
          {confirmDel ? (
            <>
              <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => void run("del", async () => (await client.deleteSsoConnection(c.id), toast(tr("Connection “{0}” deleted.", c.name), "ok"), onGone()))}>
                {tr("Yes, delete")}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmDel(false)}>
                {tr("Cancel")}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDel(true)}>
              {tr("Delete")}
            </button>
          )}
        </span>
      </header>
      {confirmDel ? <p className="fine">{tr("Deleting also removes its domains, its links to projects ({0}) and the secret value.", c.projects.length)}</p> : null}

      {edit ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run("edit", async () => {
              onChanged(await client.patchSsoConnection(c.id, edit));
              setEdit(null);
            });
          }}
        >
          <ConnectionFields v={edit} set={setEdit} idp={idp} />
          <span className="team-row-actions">
            <button type="submit" className="btn btn-brass" disabled={busy !== null}>
              {tr("Save")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEdit(null)}>
              {tr("Cancel")}
            </button>
          </span>
        </form>
      ) : null}

      <h4>{tr("Return address to declare at the provider")}</h4>
      <p className="sso-copy-row">
        <code>{c.redirect_uri}</code> <Copy text={c.redirect_uri} label={tr("the return address")} />
      </p>

      <h4>{tr("Client secret")}</h4>
      <p className="fine">
        {tr("Name")} <code>{c.client_secret.name}</code> · {c.client_secret.set ? <span className="chip role-member">{tr("set")}</span> : <span className="chip">{tr("missing: nobody can sign in")}</span>}
      </p>
      <form
        className="team-inline-form"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          const value = secret;
          setSecret(""); // la valeur ne reste pas affichée
          void run("secret", async () => {
            await client.setSsoClientSecret(c.id, value);
            toast(tr("Client secret set (it will never be shown again)."), "ok");
            await refresh();
          });
        }}
      >
        <input type="password" aria-label={tr("Client secret value")} autoComplete="new-password" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={c.client_secret.set ? tr("Replace the value") : tr("Secret value")} />
        <button type="submit" className="btn" disabled={busy !== null || !secret || secret !== secret.trim()}>
          {tr("Set the value")}
        </button>
      </form>

      <h4>{tr("Email domains")}</h4>
      <p className="fine">{tr("A domain opens nothing until it is proven: set the TXT record shown in your DNS zone, then “Verify”.")}</p>
      {c.domains.length ? (
        <ul className="secret-list sso-domains">
          {c.domains.map((d) => (
            <li key={d.domain}>
              <div>
                <strong>{d.domain}</strong> {d.verified ? <span className="chip role-member">{d.verified_at ? tr("proven on {0}", fmtWhen(d.verified_at)) : tr("proven")}</span> : <span className="chip">{tr("to prove")}</span>}
                {d.verified ? null : (
                  <p className="fine sso-copy-row">
                    TXT <code>{d.txt.name}</code> = <code>{d.txt.value}</code> <Copy text={d.txt.value} label={tr("the TXT value of {0}", d.domain)} />
                  </p>
                )}
              </div>
              <span className="team-row-actions">
                {d.verified ? null : (
                  <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void run(`v:${d.domain}`, async () => (await client.verifySsoDomain(c.id, d.domain), toast(tr("{0} is proven.", d.domain), "ok"), await refresh()))}>
                    {busy === `v:${d.domain}` ? tr("Verifying…") : tr("Verify")}
                  </button>
                )}
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy !== null} onClick={() => void run(`r:${d.domain}`, async () => (await client.removeSsoDomain(c.id, d.domain), await refresh()))}>
                  {tr("Remove")}
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="team-inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          const v = domain.trim().toLowerCase();
          if (!v) return;
          void run("domain", async () => {
            await client.addSsoDomain(c.id, v);
            setDomain("");
            await refresh();
          });
        }}
      >
        <input aria-label={tr("New email domain")} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" spellCheck={false} />
        <button type="submit" className="btn" disabled={busy !== null || !domain.trim()}>
          {tr("Add")}
        </button>
      </form>

      <p className="fine">{c.projects.length ? tr("Linked to {0} project(s).", c.projects.length) : tr("Not linked to any project yet: choose it in a project (“SSO” section).")}</p>
      <Audit client={client} id={c.id} />
    </section>
  );
}

function auditDetail(e: SsoAuditEvent): string {
  const d = e.detail ?? {};
  const bits: string[] = [];
  if (typeof d.reason === "string") bits.push(d.reason);
  if (typeof d.domain === "string") bits.push(d.domain);
  if (typeof d.from === "string" || typeof d.to === "string") bits.push(`${d.from ?? "—"} → ${d.to ?? "—"}`);
  if (typeof d.role === "string") bits.push(d.role);
  if (typeof d.name === "string") bits.push(d.name);
  return bits.join(" · ");
}

function Audit({ client, id }: { client: NokkerClient; id: string }): React.ReactElement {
  const [events, setEvents] = useState<SsoAuditEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <details
      className="sso-audit"
      onToggle={(e) => {
        if (!(e.currentTarget as HTMLDetailsElement).open || events) return;
        client.getSsoAudit(id, 100).then(
          (r) => setEvents(r.events),
          (er: unknown) => setErr(settingsError(er)),
        );
      }}
    >
      <summary>{tr("Log")}</summary>
      {err ? <p className="error">{err}</p> : null}
      {events === null && !err ? <p className="fine">{tr("Loading…")}</p> : null}
      {events?.length === 0 ? <p className="fine">{tr("Nothing yet.")}</p> : null}
      {events?.length ? (
        <ul className="sso-audit-list">
          {events.map((e, i) => (
            <li key={i} className={e.event === "login_refused" ? "ko" : undefined}>
              <span className="fine">{e.at ? new Date(e.at).toLocaleString(shellLang() === "fr" ? "fr-CH" : "en-GB") : "—"}</span> <strong>{auditLabel(e.event)}</strong>
              {e.email || e.account ? <span className="fine"> · {e.email || e.account}</span> : null}
              {auditDetail(e) ? <span className="fine"> · {auditDetail(e)}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
