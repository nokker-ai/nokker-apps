import React, { useCallback, useEffect, useRef, useState } from "react";
import { type Agent, type AgentRun, type AgentStatus, type NokkerClient } from "@nokker-apps/sdk";
import { AGENT_STATUS_THEME } from "@nokker-apps/brand";
import { Icon } from "../icons.js";
import { mergeRun, runActive, runCost, runDuration, runStatusLabel, shortDate, triggerLabel } from "../crew/model.js";
import { MachinesDeck } from "../crew/MachinesDeck.js";
import { MailWatchView, NewAgent, TriggerEdit, errorText } from "../crew/TriggerEditor.js";
import { m } from "../crew/mail.js";
import { cw, statusLabel, type Lang } from "../crew/i18n.js";
import { uiLang } from "./ConnectorsTab.js";

const COLUMNS: AgentStatus[] = ["running", "armed", "paused", "failed"];

function ago(lang: Lang, iso: string | null | undefined): string {
  if (!iso) return cw(lang, "neverRun");
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return cw(lang, "justNow");
  if (min < 60) return cw(lang, "agoMin", { n: min });
  const h = Math.round(min / 60);
  return h < 48 ? cw(lang, "agoH", { n: h }) : cw(lang, "agoD", { n: Math.round(h / 24) });
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
 * levée demande une carte forte. Textes dans la langue de l'interface (`crew/i18n.ts`). */
export function CrewTab(props: CrewProps): React.ReactElement {
  const { agents, freshId, agentRuns } = props;
  const lang = uiLang();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = agents.find((a) => a.id === openId) ?? null;
  // X15 : la vue « toutes les machines » n'existe que si nokker.ai sert le deck (drapeau `cloud_link.crew`, sinon 404).
  const [deckAvailable, setDeckAvailable] = useState(false);
  const [view, setView] = useState<"agents" | "machines">("agents");
  const [creating, setCreating] = useState(false);
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
    <section className="crew" aria-label={cw(lang, "ariaCrew")}>
      <header className="crew-head">
        <h2>Crew</h2>
        <span className="fine">{cw(lang, "legend")}</span>
        {!creating ? (
          <button type="button" className="btn btn-sm" onClick={() => setCreating(true)}>
            {m(lang, "newAgent")}
          </button>
        ) : null}
        {deckAvailable ? (
          <div className="crew-views" role="tablist" aria-label={cw(lang, "viewAria")}>
            <button type="button" role="tab" aria-selected={view === "agents"} className={`tab ${view === "agents" ? "on" : ""}`} onClick={() => setView("agents")}>
              {cw(lang, "byState")}
            </button>
            <button type="button" role="tab" aria-selected={view === "machines"} className={`tab ${view === "machines" ? "on" : ""}`} onClick={() => setView("machines")}>
              {cw(lang, "allMachines")}
            </button>
          </div>
        ) : null}
        {creating ? <NewAgent client={props.client} lang={lang} toast={props.toast} onDone={() => setCreating(false)} /> : null}
      </header>
      {view === "machines" && deckAvailable ? <MachinesDeck client={props.client} lang={lang} tick={deckTick} toast={props.toast} /> : null}
      {view === "machines" && deckAvailable ? null : (
      <div className="deck">
        {COLUMNS.map((st) => {
          const label = statusLabel(lang, st);
          const list = agents.filter((a) => a.status === st);
          return (
            <div key={st} className="deck-col" style={themeVars(st)}>
              <h3 className="deck-col-title">
                <span className="state-dot" aria-hidden="true" />
                {label}
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
                    aria-label={cw(lang, "agentAria", { name: a.name, state: label }) + (waiting ? cw(lang, "waitingAria") : "")}
                  >
                    <span className="agent-top">
                      <Icon name="bot" size={18} />
                      <span className="agent-card-name">{a.name}</span>
                    </span>
                    <span className="agent-role">{a.role}</span>
                    {a.origin?.pack ? <span className="agent-origin">{cw(lang, "fromPack", { pack: a.origin.pack })}</span> : null}
                    <span className="agent-trigger">
                      <Icon name="timer" size={13} />
                      <span>
                        {triggerLabel(a.trigger, lang)}
                        {a.next_run_at ? ` · ${cw(lang, "next", { at: shortDate(a.next_run_at, Date.now(), lang) })}` : ""}
                      </span>
                    </span>
                    {waiting ? <span className="agent-waiting">{cw(lang, "waiting")}</span> : null}
                    {a.arm_approval_id ? <span className="agent-waiting">{cw(lang, "armToSign")}</span> : null}
                    <span className="agent-meta">
                      <span className="mono">{a.model}</span>
                      <span>{a.last_run ? `${runStatusLabel(a.last_run.status, lang)} ${ago(lang, a.last_run.ended_at)}` : cw(lang, "neverRun")}</span>
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
              {list.length === 0 ? <span className="fine deck-empty">{cw(lang, "noAgent")}</span> : null}
            </div>
          );
        })}
      </div>
      )}
      {open ? <AgentPopout {...props} lang={lang} agent={open} onClose={() => setOpenId(null)} /> : null}
    </section>
  );
}

function AgentPopout({ agent, client, agentRuns, onOpenThread, toast, onClose, lang }: CrewProps & { agent: Agent; onClose: () => void; lang: Lang }): React.ReactElement {
  const [tab, setTab] = useState<"settings" | "current" | "past">("settings");
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [more, setMore] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const when = (iso: string): string => shortDate(iso, Date.now(), lang);

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
      if (r && typeof r === "object" && "approval_id" in r) toast(cw(lang, "armCardSent"), "ok");
      else if (ok) toast(ok, "ok");
    } catch (e) {
      // Armer un agent `mail:` revérifie la relève et la boîte : ses refus (codes stables) sont traduits.
      toast(cw(lang, "refused", { why: errorText(lang, e) }), "error");
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
          <span className="state-label">{statusLabel(lang, agent.status)}</span>
          <button type="button" className="icon-btn" aria-label={cw(lang, "close")} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="crew-actions">
          <button type="button" className="btn btn-brass" disabled={busy || running} onClick={() => void act(() => client.runAgent(agent.id), cw(lang, "runStarted"))}>
            <Icon name="play" /> {cw(lang, "runNow")}
          </button>
          {agent.status === "paused" ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void act(() => client.armAgent(agent.id))}>
              {agent.arm_approval_id ? cw(lang, "resendArm") : cw(lang, "arm")}
            </button>
          ) : (
            <button type="button" className="btn" disabled={busy} onClick={() => void act(() => client.disarmAgent(agent.id))}>
              {cw(lang, "disarm")}
            </button>
          )}
          {confirmDelete ? (
            <>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void act(() => client.deleteAgent(agent.id), cw(lang, "deleted", { name: agent.name }))}>
                {cw(lang, "confirmDelete")}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
                {cw(lang, "cancel")}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(true)}>
              {cw(lang, "delete")}
            </button>
          )}
        </div>
        {confirmDelete ? <p className="fine crew-confirm">{cw(lang, "deleteNote")}</p> : null}
        {agent.arm_approval_id ? <p className="fine crew-confirm">{cw(lang, "armPending")}</p> : null}
        {agent.status === "failed" ? <p className="fine crew-confirm">{cw(lang, "failedNote")}</p> : null}
        <div className="tabs" role="tablist" aria-label={cw(lang, "detailsAria")}>
          {(["settings", "current", "past"] as const).map((id) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={`tab ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>
              {cw(lang, id)}
            </button>
          ))}
        </div>
        <div className="popout-body" role="tabpanel">
          {tab === "settings" ? (
            <dl className="agent-grid">
              <dt>{cw(lang, "mission")}</dt>
              <dd>{agent.instructions || agent.role}</dd>
              {agent.origin?.pack ? (
                <>
                  <dt>{cw(lang, "origin")}</dt>
                  <dd>{cw(lang, "originLine", { pack: agent.origin.pack, template: agent.origin.template })}</dd>
                </>
              ) : null}
              <dt>{cw(lang, "trigger")}</dt>
              <dd>
                {triggerLabel(agent.trigger, lang)}
                {agent.trigger?.kind === "schedule" ? <span className="fine"> ({agent.trigger.tz})</span> : null}
                {agent.next_run_at ? <span className="fine">{cw(lang, "nextRun", { at: when(agent.next_run_at) })}</span> : null}
                <TriggerEdit agent={agent} client={client} lang={lang} toast={toast} />
              </dd>
              {agent.mail_watch ? (
                <>
                  <dt>{m(lang, "watch")}</dt>
                  <dd>
                    <MailWatchView lang={lang} w={agent.mail_watch} />
                  </dd>
                </>
              ) : null}
              <dt>{cw(lang, "model")}</dt>
              <dd className="mono">{agent.model || cw(lang, "defaultModel")}</dd>
              <dt>{cw(lang, "tools")}</dt>
              <dd className="tools">
                {agent.tools.map((t) => (
                  <span key={t} className="chip">
                    {t}
                  </span>
                ))}
              </dd>
              {agent.auto_approve?.length ? (
                <>
                  <dt>{cw(lang, "noCard")}</dt>
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
                  <dt>{cw(lang, "secrets")}</dt>
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
                  <dt>{cw(lang, "budget")}</dt>
                  <dd>{cw(lang, "budgetLine", { calls: agent.budget.max_calls, cost: agent.budget.max_cost, currency: agent.budget.currency })}</dd>
                </>
              ) : null}
              <dt>{cw(lang, "created")}</dt>
              <dd>{new Date(agent.created_at).toLocaleString(lang === "fr" ? "fr-CH" : "en-GB")}</dd>
              {agent.trigger?.kind === "event" && agent.trigger.event.startsWith("webhook:") ? (
                <>
                  <dt>{cw(lang, "webhook")}</dt>
                  <dd>
                    <WebhookKey client={client} agentId={agent.id} toast={toast} lang={lang} />
                  </dd>
                </>
              ) : null}
            </dl>
          ) : tab === "current" ? (
            current ? (
              <div className="run-current">
                <p>
                  <strong>{runStatusLabel(current.status, lang)}</strong>
                  {current.started_at ? <span className="fine">{cw(lang, "since", { at: when(current.started_at) })}</span> : null}
                </p>
                {current.status === "waiting_approval" ? <p className="fine">{cw(lang, "waitingCard")}</p> : null}
                <div className="crew-actions">
                  {current.thread_id ? (
                    <button type="button" className="btn" onClick={() => onOpenThread(current.thread_id!)}>
                      <Icon name="goto" /> {cw(lang, "openThread")}
                    </button>
                  ) : null}
                  <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void act(() => client.cancelAgentRun(agent.id, current.run_id), cw(lang, "runCancelled"))}>
                    {cw(lang, "cancelRun")}
                  </button>
                </div>
              </div>
            ) : (
              <p className="fine">{cw(lang, "noCurrent")}</p>
            )
          ) : runs === null ? (
            <p className="fine">{cw(lang, "loading")}</p>
          ) : runs.length === 0 ? (
            <p className="fine">{cw(lang, "noRuns")}</p>
          ) : (
            <>
              <ul className="run-list">
                {runs.map((r) => (
                  <li key={r.run_id} className={`run run-${r.status}`}>
                    <span className="run-status">
                      {runStatusLabel(r.status, lang)}
                      {r.catch_up ? <span className="fine">{cw(lang, "catchUp")}</span> : null}
                    </span>
                    <span className="fine">
                      {r.started_at ? when(r.started_at) : r.scheduled_for ? cw(lang, "planned", { at: when(r.scheduled_for) }) : ""}
                      {runDuration(r) ? ` · ${runDuration(r)}` : ""}
                      {runCost(r, lang) ? ` · ${runCost(r, lang)}` : ""}
                    </span>
                    {r.event ? <span className="run-summary fine">{cw(lang, "firedBy", { event: r.event })}</span> : null}
                    {r.summary ? <span className="run-summary">{r.summary}</span> : null}
                    {r.thread_id ? (
                      <button type="button" className="btn btn-ghost run-open" onClick={() => onOpenThread(r.thread_id!)}>
                        {cw(lang, "openThread")}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {more ? (
                <button type="button" className="btn btn-ghost" onClick={() => void loadRuns(more)}>
                  {cw(lang, "older")}
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
function WebhookKey({ client, agentId, toast, lang }: { client: NokkerClient; agentId: string; toast: CrewProps["toast"]; lang: Lang }): React.ReactElement {
  const [key, setKey] = useState<{ secret: string; url?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (key) {
    return (
      <span className="webhook-key">
        <code>{key.secret}</code>
        {key.url ? <span className="fine"> · {key.url}</span> : null}
        <span className="fine">{cw(lang, "keyOnce")}</span>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(key.secret).then(
              () => toast(cw(lang, "copied"), "ok"),
              () => toast(cw(lang, "copyFailed"), "error"),
            );
          }}
        >
          {cw(lang, "copy")}
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
          (e) => toast(cw(lang, "keyRefused", { why: errorText(lang, e) }), "error"),
        ).finally(() => setBusy(false));
      }}
    >
      {cw(lang, "newKey")}
    </button>
  );
}
