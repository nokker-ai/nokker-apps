/**
 * Onglet « Plan » (X18, LOKKAL §7.18.3) : visible seulement si `GET /v1/plan/cards` répond (drapeau `plan`). Arbre
 * objectif → lots → tâches ; l'avancement remonte (statut d'une mère calculé, en lecture seule) ; le but, les
 * contraintes et les décisions descendent vers les fils qui travaillent sur la carte. « Brief du matin » en tête.
 */
import React, { useCallback, useEffect, useState } from "react";
import { PLAN_KIND_LABEL, PLAN_STATUS_LABEL, type Agent, type NokkerClient, type PlanCard, type PlanCardStatus, type PlanContext } from "@nokker-apps/sdk";
import { Icon } from "../icons.js";
import { cronHuman, lines, opsError, planTree } from "../ops/model.js";

type Toast = (text: string, tone?: "ok" | "error") => void;
const STATUSES: PlanCardStatus[] = ["todo", "in_progress", "blocked", "done"];

export function PlanTab({ client, tick, toast, currentThread }: { client: NokkerClient; tick: number; toast: Toast; currentThread: { id: string; title: string } | null }): React.ReactElement {
  const [cards, setCards] = useState<PlanCard[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [err, setErr] = useState<string | null>(null);
  const [title, setTitle] = useState("");

  const load = useCallback(async () => {
    try {
      const l = (await client.listPlanCards()).cards;
      setCards(l);
      setErr(null);
      // Premier chargement : les racines dépliées.
      setOpen((cur) => (cur.size ? cur : new Set(l.filter((c) => !c.parent_id).map((c) => c.id))));
    } catch (e) {
      setErr(opsError(e));
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load, tick]);

  const addRoot = async (): Promise<void> => {
    try {
      const c = await client.createPlanCard({ title: title.trim() });
      setTitle("");
      setSel(c.id);
      await load();
    } catch (e) {
      toast(opsError(e), "error");
    }
  };

  const tree = cards ? planTree(cards) : null;
  const current = cards?.find((c) => c.id === sel) ?? null;
  const toggle = (id: string): void =>
    setOpen((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const row = (c: PlanCard): React.ReactElement => {
    const kids = tree!.kids(c);
    const isOpen = open.has(c.id);
    return (
      <li key={c.id}>
        <div className={`plan-row st-${c.status} ${sel === c.id ? "on" : ""}`}>
          {kids.length ? (
            <button type="button" className="icon-btn plan-fold" aria-expanded={isOpen} aria-label={`${isOpen ? "Replier" : "Déplier"} ${c.title}`} onClick={() => toggle(c.id)}>
              <Icon name={isOpen ? "chevronDown" : "arrowRight"} size={14} />
            </button>
          ) : (
            <span className="plan-fold" aria-hidden="true" />
          )}
          <button
            type="button"
            className="plan-pick"
            aria-current={sel === c.id ? "true" : undefined}
            aria-label={`${PLAN_KIND_LABEL[c.kind]} ${c.title}, ${PLAN_STATUS_LABEL[c.status]}${c.computed ? `, ${c.progress.done} sur ${c.progress.total} faites` : ""}`}
            onClick={() => setSel(c.id)}
          >
            <span className="plan-kind">{PLAN_KIND_LABEL[c.kind]}</span>
            <span className="plan-title">{c.title}</span>
            <span className={`plan-status st-${c.status}`}>{PLAN_STATUS_LABEL[c.status]}</span>
            {c.computed ? <Progress c={c} /> : null}
          </button>
        </div>
        {kids.length && isOpen ? <ul className="plan-tree">{kids.map(row)}</ul> : null}
      </li>
    );
  };

  return (
    <section className="ops-tab" aria-label="Plan">
      <Brief client={client} toast={toast} />
      <div className="ops-split">
        <div className="ops-list">
          {err ? (
            <p className="error" role="alert">
              {err}
            </p>
          ) : null}
          {tree === null ? <p className="fine">Chargement…</p> : tree.roots.length ? <ul className="plan-tree root">{tree.roots.map(row)}</ul> : <p className="fine">Aucun objectif. Commence par un but, découpe ensuite.</p>}
          <form
            className="team-inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (title.trim()) void addRoot();
            }}
          >
            <input aria-label="Nouvel objectif" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Nouvel objectif" />
            <button type="submit" className="btn" disabled={!title.trim()}>
              <Icon name="plus" size={14} /> Ajouter
            </button>
          </form>
        </div>
        <div className="ops-detail">
          {current ? (
            <CardView key={current.id} c={current} client={client} toast={toast} currentThread={currentThread} onChanged={() => void load()} onGone={() => (setSel(null), void load())} onPick={setSel} />
          ) : (
            <p className="fine">Choisis une carte.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function Progress({ c }: { c: PlanCard }): React.ReactElement {
  const pct = Math.round(c.progress.ratio * 100);
  return (
    <span className="plan-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${c.progress.done} sur ${c.progress.total} tâches faites`}>
      <span className="plan-progress-fill" style={{ width: `${pct}%` }} />
      <span className="plan-progress-n">
        {c.progress.done}/{c.progress.total}
      </span>
    </span>
  );
}

function CardView({
  c,
  client,
  toast,
  currentThread,
  onChanged,
  onGone,
  onPick,
}: {
  c: PlanCard;
  client: NokkerClient;
  toast: Toast;
  currentThread: { id: string; title: string } | null;
  onChanged: () => void;
  onGone: () => void;
  onPick: (id: string) => void;
}): React.ReactElement {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ title: c.title, intent: c.intent, constraints: c.constraints.join("\n"), decisions: c.decisions.join("\n") });
  const [child, setChild] = useState("");
  const [ctx, setCtx] = useState<PlanContext | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    try {
      await fn();
      if (ok) toast(ok, "ok");
      onChanged();
    } catch (e) {
      toast(opsError(e), "error");
    }
  };
  const working = !!currentThread && c.threads.includes(currentThread.id);
  return (
    <article className="plan-detail">
      <header className="team-head">
        <div>
          <span className="plan-kind">{PLAN_KIND_LABEL[c.kind]}</span>
          <h2>{c.title}</h2>
          {c.computed ? (
            <p className="fine">
              {PLAN_STATUS_LABEL[c.status]} (calculé) · {c.progress.done}/{c.progress.total} faites
              {c.progress.blocked ? ` · ${c.progress.blocked} bloquée(s)` : ""}
            </p>
          ) : null}
        </div>
        {!c.computed ? (
          <label className="fine plan-status-pick">
            Statut{" "}
            <select value={c.status} onChange={(e) => void run(() => client.patchPlanCard(c.id, { status: e.target.value as PlanCardStatus }))}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PLAN_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </header>
      {!edit ? (
        <>
          {c.intent ? <p>{c.intent}</p> : null}
          <dl className="team-rules">
            <dt>Contraintes</dt>
            <dd>{c.constraints.length ? <ul className="plan-bullets">{c.constraints.map((x) => <li key={x}>{x}</li>)}</ul> : <span className="fine">aucune</span>}</dd>
            <dt>Décisions</dt>
            <dd>{c.decisions.length ? <ul className="plan-bullets">{c.decisions.map((x) => <li key={x}>{x}</li>)}</ul> : <span className="fine">aucune</span>}</dd>
          </dl>
          <button type="button" className="btn" onClick={() => setEdit(true)}>
            Modifier
          </button>
        </>
      ) : (
        <div className="team-rules-form">
          <label className="fine" htmlFor="pc-title">
            Titre
          </label>
          <input id="pc-title" value={f.title} maxLength={200} onChange={(e) => setF({ ...f, title: e.target.value })} />
          <label className="fine" htmlFor="pc-intent">
            But
          </label>
          <textarea id="pc-intent" rows={2} value={f.intent} onChange={(e) => setF({ ...f, intent: e.target.value })} />
          <label className="fine" htmlFor="pc-cons">
            Contraintes (une par ligne)
          </label>
          <textarea id="pc-cons" rows={3} value={f.constraints} onChange={(e) => setF({ ...f, constraints: e.target.value })} />
          <label className="fine" htmlFor="pc-dec">
            Décisions (une par ligne)
          </label>
          <textarea id="pc-dec" rows={3} value={f.decisions} onChange={(e) => setF({ ...f, decisions: e.target.value })} />
          <span className="team-row-actions">
            <button
              type="button"
              className="btn btn-brass"
              disabled={!f.title.trim()}
              onClick={() => void run(() => client.patchPlanCard(c.id, { title: f.title.trim(), intent: f.intent.trim(), constraints: lines(f.constraints), decisions: lines(f.decisions) }), "Carte enregistrée : vaut dès le prochain appel du modèle.").then(() => setEdit(false))}
            >
              Enregistrer
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEdit(false)}>
              Annuler
            </button>
          </span>
        </div>
      )}

      <section className="machine-section">
        <h3>Travailler dessus</h3>
        {currentThread ? (
          working ? (
            <p className="fine">
              La session « {currentThread.title} » reçoit ce contexte.{" "}
              <button type="button" className="btn btn-ghost" onClick={() => void run(() => client.detachPlanThread(c.id, currentThread.id), "Session détachée de la carte.")}>
                Détacher
              </button>
            </p>
          ) : (
            <button type="button" className="btn btn-brass" onClick={() => void run(() => client.attachPlanThread(c.id, currentThread.id), `La session « ${currentThread.title} » travaille sur cette carte.`)}>
              Rattacher la session « {currentThread.title} »
            </button>
          )
        ) : (
          <p className="fine">Ouvre une session pour la rattacher.</p>
        )}
        {c.threads.length && !working ? <p className="fine">{c.threads.length} session(s) rattachée(s).</p> : null}
        <button type="button" className="btn btn-ghost" onClick={() => void client.getPlanContext(c.id).then(setCtx, (e) => toast(opsError(e), "error"))}>
          Voir ce que l'agent reçoit
        </button>
        {ctx ? (
          <pre className="plan-context" aria-label="Contexte transmis au modèle">
            {ctx.block}
          </pre>
        ) : null}
      </section>

      <section className="machine-section">
        <h3>Découper</h3>
        <form
          className="team-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (child.trim()) void run(() => client.createPlanCard({ title: child.trim(), parent_id: c.id })).then(() => setChild(""));
          }}
        >
          <input aria-label="Nouvelle carte fille" value={child} maxLength={200} onChange={(e) => setChild(e.target.value)} placeholder={c.kind === "goal" ? "Nouveau lot" : "Nouvelle tâche"} />
          <button type="submit" className="btn" disabled={!child.trim()}>
            <Icon name="plus" size={14} /> Ajouter
          </button>
        </form>
        {c.parent_id ? (
          <button type="button" className="btn btn-ghost" onClick={() => onPick(c.parent_id!)}>
            Remonter à la carte mère
          </button>
        ) : null}
        {confirmDel ? (
          <span className="team-row-actions">
            <button type="button" className="btn btn-danger" onClick={() => void client.deletePlanCard(c.id).then(onGone, (e) => toast(opsError(e), "error"))}>
              Oui, supprimer{c.children.length ? " (les filles remontent d'un cran)" : ""}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDel(false)}>
              Annuler
            </button>
          </span>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={() => setConfirmDel(true)}>
            Supprimer la carte
          </button>
        )}
      </section>
    </article>
  );
}

function Brief({ client, toast }: { client: NokkerClient; toast: Toast }): React.ReactElement {
  const [agent, setAgent] = useState<Agent | null | undefined>(undefined);
  const [cron, setCron] = useState("30 7 * * 1-5");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    client.getBrief().then(
      (r) => {
        setAgent(r.agent);
        if (r.agent?.trigger?.kind === "schedule") setCron(r.agent.trigger.cron);
      },
      () => setAgent(undefined),
    );
  }, [client]);
  if (agent === undefined) return <></>;
  const tz = agent?.trigger?.kind === "schedule" ? agent.trigger.tz : "Europe/Zurich";
  const set = async (on: boolean): Promise<void> => {
    setBusy(true);
    try {
      if (on) setAgent((await client.setBrief({ cron, tz })).agent);
      else {
        await client.deleteBrief();
        setAgent(null);
      }
      toast(on ? `Brief du matin : ${cronHuman(cron)}.` : "Brief du matin arrêté.", "ok");
    } catch (e) {
      toast(opsError(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="plan-brief">
      <label className="plan-brief-toggle">
        <input type="checkbox" checked={!!agent} disabled={busy} onChange={(e) => void set(e.target.checked)} />
        <strong>Brief du matin</strong>
      </label>
      <span className="fine">{agent ? `${cronHuman(cron)} (${tz}) · objectifs, blocages, incidents vivants, agenda` : "un résumé du plan chaque matin, dans une bulle"}</span>
      {agent ? (
        <span className="team-row-actions">
          <input aria-label="Horaire (cron)" className="plan-cron" value={cron} onChange={(e) => setCron(e.target.value)} spellCheck={false} />
          <button type="button" className="btn btn-ghost" disabled={busy || !cron.trim()} onClick={() => void set(true)}>
            Changer l'horaire
          </button>
        </span>
      ) : null}
    </div>
  );
}
