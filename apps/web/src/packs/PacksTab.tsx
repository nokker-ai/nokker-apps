/**
 * Onglet « Packs » (LOKKAL §7.30) : packs d'agents livrés avec Nokker. Au web (drapeau `packs_web`) : catalogue,
 * détail, installation de ce qui n'exige pas la machine (cartes d'agents à activer, rien d'armé), relais vers la
 * machine pour le reste, retrait (les agents créés restent : une carte propose quoi en faire). Dans Lokkal : liste et
 * retrait ; l'installation passe par une session (outil `pack_install`, sous carte).
 */
import React, { useCallback, useEffect, useState } from "react";
import { NokkerApiError, type NokkerClient, type PackDetail, type PackInstallResult, type PackMachine, type PackNeed, type PackRemoveResult, type PackSummary } from "@nokker-apps/sdk";
import "./packs.css";

type Toast = (text: string, tone?: "ok" | "error") => void;
type Thread = { id: string; title: string } | null;

export function needLabel(n: PackNeed): string {
  return n.kind === "gpu" ? "un GPU" : n.kind === "mcp" ? `le serveur MCP « ${n.name ?? "?"} »` : `l'outil ${n.name ?? "?"}`;
}

/** « 2 compétences, 1 agent » — vide si rien. */
export function countLine(skills: number, agents: number): string {
  const parts = [skills ? `${skills} compétence${skills > 1 ? "s" : ""}` : "", agents ? `${agents} agent${agents > 1 ? "s" : ""}` : ""].filter(Boolean);
  return parts.join(", ");
}

export function packError(e: unknown): { code: string | null; text: string; machine?: PackMachine; report?: string[] } {
  if (e instanceof NokkerApiError) {
    const err = (e.body as { error?: { code?: string; message?: string; machine?: PackMachine; report?: string[] } } | undefined)?.error;
    const code = err?.code ?? null;
    const text =
      code === "machine_only"
        ? "Rien de ce pack ne s'installe au web : tout demande ta machine."
        : code === "scan_refused"
          ? "Installation refusée par le scanner de sécurité : rien n'a été installé."
          : code === "no_scanner"
            ? "Le scanner de sécurité n'est pas disponible : rien n'a été installé."
            : code === "unknown_thread"
              ? "Cette session n'existe plus : choisis-en une autre."
              : err?.message || `refus du serveur (${e.status})`;
    return { code, text, ...(err?.machine ? { machine: err.machine } : {}), ...(err?.report ? { report: err.report } : {}) };
  }
  return { code: null, text: "le serveur ne répond pas" };
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
        <p className="fine">Des compétences et des modèles d'agents livrés avec Nokker, vérifiés avant l'installation.</p>
        {err ? (
          <p className="error" role="alert">
            {err}
          </p>
        ) : null}
        {packs === null ? (
          <p className="fine">Chargement…</p>
        ) : (
          <ul className="team-list">
            {packs.map((p) => (
              <li key={p.name}>
                <button type="button" className={`team-item ${p.name === sel ? "on" : ""}`} aria-current={p.name === sel ? "true" : undefined} onClick={() => setSel(p.name)}>
                  <strong>{p.title}</strong>
                  {p.installed ? <span className="chip role-member">installé</span> : null}
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
      <h4>Le reste, sur ta machine</h4>
      {m.skills.length ? <p className="fine">Compétences : {m.skills.join(", ")}</p> : null}
      {m.agents.length ? (
        <ul className="secret-list">
          {m.agents.map((a) => (
            <li key={a.template}>
              <code>{a.template}</code> <span className="fine">demande {a.needs.map(needLabel).join(", ")}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {m.linked.length ? (
        <p className="fine">
          Machines liées :{" "}
          {m.linked.map((x) => (
            <span key={x.machine_id} className="chip">
              <span className={`pack-dot ${x.online ? "on" : ""}`} aria-hidden="true" /> {x.name} {x.online ? "en ligne" : "hors ligne"}
            </span>
          ))}
        </p>
      ) : null}
      {m.handoff ? (
        <p className="pack-handoff" role="status">
          Relais proposé vers « {String(m.handoff.machine_name ?? "ta machine")} » : accepte-le dans la session pour installer le reste là-bas.{" "}
          {threadId ? (
            <button type="button" className="btn btn-sm" onClick={() => onOpenThread(threadId)}>
              Ouvrir la session
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
  if (!d) return refusal ? <p className="error">{refusal.text}</p> : <p className="fine">Chargement…</p>;
  const thread = cards && currentThread ? currentThread.id : undefined;
  const hasMachine = !!(d.machine?.skills.length || d.machine?.agents.length);

  const install = async (): Promise<void> => {
    setBusy(true);
    setRefusal(null);
    setRemoved(null);
    try {
      const r = await client.installPack(name, { ...(thread ? { thread_id: thread } : {}), ...(handoff && thread ? { handoff: true } : {}) });
      setResult(r);
      toast(r.proposed.length ? `Pack « ${d.title} » installé : ${r.proposed.length} carte(s) d'agent à activer dans « ${currentThread?.title} ».` : `Pack « ${d.title} » installé.`, "ok");
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
      toast(r.proposed.length ? `${r.proposed.length} carte(s) posée(s) dans « ${currentThread.title} ».` : "Rien à proposer : chaque modèle a déjà son agent.", "ok");
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
      toast(`Pack « ${d.title} » retiré.`, "ok");
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
            Au web : {countLine(d.web?.skills.length ?? 0, d.web?.agents.length ?? 0) || "rien"}
            {hasMachine ? ` · sur la machine : ${countLine(d.machine!.skills.length, d.machine!.agents.length)}` : ""}
          </p>
        </div>
      </header>

      <section className="machine-section">
        <h3>Compétences</h3>
        <ul className="secret-list">
          {d.skills.map((s) => (
            <li key={s.name}>
              <code>{s.name}</code> <span className="fine">{s.description}</span> {s.locality === "local" ? <span className="chip">machine seulement</span> : null}
            </li>
          ))}
        </ul>
        {d.agents.length ? (
          <>
            <h3>Modèles d'agents</h3>
            <ul className="secret-list">
              {d.agents.map((a) => (
                <li key={a.id}>
                  <strong>{a.name}</strong> <span className="fine">{a.role}</span> {d.machine?.agents.some((m) => m.template === a.id) ? <span className="chip">machine seulement</span> : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {d.connectors.length ? <p className="fine">Demande les connecteurs du compte : {d.connectors.join(", ")}.</p> : null}
        {d.mcp.length ? (
          <p className="fine">
            Serveurs MCP à ajouter sur ta machine : {d.mcp.map((r) => `${r.role} (${r.purpose})`).join(" ; ")}.
          </p>
        ) : null}
      </section>

      {d.installed && d.install ? (
        <section className="machine-section">
          <h3>Installé</h3>
          <p className="fine">
            Version {d.install.version} · le {new Date(d.install.installed_at * 1000).toLocaleDateString("fr-CH")} · {countLine(d.install.skills.length, d.install.templates.length)}
          </p>
          {d.created_agents?.length ? (
            <p className="fine">
              Agents créés depuis ce pack : {d.created_agents.map((a) => `${a.name} (${a.armed ? "armé" : "au repos"})`).join(", ")} — dans Crew.
            </p>
          ) : null}
          <span className="team-row-actions">
            {currentThread ? (
              <button type="button" className="btn" disabled={busy} onClick={() => void proposeAgain()}>
                Proposer les cartes dans « {currentThread.title} »
              </button>
            ) : null}
            {confirmRm ? (
              <>
                <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>
                  Oui, retirer
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setConfirmRm(false)}>
                  Annuler
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirmRm(true)}>
                Retirer le pack
              </button>
            )}
          </span>
          {confirmRm ? <p className="fine">Ses compétences partent et ses cartes non activées se ferment. Les agents déjà créés restent : une carte te proposera de les désarmer ou de les supprimer.</p> : null}
        </section>
      ) : (
        <section className="machine-section">
          <h3>Installer</h3>
          <label className="team-check">
            <input type="checkbox" checked={cards && !!currentThread} disabled={!currentThread} onChange={(e) => setCards(e.target.checked)} /> poser les cartes d'agents dans
            {currentThread ? ` « ${currentThread.title} »` : " une session (ouvre-en une d'abord)"}
          </label>
          {hasMachine ? (
            <label className="team-check">
              <input type="checkbox" checked={handoff} disabled={!thread} onChange={(e) => setHandoff(e.target.checked)} /> proposer un relais vers ma machine pour le reste
            </label>
          ) : null}
          <p className="fine">Rien n'est créé ni armé : chaque agent s'active depuis sa carte. Les compétences passent d'abord le scanner de sécurité.</p>
          <button type="button" className="btn btn-brass" disabled={busy} onClick={() => void install()}>
            {busy ? "Installation…" : "Installer"}
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
          <h3>Installé au web</h3>
          {result.skills.length ? <p className="fine">Compétences : {result.skills.join(", ")}.</p> : null}
          {result.proposed.length && currentThread ? (
            <p>
              {result.proposed.length} carte(s) d'agent dans « {currentThread.title} » : vérifie-les, puis active-les.{" "}
              <button type="button" className="btn btn-sm" onClick={() => onOpenThread(currentThread.id)}>
                Ouvrir la session
              </button>
            </p>
          ) : null}
          {result.to_propose?.length ? <p className="fine">Modèles à proposer plus tard : {result.to_propose.map((t) => t.template).join(", ")} (ouvre une session, puis « Proposer les cartes »).</p> : null}
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
        Pack retiré{r.already_removed ? " (il l'était déjà)" : ""}
        {r.drafts_closed.length ? ` · ${r.drafts_closed.length} carte(s) non activée(s) fermée(s)` : ""}.
      </p>
      {r.agents?.length ? (
        <p className="fine">
          {r.agents.length} agent(s) créé(s) depuis ce pack restent tels quels{r.card && thread ? ` : la carte « Agents du pack » dans « ${thread.title} » te propose de les désarmer ou de les supprimer.` : " : désarme-les ou supprime-les depuis Crew si tu veux."}{" "}
          {r.card && thread ? (
            <button type="button" className="btn btn-sm" onClick={() => onOpenThread(thread.id)}>
              Ouvrir la session
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
      toast(`Pack « ${p.title} » retiré de la machine.`, "ok");
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
            {p.mcp.length ? ` · serveurs MCP : ${p.mcp.join(", ")}` : ""}
            {p.connectors.length ? ` · connecteurs : ${p.connectors.join(", ")}` : ""}
          </p>
        </div>
      </header>
      {p.installed ? (
        <span className="team-row-actions">
          {confirmRm ? (
            <>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>
                Oui, retirer
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmRm(false)}>
                Annuler
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirmRm(true)}>
              Retirer le pack
            </button>
          )}
        </span>
      ) : (
        <p className="fine">Pour l'installer sur cette machine, demande-le dans une session : « installe le pack {p.name} » (Nina le fait sous ta carte, après le scanner).</p>
      )}
      {removed ? <RemovedNote r={removed} thread={currentThread} onOpenThread={() => undefined} /> : null}
    </div>
  );
}
