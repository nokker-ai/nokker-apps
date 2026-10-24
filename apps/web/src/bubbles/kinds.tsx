/**
 * Rendu du corps des bulles, par `kind` (BUBBLES.md §2). Un champ inconnu de `state` est ignoré ; un
 * champ attendu absent ne casse rien (le noyau peut remplir l'état en plusieurs `bubble.updated`).
 */
import React, { useEffect, useState } from "react";
import { NokkerApiError, type Approval, type Bubble, type BubbleBase } from "@nokker-apps/sdk";
import { useStore } from "../context.js";
import { Icon } from "../icons.js";

type B<K extends Bubble["kind"]> = BubbleBase<K>;

export function statusLabel(b: Bubble, now: number): string {
  switch (b.kind) {
    case "monitor":
      return b.status === "working" ? "mesure" : b.status === "failed" ? "échec" : "vivante";
    case "search":
      return b.status === "working" ? "cherche" : `${b.state.results?.length ?? 0} sources`;
    case "timer": {
      if (b.status === "done") return "terminé";
      const left = Math.max(0, Date.parse(b.state.ends_at) - now);
      return fmtDuration(left);
    }
    case "script":
      return b.status === "working" ? "tourne" : b.state.exit_code === 0 ? "exit 0" : b.state.exit_code != null ? `exit ${b.state.exit_code}` : b.status;
    case "media":
      return b.state.mime?.split("/")[0] ?? "aperçu";
    case "notify":
      return b.state.from_title;
    case "agent_draft":
      return b.status === "working" ? "Nina remplit" : "prête";
    case "approval":
      return b.status === "working" ? "en attente" : b.status === "done" ? "approuvée" : b.status === "failed" ? "refusée" : b.status;
  }
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function useNow(active: boolean, every = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [active, every]);
  return now;
}

function Actions({ b, readOnly }: { b: Bubble; readOnly: boolean }) {
  const store = useStore();
  if (!b.actions.length || readOnly) return null;
  return (
    <div className="bubble-actions">
      {b.actions.map((a) => (
        <button key={a.id} type="button" className={`btn ${a.primary ? "btn-brass" : ""}`} onClick={() => void store.runAction(b, a.id)}>
          {a.label}
        </button>
      ))}
    </div>
  );
}

function Skel({ w = "100%", h = 10 }: { w?: string; h?: number }) {
  return <div className="skel" style={{ width: w, height: h }} />;
}

function Monitor({ b, readOnly }: { b: B<"monitor">; readOnly: boolean }) {
  const s = b.state;
  const pct = s.max ? Math.min(100, (s.value / s.max) * 100) : null;
  const hot = pct !== null && pct >= 85;
  const series = s.series ?? [];
  const vals = series.map(([, v]) => v);
  const lo = Math.min(...vals, s.value) - 2;
  const hi = Math.max(...vals, s.value) + 1;
  const pts = series.map(([, v], i) => `${(i / Math.max(1, series.length - 1)) * 100},${30 - ((v - lo) / Math.max(1, hi - lo)) * 28}`).join(" ");
  return (
    <div className="bubble-body">
      <code className="mono cyan">{s.target} · {s.metric}</code>
      <div className="metric">
        <span className={`metric-value ${hot ? "hot" : ""}`}>
          {s.value.toLocaleString("fr-CH", { maximumFractionDigits: 1 })}
          <small>{s.unit}</small>
        </span>
        {series.length > 1 ? (
          <svg className="spark" viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label={`Évolution : de ${vals[0]} à ${vals.at(-1)} ${s.unit}`}>
            <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
          </svg>
        ) : null}
      </div>
      {pct !== null ? (
        <div className="bar" role="meter" aria-valuemin={0} aria-valuemax={s.max} aria-valuenow={s.value} aria-label={`${s.metric} ${s.value} ${s.unit}`}>
          <div className="bar-fill" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {s.items?.length ? (
        <dl className="kv">
          {s.items.map((i) => (
            <React.Fragment key={i.label}>
              <dt className="mono">{i.label}</dt>
              <dd>{i.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : b.status === "working" ? (
        <div className="skel-stack">
          <Skel w="80%" />
          <Skel w="60%" />
        </div>
      ) : null}
      <Actions b={b} readOnly={readOnly} />
    </div>
  );
}

function Search({ b }: { b: B<"search"> }) {
  const store = useStore();
  const s = b.state;
  return (
    <div className="bubble-body">
      <span className="query">« {s.query} »</span>
      <div className="sources">
        {(s.results ?? []).map((r) => {
          const p = r.preview;
          return (
            <a key={r.url} className="source" href={r.url} target="_blank" rel="noopener noreferrer" title={p?.excerpt ?? r.snippet}>
              {p?.image ? (
                <img src={store.client.resolveUrl(p.image) ?? undefined} alt="" loading="lazy" className="source-img" />
              ) : s.previews_done || p ? (
                <div className="source-img source-img-none" aria-hidden="true">
                  {(p?.site_name ?? r.site ?? "?").slice(0, 1).toUpperCase()}
                </div>
              ) : (
                <div className="skel source-img" aria-hidden="true" />
              )}
              <span className="source-site">
                {p?.favicon ? <img src={store.client.resolveUrl(p.favicon) ?? undefined} alt="" width={14} height={14} /> : null}
                {p?.site_name ?? r.site}
              </span>
              <span className="source-title">{p?.title ?? r.title}</span>
              <span className="sr-only">{r.snippet}</span>
            </a>
          );
        })}
      </div>
      <span className="fine">
        {s.took_ms ? `${s.took_ms} ms · ${s.engines.join(", ")} · ` : ""}Les sources se montrent, elles ne se citent pas.
      </span>
    </div>
  );
}

function Timer({ b }: { b: B<"timer"> }) {
  const now = useNow(b.status !== "done");
  const start = Date.parse(b.state.started_at);
  const end = Date.parse(b.state.ends_at);
  const total = Math.max(1, end - start);
  const left = Math.max(0, end - now);
  const pct = b.status === "done" ? 100 : Math.min(100, ((total - left) / total) * 100);
  return (
    <div className="bubble-body">
      <div className="metric">
        <span className="metric-value timer-value" aria-live="off">{b.status === "done" ? "00:00" : fmtDuration(left)}</span>
        <span className="fine">{b.state.label}</span>
      </div>
      <div className="bar">
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="fine">Fin : {new Date(end).toLocaleTimeString("fr-CH", { hour: "2-digit", minute: "2-digit" })}</span>
    </div>
  );
}

function Script({ b }: { b: B<"script"> }) {
  const s = b.state;
  return (
    <div className="bubble-body">
      <code className="mono blue">
        {s.host ? `${s.host} $ ` : "$ "}
        {s.command}
      </code>
      <pre className="log" aria-label="Fin du journal">
        {(s.log_tail ?? []).slice(-8).join("\n") || " "}
      </pre>
      {s.exit_code != null ? <span className={`chip ${s.exit_code === 0 ? "ok" : "ko"}`}>code de sortie {s.exit_code}</span> : null}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function Media({ b }: { b: B<"media"> }) {
  const store = useStore();
  const s = b.state;
  // `bubble_show` (noyau 19.10) : une PAGE montrée = carte d'aperçu cliquable (OpenGraph), pas une vidéo.
  const isPage = (s.mime ?? "").startsWith("text/html");
  const p = s.preview;
  const image = store.client.resolveUrl(s.poster ?? p?.image ?? null);
  const site = p?.site_name || hostOf(s.url);
  if (isPage) {
    return (
      <div className="bubble-body">
        <a className="link-card" href={s.url} target="_blank" rel="noopener noreferrer" aria-label={`Ouvrir ${p?.title ?? b.title}`}>
          {image ? (
            <img src={image} alt="" className="link-card-img" />
          ) : b.status === "working" ? (
            <div className="skel link-card-img" />
          ) : (
            <div className="link-card-img source-img-none" aria-hidden="true">
              {site.slice(0, 1).toUpperCase()}
            </div>
          )}
          <span className="link-card-text">
            <span className="source-site">
              {p?.favicon ? <img src={store.client.resolveUrl(p.favicon) ?? undefined} alt="" width={14} height={14} /> : null}
              {site}
            </span>
            <span className="link-card-title">{p?.title ?? b.title}</span>
            {p?.description ? <span className="link-card-desc">{p.description}</span> : null}
          </span>
        </a>
      </div>
    );
  }
  return (
    <div className="bubble-body">
      <a className="media" href={s.url} target="_blank" rel="noopener noreferrer" aria-label={`Ouvrir ${b.title}`}>
        {image ? <img src={image} alt="" className="media-img" /> : <div className="skel media-img" />}
        <span className="media-play" aria-hidden="true">
          <Icon name="play" size={22} />
        </span>
      </a>
      <span className="fine">
        {p?.site_name ?? ""} · {s.mime}
      </span>
    </div>
  );
}

function Notify({ b }: { b: B<"notify"> }) {
  const store = useStore();
  return (
    <div className="bubble-body">
      <p className="notify-text">{b.state.text}</p>
      <div className="bubble-actions">
        {b.state.actions.map((a) => (
          <button key={a.id} type="button" className={`btn ${a.primary ? "btn-brass" : ""}`} onClick={() => void store.runAction(b, a.id)}>
            {a.label}
          </button>
        ))}
        <button type="button" className="btn btn-ghost" onClick={() => store.gotoFromNotify(b)}>
          <Icon name="goto" /> Aller à la session
        </button>
      </div>
    </div>
  );
}

function AgentDraft({ b, readOnly }: { b: B<"agent_draft">; readOnly: boolean }) {
  const s = b.state;
  const rows: [string, React.ReactNode, boolean][] = [
    ["Nom", <span className="agent-name">{s.name}</span>, !!s.name],
    ["Rôle", s.role, !!s.role],
    ["Modèle", <span className="mono cyan">{s.model}</span>, !!s.model],
    ["Outils", <span className="tools">{s.tools.map((t) => <span key={t} className="chip">{t}</span>)}</span>, s.tools.length > 0],
  ];
  return (
    <div className="bubble-body">
      <dl className="agent-grid">
        {rows.map(([k, v, has]) => (
          <React.Fragment key={k}>
            <dt>{k}</dt>
            <dd>{has ? v : <Skel w="60%" h={12} />}</dd>
          </React.Fragment>
        ))}
      </dl>
      <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(s.fill * 100)} aria-label="Remplissage de la carte">
        <div className="bar-fill" style={{ width: `${s.fill * 100}%` }} />
      </div>
      <span className="fine">À l'activation, la carte se réduit et rejoint le deck Crew.</span>
      <Actions b={b} readOnly={readOnly} />
    </div>
  );
}

function ApprovalBody({ b }: { b: B<"approval"> }) {
  return <ApprovalCard approvalId={b.state.approval_id} rev={b.version} uid={b.id} />;
}

export function ApprovalCard({ approvalId, rev, uid }: { approvalId: string; rev?: number; uid: string }) {
  const store = useStore();
  const [a, setA] = useState<Approval | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [totp, setTotp] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    store.getApproval(approvalId).then((x) => live && setA(x), (e) => live && setErr(e instanceof NokkerApiError && e.status === 404 ? "Carte introuvable ou réservée à un autre compte." : String(e)));
    return () => {
      live = false;
    };
  }, [approvalId, rev, reload, store]);
  if (!a) return <div className="bubble-body">{err ? <span className="error">{err}</span> : <Skel />}</div>;
  const pending = a.status === "pending";
  const go = async (decision: "approve" | "reject", withTotp: boolean): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await store.decide(a, decision, withTotp ? totp : undefined);
      setReload((n) => n + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const canSign = store.authMode !== "demo" && store.authMode !== null;
  return (
    <div className="bubble-body">
      <p className="notify-text">{a.reason}</p>
      <dl className="kv">
        <dt>Outil</dt>
        <dd className="mono">{a.tool_name}</dd>
        <dt>Effet</dt>
        <dd>{a.effect} · niveau {a.strength}</dd>
      </dl>
      {a.advice ? <p className="fine">{a.advice}</p> : null}
      {pending ? (
        <>
          {canSign ? (
            <div className="bubble-actions">
              <button type="button" className="btn btn-brass" disabled={busy} onClick={() => void go("approve", false)}>
                <Icon name="shield" /> Approuver (appareil)
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void go("reject", false)}>
                Refuser
              </button>
            </div>
          ) : null}
          {a.strength === "standard" ? (
            <form
              className="totp"
              onSubmit={(e) => {
                e.preventDefault();
                void go("approve", true);
              }}
            >
              <label htmlFor={`totp-${uid}`}>Code TOTP</label>
              <input id={`totp-${uid}`} inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))} autoComplete="one-time-code" />
              <button type="submit" className="btn btn-brass" disabled={busy || totp.length !== 6}>
                Approuver
              </button>
              <button type="button" className="btn" disabled={busy || totp.length !== 6} onClick={() => void go("reject", true)}>
                Refuser
              </button>
            </form>
          ) : null}
        </>
      ) : (
        <span className={`chip ${a.status === "executed" || a.status === "approved" ? "ok" : "ko"}`}>{a.status}</span>
      )}
      {err ? <span className="error" role="alert">{err}</span> : null}
    </div>
  );
}

export function BubbleBody({ b, readOnly }: { b: Bubble; readOnly: boolean }): React.ReactElement {
  switch (b.kind) {
    case "monitor":
      return <Monitor b={b} readOnly={readOnly} />;
    case "search":
      return <Search b={b} />;
    case "timer":
      return <Timer b={b} />;
    case "script":
      return <Script b={b} />;
    case "media":
      return <Media b={b} />;
    case "notify":
      return <Notify b={b} />;
    case "agent_draft":
      return <AgentDraft b={b} readOnly={readOnly} />;
    case "approval":
      return <ApprovalBody b={b} />;
  }
}
