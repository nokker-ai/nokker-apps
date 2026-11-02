/**
 * `/loop <intervalle> <prompt>` — pur, sans Ink : lecture de l'intervalle, garde-fous, textes de `/loop`. La boucle
 * vit tant que la session est ouverte ; une relance ne part jamais pendant un tour (elle passe par la file de prompts),
 * et une relance encore en file n'est pas doublée. Échap n'arrête pas une boucle (seulement le tour).
 */
import { t } from "./i18n/index.js";

/** Plancher de l'intervalle et nombre de relances au plus, par boucle. */
export const LOOP_MIN_MS = 30_000;
export const LOOP_MAX_RUNS = 50;

export interface LoopEntry {
  id: number;
  everyMs: number;
  /** Intervalle tel qu'affiché et envoyé au modèle (« 5m », « 30s »). */
  every: string;
  prompt: string;
  /** Relances déjà envoyées ou mises en file. */
  runs: number;
  /** Prochaine relance (ms depuis l'époque). */
  nextAt: number;
}

/** `30s`, `5m`, `1m30s` → ms ; `null` si illisible. */
export function parseInterval(s: string): number | null {
  const m = /^(?:(\d+)m)?(?:(\d+)s)?$/i.exec(s.trim());
  if (!m || (!m[1] && !m[2])) return null;
  const ms = (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 1000;
  return ms > 0 ? ms : null;
}

/** Intervalle lisible : `90000` → `1m30s`. */
export function formatInterval(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m}m${r ? `${r}s` : ""}` : `${r}s`;
}

/** Intervalle demandé → intervalle retenu (plancher 30 s) et s'il a été relevé. */
export function clampInterval(ms: number): { ms: number; raised: boolean } {
  return ms < LOOP_MIN_MS ? { ms: LOOP_MIN_MS, raised: true } : { ms, raised: false };
}

/** Décision à l'échéance d'une boucle : sauter (la relance précédente attend encore dans la file), ou relancer avec
 * le numéro `run` ; `last` : c'est la 50e, la boucle s'arrête après. */
export function loopTickDecision(l: Pick<LoopEntry, "runs">, alreadyQueued: boolean): { skip: true } | { skip: false; run: number; last: boolean } {
  if (alreadyQueued || l.runs >= LOOP_MAX_RUNS) return { skip: true };
  const run = l.runs + 1;
  return { skip: false, run, last: run >= LOOP_MAX_RUNS };
}

/** `/loop` sans argument. */
export function formatLoops(loops: readonly LoopEntry[], now: number): string {
  if (loops.length === 0) return t("No loop running. /loop <interval> <prompt> starts one (30s at least, e.g. /loop 5m check the CI).");
  return [
    t("Loops ({0}):", loops.length),
    ...loops.map((l) => `  #${l.id}  ${t("every {0} · {1}/{2} runs · next in {3}", l.every, l.runs, LOOP_MAX_RUNS, formatInterval(Math.max(0, l.nextAt - now)))}  ${clip(l.prompt)}`),
    t("/loop stop [#id] stops them (all by default)."),
  ].join("\n");
}

/** Ligne de la barre d'état. */
export function loopsStatusLine(loops: readonly LoopEntry[]): string | null {
  if (loops.length === 0) return null;
  return loops.map((l) => t("loop #{0} every {1} ({2}/{3})", l.id, l.every, l.runs, LOOP_MAX_RUNS)).join(" · ");
}

function clip(s: string, max = 60): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
