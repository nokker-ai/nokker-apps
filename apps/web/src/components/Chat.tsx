import React, { useEffect, useRef, useState } from "react";
import { FlowBox } from "../pretext/FlowBox.js";
import { PAY_TOOL, liveTail, type LiveInput, type NokkerClient, type ThreadMessage } from "@nokker-apps/sdk";
import { Markdown } from "../Markdown.js";
import { Icon } from "../icons.js";
import { MAX_IMAGES, readAsDataUrl, refusalText, refuseImage, type PendingImage } from "../composer/images.js";
import { tr } from "../i18n/index.js";
import { anchor } from "../showme/model.js";
import { ListenButton } from "../voice/ListenButton.js";
import { speechCapability } from "../voice/speech.js";
import { Orb } from "../voice/Orb.js";
import { orbEnabled } from "../voice/orbState.js";
import { approvalStatusLabel } from "../ops/model.js";
import { ageMinutes } from "../offline/cache.js";
import { splitImages, toolImagesByTurn } from "./imageOrigin.js";
import { PhoneFetchedNote, PhoneFetchOffers, PhoneTaskNotes } from "./PhoneFetch.js";
import { MaskedText, RedactContext } from "./redaction.js";
import { useRedaction } from "./useRedaction.js";
import { canAddText, clock, textAttachment, textPlugin, textRefusal } from "../platform/text.js";
import type { RedactionMeta, TextAttachment } from "@nokker-apps/sdk";

/** Conversation du fil courant. Les blocs `system` (bulle reçue, message d'une autre session) s'affichent en
 * ligne discrète : c'est le contexte que Nina voit. */
export function Chat({
  title,
  messages,
  streaming,
  live,
  startedMessage = null,
  sending,
  onSend,
  threadId = null,
  client,
  turnCosts = {},
  quotaTurns = {},
  turnNotices = {},
  onOpenAccount,
  accountRemote = false,
  costTotals = null,
  writing = [],
  hookNotice = null,
  onTrustHooks,
  empty,
  onCommand,
  offlineAt,
  readOnly,
  prefill,
}: {
  title: string;
  messages: ThreadMessage[];
  streaming: string | null;
  live?: { turn_id: string; text: string } | null;
  /** Message d'un autre client reçu par `turn.started` : montré dès le début du tour, remplacé par l'historique à la fin. */
  startedMessage?: { turn_id: string; text: string; truncated: boolean } | null;
  sending: boolean;
  /** Resolves `false` when nothing was sent: the text and images come back to the composer if it is still empty. */
  onSend: (text: string, images: string[], texts?: TextAttachment[], opts?: { redaction?: RedactionMeta }) => Promise<boolean | void> | void;
  /** Fil courant : sert aux images de l'historique et au coût par tour (`<fil>:<index>`). */
  threadId?: string | null;
  client?: NokkerClient;
  /** X2 : ligne de coût par `turn_id`. */
  turnCosts?: Record<string, string>;
  /** Tours finis par un quota atteint (`<fil>:<index>`) : un lien « Mon compte » sous leur phrase. */
  quotaTurns?: Record<string, true>;
  /** Ligne d'état d'un tour (`<fil>:<index>`), du noyau, telle quelle sous la réponse. */
  turnNotices?: Record<string, string>;
  onOpenAccount?: () => void;
  /** Lokkal : le compte est sur nokker.ai (le bouton ouvre cette page, il le dit). */
  accountRemote?: boolean;
  /** X2 : totaux session et jour ; `null` = route absente, pas d'encart. */
  costTotals?: { session: string | null; day: string } | null;
  /** X22 : écritures en cours du fil courant (un bloc vivant par `call_id`). */
  writing?: LiveInput[];
  /** X3 : hooks du dépôt pas encore de confiance sur ce fil. */
  hookNotice?: { count: number; notice: string } | null;
  onTrustHooks?: () => void;
  /** Fil vide : contenu d'accueil ; `fill` remplit la zone de saisie (sans envoyer). */
  empty?: (fill: (text: string) => void) => React.ReactNode;
  /** A line typed in the composer that the client handles itself (`/guide`): true = handled, nothing is sent. */
  onCommand?: (text: string) => boolean;
  /** Offline: the thread shown is the copy kept on this device, taken at this time (ms) — W6. */
  offlineAt?: number | null;
  /** Something shared to Nokker from another app (native share sheet): fills the composer once per `key`; the person
   * adds a sentence and sends. */
  prefill?: { key: string; text: string; images: PendingImage[] } | null;
  /** Read-only thread (mirror copy of a Lokkal thread): this line instead of the composer, and an optional action. */
  readOnly?: { text: string; action?: { label: string; run: () => void; busy?: boolean } } | null;
}): React.ReactElement {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  // P9 (app native) : texte reconnu sur l'appareil — OCR, transcription d'un audio joint, dictée au micro.
  const tp = textPlugin();
  const [texts, setTexts] = useState<TextAttachment[]>([]);
  const [preview, setPreview] = useState<{ att: TextAttachment; dropImage?: string } | null>(null);
  // P9b : masquage sur l'appareil (app native). `keep` : valeurs que la personne laisse en clair dans l'aperçu.
  const rd = useRedaction(client, threadId);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [typedChoice, setTypedChoice] = useState<{ sig: string; mask: boolean } | null>(null);
  const typedSpans = rd.find(draft);
  const typedSig = typedSpans.map((x) => x.value).join("\u0001");
  const [recording, setRecording] = useState(false);
  // Orb only: the short moment between the end of the dictation and the text being ready.
  const [finalising, setFinalising] = useState(false);
  const [attachMenu, setAttachMenu] = useState(false);
  const [textBusy, setTextBusy] = useState(false);
  const [textNote, setTextNote] = useState<string | null>(null);
  const audioRef = useRef<HTMLInputElement>(null);
  const refusal = (e: unknown): string => {
    const r = textRefusal(e);
    return r === "unavailable_on_device"
      ? tr("Speech recognition is not available on this phone for this language: nothing is sent online.")
      : r === "denied"
        ? tr("Access is refused for Nokker: allow it in Settings → Nokker.")
        : tr("The text could not be recognised. Try again.");
  };
  const ocr = async (im: PendingImage): Promise<void> => {
    if (!tp || !canAddText(texts)) return;
    setTextBusy(true);
    setTextNote(null);
    try {
      const r = await tp.ocrImage({ data_url: im.dataUrl });
      if (!r.text.trim()) setTextNote(tr("No text found on this image."));
      else setPreview({ att: textAttachment("device_ocr", tr("Text read on {0}", im.name), r.text), dropImage: im.id });
    } catch (e) {
      setTextNote(refusal(e));
    } finally {
      setTextBusy(false);
    }
  };
  // Dictée arrêtée par l'app (fin de durée, arrière-plan) : le micro est déjà libéré ; on récupère le texte comme pour
  // un arrêt par le bouton, et le bouton quitte l'état « enregistrement ».
  const recordingRef = useRef(false);
  recordingRef.current = recording;
  const toggleRef = useRef<() => Promise<void>>(async () => undefined);
  useEffect(() => {
    if (!tp?.addListener) return;
    // Le retrait peut arriver avant la promesse (double montage en développement) : retiré dès qu'elle se résout.
    let h: { remove?: () => void } | undefined;
    let dead = false;
    void Promise.resolve(tp.addListener("dictationEnded", () => void (recordingRef.current && toggleRef.current()))).then(
      (x) => (dead ? x?.remove?.() : (h = x)),
      () => undefined,
    );
    return () => {
      dead = true;
      h?.remove?.();
    };
  }, [tp]);
  const stoppingRef = useRef(false);
  const toggleDictation = async (): Promise<void> => {
    if (!tp) return;
    setTextNote(null);
    if (recording) {
      if (stoppingRef.current) return; // un seul arrêt (bouton et fin native peuvent se croiser)
      stoppingRef.current = true;
      setFinalising(true);
      setTextBusy(true);
      try {
        const r = await tp.dictationStop();
        if (r.text.trim()) setPreview({ att: textAttachment("device_dictation", tr("Dictation ({0})", clock(r.duration_s)), r.text, { duration_s: r.duration_s }) });
      } catch (e) {
        setTextNote(refusal(e));
      } finally {
        setRecording(false);
        setFinalising(false);
        setTextBusy(false);
        stoppingRef.current = false;
      }
      return;
    }
    try {
      const st = await tp.speechStatus();
      if (st.speech !== "granted" || st.microphone !== "granted") {
        const after = await tp.requestSpeech();
        if (after.speech !== "granted" || after.microphone !== "granted") return setTextNote(refusal("denied"));
      }
      await tp.dictationStart();
      setRecording(true);
    } catch (e) {
      setTextNote(refusal(e));
    }
  };
  toggleRef.current = toggleDictation;
  const transcribe = async (f: File): Promise<void> => {
    if (!tp || !canAddText(texts)) return;
    setTextBusy(true);
    setTextNote(null);
    try {
      const st = await tp.speechStatus();
      if (st.speech !== "granted") await tp.requestSpeech();
      const data = await readAsDataUrl(f);
      const r = await tp.transcribeAudio({ data_url: data, name: f.name });
      setPreview({ att: textAttachment("device_stt", tr("Transcript of {0} ({1})", f.name, clock(r.duration_s)), r.text, { duration_s: r.duration_s }) });
    } catch (e) {
      setTextNote(refusal(e));
    } finally {
      setTextBusy(false);
    }
  };
  useEffect(() => {
    if (!prefill) return;
    setDraft(prefill.text);
    setImages(prefill.images.slice(0, MAX_IMAGES));
    requestAnimationFrame(() => document.getElementById("nk-composer")?.focus());
    // une fois par partage
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.key]);
  const [imgError, setImgError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // « Listen » (speaker): only when the core says reading aloud is available (GET /v1/speech).
  const [canSpeak, setCanSpeak] = useState(false);
  useEffect(() => {
    let live = true;
    if (client && threadId) void speechCapability(client).then((c) => live && setCanSpeak(!!c));
    return () => {
      live = false;
    };
  }, [client, threadId]);
  const online = useOnline();
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // Nina réfléchit : envoi en cours et aucun jeton reçu — le premier jeton streamé arrête le scanner KITT ; un
  // `nokker.reset` (appel fini en outils) remet `streaming` à "" et le relance (CLIENT-API.md §Streaming).
  const thinking = sending && !streaming;
  const toolImages = toolImagesByTurn(messages);
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
    if ((!t && images.length === 0 && texts.length === 0) || sending || recording) return;
    if (t && images.length === 0 && texts.length === 0 && onCommand?.(t)) {
      setDraft("");
      return;
    }
    const kept = images;
    const keptTexts = texts;
    // Message tapé : masqué seulement si la personne l'a choisi pour CES valeurs-là.
    const typed = typedSpans.length && typedChoice?.mask && typedChoice.sig === typedSig ? rd.maskTyped(t) : null;
    setDraft("");
    setImages([]);
    setTexts([]);
    setImgError(null);
    setTypedChoice(null);
    void Promise.resolve(onSend(typed ? typed.text : t, kept.map((i) => i.dataUrl), keptTexts, typed ? { redaction: typed.meta } : undefined)).then((ok) => {
      if (ok !== false) return void rd.commit();
      setDraft((d) => (d.trim() ? d : t));
      setImages((cur) => (cur.length ? cur : kept));
      setTexts((cur) => (cur.length ? cur : keptTexts));
    });
  }

  // X7 : images collées, déposées ou choisies. Refus annoncé (type, taille, nombre), jamais silencieux.
  async function addFiles(files: Iterable<File>): Promise<void> {
    let count = images.length;
    const added: PendingImage[] = [];
    let refusal: string | null = null;
    for (const f of files) {
      const why = refuseImage(f, count);
      if (why) {
        refusal = refusalText(why);
        continue;
      }
      try {
        added.push({ id: `${f.name}-${f.size}-${Math.random().toString(36).slice(2, 8)}`, name: f.name || tr("image"), type: f.type, size: f.size, dataUrl: await readAsDataUrl(f) });
        count++;
      } catch {
        refusal = tr("This image could not be read.");
      }
    }
    if (added.length) setImages((cur) => [...cur, ...added]);
    setImgError(refusal);
  }

  return (
    <section className="chat" aria-label={tr("Conversation with Nina — session {0}", title)}>
      <div className="chat-scroll" role="log" aria-live="polite" aria-relevant="additions">
        <div className="chat-inner">
          {empty && messages.length === 0 && !live && !streaming && !sending
            ? empty((text) => {
                setDraft(text);
                document.getElementById("nk-composer")?.focus();
              })
            : null}
          <RedactContext.Provider value={rd.dict}>
          {messages.map((m, i) => (
            <Message
              key={`${m.index}-${m.role}`}
              m={m}
              thinking={thinking && i === lastUserIdx}
              images={m.role === "user" && client && threadId && splitImages(m.images).person.length ? <MessageImages client={client} threadId={threadId} images={splitImages(m.images).person} /> : null}
              toolImages={m.role === "assistant" && client && threadId && toolImages.get(m.index)?.length ? <ToolImages client={client} threadId={threadId} images={toolImages.get(m.index)!} /> : null}
              attachments={m.role === "user" && client && threadId && m.attachments?.some((a) => a.source !== "device_dictation") ? <AttachmentChips client={client} threadId={threadId} items={m.attachments.filter((a) => a.source !== "device_dictation")} /> : null}
              cost={m.role === "assistant" && threadId ? turnCosts[`${threadId}:${m.index}`] : undefined}
              quotaAction={m.role === "assistant" && threadId && quotaTurns[`${threadId}:${m.index}`] && onOpenAccount ? onOpenAccount : undefined}
              quotaRemote={accountRemote}
              notice={m.role === "assistant" && threadId ? turnNotices[`${threadId}:${m.index}`] : undefined}
              listen={canSpeak && client && threadId && m.role === "assistant" && m.content ? <ListenButton client={client} threadId={threadId} index={m.index} /> : null}
              phone={
                m.role === "assistant" && (m.phone_fetched?.length || m.phone_tasks?.length || (m.phone_fetch_offers?.length && client && threadId)) ? (
                  <>
                    {m.phone_tasks?.length ? <PhoneTaskNotes items={m.phone_tasks} /> : null}
                    {m.phone_fetched?.length ? <PhoneFetchedNote items={m.phone_fetched} /> : null}
                    {m.phone_fetch_offers?.length && client && threadId ? <PhoneFetchOffers client={client} threadId={threadId} offers={m.phone_fetch_offers} /> : null}
                  </>
                ) : null
              }
            />
          ))}
          </RedactContext.Provider>
          {startedMessage && !messages.some((m) => m.role === "user" && m.content.trim() === startedMessage.text.trim() && !startedMessage.truncated) ? (
            <div data-started-message={startedMessage.turn_id} style={{ display: "contents" }}>
              <Message m={{ index: -1, role: "user", content: startedMessage.text }} />
              {startedMessage.truncated ? <p className="fine started-cut">{tr("The full message appears when the reply ends.")}</p> : null}
            </div>
          ) : null}
          {live && streaming === null ? (
            <div className="msg nina" data-turn-id={live.turn_id}>
              <NinaAvatar />
              <FlowBox className="msg-body" text={live.text}>
                <Markdown text={live.text} />
              </FlowBox>
            </div>
          ) : null}
          {writing.map((w) => (
            <LiveWrite key={w.callId} w={w} />
          ))}
          {streaming ? (
            <div className="msg nina">
              <NinaAvatar />
              <FlowBox className="msg-body" text={streaming}><Markdown text={streaming} /></FlowBox>
            </div>
          ) : null}
          <div ref={endRef} />
        </div>
      </div>
      {hookNotice ? (
        <div className="hook-notice" role="status">
          <span>
            {hookNotice.count === 1
              ? tr("This repository declares 1 hook that is not trusted yet: it is ignored.")
              : tr("This repository declares {0} hooks that are not trusted yet: they are ignored.", hookNotice.count)}{" "}
            {hookNotice.notice}
          </span>
          {onTrustHooks ? (
            <button type="button" className="btn" onClick={onTrustHooks}>
              {tr("Trust")}
            </button>
          ) : null}
        </div>
      ) : null}
      {costTotals ? (
        <p className="cost-totals fine" aria-label={tr("Cost")}>
          {costTotals.session ? <span>{tr("Session: {0}", costTotals.session)}</span> : null}
          <span>{tr("Today (UTC): {0}", costTotals.day)}</span>
        </p>
      ) : null}
      {images.length || imgError ? (
        <div className="composer-images">
          {images.map((im) => (
            <figure key={im.id} className="composer-thumb">
              <img src={im.dataUrl} alt={im.name} />
              <button type="button" className="icon-btn" aria-label={tr("Remove {0}", im.name)} onClick={() => setImages((cur) => cur.filter((x) => x.id !== im.id))}>
                <Icon name="close" size={12} />
              </button>
              {tp && canAddText(texts) ? (
                <button type="button" className="composer-ocr" disabled={textBusy} data-ocr onClick={() => void ocr(im)}>
                  {tr("Text only")}
                </button>
              ) : null}
            </figure>
          ))}
          {imgError ? <span className="fine composer-img-error" role="alert">{imgError}</span> : null}
        </div>
      ) : null}
      {texts.length || textNote || preview ? (
        <div className="composer-texts" data-composer-texts>
          {texts.map((a, i) => (
            <span key={`${a.source}-${i}`} className="composer-text-chip" data-text-source={a.source}>
              <span>{a.name}</span>
              <button type="button" className="icon-btn" aria-label={tr("Remove {0}", a.name)} onClick={() => setTexts((cur) => cur.filter((_, j) => j !== i))}>
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
          {textNote ? <p className="fine" role="status">{textNote}</p> : null}
          {preview ? (
            <div className="composer-text-preview" role="dialog" aria-labelledby="nk-text-preview" data-text-preview>
              <p id="nk-text-preview" className="fine">
                {preview.att.source === "device_dictation" ? tr("Your dictated note — check it before sending.") : tr("Recognised on this phone — check it before attaching.")}
              </p>
              <textarea value={preview.att.text} rows={6} aria-label={preview.att.name} onChange={(e) => setPreview({ ...preview, att: { ...preview.att, text: e.target.value } })} />
              {rd.mode === "unavailable" ? (
                <p className="fine" role="alert" data-redact-unavailable>
                  {tr("Masking is not available on this phone: this text cannot be sent.")}
                  {preview.dropImage ? ` ${tr("The photo will be sent as is.")}` : null}
                </p>
              ) : null}
              {rd.active && rd.find(preview.att.text).length ? (
                <div className="redact-preview" data-redact-preview>
                  <p className="fine">{tr("Masked before sending (tap a value to leave it visible):")}</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {[...new Set(rd.find(preview.att.text).map((x) => x.value))].map((v) => (
                      <button
                        key={v}
                        type="button"
                        className="btn btn-ghost btn-sm"
                        aria-pressed={!keep.has(v)}
                        data-redact-value={keep.has(v) ? "kept" : "masked"}
                        onClick={() => setKeep((k) => {
                          const n = new Set(k);
                          if (n.has(v)) n.delete(v);
                          else n.add(v);
                          return n;
                        })}
                        style={keep.has(v) ? {} : { textDecoration: "line-through" }}
                      >
                        {keep.has(v) ? tr("{0} (left visible)", v) : v}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="composer-text-actions">
                <button
                  type="button"
                  className="btn btn-brass"
                  disabled={!preview.att.text.trim()}
                  onClick={() => {
                    const p = preview;
                    void rd.maskAttachment(textAttachment(p.att.source, p.att.name, p.att.text, { ...(p.att.duration_s ? { duration_s: p.att.duration_s } : {}) }), keep).then((att) => {
                      if (!att) {
                        // Fail-closed : sans masquage dans la coque, le texte lu sur l'appareil ne part pas.
                        setTextNote(tr("Masking is not available on this phone, so this text was not attached. Update or restart the app."));
                        setPreview(null);
                        return;
                      }
                      setTexts((cur) => [...cur, att]);
                      setKeep(new Set());
                      if (p.dropImage) setImages((cur) => cur.filter((x) => x.id !== p.dropImage));
                      setPreview(null);
                    });
                  }}
                >
                  {preview.att.source === "device_ocr" ? tr("Send the text, not the photo") : tr("Attach")}
                </button>
                <button type="button" className="btn" onClick={() => (setPreview(null), setKeep(new Set()))}>{tr("Cancel")}</button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {typedSpans.length && !(typedChoice?.sig === typedSig && !typedChoice.mask) ? (
        <div className="fine redact-typed" role="status" data-redact-typed={typedChoice?.sig === typedSig && typedChoice.mask ? "mask" : "ask"} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          {typedChoice?.sig === typedSig && typedChoice.mask ? (
            <>
              <span>{typedSpans.length === 1 ? tr("1 sensitive value will be masked when sending.") : tr("{0} sensitive values will be masked when sending.", String(typedSpans.length))}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTypedChoice({ sig: typedSig, mask: false })} data-redact-undo>
                {tr("Undo")}
              </button>
            </>
          ) : (
            <>
              <span>{typedSpans.length === 1 ? tr("1 sensitive value:") : tr("{0} sensitive values:", String(typedSpans.length))}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTypedChoice({ sig: typedSig, mask: true })} data-redact-mask>
                {tr("Mask")}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTypedChoice({ sig: typedSig, mask: false })} data-redact-leave>
                {tr("Keep as is")}
              </button>
            </>
          )}
        </div>
      ) : null}
      {offlineAt != null ? (
        <p className="fine composer-offline" role="status" data-offline-copy>
          {ageMinutes(offlineAt) < 1
            ? tr("Offline: copy from just now, read only. Nothing is sent until the connection is back.")
            : tr("Offline: copy from {0} min ago, read only. Nothing is sent until the connection is back.", String(ageMinutes(offlineAt)))}
        </p>
      ) : !online ? (
        <p className="fine composer-offline" role="status">
          {tr("You are offline: nothing can be sent until the connection is back.")}
        </p>
      ) : null}
      {readOnly ? (
        <div className="composer-readonly" role="status" data-read-only>
          <p className="fine">{readOnly.text}</p>
          {readOnly.action ? (
            <button type="button" className="btn btn-brass" disabled={readOnly.action.busy} onClick={readOnly.action.run} data-continue-cloud>
              {readOnly.action.label}
            </button>
          ) : null}
        </div>
      ) : (
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
          {tr("Message to Nina")}
        </label>
        {(recording || finalising) && orbEnabled() ? (
          <span className="orb-dock" data-orb-dock>
            <Orb state={finalising ? "thinking" : "listening"} size="md" />
          </span>
        ) : null}
        <span className="composer-attach">
          <button
            type="button"
            className="icon-btn"
            aria-label={tp ? tr("Attach") : tr("Attach an image")}
            aria-haspopup={tp ? "menu" : undefined}
            aria-expanded={tp ? attachMenu : undefined}
            {...anchor("attach")}
            onClick={() => (tp ? setAttachMenu((v) => !v) : fileRef.current?.click())}
          >
            <Icon name="image" size={18} />
          </button>
          {tp && attachMenu ? (
            <span className="composer-attach-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setAttachMenu(false); fileRef.current?.click(); }}>
                <Icon name="image" size={16} /> {tr("An image")}
              </button>
              <button type="button" role="menuitem" data-audio disabled={textBusy || !canAddText(texts)} onClick={() => { setAttachMenu(false); audioRef.current?.click(); }}>
                <Icon name="soundOn" size={16} /> {tr("An audio to transcribe")}
              </button>
            </span>
          ) : null}
        </span>
        {tp ? (
          <>
            <button type="button" className={`icon-btn ${recording ? "recording" : ""}`} aria-pressed={recording} aria-label={recording ? tr("Stop dictation") : tr("Dictate a note")} disabled={textBusy && !recording} data-dictate onClick={() => void toggleDictation()}>
              <Icon name={recording ? "micOff" : "mic"} size={18} />
            </button>
            <input
              ref={audioRef}
              type="file"
              accept="audio/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void transcribe(f);
                e.target.value = "";
              }}
            />
          </>
        ) : null}
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
          {...anchor("composer")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          placeholder={tr("Say something to Nina…")}
          autoComplete="off"
        />
        <button type="submit" className="icon-btn send" aria-label={tr("Send")} {...anchor("send")} disabled={sending || recording || (!draft.trim() && images.length === 0 && texts.length === 0)}>
          <Icon name="send" size={18} />
        </button>
      </form>
      )}
    </section>
  );
}

/** Entrée de tour qui ne vient pas d'une frappe : action sur une bulle, message d'une autre session, événement. */
const MACHINE_INPUT = /^\[(Action|Message de la session|Réponse de la session|Relevé)/; // texte du noyau, comparé tel quel
function isMachineInput(m: ThreadMessage): boolean {
  return m.role === "user" && (m.channel === "session" || MACHINE_INPUT.test(m.content));
}

/** Turn that follows a decision (`nokker/approvals/executor.py`): the kernel writes a `[Approbation]…[/Approbation]`
 * block as the user's message, for the MODEL (decider, means, instructions), marked `origin: "approval"`. Never shown
 * as the person's message:
 * only what was decided, in one discreet line. `null` for any other message. */
export function approvalContinuation(m: Pick<ThreadMessage, "role" | "content" | "origin">): { tool: string; status: string } | null {
  if (m.role !== "user") return null;
  // `origin: "approval"` (noyau du 03.11) ; les tours d'avant le champ se reconnaissent à leur bloc (texte du noyau).
  if (m.origin !== "approval" && !m.content.startsWith("[Approbation]")) return null;
  const field = (name: string): string => new RegExp(`^${name} : (.*)$`, "m").exec(m.content)?.[1]?.trim() ?? "";
  return { tool: field("Outil"), status: field("D\u00e9cision") };
}

export function approvalContinuationText(c: { tool: string; status: string }): string {
  const ok = c.status === "approved" || c.status === "executed";
  if (c.tool === PAY_TOOL) return ok ? tr("Payment approved") : c.status === "failed" ? tr("Payment approved, then stopped") : tr("Payment refused");
  return tr("{0}: {1}", c.tool || tr("action"), approvalStatusLabel(c.status));
}

function Message({ m, thinking = false, images = null, toolImages = null, attachments = null, cost, quotaAction, quotaRemote = false, notice, listen = null, phone = null }: { m: ThreadMessage; thinking?: boolean; images?: React.ReactNode; toolImages?: React.ReactNode; attachments?: React.ReactNode; cost?: string; quotaAction?: () => void; quotaRemote?: boolean; notice?: string; listen?: React.ReactNode; phone?: React.ReactNode }): React.ReactElement | null {
  // Tour de continuation (approbation) sans entrée ; un message fait seulement de pièces (image, texte reconnu) s'affiche.
  if (m.role === "user" && !m.content && !images && !attachments) return null;
  // P7b : tour de suite d'une tâche du téléphone, écrit par le noyau ; jamais rendu (la bulle phone_task porte l'état).
  if (m.role === "user" && m.origin === "phone_continue") return null;
  const decided = approvalContinuation(m);
  if (decided) {
    return (
      <div className="msg system" data-continuation="">
        <span className="eyebrow">{tr("approval")}</span>
        <span>{approvalContinuationText(decided)}</span>
      </div>
    );
  }
  if (isMachineInput(m)) {
    return (
      <div className="msg system">
        <span className="eyebrow">{m.content.startsWith("[Action") ? tr("action") : tr("session")}</span>
        <span>{m.content}</span>
      </div>
    );
  }
  // P11 : le geste « Ouvrir par mon téléphone » est un tour de la personne, écrit par le noyau.
  if (m.role === "user" && m.origin === "phone_fetch") {
    const url = /https:\/\/\S+/.exec(m.content)?.[0];
    let host = url ?? m.content;
    try {
      if (url) host = new URL(url).hostname;
    } catch {
      /* garde le texte */
    }
    return (
      <div className="msg user" data-origin="phone_fetch">
        {tr("Open through my phone: {0}", host)}
      </div>
    );
  }
  if (m.role === "user") {
    if (!thinking) {
      return images || attachments ? (
        <div className="msg-user-wrap">
          {images}
          {attachments}
          {m.content ? <div className="msg user"><MaskedText text={m.content} /></div> : null}
        </div>
      ) : (
        <div className="msg user"><MaskedText text={m.content} /></div>
      );
    }
    return (
      <div className="msg-user-wrap">
        {images}
        {attachments}
        <div className="msg user kitt"><MaskedText text={m.content} /></div>
        <ThinkingWord />
      </div>
    );
  }
  return (
    <div className="msg nina">
      <NinaAvatar />
      <div className="msg-body">
        {toolImages}
        <Markdown text={m.content} />
        {phone}
        {listen}
        {quotaAction ? (
          <button type="button" className="quota-account" data-quota-account onClick={quotaAction}>
            {quotaRemote ? tr("My nokker.ai account") : tr("My account")}
          </button>
        ) : null}
        {notice ? <span className="turn-notice fine" data-turn-notice role="status">{notice}</span> : null}
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
            <img src={u} alt={im.name ?? tr("attached image")} />
          </a>
        ) : (
          <span key={im.sha256} className="msg-image missing" title={u === null ? tr("image unavailable") : tr("loading…")}>
            {u === null ? tr("image unavailable") : ""}
          </span>
        );
      })}
    </div>
  );
}

/** Pièces texte d'un message de la personne (P9 : texte lu sur une image, transcription d'un audio) : une puce nommée
 * par pièce ; le texte se relit à la demande. */
function AttachmentChips({ client, threadId, items }: { client: NokkerClient; threadId: string; items: NonNullable<ThreadMessage["attachments"]> }): React.ReactElement {
  const [open, setOpen] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<string, string | null>>({});
  const toggle = (id: string): void => {
    setOpen((o) => (o === id ? null : id));
    if (!(id in texts)) void client.getAttachment(threadId, id).then((a) => setTexts((t) => ({ ...t, [id]: a.text })), () => setTexts((t) => ({ ...t, [id]: null })));
  };
  return (
    <div className="msg-attachments" data-msg-attachments>
      {items.map((a) => (
        <div key={a.id} className="msg-attachment">
          <button type="button" className="msg-attachment-chip" aria-expanded={open === a.id} onClick={() => toggle(a.id)}>
            {a.name} · {tr("{0} characters", a.chars.toLocaleString())}
          </button>
          {open === a.id ? <div className="msg-attachment-text">{texts[a.id] === undefined ? tr("loading…") : texts[a.id] === null ? tr("unavailable") : texts[a.id]}</div> : null}
        </div>
      ))}
    </div>
  );
}

/** Images lues par Nina pendant le tour (origine `tool:…`) : côté outil, nommées, jamais comme pièce jointe. */
function ToolImages({ client, threadId, images }: { client: NokkerClient; threadId: string; images: NonNullable<ThreadMessage["images"]> }): React.ReactElement {
  return (
    <div className="msg-tool-images" data-tool-images>
      {images.map((im) => (
        <p key={im.sha256} className="fine">
          {tr("Image read by Nina: {0}", im.name || tr("image"))}
        </p>
      ))}
      <MessageImages client={client} threadId={threadId} images={images} />
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
const THINKING_COUNT = 20;
/** Le mot d'index `i` (0 à 19), traduit à l'appel : la langue de l'interface peut changer en cours de route. */
function thinkingWord(i: number): string {
  switch (i) {
    case 0:
      return tr("Knock knock knock…");
    case 1:
      return tr("Knocking at the door…");
    case 2:
      return tr("Pricking up an ear…");
    case 3:
      return tr("Sniffing out the trail…");
    case 4:
      return tr("Smoothing its mane…");
    case 5:
      return tr("Roaring softly…");
    case 6:
      return tr("Searching the den…");
    case 7:
      return tr("Sharpening its claws…");
    case 8:
      return tr("Gathering the pride…");
    case 9:
      return tr("Watching…");
    case 10:
      return tr("Lifting the knocker…");
    case 11:
      return tr("Standing guard…");
    case 12:
      return tr("Stirring the memory…");
    case 13:
      return tr("Weighing the pros and cons…");
    case 14:
      return tr("Following the footprints…");
    case 15:
      return tr("Sniffing the wind…");
    case 16:
      return tr("Polishing the brass…");
    case 17:
      return tr("Counting the knocks…");
    case 18:
      return tr("Opening the door a crack…");
    case 19:
      return tr("Tying the threads…");
    default:
      return "";
  }
}

function ThinkingWord(): React.ReactElement {
  const [i, setI] = useState(() => Math.floor(Math.random() * THINKING_COUNT));
  useEffect(() => {
    const t = setInterval(() => {
      setI((cur) => {
        let n = Math.floor(Math.random() * (THINKING_COUNT - 1));
        if (n >= cur) n += 1;
        return n;
      });
    }, 10_000); // le 19.10 : « au moins 10 secondes par mot »
    return () => clearInterval(t);
  }, []);
  return (
    <div className="thinking-word">
      <span className="sr-only">{tr("Nina is thinking")}</span>
      <span key={i} aria-hidden="true">
        {thinkingWord(i)}
      </span>
    </div>
  );
}

/** Repère de découpe d'une phrase traduite qui entoure un nœud JSX. */
const SLOT = "\u0001";

/** X22 : bloc vivant d'un outil qui écrit — le chemin, puis les dernières lignes qui défilent ; « … » si le direct
 * s'est arrêté (appel trop gros). Texte déjà caviardé par le noyau, montré tel quel (jamais interprété). */
function LiveWrite({ w }: { w: LiveInput }): React.ReactElement {
  const sentence = w.name === "patch" ? tr("Nina is editing {0}", SLOT) : w.name === "page_create" ? tr("Nina is creating the page {0}", SLOT) : tr("Nina is writing {0}", SLOT);
  const [before, after] = sentence.split(SLOT);
  return (
    <div className="live-write" aria-live="off">
      <div className="live-write-head">
        <span className="live-dot" aria-hidden="true" />
        <span>
          {before}
          <code>{w.path ?? "…"}</code>
          {after}
        </span>
      </div>
      <pre className="live-write-body">
        {liveTail(w.text, 12, 160).join("\n")}
        {w.truncated ? "\n…" : ""}
      </pre>
    </div>
  );
}

/** `navigator.onLine`, followed: the browser knows before a request fails. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const up = (): void => setOnline(true);
    const down = (): void => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}
