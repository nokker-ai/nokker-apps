/**
 * « Écran mural » du nœud maison (LOKKAL-PHONE §4.4, lot P10b). L'appareil s'appaire lui-même comme écran glance de
 * surface `wall` (code créé puis présenté sur place, avec la session) ; le jeton `nkg_` va au trousseau par le natif et
 * ne sera remis qu'en mémoire à la page murale. Le mur montre le minimum (pièce commune) ; le résumé du brief et le
 * titre du prochain rendez-vous ne s'y affichent que si le titulaire l'allume ici (le noyau filtre).
 * Sécurité (décision dev 06.11, défaut relevé à la relecture des textes) : la mise en place FERME d'office la session complète de
 * l'appareil (le mur garde son nkg_, le nœud son jeton de machine) ; elle est refusée si l'appareil n'a pas de code ;
 * la sortie du mur exige la biométrie ou le code du propriétaire, puis mène à l'écran de connexion.
 */
import React, { useCallback, useEffect, useState } from "react";
import { NokkerApiError, type GlanceDevice, type NokkerClient } from "@nokker-apps/sdk";
import { signOutDevice } from "../account/lifecycle.js";
import { forgetDevice, readStoredDeviceKey } from "../auth.js";
import { logout as gatewayLogout } from "../gateway/auth.js";
import { tr } from "../i18n/index.js";
import { useNokker } from "../store.js";
import { dropSession, openWallScreen, type DropDeps } from "../glance/wallSession.js";
import type { NodePlugin } from "../platform/node.js";
import { deviceName } from "./DeviceCard.js";

const codeOf = (e: unknown): string | undefined => (e instanceof NokkerApiError ? (e.body as { error?: { code?: string } } | undefined)?.error?.code : undefined);

const PASSKEY_KEY = "nokker.web.device";
const DROP_DEPS: DropDeps = {
  signOut: signOutDevice,
  readStored: readStoredDeviceKey,
  forget: forgetDevice,
  gatewayLogout: () => gatewayLogout(),
  passkeyLeft: () => {
    try {
      return localStorage.getItem(PASSKEY_KEY) !== null;
    } catch {
      return false;
    }
  },
};

export function WallSettings({ client, plugin }: { client: NokkerClient; plugin: NodePlugin }): React.ReactElement | null {
  const { authMode } = useNokker();
  const [device, setDevice] = useState<GlanceDevice | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    const w = await plugin.wallToken?.().catch(() => null);
    if (!w?.token || !w.device_id) {
      setDevice(null);
      return setReady(true);
    }
    const list = await client.listGlanceDevices().catch(() => null);
    const d = list?.devices.find((x) => x.id === w.device_id) ?? null;
    if (list && (!d || d.revoked)) await plugin.setWallToken?.({}).catch(() => undefined); // révoqué ailleurs
    setDevice(d && !d.revoked ? d : null);
    setReady(true);
  }, [client, plugin]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!plugin.wallToken || !plugin.setWallToken || !plugin.wallCheck || !plugin.authenticateExit || !ready) return null;

  const setup = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      // Sans code, la sortie du mur ne protégerait rien : refusé.
      if (!(await plugin.wallCheck!()).passcode) {
        setNote(tr("Set a passcode on this device first (in its settings): without one, anyone could leave the wall screen."));
        return;
      }
      const offer = await client.pairGlance(tr("Wall — {0}", deviceName()).slice(0, 60), "wall");
      const claim = await client.claimGlance(offer.code);
      await plugin.setWallToken!({ token: claim.token, device_id: claim.device.id });
      // Une session complète ne reste pas sur une tablette posée dans une pièce commune.
      await openWallScreen({ drop: () => dropSession(client, authMode, DROP_DEPS), setWall: () => plugin.setWall!({ on: true }), go: (u) => window.location.replace(u) });
    } catch (e) {
      if (e instanceof Error && e.message === "session_still_present") return setNote(tr("Nokker could not sign you out of this device: the wall screen is not shown, so that your account does not stay open behind it. Try again, or close and reopen the app."));
      setNote(codeOf(e) === "too_many_glance" ? tr("This account already has 5 screens. Remove one in My account → Glasses.") : tr("The wall screen could not be set up. Try again."));
    } finally {
      setBusy(false);
    }
  };
  const setBrief = async (on: boolean): Promise<void> => {
    if (!device) return;
    setBusy(true);
    setNote(null);
    try {
      setDevice(await client.setGlanceShowBrief(device.id, on));
    } catch {
      setNote(tr("The setting could not be saved. Try again."));
    } finally {
      setBusy(false);
    }
  };
  const stop = async (): Promise<void> => {
    if (!device) return;
    setBusy(true);
    setNote(null);
    try {
      await client.revokeGlanceDevice(device.id);
      await plugin.setWallToken!({});
      await plugin.setWall?.({ on: false }).catch(() => undefined);
      setDevice(null);
    } catch {
      setNote(tr("The setting could not be saved. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="phone-wall" data-phone-wall={device ? "set" : "none"}>
      <h4>{tr("Wall screen")}</h4>
      {!device ? (
        <>
          <p className="ob-muted">{tr("Shows in large type the time, the time of your next appointment, how many cards wait and the titles of incidents. Anyone in the room can see it: it shows nothing else.")}</p>
          <p className="ob-muted">{tr("Setting it up signs you out of this device: the wall screen and the home node keep working without your account. To leave the wall screen, you will need Face ID, Touch ID or the passcode of this device, then sign in again.")}</p>
          <button type="button" className="ob-btn" disabled={busy} onClick={() => void setup()} data-wall-setup>
            {tr("Use this device as a wall screen")}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="ob-btn"
            disabled={busy}
            onClick={() =>
              // Reconnecté pour régler le mur : la session se referme en rouvrant le mur (pas de session derrière lui).
              void openWallScreen({ drop: () => dropSession(client, authMode, DROP_DEPS), setWall: () => plugin.setWall!({ on: true }), go: (u) => window.location.replace(u) }).catch(() =>
                setNote(tr("Nokker could not sign you out of this device: the wall screen is not shown, so that your account does not stay open behind it. Try again, or close and reopen the app.")),
              )
            }
            data-wall-open
          >
            {tr("Open the wall screen")}
          </button>
          <label className="ob-check">
            <input type="checkbox" checked={device.show_brief === true} disabled={busy} onChange={(e) => void setBrief(e.target.checked)} data-wall-brief />
            <span>{tr("Show the brief summary and appointment titles on the wall screen, visible to anyone in the room")}</span>
          </label>
          <p className="ob-muted">{tr("To leave the wall screen, hold the top left corner for 3 seconds, confirm with Face ID, Touch ID or the passcode of this device, then sign in again.")}</p>
          <button type="button" className="ob-btn ob-btn-ghost" disabled={busy} onClick={() => void stop()} data-wall-stop>
            {tr("Stop using this device as a wall screen")}
          </button>
        </>
      )}
      {note ? (
        <p className="ob-note" role="alert">
          {note}
        </p>
      ) : null}
    </div>
  );
}
