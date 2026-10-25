/**
 * Deck multi-machines (X15, LOKKAL §7.19 point 5) : une colonne par machine du compte (charge, sessions, agents qui
 * respirent, cartes fortes à signer), plus nokker.ai et les agents en placement automatique. Le deck n'est pas poussé
 * en direct : relu toutes les 15 s et à chaque événement d'agent. Des noms et des états seulement.
 */
import React, { useCallback, useEffect, useState } from "react";
import { AGENT_STATUS_THEME } from "@nokker-apps/brand";
import { NokkerApiError, type DeckAgent, type DeckMachine, type DeckView, type MoveMissing, type NokkerClient } from "@nokker-apps/sdk";
import { Icon } from "../icons.js";
import { ageLabel, agentBreathes, loadSummary, moveTargets, sessionStateLabel } from "./deckModel.js";
import { cw, statusLabel, type Lang } from "./i18n.js";

const REFRESH_MS = 15_000;

export function MachinesDeck({
  client,
  lang,
  tick,
  toast,
}: {
  client: NokkerClient;
  lang: Lang;
  /** Change à chaque événement d'agent : relire le deck. */
  tick: string;
  toast(text: string, tone?: "ok" | "error"): void;
}): React.ReactElement {
  const [deck, setDeck] = useState<DeckView | null>(null);
  const [failed, setFailed] = useState(false);
  const [moving, setMoving] = useState<DeckAgent | null>(null);

  const load = useCallback(async () => {
    try {
      setDeck(await client.getDeck());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load, tick]);

  if (!deck) return <p className="fine">{failed ? cw(lang, "deckFailed") : cw(lang, "deckLoading")}</p>;

  return (
    <>
      <div className="mdeck">
        {deck.machines.map((m) => (
          <MachineColumn key={m.machine_id} m={m} lang={lang} onMove={setMoving} />
        ))}
        {deck.web.agents.length || deck.web.engine ? (
          <section className="mdeck-col" aria-label="nokker.ai">
            <header className="mdeck-head">
              <span className="mc-dot on" aria-hidden="true" />
              <strong>nokker.ai</strong>
              <span className="fine">{deck.web.engine ? cw(lang, "hosted") : cw(lang, "engineOff")}</span>
            </header>
            <AgentList agents={deck.web.agents} lang={lang} onMove={setMoving} />
          </section>
        ) : null}
        {deck.auto.agents.length ? (
          <section className="mdeck-col" aria-label={cw(lang, "autoAria")}>
            <header className="mdeck-head">
              <strong>{cw(lang, "auto")}</strong>
              <span className="fine">{cw(lang, "autoNote")}</span>
            </header>
            <AgentList agents={deck.auto.agents} lang={lang} onMove={setMoving} machines={deck.machines} />
          </section>
        ) : null}
      </div>
      {moving ? (
        <MoveDialog
          agent={moving}
          machines={deck.machines}
          client={client}
          lang={lang}
          onClose={() => setMoving(null)}
          onDone={(name, to) => {
            toast(cw(lang, "moving", { name, to }), "ok");
            setMoving(null);
            void load();
          }}
        />
      ) : null}
    </>
  );
}

function MachineColumn({ m, lang, onMove }: { m: DeckMachine; lang: Lang; onMove: (a: DeckAgent) => void }): React.ReactElement {
  const load = loadSummary(m.load, lang);
  return (
    <section className={`mdeck-col ${m.online ? "" : "offline"}`} aria-label={cw(lang, "machineAria", { name: m.name, state: cw(lang, m.online ? "online" : "offline") })}>
      <header className="mdeck-head">
        <span className={`mc-dot ${m.online ? "on" : ""}`} aria-hidden="true" />
        <strong>{m.name}</strong>
        <span className="fine">{m.online ? cw(lang, "online") : cw(lang, "offlineSeen", { age: ageLabel(m.load_age_s, lang) })}</span>
      </header>
      {load ? (
        <div className="mdeck-load" title={load.text}>
          <Meter label="RAM" pct={load.ramPct} />
          <Meter label="CPU" pct={load.cpuPct} />
          <span className="fine">{load.text}</span>
        </div>
      ) : null}
      {m.strong_approvals.length ? (
        <ul className="mdeck-approvals">
          {m.strong_approvals.map((a) => (
            <li key={a.approval_id}>
              <a className="btn btn-brass" href={a.url}>
                <Icon name="shield" size={14} /> {cw(lang, "strongCard")}
              </a>
            </li>
          ))}
        </ul>
      ) : m.pending_approvals ? (
        <p className="fine">{cw(lang, "pendingCards", { n: m.pending_approvals })}</p>
      ) : null}
      {m.sessions.length ? (
        <ul className="mdeck-sessions" aria-label={cw(lang, "sessionsAria")}>
          {m.sessions.map((s) => (
            <li key={s.thread_id} className={`mdeck-session st-${s.state}`}>
              <span className="mdeck-session-name">{s.title ?? s.name}</span>
              <span className="fine">{sessionStateLabel(s.state, lang)}</span>
            </li>
          ))}
        </ul>
      ) : m.online ? (
        <p className="fine">{cw(lang, "noSession")}</p>
      ) : null}
      <AgentList agents={m.agents} lang={lang} onMove={onMove} />
    </section>
  );
}

function Meter({ label, pct }: { label: string; pct: number }): React.ReactElement {
  return (
    <span className="meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span className="meter-label">{label}</span>
      <span className="meter-bar">
        <span className={`meter-fill ${pct >= 85 ? "hot" : ""}`} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

function AgentList({ agents, lang, onMove, machines = [] }: { agents: DeckAgent[]; lang: Lang; onMove: (a: DeckAgent) => void; machines?: DeckMachine[] }): React.ReactElement | null {
  if (!agents.length) return null;
  return (
    <div className="mdeck-agents">
      {agents.map((a) => {
        const th = AGENT_STATUS_THEME[a.status] ?? AGENT_STATUS_THEME.paused;
        const label = statusLabel(lang, a.status);
        const where = a.live_run?.machine_id ? machines.find((m) => m.machine_id === a.live_run!.machine_id)?.name : null;
        return (
          <button
            key={a.id}
            type="button"
            className={`agent-card mini s-${a.status} ${agentBreathes(a) ? "breathing" : ""}`}
            style={{ "--s-l": th.light, "--srgb-l": th.lightRgb, "--s-d": th.color, "--srgb-d": th.rgb } as React.CSSProperties}
            onClick={() => onMove(a)}
            aria-label={cw(lang, "agentAria", { name: a.name, state: label }) + (a.defined_at === "machine" ? `, ${cw(lang, "postedOnMachine")}` : "") + cw(lang, "moveAria")}
          >
            <span className="agent-top">
              <Icon name="bot" size={15} />
              <span className="agent-card-name">{a.name}</span>
            </span>
            <span className="fine">
              {label}
              {where ? cw(lang, "runsOn", { where }) : ""}
              {a.defined_at === "machine" ? ` · ${cw(lang, "postedOnMachine")}` : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function MoveDialog({
  agent,
  machines,
  client,
  lang,
  onClose,
  onDone,
}: {
  agent: DeckAgent;
  machines: DeckMachine[];
  client: NokkerClient;
  lang: Lang;
  onClose: () => void;
  onDone: (name: string, to: string) => void;
}): React.ReactElement {
  const targets = moveTargets(machines, agent.placement?.machine ?? null, lang);
  const [to, setTo] = useState(targets[0]?.to ?? "web");
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState<MoveMissing[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const go = async (): Promise<void> => {
    setBusy(true);
    setMissing(null);
    setErr(null);
    try {
      await client.moveAgent(agent.id, to);
      onDone(agent.name, targets.find((t) => t.to === to)?.label ?? to);
    } catch (e) {
      const body = e instanceof NokkerApiError ? (e.body as { error?: { message?: string; missing?: MoveMissing[] } } | undefined) : undefined;
      if (body?.error?.missing?.length) setMissing(body.error.missing);
      else setErr(body?.error?.message ?? cw(lang, "moveFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="popout-backdrop" onClick={onClose}>
      <div className="popout" role="dialog" aria-modal="true" aria-label={cw(lang, "moveTitleAria", { name: agent.name })} onClick={(e) => e.stopPropagation()}>
        <header className="popout-head">
          <Icon name="bot" size={20} />
          <h3>{cw(lang, "moveTitle", { name: agent.name })}</h3>
          <button type="button" className="icon-btn" aria-label={cw(lang, "close")} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="popout-body">
          <label className="fine" htmlFor="mv-to">
            {cw(lang, "moveTo")}
          </label>
          <select id="mv-to" value={to} onChange={(e) => setTo(e.target.value)}>
            {targets.map((t) => (
              <option key={t.to} value={t.to}>
                {t.label}
              </option>
            ))}
          </select>
          <p className="fine">{cw(lang, "moveNote")}</p>
          {missing ? (
            <div role="alert">
              <p className="error">{cw(lang, "missing")}</p>
              <ul className="mdeck-missing">
                {missing.map((x, i) => (
                  <li key={i}>{x.message}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {err ? (
            <p className="error" role="alert">
              {err}
            </p>
          ) : null}
          <div className="crew-actions" style={{ padding: "12px 0 0" }}>
            <button type="button" className="btn btn-brass" disabled={busy} onClick={() => void go()}>
              {busy ? cw(lang, "checking") : cw(lang, "move")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              {cw(lang, "cancel")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
