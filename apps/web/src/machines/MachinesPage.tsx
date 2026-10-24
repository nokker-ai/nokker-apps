/** Page `/machines` (« mes machines ») : les machines Lokkal liées au compte, leur passerelle, et les délier. */
import React, { useCallback, useEffect, useState } from "react";
import type { LinkedMachine } from "@nokker-apps/sdk";
import { BRAND } from "@nokker-apps/brand";
import { uiLang } from "../components/ConnectorsTab.js";
import { linkIssue } from "../link/code.js";
import { t } from "../onboarding/i18n.js";
import { useNokker } from "../store.js";
import { Welcome } from "../welcome/Welcome.js";
import { gatewayHref, linkedOn, seenLabel } from "./model.js";

type Load = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; machines: LinkedMachine[] };

export function MachinesPage(): React.ReactElement {
  const store = useNokker();
  const L = uiLang();
  const { client, access } = store;
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [asking, setAsking] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoad({ kind: "loading" });
    try {
      setLoad({ kind: "ready", machines: (await client.listMachines()).machines });
    } catch {
      setLoad({ kind: "failed" });
    }
  }, [client]);

  useEffect(() => {
    if (access === "ready") void refresh();
  }, [access, refresh]);

  if (access !== "ready" && access !== "booting") return <Welcome {...store} lang={L} />;

  const revoke = async (m: LinkedMachine): Promise<void> => {
    setRevoking(m.machine_id);
    setFailedId(null);
    try {
      await client.revokeMachine(m.machine_id);
      setDone(m.name);
      setAsking(null);
      await refresh();
    } catch (err) {
      // 404 : déjà déliée ailleurs — la liste rafraîchie le montre.
      if (linkIssue(err) === "unknown") {
        setAsking(null);
        await refresh();
      } else setFailedId(m.machine_id);
    } finally {
      setRevoking(null);
    }
  };

  const nowS = Date.now() / 1000;

  return (
    <div className="ob">
      <main className="ob-card wl-card mc-card" aria-labelledby="mc-title">
        <header className="wl-logo">
          <img className="only-light" src="/brand/nokker-emblem-light.svg" alt="" width={56} height={56} />
          <img className="only-dark" src="/brand/nokker-emblem-dark.svg" alt="" width={56} height={56} />
          <span className="ob-brand">{BRAND.productName}</span>
        </header>
        <h1 id="mc-title" className="ob-title">{t(L, "mcTitle")}</h1>
        <p>{t(L, "mcIntro")}</p>

        {done ? <p className="ob-status" role="status">{t(L, "mcRevoked", { machine: done })}</p> : null}

        {access === "booting" || load.kind === "loading" ? <p className="ob-status" role="status">{t(L, "mcLoading")}</p> : null}

        {load.kind === "failed" ? (
          <div role="alert">
            <p className="ob-error">{t(L, "mcErrLoad")}</p>
            <button type="button" className="ob-btn" onClick={() => void refresh()}>{t(L, "mcRetry")}</button>
          </div>
        ) : null}

        {load.kind === "ready" && load.machines.length === 0 ? (
          <section className="mc-empty">
            <p>{t(L, "mcEmpty")}</p>
            <a className="ob-btn primary" href="/link">{t(L, "mcHaveCode")}</a>
          </section>
        ) : null}

        {load.kind === "ready" && load.machines.length > 0 ? (
          <ul className="mc-list">
            {load.machines.map((m) => {
              const seen = seenLabel(m.last_seen_at, nowS);
              const href = gatewayHref(m.host);
              const busy = revoking === m.machine_id;
              return (
                <li key={m.machine_id} className="mc-item" data-machine={m.machine_id}>
                  <div className="mc-head">
                    <span className={`mc-dot${seen.online ? " on" : ""}`} aria-hidden="true" />
                    <strong className="mc-name">{m.name}</strong>
                    <span className="mc-seen">{t(L, seen.key, seen.vars)}</span>
                  </div>
                  <p className="mc-meta">
                    <span className="mc-host">{m.host}</span> · {t(L, "mcLinkedOn", { date: linkedOn(m.created_at, L) })}
                  </p>
                  {asking === m.machine_id ? (
                    <div className="mc-confirm">
                      <p>{t(L, "mcRevokeAsk", { machine: m.name })}</p>
                      {failedId === m.machine_id ? <p className="ob-error" role="alert">{t(L, "mcErrRevoke")}</p> : null}
                      <div className="lk-actions">
                        <button type="button" className="ob-btn danger" disabled={busy} onClick={() => void revoke(m)}>
                          {busy ? t(L, "mcRevoking") : t(L, "mcRevokeConfirm")}
                        </button>
                        <button type="button" className="ob-btn" disabled={busy} onClick={() => setAsking(null)}>{t(L, "mcCancel")}</button>
                      </div>
                    </div>
                  ) : (
                    <div className="lk-actions">
                      {href ? (
                        <a className="ob-btn" href={href} target="_blank" rel="noopener noreferrer">{t(L, "mcOpen")}</a>
                      ) : null}
                      <button
                        type="button"
                        className="ob-btn danger"
                        onClick={() => {
                          setDone(null);
                          setFailedId(null);
                          setAsking(m.machine_id);
                        }}
                      >
                        {t(L, "mcRevoke")}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
      </main>
    </div>
  );
}
