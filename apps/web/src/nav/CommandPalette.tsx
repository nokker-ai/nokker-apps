import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "../icons.js";
import { tr } from "../i18n/index.js";
import { matches } from "./views.js";

export interface Command {
  id: string;
  group: string;
  label: string;
  icon: IconName;
  /** Mots en plus pour la recherche (synonymes, nom anglais d'une vue traduite). */
  keywords?: string;
  hint?: string;
  run: () => void;
}

/**
 * Palette de commandes (Ctrl/⌘ K) : aller à une vue, ouvrir une session, créer une session du texte tapé, basculer le
 * thème. Motif combobox + listbox (WAI-ARIA 1.2) : le focus reste dans le champ, `aria-activedescendant` suit la ligne
 * active ; ↑ ↓ Entrée Échap ; clic sur le voile ferme ; le focus revient à l'élément qui l'avait.
 */
export function CommandPalette({ commands, onClose, create }: { commands: Command[]; onClose: () => void; create: (title: string) => void }): React.ReactElement {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const back = useRef<HTMLElement | null>(typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null);
  const list = useRef<HTMLUListElement>(null);

  const shown = useMemo(() => {
    const hits = commands.filter((c) => matches(q, c.label, c.keywords ?? "", c.group));
    const title = q.trim();
    if (title && !commands.some((c) => c.group === tr("Sessions") && c.label.toLowerCase() === title.toLowerCase())) {
      hits.push({ id: "new-session", group: tr("Actions"), label: tr("New session “{0}”", title), icon: "plus", run: () => create(title) });
    }
    return hits;
  }, [commands, q, create]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  // Le focus revient à l'élément d'origine à la fermeture (pas dans le nettoyage d'un effet : le double montage du mode
  // strict de React le volerait au champ).
  const close = (): void => {
    onClose();
    back.current?.focus?.();
  };
  const run = (c: Command | undefined): void => {
    if (!c) return;
    close();
    c.run();
  };

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (shown.length ? (a + 1) % shown.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (shown.length ? (a - 1 + shown.length) % shown.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(shown[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      // Le dialogue ne contient qu'un champ : le focus y reste (piège voulu d'une boîte modale).
      e.preventDefault();
    }
  };

  let last = "";
  return (
    <div className="palette-wrap" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={tr("Search and commands")}>
        <div className="palette-field">
          <Icon name="search" size={18} />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
            aria-label={tr("Search a view, a session or an action")}
            placeholder={tr("Go to a view, a session, an action…")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
          />
          <kbd className="kbd">Esc</kbd>
        </div>
        <ul ref={list} id={listId} role="listbox" className="palette-list" aria-label={tr("Results")}>
          {shown.map((c, i) => {
            const head = c.group !== last ? c.group : null;
            last = c.group;
            return (
              <React.Fragment key={c.id}>
                {head ? (
                  <li role="presentation" className="palette-group">
                    {head}
                  </li>
                ) : null}
                <li
                  id={`${listId}-${i}`}
                  data-i={i}
                  role="option"
                  aria-selected={i === active}
                  className={`palette-item ${i === active ? "on" : ""}`}
                  onPointerMove={() => setActive(i)}
                  onClick={() => run(c)}
                >
                  <Icon name={c.icon} size={16} />
                  <span className="palette-label">{c.label}</span>
                  {c.hint ? <span className="palette-hint">{c.hint}</span> : null}
                </li>
              </React.Fragment>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
