/** Carte `pack_agents` (BUBBLES §9.6) : un pack a été retiré, ses agents restent tels quels tant que l'utilisateur ne
 * choisit pas — désarmer, supprimer ou garder (décidé en direct par le noyau ; un agent supprimé entre-temps est sauté). */
import React, { useState } from "react";
import type { BubbleBase } from "@nokker-apps/sdk";
import "./packs.css";

export function PackAgents({ b, onAction }: { b: BubbleBase<"pack_agents">; onAction: (id: string) => void }): React.ReactElement {
  const s = b.state;
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className="bubble-body pack-agents">
      <p>{s.note || `Le pack « ${s.pack} » est retiré ; ces agents en viennent.`}</p>
      <ul className="pack-agents-list">
        {(s.agents ?? []).map((a) => (
          <li key={a.id}>
            <strong>{a.name}</strong> <span className="fine">{a.armed ? "armé" : a.status === "running" ? "en marche" : "au repos"}</span>
          </li>
        ))}
      </ul>
      <div className="bubble-actions">
        {confirmDelete ? (
          <>
            <button type="button" className="btn btn-danger" onClick={() => onAction("delete")}>
              Oui, supprimer {s.agents?.length === 1 ? "l'agent" : "les agents"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
              Annuler
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
