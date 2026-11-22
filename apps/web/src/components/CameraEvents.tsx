/**
 * Détections des caméras de veille des nœuds maison du titulaire (LOKKAL-PHONE §4.4, lot P10c). Lecture À LA DEMANDE
 * (le noyau ne garde rien) ; vignette lue par le natif sur le Wi-Fi de la maison, chiffrée de bout en bout, déchiffrée
 * dans le natif et montrée EN MÉMOIRE (URL blob révoquée à la fermeture). L'url et la clé de la vignette ne sont
 * jamais gardées ni journalisées ici.
 */
import React, { useEffect, useState } from "react";
import { NokkerApiError, type CameraEvent, type NokkerClient, type PhoneInfo } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import type { NodePlugin } from "../platform/node.js";

const codeOf = (e: unknown): string | undefined =>
  e instanceof NokkerApiError ? (e.status === 409 ? "node_offline" : e.status === 504 ? "phone_timeout" : ((e.body as { error?: { code?: string } } | undefined)?.error?.code ?? undefined)) : e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;

/** Phrase d'un code (les codes ne vont qu'à l'app, jamais au modèle). */
export function cameraErrorText(code: string | undefined): string {
  switch (code) {
    case "node_offline":
    case "phone_offline":
    case "phone_timeout":
      return tr("The home node does not answer. Check that it is plugged in, with the app open.");
    case "thumb_gone":
    case "not_found":
      return tr("This image is no longer on the home node (kept 24 hours).");
    case "not_home_wifi":
      return tr("Images can only be seen from the home Wi-Fi.");
    case "camera_off":
      return tr("The watch camera is off on the home node.");
    case "denied":
    case "camera_denied":
      return tr("The camera is not allowed on the home node.");
    default:
      return tr("The image could not be shown. Try again.");
  }
}

function at(e: CameraEvent): string {
  return new Date(e.start * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function PhoneCamera({ client, plugin, phone }: { client: NokkerClient; plugin: NodePlugin | undefined; phone: PhoneInfo }): React.ReactElement {
  const [items, setItems] = useState<CameraEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [image, setImage] = useState<{ id: string; src: string } | null>(null);
  useEffect(() => () => void (image && URL.revokeObjectURL(image.src)), [image]);
  const load = async (): Promise<void> => {
    setBusy("list");
    setError(null);
    try {
      setItems((await client.phoneCameraEvents(phone.machine_id, Math.floor(Date.now() / 1000) - 24 * 3600)).items.slice().reverse());
    } catch (e) {
      setError(cameraErrorText(codeOf(e)));
    } finally {
      setBusy(null);
    }
  };
  const show = async (e: CameraEvent): Promise<void> => {
    if (!plugin?.fetchLocalImage) return setError(tr("Images can only be seen in the Nokker app, from the home Wi-Fi."));
    setBusy(e.id);
    setError(null);
    try {
      const t = await client.phoneCameraThumb(phone.machine_id, e.id);
      const r = await plugin.fetchLocalImage({ url: t.url, key: t.key, id: e.id });
      const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
      if (image) URL.revokeObjectURL(image.src);
      setImage({ id: e.id, src: URL.createObjectURL(new Blob([bytes], { type: r.type || "image/jpeg" })) });
    } catch (err) {
      setError(cameraErrorText(codeOf(err)));
    } finally {
      setBusy(null);
    }
  };
  return (
    <li data-camera-phone={phone.machine_id} style={{ padding: "6px 0" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <strong>{phone.name}</strong>
        <button type="button" className="ob-btn ob-btn-ghost" disabled={busy !== null} onClick={() => void load()} data-camera-load>
          {items ? tr("Refresh") : tr("See detections")}
        </button>
      </div>
      {items ? (
        items.length ? (
          <ul style={{ listStyle: "none", padding: 0, margin: "6px 0" }}>
            {items.map((e) => (
              <li key={e.id} data-camera-event={e.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "3px 0" }}>
                <span>
                  {at(e)} · {e.title === "personne" ? tr("a person") : tr("movement")} · <span className="ob-muted">{e.camera}</span>
                </span>
                {e.has_thumb ? (
                  <button type="button" className="ob-btn ob-btn-ghost" disabled={busy !== null} onClick={() => void show(e)} data-camera-show={e.id}>
                    {tr("See the image")}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="ob-muted" data-camera-none>
            {tr("No detection in the last 24 hours.")}
          </p>
        )
      ) : null}
      {image ? (
        <figure style={{ margin: "6px 0", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6 }} data-camera-image={image.id}>
          <img src={image.src} alt={tr("Image from the watch camera")} style={{ maxWidth: "100%", borderRadius: 8 }} />
          <button type="button" className="ob-btn ob-btn-ghost" onClick={() => setImage(null)}>
            {tr("Close")}
          </button>
        </figure>
      ) : null}
      {error ? (
        <p className="ob-note" role="alert" data-camera-error>
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** Section « Caméras de la maison » : les nœuds du titulaire qui ont eu une caméra de veille (lecture à la demande). */
export function CameraEvents({ client, plugin }: { client: NokkerClient; plugin: NodePlugin | undefined }): React.ReactElement | null {
  const [phones, setPhones] = useState<PhoneInfo[] | null>(null);
  useEffect(() => {
    let live = true;
    void client.listPhones().then(
      (r) => live && setPhones(r.phones),
      () => live && setPhones([]),
    );
    return () => {
      live = false;
    };
  }, [client]);
  if (!phones?.length) return null;
  return (
    <div className="phone-camera-events" data-camera-events>
      <h4>{tr("Home cameras")}</h4>
      <p className="ob-muted">{tr("Detections of the watch cameras of your home nodes, read when you ask. Images open only from the home Wi-Fi.")}</p>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {phones.map((p) => (
          <PhoneCamera key={p.machine_id} client={client} plugin={plugin} phone={p} />
        ))}
      </ul>
    </div>
  );
}
