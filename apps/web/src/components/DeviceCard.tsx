/**
 * « Cet appareil » (LOKKAL-PHONE §4.3, lot P8) — dans l'app native seulement : ce que Nina peut lire DU téléphone, à la
 * demande, pendant un tour. Phase S : l'agenda (source de plus dans la liste des agendas) ; contacts et rappels
 * « bientôt » (le noyau ne les utilise pas encore : ni capacité déclarée, ni invite système pour rien).
 */
import React, { useEffect, useState } from "react";
import type { NokkerClient } from "@nokker-apps/sdk";
import { readStoredDeviceKey } from "../auth.js";
import { tr } from "../i18n/index.js";
import { nativePlatform } from "../platform/native.js";
import type { RedactKind } from "@nokker-apps/sdk";
import { ALL_KINDS, redactKinds, setRedactKinds, vaultPlugin } from "../platform/vault.js";
import { LIVE_KINDS, declareCaps, pimEnabled, pimPlugin, setPimEnabled, type PimKind, type PimStatus } from "../platform/pim.js";

export const deviceName = (): string => (nativePlatform() === "android" ? "Android" : "iPhone");

export function DeviceCard({ client }: { client: NokkerClient }): React.ReactElement | null {
  const plugin = pimPlugin();
  const [status, setStatus] = useState<Record<PimKind, PimStatus> | null>(null);
  const [enabled, setEnabled] = useState(pimEnabled());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (plugin) void plugin.status().then(setStatus, () => undefined);
  }, [plugin]);
  if (!plugin) return null;

  const toggle = async (kind: PimKind, on: boolean): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      let st = status ?? (await plugin.status());
      if (on && st[kind] !== "granted") st = await plugin.request({ kind });
      setStatus(st);
      const next = { ...enabled, [kind]: on && st[kind] === "granted" };
      setEnabled(next);
      setPimEnabled(next);
      if (on && st[kind] !== "granted") setNote(tr("Access is refused for Nokker: allow it in Settings → Nokker."));
      const key = await readStoredDeviceKey().catch(() => undefined);
      if (key?.deviceId) await declareCaps(client, plugin, key.deviceId, deviceName());
    } catch {
      setNote(tr("The setting could not be saved. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const rows: Array<[PimKind, string]> = [
    ["calendar", tr("Calendar")],
    ["contacts", tr("Contacts")],
    ["reminders", tr("Reminders")],
  ];
  return (
    <section className="ob-conn device-card" aria-labelledby="acc-device" data-device-card>
      <h3 id="acc-device">{tr("This device")}</h3>
      <p className="ob-note">{tr("What Nina may read from this phone when you ask her, for the period you ask. Nothing is copied ahead of time; each reading is shown in the conversation.")}</p>
      {rows.map(([kind, label]) =>
        LIVE_KINDS.has(kind) ? (
          <label key={kind} className="ob-check" data-pim={kind}>
            <input type="checkbox" checked={!!enabled[kind] && status?.[kind] === "granted"} disabled={busy} onChange={(e) => void toggle(kind, e.target.checked)} />
            <span>{label}</span>
          </label>
        ) : (
          <p key={kind} className="ob-check device-soon" data-pim={kind} aria-disabled="true">
            <input type="checkbox" disabled aria-hidden="true" tabIndex={-1} />
            <span>
              {label} <span className="ob-muted">· {tr("coming soon")}</span>
            </span>
          </p>
        ),
      )}
      {note ? <p className="ob-note" role="status">{note}</p> : null}
      <RedactSettings />
    </section>
  );
}

/** P9b : familles masquées sur l'appareil avant l'envoi (pièces OCR et transcriptions, résultats lus par le téléphone)
 * et oubli des valeurs gardées sur ce téléphone. */
function RedactSettings(): React.ReactElement | null {
  const vault = vaultPlugin();
  const [kinds, setKinds] = useState<Set<RedactKind>>(redactKinds());
  const [note, setNote] = useState<string | null>(null);
  if (!vault) return null;
  const label = (k: RedactKind): string =>
    ({
      phone: tr("Phone numbers"),
      email: tr("Email addresses"),
      iban: tr("IBAN"),
      avs: tr("AHV numbers"),
      card: tr("Card numbers"),
      birthdate: tr("Birth dates"),
      address: tr("Postal addresses"),
      secret: tr("Passwords and keys"),
    })[k];
  const toggle = (k: RedactKind, on: boolean): void => {
    const n = new Set(kinds);
    if (on) n.add(k);
    else n.delete(k);
    setKinds(n);
    setRedactKinds(n);
  };
  return (
    <div className="redact-settings" data-redact-settings>
      <h4 style={{ margin: "12px 0 4px" }}>{tr("Masked before sending")}</h4>
      <p className="ob-muted">{tr("Text read on this phone (photos, recordings, calendar) leaves masked: Nina sees a marker, the value stays here. Your typed messages are only offered masking.")}</p>
      {ALL_KINDS.map((k) => (
        <label key={k} className="ob-check" data-redact-kind={k}>
          <input type="checkbox" checked={kinds.has(k)} onChange={(e) => toggle(k, e.target.checked)} />
          <span>{label(k)}</span>
        </label>
      ))}
      <button
        type="button"
        className="ob-btn ob-btn-ghost"
        onClick={() =>
          void vault.forgetAll().then(
            () => setNote(tr("The masked values kept on this phone are forgotten. Markers already sent stay masked.")),
            () => setNote(tr("The setting could not be saved. Try again.")),
          )
        }
        data-redact-forget
      >
        {tr("Forget the masked values")}
      </button>
      {note ? <p className="ob-note" role="status">{note}</p> : null}
    </div>
  );
}
