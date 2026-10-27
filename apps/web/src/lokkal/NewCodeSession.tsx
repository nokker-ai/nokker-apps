/** Barre des sessions → « Nouvelle session de code » : une racine déclarée sur la machine, un sous-dossier libre. */
import React, { useState } from "react";
import { tr } from "../i18n/index.js";
import { joinUnderRoot, openSessionError } from "./sessions.js";
import "./lokkal.css";

export function NewCodeSession({ roots, onOpen, onCancel }: { roots: string[]; onOpen: (cwd: string) => Promise<void>; onCancel: () => void }): React.ReactElement {
  const [root, setRoot] = useState(roots[0] ?? "");
  const [sub, setSub] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Sans racine connue (noyau ancien) : chemin absolu tapé en entier, le noyau dira s'il est permis.
  const free = roots.length === 0;
  const cwd = free ? (sub.trim().startsWith("/") ? sub.trim() : null) : joinUnderRoot(root, sub);
  const submit = async (): Promise<void> => {
    if (!cwd) return setErr(free ? tr("Type an absolute path (starting with /).") : tr("The subfolder must stay inside the chosen folder."));
    setBusy(true);
    setErr(null);
    try {
      await onOpen(cwd);
    } catch (e) {
      setErr(openSessionError(e));
      setBusy(false);
    }
  };
  return (
    <form
      className="drawer-new drawer-code"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <span className="drawer-code-title">{tr("New code session")}</span>
      {free ? null : roots.length === 1 ? (
        <span className="drawer-code-root mono" title={root}>
          {root}
        </span>
      ) : (
        <>
          <label htmlFor="nk-code-root" className="sr-only">
            {tr("Folder")}
          </label>
          <select id="nk-code-root" value={root} onChange={(e) => setRoot(e.target.value)}>
            {roots.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </>
      )}
      <label htmlFor="nk-code-sub" className="sr-only">
        {free ? tr("Folder path") : tr("Subfolder (optional)")}
      </label>
      <input
        id="nk-code-sub"
        autoFocus
        value={sub}
        onChange={(e) => setSub(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        placeholder={free ? "/home/alice/project" : tr("subfolder (optional)")}
      />
      {cwd && !free ? <span className="drawer-code-path mono">{cwd}</span> : null}
      {err ? (
        <span className="error" role="alert">
          {err}
        </span>
      ) : null}
      <span className="drawer-code-actions">
        <button type="submit" className="btn btn-brass" disabled={busy}>
          {busy ? tr("Opening…") : tr("Open")}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {tr("Cancel")}
        </button>
      </span>
    </form>
  );
}
