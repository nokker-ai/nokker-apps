import { describe, expect, it, vi } from "vitest";
import type { TimedSpeech } from "@nokker-apps/sdk";
import { AvatarController, base64ToArrayBuffer, webglAvailable, type AvatarDeps, type HeadLike } from "../src/avatar/engine.js";

const SPEECH: TimedSpeech = { audio: btoa("fake-mp3"), mime: "audio/mpeg", words: ["Hello", "Bob"], wtimes: [0, 400], wdurations: [350, 600] };
const node = {} as HTMLElement;

function fakeHead(state: AudioContextState = "running") {
  const ctx = {
    state,
    resume: vi.fn(() => new Promise<void>(() => {})), // autoplay bloqué : la promesse ne se résout jamais
    decodeAudioData: vi.fn(async () => ({ duration: 1.2 }) as AudioBuffer),
  };
  const head: HeadLike & { ctx: typeof ctx } = {
    ctx,
    lipsyncLang: "fr",
    audioCtx: ctx as unknown as HeadLike["audioCtx"],
    show: vi.fn(async () => {}),
    speak: vi.fn(),
    stopSpeaking: vi.fn(),
    setMood: vi.fn(),
    setView: vi.fn(),
    dispose: vi.fn(),
  };
  return head;
}

function deps(over: Partial<AvatarDeps> = {}): AvatarDeps {
  return {
    hasWebGL: () => true,
    createHead: vi.fn(async () => fakeHead()),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    resumeWaitMs: 5,
    ...over,
  };
}

describe("<TalkingAvatar> — pilote", () => {
  it("sans WebGL (Node, sans document) : onError(webgl_unavailable), aucune exception, moteur jamais chargé", async () => {
    expect(webglAvailable()).toBe(false);
    const onError = vi.fn();
    const d = deps({ hasWebGL: () => webglAvailable() });
    const c = new AvatarController(node, "/avatars/avatar-one-v1.glb", { lang: "fr", mood: "neutral", framing: "head" }, { onError }, d);
    await expect(c.start()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith("webgl_unavailable");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(d.createHead).not.toHaveBeenCalled();
    await c.say(SPEECH); // ignoré, sans erreur
    c.dispose();
  });

  it("webglAvailable : contexte refusé ou exception → faux", () => {
    const doc = (get: () => unknown) => ({ createElement: () => ({ getContext: get }) }) as unknown as Document;
    expect(webglAvailable(doc(() => null))).toBe(false);
    expect(webglAvailable(doc(() => { throw new Error("x"); }))).toBe(false);
    expect(webglAvailable(doc(() => ({})))).toBe(true);
  });

  it("GLB introuvable : onError(load_failed), moteur libéré", async () => {
    const head = fakeHead();
    head.show = vi.fn(async () => { throw new Error("404"); });
    const onError = vi.fn();
    await new AvatarController(node, "/avatars/missing.glb", { lang: "fr", mood: "neutral", framing: "head" }, { onError }, deps({ createHead: async () => head })).start();
    expect(onError).toHaveBeenCalledWith("load_failed");
    expect(head.dispose).toHaveBeenCalled();
  });

  it("une parole donnée avant le chargement est dite une fois prêt, avec AudioBuffer et minutage ; onSpeechEnd ensuite", async () => {
    vi.useFakeTimers();
    try {
      const head = fakeHead();
      const onSpeechEnd = vi.fn();
      const c = new AvatarController(node, "/avatars/avatar-one-v1.glb", { lang: "fr", mood: "happy", framing: "upper" }, { onSpeechEnd }, deps({ createHead: async () => head }));
      await c.say(SPEECH);
      await c.start();
      expect(head.ctx.decodeAudioData).toHaveBeenCalledTimes(1);
      expect(new Uint8Array(head.ctx.decodeAudioData.mock.calls[0]![0] as ArrayBuffer)).toEqual(new Uint8Array(base64ToArrayBuffer(SPEECH.audio)));
      expect(head.speak).toHaveBeenCalledWith({ duration: 1.2 }, SPEECH);
      expect(onSpeechEnd).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1500);
      expect(onSpeechEnd).toHaveBeenCalledTimes(1);
      c.dispose();
      expect(head.dispose).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lecture bloquée par l'autoplay : onError(audio_blocked), rien n'est dit", async () => {
    const head = fakeHead("suspended");
    const onError = vi.fn();
    const c = new AvatarController(node, "/a.glb", { lang: "en", mood: "neutral", framing: "head" }, { onError }, deps({ createHead: async () => head }));
    await c.start();
    await c.say(SPEECH);
    expect(head.ctx.resume).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("audio_blocked");
    expect(head.speak).not.toHaveBeenCalled();
  });

  it("démonté pendant le chargement : le moteur est libéré, aucun rappel", async () => {
    const head = fakeHead();
    let release!: () => void;
    head.show = vi.fn(() => new Promise<void>((r) => (release = r)));
    const onReady = vi.fn();
    const c = new AvatarController(node, "/a.glb", { lang: "fr", mood: "neutral", framing: "head" }, { onReady }, deps({ createHead: async () => head }));
    const p = c.start();
    await Promise.resolve();
    await Promise.resolve();
    c.dispose();
    release();
    await p;
    expect(onReady).not.toHaveBeenCalled();
    expect(head.dispose).toHaveBeenCalled();
  });
});

describe("chargement paresseux", () => {
  it("TalkingHead et three ne sont importés que par head.ts, lui-même chargé par import()", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = join(__dirname, "../src");
    const files = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : /\.tsx?$/.test(n) && !n.endsWith(".d.ts") ? [join(d, n)] : []));
    for (const f of files(src)) {
      const code = readFileSync(f, "utf8");
      const rel = f.slice(src.length + 1);
      if (rel === "avatar/head.ts") continue;
      expect(code, rel).not.toMatch(/from\s+["'](three|@met4citizen\/talkinghead)/);
      expect(code, rel).not.toMatch(/from\s+["']\.\/head\.js["']/);
    }
    expect(readFileSync(join(src, "avatar/engine.ts"), "utf8")).toMatch(/import\("\.\/head\.js"\)/);
  });
});
