/**
 * Logique de l'extension, SANS l'API VS Code (testée contre le mock-server) : connexion au noyau local, session du
 * dossier ouvert (ou reprise d'une autre session du dossier), tours, outils, cartes d'approbation, diffs, revue des
 * écritures du tour, écriture en direct, coût, pièces de contexte, barre d'état, liste des sessions. `extension.ts` n'en
 * est que le branchement (webview, vues, commandes, diff natif, notifications).
 */
import {
  EditorSession,
  LocalEventHub,
  NokkerApiError,
  NokkerClient,
  type CostLang,
  type EditorApprovalCard,
  type EditorDiff,
  type EditorFs,
  type EditorSink,
  type EditorToolCall,
  type NokkerEvent,
  type TurnCostEvent,
} from "@nokker-apps/sdk";
import { toolTarget } from "@nokker-apps/cli/src/toolview.js";
import type { ToView, ViewCard, ViewLive, ViewTool } from "./protocol.js";
import { composeMessage, contextLabel, type ContextItem, type NewContextItem } from "./context.js";
import { choiceLabel, editorTexts, effectLabel, english, strongText, type Translate } from "./i18n.js";
import { readLocalToken } from "./connection.js";
import { LiveWrites, livePath, type LiveView } from "./live.js";
import { TurnReview } from "./review.js";
import { SessionsModel } from "./sessions.js";
import { EMPTY_STATUS, costOf, mainModel, type StatusInfo } from "./status.js";

export { imageMentions } from "./context.js";

export interface StoredDiff extends EditorDiff {
  id: string;
}

export interface ControllerHost {
  post(msg: ToView): void;
  openDiff(diff: StoredDiff): Promise<void>;
  /** Une carte attend une décision (le panneau est peut-être caché). */
  cardAlert?(card: ViewCard): void;
  log?(level: "info" | "warn" | "error", msg: string): void;
  /** Écriture en direct : un bloc a changé (éditeur en lecture seule). */
  live?(v: LiveView): void;
  status?(s: StatusInfo): void;
  /** La revue du tour a changé (nouvelle revue, statut d'un fichier). */
  reviewChanged?(): void;
  /** La liste des sessions a changé. */
  sessionsChanged?(): void;
  /** Fichier créé par le tour, refusé : le mettre à la corbeille après confirmation. */
  trashCreatedFile?(path: string, relPath: string): Promise<boolean>;
  /** Fichier modifié par l'utilisateur depuis le tour : le restaurer quand même (écrase ses modifications) ? */
  confirmOverwrite?(relPath: string): Promise<boolean>;
}

export interface ControllerOptions {
  serverUrl: string;
  folder: string | null;
  fs: EditorFs;
  userAgent?: string;
  /** Traduction (`vscode.l10n.t` dans l'extension ; anglais par défaut). */
  t?: Translate;
  /** Langue des montants et des jetons. */
  lang?: CostLang;
  /** Dossiers ouverts dans la fenêtre (vue Sessions) ; défaut : `folder`. */
  folders?: () => string[];
}

const TRANSCRIPT_MAX = 2000;

export class ChatController {
  private client: NokkerClient | null = null;
  private hub: LocalEventHub | null = null;
  private session: EditorSession | null = null;
  private unlistenThread: (() => void) | null = null;
  private cards = new Map<string, EditorApprovalCard>();
  private diffs = new Map<string, StoredDiff>();
  private contexts: ContextItem[] = [];
  private transcript: ToView[] = [];
  private error: string | null = null;
  private nextDiff = 1;
  private nextContext = 1;
  private folderNow: string | null;
  private liveWrites: LiveWrites;
  private reviewNow: TurnReview | null = null;
  private sessionsModel: SessionsModel | null = null;
  private statusNow: StatusInfo = { ...EMPTY_STATUS };
  /** Palier par tour (`turn.done.tier`) : il peut arriver avant ou après le coût du tour. */
  private tiers = new Map<string, string>();
  private readonly t: Translate;
  private readonly lang: CostLang;

  constructor(
    private readonly host: ControllerHost,
    private readonly opts: ControllerOptions,
  ) {
    this.t = opts.t ?? english;
    this.lang = opts.lang ?? "en";
    this.folderNow = opts.folder;
    this.liveWrites = new LiveWrites((v) => {
      this.host.live?.(v);
      this.emit({ type: "live", live: this.viewLive(v) });
    });
  }

  get threadId(): string | null {
    return this.session?.threadId ?? null;
  }

  get busy(): boolean {
    return this.session?.busy ?? false;
  }

  /** Dossier de la session affichée (celui de l'espace de travail, ou celui d'une session reprise). */
  get folder(): string | null {
    return this.folderNow;
  }

  get review(): TurnReview | null {
    return this.reviewNow;
  }

  get sessions(): SessionsModel | null {
    return this.sessionsModel;
  }

  get status(): StatusInfo {
    return this.statusNow;
  }

  get live(): LiveWrites {
    return this.liveWrites;
  }

  /** Contexte en attente, pour l'affichage et les tests. */
  contextLabels(): string[] {
    return this.contexts.map((c) => contextLabel(c, this.t));
  }

  contextItems(): ContextItem[] {
    return [...this.contexts];
  }

  /** Diffs connus du fil affiché (ordre d'arrivée). */
  knownDiffs(): StoredDiff[] {
    return [...this.diffs.values()];
  }

  /** Ouvre la session du dossier : reprend son fil le plus récent (comme `nokker` dans un terminal), sinon un fil neuf ;
   * `threadId` : reprend cette session-là (vue Sessions), dans son dossier `cwd`. */
  async connect(opts: { resume?: boolean; threadId?: string; cwd?: string } = {}): Promise<boolean> {
    this.error = null;
    const folder = opts.cwd ?? this.opts.folder;
    if (!folder) {
      this.error = this.t("Open a folder: Nokker works on the folder of the workspace.");
      this.postState();
      return false;
    }
    const tok = await readLocalToken(this.opts.serverUrl, this.t);
    if ("error" in tok) {
      this.error = tok.error;
      this.postState();
      return false;
    }
    try {
      this.closeSession();
      if (!this.client || !this.hub) {
        this.client = new NokkerClient({ baseUrl: this.opts.serverUrl, token: tok.token, userAgent: this.opts.userAgent ?? "nokker-vscode/0.1" });
        this.hub = new LocalEventHub(this.client, (err) => this.host.log?.("warn", `events: ${String(err)}`));
        this.sessionsModel = new SessionsModel(this.client, this.hub, {
          folders: () => this.opts.folders?.() ?? (this.opts.folder ? [this.opts.folder] : []),
          current: () => this.threadId,
          lang: this.lang,
        });
        this.sessionsModel.onChange(() => this.host.sessionsChanged?.());
      } else {
        this.client.setToken(tok.token);
      }
      const hub = this.hub;
      this.session = await EditorSession.open(this.client, hub, folder, this.opts.fs, {
        resume: opts.resume !== false,
        texts: editorTexts(this.t),
        ...(opts.threadId ? { threadId: opts.threadId } : {}),
      });
      this.folderNow = folder;
      await hub.ready();
      const threadId = this.session.threadId;
      this.unlistenThread = hub.listen(threadId, (e) => this.onThreadEvent(e));
      this.resetTranscript();
      const history = await this.session.history();
      if (history.length) this.emit({ type: "history", messages: history.map((m) => ({ role: m.role, text: m.content })) });
      // Une carte restée ouverte (tour en cours dans un autre client) : reprise par l'API.
      this.session.setSink(this.sink());
      await this.session.refreshApprovals();
      this.statusNow = { ...EMPTY_STATUS, cards: this.cards.size };
      this.postState();
      void this.sessionsModel?.refresh();
      this.host.log?.("info", `session ${threadId} on ${folder}`);
      return true;
    } catch (err) {
      this.error = this.errorText(err);
      this.session = null;
      this.postState();
      return false;
    }
  }

  /** Nouveau fil sur le dossier de l'espace de travail (`POST /v1/local/sessions`). */
  async newThread(): Promise<boolean> {
    if (this.busy) {
      this.emit({ type: "error", text: this.t("A turn is running: stop it first.") });
      return false;
    }
    return this.connect({ resume: false });
  }

  /** Reprend une session du noyau (vue Sessions) dans son propre dossier. */
  async openSession(threadId: string, cwd: string): Promise<boolean> {
    if (threadId === this.threadId) return true;
    if (this.busy) {
      this.emit({ type: "error", text: this.t("A turn is running: stop it first.") });
      return false;
    }
    return this.connect({ threadId, cwd });
  }

  /** Le panneau (re)chargé rejoue ce qui a été affiché depuis la connexion. */
  replay(): void {
    for (const m of this.transcript) this.host.post(m);
    this.postState();
    this.postContext();
  }

  addContext(c: NewContextItem): void {
    this.contexts.push({ ...c, id: `ctx${this.nextContext++}` } as ContextItem);
    this.postContext();
  }

  /** « Envoyer la sélection ». */
  addSelection(c: Omit<Extract<NewContextItem, { kind: "selection" }>, "kind">): void {
    this.addContext({ kind: "selection", ...c });
  }

  removeContext(id: string): void {
    this.contexts = this.contexts.filter((c) => c.id !== id);
    this.postContext();
  }

  /** Pré-remplit la zone de saisie (« corrige ça » depuis une quick fix) sans envoyer. */
  prefill(text: string): void {
    this.host.post({ type: "prefill", text });
  }

  /** Un tour. Les pièces de contexte partent avec ce message puis sont retirées. */
  async send(text: string): Promise<void> {
    const typed = text.trim();
    if (!typed) return;
    if (!this.session && !(await this.connect())) return;
    const session = this.session!;
    if (session.busy) {
      this.emit({ type: "error", text: this.t("A turn is already running.") });
      return;
    }
    const contexts = this.contexts;
    this.contexts = [];
    this.postContext();
    this.emit({ type: "user", text: typed, context: contexts.map((c) => contextLabel(c, this.t)) });
    this.postState(true);
    this.setStatus({ busy: true });
    // Revue du tour : les points connus avant l'envoi (le point du tour sera le premier qui apparaît).
    this.startReview(session.threadId);
    const review = this.reviewNow;
    try {
      await review?.begin();
      const { text: message, attachments } = composeMessage(typed, contexts, this.t);
      const out = await session.prompt(message, this.sink(), attachments.length ? { attachments } : {});
      this.emit({ type: "turnEnd", stopReason: out.stopReason });
    } catch (err) {
      this.emit({ type: "error", text: this.errorText(err) });
      this.emit({ type: "turnEnd", stopReason: "error" });
    } finally {
      this.postState();
      this.setStatus({ busy: false, cards: this.cards.size });
      if (review && review === this.reviewNow && review.list().length) {
        await review.resolvePoint().catch(() => null);
        this.postReview();
      }
    }
  }

  async cancel(): Promise<void> {
    await this.session?.cancel();
  }

  /** Décision d'une carte (bouton du panneau ou de la notification). Une carte forte n'a pas de choix : rien ne part. */
  async decide(id: string, index: number): Promise<void> {
    const card = this.cards.get(id);
    const choice = card?.choices?.[index];
    if (!card || !choice || !this.session) return;
    try {
      await this.session.decide(id, choice);
    } catch (err) {
      this.emit({ type: "error", text: this.t("Decision: {0}", this.errorText(err)) });
    }
  }

  /** Cartes ouvertes de la session affichée, telles que le panneau les montre. */
  openCards(): ViewCard[] {
    return [...this.cards.values()].map((c) => this.viewCard(c));
  }

  async openDiff(id: string): Promise<void> {
    const d = this.diffs.get(id);
    if (d) await this.host.openDiff(d);
  }

  /** Coupe la session affichée (pas la connexion au noyau ni la vue Sessions). */
  closeSession(): void {
    this.unlistenThread?.();
    this.unlistenThread = null;
    this.session?.dispose();
    this.session = null;
    this.cards.clear();
    if (this.reviewNow) {
      this.reviewNow.dispose();
      this.reviewNow = null;
      this.host.reviewChanged?.();
    }
  }

  dispose(): void {
    this.closeSession();
    this.sessionsModel?.dispose();
    this.sessionsModel = null;
    this.hub?.close();
    this.hub = null;
    this.client = null;
  }

  private startReview(threadId: string): void {
    this.reviewNow?.dispose();
    this.reviewNow = null;
    if (!this.client || !this.hub) return;
    const review = new TurnReview(
      this.client,
      this.hub,
      threadId,
      {
        trashCreatedFile: (p, rel) => this.host.trashCreatedFile?.(p, rel) ?? Promise.resolve(false),
        read: (p) => this.opts.fs.read(p),
        confirmOverwrite: (rel) => this.host.confirmOverwrite?.(rel) ?? Promise.resolve(false),
      },
      this.t,
    );
    review.onChange(() => {
      if (review !== this.reviewNow) return;
      this.postReview();
      this.host.reviewChanged?.();
    });
    this.reviewNow = review;
    this.host.reviewChanged?.();
  }

  private postReview(): void {
    const r = this.reviewNow;
    if (!r || !r.list().length) return;
    this.host.post({ type: "review", files: r.list().length, pending: r.pending });
  }

  private onThreadEvent(e: NokkerEvent): void {
    this.liveWrites.apply(e);
    if (e.type === "turn.done" && e.thread_id === this.threadId && e.tier) {
      this.tiers.set(e.turn_id, e.tier);
      this.setStatus({ tier: e.tier });
    }
  }

  private viewLive(v: LiveView): ViewLive {
    return { callId: v.callId, name: v.name, path: livePath(v.path), tail: this.liveWrites.tail(v.callId), truncated: v.truncated, done: v.done, discarded: v.discarded };
  }

  private setStatus(patch: Partial<StatusInfo>): void {
    this.statusNow = { ...this.statusNow, ...patch, connected: this.session !== null, error: this.error };
    this.host.status?.(this.statusNow);
  }

  private postContext(): void {
    this.host.post({ type: "context", items: this.contexts.map((x) => ({ id: x.id, label: contextLabel(x, this.t) })) });
  }

  private errorText(err: unknown): string {
    const t = this.t;
    if (err instanceof NokkerApiError) {
      let msg = err.serverMessage;
      if (typeof err.body === "string") {
        try {
          msg = (JSON.parse(err.body) as { error?: { message?: string } }).error?.message ?? msg;
        } catch {
          // corps non JSON
        }
      }
      if (err.status === 401) return t("local token refused by the kernel (nokker doctor)");
      if (err.status === 403) return t("folder outside the roots declared to Lokkal ({0})", msg);
      return msg;
    }
    const m = err instanceof Error ? err.message : String(err);
    return /fetch failed|ECONNREFUSED|ENOTFOUND/.test(m) ? t("kernel unreachable: is Lokkal running? (nokker doctor)") : m;
  }

  private resetTranscript(): void {
    this.transcript = [];
    this.diffs.clear();
    this.cards.clear();
    this.liveWrites.clear();
    this.tiers.clear();
    this.host.post({ type: "history", messages: [] });
  }

  private emit(m: ToView): void {
    this.transcript.push(m);
    if (this.transcript.length > TRANSCRIPT_MAX) this.transcript.splice(0, this.transcript.length - TRANSCRIPT_MAX);
    this.host.post(m);
  }

  private postState(busy = this.busy): void {
    this.host.post({
      type: "state",
      connected: this.session !== null,
      busy,
      folder: this.folderNow,
      server: this.opts.serverUrl,
      threadId: this.threadId,
      error: this.error,
    });
    this.setStatus({});
  }

  private viewTool(t: EditorToolCall): ViewTool {
    const diffs = t.diffs.map((d) => {
      const id = `d${this.nextDiff++}`;
      this.diffs.set(id, { ...d, id });
      return { id, relPath: d.relPath, fragment: d.fragment, created: d.oldText === null };
    });
    return {
      callId: t.callId,
      name: t.name,
      target: toolTarget(t.name, t.args),
      effect: t.effect ? effectLabel(this.t, t.effect) : null,
      status: t.status,
      preview: t.preview,
      ms: t.ms,
      depth: t.depth,
      diffs,
    };
  }

  private viewCard(card: EditorApprovalCard): ViewCard {
    const a = card.approval;
    return {
      id: a.id,
      tool: a.tool_name,
      target: toolTarget(a.tool_name, a.arguments),
      effect: effectLabel(this.t, a.effect),
      reason: a.reason,
      choices: card.choices
        ? card.choices.map((c, index) => ({ index, id: c.id, key: c.key, label: choiceLabel(this.t, c, a.tool_name), ...(c.rule ? { rule: c.rule } : {}) }))
        : null,
      forwarded: card.forwarded,
      strongText: card.choices ? null : strongText(this.t, card),
      expiresAt: a.expires_at,
    };
  }

  private sink(): EditorSink {
    return {
      onText: (append: string) => this.emit({ type: "text", append }),
      onTextReplace: (text: string) => this.emit({ type: "textReplace", text }),
      onToolStart: (t: EditorToolCall) => this.emit({ type: "tool", tool: this.viewTool(t) }),
      onToolEnd: (t: EditorToolCall) => {
        if (t.status === "completed") for (const d of t.diffs) this.reviewNow?.record(d);
        this.emit({ type: "tool", tool: this.viewTool(t) });
      },
      onApproval: (card: EditorApprovalCard) => {
        this.cards.set(card.approval.id, card);
        const view = this.viewCard(card);
        this.emit({ type: "card", card: view });
        this.setStatus({ cards: this.cards.size });
        this.host.cardAlert?.(view);
      },
      // Carte forte déposée chez nokker.ai après coup : « au terminal » devient « attend ton téléphone ».
      onApprovalUpdate: (card: EditorApprovalCard) => {
        if (!this.cards.has(card.approval.id)) return;
        this.cards.set(card.approval.id, card);
        this.emit({ type: "card", card: this.viewCard(card) });
      },
      onApprovalClosed: (id: string, status: string) => {
        this.cards.delete(id);
        this.emit({ type: "cardClosed", id, status });
        this.setStatus({ cards: this.cards.size });
      },
      onCost: (c: TurnCostEvent) => {
        const line = costOf(c, this.lang);
        const main = mainModel(c);
        this.emit({ type: "cost", line });
        this.setStatus({ turnCost: line, model: main.model ?? this.statusNow.model, tier: this.tiers.get(c.turn_id) ?? main.tier ?? this.statusNow.tier });
      },
      onNotice: (text: string) => this.emit({ type: "notice", text }),
    };
  }
}
