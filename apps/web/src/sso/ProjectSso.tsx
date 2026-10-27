/**
 * Section « SSO » d'un projet (propriétaire, LOKKAL §7.24) : la connexion, les groupes → rôles (jamais propriétaire :
 * il reste le créateur, et garde l'accès même en SSO obligatoire), et « SSO obligatoire » avec l'âge maximal de la
 * connexion. Et, pour un membre, le panneau d'un projet vu sans connexion SSO assez récente.
 */
import React, { useEffect, useState } from "react";
import { NokkerApiError, SSO_MAX_AGE, SSO_ROLES, type GatedProject, type NokkerClient, type SsoBinding, type SsoConnection, type SsoMapping } from "@nokker-apps/sdk";
import { shellLang, tr } from "../i18n/index.js";
import { Icon } from "../icons.js";
import { goSso } from "./browser.js";
import { cleanMappings, ssoErrorCode } from "./flow.js";
import { settingsError } from "./SsoSettings.js";
import { maxAgeChoices, maxAgeLabel, ssoRoleLabel, ssoText } from "./text.js";

type Toast = (text: string, tone?: "ok" | "error") => void;

export function ProjectSso({ client, projectId, toast }: { client: NokkerClient; projectId: string; toast: Toast }): React.ReactElement | null {
  const [conns, setConns] = useState<SsoConnection[] | null>(null);
  const [binding, setBinding] = useState<SsoBinding | null>(null);
  const [form, setForm] = useState<{ connection: string; mappings: SsoMapping[]; required: boolean; max_age_s: number } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      let list: SsoConnection[];
      try {
        list = (await client.listSsoConnections()).connections;
      } catch {
        return; // drapeau `sso` éteint : pas de section
      }
      let b: SsoBinding | null = null;
      try {
        b = await client.getProjectSso(projectId);
      } catch (e) {
        if (!(e instanceof NokkerApiError && e.status === 404)) {
          if (live) toast(settingsError(e), "error");
          return;
        }
      }
      if (!live) return;
      setConns(list);
      setBinding(b);
      setForm(b ? { connection: b.connection, mappings: b.mappings, required: b.required, max_age_s: b.max_age_s } : null);
    })();
    return () => {
      live = false;
    };
  }, [client, projectId, toast]);

  if (conns === null) return null;
  const startEdit = (): void => setForm({ connection: conns[0]?.id ?? "", mappings: [{ group: "", role: "member" }], required: false, max_age_s: SSO_MAX_AGE.default });
  const save = async (): Promise<void> => {
    if (!form) return;
    setBusy(true);
    try {
      const b = await client.putProjectSso(projectId, { connection: form.connection, mappings: cleanMappings(form.mappings), required: form.required, max_age_s: form.max_age_s });
      setBinding(b);
      setForm({ connection: b.connection, mappings: b.mappings, required: b.required, max_age_s: b.max_age_s });
      toast(tr("Project SSO saved: roles follow the groups at each person's next sign-in."), "ok");
    } catch (e) {
      toast(settingsError(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await client.deleteProjectSso(projectId);
      setBinding(null);
      setForm(null);
      toast(tr("SSO removed from this project. Memberships already granted stay."), "ok");
    } catch (e) {
      toast(settingsError(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="machine-section sso-project" aria-label={tr("Project SSO")}>
      <h3>SSO</h3>
      {!form ? (
        <>
          <p className="fine">{tr("No SSO: members join by invitation.")}</p>
          {conns.length ? (
            <button type="button" className="btn" onClick={startEdit}>
              {tr("Link an SSO connection")}
            </button>
          ) : (
            <p className="fine">{tr("First create a connection in “Organisation SSO”.")}</p>
          )}
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="sso-grid">
            <label htmlFor={`sso-c-${projectId}`}>{tr("Connection")}</label>
            <select id={`sso-c-${projectId}`} value={form.connection} onChange={(e) => setForm({ ...form, connection: e.target.value })}>
              {conns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.client_secret.set ? "" : tr(" (secret missing)")}
                </option>
              ))}
            </select>
          </div>
          <h4>{tr("Groups → roles")}</h4>
          <p className="fine">
            {tr(
              "At each sign-in, the highest role the groups grant. A member who came through SSO and no longer has any group is removed; a membership that came from an invitation is only touched if a group grants it a role.",
            )}
          </p>
          <ul className="sso-mappings">
            {form.mappings.map((m, i) => (
              <li key={i} className="team-inline-form">
                <input aria-label={tr("Group {0}", i + 1)} value={m.group} onChange={(e) => setForm({ ...form, mappings: form.mappings.map((x, j) => (j === i ? { ...x, group: e.target.value } : x)) })} placeholder={tr("group name")} spellCheck={false} />
                <select aria-label={tr("Role of group {0}", i + 1)} value={m.role} onChange={(e) => setForm({ ...form, mappings: form.mappings.map((x, j) => (j === i ? { ...x, role: e.target.value as SsoMapping["role"] } : x)) })}>
                  {SSO_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ssoRoleLabel(r)}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-sm btn-ghost" aria-label={tr("Remove group {0}", i + 1)} onClick={() => setForm({ ...form, mappings: form.mappings.filter((_, j) => j !== i) })}>
                  {tr("Remove")}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn-sm" onClick={() => setForm({ ...form, mappings: [...form.mappings, { group: "", role: "member" }] })}>
            <Icon name="plus" size={14} /> {tr("A group")}
          </button>
          <p className="fine">{tr("The owner role is never obtained through SSO.")}</p>
          <label className="team-check">
            <input type="checkbox" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} /> {tr("SSO required")}
          </label>
          {form.required ? (
            <div className="sso-grid">
              <label htmlFor={`sso-a-${projectId}`}>{tr("SSO sign-in valid for")}</label>
              <select id={`sso-a-${projectId}`} value={form.max_age_s} onChange={(e) => setForm({ ...form, max_age_s: Number(e.target.value) })}>
                {[...maxAgeChoices(), ...(maxAgeChoices().some((c) => c.s === form.max_age_s) ? [] : [{ s: form.max_age_s, label: maxAgeLabel(form.max_age_s) }])].map((c) => (
                  <option key={c.s} value={c.s}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <p className="fine">
            {form.required
              ? tr(
                  "Members (not you) can only open this project after an SSO sign-in less than {0} old; their linked machines and agents too. You keep control to fix the configuration.",
                  maxAgeLabel(form.max_age_s),
                )
              : tr("Members can also open this project through their usual sign-in.")}
          </p>
          <span className="team-row-actions">
            <button type="submit" className="btn btn-brass" disabled={busy || !form.connection}>
              {tr("Save")}
            </button>
            {binding ? (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void remove()}>
                {tr("Remove the SSO")}
              </button>
            ) : (
              <button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>
                {tr("Cancel")}
              </button>
            )}
          </span>
        </form>
      )}
    </section>
  );
}

/** Projet « SSO obligatoire » vu sans connexion SSO assez récente : le nom, et le chemin de connexion. */
export function SsoGate({ client, project: p }: { client: NokkerClient; project: GatedProject }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="team-project">
      <header className="team-head">
        <div>
          <h2>{p.name}</h2>
          <p className="fine">{tr("This project requires a recent sign-in through its organisation's SSO.")}</p>
        </div>
      </header>
      {err ? (
        <p className="error" role="alert">
          {err}
        </p>
      ) : null}
      <button
        type="button"
        className="btn btn-brass"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setErr(null);
          goSso(client, shellLang(), { connection: p.sso.connection }).catch((e: unknown) => {
            setErr(ssoText(shellLang(), ssoErrorCode(e)));
            setBusy(false);
          });
        }}
      >
        {busy ? tr("Redirecting…") : tr("Sign in with SSO")}
      </button>
    </div>
  );
}
