/**
 * Réglages SSO du propriétaire (LOKKAL §7.24), dans l'onglet Équipe : connexions OIDC de son organisation,
 * `redirect_uri` à recopier chez le fournisseur, secret du client en écriture seule (le NOM est rangé ; la valeur part
 * au coffre du noyau et ne revient jamais), domaines prouvés par TXT, journal. Absent si nokker.ai n'a pas le drapeau
 * `sso` (404).
 */
import React, { useCallback, useEffect, useState } from "react";
import type { NokkerClient, SsoAuditEvent, SsoConnection, SsoConnectionInput, SsoTokenAuth } from "@nokker-apps/sdk";
import { Icon } from "../icons.js";
import "./sso.css";
import { fmtWhen, teamError } from "../team/model.js";
import { ssoErrorCode } from "./flow.js";
import { AUDIT_LABEL, SETTINGS_ERROR } from "./text.js";

type Toast = (text: string, tone?: "ok" | "error") => void;

export function settingsError(e: unknown): string {
  return SETTINGS_ERROR[ssoErrorCode(e)] ?? teamError(e);
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
      <strong>SSO de l'organisation</strong>
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
          <h2>SSO de l'organisation</h2>
          <p className="fine">
            Tes membres se connectent par le fournisseur d'identité de ton organisation (OIDC). Une adresse n'ouvre la connexion que si son domaine est prouvé ici. Chaque projet choisit ensuite
            sa connexion et ce que donnent les groupes (dans le projet, section « SSO »).
          </p>
        </div>
      </header>
      {err ? (
        <p className="error" role="alert">
          {err}
        </p>
      ) : null}
      {conns === null ? <p className="fine">Chargement…</p> : conns.map((c) => <ConnectionCard key={c.id} client={client} c={c} toast={toast} onChanged={replace} onGone={() => void load()} />)}
      <NewConnection
        client={client}
        toast={toast}
        onCreated={(c) => {
          toast(`Connexion « ${c.name} » créée. Pose maintenant la valeur du secret du client.`, "ok");
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
      <label htmlFor={`${idp}-name`}>Nom</label>
      <input id={`${idp}-name`} value={v.name} maxLength={80} onChange={f("name")} placeholder="Annuaire de l'équipe" />
      <label htmlFor={`${idp}-iss`}>Issuer</label>
      <input id={`${idp}-iss`} value={v.issuer} onChange={f("issuer")} placeholder="https://idp.example.com" spellCheck={false} />
      <label htmlFor={`${idp}-cid`}>client_id</label>
      <input id={`${idp}-cid`} value={v.client_id} onChange={f("client_id")} spellCheck={false} />
      <label htmlFor={`${idp}-sn`}>Nom du secret du client</label>
      <input id={`${idp}-sn`} value={v.client_secret_name} onChange={f("client_secret_name")} placeholder="SSO_CLIENT" spellCheck={false} />
      <label htmlFor={`${idp}-gc`}>Claim des groupes</label>
      <input id={`${idp}-gc`} value={v.groups_claim ?? "groups"} onChange={f("groups_claim")} spellCheck={false} />
      <label htmlFor={`${idp}-ta`}>Authentification au jeton</label>
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
        <Icon name="plus" size={14} /> Nouvelle connexion SSO
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
      <h3>Nouvelle connexion</h3>
      <ConnectionFields v={v} set={setV} idp="sso-new" />
      <p className="fine">Ici, seulement le NOM du secret. Sa valeur se pose ensuite, en écriture seule.</p>
      <span className="team-row-actions">
        <button type="submit" className="btn btn-brass" disabled={busy || !ok}>
          Créer
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          Annuler
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
      aria-label={`Copier ${label}`}
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(
          () => setDone(true),
          () => undefined,
        )
      }
    >
      {done ? "Copié" : "Copier"}
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
    <section className="machine-section sso-conn" aria-label={`Connexion ${c.name}`}>
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
              Modifier
            </button>
          )}
          {confirmDel ? (
            <>
              <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => void run("del", async () => (await client.deleteSsoConnection(c.id), toast(`Connexion « ${c.name} » supprimée.`, "ok"), onGone()))}>
                Oui, supprimer
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmDel(false)}>
                Annuler
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDel(true)}>
              Supprimer
            </button>
          )}
        </span>
      </header>
      {confirmDel ? <p className="fine">Supprimer retire aussi ses domaines, ses liens aux projets ({c.projects.length}) et la valeur du secret.</p> : null}

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
              Enregistrer
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEdit(null)}>
              Annuler
            </button>
          </span>
        </form>
      ) : null}

      <h4>Adresse de retour à déclarer chez le fournisseur</h4>
      <p className="sso-copy-row">
        <code>{c.redirect_uri}</code> <Copy text={c.redirect_uri} label="l'adresse de retour" />
      </p>

      <h4>Secret du client</h4>
      <p className="fine">
        Nom <code>{c.client_secret.name}</code> · {c.client_secret.set ? <span className="chip role-member">posé</span> : <span className="chip">absent : personne ne peut se connecter</span>}
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
            toast("Secret du client posé (il ne sera plus jamais affiché).", "ok");
            await refresh();
          });
        }}
      >
        <input type="password" aria-label="Valeur du secret du client" autoComplete="new-password" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={c.client_secret.set ? "Remplacer la valeur" : "Valeur du secret"} />
        <button type="submit" className="btn" disabled={busy !== null || !secret || secret !== secret.trim()}>
          Poser la valeur
        </button>
      </form>

      <h4>Domaines e-mail</h4>
      <p className="fine">Un domaine n'ouvre rien tant qu'il n'est pas prouvé : pose l'enregistrement TXT indiqué dans ta zone DNS, puis « Vérifier ».</p>
      {c.domains.length ? (
        <ul className="secret-list sso-domains">
          {c.domains.map((d) => (
            <li key={d.domain}>
              <div>
                <strong>{d.domain}</strong> {d.verified ? <span className="chip role-member">prouvé{d.verified_at ? ` le ${fmtWhen(d.verified_at)}` : ""}</span> : <span className="chip">à prouver</span>}
                {d.verified ? null : (
                  <p className="fine sso-copy-row">
                    TXT <code>{d.txt.name}</code> = <code>{d.txt.value}</code> <Copy text={d.txt.value} label={`la valeur TXT de ${d.domain}`} />
                  </p>
                )}
              </div>
              <span className="team-row-actions">
                {d.verified ? null : (
                  <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void run(`v:${d.domain}`, async () => (await client.verifySsoDomain(c.id, d.domain), toast(`${d.domain} est prouvé.`, "ok"), await refresh()))}>
                    {busy === `v:${d.domain}` ? "Vérification…" : "Vérifier"}
                  </button>
                )}
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy !== null} onClick={() => void run(`r:${d.domain}`, async () => (await client.removeSsoDomain(c.id, d.domain), await refresh()))}>
                  Retirer
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
        <input aria-label="Nouveau domaine e-mail" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" spellCheck={false} />
        <button type="submit" className="btn" disabled={busy !== null || !domain.trim()}>
          Ajouter
        </button>
      </form>

      <p className="fine">{c.projects.length ? `Liée à ${c.projects.length} projet(s).` : "Liée à aucun projet pour l'instant : choisis-la dans un projet (section « SSO »)."}</p>
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
      <summary>Journal</summary>
      {err ? <p className="error">{err}</p> : null}
      {events === null && !err ? <p className="fine">Chargement…</p> : null}
      {events?.length === 0 ? <p className="fine">Rien pour l'instant.</p> : null}
      {events?.length ? (
        <ul className="sso-audit-list">
          {events.map((e, i) => (
            <li key={i} className={e.event === "login_refused" ? "ko" : undefined}>
              <span className="fine">{e.at ? new Date(e.at).toLocaleString("fr-CH") : "—"}</span> <strong>{AUDIT_LABEL[e.event] ?? e.event}</strong>
              {e.email || e.account ? <span className="fine"> · {e.email || e.account}</span> : null}
              {auditDetail(e) ? <span className="fine"> · {auditDetail(e)}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
