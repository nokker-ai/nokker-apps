/**
 * « Glasses » card in My account: pair display glasses for the read-only glance view (core AMBIENT.md §6) — a code and
 * its QR, valid 5 minutes — and the list of paired glasses with « Revoke ». Hidden when the core does not serve glance
 * (404 on the device list: flag off).
 */
import React, { useCallback, useEffect, useState } from "react";
import qrcode from "qrcode-generator";
import { NokkerApiError, type GlanceDevice, type GlanceOffer, type NokkerClient } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";

/** QR drawn as SVG rectangles from the generator's modules (no HTML injected). */
export function QrSvg({ text, size = 176 }: { text: string; size?: number }): React.ReactElement {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const cells: React.ReactElement[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) cells.push(<rect key={`${r}-${c}`} x={c + quiet} y={r + quiet} width={1} height={1} />);
  const side = n + quiet * 2;
  return (
    <svg className="glasses-qr" width={size} height={size} viewBox={`0 0 ${side} ${side}`} role="img" aria-label={tr("QR code to pair the glasses")} shapeRendering="crispEdges">
      <rect width={side} height={side} fill="#fff" />
      <g fill="#000">{cells}</g>
    </svg>
  );
}

function apiCode(e: unknown): string | undefined {
  if (!(e instanceof NokkerApiError)) return undefined;
  const err = (e.body as { error?: { code?: unknown } } | undefined)?.error;
  return typeof err?.code === "string" ? err.code : undefined;
}

export function GlassesCard({ client }: { client: NokkerClient }): React.ReactElement | null {
  const [devices, setDevices] = useState<GlanceDevice[] | null | "off">(null);
  const [offer, setOffer] = useState<(GlanceOffer & { until: number }) | null>(null);
  const [left, setLeft] = useState(0);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    client.listGlanceDevices().then(
      (r) => setDevices(r.devices.filter((d) => !d.revoked)),
      (e) => setDevices(e instanceof NokkerApiError && e.status === 404 ? "off" : []),
    );
  }, [client]);
  useEffect(load, [load]);

  // Countdown of the offer; when it runs out, the code is gone and the list is read again (the glasses may have claimed it).
  useEffect(() => {
    if (!offer) return;
    const tick = (): void => {
      const s = Math.max(0, Math.round((offer.until - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) setOffer(null);
    };
    tick();
    const t = setInterval(() => {
      tick();
      load();
    }, 5000);
    const t1 = setInterval(tick, 1000);
    return () => {
      clearInterval(t);
      clearInterval(t1);
    };
  }, [offer, load]);

  if (devices === "off") return null;

  const pair = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const o = await client.pairGlance();
      setOffer({ ...o, until: Date.now() + o.expires_in * 1000 });
    } catch (e) {
      setError(apiCode(e) === "too_many_glance" ? tr("Five glasses are paired already: revoke one first.") : tr("The pairing code could not be made."));
    } finally {
      setBusy(false);
    }
  };
  const revoke = (id: string): void => {
    setError(null);
    client.revokeGlanceDevice(id).then(
      () => {
        setConfirm(null);
        load();
      },
      () => setError(tr("These glasses could not be revoked.")),
    );
  };

  return (
    <section className="ob-conn glasses-card" aria-labelledby="acc-glasses">
      <h3 id="acc-glasses">{tr("Glasses")}</h3>
      <p className="ob-muted">{tr("A read-only view for display glasses: the morning brief, the cards that wait, live incidents. Nothing can be decided from them.")}</p>
      {error ? (
        <p className="ob-error" role="alert">
          {error}
        </p>
      ) : null}
      {offer ? (
        <div className="glasses-offer" role="status">
          <p>{tr("On the glasses, open the Nokker glance page and type this code:")}</p>
          <p className="glasses-code" aria-label={tr("Pairing code {0}", offer.code.split("").join(" "))}>
            {offer.code}
          </p>
          <QrSvg text={offer.qr} size={120} />
          <p className="ob-note">{tr("Valid {0} more seconds, once.", left)}</p>
        </div>
      ) : (
        <div className="ob-actions">
          <button type="button" className="ob-btn primary" disabled={busy} onClick={() => void pair()}>
            {tr("Pair glasses")}
          </button>
        </div>
      )}
      {devices && devices.length ? (
        <ul className="acc-list">
          {devices.map((d) => (
            <li key={d.id} data-glasses={d.id}>
              <div>
                <strong>{d.name}</strong>
                <div className="ob-note">{d.last_seen_at ? tr("Last read {0}", new Date(d.last_seen_at).toLocaleString()) : tr("Not used yet")}</div>
              </div>
              {confirm === d.id ? (
                <button type="button" className="ob-btn danger" onClick={() => revoke(d.id)}>
                  {tr("Revoke these glasses")}
                </button>
              ) : (
                <button type="button" className="ob-btn" onClick={() => setConfirm(d.id)}>
                  {tr("Revoke")}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
