/**
 * Mode « nœud maison » de « Ce téléphone » (LOKKAL-PHONE §4.4, lot P10a). Un vieux téléphone ou une tablette, branché,
 * sur le Wi-Fi de la maison, app ouverte : il relaie Home Assistant (HA n'a pas besoin d'être exposé à Internet). Tout se règle
 * dans le natif : l'URL (privée seulement), le jeton (champ NATIF, jamais dans la WebView), le Wi-Fi « maison »
 * (empreinte salée, le BSSID ne sort jamais) et les entités partagées (VIDE par défaut).
 */
import React, { useEffect, useState } from "react";
import { normalizeEntityPattern, type HomeNodeStatus, type NokkerClient } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import type { NodePlugin, NodeStatus } from "../platform/node.js";
import { applyHomeGuard } from "../platform/homeGuard.js";
import { CameraSettings } from "./CameraSettings.js";
import { KnockHomeSettings } from "./KnockHomeSettings.js";
import { WallSettings } from "./WallSettings.js";

/** Texte d'un contrôle de HA (code du natif). */
export function haCheckText(code: HomeNodeStatus["ha_check"]): string {
  switch (code) {
    case "ok":
      return tr("Home Assistant answers.");
    case "not_home_wifi":
      return tr("This device is not on the home Wi-Fi.");
    case "ha_not_configured":
      return tr("Enter the address and the token of Home Assistant first.");
    case "ha_unreachable":
      return tr("Home Assistant does not answer at this address.");
    case "ha_auth_failed":
      return tr("Home Assistant refused the token.");
    case null:
    case undefined:
      return "";
    default:
      return tr("Home Assistant returned an error.");
  }
}

/** Pourquoi Nina ne passe pas (encore) par ce nœud ; null quand `lan_home` est allumé. */
export function homeBlocker(h: HomeNodeStatus): string | null {
  if (h.lan_home === "on") return null;
  if (!h.ha_url || !h.ha_token_set) return tr("Enter the address and the token of Home Assistant first.");
  if (!h.home_wifi_set) return tr("Mark the home Wi-Fi first.");
  if (!h.home_wifi) return tr("This device is not on the home Wi-Fi.");
  return tr("Not reachable right now.");
}

export function HomeNodeSettings({ client, plugin, st, setSt }: { client: NokkerClient; plugin: NodePlugin; st: NodeStatus; setSt: (s: NodeStatus) => void }): React.ReactElement | null {
  const [url, setUrl] = useState(st.home?.ha_url ?? "");
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [haFound, setHaFound] = useState<{ name: string; url: string }[] | null>(null);
  const [lan, setLan] = useState<{ id: string; types: string[]; name: string }[] | null>(null);
  // Le « toc toc toc » suit le mode maison tout de suite (sans attendre le prochain état du nœud).
  useEffect(() => applyHomeGuard(st), [st]);
  if (!plugin.setHome) return null;
  const h = st.home;
  const on = h?.on === true;
  const act = async (fn: () => Promise<NodeStatus | undefined>, fail: string): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const r = await fn();
      if (r) setSt(r);
    } catch {
      setNote(fail);
    } finally {
      setBusy(false);
    }
  };
  const entities = h?.entities ?? [];
  const setEntities = (next: string[]): Promise<void> => act(() => plugin.setHome!({ entities: next }), tr("The list could not be saved. Try again."));
  return (
    <div className="phone-home" data-phone-home={on ? "on" : "off"} data-lan-home={h?.lan_home ?? "off"}>
      <label className="ob-check">
        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => void act(() => plugin.setHome!({ on: e.target.checked }), tr("The setting could not be saved. Try again."))} data-home-toggle />
        <span>{tr("Home node: this device stays at home")}</span>
      </label>
      <p className="ob-muted">{tr("Plugged in, on the home Wi-Fi, app open: Nina reaches your Home Assistant through this device. Home Assistant does not need to be exposed to the Internet, and its token stays on this device.")}</p>
      {on && h ? (
        <>
          <p className="ob-note" data-home-state={h.lan_home}>
            {h.lan_home === "on" ? tr("Nina can reach Home Assistant through this device.") : homeBlocker(h)}
          </p>
          <form
            className="ob-field"
            style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              void act(() => plugin.setHome!({ ha_url: url }), tr("Enter the address of Home Assistant on your home network, such as http://homeassistant.local:8123."));
            }}
          >
            <input type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1, minWidth: 0 }} placeholder="http://homeassistant.local:8123" aria-label={tr("Home Assistant address")} data-home-url />
            <button type="submit" className="ob-btn" disabled={busy} data-home-url-save>
              {tr("Save")}
            </button>
          </form>
          {plugin.discoverHa ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button
                type="button"
                className="ob-btn ob-btn-ghost"
                disabled={busy}
                onClick={() =>
                  void plugin
                    .discoverHa!()
                    .then((r) => setHaFound(r.candidates), () => setHaFound([]))
                }
                data-home-find
              >
                {tr("Find Home Assistant")}
              </button>
              {haFound?.length
                ? haFound.map((c) => (
                    <button key={c.url} type="button" className="ob-btn ob-btn-ghost" onClick={() => setUrl(c.url)} data-home-found={c.url}>
                      {c.name} · {c.url}
                    </button>
                  ))
                : null}
              {haFound && !haFound.length ? (
                <span className="ob-muted" data-home-found-none>
                  {tr("No Home Assistant found on this Wi-Fi. Enter its address.")}
                </span>
              ) : null}
            </div>
          ) : null}
          <p className="ob-muted" data-home-token-state={h.ha_token_set ? "set" : "none"}>
            {h.ha_token_set ? tr("Token kept on this device.") : tr("No token yet: use a long-lived token of a Home Assistant account that is not an administrator.")}
          </p>
          <button
            type="button"
            className="ob-btn ob-btn-ghost"
            disabled={busy || !plugin.promptHaToken}
            onClick={() => void act(async () => ((await plugin.promptHaToken!()).saved ? plugin.status() : undefined), tr("The token could not be saved. Try again."))}
            data-home-token
          >
            {h.ha_token_set ? tr("Replace the token") : tr("Enter the token")}
          </button>
          <p className="ob-muted" data-home-wifi={h.home_wifi ? "home" : h.home_wifi_set ? "away" : "none"}>
            {h.home_wifi ? tr("On the home Wi-Fi.") : h.home_wifi_set ? tr("This device is not on the home Wi-Fi.") : tr("The home Wi-Fi is not marked yet.")}
          </p>
          <button
            type="button"
            className="ob-btn ob-btn-ghost"
            disabled={busy || !plugin.markHomeWifi}
            onClick={() =>
              void act(async () => {
                const r = await plugin.markHomeWifi!();
                if (!r.ok) setNote(tr("This device could not read the name of the current Wi-Fi. Allow location for Nokker (the system requires it to read the Wi-Fi name), then try again."));
                return r;
              }, tr("This device could not read the name of the current Wi-Fi. Allow location for Nokker (the system requires it to read the Wi-Fi name), then try again."))
            }
            data-home-wifi-mark
          >
            {tr("This Wi-Fi is the home one")}
          </button>
          <h4>{tr("Shared with Nina")}</h4>
          {entities.length ? (
            <ul className="phone-hosts" aria-label={tr("Shared with Nina")} style={{ listStyle: "none", padding: 0, margin: "8px 0" }}>
              {entities.map((p) => (
                <li key={p} data-home-entity={p} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "4px 0" }}>
                  <code>{p}</code>{" "}
                  <button type="button" className="ob-btn ob-btn-ghost" disabled={busy} onClick={() => void setEntities(entities.filter((x) => x !== p))} aria-label={tr("Remove {0}", p)}>
                    {tr("Remove")}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ob-muted" data-home-entities-empty>
              {tr("Nothing is shared until you add entities, such as light.* or switch.kitchen.")}
            </p>
          )}
          <form
            className="ob-field"
            style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              const p = normalizeEntityPattern(draft);
              if (!p) return setNote(tr("Enter an entity such as light.living_room, or a pattern such as light.*."));
              setDraft("");
              void setEntities([...entities.filter((x) => x !== p), p]);
            }}
          >
            <input type="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} style={{ flex: 1, minWidth: 0 }} placeholder="light.*" aria-label={tr("Entity to share")} data-home-entity-input />
            <button type="submit" className="ob-btn" disabled={busy} data-home-entity-add>
              {tr("Add")}
            </button>
          </form>
          <p className="ob-muted">{tr("For now, Nina only reads the state of the home through this device. Actions (turning on a light, for example) will come once this device is verified. Sensitive actions (locks, garage, alarm) will always ask for your approval.")}</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="ob-btn ob-btn-ghost" disabled={busy || !plugin.checkHa} onClick={() => void act(() => plugin.checkHa!(), tr("Home Assistant does not answer at this address."))} data-home-check>
              {tr("Test the connection")}
            </button>
            <button type="button" className="ob-btn ob-btn-ghost" disabled={busy || !plugin.forgetHome} onClick={() => void act(() => plugin.forgetHome!(), tr("The setting could not be saved. Try again."))} data-home-forget>
              {tr("Forget Home Assistant on this device")}
            </button>
          </div>
          {h.ha_check ? (
            <p className="ob-note" role="status" data-home-check-result={h.ha_check}>
              {haCheckText(h.ha_check)}
            </p>
          ) : null}
          {plugin.discoverLan ? (
            <div className="phone-lan" data-phone-lan>
              <h4>{tr("Devices at home")}</h4>
              <p className="ob-muted">{tr("Screens, speakers and Home Assistant seen on the home Wi-Fi: only their names. Computers and phones are never listed.")}</p>
              <button
                type="button"
                className="ob-btn ob-btn-ghost"
                disabled={busy}
                onClick={() =>
                  void plugin
                    .discoverLan!()
                    .then((r) => setLan(r.services), (e: { code?: string }) => (setLan([]), setNote(e?.code === "not_home_wifi" ? tr("This device is not on the home Wi-Fi.") : tr("The search could not run. Allow the local network for Nokker, then try again."))))
                }
                data-lan-scan
              >
                {tr("Search")}
              </button>
              {lan ? (
                lan.length ? (
                  <ul style={{ listStyle: "none", padding: 0, margin: "6px 0" }}>
                    {lan.map((s) => (
                      <li key={s.id} data-lan-service={s.name}>
                        {s.name} <span className="ob-muted">· {s.types.map((t) => t.replace(/^_|\._tcp$/g, "")).join(", ")}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="ob-muted" data-lan-none>{tr("No device found.")}</p>
                )
              ) : null}
            </div>
          ) : null}
          <WallSettings client={client} plugin={plugin} />
          <CameraSettings plugin={plugin} st={st} setSt={setSt} />
          <KnockHomeSettings plugin={plugin} st={st} setSt={setSt} />
        </>
      ) : null}
      {note ? (
        <p className="ob-note" role="alert">
          {note}
        </p>
      ) : null}
    </div>
  );
}
