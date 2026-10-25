/**
 * Page `/approve/<machine_id>/<approval_id>` d'app.nokker.ai : une carte FORTE posée sur une machine liée, signée ici
 * par la passkey de cet appareil (vérification de l'utilisateur exigée ; une signature de clé simple est refusée sur
 * une carte forte). nokker.ai ne fait que transmettre (`forwarded`) ; le verdict vient du Lokkal qui a vérifié la
 * preuve (LOKKAL §7.3, X10). Ce qui part est dit par nokker.ai quand il a lu les arguments (X20c, §7.12 point 8) ; le
 * texte de la machine reste au second plan. Variante `/approve?host=…&approval=…` : lien de la bulle sur la passerelle.
 */
import React, { useCallback, useEffect, useState } from "react";
import { BRAND } from "@nokker-apps/brand";
import { NokkerApiError, type RemoteApproval } from "@nokker-apps/sdk";
import { useNokker } from "../store.js";
import { uiLang } from "../components/ConnectorsTab.js";
import { Welcome } from "../welcome/Welcome.js";
import { classBanner, isAccountConnectorTool, isFinal, minutesLeftUntil, remoteTargetFrom, shortSha, truncatedSuffix } from "./remote.js";

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

  if (access !== "ready" && access !== "booting") return <Welcome {...store} lang={L} />;

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
      if (e instanceof Error && e.message === "no-passkey") setErr("Cette carte se signe avec une passkey : ouvre ce lien sur ton téléphone.");
      else if (e instanceof NokkerApiError && e.status === 409) await load();
      else if (code === "strong_approval_required" || code === "strong_device_required") setErr("À signer sur ton téléphone : cet appareil ne peut pas décider d'une carte forte.");
      else setErr("La décision n'a pas pu être transmise. Réessaie.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ob">
      <main className="ob-card wl-card ra-card" aria-labelledby="ra-title">
        <header className="wl-logo">
          <img className="only-light" src="/brand/nokker-emblem-light.svg" alt="" width={56} height={56} />
          <img className="only-dark" src="/brand/nokker-emblem-dark.svg" alt="" width={56} height={56} />
          <span className="ob-brand">{BRAND.productName}</span>
        </header>
        {view.kind === "loading" ? <p className="ob-status" role="status">Chargement…</p> : null}
        {view.kind === "bad" ? <p className="ob-error" role="alert">Ce lien d'approbation n'est pas valide.</p> : null}
        {view.kind === "missing" ? (
          <p className="ob-error" role="alert">Cette demande n'existe pas sur une machine de ce compte, ou elle a déjà disparu.</p>
        ) : null}
        {view.kind === "failed" ? (
          <div role="alert">
            <p className="ob-error">La demande n'a pas pu se charger.</p>
            <button type="button" className="ob-btn" onClick={() => void load()}>
              Réessayer
            </button>
          </div>
        ) : null}
        {view.kind === "card" ? <Card v={view} busy={busy} err={err} canSign={!!signDecision} onDecide={decide} /> : null}
        <a className="ob-btn" href="/machines">
          Mes machines
        </a>
      </main>
    </div>
  );
}

function Card({
  v,
  busy,
  err,
  canSign,
  onDecide,
}: {
  v: Extract<View, { kind: "card" }>;
  busy: boolean;
  err: string | null;
  canSign: boolean;
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
        {headline ?? "Approbation forte"}
      </h1>
      <p className="ra-machine">
        Machine <strong>{v.machineName}</strong>
        {s?.tool ? (
          <>
            {" "}
            · outil <code>{s.tool}</code>
          </>
        ) : null}
      </p>
      {banner && !erased ? <p className={`ra-banner ra-${s?.class}`}>{banner}</p> : null}

      {erased ? (
        <p className="fine">Détail effacé après la décision.</p>
      ) : fromCloud && s ? (
        <dl className="ra-summary" aria-label="Ce que nokker.ai a lu des arguments">
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
                {l.redacted ? <span className="ra-redacted"> secret caviardé</span> : null}
              </dd>
            </React.Fragment>
          ))}
        </dl>
      ) : (
        <div className="ra-local">
          <p className="fine">
            Les arguments sont restés sur ta machine ; seule elle peut exécuter.
            {a.args_sha256 ? (
              <>
                {" "}
                Empreinte <code title={a.args_sha256}>{shortSha(a.args_sha256)}</code>
              </>
            ) : null}
          </p>
          {isAccountConnectorTool(s?.tool) ? (
            <p className="ob-error">Cette carte ne montre pas ses arguments : nokker.ai refusera de l'envoyer.</p>
          ) : null}
        </div>
      )}

      {/* Texte de la machine : second plan, texte brut (jamais du HTML ni du Markdown). */}
      <div className={`ra-machine-text ${headline ? "secondary" : ""}`}>
        <span className="ra-label">Décrit par ta machine</span>
        <p className="ra-title">{a.title}</p>
        {!erased && a.reason ? <p className="fine">{a.reason}</p> : null}
        {!erased && a.advice ? <p className="fine">Avis : {a.advice}</p> : null}
      </div>

      {a.status === "pending" ? (
        <>
          <p className="ob-hint">Expire dans environ {minutesLeftUntil(a.expires_at, Date.now())} min. Ta passkey te sera demandée.</p>
          {a.error ? (
            <p className="ob-error" role="alert">
              Ta machine a refusé la signature : {a.error}. Signe à nouveau.
            </p>
          ) : null}
          {err ? (
            <p className="ob-error" role="alert">
              {err}
            </p>
          ) : null}
          {canSign ? (
            <div className="lk-actions">
              <button type="button" className="ob-btn primary" disabled={busy} onClick={() => void onDecide("approve")}>
                {busy ? "Signature…" : "Approuver"}
              </button>
              <button type="button" className="ob-btn danger" disabled={busy} onClick={() => void onDecide("reject")}>
                Refuser
              </button>
            </div>
          ) : (
            <p className="ob-error" role="alert">
              Aucun appareil enrôlé sur ce navigateur : ouvre ce lien sur ton téléphone.
            </p>
          )}
        </>
      ) : null}
      {a.status === "forwarded" ? (
        <p className="ob-status" role="status">
          Transmis à ta machine. Le résultat s'affiche dès qu'elle l'a vérifié (elle doit être allumée).
        </p>
      ) : null}
      {isFinal(a.status) ? (
        <p className={`ra-final ra-${a.status}`} role="status">
          {a.status === "approved"
            ? a.outcome === "failed"
              ? "Approuvé, mais l'action a échoué sur ta machine."
              : a.outcome === "executed"
                ? "Approuvé : ta machine a exécuté l'action."
                : "Approuvé : ta machine a vérifié et exécute l'action."
            : a.status === "rejected"
              ? "Refusé : l'action n'a pas lieu."
              : "Expirée : la demande n'a pas été décidée à temps."}
        </p>
      ) : null}
    </section>
  );
}
