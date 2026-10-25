/**
 * Logique du panneau, SANS l'API VS Code (testée contre le mock-server) : connexion au noyau local, session du dossier
 * ouvert, tours, outils, cartes d'approbation, diffs, coût, contexte de sélection. `extension.ts` n'en est que le
 * branchement (webview, commandes, diff natif).
 */
import {
  EditorSession,
  LocalEventHub,
  NokkerApiError,
  NokkerClient,
  formatCostLine,
  strongCardText,
  type ChatAttachment,
  type EditorApprovalCard,
  type EditorDiff,
  type EditorFs,
  type EditorToolCall,
} from "@nokker-apps/sdk";
import { EFFECT_LABEL, toolTarget } from "@nokker-apps/cli/src/toolview.js";
import type { ToView, ViewCard, ViewTool } from "./protocol.js";
import { composeMessage, contextLabel, type SelectionContext } from "./selection.js";
import { readLocalToken } from "./connection.js";

export interface StoredDiff extends EditorDiff {
  id: string;
}

export interface ControllerHost {
  post(msg: ToView): void;
  openDiff(diff: StoredDiff): Promise<void>;
  /** Une carte attend une décision (le panneau est peut-être caché). */
  cardAlert?(card: ViewCard): void;
  log?(level: "info" | "warn" | "error", msg: string): void;
}

export interface ControllerOptions {
  serverUrl: string;
  folder: string | null;
  fs: EditorFs;
  userAgent?: string;
}

/** Images citées dans le texte (`@capture.png`) : le noyau les lit dans le dossier de la session (LOKKAL.md §7.6). */
export function imageMentions(text: string): ChatAttachment[] {
  const out: ChatAttachment[] = [];
  for (const m of text.matchAll(/(?:^|\s)@([\w./-]+\.(?:png|jpe?g|webp|gif))(?=\s|$|[,;:!?)])/gi)) {
    if (!m[1]!.split("/").includes("..")) out.push({ path: m[1]! });
  }
  return out.slice(0, 4);
}

function errorText(err: unknown): string {
  if (err instanceof NokkerApiError) {
    let msg = err.serverMessage;
    if (typeof err.body === "string") {
      try {
        msg = (JSON.parse(err.body) as { error?: { message?: string } }).error?.message ?? msg;
      } catch {
        // corps non JSON
      }
    }
    if (err.status === 401) return "jeton local refusé par le noyau (nokker doctor)";
    if (err.status === 403) return `dossier hors des racines déclarées de Lokkal (${msg})`;
    return msg;
  }
  const m = err instanceof Error ? err.message : String(err);
  return /fetch failed|ECONNREFUSED|ENOTFOUND/.test(m) ? "noyau injoignable : Lokkal tourne-t-il ? (nokker doctor)" : m;
}

const TRANSCRIPT_MAX = 2000;

export class ChatController {
  private client: NokkerClient | null = null;
  private hub: LocalEventHub | null = null;
  private session: EditorSession | null = null;
  private cards = new Map<string, EditorApprovalCard>();
  private diffs = new Map<string, StoredDiff>();
  private contexts: SelectionContext[] = [];
  private transcript: ToView[] = [];
  private error: string | null = null;
  private nextDiff = 1;
  private nextContext = 1;

  constructor(
    private readonly host: ControllerHost,
    private readonly opts: ControllerOptions,
  ) {}

  get threadId(): string | null {
    return this.session?.threadId ?? null;
  }

  get busy(): boolean {
    return this.session?.busy ?? false;
  }

  get folder(): string | null {
    return this.opts.folder;
  }

  /** Contexte en attente (sélections), pour l'affichage et les tests. */
  contextLabels(): string[] {
    return this.contexts.map(contextLabel);
  }

  /** Diffs connus du fil affiché (ordre d'arrivée). */
  knownDiffs(): StoredDiff[] {
    return [...this.diffs.values()];
  }

  /** Ouvre la session du dossier : reprend son fil le plus récent (comme `nokker` dans un terminal), sinon un fil neuf. */
  async connect(opts: { resume?: boolean } = {}): Promise<boolean> {
    this.error = null;
    if (!this.opts.folder) {
      this.error = "Ouvre un dossier : Nokker travaille sur le dossier de l'espace de travail.";
      this.postState();
      return false;
    }
    const tok = await readLocalToken(this.opts.serverUrl);
    if ("error" in tok) {
      this.error = tok.error;
      this.postState();
      return false;
    }
    try {
      this.dispose();
      this.client = new NokkerClient({ baseUrl: this.opts.serverUrl, token: tok.token, userAgent: this.opts.userAgent ?? "nokker-vscode/0.1" });
      this.hub = new LocalEventHub(this.client, (err) => this.host.log?.("warn", `événements : ${String(err)}`));
      this.session = await EditorSession.open(this.client, this.hub, this.opts.folder, this.opts.fs, { resume: opts.resume !== false });
      await this.hub.ready();
      this.resetTranscript();
      const history = await this.session.history();
      if (history.length) this.emit({ type: "history", messages: history.map((m) => ({ role: m.role, text: m.content })) });
      // Une carte restée ouverte (tour en cours dans un autre client) : reprise par l'API.
      this.session.setSink(this.sink());
      await this.session.refreshApprovals();
      this.postState();
      this.host.log?.("info", `session ${this.session.threadId} sur ${this.opts.folder}`);
      return true;
    } catch (err) {
      this.error = errorText(err);
      this.session = null;
      this.postState();
      return false;
    }
  }

  /** Nouveau fil sur le même dossier (`POST /v1/local/sessions`). */
  async newThread(): Promise<boolean> {
    if (this.busy) {
      this.emit({ type: "error", text: "Un tour est en cours : arrête-le d'abord." });
      return false;
    }
    return this.connect({ resume: false });
  }

  /** Le panneau (re)chargé rejoue ce qui a été affiché depuis la connexion. */
  replay(): void {
    for (const m of this.transcript) this.host.post(m);
    this.postState();
    this.host.post({ type: "context", items: this.contexts.map((c) => ({ id: c.id, label: contextLabel(c) })) });
  }

  addSelection(c: Omit<SelectionContext, "id">): void {
    this.contexts.push({ ...c, id: `ctx${this.nextContext++}` });
    this.host.post({ type: "context", items: this.contexts.map((x) => ({ id: x.id, label: contextLabel(x) })) });
  }

  removeContext(id: string): void {
    this.contexts = this.contexts.filter((c) => c.id !== id);
    this.host.post({ type: "context", items: this.contexts.map((x) => ({ id: x.id, label: contextLabel(x) })) });
  }

  /** Un tour. Les blocs de contexte (sélections) partent avec ce message puis sont retirés. */
  async send(text: string): Promise<void> {
    const t = text.trim();
    if (!t) return;
    if (!this.session && !(await this.connect())) return;
    const session = this.session!;
    if (session.busy) {
      this.emit({ type: "error", text: "Un tour est déjà en cours." });
      return;
    }
    const contexts = this.contexts;
    this.contexts = [];
    this.host.post({ type: "context", items: [] });
    this.emit({ type: "user", text: t, context: contexts.map(contextLabel) });
    this.postState(true);
    try {
      const attachments = imageMentions(t);
      const out = await session.prompt(composeMessage(t, contexts), this.sink(), attachments.length ? { attachments } : {});
      this.emit({ type: "turnEnd", stopReason: out.stopReason });
    } catch (err) {
      this.emit({ type: "error", text: errorText(err) });
      this.emit({ type: "turnEnd", stopReason: "error" });
    } finally {
      this.postState();
    }
  }

  async cancel(): Promise<void> {
    await this.session?.cancel();
  }

  /** Décision d'une carte par le panneau (bouton). Une carte forte n'a pas de bouton : refusée ici aussi. */
  async decide(id: string, index: number): Promise<void> {
    const card = this.cards.get(id);
    const choice = card?.choices?.[index];
    if (!card || !choice || !this.session) return;
    try {
      await this.session.decide(id, choice);
    } catch (err) {
      this.emit({ type: "error", text: `décision : ${errorText(err)}` });
    }
  }

  async openDiff(id: string): Promise<void> {
    const d = this.diffs.get(id);
    if (d) await this.host.openDiff(d);
  }

  dispose(): void {
    this.session?.dispose();
    this.hub?.close();
    this.session = null;
    this.hub = null;
    this.cards.clear();
  }

  private resetTranscript(): void {
    this.transcript = [];
    this.diffs.clear();
    this.cards.clear();
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
      folder: this.opts.folder,
      server: this.opts.serverUrl,
      threadId: this.threadId,
      error: this.error,
    });
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
      effect: t.effect ? EFFECT_LABEL[t.effect] : null,
      status: t.status,
      preview: t.preview,
      ms: t.ms,
      depth: t.depth,
      diffs,
    };
  }

  private sink() {
    return {
      onText: (append: string) => this.emit({ type: "text", append }),
      onTextReplace: (text: string) => this.emit({ type: "textReplace", text }),
      onToolStart: (t: EditorToolCall) => this.emit({ type: "tool", tool: this.viewTool(t) }),
      onToolEnd: (t: EditorToolCall) => this.emit({ type: "tool", tool: this.viewTool(t) }),
      onApproval: (card: EditorApprovalCard) => {
        this.cards.set(card.approval.id, card);
        const view = viewCard(card);
        this.emit({ type: "card", card: view });
        this.host.cardAlert?.(view);
      },
      // Carte forte déposée chez nokker.ai après coup : le panneau remplace « au terminal » par « attend ton téléphone ».
      onApprovalUpdate: (card: EditorApprovalCard) => {
        if (!this.cards.has(card.approval.id)) return;
        this.cards.set(card.approval.id, card);
        this.emit({ type: "card", card: viewCard(card) });
      },
      onApprovalClosed: (id: string, status: string) => {
        this.cards.delete(id);
        this.emit({ type: "cardClosed", id, status });
      },
      onCost: (c: Parameters<typeof formatCostLine>[0]) => this.emit({ type: "cost", line: formatCostLine(c) }),
      onNotice: (text: string) => this.emit({ type: "notice", text }),
    };
  }
}

function viewCard(card: EditorApprovalCard): ViewCard {
  const a = card.approval;
  return {
    id: a.id,
    tool: a.tool_name,
    target: toolTarget(a.tool_name, a.arguments),
    effect: (a.effect && (EFFECT_LABEL as Record<string, string>)[a.effect]) || a.effect || "inconnu",
    reason: a.reason,
    choices: card.choices ? card.choices.map((c, index) => ({ index, key: c.key, label: c.label, ...(c.rule ? { rule: c.rule } : {}) })) : null,
    forwarded: card.forwarded,
    strongText: card.choices ? null : strongCardText(card),
    expiresAt: a.expires_at,
  };
}
