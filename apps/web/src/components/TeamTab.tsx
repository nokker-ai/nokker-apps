/**
 * Onglet « Équipe » (X17, LOKKAL §7.15) : projets partagés entre comptes nokker.ai. Visible seulement quand
 * `GET /v1/projects` répond (drapeau `team` de nokker.ai). Des noms partout, jamais de valeur de secret : chaque membre
 * pose la sienne dans le coffre de sa machine. Les droits sont vérifiés par le noyau ; l'écran ne fait que griser.
 */
import React, { useCallback, useEffect, useState } from "react";
import { isGatedProject, type Agent, type MyInvitation, type NokkerClient, type Project, type ProjectEntry, type ProjectInvitation, ProjectMember, type ProjectNote, type ProjectRole, type ProjectRules, type ProjectSkill } from "@nokker-apps/sdk";
import { Icon } from "../icons.js";
import { tr } from "../i18n/index.js";
import { ProjectSso, SsoGate } from "../sso/ProjectSso.js";
import { SsoEntry, SsoSettings } from "../sso/SsoSettings.js";
import { useSsoGuard } from "../sso/guard.js";
import { NotesHistory } from "../mirror/NotesHistory.js";
import { ProjectAgents, ProjectAudit, ProjectBudget } from "../project/ProjectExtras.js";
import {
  GRANTABLE_ROLES,
  RULE_MODES,
  abilities,
  badRules,
  budgetLabel,
  fmtWhen,
  modeLabel,
  parseRuleLines,
  roleLabel,
  teamError,
  validSecretName,
  validSkillName,
  validSkillSource,
} from "../team/model.js";

type Toast = (text: string, tone?: "ok" | "error") => void;

/** Une phrase traduite qui entoure des nœuds JSX : on traduit avec des repères, puis on coupe dessus. */
const SLOT = "\u0001";
function slots(text: string, ...nodes: React.ReactNode[]): React.ReactElement {
  return (
    <>
      {text.split(SLOT).map((s, i) => (
        <React.Fragment key={i}>
          {s}
          {nodes[i] ?? null}
        </React.Fragment>
      ))}
    </>
  );
}

export function TeamTab({ client: raw, toast, onInvitations }: { client: NokkerClient; toast: Toast; onInvitations?: (n: number) => void }): React.ReactElement {
  const client = useSsoGuard(raw, toast);
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null);
  const [invites, setInvites] = useState<MyInvitation[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, iv] = await Promise.all([client.listProjects(), client.listMyInvitations()]);
      setProjects(l.projects);
      setInvites(iv.invitations);
      onInvitations?.(iv.invitations.length);
      setErr(null);
      setSel((cur) => (cur && (cur === "sso" || l.projects.some((p) => p.id === cur)) ? cur : (l.projects[0]?.id ?? null)));
    } catch (e) {
      setErr(teamError(e));
    }
  }, [client, onInvitations]);
  useEffect(() => {
    void load();
  }, [load]);

  const answer = async (iv: MyInvitation, accept: boolean): Promise<void> => {
    try {
      await client.answerInvitation(iv.id, accept);
      toast(accept ? tr("You are joining “{0}”.", iv.project.name) : tr("Invitation to “{0}” declined.", iv.project.name), "ok");
      if (accept) setSel(iv.project.id);
      await load();
    } catch (e) {
      toast(teamError(e), "error");
    }
  };

  const current = projects?.find((p) => p.id === sel) ?? null;
  return (
    <section className="team-tab" aria-label={tr("Team")}>
      <aside className="team-side">
        <h2>{tr("Projects")}</h2>
        {err ? (
          <p className="error" role="alert">
            {err}
          </p>
        ) : null}
        {projects === null ? (
          <p className="fine">{tr("Loading…")}</p>
        ) : projects.length === 0 ? (
          <p className="fine">{tr("No projects. A project shares rules, secret names and a skills catalogue with other accounts.")}</p>
        ) : (
          <ul className="team-list">
            {projects.map((p) => (
              <li key={p.id}>
                <button type="button" className={`team-item ${p.id === sel ? "on" : ""}`} aria-current={p.id === sel ? "true" : undefined} onClick={() => setSel(p.id)}>
                  <strong>{p.name}</strong>
                  <span className={`chip role-${p.role}`}>{roleLabel(p.role)}</span>
                  {isGatedProject(p) ? <span className="chip">SSO</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
        <SsoEntry client={client} on={sel === "sso"} onOpen={() => setSel("sso")} />
        <CreateProject
          client={client}
          onCreated={(p) => {
            toast(tr("Project “{0}” created.", p.name), "ok");
            setSel(p.id);
            void load();
          }}
          toast={toast}
        />
        {invites.length ? (
          <div className="team-invites" aria-label={tr("Invitations received")}>
            <h3>{tr("Invitations for you")}</h3>
            <ul className="team-list">
              {invites.map((iv) => (
                <li key={iv.id} className="team-invite">
                  <span>
                    <strong>{iv.project.name}</strong>
                    <span className="fine"> · {tr("{0} · until {1}", roleLabel(iv.role), fmtWhen(iv.expires_at))}</span>
                  </span>
                  <span className="team-row-actions">
                    <button type="button" className="btn btn-brass" onClick={() => void answer(iv, true)}>
                      {tr("Join")}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => void answer(iv, false)}>
                      {tr("Decline")}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </aside>
      <div className="team-main">
        {sel === "sso" ? (
          <SsoSettings client={client} toast={toast} />
        ) : current && isGatedProject(current) ? (
          <SsoGate client={raw} project={current} />
        ) : current ? (
          <ProjectView key={current.id} client={client} project={current} toast={toast} onChanged={() => void load()} onGone={() => { setSel(null); void load(); }} />
        ) : projects?.length ? (
          <p className="fine">{tr("Pick a project.")}</p>
        ) : null}
      </div>
    </section>
  );
}

function CreateProject({ client, onCreated, toast }: { client: NokkerClient; onCreated: (p: Project) => void; toast: Toast }): React.ReactElement {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async (): Promise<void> => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      onCreated(await client.createProject({ name: name.trim() }));
      setName("");
    } catch (e) {
      toast(teamError(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="team-inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
    >
      <input aria-label={tr("Name of the new project")} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={tr("New project")} />
      <button type="submit" className="btn" disabled={busy || !name.trim()}>
        <Icon name="plus" size={14} /> {tr("Create")}
      </button>
    </form>
  );
}

function ProjectView({ client, project: p, toast, onChanged, onGone }: { client: NokkerClient; project: Project; toast: Toast; onChanged: () => void; onGone: () => void }): React.ReactElement {
  const can = abilities(p.role);
  const [confirmDel, setConfirmDel] = useState(false);
  const del = async (): Promise<void> => {
    try {
      await client.deleteProject(p.id);
      toast(tr("Project “{0}” deleted.", p.name), "ok");
      onGone();
    } catch (e) {
      toast(teamError(e), "error");
    }
  };
  const setMirror = async (on: boolean): Promise<void> => {
    try {
      await client.patchProject(p.id, { mirror: on });
      onChanged();
    } catch (e) {
      toast(teamError(e), "error");
    }
  };
  return (
    <div className="team-project">
      <header className="team-head">
        <div>
          <h2>{p.name}</h2>
          {p.description ? <p className="fine">{p.description}</p> : null}
          <p className="fine">
            {tr("Your role:")} <strong>{roleLabel(p.role)}</strong> · {tr("budget {0}", budgetLabel(p.budget))}
          </p>
        </div>
        {can.owner ? (
          confirmDel ? (
            <span className="team-row-actions">
              <button type="button" className="btn btn-danger" onClick={() => void del()}>
                {tr("Yes, delete everything")}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmDel(false)}>
                {tr("Cancel")}
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDel(true)}>
              {tr("Delete the project")}
            </button>
          )
        ) : null}
      </header>
      {p.repos.length ? (
        <section className="machine-section">
          <h3>{tr("Repositories")}</h3>
          <ul className="secret-list">
            {p.repos.map((r) => (
              <li key={r.key}>
                <code>{r.key}</code>
              </li>
            ))}
          </ul>
          <p className="fine">{tr("On your machine, a session opened in one of these repositories receives the project rules.")}</p>
        </section>
      ) : null}
      <Members client={client} p={p} toast={toast} onLeft={onGone} />
      {can.owner ? <Invitations client={client} p={p} toast={toast} /> : null}
      {can.owner ? <ProjectSso client={client} projectId={p.id} toast={toast} /> : null}
      <Rules client={client} p={p} toast={toast} onSaved={onChanged} />
      <Secrets client={client} p={p} toast={toast} />
      <Skills client={client} p={p} toast={toast} />
      <section className="machine-section">
        <h3>{tr("Shared memory")}</h3>
        <p className="fine">
          {p.mirror
            ? tr("Mirrored: project-scope learned notes (rules, feedback, facts) go through nokker.ai for subscribed members. Repository files do not travel.")
            : tr("Project notes stay on each member's machines.")}
        </p>
        {can.owner ? (
          <button type="button" className="btn" onClick={() => void setMirror(!p.mirror)}>
            {p.mirror ? tr("Stop mirroring") : tr("Mirror")}
          </button>
        ) : null}
        {p.mirror ? <Notes client={client} p={p} /> : null}
        {p.mirror && can.edit ? <NotesHistory client={client} projectId={p.id} toast={toast} /> : null}
      </section>
      <ProjectBudget client={client} p={p} toast={toast} onSaved={onChanged} />
      <ProjectAgents client={client} p={p} toast={toast} />
      <ProjectAudit client={client} p={p} />
    </div>
  );
}

function useList<T>(fetcher: () => Promise<T[]>, deps: unknown[]): { items: T[] | null; err: string | null; reload: () => Promise<void> } {
  const [items, setItems] = useState<T[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(async () => {
    try {
      setItems(await fetcher());
      setErr(null);
    } catch (e) {
      setErr(teamError(e));
      setItems((cur) => cur ?? []);
    }
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { items, err, reload };
}

function ErrLine({ err }: { err: string | null }): React.ReactElement | null {
  return err ? (
    <p className="error" role="alert">
      {err}
    </p>
  ) : null;
}

function Members({ client, p, toast, onLeft }: { client: NokkerClient; p: Project; toast: Toast; onLeft: () => void }): React.ReactElement {
  const { items, err, reload } = useList<ProjectMember>(async () => (await client.listProjectMembers(p.id)).members, [client, p.id]);
  const owner = p.role === "owner";
  const act = async (fn: () => Promise<unknown>, ok: string, after?: () => void): Promise<void> => {
    try {
      await fn();
      toast(ok, "ok");
      if (after) after();
      else await reload();
    } catch (e) {
      toast(teamError(e), "error");
    }
  };
  return (
    <section className="machine-section">
      <h3>{tr("Members")}</h3>
      <ErrLine err={err} />
      {items ? (
        <ul className="team-members">
          {items.map((m) => (
            <li key={m.account_id}>
              <span className="team-member-mail">
                {m.email}
                {m.you ? <span className="fine"> {tr("(you)")}</span> : null}
              </span>
              {owner && m.role !== "owner" ? (
                <select aria-label={tr("Role of {0}", m.email)} value={m.role} onChange={(e) => void act(() => client.setProjectMemberRole(p.id, m.account_id, e.target.value as ProjectRole), tr("{0}: {1}.", m.email, roleLabel(e.target.value as ProjectRole)))}>
                  {GRANTABLE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {roleLabel(r)}
                    </option>
                  ))}
                </select>
              ) : (
                <span className={`chip role-${m.role}`}>{roleLabel(m.role)}</span>
              )}
              {owner && m.role !== "owner" ? (
                <button type="button" className="btn btn-ghost" onClick={() => void act(() => client.removeProjectMember(p.id, m.account_id), tr("{0} removed from the project.", m.email))}>
                  {tr("Remove")}
                </button>
              ) : m.you && m.role !== "owner" ? (
                <button type="button" className="btn btn-ghost" onClick={() => void act(() => client.removeProjectMember(p.id, m.account_id), tr("You left “{0}”.", p.name), onLeft)}>
                  {tr("Leave")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="fine">{tr("Loading…")}</p>
      )}
    </section>
  );
}

function Invitations({ client, p, toast }: { client: NokkerClient; p: Project; toast: Toast }): React.ReactElement {
  const { items, err, reload } = useList<ProjectInvitation>(async () => (await client.listProjectInvitations(p.id)).invitations, [client, p.id]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ProjectRole>("member");
  const [busy, setBusy] = useState(false);
  const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const invite = async (): Promise<void> => {
    setBusy(true);
    try {
      await client.inviteToProject(p.id, email.trim(), role);
      toast(tr("Invitation sent to {0}.", email.trim()), "ok");
      setEmail("");
      await reload();
    } catch (e) {
      toast(teamError(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (iv: ProjectInvitation): Promise<void> => {
    try {
      await client.revokeProjectInvitation(p.id, iv.id);
      await reload();
    } catch (e) {
      toast(teamError(e), "error");
    }
  };
  const pending = items?.filter((iv) => iv.state === "pending") ?? [];
  return (
    <section className="machine-section">
      <h3>{tr("Invite")}</h3>
      <p className="fine">{tr("By nokker.ai account address. No email is sent: the person sees the invitation in their Team tab (valid for 14 days).")}</p>
      <ErrLine err={err} />
      <form
        className="team-inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) void invite();
        }}
      >
        <input type="email" aria-label={tr("Address to invite")} value={email} onChange={(e) => setEmail(e.target.value)} placeholder={tr("address@example.com")} autoComplete="off" />
        <select aria-label={tr("Proposed role")} value={role} onChange={(e) => setRole(e.target.value as ProjectRole)}>
          {GRANTABLE_ROLES.map((r) => (
            <option key={r} value={r}>
              {roleLabel(r)}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn-brass" disabled={busy || !ok}>
          {tr("Invite")}
        </button>
      </form>
      {pending.length ? (
        <ul className="secret-list">
          {pending.map((iv) => (
            <li key={iv.id}>
              <code>{iv.email}</code>
              <span className="fine">
                {tr("{0} · until {1}", roleLabel(iv.role), fmtWhen(iv.expires_at))}
              </span>
              <button type="button" className="btn btn-ghost" onClick={() => void revoke(iv)}>
                {tr("Revoke")}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Rules({ client, p, toast, onSaved }: { client: NokkerClient; p: Project; toast: Toast; onSaved: () => void }): React.ReactElement {
  const can = abilities(p.role).edit;
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<ProjectRules["mode"] | "">(p.rules.mode ?? "");
  const [ask, setAsk] = useState(p.rules.ask.join("\n"));
  const [deny, setDeny] = useState(p.rules.deny.join("\n"));
  const [err, setErr] = useState<string | null>(null);
  const bad = [...badRules(parseRuleLines(ask)), ...badRules(parseRuleLines(deny))];
  const save = async (): Promise<void> => {
    setErr(null);
    try {
      const rules: ProjectRules = { ask: parseRuleLines(ask), deny: parseRuleLines(deny), ...(mode ? { mode } : {}) };
      await client.putProjectRules(p.id, rules);
      toast(tr("Project rules saved."), "ok");
      setEditing(false);
      onSaved();
    } catch (e) {
      setErr(teamError(e));
    }
  };
  const r = p.rules;
  return (
    <section className="machine-section">
      <h3>{tr("Rules")}</h3>
      <p className="fine">{tr("They add to your machine's rules and can only restrict: the strictest mode wins, “ask” and “deny” lists add up.")}</p>
      {!editing ? (
        <>
          <dl className="team-rules">
            <dt>{tr("Mode")}</dt>
            <dd>{r.mode ? modeLabel(r.mode) : tr("your machine's")}</dd>
            <dt>{tr("Always ask")}</dt>
            <dd>{r.ask.length ? r.ask.map((x) => <code key={x}>{x}</code>) : <span className="fine">{tr("nothing more")}</span>}</dd>
            <dt>{tr("Denied")}</dt>
            <dd>{r.deny.length ? r.deny.map((x) => <code key={x}>{x}</code>) : <span className="fine">{tr("nothing more")}</span>}</dd>
          </dl>
          {can ? (
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              {tr("Edit")}
            </button>
          ) : null}
        </>
      ) : (
        <div className="team-rules-form">
          <label className="fine" htmlFor="tr-mode">
            {tr("Mode")}
          </label>
          <select id="tr-mode" value={mode ?? ""} onChange={(e) => setMode(e.target.value as ProjectRules["mode"] | "")}>
            <option value="">{tr("your machine's")}</option>
            {RULE_MODES.map((m) => (
              <option key={m} value={m}>
                {modeLabel(m)}
              </option>
            ))}
          </select>
          <label className="fine" htmlFor="tr-ask">
            {slots(tr("Always ask (one rule per line: {0} or {1})", SLOT, SLOT), <code>{tr("tool")}</code>, <code>{tr("tool(pattern)")}</code>)}
          </label>
          <textarea id="tr-ask" rows={3} value={ask} onChange={(e) => setAsk(e.target.value)} spellCheck={false} placeholder="terminal(git push*)" />
          <label className="fine" htmlFor="tr-deny">
            {tr("Denied")}
          </label>
          <textarea id="tr-deny" rows={3} value={deny} onChange={(e) => setDeny(e.target.value)} spellCheck={false} placeholder="terminal(rm -rf*)" />
          {bad.length ? <p className="error">{tr("Unreadable rule:")} {bad.map((b) => <code key={b}>{b}</code>)}</p> : null}
          <ErrLine err={err} />
          <span className="team-row-actions">
            <button type="button" className="btn btn-brass" disabled={bad.length > 0} onClick={() => void save()}>
              {tr("Save")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>
              {tr("Cancel")}
            </button>
          </span>
        </div>
      )}
    </section>
  );
}

function Secrets({ client, p, toast }: { client: NokkerClient; p: Project; toast: Toast }): React.ReactElement {
  const can = abilities(p.role).edit;
  const { items, err, reload } = useList(async () => (await client.listProjectSecrets(p.id)).secrets, [client, p.id]);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const add = async (): Promise<void> => {
    try {
      await client.putProjectSecret(p.id, name, desc.trim() || undefined);
      setName("");
      setDesc("");
      await reload();
    } catch (e) {
      toast(teamError(e), "error");
    }
  };
  const rm = async (n: string): Promise<void> => {
    try {
      await client.removeProjectSecret(p.id, n);
      await reload();
    } catch (e) {
      toast(teamError(e), "error");
    }
  };
  return (
    <section className="machine-section">
      <h3>{tr("Expected secrets")}</h3>
      <p className="fine">
        {slots(
          tr("Names only. Everyone sets their own value on their machine ({0}); a project agent refers to it as {1}.", SLOT, SLOT),
          <code>nokker secret set {tr("NAME")}</code>,
          <code>secret:{tr("NAME")}</code>,
        )}
      </p>
      <ErrLine err={err} />
      {items?.length ? (
        <ul className="secret-list">
          {items.map((s) => (
            <li key={s.name}>
              <code>{s.name}</code>
              {s.description ? <span className="fine">{s.description}</span> : null}
              {can ? (
                <button type="button" className="btn btn-ghost" onClick={() => void rm(s.name)}>
                  {tr("Remove")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : items ? (
        <p className="fine">{tr("No names declared.")}</p>
      ) : null}
      {can ? (
        <form
          className="team-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (validSecretName(name)) void add();
          }}
        >
          <input aria-label={tr("Secret name")} value={name} onChange={(e) => setName(e.target.value.trim())} placeholder={tr("WEATHER_API_KEY")} autoComplete="off" spellCheck={false} />
          <input aria-label={tr("What it is for")} value={desc} maxLength={300} onChange={(e) => setDesc(e.target.value)} placeholder={tr("what it is for (optional)")} />
          <button type="submit" className="btn" disabled={!validSecretName(name)}>
            {tr("Declare")}
          </button>
        </form>
      ) : null}
    </section>
  );
}

function Skills({ client, p, toast }: { client: NokkerClient; p: Project; toast: Toast }): React.ReactElement {
  const can = abilities(p.role).edit;
  const { items, err, reload } = useList<ProjectSkill>(async () => (await client.listProjectSkills(p.id)).skills, [client, p.id]);
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [local, setLocal] = useState(false);
  const ok = validSkillName(name) && validSkillSource(source.trim());
  const add = async (): Promise<void> => {
    try {
      await client.putProjectSkill(p.id, name, { source: source.trim(), requires_local: local });
      setName("");
      setSource("");
      setLocal(false);
      await reload();
    } catch (e) {
      toast(teamError(e), "error");
    }
  };
  const rm = async (n: string): Promise<void> => {
    try {
      await client.removeProjectSkill(p.id, n);
      await reload();
    } catch (e) {
      toast(teamError(e), "error");
    }
  };
  return (
    <section className="machine-section">
      <h3>{tr("Skills catalogue")}</h3>
      <p className="fine">{tr("Sources, not content: everyone installs on their side, after analysis and under their own card.")}</p>
      <ErrLine err={err} />
      {items?.length ? (
        <ul className="secret-list">
          {items.map((s) => (
            <li key={s.name}>
              <code>{s.name}</code>
              <span className="fine">
                {s.source}
                {s.requires_local ? ` · ${tr("machine only")}` : ""}
                {s.description ? ` · ${s.description}` : ""}
              </span>
              {can ? (
                <button type="button" className="btn btn-ghost" onClick={() => void rm(s.name)}>
                  {tr("Remove")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : items ? (
        <p className="fine">{tr("Empty catalogue.")}</p>
      ) : null}
      {can ? (
        <form
          className="team-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) void add();
          }}
        >
          <input aria-label={tr("Skill name")} value={name} onChange={(e) => setName(e.target.value.trim().toLowerCase())} placeholder={tr("accessibility-review")} spellCheck={false} />
          <input aria-label={tr("Skill source")} value={source} onChange={(e) => setSource(e.target.value)} placeholder={tr("github:owner/repo/path")} spellCheck={false} />
          <label className="fine team-check">
            <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} /> {tr("machine only")}
          </label>
          <button type="submit" className="btn" disabled={!ok}>
            {tr("Add")}
          </button>
        </form>
      ) : null}
    </section>
  );
}

function Notes({ client, p }: { client: NokkerClient; p: Project }): React.ReactElement {
  const { items, err } = useList<ProjectNote>(async () => (await client.listProjectNotes(p.id)).notes.filter((n) => !n.deleted), [client, p.id]);
  return (
    <>
      <ErrLine err={err} />
      {items?.length ? (
        <ul className="team-notes">
          {items.map((n) => (
            <li key={n.name}>
              <span className="chip">{n.kind}</span> <strong>{n.title ?? n.name}</strong>
              {n.text ? <p className="fine">{n.text}</p> : null}
            </li>
          ))}
        </ul>
      ) : items ? (
        <p className="fine">{tr("No shared notes yet.")}</p>
      ) : null}
    </>
  );
}

