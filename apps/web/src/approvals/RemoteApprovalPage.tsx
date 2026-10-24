/**
 * Page `/approve/<machine_id>/<approval_id>` d'app.nokker.ai : une carte FORTE posée sur une machine liée, signée ici
 * par l'appareil enrôlé de ce navigateur (passkey ou clé d'appareil). nokker.ai ne fait que transmettre (`forwarded`) ; le verdict vient du Lokkal qui a
 * vérifié la preuve (LOKKAL §7.3). Variante `/approve?host=…&approval=…` : lien de la bulle sur la passerelle.
 */
import React, { useCallback, useEffect, useState } from "react";
import { BRAND } from "@nokker-apps/brand";
import { NokkerApiError, type RemoteApproval } from "@nokker-apps/sdk";
import { useNokker } from "../store.js";
import { uiLang } from "../components/ConnectorsTab.js";
import { Welcome } from "../welcome/Welcome.js";
import { isFinal, minutesLeftUntil, remoteTargetFrom } from "./remote.js";

type View =
  | { kind: "loading" }
  | { kind: "bad" }
  | { kind: "missing" }
  | { kind: "failed" }
  | { kind: "card"; machineId: string; machineName: string; a: RemoteApproval };

const POLL_MS = 3000;

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
      // Même message signé qu'une décision locale (`<challenge>.<decision>`) : passkey ou clé d'appareil.
      const p = await signDecision(view.a.challenge, decision);
      const proof = p.webauthn
        ? { device_id: p.device_id, webauthn_client_data_json: p.webauthn.client_data_json, webauthn_authenticator_data: p.webauthn.authenticator_data, webauthn_signature: p.webauthn.signature }
        : p.signature !== undefined
          ? { device_id: p.device_id, signature: p.signature }
          : null;
      if (!proof) throw new Error("preuve");
      await client.decideMachineApproval(view.machineId, view.a.approval_id, decision, proof);
      setView({ ...view, a: { ...view.a, status: "forwarded" } });
    } catch (e) {
      if (e instanceof NokkerApiError && e.status === 409) await load();
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
        <h1 id="ra-title" className="ob-title">Approbation forte</h1>
        {view.kind === "loading" ? <p className="ob-status" role="status">Chargement…</p> : null}
        {view.kind === "bad" ? <p className="ob-error" role="alert">Ce lien d'approbation n'est pas valide.</p> : null}
        {view.kind === "missing" ? (
          <p className="ob-error" role="alert">Cette demande n'existe pas sur une machine de ce compte, ou elle a déjà disparu.</p>
        ) : null}
        {view.kind === "failed" ? (
          <div role="alert">
            <p className="ob-error">La demande n'a pas pu se charger.</p>
            <button type="button" className="ob-btn" onClick={() => void load()}>Réessayer</button>
          </div>
        ) : null}
        {view.kind === "card" ? (
          <section>
            <p className="ra-machine">
              Machine <strong>{view.machineName}</strong>
            </p>
            <p className="lk-machine">{view.a.title}</p>
            <p>{view.a.reason}</p>
            {view.a.status === "pending" ? (
              <>
                <p className="ob-hint">Expire dans environ {minutesLeftUntil(view.a.expires_at, Date.now())} min. Ton appareil te demandera de confirmer.</p>
                {err ? <p className="ob-error" role="alert">{err}</p> : null}
                {signDecision ? (
                  <div className="lk-actions">
                    <button type="button" className="ob-btn primary" disabled={busy} onClick={() => void decide("approve")}>
                      {busy ? "Signature…" : "Approuver"}
                    </button>
                    <button type="button" className="ob-btn danger" disabled={busy} onClick={() => void decide("reject")}>
                      Refuser
                    </button>
                  </div>
                ) : (
                  <p className="ob-error" role="alert">Aucun appareil enrôlé sur ce navigateur : ouvre ce lien sur un appareil enrôlé.</p>
                )}
              </>
            ) : null}
            {view.a.status === "forwarded" ? (
              <p className="ob-status" role="status">
                Transmis à ta machine. Le résultat s'affiche dès qu'elle l'a vérifié (elle doit être allumée).
              </p>
            ) : null}
            {isFinal(view.a.status) ? (
              <p className={`ra-final ra-${view.a.status}`} role="status">
                {view.a.status === "approved" ? "Approuvé : ta machine a vérifié et exécute l'action." : view.a.status === "rejected" ? "Refusé : l'action n'a pas lieu." : "Expirée : la demande n'a pas été décidée à temps."}
              </p>
            ) : null}
          </section>
        ) : null}
        <a className="ob-btn" href="/machines">Mes machines</a>
      </main>
    </div>
  );
}
