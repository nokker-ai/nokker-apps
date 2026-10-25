import React, { useState } from "react";
import { isSessionThread, type Thread } from "@nokker-apps/sdk";
import { BRAND } from "@nokker-apps/brand";
import { Icon } from "../icons.js";

/** Tiroir gauche : les sessions (fils permanents). Chaque ligne est aussi une cible de dépôt de bulle. */
export function Drawer({
  threads,
  unseen = {},
  currentId,
  dropTargetId,
  onSelect,
  onCreate,
  onDelete,
}: {
  threads: Thread[];
  unseen?: Record<string, number>;
  currentId: string | null;
  dropTargetId: string | null;
  onSelect: (id: string) => void;
  onCreate: (title: string) => void;
  onDelete: (id: string) => void;
}): React.ReactElement {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  return (
    <aside className="drawer" aria-label="Sessions">
      <div className="drawer-brand">
        {/* Kit de marque (packages/brand/assets, servi sous /brand/) : logo horizontal, emblème seul en rail. */}
        <img className="drawer-lockup only-light" src="/brand/lockup/nokker-horizontal-light-transparent.svg" alt={BRAND.productName} />
        <img className="drawer-lockup only-dark" src="/brand/lockup/nokker-horizontal-dark-transparent.svg" alt={BRAND.productName} />
        <img className="drawer-mark only-light" src="/brand/nokker-emblem-light.svg" alt={BRAND.productName} />
        <img className="drawer-mark only-dark" src="/brand/nokker-emblem-dark.svg" alt="" />
      </div>

      <div className="drawer-head">
        <span className="eyebrow">Sessions</span>
        <button type="button" className="icon-btn" aria-label="Nouvelle session" aria-expanded={creating} onClick={() => setCreating((c) => !c)}>
          <Icon name="plus" size={18} />
        </button>
      </div>

      {creating ? (
        <form
          className="drawer-new"
          onSubmit={(e) => {
            e.preventDefault();
            const t = title.trim();
            if (!t) return;
            onCreate(t);
            setTitle("");
            setCreating(false);
          }}
        >
          <label htmlFor="nk-new-session" className="sr-only">
            Nom de la nouvelle session
          </label>
          <input
            id="nk-new-session"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setCreating(false)}
            placeholder="Nom de la session"
          />
          <button type="submit" className="btn btn-brass">
            Créer
          </button>
        </form>
      ) : null}

      <nav className="drawer-list" aria-label="Liste des sessions">
        {threads.filter(isSessionThread).map((t) => {
          const current = t.id === currentId;
          const unread = t.unread || (current ? 0 : unseen[t.id] ?? 0);
          const cls = ["session-row", current ? "current" : "", t.working ? "working" : "", dropTargetId === t.id ? "drop" : ""].join(" ");
          const label = `Session ${t.title}${current ? ", courante" : ""}${t.working ? ", travaille" : ""}, ${t.bubble_count} bulle${t.bubble_count > 1 ? "s" : ""}${unread ? `, ${unread} réponse${unread > 1 ? "s" : ""} non lue${unread > 1 ? "s" : ""}` : ""}`;
          return (
            <div key={t.id} className="session-wrap">
            <button
              type="button"
              className={cls}
              data-thread-id={t.id}
              aria-current={current ? "page" : undefined}
              aria-label={label}
              title={t.title}
              onClick={() => onSelect(t.id)}
            >
              <span className="session-initial" aria-hidden="true">
                {t.title.slice(0, 1).toUpperCase()}
                <span className="session-dot" />
              </span>
              <span className="session-text">
                <span className="session-name">
                  {t.title}
                  {t.working ? <span className="session-working">travaille</span> : null}
                </span>
                <span className="session-snippet">{t.last_snippet || "—"}</span>
              </span>
              <span className="session-meta" aria-hidden="true">
                {unread ? <span className="session-unread">{unread}</span> : null}
                <span className="session-count">{t.bubble_count} b.</span>
              </span>
            </button>
            {confirmId === t.id ? (
              <span className="session-confirm" role="group" aria-label={`Supprimer la session ${t.title} ?`}>
                <button type="button" className="btn btn-danger" autoFocus onClick={() => { setConfirmId(null); onDelete(t.id); }}>
                  Supprimer
                </button>
                <button type="button" className="btn" onClick={() => setConfirmId(null)}>
                  Annuler
                </button>
              </span>
            ) : (
              <button type="button" className="icon-btn session-del" aria-label={`Supprimer la session ${t.title}`} title="Supprimer la session" onClick={() => setConfirmId(t.id)}>
                <Icon name="close" size={14} />
              </button>
            )}
            </div>
          );
        })}
      </nav>

      <div className="drawer-foot">
        <span>Les sessions sont permanentes et se parlent entre elles.</span>
        <span>Glisse une bulle sur une session pour la déplacer ou la copier.</span>
      </div>
    </aside>
  );
}
