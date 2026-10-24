import React, { useEffect, useRef, useState } from "react";
import type { ThreadMessage } from "@nokker-apps/sdk";
import { Markdown } from "../Markdown.js";
import { Icon } from "../icons.js";

/** Conversation du fil courant. Les blocs `system` (bulle reçue, message d'une autre session) s'affichent en
 * ligne discrète : c'est le contexte que Nina voit. */
export function Chat({
  title,
  messages,
  streaming,
  live,
  sending,
  onSend,
}: {
  title: string;
  messages: ThreadMessage[];
  streaming: string | null;
  live?: { turn_id: string; text: string } | null;
  sending: boolean;
  onSend: (text: string) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  // Nina réfléchit : envoi en cours et aucun jeton reçu — le premier jeton streamé arrête le scanner KITT ; un
  // `nokker.reset` (appel fini en outils) remet `streaming` à "" et le relance (CLIENT-API.md §Streaming).
  const thinking = sending && !streaming;
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user" && messages[i]!.content && !isMachineInput(messages[i]!)) {
      lastUserIdx = i;
      break;
    }
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, streaming, live, thinking]);

  function submit(): void {
    const t = draft.trim();
    if (!t || sending) return;
    setDraft("");
    onSend(t);
  }

  return (
    <section className="chat" aria-label={`Conversation avec Nina — session ${title}`}>
      <div className="chat-scroll" role="log" aria-live="polite" aria-relevant="additions">
        <div className="chat-inner">
          {messages.map((m, i) => (
            <Message key={`${m.index}-${m.role}`} m={m} thinking={thinking && i === lastUserIdx} />
          ))}
          {live && streaming === null ? (
            <div className="msg nina" data-turn-id={live.turn_id}>
              <NinaAvatar />
              <div className="msg-body">
                <Markdown text={live.text} />
              </div>
            </div>
          ) : null}
          {streaming ? (
            <div className="msg nina">
              <NinaAvatar />
              <div className="msg-body"><Markdown text={streaming} /></div>
            </div>
          ) : null}
          <div ref={endRef} />
        </div>
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor="nk-composer" className="sr-only">
          Message à Nina
        </label>
        <input id="nk-composer" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Dis quelque chose à Nina…" autoComplete="off" />
        <button type="submit" className="icon-btn send" aria-label="Envoyer" disabled={sending || !draft.trim()}>
          <Icon name="send" size={18} />
        </button>
      </form>
    </section>
  );
}

/** Entrée de tour qui ne vient pas d'une frappe : action sur une bulle, message d'une autre session, événement. */
function isMachineInput(m: ThreadMessage): boolean {
  return m.role === "user" && (m.channel === "session" || /^\[(Action|Message de la session|Réponse de la session|Relevé)/.test(m.content));
}

function Message({ m, thinking = false }: { m: ThreadMessage; thinking?: boolean }): React.ReactElement | null {
  if (m.role === "user" && !m.content) return null; // tour de continuation (approbation) sans entrée
  if (isMachineInput(m)) {
    return (
      <div className="msg system">
        <span className="eyebrow">{m.content.startsWith("[Action") ? "action" : "session"}</span>
        <span>{m.content}</span>
      </div>
    );
  }
  if (m.role === "user") {
    if (!thinking) return <div className="msg user">{m.content}</div>;
    return (
      <div className="msg-user-wrap">
        <div className="msg user kitt">{m.content}</div>
        <ThinkingWord />
      </div>
    );
  }
  return (
    <div className="msg nina">
      <NinaAvatar />
      <div className="msg-body">
        <Markdown text={m.content} />
      </div>
    </div>
  );
}

/** Avatar de Nina : l'emblème de la marque (kit, version ≤ 64 px). */
function NinaAvatar(): React.ReactElement {
  return (
    <span className="avatar" aria-hidden="true">
      <img className="only-light" src="/brand/nokker-emblem-light.svg" alt="" />
      <img className="only-dark" src="/brand/nokker-emblem-dark.svg" alt="" />
    </span>
  );
}

/** Mots de réflexion — l'univers du heurtoir et du lion.
 * Un mot différent à chaque fois (10 s chacun), jamais deux fois de suite le même. */
const THINKING_WORDS = [
  "Toc toc toc…", "Frappe à la porte…", "Tend l'oreille…", "Flaire la piste…", "Lisse sa crinière…",
  "Rugit tout bas…", "Fouille la tanière…", "Aiguise ses griffes…", "Rassemble la meute…", "Guette…",
  "Soulève le heurtoir…", "Monte la garde…", "Remue la mémoire…", "Pèse le pour et le contre…",
  "Suit les empreintes…", "Hume le vent…", "Polit le laiton…", "Compte les coups…", "Entrouvre la porte…",
  "Noue les fils…",
];

function ThinkingWord(): React.ReactElement {
  const [i, setI] = useState(() => Math.floor(Math.random() * THINKING_WORDS.length));
  useEffect(() => {
    const t = setInterval(() => {
      setI((cur) => {
        let n = Math.floor(Math.random() * (THINKING_WORDS.length - 1));
        if (n >= cur) n += 1;
        return n;
      });
    }, 10_000); // le 19.10 : « au moins 10 secondes par mot »
    return () => clearInterval(t);
  }, []);
  return (
    <div className="thinking-word">
      <span className="sr-only">Nina réfléchit</span>
      <span key={i} aria-hidden="true">
        {THINKING_WORDS[i]}
      </span>
    </div>
  );
}
