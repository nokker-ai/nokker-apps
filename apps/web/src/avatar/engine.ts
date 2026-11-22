/**
 * Pilote de `<TalkingAvatar>` sans React : vérifie WebGL, charge TalkingHead à la demande, montre l'avatar et lui fait
 * dire une `TimedSpeech`. Les dépendances (détection WebGL, chargement du moteur, minuterie) sont injectables : les
 * tests le font tourner sous Node, sans DOM ni WebGL.
 */
import type { TimedSpeech } from "@nokker-apps/sdk";

export type AvatarErrorCode = "webgl_unavailable" | "load_failed" | "audio_blocked";
export type AvatarMood = "neutral" | "happy";
export type AvatarFraming = "head" | "upper";

export interface HeadOptions {
  lang: string;
  mood: AvatarMood;
  framing: AvatarFraming;
}

/** Ce que le pilote attend du moteur (TalkingHead, enveloppé par `head.ts`). */
export interface HeadLike {
  readonly lipsyncLang: string;
  readonly audioCtx: Pick<AudioContext, "state" | "resume" | "decodeAudioData">;
  show(url: string): Promise<void>;
  speak(audio: AudioBuffer, s: Pick<TimedSpeech, "words" | "wtimes" | "wdurations">): void;
  stopSpeaking(): void;
  setMood(mood: AvatarMood): void;
  setView(view: AvatarFraming): void;
  dispose(): void;
}

export interface AvatarDeps {
  hasWebGL: () => boolean;
  createHead: (node: HTMLElement, o: HeadOptions) => Promise<HeadLike>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  /** Temps laissé à `AudioContext.resume()` avant de conclure que le navigateur bloque la lecture. */
  resumeWaitMs: number;
}

export interface AvatarCallbacks {
  onReady?: () => void;
  onSpeechEnd?: () => void;
  onError?: (code: AvatarErrorCode) => void;
}

/** WebGL utilisable dans cette page ? Faux sous Node, sans `document`, ou quand le contexte est refusé. */
export function webglAvailable(doc: Document | undefined = typeof document === "undefined" ? undefined : document): boolean {
  try {
    if (!doc) return false;
    const c = doc.createElement("canvas");
    return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** Base64 → octets, pour `decodeAudioData` (pas d'URL `data:` : aucune requête, rien à ouvrir dans la CSP). */
export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export const defaultDeps: AvatarDeps = {
  hasWebGL: () => webglAvailable(),
  createHead: async (node, o) => (await import("./head.js")).createHead(node, o),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  resumeWaitMs: 400,
};

export class AvatarController {
  private head: HeadLike | null = null;
  private disposed = false;
  private failed = false;
  private pending: TimedSpeech | null = null;
  private endTimer: unknown = null;
  private speechSeq = 0;

  constructor(
    private readonly node: HTMLElement,
    private readonly url: string,
    private opts: HeadOptions,
    private readonly cb: AvatarCallbacks,
    private readonly deps: AvatarDeps = defaultDeps,
  ) {}

  /** Monte l'avatar. Ne lève jamais : un échec passe par `onError` et le pilote reste inerte. */
  async start(): Promise<void> {
    if (!this.deps.hasWebGL()) return this.fail("webgl_unavailable");
    let head: HeadLike;
    try {
      head = await this.deps.createHead(this.node, this.opts);
    } catch {
      // Le moteur n'a pas pu créer son rendu (contexte WebGL refusé au dernier moment) ou son code n'a pas chargé.
      return this.fail(this.deps.hasWebGL() ? "load_failed" : "webgl_unavailable");
    }
    if (this.disposed) return void safe(() => head.dispose());
    try {
      await head.show(this.url);
    } catch {
      safe(() => head.dispose());
      return this.fail("load_failed");
    }
    if (this.disposed) return void safe(() => head.dispose());
    this.head = head;
    this.cb.onReady?.();
    const p = this.pending;
    this.pending = null;
    if (p) await this.say(p);
  }

  /** Fait dire `s` une fois. Avant que l'avatar soit prêt, la dernière parole demandée attend son tour. */
  async say(s: TimedSpeech): Promise<void> {
    if (this.disposed || this.failed) return;
    const head = this.head;
    if (!head) {
      this.pending = s;
      return;
    }
    const seq = ++this.speechSeq;
    this.clearEnd();
    safe(() => head.stopSpeaking());
    if (!(await this.audioRunning(head))) {
      if (seq === this.speechSeq && !this.disposed) this.cb.onError?.("audio_blocked");
      return;
    }
    let buf: AudioBuffer;
    try {
      buf = await head.audioCtx.decodeAudioData(base64ToArrayBuffer(s.audio));
    } catch {
      if (seq === this.speechSeq && !this.disposed) this.cb.onError?.("load_failed");
      return;
    }
    if (seq !== this.speechSeq || this.disposed) return;
    try {
      head.speak(buf, s);
    } catch {
      this.cb.onError?.("load_failed");
      return;
    }
    const lastWord = s.wtimes.reduce((m, t, i) => Math.max(m, t + (s.wdurations[i] ?? 0)), 0);
    const ms = Math.max(buf.duration * 1000, lastWord) + 250;
    this.endTimer = this.deps.setTimeout(() => {
      this.endTimer = null;
      if (seq === this.speechSeq && !this.disposed) this.cb.onSpeechEnd?.();
    }, ms);
  }

  setMood(m: AvatarMood): void {
    this.opts = { ...this.opts, mood: m };
    if (this.head) safe(() => this.head!.setMood(m));
  }

  setFraming(f: AvatarFraming): void {
    this.opts = { ...this.opts, framing: f };
    if (this.head) safe(() => this.head!.setView(f));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearEnd();
    this.pending = null;
    const h = this.head;
    this.head = null;
    if (h) safe(() => h.dispose());
  }

  private fail(code: AvatarErrorCode): void {
    if (this.disposed || this.failed) return;
    this.failed = true;
    this.pending = null;
    this.cb.onError?.(code);
  }

  private clearEnd(): void {
    if (this.endTimer !== null) this.deps.clearTimeout(this.endTimer);
    this.endTimer = null;
  }

  /** Autoplay : sans geste de la personne, `resume()` reste en attente indéfiniment ; on ne l'attend qu'un instant. */
  private async audioRunning(head: HeadLike): Promise<boolean> {
    const ctx = head.audioCtx;
    if (ctx.state === "running") return true;
    try {
      await Promise.race([ctx.resume(), new Promise<void>((r) => this.deps.setTimeout(r, this.deps.resumeWaitMs))]);
    } catch {
      return false;
    }
    return (ctx.state as AudioContextState) === "running";
  }
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* le moteur est déjà démonté */
  }
}
