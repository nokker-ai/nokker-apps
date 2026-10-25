/**
 * Skills du dépôt et sous-agents d'une session de code (LOKKAL §7.28 points 13 et 14). Skills : bandeau de confiance
 * quand l'arbre `.nokker/skills` est `untrusted` (empreinte, nombre, avis : leur contenu ne se lit qu'après la
 * confiance), puis la liste par `skill_list` / `skill_view`. Sous-agents : vivants sur plafond, état par
 * `delegate_status` (jamais `wait_s`), arrêt par `delegate_cancel`, rafraîchis par les événements `subagent.*` ; leurs
 * cartes (fil `<cs>/sa-<id>`) se décident ici avec la carte d'approbation habituelle.
 */
import React, { useCallback, useEffect, useState } from "react";
import { NokkerApiError, parseToolJson, type Approval, type CodeSession, type DelegateCancelResult, type DelegateStatusResult, type NokkerClient, type NokkerEvent, type SkillInfo } from "@nokker-apps/sdk";
import { ApprovalCard } from "../bubbles/kinds.js";
import { Markdown } from "../Markdown.js";
import { apiCode, c, codeError, subStatus, type Lang } from "./model.js";

type Toast = (text: string, tone?: "ok" | "error") => void;
type OnCodeEvent = (fn: (e: NokkerEvent) => void) => () => void;

/** L'événement concerne-t-il cette session ? Le fil parent est l'id `cs_…`, préfixé ou non du locataire. */
export function eventSession(e: NokkerEvent): string | null {
  if (e.type !== "skill.untrusted" && !e.type.startsWith("subagent.")) return null;
  const f = e as { session_id?: string; parent_thread_id?: string; thread_id?: string };
  const raw = f.session_id ?? f.parent_thread_id ?? f.thread_id;
  if (!raw) return null;
  const root = raw.split("/sa-")[0]!;
  return root.slice(root.lastIndexOf(":") + 1);
}

export const shortSha = (sha: string | null | undefined): string => (sha ? sha.slice(0, 12) : "—");

export function SessionSkills({ s, client, lang, toast, onChanged }: { s: CodeSession; client: NokkerClient; lang: Lang; toast: Toast; onChanged: () => Promise<void> }): React.ReactElement | null {
  const sk = s.skills;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!sk || !sk.enabled) return null;
  if (sk.project === "absent") return <p className="fine">{c(lang, "skillsAbsent")}</p>;
  if (sk.project === "invalid")
    return (
      <div className="code-confirm">
        <p className="code-warn">
          <strong>{c(lang, "skillsInvalid")}</strong>
          {sk.notice ? ` : ${sk.notice}` : ""}
        </p>
      </div>
    );
  if (sk.project === "untrusted") {
    const trust = async (): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await client.trustCodeSessionSkills(s.id, sk.sha256 ?? "");
        toast(c(lang, "skillsTrusted"), "ok");
        await onChanged();
      } catch (e) {
        setError(apiCode(e) === "skills_changed" ? c(lang, "skillsChanged") : codeError(lang, e));
        if (apiCode(e) === "skills_changed") await onChanged();
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="code-confirm code-skills-trust" role="group" aria-label={c(lang, "skills")}>
        <p>{c(lang, "skillsUntrusted", { count: sk.count, root: sk.root })}</p>
        {sk.notice ? <p className="fine">{sk.notice}</p> : null}
        <p className="fine mono">{c(lang, "skillsSha", { sha: shortSha(sk.sha256) })}</p>
        <p className="fine">{c(lang, "skillsNoPreview")}</p>
        <span className="code-actions">
          <button type="button" className="btn btn-brass" disabled={busy || !sk.sha256} onClick={() => void trust()}>
            {c(lang, "skillsTrust")}
          </button>
        </span>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }
  return <SkillList s={s} client={client} lang={lang} />;
}

function SkillList({ s, client, lang }: { s: CodeSession; client: NokkerClient; lang: Lang }): React.ReactElement {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState<{ name: string; content: string; files: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    client.callCodeSessionTool(s.id, "skill_list").then(
      (r) => {
        if (!live || "approval_id" in r) return;
        const v = r.is_error ? null : parseToolJson<{ skills: SkillInfo[]; note?: string }>(r.content);
        setSkills(v?.skills ?? []);
        setNote(v?.note ?? (r.is_error ? r.content : null));
      },
      (e) => live && setError(codeError(lang, e)),
    );
    return () => {
      live = false;
    };
  }, [client, s.id, s.skills?.sha256, lang]);
  const view = async (name: string): Promise<void> => {
    if (open?.name === name) return setOpen(null);
    try {
      const r = await client.callCodeSessionTool(s.id, "skill_view", { name });
      if ("approval_id" in r) return;
      if (r.is_error) return setError(r.content);
      const v = parseToolJson<{ content?: string; linked_files?: string[] }>(r.content);
      setOpen({ name, content: v?.content ?? r.content, files: v?.linked_files ?? [] });
    } catch (e) {
      setError(codeError(lang, e));
    }
  };
  return (
    <div className="code-skills">
      <h4>{c(lang, "skillsList")}</h4>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {note ? <p className="fine">{note}</p> : null}
      {skills && !skills.length ? <p className="fine">{c(lang, "skillsNone")}</p> : null}
      {skills?.length ? (
        <ul className="code-skill-list">
          {skills.map((k) => (
            <li key={`${k.source}:${k.name}`}>
              <div className="code-point">
                <code>{k.category ? `${k.category}/${k.name}` : k.name}</code>
                <span className="code-point-reason">{k.description}</span>
                <span className="chip">{k.source}</span>
              </div>
              <span className="code-actions">
                <button type="button" className="btn btn-sm" aria-expanded={open?.name === k.name} onClick={() => void view(k.name)}>
                  {c(lang, open?.name === k.name ? "skillsHide" : "skillsView")}
                </button>
              </span>
              {open?.name === k.name ? (
                <div className="code-skill-view">
                  <Markdown text={open.content} />
                  {open.files.length ? <p className="fine">{c(lang, "skillsFiles", { files: open.files.join(", ") })}</p> : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function SessionSubagents({
  s,
  client,
  lang,
  toast,
  onCodeEvent,
  onChanged,
}: {
  s: CodeSession;
  client: NokkerClient;
  lang: Lang;
  toast: Toast;
  onCodeEvent: OnCodeEvent;
  onChanged: () => Promise<void>;
}): React.ReactElement | null {
  const [st, setSt] = useState<DelegateStatusResult | null>(null);
  const [cards, setCards] = useState<Approval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await client.callCodeSessionTool(s.id, "delegate_status");
      if ("approval_id" in r) return;
      if (r.is_error) setError(r.content);
      else {
        setSt(parseToolJson<DelegateStatusResult>(r.content));
        setError(null);
      }
    } catch (e) {
      // Un tour tient le fil : on garde l'état connu, l'événement suivant relira.
      if (!(e instanceof NokkerApiError && apiCode(e) === "turn_running")) setError(codeError(lang, e));
    }
    // Cartes des enfants : le flux habituel des cartes (le noyau ne les montre qu'au propriétaire de la session).
    client.listApprovals("pending").then(
      (l) => setCards(l.filter((a) => a.thread_id.startsWith(`${s.id}/sa-`) || a.thread_id.includes(`:${s.id}/sa-`))),
      () => undefined,
    );
  }, [client, s.id, lang]);
  useEffect(() => {
    void load();
  }, [load]);
  // En direct : `subagent.*` de CETTE session relisent l'état (et le compteur de la carte).
  useEffect(
    () =>
      onCodeEvent((e) => {
        if (!e.type.startsWith("subagent.") || eventSession(e) !== s.id) return;
        void load();
        if (e.type !== "subagent.progress") void onChanged();
      }),
    [onCodeEvent, s.id, load, onChanged],
  );

  if (!s.subagents) return null;
  const stop = async (ids?: string[]): Promise<void> => {
    setBusy(true);
    try {
      const r = await client.callCodeSessionTool(s.id, "delegate_cancel", ids ? { ids } : {});
      if (!("approval_id" in r) && !r.is_error) toast(c(lang, "subStopped", { n: parseToolJson<DelegateCancelResult>(r.content)?.cancelled.length ?? 0 }), "ok");
      else if (!("approval_id" in r)) setError(r.content);
      await load();
      await onChanged();
    } catch (e) {
      setError(codeError(lang, e));
    } finally {
      setBusy(false);
    }
  };
  const live = (x: { status: string }): boolean => x.status === "queued" || x.status === "running" || x.status === "stopping";
  const kids = st?.children ?? [];
  return (
    <div className="code-subagents" aria-label={c(lang, "sub")}>
      <div className="code-head">
        <h4>{c(lang, "sub")}</h4>
        <span className="fine">{c(lang, "subLive", { live: s.subagents.live, limit: s.subagents.limit })}</span>
        <span className="code-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void load()}>
            {c(lang, "subRefresh")}
          </button>
          {kids.some(live) ? (
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void stop()}>
              {c(lang, "subStopAll")}
            </button>
          ) : null}
        </span>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {cards.length ? (
        <div className="code-sub-cards">
          <p className="code-warn">{c(lang, "subCards")}</p>
          {cards.map((a) => (
            <ApprovalCard key={a.id} approvalId={a.id} uid={`code-${a.id}`} />
          ))}
        </div>
      ) : null}
      {st && !kids.length ? <p className="fine">{c(lang, "subNone")}</p> : null}
      {kids.length ? (
        <ul className="code-point-list">
          {kids.map((k) => (
            <li key={k.child_id}>
              <div className="code-point">
                <code>{k.child_id}</code>
                <span className="code-point-reason">{k.goal}</span>
                <span className={`chip ${live(k) ? "ok" : ""}`}>{subStatus(lang, k.status)}</span>
                <span className="fine">
                  {c(lang, "subElapsed", { s: Math.round(k.elapsed_s) })}
                  {k.last_tool && live(k) ? ` · ${k.last_tool}` : ""}
                  {k.worktree?.branch ? ` · ${c(lang, "subBranch", { branch: k.worktree.branch })}` : ""}
                </span>
              </div>
              {k.summary || k.error ? <p className="fine">{k.summary ?? k.error}</p> : null}
              {live(k) ? (
                <span className="code-actions">
                  <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void stop([k.child_id])}>
                    {c(lang, "subStop")}
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
