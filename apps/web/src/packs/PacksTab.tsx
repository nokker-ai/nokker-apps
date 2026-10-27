/**
 * Onglet « Packs » (LOKKAL §7.30) : packs d'agents livrés avec Nokker. Au web (drapeau `packs_web`) : catalogue,
 * détail, installation de ce qui n'exige pas la machine (cartes d'agents à activer, rien d'armé), relais vers la
 * machine pour le reste, retrait (les agents créés restent : une carte propose quoi en faire). Dans Lokkal : liste et
 * retrait ; l'installation passe par une session (outil `pack_install`, sous carte).
 */
import React, { useCallback, useEffect, useState } from "react";
import { NokkerApiError, type NokkerClient, type PackDetail, type PackInstallResult, type PackMachine, type PackNeed, type PackRemoveResult, type PackSummary } from "@nokker-apps/sdk";
import { shellLang, tr } from "../i18n/index.js";
import "./packs.css";

type Toast = (text: string, tone?: "ok" | "error") => void;
type Thread = { id: string; title: string } | null;

export function needLabel(n: PackNeed): string {
  return n.kind === "gpu" ? tr("a GPU") : n.kind === "mcp" ? tr("the MCP server “{0}”", n.name ?? "?") : tr("the {0} tool", n.name ?? "?");
}

/** « 2 skills, 1 agent » — vide si rien. */
export function countLine(skills: number, agents: number): string {
  const parts = [
    skills ? (skills > 1 ? tr("{0} skills", skills) : tr("{0} skill", skills)) : "",
    agents ? (agents > 1 ? tr("{0} agents", agents) : tr("{0} agent", agents)) : "",
  ].filter(Boolean);
  return parts.join(", ");
}

export function packError(e: unknown): { code: string | null; text: string; machine?: PackMachine; report?: string[] } {
  if (e instanceof NokkerApiError) {
    const err = (e.body as { error?: { code?: string; message?: string; machine?: PackMachine; report?: string[] } } | undefined)?.error;
    const code = err?.code ?? null;
    const text =
      code === "machine_only"
        ? tr("Nothing in this pack installs on the web: everything needs your machine.")
        : code === "scan_refused"
          ? tr("Installation refused by the security scanner: nothing was installed.")
          : code === "no_scanner"
            ? tr("The security scanner is not available: nothing was installed.")
            : code === "unknown_thread"
              ? tr("This session no longer exists: pick another one.")
              : err?.message || tr("server refused ({0})", e.status);
    return { code, text, ...(err?.machine ? { machine: err.machine } : {}), ...(err?.report ? { report: err.report } : {}) };
  }
  return { code: null, text: tr("the server is not responding") };
}

export function PacksTab({ client, local, currentThread, toast, onOpenThread }: { client: NokkerClient; local: boolean; currentThread: Thread; toast: Toast; onOpenThread: (id: string) => void }): React.ReactElement {
  const [packs, setPacks] = useState<PackSummary[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const l = local ? await client.listLocalPacks() : await client.listPacks();
      setPacks(l.packs as PackSummary[]);
      setSel((cur) => cur ?? l.packs[0]?.name ?? null);
      setErr(null);
    } catch (e) {
      setErr(packError(e).text);
      setPacks((p) => p ?? []);
    }
  }, [client, local]);
  useEffect(() => {
    void load();
  }, [load]);
  const current = packs?.find((p) => p.name === sel) ?? null;

  return (
    <section className="team-tab packs-tab" aria-label="Packs">
      <aside className="team-side">
        <h2>Packs</h2>
        <p className="fine">{tr("Skills and agent templates shipped with Nokker, checked before installation.")}</p>
        {err ? (
          <p className="error" role="alert">
            {err}
          </p>
        ) : null}
        {packs === null ? (
          <p className="fine">{tr("Loading…")}</p>
        ) : (
          <ul className="team-list">
            {packs.map((p) => (
              <li key={p.name}>
                <button type="button" className={`team-item ${p.name === sel ? "on" : ""}`} aria-current={p.name === sel ? "true" : undefined} onClick={() => setSel(p.name)}>
                  <strong>{p.title}</strong>
                  {p.installed ? <span className="chip role-member">{tr("installed")}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <div className="team-main">
        {current ? (
          local ? (
            <LocalPack key={current.name} client={client} pack={current} currentThread={currentThread} toast={toast} onChanged={() => void load()} />
          ) : (
            <WebPack key={current.name} client={client} name={current.name} currentThread={currentThread} toast={toast} onChanged={() => void load()} onOpenThread={onOpenThread} />
          )
        ) : null}
      </div>
    </section>
  );
}

function MachinePart({ m, onOpenThread, threadId }: { m: PackMachine; onOpenThread: (id: string) => void; threadId: string | null }): React.ReactElement {
  return (
    <div className="pack-machine">
      <h4>{tr("The rest, on your machine")}</h4>
      {m.skills.length ? <p className="fine">{tr("Skills: {0}", m.skills.join(", "))}</p> : null}
      {m.agents.length ? (
        <ul className="secret-list">
          {m.agents.map((a) => (
            <li key={a.template}>
              <code>{a.template}</code> <span className="fine">{tr("needs {0}", a.needs.map(needLabel).join(", "))}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {m.linked.length ? (
        <p className="fine">
          {tr("Linked machines:")}{" "}
          {m.linked.map((x) => (
            <span key={x.machine_id} className="chip">
              <span className={`pack-dot ${x.online ? "on" : ""}`} aria-hidden="true" /> {x.name} {x.online ? tr("online") : tr("offline")}
            </span>
          ))}
        </p>
      ) : null}
      {m.handoff ? (
        <p className="pack-handoff" role="status">
          {tr("Handoff offered to “{0}”: accept it in the session to install the rest there.", String(m.handoff.machine_name ?? tr("your machine")))}{" "}
          {threadId ? (
            <button type="button" className="btn btn-sm" onClick={() => onOpenThread(threadId)}>
              {tr("Open the session")}
            </button>
          ) : null}
        </p>
      ) : (
        <p className="fine">{m.next}</p>
      )}
    </div>
  );
}

function WebPack({ client, name, currentThread, toast, onChanged, onOpenThread }: { client: NokkerClient; name: string; currentThread: Thread; toast: Toast; onChanged: () => void; onOpenThread: (id: string) => void }): React.ReactElement {
  const [d, setD] = useState<PackDetail | null>(null);
  const [cards, setCards] = useState(true);
  const [handoff, setHandoff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PackInstallResult | null>(null);
  const [refusal, setRefusal] = useState<ReturnType<typeof packError> | null>(null);
  const [confirmRm, setConfirmRm] = useState(false);
  const [removed, setRemoved] = useState<PackRemoveResult | null>(null);
  const load = useCallback(async () => {
    try {
      setD(await client.getPack(name));
    } catch (e) {
      setRefusal(packError(e));
    }
  }, [client, name]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!d) return refusal ? <p className="error">{refusal.text}</p> : <p className="fine">{tr("Loading…")}</p>;
  const thread = cards && currentThread ? currentThread.id : undefined;
  const hasMachine = !!(d.machine?.skills.length || d.machine?.agents.length);

  const install = async (): Promise<void> => {
    setBusy(true);
    setRefusal(null);
    setRemoved(null);
    try {
      const r = await client.installPack(name, { ...(thread ? { thread_id: thread } : {}), ...(handoff && thread ? { handoff: true } : {}) });
      setResult(r);
      toast(
        r.proposed.length
          ? tr("Pack “{0}” installed: {1} agent card(s) to activate in “{2}”.", d.title, r.proposed.length, currentThread?.title ?? "")
          : tr("Pack “{0}” installed.", d.title),
        "ok",
      );
      onChanged();
      await load();
    } catch (e) {
      setRefusal(packError(e));
    } finally {
      setBusy(false);
    }
  };
  const proposeAgain = async (): Promise<void> => {
    if (!currentThread) return;
    setBusy(true);
    try {
      const r = await client.proposePack(name, { thread_id: currentThread.id });
      toast(r.proposed.length ? tr("{0} card(s) placed in “{1}”.", r.proposed.length, currentThread.title) : tr("Nothing to propose: every template already has its agent."), "ok");
      await load();
    } catch (e) {
      toast(packError(e).text, "error");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (): Promise<void> => {
    setBusy(true);
    setConfirmRm(false);
    try {
      const r = await client.removePack(name, currentThread?.id);
      setRemoved(r);
      setResult(null);
      toast(tr("Pack “{0}” removed.", d.title), "ok");
      onChanged();
      await load();
    } catch (e) {
      toast(packError(e).text, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="team-project pack-detail">
      <header className="team-head">
        <div>
          <h2>{d.title}</h2>
          <p className="fine">{d.description}</p>
          <p className="fine">
            {tr("On the web: {0}", countLine(d.web?.skills.length ?? 0, d.web?.agents.length ?? 0) || tr("nothing"))}
            {hasMachine ? tr(" · on the machine: {0}", countLine(d.machine!.skills.length, d.machine!.agents.length)) : ""}
          </p>
        </div>
      </header>

      <section className="machine-section">
        <h3>{tr("Skills")}</h3>
        <ul className="secret-list">
          {d.skills.map((s) => (
            <li key={s.name}>
              <code>{s.name}</code> <span className="fine">{s.description}</span> {s.locality === "local" ? <span className="chip">{tr("machine only")}</span> : null}
            </li>
          ))}
        </ul>
        {d.agents.length ? (
          <>
            <h3>{tr("Agent templates")}</h3>
            <ul className="secret-list">
              {d.agents.map((a) => (
                <li key={a.id}>
                  <strong>{a.name}</strong> <span className="fine">{a.role}</span> {d.machine?.agents.some((m) => m.template === a.id) ? <span className="chip">{tr("machine only")}</span> : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {d.connectors.length ? <p className="fine">{tr("Needs the account connectors: {0}.", d.connectors.join(", "))}</p> : null}
        {d.mcp.length ? (
          <p className="fine">
            {tr("MCP servers to add on your machine: {0}.", d.mcp.map((r) => `${r.role} (${r.purpose})`).join("; "))}
          </p>
        ) : null}
      </section>

      {d.installed && d.install ? (
        <section className="machine-section">
          <h3>{tr("Installed")}</h3>
          <p className="fine">
            {tr("Version {0} · on {1} · {2}", d.install.version, new Date(d.install.installed_at * 1000).toLocaleDateString(shellLang() === "fr" ? "fr-CH" : "en-GB"), countLine(d.install.skills.length, d.install.templates.length))}
          </p>
          {d.created_agents?.length ? (
            <p className="fine">
              {tr("Agents created from this pack: {0} — in Crew.", d.created_agents.map((a) => `${a.name} (${a.armed ? tr("armed") : tr("idle")})`).join(", "))}
            </p>
          ) : null}
          <span className="team-row-actions">
            {currentThread ? (
              <button type="button" className="btn" disabled={busy} onClick={() => void proposeAgain()}>
                {tr("Propose the cards in “{0}”", currentThread.title)}
              </button>
            ) : null}
            {confirmRm ? (
              <>
                <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>
                  {tr("Yes, remove")}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setConfirmRm(false)}>
                  {tr("Cancel")}
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirmRm(true)}>
                {tr("Remove the pack")}
              </button>
            )}
          </span>
          {confirmRm ? <p className="fine">{tr("Its skills go away and its unactivated cards close. Agents already created stay: a card will offer to disarm or delete them.")}</p> : null}
        </section>
      ) : (
        <section className="machine-section">
          <h3>{tr("Install")}</h3>
          <label className="team-check">
            <input type="checkbox" checked={cards && !!currentThread} disabled={!currentThread} onChange={(e) => setCards(e.target.checked)} />{" "}
            {currentThread ? tr("place the agent cards in “{0}”", currentThread.title) : tr("place the agent cards in a session (open one first)")}
          </label>
          {hasMachine ? (
            <label className="team-check">
              <input type="checkbox" checked={handoff} disabled={!thread} onChange={(e) => setHandoff(e.target.checked)} /> {tr("offer a handoff to my machine for the rest")}
            </label>
          ) : null}
          <p className="fine">{tr("Nothing is created or armed: each agent is activated from its card. Skills go through the security scanner first.")}</p>
          <button type="button" className="btn btn-brass" disabled={busy} onClick={() => void install()}>
            {busy ? tr("Installing…") : tr("Install")}
          </button>
        </section>
      )}

      {refusal ? (
        <section className="machine-section" role="alert">
          <p className="error">{refusal.text}</p>
          {refusal.report?.length ? (
            <ul className="pack-report">
              {refusal.report.map((r, i) => (
                <li key={i}>
                  <code>{r}</code>
                </li>
              ))}
            </ul>
          ) : null}
          {refusal.machine ? <MachinePart m={refusal.machine} onOpenThread={onOpenThread} threadId={thread ?? null} /> : null}
        </section>
      ) : null}

      {result ? (
        <section className="machine-section" role="status">
          <h3>{tr("Installed on the web")}</h3>
          {result.skills.length ? <p className="fine">{tr("Skills: {0}.", result.skills.join(", "))}</p> : null}
          {result.proposed.length && currentThread ? (
            <p>
              {tr("{0} agent card(s) in “{1}”: review them, then activate them.", result.proposed.length, currentThread.title)}{" "}
              <button type="button" className="btn btn-sm" onClick={() => onOpenThread(currentThread.id)}>
                {tr("Open the session")}
              </button>
            </p>
          ) : null}
          {result.to_propose?.length ? <p className="fine">{tr("Templates to propose later: {0} (open a session, then “Propose the cards”).", result.to_propose.map((t) => t.template).join(", "))}</p> : null}
          {result.setup?.map((s) => (
            <p key={s} className="fine">
              {s}
            </p>
          ))}
          {result.machine ? <MachinePart m={result.machine} onOpenThread={onOpenThread} threadId={thread ?? null} /> : null}
        </section>
      ) : null}

      {removed ? <RemovedNote r={removed} thread={currentThread} onOpenThread={onOpenThread} /> : null}
    </div>
  );
}

function RemovedNote({ r, thread, onOpenThread }: { r: PackRemoveResult; thread: Thread; onOpenThread: (id: string) => void }): React.ReactElement {
  return (
    <section className="machine-section" role="status">
      <p>
        {tr("Pack removed")}
        {r.already_removed ? tr(" (it already was)") : ""}
        {r.drafts_closed.length ? tr(" · {0} unactivated card(s) closed", r.drafts_closed.length) : ""}.
      </p>
      {r.agents?.length ? (
        <p className="fine">
          {tr("{0} agent(s) created from this pack stay as they are", r.agents.length)}
          {r.card && thread ? tr(": the “Pack agents” card in “{0}” offers to disarm or delete them.", thread.title) : tr(": disarm or delete them from Crew if you want.")}{" "}
          {r.card && thread ? (
            <button type="button" className="btn btn-sm" onClick={() => onOpenThread(thread.id)}>
              {tr("Open the session")}
            </button>
          ) : null}
        </p>
      ) : null}
      {r.error ? <p className="error">{r.error}</p> : null}
    </section>
  );
}

function LocalPack({ client, pack: p, currentThread, toast, onChanged }: { client: NokkerClient; pack: PackSummary; currentThread: Thread; toast: Toast; onChanged: () => void }): React.ReactElement {
  const [confirmRm, setConfirmRm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState<PackRemoveResult | null>(null);
  const remove = async (): Promise<void> => {
    setBusy(true);
    setConfirmRm(false);
    try {
      setRemoved(await client.removeLocalPack(p.name, currentThread?.id));
      toast(tr("Pack “{0}” removed from the machine.", p.title), "ok");
      onChanged();
    } catch (e) {
      toast(packError(e).text, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="team-project pack-detail">
      <header className="team-head">
        <div>
          <h2>{p.title}</h2>
          <p className="fine">{p.description}</p>
          <p className="fine">
            {countLine(p.skills.length, p.agents.length)}
            {p.mcp.length ? tr(" · MCP servers: {0}", p.mcp.join(", ")) : ""}
            {p.connectors.length ? tr(" · connectors: {0}", p.connectors.join(", ")) : ""}
          </p>
        </div>
      </header>
      {p.installed ? (
        <span className="team-row-actions">
          {confirmRm ? (
            <>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>
                {tr("Yes, remove")}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmRm(false)}>
                {tr("Cancel")}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirmRm(true)}>
              {tr("Remove the pack")}
            </button>
          )}
        </span>
      ) : (
        <p className="fine">{tr("To install it on this machine, ask in a session: “install the {0} pack” (Nina does it under your card, after the scanner).", p.name)}</p>
      )}
      {removed ? <RemovedNote r={removed} thread={currentThread} onOpenThread={() => undefined} /> : null}
    </div>
  );
}
