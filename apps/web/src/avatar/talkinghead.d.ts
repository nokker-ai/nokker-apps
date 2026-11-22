// Déclarations minimales de TalkingHead (@met4citizen/talkinghead, MIT, sans types publiés) : seulement ce que
// `head.ts` utilise.
declare module "@met4citizen/talkinghead" {
  export class TalkingHead {
    constructor(node: HTMLElement, opt?: Record<string, unknown>);
    audioCtx: AudioContext;
    lipsync: Record<string, unknown>;
    isSpeaking: boolean;
    showAvatar(avatar: { url: string; body?: "F" | "M"; avatarMood?: string; lipsyncLang?: string }, onprogress?: ((ev: ProgressEvent) => void) | null): Promise<void>;
    speakAudio(r: { audio: AudioBuffer; words: string[]; wtimes: number[]; wdurations: number[] }, opt?: { lipsyncLang?: string } | null): void;
    stopSpeaking(): void;
    setMood(mood: string): void;
    setView(view: string, opt?: { cameraX?: number; cameraY?: number; cameraDistance?: number }): void;
    start(): void;
    stop(): void;
    dispose(): void;
  }
}
declare module "@met4citizen/talkinghead/modules/lipsync-fr.mjs" {
  export class LipsyncFr {}
}
declare module "@met4citizen/talkinghead/modules/lipsync-en.mjs" {
  export class LipsyncEn {}
}
declare module "@met4citizen/talkinghead/modules/lipsync-de.mjs" {
  export class LipsyncDe {}
}

// three 0.180 n'embarque pas ses types (pas de @types/three ici) : le strict minimum utilisé par head.ts.
declare module "three" {
  export class Color {
    constructor(hex: number);
  }
  export class PMREMGenerator {
    constructor(renderer: unknown);
    fromScene(scene: unknown, sigma?: number): { texture: unknown };
    dispose(): void;
  }
}
declare module "three/examples/jsm/environments/RoomEnvironment.js" {
  export class RoomEnvironment {
    constructor();
  }
}
