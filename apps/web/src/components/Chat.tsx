import React, { useEffect, useRef, useState } from "react";
import { liveTail, type LiveInput, type NokkerClient, type ThreadMessage } from "@nokker-apps/sdk";
import { Markdown } from "../Markdown.js";
import { Icon } from "../icons.js";
import { REFUSAL_TEXT, readAsDataUrl, refuseImage, type PendingImage } from "../composer/images.js";

/** Conversation du fil courant. Les blocs `system` (bulle reçue, message d'une autre session) s'affichent en
 * ligne discrète : c'est le contexte que Nina voit. */
export function Chat({
  title,
  messages,
  streaming,
  live,
  sending,
  onSend,
  threadId = null,
  client,
  turnCosts = {},
  costTotals = null,
  writing = [],
  hookNotice = null,
  onTrustHooks,
}: {
  title: string;
  messages: ThreadMessage[];
  streaming: string | null;
  live?: { turn_id: string; text: string } | null;
  sending: boolean;
  onSend: (text: string, images: string[]) => void;
  /** Fil courant : sert aux images de l'historique et au coût par tour (`<fil>:<index>`). */
  threadId?: string | null;
  client?: NokkerClient;
  /** X2 : ligne de coût par `turn_id`. */
  turnCosts?: Record<string, string>;
  /** X2 : totaux session et jour ; `null` = route absente, pas d'encart. */
  costTotals?: { session: string | null; day: string } | null;
  /** X22 : écritures en cours du fil courant (un bloc vivant par `call_id`). */
  writing?: LiveInput[];
  /** X3 : hooks du dépôt pas encore de confiance sur ce fil. */
  hookNotice?: { count: number; notice: string } | null;
  onTrustHooks?: () => void;
}): React.ReactElement {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [imgError, setImgError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
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
    if ((!t && images.length === 0) || sending) return;
    setDraft("");
    setImages([]);
    setImgError(null);
    onSend(t, images.map((i) => i.dataUrl));
  }

  // X7 : images collées, déposées ou choisies. Refus annoncé (type, taille, nombre), jamais silencieux.
  async function addFiles(files: Iterable<File>): Promise<void> {
    let count = images.length;
    const added: PendingImage[] = [];
    let refusal: string | null = null;
    for (const f of files) {
      const why = refuseImage(f, count);
      if (why) {
        refusal = REFUSAL_TEXT[why];
        continue;
      }
      try {
        added.push({ id: `${f.name}-${f.size}-${Math.random().toString(36).slice(2, 8)}`, name: f.name || "image", type: f.type, size: f.size, dataUrl: await readAsDataUrl(f) });
        count++;
      } catch {
        refusal = "Cette image n'a pas pu être lue.";
      }
    }
    if (added.length) setImages((cur) => [...cur, ...added]);
    setImgError(refusal);
  }

  return (
    <section className="chat" aria-label={`Conversation avec Nina — session ${title}`}>
      <div className="chat-scroll" role="log" aria-live="polite" aria-relevant="additions">
        <div className="chat-inner">
          {messages.map((m, i) => (
            <Message
              key={`${m.index}-${m.role}`}
              m={m}
              thinking={thinking && i === lastUserIdx}
              images={m.role === "user" && m.images?.length && client && threadId ? <MessageImages client={client} threadId={threadId} images={m.images} /> : null}
              cost={m.role === "assistant" && threadId ? turnCosts[`${threadId}:${m.index}`] : undefined}
            />
          ))}
          {live && streaming === null ? (
            <div className="msg nina" data-turn-id={live.turn_id}>
              <NinaAvatar />
              <div className="msg-body">
                <Markdown text={live.text} />
              </div>
            </div>
          ) : null}
          {writing.map((w) => (
            <LiveWrite key={w.callId} w={w} />
          ))}
          {streaming ? (
            <div className="msg nina">
              <NinaAvatar />
              <div className="msg-body"><Markdown text={streaming} /></div>
            </div>
          ) : null}
          <div ref={endRef} />
        </div>
      </div>
      {hookNotice ? (
        <div className="hook-notice" role="status">
          <span>
            Ce dépôt déclare {hookNotice.count} hook{hookNotice.count > 1 ? "s" : ""} pas encore de confiance : ils sont ignorés. {hookNotice.notice}
          </span>
          {onTrustHooks ? (
            <button type="button" className="btn" onClick={onTrustHooks}>
              Faire confiance
            </button>
          ) : null}
        </div>
      ) : null}
      {costTotals ? (
        <p className="cost-totals fine" aria-label="Coût">
          {costTotals.session ? <span>Session : {costTotals.session}</span> : null}
          <span>Aujourd'hui (UTC) : {costTotals.day}</span>
        </p>
      ) : null}
      {images.length || imgError ? (
        <div className="composer-images">
          {images.map((im) => (
            <figure key={im.id} className="composer-thumb">
              <img src={im.dataUrl} alt={im.name} />
              <button type="button" className="icon-btn" aria-label={`Retirer ${im.name}`} onClick={() => setImages((cur) => cur.filter((x) => x.id !== im.id))}>
                <Icon name="close" size={12} />
              </button>
            </figure>
          ))}
          {imgError ? <span className="fine composer-img-error" role="alert">{imgError}</span> : null}
        </div>
      ) : null}
      <form
        className={`composer ${dragging ? "dropping" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onDragOver={(e) => {
          if ([...e.dataTransfer.items].some((it) => it.kind === "file")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void addFiles(e.dataTransfer.files);
        }}
      >
        <label htmlFor="nk-composer" className="sr-only">
          Message à Nina
        </label>
        <button type="button" className="icon-btn" aria-label="Joindre une image" onClick={() => fileRef.current?.click()}>
          <Icon name="image" size={18} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          id="nk-composer"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          placeholder="Dis quelque chose à Nina…"
          autoComplete="off"
        />
        <button type="submit" className="icon-btn send" aria-label="Envoyer" disabled={sending || (!draft.trim() && images.length === 0)}>
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

function Message({ m, thinking = false, images = null, cost }: { m: ThreadMessage; thinking?: boolean; images?: React.ReactNode; cost?: string }): React.ReactElement | null {
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
    if (!thinking) {
      return images ? (
        <div className="msg-user-wrap">
          {images}
          {m.content ? <div className="msg user">{m.content}</div> : null}
        </div>
      ) : (
        <div className="msg user">{m.content}</div>
      );
    }
    return (
      <div className="msg-user-wrap">
        {images}
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
        {cost ? <span className="turn-cost fine">{cost}</span> : null}
      </div>
    </div>
  );
}

/** Images d'un message de l'historique (X7) : lues avec l'en-tête d'auth puis montrées en URL `blob:` (une balise
 * `<img>` seule n'enverrait pas le jeton). Indisponible : une vignette grise nommée, jamais d'erreur bloquante. */
function MessageImages({ client, threadId, images }: { client: NokkerClient; threadId: string; images: NonNullable<ThreadMessage["images"]> }): React.ReactElement {
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  useEffect(() => {
    let live = true;
    const made: string[] = [];
    for (const im of images) {
      client.getThreadImage(threadId, im.sha256).then(
        (blob) => {
          const u = URL.createObjectURL(blob);
          made.push(u);
          if (live) setUrls((cur) => ({ ...cur, [im.sha256]: u }));
          else URL.revokeObjectURL(u);
        },
        () => live && setUrls((cur) => ({ ...cur, [im.sha256]: null })),
      );
    }
    return () => {
      live = false;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [client, threadId, images]);
  return (
    <div className="msg-images">
      {images.map((im) => {
        const u = urls[im.sha256];
        return u ? (
          <a key={im.sha256} href={u} target="_blank" rel="noopener noreferrer" className="msg-image">
            <img src={u} alt={im.name ?? "image jointe"} />
          </a>
        ) : (
          <span key={im.sha256} className="msg-image missing" title={u === null ? "image indisponible" : "chargement…"}>
            {u === null ? "image indisponible" : ""}
          </span>
        );
      })}
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

/** X22 : bloc vivant d'un outil qui écrit — le chemin, puis les dernières lignes qui défilent ; « … » si le direct
 * s'est arrêté (appel trop gros). Texte déjà caviardé par le noyau, montré tel quel (jamais interprété). */
function LiveWrite({ w }: { w: LiveInput }): React.ReactElement {
  const verb = w.name === "patch" ? "modifie" : w.name === "page_create" ? "crée la page" : "écrit";
  return (
    <div className="live-write" aria-live="off">
      <div className="live-write-head">
        <span className="live-dot" aria-hidden="true" />
        <span>
          Nina {verb} <code>{w.path ?? "…"}</code>
        </span>
      </div>
      <pre className="live-write-body">
        {liveTail(w.text, 12, 160).join("\n")}
        {w.truncated ? "\n…" : ""}
      </pre>
    </div>
  );
}
