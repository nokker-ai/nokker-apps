/**
 * « Maison » (core HOUSE-ROOM.md §6): the household's shared room, one avatar per agent. Members appear as anonymised
 * labels; an avatar glows while its agent works (`house.agent`); an event shows as a message of its agent with a badge of
 * its type; a message that came from a session (`origin.kind = ask_house`) says so. Writing: the text goes to the
 * mentioned agent (`@slug`, tap an avatar to insert it) or to the default one. The reply comes later (`house.message`);
 * if nothing comes within a while, the room says so instead of spinning forever (a restart loses the reply, the core
 * has no queue). Read only for a child (`right: read`). Append-only: nothing is edited or deleted here.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { addressedAgent, NokkerApiError, type HouseAgent, type HouseMessage, type HouseView as View, type NokkerClient, type NokkerEvent } from "@nokker-apps/sdk";
import { shellLang, tr } from "../i18n/index.js";
import { Icon } from "../icons.js";

/** A reply that has not come after this long is announced (the core may have restarted). */
export const REPLY_WAIT_MS = 90_000;

export function eventLabel(event: HouseMessage["event"]): string | null {
  switch (event) {
    case "camera.incident":
      return tr("camera");
    case "mail.arrived":
      return tr("mail");
    case "memory.report":
      return tr("memory");
    case "agenda.reminder":
      return tr("reminder");
    case "card.pending":
      return tr("card");
    default:
      return null;
  }
}

function initials(name: string): string {
  return name.slice(0, 1).toUpperCase();
}

function apiCode(e: unknown): string | undefined {
  return e instanceof NokkerApiError ? (e.body as { error?: { code?: string } } | undefined)?.error?.code : undefined;
}

export function HouseView({ client, onEvent, toast }: { client: NokkerClient; onEvent: (fn: (e: NokkerEvent) => void) => () => void; toast: (t: string, tone?: "ok" | "error") => void }): React.ReactElement {
  const lang = shellLang();
  const [view, setView] = useState<View | null>(null);
  const [messages, setMessages] = useState<HouseMessage[]>([]);
  const [working, setWorking] = useState<Set<string>>(new Set());
  const [waiting, setWaiting] = useState<{ agent: string; since: number } | null>(null);
  const [late, setLate] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const logRef = useRef<HTMLOListElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const add = useCallback((m: HouseMessage) => setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m])), []);

  useEffect(() => {
    let live = true;
    Promise.all([client.getHouse(), client.listHouseMessages({ limit: 50 })]).then(
      ([v, page]) => {
        if (!live) return;
        setView(v);
        setMessages(page.messages);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client]);

  useEffect(
    () =>
      onEvent((e) => {
        if (e.type === "house.message") {
          add(e.message);
          if (e.message.kind === "agent") {
            setWaiting((w) => (w && w.agent === e.message.agent ? null : w));
            setLate(false);
          }
        } else if (e.type === "house.agent") {
          setWorking((cur) => {
            const next = new Set(cur);
            if (e.state === "working") next.add(e.agent);
            else next.delete(e.agent);
            return next;
          });
        }
      }),
    [onEvent, add],
  );

  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => setLate(true), Math.max(0, waiting.since + REPLY_WAIT_MS - Date.now()));
    return () => clearTimeout(t);
  }, [waiting]);

  // The log is its own scroller: keep its bottom in view when a message arrives (scrollIntoView would move the page).
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  if (failed) return <p className="fine house-empty">{tr("The house room cannot be reached right now.")}</p>;
  if (!view) return <p className="fine house-empty">{tr("loading…")}</p>;

  const agents = view.agents;
  const byslug = new Map(agents.map((a) => [a.slug, a]));
  const canWrite = view.me.right === "act" || view.me.right === "strong";
  const target = addressedAgent(draft, agents);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    try {
      const out = await client.postHouseMessage(text);
      add(out.message);
      setDraft("");
      setWaiting({ agent: out.agent, since: Date.now() });
      setLate(false);
    } catch (e) {
      const k = apiCode(e);
      toast(
        k === "agent_forbidden"
          ? tr("This agent is not for you: ask the house without a mention.")
          : k === "rate"
            ? tr("Too many messages at once: try again in a moment.")
            : k === "member_suspended"
              ? tr("Your place in the household is suspended.")
              : tr("The message could not be sent."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  const mention = (a: HouseAgent): void => {
    if (!canWrite || !a.may_address) return;
    setDraft((d) => (d.includes(`@${a.slug}`) ? d : `@${a.slug} ${d}`.trimEnd() + " "));
    input.current?.focus();
  };

  return (
    <section className="house" aria-label={tr("Home")}>
      <ul className="house-avatars" aria-label={tr("The household's agents")}>
        {agents.map((a) => {
          const busyNow = working.has(a.slug);
          return (
            <li key={a.slug}>
              <button
                type="button"
                className={`house-avatar ${busyNow ? "working" : ""} ${a.available ? "" : "off"}`}
                onClick={() => mention(a)}
                disabled={!canWrite || !a.may_address}
                aria-label={`${a.name} — ${a.role}${busyNow ? ` — ${tr("working")}` : ""}${a.available ? "" : ` — ${tr("not available")}`}`}
                title={a.role}
              >
                <span className="house-face" aria-hidden="true">
                  {initials(a.name)}
                </span>
                <span className="house-name">{a.name}</span>
                {busyNow ? <span className="house-state">{tr("working")}</span> : !a.available ? <span className="house-state">{tr("not available")}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      <ol ref={logRef} className="house-log" aria-live="polite">
        {messages.map((m) => {
          const ag = m.agent ? byslug.get(m.agent) : undefined;
          const badge = m.kind === "event" ? eventLabel(m.event) : null;
          const who = m.kind === "member" ? (m.mine ? tr("you") : (m.author ?? tr("a member"))) : (ag?.name ?? m.agent ?? tr("the house"));
          return (
            <li key={m.id} className={`house-msg ${m.kind} ${m.mine ? "mine" : ""}`}>
              <div className="house-meta">
                <span className="house-who">{who}</span>
                {badge ? <span className="chip house-badge">{badge}</span> : null}
                {m.origin?.kind === "ask_house" ? <span className="chip house-badge">{tr("from a session")}</span> : null}
                {m.origin?.via ? <span className="fine">{tr("asked through {0}", byslug.get(m.origin.via)?.name ?? m.origin.via)}</span> : null}
                {m.audience === "adults" ? <span className="chip house-badge">{tr("adults")}</span> : null}
                <time className="fine" dateTime={new Date(m.at * 1000).toISOString()}>
                  {new Date(m.at * 1000).toLocaleTimeString(lang === "fr" ? "fr-CH" : "en-GB", { hour: "2-digit", minute: "2-digit" })}
                </time>
              </div>
              <p className="house-text">{m.text}</p>
              {m.mine && m.approvals?.length ? <p className="fine">{m.approvals.length === 1 ? tr("1 card waits for your decision.") : tr("{0} cards wait for your decision.", m.approvals.length)}</p> : null}
            </li>
          );
        })}
      </ol>
      {late && waiting ? (
        <p className="fine house-late" role="status">
          {tr("{0} has not answered yet: Nokker may have restarted. Ask again if needed.", byslug.get(waiting.agent)?.name ?? waiting.agent)}
        </p>
      ) : null}
      {canWrite ? (
        <form
          className="composer house-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label htmlFor="nk-house" className="sr-only">
            {tr("Message to the house")}
          </label>
          <input ref={input} id="nk-house" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={tr("Write to the house… (@agent to choose)")} autoComplete="off" maxLength={2000} />
          {draft.trim() && target ? <span className="fine house-to">{tr("to {0}", target.name)}</span> : null}
          <button type="submit" className="icon-btn send" aria-label={tr("Send")} disabled={busy || !draft.trim()}>
            <Icon name="send" size={18} />
          </button>
        </form>
      ) : (
        <p className="fine house-readonly">{view.me.right === "none" ? tr("You have no right on the house: you can only read this room.") : tr("You can read the house room; writing is for older members.")}</p>
      )}
    </section>
  );
}
