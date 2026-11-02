import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import type { SignaturePrefs } from "@nokker-apps/brand";
import { Icon } from "../icons.js";
import { knock } from "../sound.js";
import { tr } from "../i18n/index.js";
import { anchor } from "../showme/model.js";
import { settingsAttention, type NavView, type ViewId } from "./views.js";

/**
 * Menu du compte (en haut à droite) : tout ce qui est compte et réglages, rarement ouvert, regroupé derrière UN bouton
 * au lieu d'une rangée d'onglets. Motif « disclosure » : bouton `aria-expanded`, liste de boutons ; flèches haut/bas,
 * Début/Fin, Échap (rend le focus au bouton), clic en dehors ferme.
 */
export function AccountMenu({
  views,
  current,
  onOpen,
  theme,
  onTheme,
  sound,
  onSound,
  status,
  ready,
  onPalette,
  shortcut,
  onGuide,
  onArrange,
}: {
  views: NavView[];
  current: ViewId;
  onOpen: (id: ViewId) => void;
  theme: "light" | "dark";
  onTheme: () => void;
  sound: SignaturePrefs;
  onSound: (p: SignaturePrefs) => void;
  status: string;
  ready: boolean;
  onPalette: () => void;
  shortcut: string;
  /** « Discover » (the Guide): present only when the Guide is served. */
  onGuide?: () => void;
  /** « Arrange the bubbles »: present only on the chat with two bubbles or more (kept out of the top bar: 3 controls). */
  onArrange?: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const settings = views.filter((v) => v.group === "settings");
  const waiting = settingsAttention(views);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>(".menu-item")?.focus();
    const onDown = (e: PointerEvent): void => {
      if (!panel.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, close]);

  const onKey = (e: React.KeyboardEvent): void => {
    const items = [...(panel.current?.querySelectorAll<HTMLElement>(".menu-item") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (k: number): void => items[(k + items.length) % items.length]?.focus();
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      go(i + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      go(i - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      go(0);
    } else if (e.key === "End") {
      e.preventDefault();
      go(items.length - 1);
    } else if (e.key === "Tab" && !e.shiftKey && i === items.length - 1) {
      close(false);
    }
  };

  const pick = (v: ViewId): void => {
    onOpen(v);
    close(false);
  };

  const label = waiting ? tr("Account and settings, {0} waiting", waiting) : tr("Account and settings");
  return (
    <div className="acct">
      <button
        ref={btn}
        type="button"
        className={`acct-btn ${open ? "on" : ""} ${settings.some((v) => v.id === current) ? "here" : ""}`}
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        {...anchor("account")}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="user" size={18} />
        <span className={`acct-dot ${ready ? "ok" : ""}`} aria-hidden="true" />
        {waiting ? (
          <span className="acct-count" aria-hidden="true">
            {waiting > 9 ? "9+" : waiting}
          </span>
        ) : null}
      </button>
      {open ? (
        <div ref={panel} id={id} className="menu-pop" role="group" aria-label={tr("Account and settings")} onKeyDown={onKey}>
          <p className="menu-status">
            <span className={`conn ${ready ? "ok" : ""}`} aria-hidden="true" />
            {status}
          </p>
          <ul className="menu-list">
            {settings.map((v) => (
              <li key={v.id}>
                <button type="button" className={`menu-item ${current === v.id ? "on" : ""}`} aria-current={current === v.id ? "page" : undefined} data-view={v.id} onClick={() => pick(v.id)}>
                  <Icon name={v.icon} size={18} />
                  <span className="menu-label">{v.label}</span>
                  {v.count ? (
                    <span className="nav-count" aria-label={v.countLabel}>
                      {v.count}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
          <ul className="menu-list menu-prefs">
            {onGuide ? (
              <li>
                <button
                  type="button"
                  className="menu-item"
                  data-guide-open
                  onClick={() => {
                    close(false);
                    onGuide();
                  }}
                >
                  <Icon name="bot" size={18} />
                  <span className="menu-label">{tr("Discover")}</span>
                </button>
              </li>
            ) : null}
            {onArrange ? (
              <li>
                <button
                  type="button"
                  className="menu-item"
                  data-arrange
                  onClick={() => {
                    close(false);
                    onArrange();
                  }}
                >
                  <Icon name="crew" size={18} />
                  <span className="menu-label">{tr("Arrange the bubbles")}</span>
                </button>
              </li>
            ) : null}
            <li>
              <button type="button" className="menu-item" aria-pressed={theme === "dark"} onClick={onTheme}>
                <Icon name={theme === "dark" ? "moon" : "sun"} size={18} />
                <span className="menu-label">{tr("Dark theme")}</span>
                <span className={`menu-switch ${theme === "dark" ? "on" : ""}`} aria-hidden="true" />
              </button>
            </li>
            <li>
              <button
                type="button"
                className="menu-item"
                aria-pressed={sound.sound}
                title={sound.sound ? tr("Knock knock knock: on") : tr("Knock knock knock: off")}
                onClick={() => {
                  const next = { ...sound, sound: !sound.sound };
                  onSound(next);
                  if (next.sound) knock("bubble", { ...next, coalesceMs: 0 });
                }}
              >
                <Icon name={sound.sound ? "soundOn" : "soundOff"} size={18} />
                <span className="menu-label">{tr("Bubble sound")}</span>
                <span className={`menu-switch ${sound.sound ? "on" : ""}`} aria-hidden="true" />
              </button>
            </li>
            <li>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  close(false);
                  onPalette();
                }}
              >
                <Icon name="search" size={18} />
                <span className="menu-label">{tr("Search and commands")}</span>
                <kbd className="kbd">{shortcut}</kbd>
              </button>
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}
