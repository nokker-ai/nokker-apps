/**
 * Nightly memory consolidation — mock of core docs/CONSOLIDATION.md §6 (shapes of nokker/memory/consolidation/engine.py;
 * flag `memory_consolidation` off by default like the core: option `consolidation` or `MOCK_CONSOLIDATION=1` → else 404).
 * Demo: last night merged, corrected, archived and learned; the corrected note was edited since by the person, so
 * undoing that op is a 409 `conflict` and undoing the night lists it in `conflicts` (the others are undone).
 */
import type { ConsolidationNoteView, ConsolidationOp, ConsolidationRun, ConsolidationSettings } from "@nokker-apps/sdk";
import { CONSOLIDATION_OP_KINDS } from "@nokker-apps/sdk";
import type { MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;
const PREFIX = "/v1/memory/consolidation";
const LABELS: Record<string, [string, string]> = {
  merge: ["fusion", "fusions"],
  correct: ["correction", "corrections"],
  archive: ["archivage", "archivages"],
  summarize: ["résumé", "résumés"],
  lesson: ["leçon", "leçons"],
};

interface C {
  runs: ConsolidationRun[];
  ops: Map<string, ConsolidationOp[]>;
  settings: ConsolidationSettings;
  pins: Set<string>;
  notes: Set<string>;
  /** Notes the person edited after the consolidation: undoing an op that touched them is a conflict. */
  edited: Set<string>;
}
const all = new WeakMap<MockState, C>();

const note = (title: string, text: string, origin: "user" | "agent" = "user"): ConsolidationNoteView => ({ title, text, kind: "fact", origin, audience: "all" });
const summary = (counts: ConsolidationRun["counts"]): string => {
  const parts = CONSOLIDATION_OP_KINDS.filter((k) => counts[k]).map((k) => `${counts[k]} ${counts[k] === 1 ? LABELS[k]![0] : LABELS[k]![1]}`);
  return parts.length ? parts.join(", ") : "rien à changer";
};

function seed(): C {
  const end = Math.floor(Date.now() / 1000) - 5 * 3600;
  const night = new Date((end - 3600) * 1000).toISOString().slice(0, 10);
  const id = "cr_demo_night";
  const ops: ConsolidationOp[] = [
    {
      id: "co_merge", seq: 0, kind: "merge", scope: "user", reason: "Deux notes disent la même chose sur le rapport du lundi.", evidence: { similar: 0.93 }, at: end, undone_at: null,
      notes: [
        { name: "rapports-lundi", action: "annotate", text: "Fusionnée cette nuit avec : « Rapport hebdo » : le rapport part le lundi à 9 h." },
        { name: "rapport-hebdo", action: "archive", before: note("Rapport hebdo", "Le rapport part le lundi à 9 h.", "agent"), after: null },
      ],
    },
    {
      id: "co_correct", seq: 1, kind: "correct", scope: "user", reason: "La note la plus récente fait foi sur l'heure de la réunion.", evidence: { newer: "2026-10-30" }, at: end + 20, undone_at: null,
      notes: [{ name: "reunion-equipe", action: "update", before: note("Réunion d'équipe", "Le mardi à 10 h."), after: note("Réunion d'équipe", "Le mardi à 11 h (corrigée d'après la note du 30.10).") }],
    },
    {
      id: "co_archive", seq: 2, kind: "archive", scope: "user", reason: "Note périmée depuis plus de 90 jours, jamais rappelée.", evidence: { age_days: 120 }, at: end + 40, undone_at: null,
      notes: [{ name: "wifi-hotel", action: "archive", before: note("Wi-Fi de l'hôtel", "Réseau « Hotel-Guest ».", "agent"), after: null }],
    },
    {
      id: "co_lesson", seq: 3, kind: "lesson", scope: "user", reason: "Trois tours ont buté sur la même erreur.", evidence: { episodes: 3 }, at: end + 60, undone_at: null,
      notes: [{ name: "lecon-tests", action: "create", before: null, after: note("Lancer les tests avant de pousser", "Piège à éviter : pousser sans lancer les tests du paquet touché.", "agent") }],
    },
  ];
  const counts = { merge: 1, correct: 1, archive: 1, summarize: 0, lesson: 1 };
  const run: ConsolidationRun = { id, night, tz: "Europe/Zurich", trigger: "schedule", status: "done", dry_run: false, model: "flash", started_at: end - 30, finished_at: end + 70, counts, skipped: 0, undone_at: null, summary: summary(counts) };
  return {
    runs: [run],
    ops: new Map([[id, ops]]),
    settings: { enabled: true, tz: "Europe/Zurich", cron: "30 3 * * *", max_ops: 40 },
    pins: new Set(),
    notes: new Set(["rapports-lundi", "reunion-equipe", "lecon-tests"]),
    edited: new Set(["reunion-equipe"]),
  };
}
function c(state: MockState): C {
  let x = all.get(state);
  if (!x) all.set(state, (x = seed()));
  return x;
}

const err = (send: Send, status: number, code: string, message: string): true => (send(status, { error: { code, message } }), true);
const touched = (op: ConsolidationOp): string[] => op.notes.filter((n) => n.action === "update" || n.action === "create").map((n) => n.name);

export async function handleConsolidation(state: MockState, method: string, url: URL, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + "/")) return false;
  if (!state.consolidation) return err(send, 404, "not_found", "not found");
  const x = c(state);
  const now = (): number => Date.now() / 1000;
  if (path === PREFIX + "/runs" && method === "GET") {
    const lim = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 30) || 30, 100));
    return send(200, { runs: x.runs.slice(0, lim) }), true;
  }
  let m = /^\/v1\/memory\/consolidation\/runs\/([^/]+)(\/undo)?$/.exec(path);
  if (m) {
    const run = x.runs.find((r) => r.id === m![1]);
    if (!run) return err(send, 404, "not_found", "consolidation inconnue");
    const ops = x.ops.get(run.id) ?? [];
    if (!m[2] && method === "GET") return send(200, { run, ops }), true;
    if (m[2] && method === "POST") {
      const undone: string[] = [];
      const already: string[] = [];
      const conflicts: { op: string; message: string }[] = [];
      for (const op of [...ops].reverse()) {
        if (op.undone_at !== null) already.push(op.id);
        else if (touched(op).some((n) => x.edited.has(n))) conflicts.push({ op: op.id, message: `la note ${touched(op).find((n) => x.edited.has(n))} a changé depuis la consolidation` });
        else {
          op.undone_at = now();
          undone.push(op.id);
        }
      }
      if (!conflicts.length && run.undone_at === null) run.undone_at = now();
      return send(200, { run: run.id, undone, already, conflicts, complete: !conflicts.length }), true;
    }
    return false;
  }
  m = /^\/v1\/memory\/consolidation\/ops\/([^/]+)\/undo$/.exec(path);
  if (m && method === "POST") {
    const op = [...x.ops.values()].flat().find((o) => o.id === m![1]);
    if (!op) return err(send, 404, "not_found", "opération inconnue");
    if (op.undone_at !== null) return send(200, { op: op.id, undone: true, already: true }), true;
    const changed = touched(op).find((n) => x.edited.has(n));
    if (changed) return err(send, 409, "conflict", `la note ${changed} a changé depuis la consolidation`);
    op.undone_at = now();
    return send(200, { op: op.id, undone: true, already: false }), true;
  }
  if (path === PREFIX + "/run" && method === "POST") {
    const b = await readBody();
    if (b.dry_run !== undefined && typeof b.dry_run !== "boolean") return err(send, 400, "bad_body", "corps {dry_run?: bool}");
    const night = new Date().toISOString().slice(0, 10);
    const counts = { merge: 0, correct: 0, archive: 0, summarize: 0, lesson: 0 };
    const run: ConsolidationRun = { id: `cr_${Date.now().toString(16)}`, night, tz: x.settings.tz, trigger: "manual", status: "done", dry_run: b.dry_run === true, model: "flash", started_at: now(), finished_at: now(), counts, skipped: 0, undone_at: null, summary: summary(counts) };
    if (run.dry_run) return send(200, { run, ops: [] }), true;
    if (x.runs.some((r) => r.night === night && !r.dry_run)) return send(200, { status: "already", night }), true;
    x.runs.unshift(run);
    x.ops.set(run.id, []);
    return send(200, { run, ops: [] }), true;
  }
  if (path === PREFIX + "/settings") {
    if (method === "GET") return send(200, x.settings), true;
    if (method !== "PUT") return false;
    const b = await readBody();
    const enabled = b.enabled ?? x.settings.enabled;
    const tz = b.tz ?? x.settings.tz;
    const cron = b.cron ?? x.settings.cron;
    if (typeof enabled !== "boolean" || typeof tz !== "string" || typeof cron !== "string") return err(send, 400, "bad_body", "corps {enabled?: bool, tz?: fuseau, cron?: 5 champs}");
    if (cron.trim().split(/\s+/).length !== 5) return err(send, 400, "bad_schedule", "cron : 5 champs");
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
    } catch {
      return err(send, 400, "bad_schedule", `fuseau inconnu : ${tz}`);
    }
    x.settings = { ...x.settings, enabled, tz, cron };
    return send(200, x.settings), true;
  }
  if (path === PREFIX + "/pins" && method === "GET") return send(200, { pins: [...x.pins].sort() }), true;
  m = /^\/v1\/memory\/consolidation\/pins\/([a-z0-9][a-z0-9-]{1,140})$/.exec(path);
  if (m && method === "PUT") {
    const b = await readBody();
    if (typeof b.pinned !== "boolean") return err(send, 400, "bad_body", "corps {pinned: bool}");
    const name = m[1]!;
    if (b.pinned) {
      if (!x.notes.has(name)) return err(send, 404, "not_found", "note inconnue (ou d'un autre compte)");
      x.pins.add(name);
    } else x.pins.delete(name);
    return send(200, { name, pinned: b.pinned, pins: [...x.pins].sort() }), true;
  }
  return err(send, 404, "not_found", "not found");
}
