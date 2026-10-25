/**
 * Revue des écritures d'un tour, fichier par fichier : accepter (rien à faire, le fichier reste) ou refuser = revenir au
 * point de retour que le noyau a pris AVANT les écritures du tour (docs/en/checkpoints.md : un point avant le premier
 * appel non-READ de chaque tour, au plus un par tour). Pur (sans API VS Code), testé contre le mock-server.
 *
 * - Le point du tour, noyau du 25.10 (§7.4.7) : le premier `checkpoint.created {thread_id, turn_index, hash, tool}` du
 *   fil après l'envoi ; il est cherché dans `checkpoint_list` (dont les points portent `turn_index`). Noyau plus ancien
 *   (rc.6, sans l'événement) : la liste des points (`checkpoint_list`, appel direct sans tour modèle, §7.4.8) est lue
 *   AVANT l'envoi puis APRÈS le tour ; le plus ancien point apparu entre les deux est celui du tour. Aucun point
 *   nouveau : le noyau n'en a pas pris parce que rien n'avait changé depuis le précédent (le plus récent vaut donc l'état
 *   d'avant le tour). Liste « avant » illisible (409, noyau d'avant les points) : repli sur l'heure d'envoi.
 * - Refuser : `checkpoint_restore {hash, file}` par `POST /v1/local/tools/call`. L'effet est DESTRUCTIF : le noyau pose
 *   une carte FORTE (202 `{approval_id}`) que l'éditeur ne décide jamais (terminal, ou téléphone si la machine est liée) ;
 *   le résultat arrive dans `tool.result {approval_id}`. Un refus de la carte rend le fichier « à revoir ».
 * - Fichier CRÉÉ par le tour : noyau du 25.10 (il relie ses points aux tours) : `checkpoint_restore {hash, file}` le
 *   supprime lui-même après un point « avant retour » qui en garde la copie (`deleted`, `snapshot`), même carte forte.
 *   Noyau plus ancien : il ne sait pas (`git checkout <point> -- <fichier>` échoue) ; l'éditeur propose la corbeille
 *   (geste local, confirmé par l'utilisateur).
 * - Le retour d'UN fichier écrase le fichier (le mode sûr du noyau ne vaut que pour un retour du dossier entier) : si
 *   l'utilisateur l'a modifié depuis le tour, l'éditeur demande confirmation avant.
 */
import {
  NokkerApiError,
  type CheckpointInfo,
  type EditorDiff,
  type LocalEventHub,
  type LocalToolOutcome,
  type NokkerClient,
  type NokkerEvent,
} from "@nokker-apps/sdk";
import { english, strongText, type Translate } from "./i18n.js";

export type ReviewStatus = "pending" | "accepted" | "restoring" | "restored" | "failed";

export interface ReviewFile {
  relPath: string;
  /** Chemin sur la machine de l'éditeur. */
  path: string;
  /** Texte d'avant le tour (`null` : créé par le tour). */
  oldText: string | null;
  /** Texte après le tour (`""` : supprimé). */
  newText: string;
  /** Seulement le passage remplacé (fichier entier illisible). */
  fragment: boolean;
  created: boolean;
  status: ReviewStatus;
  /** Ce que l'éditeur dit à côté du statut (où attend la carte, l'erreur du noyau…). */
  note: string | null;
  /** Carte du retour en attente. */
  approvalId: string | null;
}

export interface ReviewHost {
  /** Fichier créé par le tour : le mettre à la corbeille, après confirmation (`false` : l'utilisateur renonce). */
  trashCreatedFile(path: string, relPath: string): Promise<boolean>;
  /** Contenu actuel du fichier (`null` : absent ou illisible). */
  read?(path: string): Promise<string | null>;
  /** Modifié par l'utilisateur depuis le tour : restaurer quand même ? (`false` : rien ne part). */
  confirmOverwrite?(relPath: string): Promise<boolean>;
}

/** Le point de retour du tour (voir l'en-tête). `before` : hash connus avant l'envoi, `null` si la liste n'a pas pu être
 * lue ; `after` : la liste après le tour, du plus récent au plus ancien (forme de `checkpoint_list`). */
export function pickTurnPoint(before: ReadonlySet<string> | null, after: CheckpointInfo[], sentAtMs: number): CheckpointInfo | null {
  if (before) {
    const fresh = after.filter((c) => !before.has(c.hash));
    if (fresh.length) return fresh[fresh.length - 1]!;
    return after[0] ?? null;
  }
  // Repli : `git log %aI` est à la seconde.
  const floor = Math.floor(sentAtMs / 1000) * 1000;
  const time = (c: CheckpointInfo): number => Date.parse(c.timestamp);
  const since = after.filter((c) => time(c) >= floor);
  if (since.length) return since[since.length - 1]!;
  return after.find((c) => time(c) < floor) ?? null;
}

function parseCheckpoints(outcome: LocalToolOutcome): CheckpointInfo[] | null {
  if (!("content" in outcome) || outcome.is_error) return null;
  try {
    const v = JSON.parse(outcome.content) as unknown;
    return Array.isArray(v) ? (v as CheckpointInfo[]) : null;
  } catch {
    return null;
  }
}

/** Résultat de `checkpoint_restore` (contenu JSON du noyau) → succès (`deleted`/`snapshot` pour un fichier créé depuis
 * le point, noyau du 25.10), ou l'erreur à montrer. */
export function restoreOutcome(content: string, isError: boolean): { ok: true; deleted?: boolean; snapshot?: string } | { ok: false; error: string } {
  try {
    const r = JSON.parse(content) as { success?: boolean; error?: string; deleted?: boolean; snapshot?: string };
    if (r.success && !isError) return { ok: true, ...(typeof r.deleted === "boolean" ? { deleted: r.deleted } : {}), ...(r.snapshot ? { snapshot: r.snapshot } : {}) };
    return { ok: false, error: r.error ?? content };
  } catch {
    return isError ? { ok: false, error: content } : { ok: true };
  }
}

export class TurnReview {
  private files = new Map<string, ReviewFile>();
  private before: Set<string> | null = null;
  private sentAt = 0;
  private point: CheckpointInfo | null = null;
  private pointRead = false;
  /** Premier `checkpoint.created` du fil après l'envoi (noyau du 25.10). */
  private announced: { hash: string; turn_index: number; tool: string } | null = null;
  /** Le noyau relie ses points aux tours (événement vu, ou `turn_index` dans la liste) : il sait supprimer un fichier
   * créé depuis le point. */
  private linked = false;
  private unlisten: (() => void) | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private readonly client: NokkerClient,
    private readonly hub: LocalEventHub,
    readonly threadId: string,
    private readonly host: ReviewHost,
    private readonly t: Translate = english,
  ) {
    this.unlisten = this.hub.listen(threadId, (e) => this.onEvent(e));
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Avant l'envoi : les points connus (best effort, borné). */
  async begin(timeoutMs = 3000): Promise<void> {
    this.sentAt = Date.now();
    const list = await Promise.race([this.listPoints(), new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
    this.before = list ? new Set(list.map((c) => c.hash)) : null;
    if (list?.some((c) => typeof c.turn_index === "number")) this.linked = true;
    this.announced = null;
    this.sentAt = Date.now();
  }

  /** Une écriture du tour (diff calculé par la session). Le même fichier écrit deux fois : l'avant reste le premier. */
  record(d: EditorDiff): void {
    const prev = this.files.get(d.relPath);
    if (prev) {
      prev.newText = d.newText;
      prev.fragment = prev.fragment && d.fragment;
    } else {
      this.files.set(d.relPath, {
        relPath: d.relPath,
        path: d.path,
        oldText: d.oldText,
        newText: d.newText,
        fragment: d.fragment,
        created: d.oldText === null,
        status: "pending",
        note: null,
        approvalId: null,
      });
    }
    this.changed();
  }

  /** Fichiers de la revue, dans l'ordre d'écriture. */
  list(): ReviewFile[] {
    return [...this.files.values()];
  }

  get(relPath: string): ReviewFile | undefined {
    return this.files.get(relPath);
  }

  get pending(): number {
    return this.list().filter((f) => f.status === "pending" || f.status === "failed").length;
  }

  /** Le point du tour, lu une fois après le tour (tant qu'il n'est pas trouvé, relu au premier refus). */
  async resolvePoint(): Promise<CheckpointInfo | null> {
    if (this.pointRead && this.point) return this.point;
    const after = await this.listPoints();
    if (after?.some((c) => typeof c.turn_index === "number")) this.linked = true;
    const ann = this.announced;
    if (ann) {
      // Le point annoncé par le noyau ; absent de la liste (illisible) : sa forme minimale suffit au retour.
      this.point = after?.find((c) => c.hash === ann.hash) ?? { hash: ann.hash, short_hash: ann.hash.slice(0, 8), timestamp: "", reason: "", files_changed: 0, thread_id: this.threadId, turn_index: ann.turn_index, tool: ann.tool };
      this.pointRead = true;
    } else if (after) {
      this.point = pickTurnPoint(this.before, after, this.sentAt);
      this.pointRead = true;
    }
    return this.point;
  }

  accept(relPath: string): void {
    const f = this.files.get(relPath);
    if (!f || (f.status !== "pending" && f.status !== "failed")) return;
    f.status = "accepted";
    f.note = null;
    this.changed();
  }

  acceptAll(): void {
    for (const f of this.files.values()) if (f.status === "pending" || f.status === "failed") {
      f.status = "accepted";
      f.note = null;
    }
    this.changed();
  }

  /** Refuser un fichier : retour au point du tour (carte forte du noyau), ou corbeille pour un fichier créé. */
  async refuse(relPath: string): Promise<ReviewStatus | null> {
    const f = this.files.get(relPath);
    if (!f || (f.status !== "pending" && f.status !== "failed")) return f?.status ?? null;
    const t = this.t;
    if (f.created && !this.linked) await this.resolvePoint().catch(() => null); // apprend si le noyau sait supprimer
    if (f.created && !this.linked) {
      const trashed = await this.host.trashCreatedFile(f.path, f.relPath);
      this.set(f, trashed ? "restored" : "pending", trashed ? t("Moved to the trash (created by this turn).") : null);
      return f.status;
    }
    if (!f.fragment && this.host.read) {
      const now = await this.host.read(f.path);
      if (now !== null && now !== f.newText && !(await (this.host.confirmOverwrite?.(f.relPath) ?? Promise.resolve(false)))) {
        this.set(f, "pending", t("Changed since the turn: not restored."));
        return f.status;
      }
    }
    this.set(f, "restoring", t("Looking for the restore point…"));
    let point: CheckpointInfo | null;
    try {
      point = await this.resolvePoint();
    } catch {
      point = null;
    }
    if (!point) {
      this.set(f, "failed", t("No restore point of the kernel for this turn."));
      return f.status;
    }
    let out: LocalToolOutcome;
    try {
      out = await this.client.callLocalTool(this.threadId, "checkpoint_restore", { hash: point.hash, file: f.relPath });
    } catch (err) {
      const busy = err instanceof NokkerApiError && err.status === 409;
      this.set(f, "failed", busy ? t("A turn is running on this session: try again when it ends.") : t("Restore failed: {0}", err instanceof Error ? err.message : String(err)));
      return f.status;
    }
    if ("approval_id" in out) {
      f.approvalId = out.approval_id;
      // Carte FORTE (destructif) : jamais décidée ici. Le texte dit où elle attend ; `approval.forwarded` le met à jour.
      let forwarded = false;
      try {
        forwarded = (await this.client.listLocalApprovals()).some((a) => a.id === out.approval_id && a.forwarded === true);
      } catch {
        // liste illisible : « au terminal » par défaut
      }
      if (f.approvalId === out.approval_id) this.set(f, "restoring", strongText(t, { forwarded }));
      return f.status;
    }
    this.apply(f, out.content, out.is_error);
    return f.status;
  }

  dispose(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.listeners.clear();
  }

  private async listPoints(): Promise<CheckpointInfo[] | null> {
    try {
      return parseCheckpoints(await this.client.callLocalTool(this.threadId, "checkpoint_list"));
    } catch {
      return null;
    }
  }

  private apply(f: ReviewFile, content: string, isError: boolean): void {
    const r = restoreOutcome(content, isError);
    f.approvalId = null;
    if (!r.ok) this.set(f, "failed", this.t("Restore failed: {0}", r.error));
    else if (r.deleted === true) this.set(f, "restored", this.t("Deleted (created by this turn); a copy stays in restore point {0}.", (r.snapshot ?? "").slice(0, 8)));
    else if (r.deleted === false) this.set(f, "restored", this.t("Already absent: nothing to delete."));
    else this.set(f, "restored", this.t("Restored from the restore point of the turn."));
  }

  private byApproval(id: string): ReviewFile | undefined {
    return [...this.files.values()].find((f) => f.approvalId === id);
  }

  private onEvent(e: NokkerEvent): void {
    if (e.type === "checkpoint.created") {
      this.linked = true;
      // Le premier point du fil après l'envoi est celui d'avant les écritures du tour (pas ceux de ses sous-agents).
      if (e.thread_id === this.threadId && this.sentAt && !this.announced && !this.pointRead) this.announced = { hash: e.hash, turn_index: e.turn_index, tool: e.tool };
      return;
    }
    if (e.type === "tool.result" && e.approval_id && !e.call_id) {
      const f = this.byApproval(e.approval_id);
      if (f) this.apply(f, (e as { content?: string }).content ?? e.preview ?? "", e.is_error === true || e.ok === false);
    } else if (e.type === "approval.decided") {
      const f = this.byApproval(e.approval_id);
      if (f && e.decision !== "approved" && e.decision !== "executed") {
        f.approvalId = null;
        this.set(f, "pending", e.decision === "expired" ? this.t("Restore card expired: file kept.") : this.t("Restore refused: file kept."));
      }
    } else if (e.type === "approval.forwarded") {
      const f = this.byApproval(e.approval_id);
      if (f && f.status === "restoring") this.set(f, "restoring", strongText(this.t, { forwarded: true }));
    }
  }

  private set(f: ReviewFile, status: ReviewStatus, note: string | null): void {
    f.status = status;
    f.note = note;
    this.changed();
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }
}
