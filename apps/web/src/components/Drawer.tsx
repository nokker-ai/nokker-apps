import React, { useState } from "react";
import { isSessionThread, type Thread } from "@nokker-apps/sdk";
import { BRAND } from "@nokker-apps/brand";
import { Icon } from "../icons.js";
import { tr } from "../i18n/index.js";
import { NewCodeSession } from "../lokkal/NewCodeSession.js";

/** Tiroir gauche : les sessions (fils permanents). Chaque ligne est aussi une cible de dépôt de bulle. */
export function Drawer({
  threads,
  unseen = {},
  currentId,
  dropTargetId,
  onSelect,
  onCreate,
  onDelete,
  codeSessions = {},
  roots = null,
  onCreateCode,
}: {
  threads: Thread[];
  unseen?: Record<string, number>;
  currentId: string | null;
  dropTargetId: string | null;
  onSelect: (id: string) => void;
  onCreate: (title: string) => void;
  onDelete: (id: string) => void;
  /** Web servi par Lokkal : `thread_id` → dossier des sessions de code. */
  codeSessions?: Record<string, string>;
  /** Racines où ouvrir une session de code ; `null` hors Lokkal (le « + » crée une conversation, comme avant). */
  roots?: string[] | null;
  onCreateCode?: (cwd: string) => Promise<void>;
}): React.ReactElement {
  // Lokkal : le « + » propose d'abord le choix (conversation ou session de code).
  const [creating, setCreating] = useState<false | "choose" | "chat" | "code">(false);
  const [title, setTitle] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  return (
    <aside className="drawer" aria-label={tr("Sessions")}>
      <div className="drawer-brand">
        {/* Kit de marque (packages/brand/assets, servi sous /brand/) : logo horizontal, emblème seul en rail. */}
        <img className="drawer-lockup only-light" src="/brand/lockup/nokker-horizontal-light-transparent.svg" alt={BRAND.productName} />
        <img className="drawer-lockup only-dark" src="/brand/lockup/nokker-horizontal-dark-transparent.svg" alt={BRAND.productName} />
        <img className="drawer-mark only-light" src="/brand/nokker-emblem-light.svg" alt={BRAND.productName} />
        <img className="drawer-mark only-dark" src="/brand/nokker-emblem-dark.svg" alt="" />
      </div>

      <div className="drawer-head">
        <span className="eyebrow">{tr("Sessions")}</span>
        <button type="button" className="icon-btn" aria-label={tr("New session")} aria-expanded={!!creating} onClick={() => setCreating((c) => (c ? false : roots !== null && onCreateCode ? "choose" : "chat"))}>
          <Icon name="plus" size={18} />
        </button>
      </div>

      {creating === "choose" ? (
        <div className="drawer-new drawer-choose" role="group" aria-label={tr("New session")}>
          <button type="button" className="btn" autoFocus onClick={() => setCreating("chat")}>
            <Icon name="chat" size={16} />
            {tr("New conversation")}
          </button>
          <button type="button" className="btn" onClick={() => setCreating("code")}>
            <Icon name="folder" size={16} />
            {tr("New code session")}
          </button>
        </div>
      ) : null}
      {creating === "code" && onCreateCode ? (
        <NewCodeSession
          roots={roots ?? []}
          onCancel={() => setCreating(false)}
          onOpen={async (cwd) => {
            await onCreateCode(cwd);
            setCreating(false);
          }}
        />
      ) : null}
      {creating === "chat" ? (
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
            {tr("Name of the new session")}
          </label>
          <input
            id="nk-new-session"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setCreating(false)}
            placeholder={tr("Session name")}
          />
          <button type="submit" className="btn btn-brass">
            {tr("Create")}
          </button>
        </form>
      ) : null}

      <nav className="drawer-list" aria-label={tr("Session list")}>
        {threads.filter(isSessionThread).map((t) => {
          const current = t.id === currentId;
          const unread = t.unread || (current ? 0 : unseen[t.id] ?? 0);
          const cwd = codeSessions[t.id];
          const cls = ["session-row", current ? "current" : "", t.working ? "working" : "", dropTargetId === t.id ? "drop" : "", cwd ? "code" : ""].join(" ");
          const label = [
            cwd ? tr("Code session {0}, folder {1}", t.title, cwd) : tr("Session {0}", t.title),
            current ? tr("current") : "",
            t.working ? tr("working") : "",
            t.bubble_count === 1 ? tr("1 bubble") : tr("{0} bubbles", t.bubble_count),
            unread ? (unread === 1 ? tr("1 unread reply") : tr("{0} unread replies", unread)) : "",
          ]
            .filter(Boolean)
            .join(", ");
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
                {cwd ? <Icon name="folder" size={16} /> : t.title.slice(0, 1).toUpperCase()}
                <span className="session-dot" />
              </span>
              <span className="session-text">
                <span className="session-name">
                  {t.title}
                  {t.working ? <span className="session-working">{tr("working")}</span> : null}
                </span>
                <span className={`session-snippet ${cwd ? "mono" : ""}`} title={cwd}>
                  {cwd ?? (t.last_snippet || "—")}
                </span>
              </span>
              <span className="session-meta" aria-hidden="true">
                {unread ? <span className="session-unread">{unread}</span> : null}
                <span className="session-count">{tr("{0} b.", t.bubble_count)}</span>
              </span>
            </button>
            {confirmId === t.id ? (
              <span className="session-confirm" role="group" aria-label={tr("Delete the session {0}?", t.title)}>
                <button type="button" className="btn btn-danger" autoFocus onClick={() => { setConfirmId(null); onDelete(t.id); }}>
                  {tr("Delete")}
                </button>
                <button type="button" className="btn" onClick={() => setConfirmId(null)}>
                  {tr("Cancel")}
                </button>
              </span>
            ) : (
              <button type="button" className="icon-btn session-del" aria-label={tr("Delete the session {0}", t.title)} title={tr("Delete the session")} onClick={() => setConfirmId(t.id)}>
                <Icon name="close" size={14} />
              </button>
            )}
            </div>
          );
        })}
      </nav>

      <div className="drawer-foot">
        <span>{tr("Sessions are permanent and talk to each other.")}</span>
        <span>{tr("Drag a bubble onto a session to move or copy it.")}</span>
      </div>
    </aside>
  );
}
