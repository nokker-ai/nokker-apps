/**
 * Réglages → Appareils : ACCORD, l'appareil physique Autoriser / Refuser qui tranche les cartes d'accord de la
 * machine (nokker docs/ACCORD-DEVICE.md §2). Propriétaire local seulement ; l'écran n'existe que si `GET /v1/local/accord`
 * répond (drapeau `local.accord.enabled`, éteint par défaut).
 *
 * Appairage : « Ajouter un appareil » ouvre une fenêtre de 2 min ; l'appareil affiche un code à 6 chiffres et l'empreinte
 * de l'hôte, l'app montre EN GROS les 8 caractères de l'hôte et ceux de la clé de chaque appareil demandeur : la personne
 * les compare avec l'écran de l'appareil AVANT de taper le code.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { NokkerApiError, type AccordDevice, type AccordStatus, type NokkerClient } from "@nokker-apps/sdk";
import { shellLang, tr } from "../i18n/index.js";
import { countdown, defaultDeviceName, deviceName, groupFingerprint, lastSeenText, pairErrorCode, pairErrorText, sortDevices, spelled, validCode, validName, cleanCode, when } from "./model.js";
import "./accord.css";

type Toast = (text: string, tone?: "ok" | "error") => void;

const POLL_MS = 2000;

/** Huit caractères à comparer, en gros : deux groupes de quatre, lus un à un par un lecteur d'écran. */
export function Fingerprint({ value, label }: { value: string; label: string }): React.ReactElement {
  const [a, b] = groupFingerprint(value);
  return (
    <div className="accord-fp" role="group" aria-label={`${label} : ${spelled(value)}`}>
      <span className="accord-fp-label">{label}</span>
      <span className="accord-fp-chars mono" aria-hidden="true">
        <span>{a}</span>
        <span>{b}</span>
      </span>
    </div>
  );
}

export function AccordDevices({ client, toast }: { client: NokkerClient; toast: Toast }): React.ReactElement {
  const [status, setStatus] = useState<AccordStatus | null>(null);
  /** Échéances locales (ms) calculées à partir des secondes du noyau à chaque lecture : le compte à rebours ne dépend pas du poll. */
  const [windowEnd, setWindowEnd] = useState(0);
  const [lockEnd, setLockEnd] = useState(0);
  const [tick, setTick] = useState(Date.now());
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"open" | "pair" | "revoke" | "rename" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState<AccordDevice | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  /** Renommage en ligne : l'appareil en cours d'édition, le texte saisi, l'erreur lisible. */
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const apply = useCallback((s: AccordStatus) => {
    setStatus(s);
    setWindowEnd(s.pairing.open ? Date.now() + s.pairing.closes_in_s * 1000 : 0);
    setLockEnd(s.pairing.locked ? Date.now() + s.pairing.locked_for_s * 1000 : 0);
  }, []);
  const load = useCallback(async () => {
    try {
      apply(await client.getLocalAccord());
    } catch {
      /* injoignable : on garde ce qui est affiché */
    }
  }, [client, apply]);

  useEffect(() => {
    void load();
  }, [load]);
  const open = !!status?.pairing.open && tick < windowEnd;
  const locked = !!status?.pairing.locked && tick < lockEnd;
  // Fenêtre ouverte : on relit l'état (les demandes de l'appareil arrivent) et on tient le compte à rebours.
  useEffect(() => {
    if (!status?.pairing.open && !status?.pairing.locked) return;
    const poll = setInterval(() => void load(), POLL_MS);
    const clock = setInterval(() => setTick(Date.now()), 500);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [status?.pairing.open, status?.pairing.locked, load]);
  // La fenêtre (ou le blocage) vient de finir : un dernier état du noyau.
  useEffect(() => {
    if (status?.pairing.open && tick >= windowEnd) void load();
    if (status?.pairing.locked && tick >= lockEnd) void load();
  }, [tick, windowEnd, lockEnd, status?.pairing.open, status?.pairing.locked, load]);

  const startPairing = async (): Promise<void> => {
    setBusy("open");
    setError(null);
    setPaired(null);
    setCode("");
    try {
      apply(await client.openAccordPairing());
      setTick(Date.now());
      setTimeout(() => codeRef.current?.focus(), 0);
    } catch (e) {
      // Appairage bloqué : la bannière (compte à rebours du noyau) le dit déjà, pas de second message.
      if (pairErrorCode(e) === "pairing_locked") void load();
      else setError(pairErrorText(e, status?.pairing.locked_for_s));
    } finally {
      setBusy(null);
    }
  };

  const pair = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!validCode(code)) return;
    setBusy("pair");
    setError(null);
    try {
      const d = await client.pairAccordDevice(cleanCode(code));
      setPaired(d);
      setCode("");
      toast(tr("Device paired: {0}", d.key8), "ok");
      await load();
    } catch (err) {
      if (pairErrorCode(err) !== "pairing_locked") setError(pairErrorText(err, status?.pairing.locked_for_s));
      setCode("");
      await load(); // fenêtre fermée, appairage bloqué, demandes : l'état du noyau fait foi
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (d: AccordDevice): Promise<void> => {
    setBusy("revoke");
    try {
      await client.revokeAccordDevice(d.device_id);
      toast(tr("Device revoked."), "ok");
      setConfirmId(null);
      await load();
    } catch (err) {
      toast(err instanceof NokkerApiError && err.status === 404 ? tr("This device is unknown or already revoked.") : tr("The machine is not responding."), "error");
      await load();
    } finally {
      setBusy(null);
    }
  };

  const startEdit = (d: AccordDevice): void => {
    setEditId(d.device_id);
    setDraft(d.name_is_default ? "" : deviceName(d)); // nom par défaut : champ vide (la valeur par défaut est dite dessous)
    setNameError(null);
    setConfirmId(null);
  };
  const saveName = async (d: AccordDevice): Promise<void> => {
    if (!validName(draft)) return setNameError(pairErrorText(new NokkerApiError("bad_name", 400, { error: { code: "bad_name", message: "bad_name" } })));
    setBusy("rename");
    setNameError(null);
    try {
      await client.renameAccordDevice(d.device_id, draft.normalize("NFC").trim());
      toast(tr("Device renamed."), "ok");
      setEditId(null);
      await load();
    } catch (err) {
      if (err instanceof NokkerApiError && err.status === 404) {
        toast(tr("This device is unknown or already revoked."), "error");
        setEditId(null);
        await load();
      } else setNameError(pairErrorText(err));
    } finally {
      setBusy(null);
    }
  };

  const lang = shellLang();
  const devices = sortDevices(status?.devices ?? []);
  const requests = status?.pairing.requests ?? [];

  return (
    <section className="machine-tab accord" aria-label={tr("Devices")} data-accord>
      <div className="machine-section">
        <h2>{tr("Devices")}</h2>
        <p className="fine">{tr("ACCORD is a physical Allow / Refuse button: it decides the approval cards of this machine. A refusal is always allowed; allowing a strong action still waits for your phone.")}</p>

        {status === null ? (
          <p className="fine" aria-live="polite">{tr("Loading…")}</p>
        ) : (
          <>
            <div className="accord-actions">
              <button type="button" className="btn btn-brass" disabled={busy !== null || locked} onClick={() => void startPairing()}>
                {open ? tr("Restart pairing") : tr("Add a device")}
              </button>
              {locked ? (
                <span className="accord-locked" role="status">
                  {tr("Pairing is blocked for {0} after three wrong codes. Try again later.", countdown((lockEnd - tick) / 1000))}
                </span>
              ) : null}
            </div>

            {error ? (
              <p className="accord-error" role="alert" data-accord-error>
                {error}
              </p>
            ) : null}

            {paired ? (
              <p className="accord-ok" role="status" data-accord-paired>
                {tr("Device paired: {0}", paired.key8)}
              </p>
            ) : null}

            {open ? (
              <div className="accord-pairing" data-accord-pairing>
                <p className="accord-countdown" role="timer" aria-live="off">
                  {tr("Pairing is open: {0} left", countdown((windowEnd - tick) / 1000))}
                </p>
                <ol className="accord-steps">
                  <li>{tr("On the device, start pairing: it shows a 6-digit code and the fingerprint of this machine.")}</li>
                  <li>{tr("Check that the characters below are exactly the same as on the device screen. If they differ, do not pair it.")}</li>
                  <li>{tr("Type the 6-digit code.")}</li>
                </ol>
                <div className="accord-compare">
                  <Fingerprint value={status.host_fp8} label={tr("This machine")} />
                  {requests.length > 0 ? (
                    requests.map((r) => <Fingerprint key={r.key8} value={r.key8} label={tr("The device")} />)
                  ) : (
                    <div className="accord-fp accord-fp-wait" role="status">
                      <span className="accord-fp-label">{tr("The device")}</span>
                      <span className="accord-fp-hint">{tr("Waiting for the device…")}</span>
                    </div>
                  )}
                </div>
                <form className="accord-code" onSubmit={(e) => void pair(e)}>
                  <label htmlFor="accord-code">{tr("Code shown on the device (6 digits)")}</label>
                  <div className="accord-code-row">
                    <input
                      id="accord-code"
                      ref={codeRef}
                      className="mono"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      autoComplete="off"
                      maxLength={7}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/[^\d\s]/g, ""))}
                      aria-invalid={error ? true : undefined}
                    />
                    <button type="submit" className="btn btn-brass" disabled={busy !== null || !validCode(code) || requests.length === 0}>
                      {busy === "pair" ? tr("Pairing…") : tr("Pair")}
                    </button>
                  </div>
                  {requests.length === 0 ? <p className="fine">{tr("The code can be typed once the device has asked to pair.")}</p> : null}
                </form>
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="machine-section">
        <h2>{tr("Paired devices")}</h2>
        {status !== null && devices.length === 0 ? <p className="fine">{tr("No device paired yet.")}</p> : null}
        <ul className="accord-list">
          {devices.map((d) => (
            <li key={d.device_id} className={`accord-device ${d.revoked ? "revoked" : ""}`} data-device={d.device_id}>
              <div className="accord-device-main">
                {editId === d.device_id ? (
                  <form className="accord-rename" onSubmit={(e) => { e.preventDefault(); void saveName(d); }}>
                    <label htmlFor={`accord-name-${d.device_id}`}>{tr("Device name")}</label>
                    <div className="accord-rename-row">
                      <input
                        id={`accord-name-${d.device_id}`}
                        value={draft}
                        maxLength={80}
                        autoComplete="off"
                        autoFocus
                        placeholder={defaultDeviceName(d.key8)}
                        aria-invalid={nameError ? true : undefined}
                        aria-describedby={`accord-name-hint-${d.device_id}`}
                        onChange={(e) => { setDraft(e.target.value); setNameError(null); }}
                        onKeyDown={(e) => { if (e.key === "Escape") setEditId(null); }}
                      />
                      <button type="submit" className="btn btn-brass" disabled={busy !== null || !validName(draft)}>{tr("Save")}</button>
                      <button type="button" className="btn btn-ghost" onClick={() => setEditId(null)}>{tr("Cancel")}</button>
                    </div>
                    <p className="fine" id={`accord-name-hint-${d.device_id}`}>{tr("Leave empty to go back to the default name ({0}).", defaultDeviceName(d.key8))}</p>
                    {nameError ? <p className="accord-error" role="alert" data-accord-name-error>{nameError}</p> : null}
                  </form>
                ) : (
                  <strong className="accord-name">{deviceName(d)}</strong>
                )}
                <span className="mono accord-key">{tr("Key {0}", d.key8)}</span>
                {d.revoked && d.revoked_at ? (
                  <span className="fine">{tr("Revoked on {0}", when(d.revoked_at, lang))}</span>
                ) : (
                  <>
                    <span className="fine">{tr("Paired on {0}", when(d.paired_at, lang))}</span>
                    <span className="fine" data-last-seen>{lastSeenText(d)}</span>
                  </>
                )}
                <span className="fine mono accord-id">{d.device_id}</span>
              </div>
              {d.revoked ? (
                <span className="accord-badge" role="status">{tr("revoked")}</span>
              ) : confirmId === d.device_id ? (
                <div className="accord-confirm" role="group" aria-label={tr("Confirm the revocation")}>
                  <p>{tr("Revoke “{0}”? It will no longer be able to answer any approval card.", `${deviceName(d)} · ${d.key8}`)}</p>
                  <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => void revoke(d)}>
                    {tr("Revoke the device")}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setConfirmId(null)}>
                    {tr("Cancel")}
                  </button>
                </div>
              ) : (
                <div className="accord-device-actions">
                  {editId === d.device_id ? null : (
                    <button type="button" className="btn btn-ghost" onClick={() => startEdit(d)} aria-label={tr("Rename {0}", deviceName(d))}>
                      {tr("Rename")}
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost" onClick={() => setConfirmId(d.device_id)}>
                    {tr("Revoke")}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
