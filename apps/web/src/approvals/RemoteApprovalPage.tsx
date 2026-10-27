/**
 * Page `/approve/<machine_id>/<approval_id>` d'app.nokker.ai : une carte FORTE posée sur une machine liée, signée ici
 * par la passkey de cet appareil (vérification de l'utilisateur exigée ; une signature de clé simple est refusée sur
 * une carte forte). nokker.ai ne fait que transmettre (`forwarded`) ; le verdict vient du Lokkal qui a vérifié la
 * preuve (LOKKAL §7.3, X10). Ce qui part est dit par nokker.ai quand il a lu les arguments (X20c, §7.12 point 8) ; le
 * texte de la machine reste au second plan. Variante `/approve?host=…&approval=…` : lien de la bulle sur la passerelle.
 * Navigateur intégré d'une appli (Telegram, Instagram…) ou sans WebAuthn : la passkey n'y marche pas, la page dit
 * d'ouvrir le lien dans Safari ou Chrome (bouton « Copier le lien ») au lieu de demander une connexion vaine.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { BRAND } from "@nokker-apps/brand";
import { NokkerApiError, type RemoteApproval } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import { useNokker } from "../store.js";
import { uiLang } from "../components/ConnectorsTab.js";
import { Welcome } from "../welcome/Welcome.js";
import { browserEnv, classBanner, isAccountConnectorTool, isFinal, minutesLeftUntil, raText, remoteTargetFrom, shortSha, signBlocker, truncatedSuffix, type RaLang } from "./remote.js";
import { OpenElsewhere } from "./OpenElsewhere.js";
import { MiniAppBlock } from "./MiniAppBlock.js";

type View =
  | { kind: "loading" }
  | { kind: "bad" }
  | { kind: "missing" }
  | { kind: "failed" }
  | { kind: "card"; machineId: string; machineName: string; a: RemoteApproval };

const POLL_MS = 3000;

const apiCode = (e: unknown): string | undefined => {
  if (!(e instanceof NokkerApiError)) return undefined;
  const b = e.body as { error?: string | { code?: string; message?: string } } | undefined;
  return typeof b?.error === "string" ? b.error : b?.error?.code ?? b?.error?.message;
};

export function RemoteApprovalPage(): React.ReactElement {
  const store = useNokker();
  const L = uiLang();
  const { client, access, signDecision } = store;
  const [target] = useState(() => remoteTargetFrom(location.pathname, location.search));
  const [view, setView] = useState<View>(target ? { kind: "loading" } : { kind: "bad" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const blocker = useMemo(() => signBlocker(browserEnv()), []);
  // Seul un navigateur qui a DÉJÀ une passkey signe ici ; sinon la carte forte se signe dans la Mini App Telegram.
  const passkey = store.authMode === "passkey";

  const load = useCallback(async (): Promise<void> => {
    if (!target) return;
    try {
      const { machines } = await client.listMachines();
      const mc = target.kind === "id" ? machines.find((m) => m.machine_id === target.machineId) : machines.find((m) => m.host === target.host);
      if (!mc) return setView({ kind: "missing" });
      const a = await client.getMachineApproval(mc.machine_id, target.approvalId);
      setView({ kind: "card", machineId: mc.machine_id, machineName: mc.name, a });
    } catch (e) {
      setView(e instanceof NokkerApiError && e.status === 404 ? { kind: "missing" } : { kind: "failed" });
    }
  }, [client, target]);

  useEffect(() => {
    if (access === "ready") void load();
  }, [access, load]);

  // Transmise : on relève le verdict du Lokkal (il arrive quand la machine est allumée, ou jamais avant expiration).
  const status = view.kind === "card" ? view.a.status : null;
  useEffect(() => {
    if (status !== "forwarded") return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [status, load]);

  if (access !== "ready" && access !== "booting") {
    // Se connecter dans un navigateur intégré ne mènerait à rien : on dit d'abord où ouvrir le lien.
    if (blocker && target) {
      return (
        <Frame>
          <MiniAppBlock lang={L} heading target={target.kind === "id" ? target : { host: target.host, approvalId: target.approvalId }} />
          <OpenElsewhere lang={L} blocker={blocker} secondary />
        </Frame>
      );
    }
    return <Welcome {...store} lang={L} />;
  }

  const decide = async (decision: "approve" | "reject"): Promise<void> => {
    if (view.kind !== "card" || !signDecision) return;
    setBusy(true);
    setErr(null);
    try {
      // Même message signé qu'une décision locale (`<challenge>.<decision>`) ; carte forte = passkey (uv).
      const p = await signDecision(view.a.challenge, decision);
      if (!p.webauthn) throw new Error("no-passkey");
      await client.decideMachineApproval(view.machineId, view.a.approval_id, decision, {
        device_id: p.device_id,
        webauthn_client_data_json: p.webauthn.client_data_json,
        webauthn_authenticator_data: p.webauthn.authenticator_data,
        webauthn_signature: p.webauthn.signature,
      });
      setView({ ...view, a: { ...view.a, status: "forwarded", error: null } });
    } catch (e) {
      const code = apiCode(e);
      // Appareil sans passkey (clé de session ouverte par code mail) : il ne décide jamais d'une carte forte.
      if (e instanceof Error && e.message === "no-passkey") setErr(raText(L, "loginOnly"));
      else if (e instanceof NokkerApiError && e.status === 409) await load();
      else if (code === "strong_approval_required" || code === "strong_device_required") setErr(raText(L, "loginOnly"));
      else setErr(tr("The decision could not be forwarded. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame>
        {view.kind === "loading" ? <p className="ob-status" role="status">{tr("Loading…")}</p> : null}
        {view.kind === "bad" ? <p className="ob-error" role="alert">{tr("This approval link is not valid.")}</p> : null}
        {view.kind === "missing" ? (
          <p className="ob-error" role="alert">{tr("This request does not exist on a machine of this account, or it has already gone.")}</p>
        ) : null}
        {view.kind === "failed" ? (
          <div role="alert">
            <p className="ob-error">{tr("The request could not be loaded.")}</p>
            <button type="button" className="ob-btn" onClick={() => void load()}>
              {tr("Retry")}
            </button>
          </div>
        ) : null}
        {view.kind === "card" ? <Card v={view} busy={busy} err={err} canSign={!!signDecision} passkey={passkey} lang={L} blocker={blocker} onDecide={decide} /> : null}
        <a className="ob-btn" href="/machines">
          {tr("My machines")}
        </a>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="ob">
      <main className="ob-card wl-card ra-card" aria-labelledby="ra-title">
        <header className="wl-logo">
          <img className="only-light" src="/brand/nokker-emblem-light.svg" alt="" width={56} height={56} />
          <img className="only-dark" src="/brand/nokker-emblem-dark.svg" alt="" width={56} height={56} />
          <span className="ob-brand">{BRAND.productName}</span>
        </header>
        {children}
      </main>
    </div>
  );
}

function Card({
  v,
  busy,
  err,
  canSign,
  passkey,
  lang,
  blocker,
  onDecide,
}: {
  v: Extract<View, { kind: "card" }>;
  busy: boolean;
  err: string | null;
  canSign: boolean;
  passkey: boolean;
  lang: RaLang;
  blocker: ReturnType<typeof signBlocker>;
  onDecide: (d: "approve" | "reject") => Promise<void>;
}): React.ReactElement {
  const a = v.a;
  const s = a.summary;
  const fromCloud = a.summary_source === "nokker.ai";
  const erased = !!s?.erased || isFinal(a.status);
  const banner = classBanner(s?.class);
  const headline = fromCloud && s?.headline ? s.headline : null;
  return (
    <section>
      <h1 id="ra-title" className="ob-title">
        {headline ?? tr("Strong approval")}
      </h1>
      <p className="ra-machine">
        {tr("Machine")} <strong>{v.machineName}</strong>
        {s?.tool ? (
          <>
            {" "}
            · {tr("tool")} <code>{s.tool}</code>
          </>
        ) : null}
      </p>
      {banner && !erased ? <p className={`ra-banner ra-${s?.class}`}>{banner}</p> : null}

      {erased ? (
        <p className="fine">{tr("Detail erased after the decision.")}</p>
      ) : fromCloud && s ? (
        <dl className="ra-summary" aria-label={tr("What nokker.ai read from the arguments")}>
          {s.lines.map((l) => (
            <React.Fragment key={l.key}>
              <dt>{l.label}</dt>
              <dd>
                {l.items?.length ? (
                  <ul className="ra-items">
                    {l.items.map((it) => (
                      <li key={it}>{it}</li>
                    ))}
                    {l.count && l.count > l.items.length ? <li className="fine">+ {l.count - l.items.length}</li> : null}
                  </ul>
                ) : (
                  <span className="ra-value">
                    {l.value}
                    {l.truncated ? <span className="fine"> {truncatedSuffix(l.length)}</span> : null}
                  </span>
                )}
                {l.redacted ? <span className="ra-redacted"> {tr("secret redacted")}</span> : null}
              </dd>
            </React.Fragment>
          ))}
        </dl>
      ) : (
        <div className="ra-local">
          <p className="fine">
            {tr("The arguments stayed on your machine; only it can execute.")}
            {a.args_sha256 ? (
              <>
                {" "}
                {tr("Fingerprint")} <code title={a.args_sha256}>{shortSha(a.args_sha256)}</code>
              </>
            ) : null}
          </p>
          {isAccountConnectorTool(s?.tool) ? (
            <p className="ob-error">{tr("This card does not show its arguments: nokker.ai will refuse to send it.")}</p>
          ) : null}
        </div>
      )}

      {/* Texte de la machine : second plan, texte brut (jamais du HTML ni du Markdown). */}
      <div className={`ra-machine-text ${headline ? "secondary" : ""}`}>
        <span className="ra-label">{tr("Described by your machine")}</span>
        <p className="ra-title">{a.title}</p>
        {!erased && a.reason ? <p className="fine">{a.reason}</p> : null}
        {!erased && a.advice ? <p className="fine">{tr("Advice: {0}", a.advice)}</p> : null}
      </div>

      {a.status === "pending" ? (
        <>
          <p className="ob-hint">
            {passkey
              ? tr("Expires in about {0} min. Your passkey will be requested.", minutesLeftUntil(a.expires_at, Date.now()))
              : tr("Expires in about {0} min.", minutesLeftUntil(a.expires_at, Date.now()))}
          </p>
          {a.error ? (
            <p className="ob-error" role="alert">
              {tr("Your machine refused the signature: {0}. Sign again.", a.error)}
            </p>
          ) : null}
          {err ? (
            <p className="ob-error" role="alert">
              {err}
            </p>
          ) : null}
          {!passkey ? (
            <MiniAppBlock lang={lang} target={{ machineId: v.machineId, approvalId: a.approval_id }} />
          ) : blocker ? (
            <OpenElsewhere lang={lang} blocker={blocker} />
          ) : canSign ? (
            <div className="lk-actions">
              <button type="button" className="ob-btn primary" disabled={busy} onClick={() => void onDecide("approve")}>
                {busy ? tr("Signing…") : tr("Approve")}
              </button>
              <button type="button" className="ob-btn danger" disabled={busy} onClick={() => void onDecide("reject")}>
                {tr("Reject")}
              </button>
            </div>
          ) : (
            <p className="ob-error" role="alert">
              {raText(lang, "noDevice")}
            </p>
          )}
        </>
      ) : null}
      {a.status === "forwarded" ? (
        <p className="ob-status" role="status">
          {tr("Forwarded to your machine. The result appears as soon as it has verified it (it must be on).")}
        </p>
      ) : null}
      {isFinal(a.status) ? (
        <p className={`ra-final ra-${a.status}`} role="status">
          {a.status === "approved"
            ? a.outcome === "failed"
              ? tr("Approved, but the action failed on your machine.")
              : a.outcome === "executed"
                ? tr("Approved: your machine executed the action.")
                : tr("Approved: your machine verified it and is executing the action.")
            : a.status === "rejected"
              ? tr("Rejected: the action does not happen.")
              : tr("Expired: the request was not decided in time.")}
        </p>
      ) : null}
    </section>
  );
}
