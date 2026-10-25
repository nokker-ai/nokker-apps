import React, { useCallback, useEffect, useRef, useState } from "react";
import { NokkerApiError, type Agent, type AgentRun, type AgentStatus, type NokkerClient } from "@nokker-apps/sdk";
import { AGENT_STATUS_THEME } from "@nokker-apps/brand";
import { Icon } from "../icons.js";
import { RUN_STATUS_LABEL, mergeRun, runActive, runCost, runDuration, shortDate, triggerLabel } from "../crew/model.js";
import { MachinesDeck } from "../crew/MachinesDeck.js";

const COLUMNS: AgentStatus[] = ["running", "armed", "paused", "failed"];

function ago(iso: string | null | undefined): string {
  if (!iso) return "jamais lancé";
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `il y a ${h} h` : `il y a ${Math.round(h / 24)} j`;
}

const themeVars = (st: AgentStatus): React.CSSProperties => {
  const th = AGENT_STATUS_THEME[st];
  return { "--s-l": th.light, "--srgb-l": th.lightRgb, "--s-d": th.color, "--srgb-d": th.rgb } as React.CSSProperties;
};

export interface CrewProps {
  agents: Agent[];
  freshId: string | null;
  client: NokkerClient;
  /** Dernier passage reçu par événement, par agent (§9.5 `agent.run`). */
  agentRuns: Record<string, AgentRun>;
  onOpenThread(threadId: string): void;
  toast(text: string, tone?: "ok" | "error"): void;
}

/** Onglet Crew — un deck (X14, BUBBLES.md §9.5) : une carte par agent, couleur ET libellé d'état, déclencheur et
 * dernier passage lisibles ; la carte respire quand un passage tourne. Clic = popout (actions, Réglages, Passage
 * en cours, Passages) au-dessus du deck. Le clic de l'humain EST la décision : seul « Armer » avec une écriture
 * levée demande une carte forte. */
export function CrewTab(props: CrewProps): React.ReactElement {
  const { agents, freshId, agentRuns } = props;
  const [openId, setOpenId] = useState<string | null>(null);
  const open = agents.find((a) => a.id === openId) ?? null;
  // X15 : la vue « toutes les machines » n'existe que si nokker.ai sert le deck (drapeau `cloud_link.crew`, sinon 404).
  const [deckAvailable, setDeckAvailable] = useState(false);
  const [view, setView] = useState<"agents" | "machines">("agents");
  useEffect(() => {
    let live = true;
    props.client.getDeck().then(
      () => live && setDeckAvailable(true),
      () => live && setDeckAvailable(false),
    );
    return () => {
      live = false;
    };
  }, [props.client]);
  const deckTick = agents.map((a) => `${a.id}:${a.status}:${a.placement?.machine ?? ""}`).join("|") + Object.keys(agentRuns).length;
  useEffect(() => {
    if (openId && !open) setOpenId(null); // supprimé (ici ou ailleurs)
  }, [openId, open]);
  return (
    <section className="crew" aria-label="Crew — agents">
      <header className="crew-head">
        <h2>Crew</h2>
        <span className="fine">Une carte par agent. Bleu : au repos · vert : armé · orange : en marche · rouge : en échec.</span>
        {deckAvailable ? (
          <div className="crew-views" role="tablist" aria-label="Vue du Crew">
            <button type="button" role="tab" aria-selected={view === "agents"} className={`tab ${view === "agents" ? "on" : ""}`} onClick={() => setView("agents")}>
              Par état
            </button>
            <button type="button" role="tab" aria-selected={view === "machines"} className={`tab ${view === "machines" ? "on" : ""}`} onClick={() => setView("machines")}>
              Toutes les machines
            </button>
          </div>
        ) : null}
      </header>
      {view === "machines" && deckAvailable ? <MachinesDeck client={props.client} tick={deckTick} toast={props.toast} /> : null}
      {view === "machines" && deckAvailable ? null : (
      <div className="deck">
        {COLUMNS.map((st) => {
          const th = AGENT_STATUS_THEME[st];
          const list = agents.filter((a) => a.status === st);
          return (
            <div key={st} className="deck-col" style={themeVars(st)}>
              <h3 className="deck-col-title">
                <span className="state-dot" aria-hidden="true" />
                {th.label}
                <span className="count">{list.length}</span>
              </h3>
              {list.map((a) => {
                const live = agentRuns[a.id];
                const waiting = live?.status === "waiting_approval";
                return (
                  <button
                    key={a.id}
                    type="button"
                    className={`agent-card s-${a.status} ${a.id === freshId ? "fresh" : ""}`}
                    onClick={() => setOpenId(a.id)}
                    aria-haspopup="dialog"
                    aria-label={`Agent ${a.name}, ${th.label}${waiting ? ", attend ton feu vert" : ""}`}
                  >
                    <span className="agent-top">
                      <Icon name="bot" size={18} />
                      <span className="agent-card-name">{a.name}</span>
                    </span>
                    <span className="agent-role">{a.role}</span>
                    {a.origin?.pack ? <span className="agent-origin">depuis le pack « {a.origin.pack} »</span> : null}
                    <span className="agent-trigger">
                      <Icon name="timer" size={13} />
                      <span>
                        {triggerLabel(a.trigger)}
                        {a.next_run_at ? ` · prochain ${shortDate(a.next_run_at)}` : ""}
                      </span>
                    </span>
                    {waiting ? <span className="agent-waiting">Attend ton feu vert</span> : null}
                    {a.arm_approval_id ? <span className="agent-waiting">Armement à signer</span> : null}
                    <span className="agent-meta">
                      <span className="mono">{a.model}</span>
                      <span>{a.last_run ? `${RUN_STATUS_LABEL[a.last_run.status]} ${ago(a.last_run.ended_at)}` : "jamais lancé"}</span>
                    </span>
                    <span className="tools">
                      {a.tools.slice(0, 4).map((t) => (
                        <span key={t} className="chip">
                          {t}
                        </span>
                      ))}
                    </span>
                  </button>
                );
              })}
              {list.length === 0 ? <span className="fine deck-empty">Aucun agent</span> : null}
            </div>
          );
        })}
      </div>
      )}
      {open ? <AgentPopout {...props} agent={open} onClose={() => setOpenId(null)} /> : null}
    </section>
  );
}

function errText(e: unknown): string {
  if (e instanceof NokkerApiError) {
    const m = (e.body as { error?: { message?: string } } | undefined)?.error?.message;
    return m ?? `refus du serveur (${e.status})`;
  }
  return "le serveur ne répond pas";
}

function AgentPopout({ agent, client, agentRuns, onOpenThread, toast, onClose }: CrewProps & { agent: Agent; onClose: () => void }): React.ReactElement {
  const [tab, setTab] = useState<"settings" | "current" | "past">("settings");
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [more, setMore] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const th = AGENT_STATUS_THEME[agent.status];

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("[role=tab]")?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const loadRuns = useCallback(
    async (before?: string) => {
      try {
        const page = await client.listAgentRuns(agent.id, { limit: 10, before });
        setRuns((cur) => (before && cur ? [...cur, ...page.runs] : page.runs));
        setMore(page.next_before);
      } catch {
        setRuns((cur) => cur ?? []);
      }
    },
    [client, agent.id],
  );
  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  // Passage reçu en direct : fusionné dans la liste, sans recharger.
  const live = agentRuns[agent.id];
  useEffect(() => {
    if (live) setRuns((cur) => mergeRun(cur ?? [], live));
  }, [live]);

  const act = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    setBusy(true);
    try {
      const r = await fn();
      if (r && typeof r === "object" && "approval_id" in r) toast("Carte forte envoyée : approuve depuis ton appareil pour armer l'agent.", "ok");
      else if (ok) toast(ok, "ok");
    } catch (e) {
      toast(`Action refusée : ${errText(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const current = runs?.find(runActive) ?? null;
  const running = agent.status === "running";

  return (
    <div className="popout-backdrop" onClick={onClose}>
      <div
        className="popout"
        role="dialog"
        aria-modal="true"
        aria-label={`Agent ${agent.name}`}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
        style={themeVars(agent.status)}
      >
        <header className="popout-head">
          <Icon name="bot" size={20} />
          <h3>{agent.name}</h3>
          <span className="state-label">{th.label}</span>
          <button type="button" className="icon-btn" aria-label="Fermer" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="crew-actions">
          <button type="button" className="btn btn-brass" disabled={busy || running} onClick={() => void act(() => client.runAgent(agent.id), "Passage lancé.")}>
            <Icon name="play" /> Lancer maintenant
          </button>
          {agent.status === "paused" ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void act(() => client.armAgent(agent.id))}>
              {agent.arm_approval_id ? "Renvoyer la carte d'armement" : "Armer"}
            </button>
          ) : (
            <button type="button" className="btn" disabled={busy} onClick={() => void act(() => client.disarmAgent(agent.id))}>
              Désarmer
            </button>
          )}
          {confirmDelete ? (
            <>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void act(() => client.deleteAgent(agent.id), `Agent « ${agent.name} » supprimé.`)}>
                Oui, supprimer
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
                Annuler
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(true)}>
              Supprimer
            </button>
          )}
        </div>
        {confirmDelete ? <p className="fine crew-confirm">Les fils des passages restent ; un passage en cours est annulé d'abord.</p> : null}
        {agent.arm_approval_id ? (
          <p className="fine crew-confirm">Armement en attente : une carte forte est partie sur ton téléphone (règle d'écriture à approuver).</p>
        ) : null}
        {agent.status === "failed" ? <p className="fine crew-confirm">Le dernier passage a échoué ; l'agent reste armé (« Désarmer » arrête ses échéances).</p> : null}
        <div className="tabs" role="tablist" aria-label="Détails de l'agent">
          {(
            [
              ["settings", "Réglages"],
              ["current", "Passage en cours"],
              ["past", "Passages"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={`tab ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="popout-body" role="tabpanel">
          {tab === "settings" ? (
            <dl className="agent-grid">
              <dt>Mission</dt>
              <dd>{agent.instructions || agent.role}</dd>
              {agent.origin?.pack ? (
                <>
                  <dt>Origine</dt>
                  <dd>depuis le pack « {agent.origin.pack} » (modèle {agent.origin.template})</dd>
                </>
              ) : null}
              <dt>Déclencheur</dt>
              <dd>
                {triggerLabel(agent.trigger)}
                {agent.trigger?.kind === "schedule" ? <span className="fine"> ({agent.trigger.tz})</span> : null}
                {agent.next_run_at ? <span className="fine"> · prochain {shortDate(agent.next_run_at)}</span> : null}
              </dd>
              <dt>Modèle</dt>
              <dd className="mono">{agent.model || "par défaut"}</dd>
              <dt>Outils</dt>
              <dd className="tools">
                {agent.tools.map((t) => (
                  <span key={t} className="chip">
                    {t}
                  </span>
                ))}
              </dd>
              {agent.auto_approve?.length ? (
                <>
                  <dt>Sans carte</dt>
                  <dd className="tools">
                    {agent.auto_approve.map((r) => (
                      <span key={r} className="chip mono">
                        {r}
                      </span>
                    ))}
                  </dd>
                </>
              ) : null}
              {agent.secrets?.length ? (
                <>
                  <dt>Secrets</dt>
                  <dd className="tools">
                    {agent.secrets.map((s) => (
                      <span key={s} className="chip mono">
                        {s}
                      </span>
                    ))}
                  </dd>
                </>
              ) : null}
              {agent.budget ? (
                <>
                  <dt>Budget</dt>
                  <dd>
                    {agent.budget.max_calls} appels, {agent.budget.max_cost} {agent.budget.currency} par passage
                  </dd>
                </>
              ) : null}
              <dt>Créé</dt>
              <dd>{new Date(agent.created_at).toLocaleString("fr-CH")}</dd>
              {agent.trigger?.kind === "event" && agent.trigger.event.startsWith("webhook:") ? (
                <>
                  <dt>Webhook</dt>
                  <dd>
                    <WebhookKey client={client} agentId={agent.id} toast={toast} />
                  </dd>
                </>
              ) : null}
            </dl>
          ) : tab === "current" ? (
            current ? (
              <div className="run-current">
                <p>
                  <strong>{RUN_STATUS_LABEL[current.status]}</strong>
                  {current.started_at ? <span className="fine"> · depuis {shortDate(current.started_at)}</span> : null}
                </p>
                {current.status === "waiting_approval" ? <p className="fine">Une carte attend ta décision : elle est arrivée sur ton téléphone.</p> : null}
                <div className="crew-actions">
                  {current.thread_id ? (
                    <button type="button" className="btn" onClick={() => onOpenThread(current.thread_id!)}>
                      <Icon name="goto" /> Ouvrir le fil
                    </button>
                  ) : null}
                  <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void act(() => client.cancelAgentRun(agent.id, current.run_id), "Passage annulé.")}>
                    Annuler le passage
                  </button>
                </div>
              </div>
            ) : (
              <p className="fine">Aucun passage en cours.</p>
            )
          ) : runs === null ? (
            <p className="fine">Chargement…</p>
          ) : runs.length === 0 ? (
            <p className="fine">Aucun passage pour l'instant.</p>
          ) : (
            <>
              <ul className="run-list">
                {runs.map((r) => (
                  <li key={r.run_id} className={`run run-${r.status}`}>
                    <span className="run-status">
                      {RUN_STATUS_LABEL[r.status]}
                      {r.catch_up ? <span className="fine"> · rattrapage</span> : null}
                    </span>
                    <span className="fine">
                      {r.started_at ? shortDate(r.started_at) : r.scheduled_for ? `prévu ${shortDate(r.scheduled_for)}` : ""}
                      {runDuration(r) ? ` · ${runDuration(r)}` : ""}
                      {runCost(r) ? ` · ${runCost(r)}` : ""}
                    </span>
                    {r.event ? <span className="run-summary fine">Déclenché par {r.event}</span> : null}
                    {r.summary ? <span className="run-summary">{r.summary}</span> : null}
                    {r.thread_id ? (
                      <button type="button" className="btn btn-ghost run-open" onClick={() => onOpenThread(r.thread_id!)}>
                        Ouvrir le fil
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {more ? (
                <button type="button" className="btn btn-ghost" onClick={() => void loadRuns(more)}>
                  Plus anciens
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Clé du webhook d'un agent : rendue UNE seule fois par le noyau ; montrée ici le temps de la copier, jamais gardée. */
function WebhookKey({ client, agentId, toast }: { client: NokkerClient; agentId: string; toast: CrewProps["toast"] }): React.ReactElement {
  const [key, setKey] = useState<{ secret: string; url?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (key) {
    return (
      <span className="webhook-key">
        <code>{key.secret}</code>
        {key.url ? <span className="fine"> · {key.url}</span> : null}
        <span className="fine"> — visible une seule fois : copie-la maintenant.</span>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(key.secret).then(
              () => toast("Clé copiée.", "ok"),
              () => toast("Copie impossible : sélectionne la clé à la main.", "error"),
            );
          }}
        >
          Copier
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="btn btn-ghost"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        client.rotateAgentWebhookSecret(agentId).then(
          (k) => setKey(k),
          (e) => toast(`Clé refusée : ${errText(e)}`, "error"),
        ).finally(() => setBusy(false));
      }}
    >
      Nouvelle clé (l'ancienne cesse de marcher)
    </button>
  );
}
