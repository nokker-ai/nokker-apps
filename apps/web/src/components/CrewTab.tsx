import React, { useEffect, useRef, useState } from "react";
import type { Agent, AgentStatus } from "@nokker-apps/sdk";
import { AGENT_STATUS_THEME } from "@nokker-apps/brand";
import { Icon } from "../icons.js";

const COLUMNS: AgentStatus[] = ["running", "armed", "idle", "error"];

function ago(iso: string | null | undefined): string {
  if (!iso) return "jamais lancé";
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `il y a ${h} h` : `il y a ${Math.round(h / 24)} j`;
}

/** Onglet Crew — deck façon SOKKAN : une carte par agent, couleur ET libellé d'état, la carte respire quand
 * l'agent tourne ; clic = popout (Réglages, Session en cours, Sessions passées) au-dessus du deck. */
export function CrewTab({ agents, freshId }: { agents: Agent[]; freshId: string | null }): React.ReactElement {
  const [open, setOpen] = useState<Agent | null>(null);
  return (
    <section className="crew" aria-label="Crew — agents">
      <header className="crew-head">
        <h2>Crew</h2>
        <span className="fine">Une carte par agent. Bleu : au repos · vert : armé · orange : en marche · rouge : en erreur.</span>
      </header>
      <div className="deck">
        {COLUMNS.map((st) => {
          const th = AGENT_STATUS_THEME[st];
          const list = agents.filter((a) => a.status === st);
          return (
            <div key={st} className="deck-col" style={{ "--s-l": th.light, "--srgb-l": th.lightRgb, "--s-d": th.color, "--srgb-d": th.rgb } as React.CSSProperties}>
              <h3 className="deck-col-title">
                <span className="state-dot" aria-hidden="true" />
                {th.label}
                <span className="count">{list.length}</span>
              </h3>
              {list.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`agent-card s-${a.status} ${a.id === freshId ? "fresh" : ""}`}
                  onClick={() => setOpen(a)}
                  aria-haspopup="dialog"
                  aria-label={`Agent ${a.name}, ${th.label}`}
                >
                  <span className="agent-top">
                    <Icon name="bot" size={18} />
                    <span className="agent-card-name">{a.name}</span>
                  </span>
                  <span className="agent-role">{a.role}</span>
                  <span className="agent-meta">
                    <span className="mono">{a.model}</span>
                    <span>{ago(a.last_run)}</span>
                  </span>
                  <span className="tools">
                    {a.tools.slice(0, 4).map((t) => (
                      <span key={t} className="chip">
                        {t}
                      </span>
                    ))}
                  </span>
                </button>
              ))}
              {list.length === 0 ? <span className="fine deck-empty">Aucun agent</span> : null}
            </div>
          );
        })}
      </div>
      {open ? <AgentPopout agent={open} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

function AgentPopout({ agent, onClose }: { agent: Agent; onClose: () => void }): React.ReactElement {
  const [tab, setTab] = useState<"settings" | "current" | "past">("settings");
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
  return (
    <div className="popout-backdrop" onClick={onClose}>
      <div
        className="popout"
        role="dialog"
        aria-modal="true"
        aria-label={`Agent ${agent.name}`}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
        style={{ "--s-l": th.light, "--srgb-l": th.lightRgb, "--s-d": th.color, "--srgb-d": th.rgb } as React.CSSProperties}
      >
        <header className="popout-head">
          <Icon name="bot" size={20} />
          <h3>{agent.name}</h3>
          <span className="state-label">{th.label}</span>
          <button type="button" className="icon-btn" aria-label="Fermer" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="tabs" role="tablist" aria-label="Détails de l'agent">
          {(
            [
              ["settings", "Réglages"],
              ["current", "Session en cours"],
              ["past", "Sessions passées"],
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
              <dt>Rôle</dt>
              <dd>{agent.role}</dd>
              <dt>Modèle</dt>
              <dd className="mono">{agent.model}</dd>
              <dt>Outils</dt>
              <dd className="tools">
                {agent.tools.map((t) => (
                  <span key={t} className="chip">
                    {t}
                  </span>
                ))}
              </dd>
              <dt>Créé</dt>
              <dd>{new Date(agent.created_at).toLocaleString("fr-CH")}</dd>
            </dl>
          ) : tab === "current" ? (
            <p className="fine">{agent.status === "running" ? "Session en cours (démo) : l'agent travaille, ses bulles apparaissent dans le fil qui l'a lancé." : "Aucune session en cours."}</p>
          ) : (
            <p className="fine">Dernier lancement : {ago(agent.last_run)}. L'historique détaillé arrive avec l'API agents (hors contrat P1).</p>
          )}
        </div>
      </div>
    </div>
  );
}
