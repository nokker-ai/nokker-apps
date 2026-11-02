/**
 * « Who does what » (core WHO-DOES-WHAT.md): a top-bar button opening a contact-list panel — one row per agent, thread,
 * code session or house agent, with a status dot and an activity line; a click opens its thread. Read only: approvals
 * stay in the cards. The panel refreshes on `presence.changed`; read-only for a household member who is not the payer.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { NokkerClient, NokkerEvent, PresenceView } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import { Icon } from "../icons.js";
import { activityText, applyChange, attentionCount, canOpen, destination, entryName, grouped, groupTitle, statusText, type Destination } from "./model.js";

export function PresenceMenu({
  client,
  ready,
  onEvent,
  onOpen,
}: {
  client: NokkerClient;
  ready: boolean;
  onEvent: (fn: (e: NokkerEvent) => void) => () => void;
  onOpen: (d: Destination) => void;
}): React.ReactElement | null {
  const [view, setView] = useState<PresenceView | null>(null);
  const [on, setOn] = useState(false);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    client.getPresence().then(
      (v) => {
        setView(v);
        setOn(true);
      },
      () => setOn(false),
    );
  }, [client]);

  // The button exists only if the core serves the view (flag `who_does_what`; 404 otherwise).
  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  useEffect(
    () =>
      onEvent((e) => {
        if (e.type !== "presence.changed") return;
        setView((v) => (v ? applyChange(v, e.id, e.status) : v));
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(load, 400);
      }),
    [onEvent, load],
  );
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  useEffect(() => {
    if (!open) return;
    load();
    const down = (ev: MouseEvent | TouchEvent): void => {
      if (root.current && !root.current.contains(ev.target as Node)) setOpen(false);
    };
    const key = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("touchstart", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("touchstart", down);
      document.removeEventListener("keydown", key);
    };
  }, [open, load]);

  if (!on || !view) return null;
  const attention = attentionCount(view);
  const label = attention ? tr("Who does what, {0} need you", attention) : tr("Who does what");
  const go = (d: Destination): void => {
    setOpen(false);
    onOpen(d);
  };
  const next = view.next_waiting ? view.entries.find((e) => e.id === view.next_waiting) : undefined;
  return (
    <div className="presence" ref={root}>
      <button type="button" className={`presence-btn ${open ? "on" : ""}`} aria-haspopup="dialog" aria-expanded={open} aria-label={label} title={tr("Who does what")} onClick={() => setOpen((o) => !o)}>
        <Icon name="users" size={18} />
        {attention ? (
          <span className="presence-count" aria-hidden="true">
            {attention > 9 ? "9+" : attention}
          </span>
        ) : null}
      </button>
      {open ? (
        <section className="presence-pop" role="dialog" aria-label={tr("Who does what")}>
          <header className="presence-head">
            <h2>{tr("Who does what")}</h2>
            {view.viewer.read_only ? <span className="presence-ro">{tr("Read only")}</span> : null}
            {next && canOpen(view, next) ? (
              <button type="button" className="presence-next" onClick={() => go(destination(next))}>
                {tr("Next waiting")}
              </button>
            ) : null}
          </header>
          {view.entries.length === 0 ? <p className="presence-empty">{tr("No agent is active right now.")}</p> : null}
          <div className="presence-list">
            {grouped(view.entries).map((g) => (
              <div key={g.id} className="presence-group">
                <h3>{groupTitle(g.id, g.entries.length)}</h3>
                <ul>
                  {g.entries.map((e) => {
                    const body = (
                      <>
                        <span className={`presence-dot ${e.status}`} role="img" aria-label={statusText(e.status)} />
                        <span className="presence-text">
                          <span className="presence-name">{entryName(e)}</span>
                          <span className="presence-act" data-act={e.activity?.code ?? "status"}>{activityText(e.activity) ?? statusText(e.status)}</span>
                        </span>
                      </>
                    );
                    return (
                      <li key={e.id} data-status={e.status} data-kind={e.kind}>
                        {canOpen(view, e) ? (
                          <button type="button" className="presence-row" onClick={() => go(destination(e))}>
                            {body}
                          </button>
                        ) : (
                          <div className="presence-row static">{body}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
