/**
 * Onglet « Équipe » (X17, LOKKAL §7.15) : projets partagés entre comptes nokker.ai. Visible seulement quand
 * `GET /v1/projects` répond (drapeau `team` de nokker.ai). Des noms partout, jamais de valeur de secret : chaque membre
 * pose la sienne dans le coffre de sa machine. Les droits sont vérifiés par le noyau ; l'écran ne fait que griser.
 */
import React, { useCallback, useEffect, useState } from "react";
import type { Agent, MyInvitation, NokkerClient, Project, ProjectInvitation, ProjectMember, ProjectNote, ProjectRole, ProjectRules, ProjectSkill } from "@nokker-apps/sdk";
import { Icon } from "../icons.js";
import {
  GRANTABLE_ROLES,
  MODE_LABEL,
  ROLE_LABEL,
  abilities,
  badRules,
  budgetLabel,
  fmtWhen,
  parseRuleLines,
  teamError,
  validSecretName,
  validSkillName,
  validSkillSource,
} from "../team/model.js";

type Toast = (text: string, tone?: "ok" | "error") => void;

export function TeamTab({ client, toast, onInvitations }: { client: NokkerClient; toast: Toast; onInvitations?: (n: number) => void }): React.ReactElement {
  const [projects, setProjects] = useState<Project[] | null>(null);
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
      setSel((cur) => (cur && l.projects.some((p) => p.id === cur) ? cur : (l.projects[0]?.id ?? null)));
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
      toast(accept ? `Tu rejoins « ${iv.project.name} ».` : `Invitation à « ${iv.project.name} » déclinée.`, "ok");
      if (accept) setSel(iv.project.id);
      await load();
    } catch (e) {
      toast(teamError(e), "error");
    }
  };

  const current = projects?.find((p) => p.id === sel) ?? null;
  return (
    <section className="team-tab" aria-label="Équipe">
      <aside className="team-side">
        <h2>Projets</h2>
        {err ? (
          <p className="error" role="alert">
            {err}
          </p>
        ) : null}
        {projects === null ? (
          <p className="fine">Chargement…</p>
        ) : projects.length === 0 ? (
          <p className="fine">Aucun projet. Un projet partage des règles, des noms de secrets et un catalogue de skills avec d'autres comptes.</p>
        ) : (
          <ul className="team-list">
            {projects.map((p) => (
              <li key={p.id}>
                <button type="button" className={`team-item ${p.id === sel ? "on" : ""}`} aria-current={p.id === sel ? "true" : undefined} onClick={() => setSel(p.id)}>
                  <strong>{p.name}</strong>
                  <span className={`chip role-${p.role}`}>{ROLE_LABEL[p.role]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <CreateProject
          client={client}
          onCreated={(p) => {
            toast(`Projet « ${p.name} » créé.`, "ok");
            setSel(p.id);
            void load();
          }}
          toast={toast}
        />
        {invites.length ? (
          <div className="team-invites" aria-label="Invitations reçues">
            <h3>Invitations pour toi</h3>
            <ul className="team-list">
              {invites.map((iv) => (
                <li key={iv.id} className="team-invite">
                  <span>
                    <strong>{iv.project.name}</strong>
                    <span className="fine"> · {ROLE_LABEL[iv.role]} · jusqu'au {fmtWhen(iv.expires_at)}</span>
                  </span>
                  <span className="team-row-actions">
                    <button type="button" className="btn btn-brass" onClick={() => void answer(iv, true)}>
                      Rejoindre
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => void answer(iv, false)}>
                      Décliner
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </aside>
      <div className="team-main">
        {current ? (
          <ProjectView key={current.id} client={client} project={current} toast={toast} onChanged={() => void load()} onGone={() => { setSel(null); void load(); }} />
        ) : projects?.length ? (
          <p className="fine">Choisis un projet.</p>
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
      <input aria-label="Nom du nouveau projet" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Nouveau projet" />
      <button type="submit" className="btn" disabled={busy || !name.trim()}>
        <Icon name="plus" size={14} /> Créer
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
      toast(`Projet « ${p.name} » supprimé.`, "ok");
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
            Ton rôle : <strong>{ROLE_LABEL[p.role]}</strong> · budget {budgetLabel(p.budget)}
          </p>
        </div>
        {can.owner ? (
          confirmDel ? (
            <span className="team-row-actions">
              <button type="button" className="btn btn-danger" onClick={() => void del()}>
                Oui, tout supprimer
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmDel(false)}>
                Annuler
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDel(true)}>
              Supprimer le projet
            </button>
          )
        ) : null}
      </header>
      {p.repos.length ? (
        <section className="machine-section">
          <h3>Dépôts</h3>
          <ul className="secret-list">
            {p.repos.map((r) => (
              <li key={r.key}>
                <code>{r.key}</code>
              </li>
            ))}
          </ul>
          <p className="fine">Sur ta machine, une session ouverte dans l'un de ces dépôts reçoit les règles du projet.</p>
        </section>
      ) : null}
      <Members client={client} p={p} toast={toast} onLeft={onGone} />
      {can.owner ? <Invitations client={client} p={p} toast={toast} /> : null}
      <Rules client={client} p={p} toast={toast} onSaved={onChanged} />
      <Secrets client={client} p={p} toast={toast} />
      <Skills client={client} p={p} toast={toast} />
      <section className="machine-section">
        <h3>Mémoire commune</h3>
        <p className="fine">
          {p.mirror
            ? "En miroir : les notes apprises de portée projet (règles, retours, faits) passent par nokker.ai pour les membres abonnés. Les fichiers du dépôt ne voyagent pas."
            : "Les notes de projet restent sur les machines de chacun."}
        </p>
        {can.owner ? (
          <button type="button" className="btn" onClick={() => void setMirror(!p.mirror)}>
            {p.mirror ? "Arrêter le miroir" : "Mettre en miroir"}
          </button>
        ) : null}
        {p.mirror ? <Notes client={client} p={p} /> : null}
      </section>
      <MyAgents client={client} p={p} />
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
      <h3>Membres</h3>
      <ErrLine err={err} />
      {items ? (
        <ul className="team-members">
          {items.map((m) => (
            <li key={m.account_id}>
              <span className="team-member-mail">
                {m.email}
                {m.you ? <span className="fine"> (toi)</span> : null}
              </span>
              {owner && m.role !== "owner" ? (
                <select aria-label={`Rôle de ${m.email}`} value={m.role} onChange={(e) => void act(() => client.setProjectMemberRole(p.id, m.account_id, e.target.value as ProjectRole), `${m.email} : ${ROLE_LABEL[e.target.value as ProjectRole]}.`)}>
                  {GRANTABLE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              ) : (
                <span className={`chip role-${m.role}`}>{ROLE_LABEL[m.role]}</span>
              )}
              {owner && m.role !== "owner" ? (
                <button type="button" className="btn btn-ghost" onClick={() => void act(() => client.removeProjectMember(p.id, m.account_id), `${m.email} retiré du projet.`)}>
                  Retirer
                </button>
              ) : m.you && m.role !== "owner" ? (
                <button type="button" className="btn btn-ghost" onClick={() => void act(() => client.removeProjectMember(p.id, m.account_id), `Tu as quitté « ${p.name} ».`, onLeft)}>
                  Quitter
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="fine">Chargement…</p>
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
      toast(`Invitation posée pour ${email.trim()}.`, "ok");
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
      <h3>Inviter</h3>
      <p className="fine">Par l'adresse du compte nokker.ai. Aucun mail ne part : la personne voit l'invitation dans son onglet Équipe (valable 14 jours).</p>
      <ErrLine err={err} />
      <form
        className="team-inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) void invite();
        }}
      >
        <input type="email" aria-label="Adresse à inviter" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="adresse@exemple.ch" autoComplete="off" />
        <select aria-label="Rôle proposé" value={role} onChange={(e) => setRole(e.target.value as ProjectRole)}>
          {GRANTABLE_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn-brass" disabled={busy || !ok}>
          Inviter
        </button>
      </form>
      {pending.length ? (
        <ul className="secret-list">
          {pending.map((iv) => (
            <li key={iv.id}>
              <code>{iv.email}</code>
              <span className="fine">
                {ROLE_LABEL[iv.role]} · jusqu'au {fmtWhen(iv.expires_at)}
              </span>
              <button type="button" className="btn btn-ghost" onClick={() => void revoke(iv)}>
                Révoquer
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
      toast("Règles du projet enregistrées.", "ok");
      setEditing(false);
      onSaved();
    } catch (e) {
      setErr(teamError(e));
    }
  };
  const r = p.rules;
  return (
    <section className="machine-section">
      <h3>Règles</h3>
      <p className="fine">Elles s'ajoutent à celles de ta machine et ne peuvent que restreindre : le mode le plus strict gagne, « demander » et « interdit » s'ajoutent.</p>
      {!editing ? (
        <>
          <dl className="team-rules">
            <dt>Mode</dt>
            <dd>{r.mode ? MODE_LABEL[r.mode] : "celui de ta machine"}</dd>
            <dt>Toujours demander</dt>
            <dd>{r.ask.length ? r.ask.map((x) => <code key={x}>{x}</code>) : <span className="fine">rien de plus</span>}</dd>
            <dt>Interdit</dt>
            <dd>{r.deny.length ? r.deny.map((x) => <code key={x}>{x}</code>) : <span className="fine">rien de plus</span>}</dd>
          </dl>
          {can ? (
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              Modifier
            </button>
          ) : null}
        </>
      ) : (
        <div className="team-rules-form">
          <label className="fine" htmlFor="tr-mode">
            Mode
          </label>
          <select id="tr-mode" value={mode ?? ""} onChange={(e) => setMode(e.target.value as ProjectRules["mode"] | "")}>
            <option value="">celui de ta machine</option>
            {(Object.keys(MODE_LABEL) as NonNullable<ProjectRules["mode"]>[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>
          <label className="fine" htmlFor="tr-ask">
            Toujours demander (une règle par ligne : <code>outil</code> ou <code>outil(motif)</code>)
          </label>
          <textarea id="tr-ask" rows={3} value={ask} onChange={(e) => setAsk(e.target.value)} spellCheck={false} placeholder="terminal(git push*)" />
          <label className="fine" htmlFor="tr-deny">
            Interdit
          </label>
          <textarea id="tr-deny" rows={3} value={deny} onChange={(e) => setDeny(e.target.value)} spellCheck={false} placeholder="terminal(rm -rf*)" />
          {bad.length ? <p className="error">Règle illisible : {bad.map((b) => <code key={b}>{b}</code>)}</p> : null}
          <ErrLine err={err} />
          <span className="team-row-actions">
            <button type="button" className="btn btn-brass" disabled={bad.length > 0} onClick={() => void save()}>
              Enregistrer
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>
              Annuler
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
      <h3>Secrets attendus</h3>
      <p className="fine">
        Des noms seulement. Chacun pose sa valeur sur sa machine (<code>nokker secret set NOM</code>) ; un agent du projet la désigne par <code>secret:NOM</code>.
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
                  Retirer
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : items ? (
        <p className="fine">Aucun nom déclaré.</p>
      ) : null}
      {can ? (
        <form
          className="team-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (validSecretName(name)) void add();
          }}
        >
          <input aria-label="Nom du secret" value={name} onChange={(e) => setName(e.target.value.trim())} placeholder="CLE_API_METEO" autoComplete="off" spellCheck={false} />
          <input aria-label="À quoi il sert" value={desc} maxLength={300} onChange={(e) => setDesc(e.target.value)} placeholder="à quoi il sert (facultatif)" />
          <button type="submit" className="btn" disabled={!validSecretName(name)}>
            Déclarer
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
      <h3>Catalogue de skills</h3>
      <p className="fine">Des sources, pas de contenu : chacun installe chez lui, après analyse et sous sa propre carte.</p>
      <ErrLine err={err} />
      {items?.length ? (
        <ul className="secret-list">
          {items.map((s) => (
            <li key={s.name}>
              <code>{s.name}</code>
              <span className="fine">
                {s.source}
                {s.requires_local ? " · machine seulement" : ""}
                {s.description ? ` · ${s.description}` : ""}
              </span>
              {can ? (
                <button type="button" className="btn btn-ghost" onClick={() => void rm(s.name)}>
                  Retirer
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : items ? (
        <p className="fine">Catalogue vide.</p>
      ) : null}
      {can ? (
        <form
          className="team-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) void add();
          }}
        >
          <input aria-label="Nom du skill" value={name} onChange={(e) => setName(e.target.value.trim().toLowerCase())} placeholder="revue-accessibilite" spellCheck={false} />
          <input aria-label="Source du skill" value={source} onChange={(e) => setSource(e.target.value)} placeholder="github:owner/repo/chemin" spellCheck={false} />
          <label className="fine team-check">
            <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} /> machine seulement
          </label>
          <button type="submit" className="btn" disabled={!ok}>
            Ajouter
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
        <p className="fine">Aucune note partagée pour l'instant.</p>
      ) : null}
    </>
  );
}

function MyAgents({ client, p }: { client: NokkerClient; p: Project }): React.ReactElement {
  const { items, err } = useList<Agent>(async () => (await client.listProjectAgents(p.id)).agents, [client, p.id]);
  return (
    <section className="machine-section">
      <h3>Mes agents du projet</h3>
      <ErrLine err={err} />
      {items?.length ? (
        <ul className="secret-list">
          {items.map((a) => (
            <li key={a.id}>
              <code>{a.name}</code>
              <span className="fine">{a.role}</span>
            </li>
          ))}
        </ul>
      ) : items ? (
        <p className="fine">{abilities(p.role).attachAgents ? "Aucun de tes agents n'est rattaché à ce projet." : "En lecture, tu ne rattaches pas d'agent."}</p>
      ) : null}
    </section>
  );
}
