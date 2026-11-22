/**
 * Bouche du rig 2D de Nina, sans DOM (testée sous Node) : à l'instant `tMs` de la parole, le mot en cours (mots
 * horodatés de `/speech/timed`) et l'amplitude réelle de l'audio (AnalyserNode, RMS) donnent l'une des trois bouches.
 * Hors d'un mot : fermée. Dans un mot : ouverte si l'audio est fort, mi-ouverte s'il est moyen ; sans amplitude
 * mesurable (analyse indisponible, audio de test plat), une alternance par mot garde la bouche vivante.
 */
export type RigMouth = "open" | "half" | "closed";

export interface TimedWords {
  words: string[];
  wtimes: number[];
  wdurations: number[];
}

/** Index du mot prononcé à `tMs`, ou -1 entre les mots. */
export function wordAt(s: TimedWords, tMs: number): number {
  for (let i = 0; i < s.wtimes.length; i++) {
    const start = s.wtimes[i] ?? 0;
    if (tMs >= start && tMs < start + (s.wdurations[i] ?? 0)) return i;
  }
  return -1;
}

/** RMS d'un tampon `getByteTimeDomainData` (0 = silence, ~0,7 = saturé). */
export function rms(buf: ArrayLike<number>): number {
  if (!buf.length) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = ((buf[i] ?? 128) - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

export function mouthAt(s: TimedWords, tMs: number, level: number | null): RigMouth {
  const i = wordAt(s, tMs);
  if (i < 0) return "closed";
  if (level !== null && level > 0.09) return "open";
  if (level !== null && level > 0.03) return "half";
  // Pas d'amplitude utile : la moitié du mot ouverte, l'autre mi-ouverte, en alternant d'un mot à l'autre.
  const start = s.wtimes[i] ?? 0;
  const firstHalf = tMs - start < (s.wdurations[i] ?? 0) / 2;
  return (i % 2 === 0) === firstHalf ? "open" : "half";
}

/** Une URL de catalogue qui finit par « / » désigne un rig 2D (dossier de calques), sinon un modèle 3D. */
export function isRigUrl(url: string): boolean {
  return url.endsWith("/");
}
