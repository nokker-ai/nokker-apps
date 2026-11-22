import React, { useState } from "react";
import { isSessionThread, type Thread } from "@nokker-apps/sdk";
import { BRAND } from "@nokker-apps/brand";
import { Icon } from "../icons.js";
import { tr } from "../i18n/index.js";
import { NewCodeSession } from "../lokkal/NewCodeSession.js";
import type { NavView, ViewId } from "../nav/views.js";
import { anchor } from "../showme/model.js";
import { CLOUD, filterRows, offlineMinutes, type OriginInfo, type SearchRow, type UnifiedRow } from "../sessions/origins.js";

/** Liste unique cloud + machines (LOKKAL-PHONE §1.2) : lignes fusionnées, origines, ouverture d'un fil d'une machine. */
export interface UnifiedDrawer {
  rows: UnifiedRow[];
  origins: OriginInfo[];
  onOpenRemote: (row: { origin: string; id: string }) => void;
  /** Fil ouvert, avec son origine (`cloud` ou la machine). */
  current?: { origin: string; id: string } | null;
  search: (q: string) => Promise<{ rows: SearchRow[]; silent: string[] }>;
}

/** Tiroir gauche : les sessions (fils permanents). Chaque ligne est aussi une cible de dépôt de bulle. Sur téléphone, il
 * glisse par-dessus le chat (App : bouton en bas à gauche). */
export function Drawer({
  id,
  closed = false,
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
  places = [],
  view = "chat",
  onOpenView,
  crewPulse = false,
  crewTarget = true,
  unified,
}: {
  id?: string;
  /** Téléphone, tiroir rentré : hors de l'ordre de tabulation et de l'arbre d'accessibilité. */
  closed?: boolean;
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
  /** Vues de travail (Crew, Code, Incidents, Plan) : sous la marque, au-dessus des sessions. */
  places?: NavView[];
  /** Vue affichée : une session n'est « la page courante » que dans le chat. */
  view?: ViewId;
  onOpenView?: (id: ViewId) => void;
  /** Un agent vient d'être créé : l'entrée Crew s'illumine. */
  crewPulse?: boolean;
  /** L'entrée Crew est la cible du vol de la carte d'agent (`data-crew-tab`) ; au téléphone c'est le bouton du tiroir. */
  crewTarget?: boolean;
  /** app.nokker.ai avec au moins une machine liée : liste unique. */
  unified?: UnifiedDrawer;
}): React.ReactElement {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ q: string; rows: SearchRow[]; silent: string[] } | null>(null);
  const multi = !!unified && unified.origins.length > 0;
  const nameOf = (origin: string): string => (origin === CLOUD ? tr("cloud") : unified?.origins.find((o) => o.id === origin)?.name ?? origin);
  const runSearch = (q: string): void => {
    setQuery(q);
    if (!unified || q.trim().length < 2) return setFound(null);
    const want = q.trim();
    void unified.search(want).then((r) => setQuery((cur) => (cur.trim() === want && setFound({ q: want, ...r }), cur)));
  };
  // Lokkal : le « + » propose d'abord le choix (conversation ou session de code).
  const [creating, setCreating] = useState<false | "choose" | "chat" | "code">(false);
  const [title, setTitle] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  return (
    <aside id={id} className="drawer" aria-label={tr("Sessions")} inert={closed || undefined}>
      <div className="drawer-brand">
        {/* Kit de marque (packages/brand/assets, servi sous /brand/) : logo horizontal, emblème seul en rail. */}
        <img className="drawer-lockup only-light" src="/brand/lockup/nokker-horizontal-light-transparent.svg" alt={BRAND.productName} />
        <img className="drawer-lockup only-dark" src="/brand/lockup/nokker-horizontal-dark-transparent.svg" alt={BRAND.productName} />
        <img className="drawer-mark only-light" src="/brand/nokker-emblem-light.svg" alt={BRAND.productName} />
        <img className="drawer-mark only-dark" src="/brand/nokker-emblem-dark.svg" alt="" />
      </div>

      {places.length && onOpenView ? (
        <nav className="drawer-places" aria-label={tr("Views")}>
          {places.map((v) => (
            <button
              key={v.id}
              type="button"
              className={`place ${view === v.id ? "on" : ""} ${v.id === "crew" && crewPulse ? "pulse" : ""} ${v.attention ? "attention" : ""}`}
              aria-current={view === v.id ? "page" : undefined}
              data-view={v.id}
              {...(v.id === "crew" && crewTarget ? { "data-crew-tab": "" } : {})}
              onClick={() => onOpenView(v.id)}
            >
              <Icon name={v.icon} size={18} />
              <span className="place-label">{v.label}</span>
              {v.count ? (
                <span className="nav-count" aria-label={v.countLabel}>
                  {v.count}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
      ) : null}

      <div className="drawer-head">
        <span className="eyebrow">{tr("Sessions")}</span>
        <button type="button" className="icon-btn" aria-label={tr("New session")} {...anchor("new_session")} aria-expanded={!!creating} onClick={() => setCreating((c) => (c ? false : roots !== null && onCreateCode ? "choose" : "chat"))}>
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

      <nav className="drawer-list" aria-label={tr("Session list")} {...anchor("sessions")}>
        {multi ? (
          <div className="origin-tools">
            <input
              type="search"
              className="origin-search"
              aria-label={tr("Search all sessions")}
              placeholder={tr("Search everywhere")}
              value={query}
              onChange={(e) => runSearch(e.target.value)}
            />
            <div className="origin-filter" role="group" aria-label={tr("Sessions from")}>
              {["all", CLOUD, ...unified!.origins.map((o) => o.id)].map((o) => (
                <button key={o} type="button" className={`origin-chip ${filter === o ? "on" : ""}`} aria-pressed={filter === o} onClick={() => setFilter(o)}>
                  {o === "all" ? tr("All") : nameOf(o)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {multi && found ? (
          <div className="origin-results" aria-live="polite" data-search-results>
            {found.rows.length === 0 ? <p className="fine">{tr("Nothing found for “{0}”.", found.q)}</p> : null}
            {found.rows.map((r) => (
              <button key={`${r.origin}/${r.thread_id}/${r.turn_index ?? "t"}`} type="button" className="session-row search-hit" onClick={() => (r.origin === CLOUD ? onSelect(r.thread_id) : unified!.onOpenRemote({ origin: r.origin, id: r.thread_id }))}>
                <span className="session-text">
                  <span className="session-name">
                    {r.title || tr("Untitled session")} <span className="origin-pill">{nameOf(r.origin)}</span>
                  </span>
                  {r.snippet ? <span className="session-snippet">{r.snippet}</span> : null}
                </span>
              </button>
            ))}
            {found.silent.map((n) => (
              <p key={n} className="fine origin-silent">{tr("{0} did not answer.", n)}</p>
            ))}
          </div>
        ) : multi ? (
          filterRows(unified!.rows.filter((r) => r.origin !== CLOUD || (r.thread && isSessionThread(r.thread))), filter).map((r) => (r.origin === CLOUD && r.thread ? cloudRow(r.thread) : remoteRow(r)))
        ) : (
          threads.filter(isSessionThread).map((t) => cloudRow(t))
        )}
      </nav>

      <div className="drawer-foot">
        <span>{tr("Sessions are permanent and talk to each other.")}</span>
        <span>{tr("Drag a bubble onto a session to move or copy it.")}</span>
      </div>
    </aside>
  );

  function remoteRow(r: UnifiedRow): React.ReactElement {
    const o = unified!.origins.find((x) => x.id === r.origin);
    const mins = o && !o.online ? offlineMinutes(o) : null;
    const title = r.title || tr("Untitled session");
    return (
      <div key={`${r.origin}/${r.id}`} className="session-wrap">
        <button
          type="button"
          className={`session-row remote ${r.offline ? "offline" : ""} ${r.state === "working" ? "working" : ""} ${unified!.current?.origin === r.origin && unified!.current.id === r.id ? "current" : ""}`}
          aria-current={unified!.current?.origin === r.origin && unified!.current.id === r.id && view === "chat" ? "page" : undefined}
          data-thread-id={r.id}
          data-origin={r.origin}
          aria-label={[tr("Session {0}", title), tr("on {0}", r.originName), r.offline ? tr("offline") : ""].filter(Boolean).join(", ")}
          title={title}
          onClick={() => unified!.onOpenRemote({ origin: r.origin, id: r.id })}
        >
          <span className="session-initial" aria-hidden="true">
            {title.slice(0, 1).toUpperCase()}
            <span className="session-dot" />
          </span>
          <span className="session-text">
            <span className="session-name">
              {title} <span className="origin-pill">{r.originName}</span>
              {r.state === "working" ? <span className="session-working">{tr("working")}</span> : null}
              {r.state === "awaiting_approval" ? <span className="session-working">{tr("awaiting approval")}</span> : null}
            </span>
            <span className="session-snippet">
              {r.offline ? (mins ? tr("{0} offline for {1} min", r.originName, String(mins)) : tr("{0} offline", r.originName)) : r.snippet || "—"}
            </span>
          </span>
        </button>
      </div>
    );
  }

  function cloudRow(t: Thread): React.ReactElement {
          const selected = t.id === currentId;
          const current = selected && view === "chat";
          const unread = t.unread || (selected ? 0 : unseen[t.id] ?? 0);
          const cwd = codeSessions[t.id];
          const cls = ["session-row", selected ? "current" : "", selected && !current ? "behind" : "", t.working ? "working" : "", dropTargetId === t.id ? "drop" : "", cwd ? "code" : ""].join(" ");
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
                  {multi ? <span className="origin-pill">{tr("cloud")}</span> : null}
                  {t.working ? <span className="session-working">{tr("working")}</span> : null}
                </span>
                <span className={`session-snippet ${cwd ? "mono" : ""}`} title={cwd}>
                  {cwd ?? (t.last_snippet || "—")}
                </span>
              </span>
              <span className="session-meta" aria-hidden="true">
                {unread ? <span className="session-unread">{unread}</span> : null}
                {t.bubble_count ? <span className="session-count">{tr("{0} b.", t.bubble_count)}</span> : null}
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
  }
}
