/**
 * Rendu du corps des bulles, par `kind` (BUBBLES.md §2). Un champ inconnu de `state` est ignoré ; un
 * champ attendu absent ne casse rien (le noyau peut remplir l'état en plusieurs `bubble.updated`).
 */
import { gatewayContext, remoteApprovalUrl } from "../auth.js";
import React, { useEffect, useRef, useState } from "react";
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
    case "artifact":
      return b.status === "working" ? "écrit" : `v${b.state.version ?? 1}`;
    case "notify":
      return b.state.from_title;
    case "agent_draft":
      return b.status === "working" ? "Nina remplit" : "prête";
    case "approval":
      return b.status === "working" ? "en attente" : b.status === "done" ? "approuvée" : b.status === "failed" ? "refusée" : b.status;
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
  const [busy, setBusy] = useState<"download" | "copy" | null>(null);
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [dl, setDl] = useState<string | null>(null);
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
  }, [store.client, pageId, b.version, relink]);

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

  const copyLink = async () => {
    if (!pageId || busy) return;
    setBusy("copy");
    setCopied(null);
    setPublicUrl(null);
    try {
      const l = await store.client.getPageLink(pageId);
      if (!l.public_url) throw new Error("pas d'adresse publique");
      const href = new URL(store.client.resolveUrl(l.public_url) ?? l.public_url, location.href).href;
      // Presse-papiers absent (contexte non sécurisé, permission refusée) : l'adresse s'affiche pour une copie à la main.
      setPublicUrl(href);
      await navigator.clipboard.writeText(href);
      setCopied("ok");
    } catch {
      setCopied("fail");
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
        {s.public ? (
          <button type="button" className="btn" disabled={!pageId || busy !== null} onClick={() => void copyLink()}>
            {copied === "ok" ? "Lien copié" : "Copier le lien"}
          </button>
        ) : null}
        {b.actions.map((a) => (
          <button key={a.id} type="button" className={`btn ${a.primary ? "btn-brass" : ""}`} onClick={() => void store.runAction(b, a.id)}>
            {a.label}
          </button>
        ))}
      </div>
      {copied === "fail" && publicUrl ? (
        <input className="artifact-url mono" readOnly value={publicUrl} aria-label="Adresse publique de la page" autoFocus onFocus={(e) => e.currentTarget.select()} />
      ) : copied === "fail" ? (
        <p className="fine artifact-fail" role="alert">Le lien n'a pas pu être copié.</p>
      ) : null}
      {dl ? <iframe key={dl} className="artifact-dl" src={dl} title="" aria-hidden="true" sandbox="allow-downloads" /> : null}
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
  // Par la passerelle, cette origine n'a pas de clé d'appareil : l'approbation forte se signe là où elle existe
  // (app.nokker.ai ou le téléphone, LOKKAL.md §7.3).
  const viaGateway = store.authMode === "gateway";
  const gwHost = viaGateway ? gatewayContext() : null;
  const canSign = store.authMode !== "demo" && store.authMode !== null && !viaGateway;
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
          {viaGateway && gwHost ? (
            <p className="fine">
              Approbation forte : confirme-la depuis un appareil enrôlé.{" "}
              <a href={remoteApprovalUrl(gwHost, a.id)} target="_blank" rel="noopener noreferrer">
                Ouvrir sur app.nokker.ai
              </a>
            </p>
          ) : null}
          {a.strength === "standard" && !viaGateway ? (
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
    case "artifact":
      return <Artifact b={b} />;
    case "notify":
      return <Notify b={b} />;
    case "agent_draft":
      return <AgentDraft b={b} readOnly={readOnly} />;
    case "approval":
      return <ApprovalBody b={b} />;
    default:
      return (
        <div className="bubble-body">
          <p className="fine">Ce type de bulle n'est pas géré par cette version de l'app.</p>
        </div>
      );
  }
}
