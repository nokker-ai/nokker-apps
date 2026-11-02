/**
 * « Tu viens d'un autre agent ? » (lot 30), à la fin du premier lancement de Lokkal : reprendre skills, consignes et
 * serveurs MCP d'une installation Claude Code, Cursor, Hermes ou OpenClaw. Rien n'est écrit avant « Importer » ; aucun
 * secret n'est copié ; un serveur MCP s'ajoute dans une session (Nina le propose, la carte forte fait foi). Si le
 * noyau ne voit pas l'installation (cas normal sous docker), la commande à lancer sur la machine, puis son rapport.
 */
import React, { useState } from "react";
import type { ImportItem, ImportReport, ImportSource, NokkerClient } from "@nokker-apps/sdk";
import { IMPORT_REASONS, t, type Key, type Lang } from "./i18n.js";
import { SOURCES, groupReport, hostCommand, itemLabel, mcpRequest, nothingVisible } from "./importModel.js";

const KIND: Record<string, Key> = {
  skill: "impKindSkill",
  subagent: "impKindSubagent",
  "user-note": "impKindNote",
  rules: "impKindRules",
  hooks: "impKindHooks",
  hook: "impKindHooks",
  permission: "impKindPermission",
  cron: "impKindCron",
  "secret-name": "impKindSecret",
  mcp: "impKindMcp",
  model: "impKindModel",
  channel: "impKindChannel",
  prompt: "impKindPrompt",
  "codex-memory": "impKindNote",
  sandbox: "impKindSandbox",
};
const kindLabel = (L: Lang, kind: string): string => t(L, KIND[kind] ?? "impKindOther");
/** Raison traduite par son code ; le texte du noyau (français) en repli. */
const reasonText = (L: Lang, it: ImportItem): string => (it.code && IMPORT_REASONS[L][it.code]) || it.reason;

/** A copy button next to a command or a request: « Copied », or « Cannot copy » (clipboard refused, no API). */
export function CopyButton({ text, lang: L, copy = (t: string) => navigator.clipboard.writeText(t) }: { text: string; lang: Lang; copy?: (t: string) => Promise<void> }): React.ReactElement {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <button
      type="button"
      className={`imp-copy ${state}`}
      aria-label={`${t(L, "impCopy")}${L === "fr" ? " : " : ": "}${text}`}
      onClick={() => {
        let p: Promise<void>;
        try {
          p = copy(text);
        } catch {
          p = Promise.reject(new Error("no clipboard"));
        }
        void p.then(
          () => setState("ok"),
          () => setState("fail"),
        );
      }}
    >
      <span aria-live="polite">{state === "ok" ? t(L, "impCopied") : state === "fail" ? t(L, "impCopyFailed") : t(L, "impCopy")}</span>
    </button>
  );
}

type View =
  | { kind: "idle" }
  | { kind: "busy"; keep?: View }
  | { kind: "scan"; source: ImportSource; report: ImportReport }
  | { kind: "host"; source: ImportSource; missing?: boolean }
  | { kind: "done"; source: ImportSource; report: ImportReport; fromHost: boolean };

export function ImportCard({ client, lang: L }: { client: NokkerClient; lang: Lang }): React.ReactElement {
  const [view, setView] = useState<View>({ kind: "idle" });
  const [err, setErr] = useState(false);

  const pick = async (source: ImportSource): Promise<void> => {
    setErr(false);
    setView({ kind: "busy" });
    try {
      const report = await client.importScan(source);
      setView(nothingVisible(report) ? { kind: "host", source } : { kind: "scan", source, report });
    } catch {
      setView({ kind: "host", source }); // route absente ou refusée : la commande de l'hôte reste possible
    }
  };
  const apply = async (source: ImportSource, preview: View): Promise<void> => {
    setErr(false);
    setView({ kind: "busy", keep: preview });
    try {
      setView({ kind: "done", source, report: await client.importApply(source), fromHost: false });
    } catch {
      // The preview stays: the error is shown above it and « Import » can be tried again without a new scan.
      setErr(true);
      setView(preview);
    }
  };
  const readHost = async (source: ImportSource): Promise<void> => {
    setView({ kind: "busy" });
    try {
      setView({ kind: "done", source, report: await client.importLatestReport(source), fromHost: true });
    } catch {
      setView({ kind: "host", source, missing: true });
    }
  };

  return (
    <section className="ob-conn imp-card" aria-labelledby="imp-title">
      <h3 id="imp-title">{t(L, "impTitle")}</h3>
      <p className="ob-note">{t(L, "impIntro")}</p>
      <div className="imp-sources" role="group" aria-label={t(L, "impTitle")}>
        {SOURCES.map((s) => {
          const on = "source" in view && view.source === s.id;
          return (
            <button key={s.id} type="button" className={`ob-btn ${on ? "imp-on" : ""}`} disabled={view.kind === "busy"} aria-pressed={on} onClick={() => void pick(s.id)}>
              {on ? (
                <span className="imp-check" aria-hidden="true">
                  ✓
                </span>
              ) : null}
              {s.label}
            </button>
          );
        })}
      </div>
      {err ? <p className="ob-error" role="alert">{t(L, "impFailed")}</p> : null}
      {view.kind === "busy" ? <p className="ob-status" role="status">{t(L, "impBusy")}</p> : null}
      {view.kind === "busy" && view.keep?.kind === "scan" ? <ReportView report={view.keep.report} lang={L} preview /> : null}
      {view.kind === "host" ? (
        <div className="imp-host">
          <p>{t(L, "impHost")}</p>
          <div className="imp-cmd-row">
            <code className="imp-cmd">{hostCommand(view.source, false)}</code>
            <CopyButton text={hostCommand(view.source, false)} lang={L} />
          </div>
          <p className="ob-note">{t(L, "impHostApply")}</p>
          <div className="imp-cmd-row">
            <code className="imp-cmd">{hostCommand(view.source, true)}</code>
            <CopyButton text={hostCommand(view.source, true)} lang={L} />
          </div>
          {view.missing ? <p className="ob-error" role="alert">{t(L, "impNoReport")}</p> : null}
          <div className="ob-actions">
            <button type="button" className="ob-btn primary" onClick={() => void readHost(view.source)}>
              {t(L, "impReadReport")}
            </button>
          </div>
        </div>
      ) : null}
      {view.kind === "scan" ? (
        <>
          <ReportView report={view.report} lang={L} preview />
          {view.report.counts.planned === 0 ? (
            <p className="ob-note imp-nothing">{t(L, "impNothing")}</p>
          ) : (
            <div className="ob-actions">
              <button type="button" className="ob-btn primary" onClick={() => void apply(view.source, view)}>
                {t(L, "impApply")}
              </button>
            </div>
          )}
        </>
      ) : null}
      {view.kind === "done" ? (
        <>
          <p className="ob-status" role="status">{t(L, view.fromHost ? "impHostDone" : "impDone")}</p>
          <ReportView report={view.report} lang={L} />
          {groupReport(view.report).mcp.length ? <p className="ob-note imp-next">{t(L, "impNext")}</p> : null}
        </>
      ) : null}
    </section>
  );
}

function ReportView({ report, lang: L, preview = false }: { report: ImportReport; lang: Lang; preview?: boolean }): React.ReactElement {
  const g = groupReport(report);
  return (
    <div className="imp-report">
      {g.taken.length ? (
        <>
          <h4>{t(L, preview ? "impWillTake" : "impTaken")}</h4>
          <ul className="imp-list">
            {g.taken.map((i, n) => (
              <li key={n} className={`imp-${i.status}`}>
                <span className="imp-kind">{kindLabel(L, i.kind)}</span> {itemLabel(i)}
                {i.status === "imported" ? <span className="ob-note"> · {t(L, "impImported")}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {g.mcp.length ? (
        <>
          <h4>{t(L, "impMcp")}</h4>
          <p className="ob-note">{t(L, "impMcpWhy")}</p>
          <ul className="imp-list">
            {g.mcp.map((i, n) => (
              <li key={n}>
                <div className="imp-cmd-row">
                  <code>{mcpRequest(i, L)}</code>
                  <CopyButton text={mcpRequest(i, L)} lang={L} />
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {g.left.length ? (
        <details className="imp-left">
          <summary>{t(L, "impLeft", { n: String(g.left.length) })}</summary>
          <ul className="imp-list">
            {g.left.map((i, n) => (
              <li key={n}>
                <span className="imp-kind">{kindLabel(L, i.kind)}</span> {itemLabel(i)} — <span className="ob-note">{reasonText(L, i)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
