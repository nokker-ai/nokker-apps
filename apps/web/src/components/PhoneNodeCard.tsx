/**
 * « Ce téléphone » (LOKKAL-PHONE §5.4, lot P7, phase S) — dans l'app native seulement. Inscrire le téléphone comme nœud
 * du compte (carte forte approuvée sur un AUTRE appareil, qui montre le nom et l'empreinte de la clé), voir s'il est
 * joignable, ce qu'il a fait (journal sans contenu), le mettre en pause, le retirer. Phase S : joignable app ouverte
 * seulement (pas de notifications), lectures seulement.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { normalizeEgressHost, type NokkerClient, type PhoneOp, type PhoneTaskLog } from "@nokker-apps/sdk";
import { SERVER_URL } from "../api.js";
import { tr } from "../i18n/index.js";
import { beatMinutes, enrollPhone, nodePlugin, removePhone, type EnrollStep, type NodeStatus } from "../platform/node.js";
import { deviceName } from "./DeviceCard.js";
import { CameraEvents } from "./CameraEvents.js";
import { HomeNodeSettings } from "./HomeNodeSettings.js";

const opLabel = (op: PhoneOp): string =>
  op === "zone.state" ? tr("Zone check") : op === "calendar.list" ? tr("Calendar read") : op === "ocr.image" ? tr("Text from an image") : op === "stt.audio" ? tr("Transcription") : op === "fetch.get" ? tr("Page") : op.startsWith("ha.") ? "Home Assistant" : op;
const statusLabel = (st: PhoneTaskLog["status"]): string =>
  ({ queued: tr("waiting"), leased: tr("in progress"), done: tr("done"), failed: tr("failed"), expired: tr("expired"), cancelled: tr("cancelled") })[st] ?? st;
const failText = (code: Extract<EnrollStep, { kind: "failed" }>["code"]): string =>
  ({
    rejected: tr("The registration was refused on your other device."),
    expired: tr("The registration card expired before it was approved. Start again."),
    not_available: tr("Phone nodes are not open for this account yet."),
    too_many: tr("This account already has the maximum number of phones. Remove one first."),
    key: tr("This phone could not create its key."),
    network: tr("The registration could not be sent. Try again."),
  })[code];

export function PhoneNodeCard({ client }: { client: NokkerClient }): React.ReactElement | null {
  const plugin = nodePlugin();
  const [st, setSt] = useState<NodeStatus | null>(null);
  const [step, setStep] = useState<EnrollStep | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<PhoneTaskLog[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!plugin) return;
    const s = await plugin.status().catch(() => null);
    setSt(s);
    if (s?.enrolled && s.machine_id) setLog((await client.phoneTasks(s.machine_id, 20).catch(() => ({ tasks: [] }))).tasks);
  }, [plugin, client]);

  useEffect(() => {
    if (!plugin) return;
    void refresh();
    let h: { remove?: () => void } | undefined;
    let gone = false;
    // Chaque battement (60 s) relit l'état et le journal : ce que le téléphone vient de faire y apparaît.
    void Promise.resolve(
      plugin.addListener?.("nodeState", (s) => {
        setSt(s);
        if (s.enrolled && s.machine_id) void client.phoneTasks(s.machine_id, 20).then((r) => setLog(r.tasks), () => undefined);
      }),
    ).then((x) => (gone ? x?.remove?.() : (h = x)));
    return () => {
      gone = true;
      h?.remove?.();
      abort.current?.abort();
    };
  }, [plugin, refresh, client]);
  if (!plugin) return null;

  const register = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    abort.current = new AbortController();
    const r = await enrollPhone(client, plugin, {
      name: deviceName(),
      baseUrl: SERVER_URL,
      appVersion: (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? "0",
      osVersion: navigator.userAgent.match(/OS (\d+[_.]\d+)/)?.[1]?.replace("_", ".") ?? "",
      onStep: setStep,
      signal: abort.current.signal,
    });
    setBusy(false);
    if (r.kind === "done") {
      setStep(null);
      await refresh();
    }
  };
  const pause = async (on: boolean): Promise<void> => {
    setBusy(true);
    setSt(await (on ? plugin.start() : plugin.stop()).catch(() => st));
    setBusy(false);
  };
  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      setSt(await removePhone(client, plugin, st?.machine_id));
      setLog([]);
      setNote(tr("This phone is no longer a node of your account."));
    } catch {
      setNote(tr("The phone could not be removed. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const mins = st ? beatMinutes(st) : null;
  return (
    <section className="ob-conn phone-node-card" aria-labelledby="acc-phone-node" data-phone-node={st?.enrolled ? "enrolled" : "none"}>
      <h3 id="acc-phone-node">{tr("This phone")}</h3>
      {!st?.enrolled ? (
        <>
          <p className="ob-note">{tr("Let Nina run a few readings on this phone for you (zone, calendar, text from an image, transcription), while the app is open. Everything stays read-only.")}</p>
          {step?.kind === "waiting" ? (
            <div className="ob-note" role="status" data-phone-waiting>
              <p>{tr("Approve on another device of yours. Its card shows \"{0}\" and this key, check that they match:", deviceName())}</p>
              <p className="phone-fp" aria-label={tr("Key fingerprint")}>
                <code style={{ fontSize: "1.5em", letterSpacing: "0.12em", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{step.fingerprint}</code>
              </p>
              <button type="button" className="ob-btn ob-btn-ghost" onClick={() => abort.current?.abort()}>
                {tr("Cancel")}
              </button>
            </div>
          ) : (
            <button type="button" className="ob-btn" disabled={busy} onClick={() => void register()} data-phone-register>
              {tr("Register this phone")}
            </button>
          )}
          {step?.kind === "failed" ? (
            <p className="ob-note" role="alert" data-phone-fail={step.code}>
              {failText(step.code)}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className="ob-note" data-phone-state={st.running ? (st.last_error ? "error" : "live") : "paused"}>
            {!st.running
              ? tr("Paused: Nina does not use this phone.")
              : st.last_error
                ? tr("Not reachable right now.")
                : mins === null
                  ? tr("Starting…")
                  : mins < 2
                    ? tr("Reachable while the app is open.")
                    : tr("Last seen {0} min ago.", String(mins))}
          </p>
          <p className="ob-muted">
            {st.key_storage === "secure_enclave" ? tr("Key kept in the Secure Enclave") : tr("Software key (no Secure Enclave)")} · <code>{st.key_fingerprint}</code>
          </p>
          <label className="ob-check">
            <input type="checkbox" checked={st.running} disabled={busy} onChange={(e) => void pause(e.target.checked)} data-phone-running />
            <span>{tr("Available to Nina")}</span>
          </label>
          {log.length ? (
            <ul className="phone-log" aria-label={tr("Recent readings")} style={{ listStyle: "none", padding: 0, margin: "8px 0" }}>
              {log.slice(0, 8).map((t) => (
                <li key={t.task_id}>
                  <span>{opLabel(t.op)}{t.host ? ` (${t.host})` : ""}</span> <span className="ob-muted">· {statusLabel(t.status)} · {new Date(t.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ob-muted">{tr("No reading yet.")}</p>
          )}
          <EgressSettings client={client} st={st} setSt={setSt} />
          {plugin ? <HomeNodeSettings client={client} plugin={plugin} st={st} setSt={setSt} /> : null}
          <button type="button" className="ob-btn ob-btn-ghost" disabled={busy} onClick={() => void remove()} data-phone-remove>
            {tr("Remove this phone")}
          </button>
        </>
      )}
      {note ? <p className="ob-note" role="status">{note}</p> : null}
      <CameraEvents client={client} plugin={plugin} />
    </section>
  );
}

/** P11 : « Laisser Nina ouvrir des pages par ce téléphone » (coupé par défaut), hôtes de la personne, plafond cellulaire. */
function EgressSettings({ client, st, setSt }: { client: NokkerClient; st: NodeStatus; setSt: (s: NodeStatus) => void }): React.ReactElement | null {
  const plugin = nodePlugin();
  const [hosts, setHosts] = useState<string[] | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const on = st.egress?.on === true;
  useEffect(() => {
    if (on) void client.getEgressHosts().then((r) => setHosts(r.hosts), () => setHosts([]));
  }, [client, on]);
  if (!plugin) return null;
  const save = async (next: string[]): Promise<void> => {
    setNote(null);
    try {
      setHosts((await client.putEgressHosts(next)).hosts);
    } catch {
      setNote(tr("The list could not be saved. Try again."));
    }
  };
  const add = (): void => {
    const h = normalizeEgressHost(draft);
    if (!h) return setNote(tr("Enter a site name such as example.ch or *.example.ch (no address of your home network)."));
    setDraft("");
    void save([...(hosts ?? []).filter((x) => x !== h), h]);
  };
  return (
    <div className="phone-egress" data-phone-egress={on ? "on" : "off"}>
      <label className="ob-check">
        <input type="checkbox" checked={on} onChange={(e) => void plugin.setEgress({ on: e.target.checked }).then(setSt, () => undefined)} data-egress-toggle />
        <span>{tr("Let Nina open pages through this phone")}</span>
      </label>
      <p className="ob-muted">{tr("Only for the sites below, or when you tap \"Open through my phone\" on a refused page. Never addresses of your home network.")}</p>
      {on ? (
        <>
          <ul className="phone-hosts" aria-label={tr("Sites opened through this phone")} style={{ listStyle: "none", padding: 0, margin: "8px 0" }}>
            {(hosts ?? []).map((h) => (
              <li key={h} data-egress-host={h} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "4px 0" }}>
                <code>{h}</code>{" "}
                <button type="button" className="ob-btn ob-btn-ghost" onClick={() => void save((hosts ?? []).filter((x) => x !== h))} aria-label={tr("Remove {0}", h)}>
                  {tr("Remove")}
                </button>
              </li>
            ))}
          </ul>
          <form
            className="phone-host-add ob-field"
            style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <input type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} style={{ flex: 1, minWidth: 0 }} placeholder="example.ch" aria-label={tr("Site to add")} data-egress-host-input />
            <button type="submit" className="ob-btn" data-egress-host-add>
              {tr("Add")}
            </button>
          </form>
          <label className="ob-check">
            <input type="checkbox" checked={st.egress?.cellular === true} onChange={(e) => void plugin.setEgress({ cellular: e.target.checked }).then(setSt, () => undefined)} data-egress-cellular />
            <span>{tr("Also on mobile data")}</span>
          </label>
          <p className="ob-muted">{tr("Data saving: off by default on mobile data; never when the phone saves data or its battery is under 20 % and not charging.")}</p>
          {st.egress?.cellular ? (
            <label className="ob-field">
              <span>{tr("Monthly mobile data limit (MB)")}</span>
              <input
                type="number"
                min={0}
                max={10000}
                value={st.egress?.cellular_cap_mb ?? 100}
                onChange={(e) => void plugin.setEgress({ cellular_cap_mb: Number(e.target.value) || 0 }).then(setSt, () => undefined)}
                data-egress-cap
              />
            </label>
          ) : null}
          <p className="ob-muted">{tr("Used this month on mobile data: {0} MB.", String(st.egress?.cellular_used_mb ?? 0))}</p>
        </>
      ) : null}
      {note ? <p className="ob-note" role="alert">{note}</p> : null}
    </div>
  );
}
