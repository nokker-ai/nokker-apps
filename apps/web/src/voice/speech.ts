/**
 * « Listen » to a reply (core p2/tts-stream, contract of 03.11.2026): `POST /v1/threads/{id}/messages/{index}/speech`
 * answers `audio/mpeg` in chunks. Playback starts on the first bytes through MediaSource (ManagedMediaSource on iOS),
 * never after the whole file; without MediaSource for MP3 the answer is read whole, then played. One reading at a time.
 */
import { NokkerApiError, type NokkerClient, type SpeechCapability } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import { off as offCap } from "../capabilities.js";

export type SpeechState = "idle" | "loading" | "playing" | "paused" | "error";

type MSCtor = typeof MediaSource;
/** MediaSource that can take MP3 (ManagedMediaSource on iOS 17.1+), or null: then the whole answer is read first. */
export function streamingSource(w: { MediaSource?: MSCtor; ManagedMediaSource?: MSCtor } = window as never): MSCtor | null {
  const MS = w.ManagedMediaSource ?? w.MediaSource;
  try {
    return MS && MS.isTypeSupported("audio/mpeg") ? MS : null;
  } catch {
    return null;
  }
}

/** What the person reads when the voice did not come (codes of the contract). */
export function speechErrorText(e: unknown): string {
  const code = e instanceof NokkerApiError ? ((e.body as { error?: { code?: string } } | undefined)?.error?.code ?? null) : null;
  const status = e instanceof NokkerApiError ? e.status : 0;
  if (code === "too_long" || status === 413) return tr("This reply is too long to be read aloud.");
  if (code === "rate_limited" || status === 429) return tr("Too many readings just now: try again in a moment.");
  if (code === "tts_off" || status === 503 || status === 404) return tr("Reading aloud is not available.");
  return tr("The voice could not be loaded. Try again.");
}

const caps = new WeakMap<object, Promise<SpeechCapability | null>>();
/** The core's capability, kept per client once the core answered (200, or 404: off); `null`: no « Listen » button.
 * Any other failure (no session yet, network) is not kept: the next call asks again. */
export function speechCapability(client: Pick<NokkerClient, "getSpeechCapability">): Promise<SpeechCapability | null> {
  // The core said the voice is off for this caller (`speech` capability): no probe.
  if (offCap("speech")) return Promise.resolve(null);
  let p = caps.get(client);
  if (!p) {
    p = client.getSpeechCapability().then(
      (c) => (c?.available ? c : null),
      () => {
        caps.delete(client);
        return null;
      },
    );
    caps.set(client, p);
  }
  return p;
}

const once = (t: EventTarget, ev: string): Promise<void> => new Promise((ok) => t.addEventListener(ev, () => ok(), { once: true }));

/** One reading: fetches, streams into an <audio>, reports its state. `stop()` frees everything. */
export class SpeechReading {
  readonly audio: HTMLAudioElement;
  private ctl = new AbortController();
  private url: string | null = null;
  private stopped = false;
  /** `stream`: played while the bytes arrive (MediaSource); `whole`: read whole first (no MediaSource for MP3). */
  mode: "stream" | "whole" | null = null;

  constructor(private readonly onState: (s: SpeechState, error?: string) => void) {
    this.audio = new Audio();
    // ManagedMediaSource (iOS) plays only with remote playback off.
    (this.audio as HTMLAudioElement & { disableRemotePlayback?: boolean }).disableRemotePlayback = true;
    this.audio.addEventListener("playing", () => !this.stopped && this.onState("playing"));
    this.audio.addEventListener("pause", () => !this.stopped && !this.audio.ended && this.onState("paused"));
    this.audio.addEventListener("ended", () => this.finish());
  }

  async start(client: Pick<NokkerClient, "speechStream">, threadId: string, index: number, lang: string): Promise<void> {
    this.onState("loading");
    try {
      const res = await client.speechStream(threadId, index, { lang, signal: this.ctl.signal });
      const MS = streamingSource();
      if (MS && res.body) {
        this.mode = "stream";
        await this.stream(MS, res.body);
      } else {
        this.mode = "whole";
        this.url = URL.createObjectURL(await res.blob());
        this.audio.src = this.url;
        await this.audio.play();
      }
    } catch (e) {
      if (this.stopped) return;
      this.stop();
      this.onState("error", speechErrorText(e));
    }
  }

  private async stream(MS: MSCtor, body: ReadableStream<Uint8Array>): Promise<void> {
    const ms = new MS();
    this.url = URL.createObjectURL(ms);
    this.audio.src = this.url;
    await once(ms, "sourceopen");
    const sb = ms.addSourceBuffer("audio/mpeg");
    const reader = body.getReader();
    let started = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (this.stopped) return void reader.cancel().catch(() => undefined);
      if (done) break;
      if (!value?.length) continue;
      sb.appendBuffer(value as Uint8Array<ArrayBuffer>);
      await once(sb, "updateend");
      // First bytes in: playing starts now, the rest keeps arriving.
      if (!started) {
        started = true;
        await this.audio.play();
      }
    }
    if (ms.readyState === "open") ms.endOfStream();
  }

  pause(): void {
    this.audio.pause();
  }

  resume(): void {
    void this.audio.play().catch(() => this.onState("error", tr("The voice could not be loaded. Try again.")));
  }

  private finish(): void {
    this.stop();
    this.onState("idle");
  }

  stop(): void {
    this.stopped = true;
    this.ctl.abort();
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}

/** The one reading in progress (a second « Listen » stops the first). */
let current: { reading: SpeechReading; reset: () => void } | null = null;
export function takeTurn(reading: SpeechReading, reset: () => void): void {
  if (current && current.reading !== reading) {
    current.reading.stop();
    current.reset();
  }
  current = { reading, reset };
}
export function releaseTurn(reading: SpeechReading): void {
  if (current?.reading === reading) current = null;
}
