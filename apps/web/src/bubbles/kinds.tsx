/**
 * Rendu du corps des bulles, par `kind` (BUBBLES.md §2). Un champ inconnu de `state` est ignoré ; un
 * champ attendu absent ne casse rien (le noyau peut remplir l'état en plusieurs `bubble.updated`).
 */
import { Markdown } from "../Markdown.js";
import { liveTail, strongCardText } from "@nokker-apps/sdk";
import { gatewayContext, remoteApprovalUrl } from "../auth.js";
import React, { useEffect, useRef, useState } from "react";
import { NokkerApiError, type Approval, type Bubble, type BubbleBase } from "@nokker-apps/sdk";
import { useStore } from "../context.js";
import { Icon } from "../icons.js";
import { PublishPanel } from "../publish/PublishPanel.js";
import { PackAgents } from "../packs/PackAgents.js";

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
    case "artifact":
      return b.status === "working" ? "écrit" : `v${b.state.version ?? 1}`;
    case "notify":
      return b.state.from_title;
    case "agent_draft":
      return b.status === "working" ? "Nina remplit" : "prête";
    case "approval":
      return b.status === "working" ? "en attente" : b.status === "done" ? "approuvée" : b.status === "failed" ? "refusée" : b.status;
    case "handoff":
      return HANDOFF_LABEL[b.state.state] ?? b.state.state;
    case "plan_split":
      return SPLIT_LABEL[b.state.state] ?? b.state.state;
    case "brief":
      return b.state.date ? new Date(b.state.date).toLocaleDateString("fr-CH", { weekday: "short", day: "numeric", month: "short" }) : "brief";
    default:
      return (b as { status: string }).status;
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

/**
 * Page créée en session (BUBBLES.md §10). Le state ne porte JAMAIS le HTML : on demande au noyau un lien signé
 * neuf à chaque montage et à chaque `bubble.updated` (usage court), et l'iframe reste en sandbox sans
 * `allow-same-origin` — la page vit sur une origine séparée et ne touche ni la session ni le DOM de l'app.
 */
function Artifact({ b }: { b: B<"artifact"> }) {
  const store = useStore();
  const s = b.state;
  const pageId = s.page_id;
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [busy, setBusy] = useState<"download" | null>(null);
  const [dl, setDl] = useState<string | null>(null);
  const writing = (s as { writing?: { call_id: string } }).writing;
  const live = writing ? store.liveInputs.get(writing.call_id) : undefined;
  // Capacité d'URL expirée (relais, 1 h) : la page d'erreur du relais poste `nokker:pages-expired` ; on redemande un
  // lien, au plus une fois par minute (la page elle-même pourrait envoyer ce message en boucle).
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [relink, setRelink] = useState(0);
  const lastRelink = useRef(0);
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frameRef.current?.contentWindow) return;
      if ((e.data as { type?: unknown } | null)?.type !== "nokker:pages-expired") return;
      if (Date.now() - lastRelink.current < 60_000) return;
      lastRelink.current = Date.now();
      setRelink((n) => n + 1);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  useEffect(() => {
    if (!pageId) return;
    let live = true;
    setFailed(false);
    store.client
      .getPageLink(pageId, { embed: true })
      .then((l) => live && setSrc(store.client.resolveUrl(l.url)))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
    // Version de la PAGE (pas de la bulle) : une bulle qui passe en `writing`, se publie ou se renomme ne recharge pas
    // l'aperçu ; seule une nouvelle version écrite le recharge (X22, BUBBLES §10.2).
  }, [store.client, pageId, s.version, relink]);

  const open = async () => {
    if (!pageId || opening) return;
    setOpening(true);
    const w = window.open("", "_blank");
    try {
      const l = await store.client.getPageLink(pageId);
      if (w) {
        w.opener = null;
        w.location.href = store.client.resolveUrl(l.url) ?? l.url;
      }
    } catch {
      w?.close();
      setFailed(true);
    } finally {
      setOpening(false);
    }
  };

  // Téléchargement : lien `download` à usage unique, chargé dans un iframe caché sandboxé qui n'a droit qu'au
  // téléchargement (pièce jointe) — une réponse d'erreur s'y afficherait sans quitter l'app ni exécuter de script.
  const download = async () => {
    if (!pageId || busy) return;
    setBusy("download");
    try {
      const l = await store.client.getPageLink(pageId, { download: true });
      setDl(store.client.resolveUrl(l.url) ?? l.url);
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bubble-body artifact">
      <div className="artifact-frame">
        {src && !failed ? (
          <iframe
            ref={frameRef}
            key={src}
            className="artifact-iframe"
            src={src}
            title={s.title || b.title}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
        ) : failed ? (
          <p className="fine artifact-fail">L'aperçu n'a pas pu se charger — ouvre la page dans un onglet.</p>
        ) : (
          <div className="skel artifact-iframe" />
        )}
        {live ? (
          // X22 : le texte qui s'écrit, en vue code — jamais exécuté (pas de srcdoc), l'iframe reste montée dessous.
          <pre className="artifact-code" aria-label={`Écriture en cours de ${s.path}`}>
            {liveTail(live.text, 40, 200).join("\n")}
            {live.truncated ? "\n…" : ""}
          </pre>
        ) : null}
        {b.status === "working" ? <span className="artifact-writing">écriture…</span> : null}
      </div>
      <div className="artifact-meta fine">
        <span>
          {s.path} · v{s.version ?? 1}
        </span>
        <span className={`artifact-vis ${s.public ? "is-public" : ""}`}>{s.public ? "publique" : "privée"}</span>
      </div>
      <div className="bubble-actions">
        <button type="button" className="btn" disabled={!pageId || opening} onClick={() => void open()}>
          <Icon name="goto" /> Ouvrir
        </button>
        <button type="button" className="btn" disabled={!pageId || busy !== null} onClick={() => void download()}>
          Télécharger
        </button>
        {b.actions.map((a) => (
          <button key={a.id} type="button" className={`btn ${a.primary ? "btn-brass" : ""}`} onClick={() => void store.runAction(b, a.id)}>
            {a.label}
          </button>
        ))}
      </div>
      {pageId ? <PublishPanel client={store.client} state={s} authMode={store.authMode} toast={store.toast} /> : null}
      {dl ? <iframe key={dl} className="artifact-dl" src={dl} title="" aria-hidden="true" sandbox="allow-downloads" /> : null}
    </div>
  );
}

function PackAgentsBody({ b }: { b: B<"pack_agents"> }) {
  const store = useStore();
  return <PackAgents b={b} onAction={(id) => void store.runAction(b, id)} />;
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
    // En local, `forwarded` est calculé par le noyau dans la liste des cartes locales (pas forcément sur la carte seule).
    const read = async (): Promise<Approval> => {
      const x = await store.getApproval(approvalId);
      if (store.authMode !== "local" || x.forwarded !== undefined) return x;
      const l = await store.client.listLocalApprovals().catch(() => []);
      const f = l.find((y) => y.id === approvalId)?.forwarded;
      return f === undefined ? x : { ...x, forwarded: f };
    };
    read().then((x) => live && setA(x), (e) => live && setErr(e instanceof NokkerApiError && e.status === 404 ? "Carte introuvable ou réservée à un autre compte." : String(e)));
    return () => {
      live = false;
    };
  }, [approvalId, rev, reload, store]);
  if (!a) return <div className="bubble-body">{err ? <span className="error">{err}</span> : <Skel />}</div>;
  const pending = a.status === "pending";
  const guardLocal = async (decision: "approve" | "reject", scope: "once" | "session"): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await store.decideLocal(a, decision, scope);
      setReload((n) => n + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
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
  // Par la passerelle, cette origine n'a pas de clé d'appareil : l'approbation forte se signe là où elle existe
  // (app.nokker.ai ou le téléphone, LOKKAL.md §7.3).
  const viaGateway = store.authMode === "gateway";
  const gwHost = viaGateway ? gatewayContext() : null;
  const local = store.authMode === "local";
  const canSign = store.authMode !== "demo" && store.authMode !== null && !viaGateway && !local;
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
          {local && a.strength !== "strong" ? (
            <div className="bubble-actions">
              <button type="button" className="btn btn-brass" disabled={busy} onClick={() => void guardLocal("approve", "once")}>
                Approuver une fois
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void guardLocal("approve", "session")}>
                Pour la session
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void guardLocal("reject", "once")}>
                Refuser
              </button>
            </div>
          ) : local ? (
            <p className="fine">{strongCardText({ forwarded: a.forwarded === true || store.forwardedApprovals.has(a.id) }).replace(/`/g, "")}</p>
          ) : null}
          {viaGateway && gwHost ? (
            <p className="fine">
              Approbation forte : confirme-la depuis un appareil enrôlé.{" "}
              <a href={remoteApprovalUrl(gwHost, a.id)} target="_blank" rel="noopener noreferrer">
                Ouvrir sur app.nokker.ai
              </a>
            </p>
          ) : null}
          {a.strength === "standard" && !viaGateway && store.authMode !== "local" ? (
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

const HANDOFF_LABEL: Record<string, string> = {
  proposed: "proposé",
  waiting: "attend la machine",
  accepted: "accepté",
  running: "en cours",
  awaiting_approval: "attend ta décision",
  done: "terminé",
  refused: "refusé",
  expired: "expiré",
  failed: "échec",
};
const NEED_LABEL: Record<string, string> = { repo: "dépôt", host: "hôte", connector: "connecteur", mcp: "serveur MCP" };

/** X21 (LOKKAL §7.16) : la session web propose de passer le relais à la machine qui a la ressource. L'utilisateur seul
 * décide ; la machine travaille avec SES permissions ; seule sa réponse finale revient ici. Actions selon l'état. */
const SPLIT_LABEL: Record<string, string> = { proposed: "à décider", accepted: "cartes créées", refused: "refusé", stale: "carte disparue" };

/** X18 : découpage proposé par le modèle. Seul l'humain crée les cartes (actions accept/refuse, en direct). */
function PlanSplit({ b, readOnly }: { b: B<"plan_split">; readOnly: boolean }) {
  const s = b.state;
  return (
    <div className="bubble-body plan-split">
      <p className="fine">
        Carte « <strong>{s.card_title}</strong> » en {s.children.length} :
      </p>
      <ol className="plan-split-list">
        {s.children.map((c, i) => (
          <li key={i}>
            <strong>{c.title}</strong>
            {c.intent ? <span className="fine"> — {c.intent}</span> : null}
            {c.constraints.length ? <span className="fine"> · {c.constraints.join(" · ")}</span> : null}
          </li>
        ))}
      </ol>
      {s.reason ? <p className="fine">Pourquoi : {s.reason}</p> : null}
      {s.state === "proposed" ? <Actions b={b} readOnly={readOnly} /> : <p className="fine">{SPLIT_LABEL[s.state] ?? s.state}.</p>}
    </div>
  );
}

function Handoff({ b }: { b: B<"handoff"> }) {
  const store = useStore();
  const s = b.state;
  const actions =
    s.state === "proposed"
      ? b.actions
      : s.state === "waiting"
        ? b.actions.filter((a) => a.id === "refuse").map((a) => ({ ...a, label: "Annuler", primary: false }))
        : [];
  return (
    <div className="bubble-body handoff">
      <p className="handoff-task">{s.task}</p>
      <dl className="kv">
        <dt>Besoin</dt>
        <dd>
          {NEED_LABEL[s.need.kind] ?? s.need.kind} <code>{s.need.name}</code>
        </dd>
        <dt>Machine</dt>
        <dd>
          {s.machine_name} <span className={`chip ${s.online ? "ok" : ""}`}>{s.online ? "en ligne" : "hors ligne"}</span>
        </dd>
      </dl>
      {!s.online && (s.state === "proposed" || s.state === "waiting") ? (
        <p className="fine">La machine est éteinte : la demande attendra qu'elle revienne (24 h au plus).</p>
      ) : null}
      {s.state === "proposed" ? <p className="fine">Elle travaillera avec ses propres permissions ; seule sa réponse finale reviendra ici.</p> : null}
      {s.pending_approvals > 0 ? (
        <p className="fine">
          {s.pending_approvals} carte{s.pending_approvals > 1 ? "s" : ""} en attente sur la machine : elles arrivent sur ton téléphone.
        </p>
      ) : null}
      {s.reply ? (
        <div className="handoff-reply">
          <span className="eyebrow">Réponse de « {s.machine_name} »</span>
          <Markdown text={s.reply} />
        </div>
      ) : null}
      {s.error ? (
        <p className="error" role="alert">
          {s.error}
        </p>
      ) : null}
      {actions.length ? (
        <div className="bubble-actions">
          {actions.map((a) => (
            <button key={a.id} type="button" className={`btn ${a.primary ? "btn-brass" : ""}`} onClick={() => void store.runAction(b, a.id)}>
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
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
    case "artifact":
      return <Artifact b={b} />;
    case "notify":
      return <Notify b={b} />;
    case "agent_draft":
      return <AgentDraft b={b} readOnly={readOnly} />;
    case "approval":
      return <ApprovalBody b={b} />;
    case "handoff":
      return <Handoff b={b} />;
    case "plan_split":
      return <PlanSplit b={b} readOnly={readOnly} />;
    case "pack_agents":
      return <PackAgentsBody b={b} />;
    case "brief":
      return (
        <div className="bubble-body brief">
          <Markdown text={b.state.text || "(brief vide)"} />
        </div>
      );
    default:
      return (
        <div className="bubble-body">
          <p className="fine">Ce type de bulle n'est pas géré par cette version de l'app.</p>
        </div>
      );
  }
}
