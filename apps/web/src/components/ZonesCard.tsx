/**
 * Zones du membre (LOKKAL-PHONE §5 écran 6, lot P6) — dans l'app native seulement. Une zone = un nom, un centre et un
 * rayon posés sur la carte native (gardés sur l'appareil), et les scénarios de la maison à lancer à l'arrivée et au
 * départ. Le noyau ne reçoit que le nom, l'id et les scénarios ; jamais une position.
 * Divulgation exacte du §5 AVANT l'invite système ; « Pendant l'utilisation » d'abord, « Toujours » seulement quand une
 * zone a un scénario.
 */
import React, { useCallback, useEffect, useState } from "react";
import type { HomeScenarios, NokkerClient, Zone } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import { MAX_ZONES, MIN_RADIUS, newZoneId, zonesPlugin, type DeviceZone, type LocationStatus } from "../platform/zones.js";

type Row = DeviceZone & Pick<Zone, "on_enter" | "on_exit"> & { home: boolean };

export function ZonesCard({ client }: { client: NokkerClient }): React.ReactElement | null {
  const plugin = zonesPlugin();
  const [status, setStatus] = useState<LocationStatus | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [home, setHome] = useState<HomeScenarios | null>(null);
  const [disclose, setDisclose] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!plugin) return;
    const [st, dev, srv, sc] = await Promise.all([
      plugin.status(),
      plugin.list(),
      client.getZones().catch(() => ({ zones: [] as Zone[] })),
      client.getHomeScenarios().catch(() => null),
    ]);
    setStatus(st.status);
    setHome(sc);
    setRows(dev.zones.map((z) => {
      const s = srv.zones.find((x) => x.id === z.id);
      return { ...z, on_enter: s?.on_enter ?? [], on_exit: s?.on_exit ?? [], home: s?.home === true };
    }));
  }, [client, plugin]);
  useEffect(() => void load(), [load]);

  if (!plugin) return null;
  const scName = (id: string) => home?.scenarios.find((s) => s.id === id)?.name ?? id;

  const save = async (next: Row[]): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await plugin.setZones({ zones: next.map(({ id, name, lat, lon, radius }) => ({ id, name, lat, lon, radius })) });
      await client.putZones(next.map(({ id, name, on_enter, on_exit, home }) => ({ id, name, on_enter, on_exit, home })));
      // Un scénario à lancer app fermée demande « Toujours » (la divulgation a déjà été lue).
      if (next.some((r) => r.on_enter.length || r.on_exit.length) && status !== "always") setStatus((await plugin.requestAlways()).status);
      setRows(next);
      setEditing(null);
    } catch {
      setError(tr("The zones could not be saved. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const place = async (r: Row): Promise<void> => {
    try {
      const p = await plugin.pick({ name: r.name || tr("New zone"), radius: r.radius, ...(r.lat || r.lon ? { lat: r.lat, lon: r.lon } : {}), ok: tr("Confirm"), cancel: tr("Cancel"), radiusLabel: tr("Radius: %d m") });
      setEditing({ ...r, lat: p.lat, lon: p.lon, radius: Math.max(MIN_RADIUS, p.radius) });
    } catch {
      /* annulé */
    }
  };

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <section className="ob-conn zones" aria-labelledby="acc-zones" data-zones={status ?? "loading"}>
      <h3 id="acc-zones">{tr("My zones")}</h3>
      <p className="ob-note">{tr("Arrival and departure from your zones (Home, Work…) can run your home scenarios. Only arrival and departure leave this phone, never your position.")}</p>
      {status === "not_determined" ? (
        <button type="button" className="ob-btn primary" data-zones-enable onClick={() => setDisclose(true)}>
          {tr("Turn on zones")}
        </button>
      ) : status === "denied" || status === "restricted" ? (
        <p className="ob-note" role="status">{tr("Location is refused for Nokker: allow it in Settings → Nokker → Location.")}</p>
      ) : status ? (
        <>
          {home && !home.bridge ? <p className="ob-note">{tr("No link to Home Assistant yet: zones only show who is home and power place reminders.")}</p> : null}
          <ul className="zones-list">
            {rows.map((r) => (
              <li key={r.id} className="zones-row" data-zone={r.id}>
                <div>
                  <strong>{r.name}</strong> {r.home ? <span className="ob-badge ok">{tr("home")}</span> : null} <span className="ob-muted">{tr("radius {0} m", String(Math.round(r.radius)))}</span>
                  {r.on_enter.length ? <p className="ob-muted">{tr("On arrival: {0}", r.on_enter.map(scName).join(", "))}</p> : null}
                  {r.on_exit.length ? <p className="ob-muted">{tr("On departure: {0}", r.on_exit.map(scName).join(", "))}</p> : null}
                </div>
                <div className="zones-actions">
                  <button type="button" className="ob-btn small" onClick={() => setEditing(r)}>{tr("Edit")}</button>
                  <button type="button" className="ob-btn small" disabled={busy} onClick={() => void save(rows.filter((x) => x.id !== r.id))}>{tr("Remove")}</button>
                </div>
              </li>
            ))}
          </ul>
          {editing ? (
            <form
              className="zones-edit"
              data-zone-edit
              onSubmit={(e) => {
                e.preventDefault();
                const name = editing.name.trim();
                if (!name || name.length > 40) return setError(tr("A zone needs a name of 1 to 40 characters."));
                if (!editing.lat && !editing.lon) return setError(tr("Place the zone on the map first."));
                // Une seule maison : la cocher sur cette zone la retire des autres.
                const others = editing.home ? rows.map((x) => ({ ...x, home: false })) : rows;
                void save(others.some((x) => x.id === editing.id) ? others.map((x) => (x.id === editing.id ? { ...editing, name } : x)) : [...others, { ...editing, name }]);
              }}
            >
              <div className="ob-field">
                <label htmlFor="zone-name">{tr("Zone name")}</label>
                <input id="zone-name" value={editing.name} maxLength={40} placeholder={tr("Home")} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </div>
              <label className="ob-check">
                <input type="checkbox" checked={editing.home} onChange={(e) => setEditing({ ...editing, home: e.target.checked })} data-zone-home />
                <span>{tr("This is my home")}</span>
              </label>
              <button type="button" className="ob-btn" data-zone-place onClick={() => void place(editing)}>
                {editing.lat || editing.lon ? tr("Move on the map ({0} m)", String(Math.round(editing.radius))) : tr("Place on the map")}
              </button>
              {home?.scenarios.length ? (
                <>
                  {(["on_enter", "on_exit"] as const).map((k) => (
                    <fieldset key={k} className="zones-scenarios">
                      <legend>{k === "on_enter" ? tr("On arrival") : tr("On departure")}</legend>
                      {home.scenarios.map((s) => (
                        <label key={s.id} className="ob-check">
                          <input type="checkbox" checked={editing[k].includes(s.id)} onChange={() => setEditing({ ...editing, [k]: toggle(editing[k], s.id) })} />
                          <span>
                            {s.name}
                            {s.strong ? <span className="ob-muted"> · {tr("asks for your approval")}</span> : null}
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  ))}
                </>
              ) : null}
              {error ? <p className="ob-error" role="alert">{error}</p> : null}
              <div className="ob-actions inline">
                <button type="submit" className="ob-btn primary" disabled={busy}>{tr("Save")}</button>
                <button type="button" className="ob-btn" onClick={() => { setEditing(null); setError(null); }}>{tr("Cancel")}</button>
              </div>
            </form>
          ) : rows.length < MAX_ZONES ? (
            <button type="button" className="ob-btn primary" data-zone-add onClick={() => setEditing({ id: newZoneId(), name: "", lat: 0, lon: 0, radius: 200, on_enter: [], on_exit: [], home: !rows.some((r) => r.home) && rows.length === 0 })}>
              {tr("Add a zone")}
            </button>
          ) : (
            <p className="ob-note">{tr("18 zones at most on a phone.")}</p>
          )}
        </>
      ) : null}
      {disclose ? (
        <div className="zones-disclosure" role="dialog" aria-modal="true" aria-labelledby="zones-disc-title" data-zones-disclosure>
          <h4 id="zones-disc-title">{tr("Your position")}</h4>
          <p>{tr("Nokker collects your position to know when you arrive at or leave your zones (Home, Work…) and run your scenarios, even when the app is closed or not in use. Only arrival and departure are sent, never your position.")}</p>
          <div className="ob-actions inline">
            <button type="button" className="ob-btn primary" onClick={() => { setDisclose(false); void plugin.requestWhenInUse().then((s) => setStatus(s.status)); }}>{tr("Continue")}</button>
            <button type="button" className="ob-btn" onClick={() => setDisclose(false)}>{tr("Not now")}</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
