/** Carte `pack_agents` (BUBBLES §9.6) : un pack a été retiré, ses agents restent tels quels tant que l'utilisateur ne
 * choisit pas — désarmer, supprimer ou garder (décidé en direct par le noyau ; un agent supprimé entre-temps est sauté). */
import React, { useState } from "react";
import type { BubbleBase } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import "./packs.css";

export function PackAgents({ b, onAction }: { b: BubbleBase<"pack_agents">; onAction: (id: string) => void }): React.ReactElement {
  const s = b.state;
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className="bubble-body pack-agents">
      <p>{s.note || tr("The “{0}” pack is removed; these agents came from it.", s.pack)}</p>
      <ul className="pack-agents-list">
        {(s.agents ?? []).map((a) => (
          <li key={a.id}>
            <strong>{a.name}</strong> <span className="fine">{a.armed ? tr("armed") : a.status === "running" ? tr("running") : tr("idle")}</span>
          </li>
        ))}
      </ul>
      <div className="bubble-actions">
        {confirmDelete ? (
          <>
            <button type="button" className="btn btn-danger" onClick={() => onAction("delete")}>
              {s.agents?.length === 1 ? tr("Yes, delete the agent") : tr("Yes, delete the agents")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
              {tr("Cancel")}
            </button>
          </>
        ) : (
          b.actions.map((a) => (
            // Supprimer est définitif : un second clic le confirme ; Garder reste l'action mise en avant.
            <button key={a.id} type="button" className={`btn ${a.primary ? "btn-brass" : "btn-ghost"}`} onClick={() => (a.id === "delete" ? setConfirmDelete(true) : onAction(a.id))}>
              {a.label}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
