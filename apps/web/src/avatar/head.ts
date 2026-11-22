/**
 * Seul module qui importe TalkingHead et three : chargé par `import()` depuis `engine.ts`, donc absent du paquet
 * principal et jamais téléchargé tant qu'aucun `<TalkingAvatar>` n'est monté.
 *
 * TalkingHead 1.7.0 importe ses modules de synchro labiale par un chemin calculé (`import(path + "lipsync-xx.mjs")`)
 * que Vite n'embarque pas (le build ne contient que les modules importés par un chemin fixe) : en production cet
 * import viserait un fichier absent (404, promesse rejetée). On lui passe donc `lipsyncModules: []` et on enregistre
 * nous-mêmes `head.lipsync.<langue>` AVANT toute parole, depuis un import à chemin fixe (un fichier par langue, chargé
 * à la demande).
 */
import { TalkingHead } from "@met4citizen/talkinghead";
import { Color, PMREMGenerator } from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { HeadLike, HeadOptions } from "./engine.js";

const LIPSYNC: Record<string, () => Promise<new () => unknown>> = {
  fr: () => import("@met4citizen/talkinghead/modules/lipsync-fr.mjs").then((m) => m.LipsyncFr),
  en: () => import("@met4citizen/talkinghead/modules/lipsync-en.mjs").then((m) => m.LipsyncEn),
  de: () => import("@met4citizen/talkinghead/modules/lipsync-de.mjs").then((m) => m.LipsyncDe),
};

/** Langue de synchro labiale connue pour `lang` (« fr-CH » → « fr ») ; l'anglais pour une langue sans module. */
export function lipsyncLang(lang: string): string {
  const base = lang.toLowerCase().split(/[-_]/)[0] ?? "";
  return base in LIPSYNC ? base : "en";
}

/** Cadrage « head » des préréglages MPFB dans un cadre carré : la vue par défaut de TalkingHead coupe la tête et la
 * décale (mesuré au rendu, Chromium 07.11) ; ces valeurs donnent un portrait tête et épaules, avec la marge du
 * balancement de repos. */
const HEAD_CAMERA = { cameraX: -0.42, cameraY: 0.75, cameraDistance: 1.4 };

/** Éclairage des préréglages (réglé au rendu, Chromium 07.11) : la lumière par défaut de TalkingHead (ambiante blanche
 * forte, directe bleutée) aplatit la peau. Ici : ambiante faible, lumière douce de trois quarts, contre-jour corail de
 * la marque, et une carte d'environnement calculée (RoomEnvironment, aucun fichier externe). */
const LIGHT = {
  lightAmbientColor: 0xfff4ec,
  lightAmbientIntensity: 0.25,
  lightDirectColor: 0xfff1e4,
  lightDirectIntensity: 14,
  lightDirectPhi: 1.1,
  lightDirectTheta: 0.9,
  lightSpotColor: 0xff6f61,
  lightSpotIntensity: 90,
  lightSpotPhi: 0.6,
  lightSpotTheta: 2.6,
  lightSpotDispersion: 1,
};

interface LookMesh {
  name: string;
  isMesh?: boolean;
  material?: Record<string, unknown> & { name?: string };
}
interface Lookable {
  renderer?: { toneMappingExposure: number };
  scene?: { environment: unknown };
  armature?: { traverse(fn: (o: LookMesh) => void): void };
}

/** Après le chargement : environnement, exposition, cils et sourcils fins (mèches opaques qui, en petit, donnent des
 * points sombres), peau plus chaude et mate. Jamais bloquant : une erreur laisse le rendu de TalkingHead. */
function applyLook(h: Lookable): void {
  try {
    const r = h.renderer;
    if (h.scene && r) {
      const pm = new PMREMGenerator(r);
      h.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
      pm.dispose();
      r.toneMappingExposure = 0.82;
    }
    h.armature?.traverse((obj) => {
      const m = obj.material;
      if (!obj.isMesh || !m) return;
      const name = `${obj.name} ${m.name ?? ""}`;
      if (/eyelash/i.test(name)) Object.assign(m, { transparent: true, opacity: 0.55, depthWrite: false, color: new Color(0x3a2a22) });
      else if (/eyebrow/i.test(name)) Object.assign(m, { transparent: true, opacity: 0.8, depthWrite: false, color: new Color(0x4a3426) });
      else if ("envMapIntensity" in m) {
        m.envMapIntensity = 0.35;
        if (/body|skin|base/i.test(name)) Object.assign(m, { roughness: 0.62, metalness: 0, color: new Color(0xf6d9c8) });
      }
      m.needsUpdate = true;
    });
  } catch {
    /* rendu d'origine */
  }
}

export async function createHead(node: HTMLElement, o: HeadOptions): Promise<HeadLike> {
  const lip = lipsyncLang(o.lang);
  const head = new TalkingHead(node, {
    // Valeur fictive : jamais appelée (seul `speakAudio` sert). Certaines builds de TalkingHead refusent un point vide.
    ttsEndpoint: "/no-tts",
    lipsyncModules: [],
    lipsyncLang: lip,
    cameraView: o.framing,
    ...(o.framing === "head" ? HEAD_CAMERA : {}),
    avatarMood: o.mood,
    cameraRotateEnable: false,
    cameraPanEnable: false,
    cameraZoomEnable: false,
    // Les GLB du catalogue ne sont pas compressés en Draco : pas de décodeur chargé depuis un autre domaine.
    dracoEnabled: false,
    ...LIGHT,
  });
  const Lipsync = await LIPSYNC[lip]!();
  head.lipsync[lip] = new Lipsync();
  return {
    lipsyncLang: lip,
    get audioCtx() {
      return head.audioCtx;
    },
    show: async (url) => {
      await head.showAvatar({ url, avatarMood: o.mood, lipsyncLang: lip });
      applyLook(head as unknown as Lookable);
    },
    speak: (audio, s) => head.speakAudio({ audio, words: s.words, wtimes: s.wtimes, wdurations: s.wdurations }, { lipsyncLang: lip }),
    stopSpeaking: () => head.stopSpeaking(),
    setMood: (m) => head.setMood(m),
    setView: (v) => head.setView(v, v === "head" ? HEAD_CAMERA : { cameraX: 0, cameraY: 0, cameraDistance: 0 }),
    dispose: () => head.dispose(),
  };
}
