/**
 * Folder mode — mock of core docs/FOLDER-MODE.md §6 (shapes of nokker/folder/run.py `FolderRun.view`, routes of
 * nokker/local/api.py `_folder`). Flag `local.folder_mode` off by default like the core: option `folder` or
 * `MOCK_FOLDER=1`, else 404. Local token only (another caller: 401, like the other local routes of this mock).
 *
 * The mock NEVER writes to disk: it lists the folder (read-only) to build a plan « sort the files by type » and then
 * plays the execution step by step. An in-place run asks `confirm_in_place`; undoing an in-place run reports one
 * conflict (a file changed since) unless `force`. A task containing « échec » / « fail » fails during the plan.
 */
import { readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { FolderRun, FolderStep } from "@nokker-apps/sdk";
import { rootFor } from "./local.js";
import { LOCAL_OWNER, randomId, type MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;
const PREFIX = "/v1/local/folder/runs";
const all = new WeakMap<MockState, Map<string, FolderRun>>();
const runsOf = (s: MockState): Map<string, FolderRun> => {
  let m = all.get(s);
  if (!m) all.set(s, (m = new Map()));
  return m;
};
const err = (send: Send, status: number, code: string, message: string): true => (send(status, { error: { message, code } }), true);

function card(run: FolderRun): FolderRun["card"] {
  if (run.status !== "awaiting_approval") return null;
  return {
    kind: "folder_run",
    strength: run.in_place ? "strong" : "standard",
    in_place: run.in_place,
    text: run.in_place
      ? "Valider ce plan modifiera le dossier lui-même. Un point de retour est pris avant la première écriture : tout peut être défait."
      : "Valider ce plan écrira seulement dans le dossier de sortie ; le dossier reste intact.",
  };
}
const view = (run: FolderRun): FolderRun => ({ ...run, card: card(run) });

function planFor(path: string, inPlace: boolean): FolderStep[] {
  let names: string[] = [];
  try {
    names = readdirSync(path).filter((n) => !n.startsWith(".") && statSync(join(path, n)).isFile()).sort().slice(0, 6);
  } catch {
    names = [];
  }
  const steps: FolderStep[] = names.map((n) => {
    const kind = (extname(n).slice(1) || "autres").toLowerCase();
    return inPlace
      ? { action: "deplacer", chemin: `dossier/${n}`, vers: `dossier/${kind}/${n}`, pourquoi: `rangé avec les fichiers .${kind}` }
      : { action: "copier", chemin: `dossier/${n}`, vers: `sortie/${kind}/${n}`, pourquoi: `rangé avec les fichiers .${kind}` };
  });
  steps.push({ action: "ecrire", chemin: inPlace ? "dossier/INDEX.md" : "sortie/INDEX.md", pourquoi: "sommaire du rangement" });
  return steps;
}

function play(state: MockState, run: FolderRun, i: number): void {
  if (run.status !== "running") return;
  const steps = run.plan?.etapes ?? [];
  if (i >= steps.length) {
    run.status = "done";
    const trash = steps.some((s) => s.action === "corbeille");
    run.report = {
      fichiers_touches: steps.map((s) => ({ action: s.action, chemin: s.chemin, ...(s.vers ? { vers: s.vers } : {}) })),
      etapes_non_faites: [],
      point_de_retour: true,
      corbeille: trash ? `dossier/.corbeille-nokker/${run.run_id}/` : null,
      resume_modele: `J'ai rangé ${steps.length - 1} fichier(s) par type et écrit un sommaire.`,
    };
    return;
  }
  run.steps[i] = "fait";
  state.later(250, () => play(state, run, i + 1));
}

export async function handleFolder(state: MockState, user: string | null, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  const bare = path.split("?", 1)[0]!.replace(/\/$/, "");
  if (bare !== PREFIX && !bare.startsWith(PREFIX + "/")) return false;
  if (!state.folder) return err(send, 404, "not_found", "not found");
  if (user !== LOCAL_OWNER) return err(send, 401, "local_token", "jeton local requis");
  const runs = runsOf(state);
  const b = method === "POST" ? await readBody() : {};
  if (bare === PREFIX) {
    if (method === "GET") return send(200, { runs: [...runs.values()].reverse().map((r) => ({ run_id: r.run_id, status: r.status, path: r.path, in_place: r.in_place, task: r.task, created_at: r.created_at })) }), true;
    if (method !== "POST") return err(send, 405, "bad_method", "GET ou POST");
    const folder = typeof b.path === "string" ? b.path : "";
    const task = b.task;
    if (!folder || typeof task !== "string" || !task.trim()) return err(send, 400, "bad_body", "path et task requis");
    const real = resolve(folder);
    let isDir = false;
    try {
      isDir = statSync(real).isDirectory();
    } catch {
      isDir = false;
    }
    if (!rootFor(real, state.localRoots) || !isDir) return err(send, 403, "outside_roots", "dossier hors des racines déclarées");
    const out = typeof b.out === "string" && b.out ? resolve(b.out) : `${real}-nokker`;
    if (!rootFor(out, state.localRoots)) return err(send, 403, "outside_roots", "sortie hors des racines déclarées");
    const inPlace = b.in_place === true;
    const id = randomId("fr");
    const run: FolderRun = { run_id: id, thread_id: `folder-${id}`, status: "planning", path: real, out: inPlace ? null : out, in_place: inPlace, task, plan: null, steps: [], plan_reply: "", card: null, report: null, error: null, undo: null, created_at: Date.now() / 1000 };
    runs.set(id, run);
    state.later(600, () => {
      if (/echec|échec|fail/i.test(task)) {
        run.status = "failed";
        run.error = "le modèle n'a pas rendu de plan";
        return;
      }
      const etapes = planFor(real, inPlace);
      run.plan = { resume: `Ranger les fichiers par type (${etapes.length - 1} fichier(s)) et écrire un sommaire.`, etapes };
      run.steps = etapes.map(() => "en attente");
      run.plan_reply = run.plan.resume;
      run.status = "awaiting_approval";
    });
    return send(202, view(run)), true;
  }
  const [id, action = ""] = bare.slice(PREFIX.length + 1).split("/", 2);
  const run = runs.get(id!);
  if (!run) return err(send, 404, "not_found", "passage inconnu");
  if (!action && method === "GET") return send(200, view(run)), true;
  if (action === "decide" && method === "POST") {
    if (b.decision !== "approve" && b.decision !== "reject") return err(send, 400, "bad_body", "decision ∈ approve, reject");
    if (run.status !== "awaiting_approval") return err(send, 409, "not_pending", `passage ${run.status} : rien à valider`);
    if (b.decision === "approve" && run.in_place && b.confirm_in_place !== true) return err(send, 400, "confirm_in_place", "passage en place : confirm_in_place: true requis");
    if (b.decision === "reject") {
      run.status = "refused";
      return send(200, view(run)), true;
    }
    run.status = "running";
    state.later(300, () => play(state, run, 0));
    return send(202, view(run)), true;
  }
  if (action === "undo" && method === "POST") {
    if (run.status === "planning" || run.status === "running") return err(send, 409, "busy", `passage ${run.status} : attends sa fin`);
    const touched = (run.report?.fichiers_touches ?? []).map((t) => t.vers ?? t.chemin);
    const conflicts = run.in_place && b.force !== true && touched.length ? [{ path: touched[0]!, why: "modifié depuis le passage" }] : [];
    run.undo = { restored: touched.filter((p) => !conflicts.some((c) => c.path === p)), conflicts, parked: b.force === true && run.in_place ? [`annules/${touched[0] ?? ""}`] : [], exact: !conflicts.length, differences: [] };
    if (!conflicts.length) run.status = "undone";
    return send(200, view(run)), true;
  }
  return err(send, 404, "not_found", "route inconnue");
}
