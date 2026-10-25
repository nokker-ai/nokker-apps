/**
 * Session de code locale vue d'un ÉDITEUR (extension VS Code, pont ACP) — LOKKAL.md §7.4. Le client terminal a sa
 * propre boucle (Ink) ; celle-ci est la même logique sans affichage, partagée par les éditeurs :
 *
 * - un abonnement `/v1/events` par client (`LocalEventHub`), routé par fil (sous-agents `<fil>/sa-…` compris) ;
 * - un tour = `POST /v1/chat/completions` en flux, texte rendu en AJOUTS seulement (un éditeur ne retire pas un texte
 *   déjà affiché : `nokker.reset` ouvre un nouveau paragraphe, le chunk final ne complète que ce qui manque) ;
 * - cartes d'approbation détectées PAR L'API (`GET /v1/local/approvals` à chaque `approval.requested` et à chaque
 *   reconnexion), jamais par un motif de texte ; une décision par carte au plus, et un plafond par tour ;
 * - carte forte : jamais décidée d'ici ; elle attend le téléphone si le noyau l'a déposée chez nokker.ai (`forwarded`,
 *   `approval.forwarded`), sinon le terminal ;
 * - diffs des `write_file`/`patch` : fichier lu au `tool.call` puis au `tool.result` (lecteur injecté).
 *
 * Aucune dépendance à Node : le lecteur de fichiers est fourni par l'appelant.
 */
import { NokkerApiError, applyChatChunk, type NokkerClient } from "./client.js";
import type { EventSubscription } from "./events.js";
import { choiceToDecision, editorCannotDecide, localChoices, type LocalChoice } from "./approval-choices.js";
import { fileEditsOf, hostPathOf, reconstructBefore, type FileEdit } from "./edits.js";
import type { ThreadMessage } from "./bubbles.js";
import type {
  Approval,
  ChatAttachment,
  LocalToolEffect,
  NokkerEvent,
  TurnCostEvent,
} from "./types.js";

/** Fil racine d'un fil de sous-agent (`th_x/sa-1` → `th_x`). */
export function rootThreadOf(threadId: string): string {
  const i = threadId.indexOf("/sa-");
  return i === -1 ? threadId : threadId.slice(0, i);
}

/** Un abonnement `/v1/events` partagé par toutes les sessions d'un même client. */
export class LocalEventHub {
  private sub: EventSubscription | null = null;
  private listeners = new Map<string, Set<(e: NokkerEvent) => void>>();
  /** Abonnés à TOUS les fils (liste des sessions d'un éditeur). */
  private everyone = new Set<(e: NokkerEvent) => void>();
  private reconnectListeners = new Set<() => void>();
  private connected = false;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly client: NokkerClient,
    private readonly onError?: (err: unknown) => void,
  ) {}

  /** Ouvre le flux au premier appel ; résout quand il est connecté (au plus `timeoutMs`). */
  async ready(timeoutMs = 3000): Promise<void> {
    if (!this.sub) {
      this.sub = this.client.subscribeEvents({
        onEvent: (e) => this.dispatch(e),
        onConnected: () => {
          this.connected = true;
          for (const w of this.waiters.splice(0)) w();
        },
        onReconnected: () => {
          for (const l of this.reconnectListeners) l();
        },
        onError: (err) => this.onError?.(err),
      });
    }
    if (this.connected) return;
    await Promise.race([new Promise<void>((r) => this.waiters.push(r)), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  /** Événements du fil `threadId` et de ses sous-agents. */
  listen(threadId: string, fn: (e: NokkerEvent) => void, onReconnect?: () => void): () => void {
    let set = this.listeners.get(threadId);
    if (!set) this.listeners.set(threadId, (set = new Set()));
    set.add(fn);
    if (onReconnect) this.reconnectListeners.add(onReconnect);
    return () => {
      set!.delete(fn);
      if (onReconnect) this.reconnectListeners.delete(onReconnect);
    };
  }

  /** Tous les événements, tous fils confondus (vue « sessions » d'un éditeur) ; `onReconnect` à chaque reconnexion. */
  listenAll(fn: (e: NokkerEvent) => void, onReconnect?: () => void): () => void {
    this.everyone.add(fn);
    if (onReconnect) this.reconnectListeners.add(onReconnect);
    return () => {
      this.everyone.delete(fn);
      if (onReconnect) this.reconnectListeners.delete(onReconnect);
    };
  }

  close(): void {
    this.sub?.close();
    this.sub = null;
    this.connected = false;
  }

  private dispatch(e: NokkerEvent): void {
    for (const fn of this.everyone) fn(e);
    const tid = eventThread(e);
    if (tid === null) {
      // `approval.decided` ne porte pas de fil : à tout le monde, chacun filtre par id de carte.
      for (const set of this.listeners.values()) for (const fn of set) fn(e);
      return;
    }
    const set = this.listeners.get(rootThreadOf(tid));
    if (set) for (const fn of set) fn(e);
  }
}

function eventThread(e: NokkerEvent): string | null {
  if (e.type === "approval.requested") return e.approval.thread_id;
  // `subagent.progress|finished` du noyau ne portent que `parent_thread_id`.
  const t = (e as { thread_id?: unknown }).thread_id ?? (e as { parent_thread_id?: unknown }).parent_thread_id;
  return typeof t === "string" ? t : null;
}

export type EditorToolStatus = "in_progress" | "completed" | "failed";

export interface EditorDiff {
  /** Chemin sur la machine de l'éditeur (absolu). */
  path: string;
  /** Chemin relatif au dossier de la session, pour l'affichage. */
  relPath: string;
  /** `null` : fichier créé. */
  oldText: string | null;
  newText: string;
  /** `true` : seulement le passage remplacé (le fichier entier n'a pas pu être relu). */
  fragment: boolean;
}

export interface EditorToolCall {
  callId: string;
  name: string;
  effect: LocalToolEffect | null;
  args: Record<string, unknown>;
  status: EditorToolStatus;
  preview: string | null;
  ms: number | null;
  /** 1 = sous-agent. */
  depth: number;
  /** Chemins (machine de l'éditeur) que l'appel lit ou écrit. */
  locations: string[];
  diffs: EditorDiff[];
}

export interface EditorApprovalCard {
  approval: Approval;
  /** `null` : carte forte, jamais décidée depuis l'éditeur (aucun bouton). */
  choices: LocalChoice[] | null;
  /** Carte forte déposée chez nokker.ai : elle attend le téléphone ; faux : à décider dans le terminal. */
  forwarded: boolean;
  /** Appel d'outil auquel la carte se rattache, s'il est connu. */
  callId: string | null;
}

export interface EditorSink {
  /** Texte de réponse à AJOUTER à ce qui est déjà affiché. */
  onText?(append: string): void;
  /** Le chunk final contredit le paragraphe affiché (rare) : le REMPLACER par `text`. Sans ce rappel (client en ajouts
   * seulement, ACP), la réponse finale est ajoutée en dessous. */
  onTextReplace?(text: string): void;
  onToolStart?(t: EditorToolCall): void;
  onToolEnd?(t: EditorToolCall): void;
  onApproval?(card: EditorApprovalCard): void;
  /** Carte déjà montrée qui change (carte forte déposée chez nokker.ai après coup : `forwarded` passe à vrai). */
  onApprovalUpdate?(card: EditorApprovalCard): void;
  /** Carte fermée (décidée ici ou ailleurs, expirée, annulée). */
  onApprovalClosed?(approvalId: string, status: string): void;
  onCost?(cost: TurnCostEvent): void;
  /** Ligne d'information (image non lue, sous-agent…). */
  onNotice?(text: string): void;
}

export interface EditorFs {
  /** Contenu du fichier, `null` s'il n'existe pas ou ne se lit pas. */
  read(path: string): Promise<string | null>;
}

/** Textes que la session produit elle-même (notices, aperçu d'un appel fermé par sa carte). Français par défaut ; un
 * éditeur traduit les siens (extension VS Code : anglais par défaut). */
export interface EditorTexts {
  subagentStarted(goal: string): string;
  subagentFinished(status: string, commits: number | null): string;
  imageSkipped: string;
  approvedExecuted: string;
  executionFailed: string;
  cardExpired: string;
  rejected: string;
}

export const EDITOR_TEXTS_FR: EditorTexts = {
  subagentStarted: (goal) => `Sous-agent lancé : ${goal}`,
  subagentFinished: (status, commits) => `Sous-agent terminé (${status})${commits ? ` : ${commits} commit(s)` : ""}`,
  imageSkipped: "Image non lue : le modèle n'a pas la vision.",
  approvedExecuted: "Approuvée : exécutée par le noyau.",
  executionFailed: "Échec de l'exécution.",
  cardExpired: "Carte expirée : non exécutée.",
  rejected: "Refusée : non exécutée.",
};

export interface TurnOutcome {
  stopReason: "end_turn" | "cancelled";
  reply: string;
  cost: TurnCostEvent | null;
}

/** Plafond de décisions par tour : une boucle de l'éditeur ne peut pas approuver en rafale. */
export const MAX_DECISIONS_PER_TURN = 25;
/** Attente de `turn.done` (et donc de `turn.cost`) après la fin du flux de réponse. */
export const TURN_DONE_WAIT_MS = 2000;

const sameArgs = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  const norm = (o: Record<string, unknown>): string => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  return norm(a) === norm(b);
};

/** Ce qui reste de `full` une fois `shown` affiché, aux blancs près (`null` si `shown` n'en est pas le début). */
export function suffixAfter(full: string, shown: string): string | null {
  let i = 0;
  let j = 0;
  const ws = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);
  while (j < shown.length) {
    if (ws(shown[j])) {
      while (ws(shown[j])) j++;
      while (ws(full[i])) i++;
    } else if (full[i] === shown[j]) {
      i++;
      j++;
    } else if (ws(full[i])) {
      while (ws(full[i])) i++;
    } else return null;
  }
  return full.slice(i);
}

/** Une carte qui attend une décision : le noyau a rendu la main au modèle avec ce marqueur dans le résultat de l'outil
 * (« EN ATTENTE D'APPROBATION HUMAINE … [approval:<id>] ») ; l'outil s'exécutera à la décision. */
const PENDING_MARKER = /\[approval:([\w-]+)\]/;

export class EditorSession {
  private sink: EditorSink = {};
  private unlisten: (() => void) | null = null;
  private tools = new Map<string, EditorToolCall>();
  private edits = new Map<string, Array<{ edit: FileEdit; host: string; before: Promise<string | null> }>>();
  private cards = new Map<string, EditorApprovalCard>();
  /** Cartes annoncées `approval.forwarded` (l'événement peut précéder la lecture de la carte). */
  private forwardedIds = new Set<string>();
  private decided = new Set<string>();
  private decisionsThisTurn = 0;
  private abort: AbortController | null = null;
  private cancelled = false;
  private doneResolve: (() => void) | null = null;
  private inTurn = false;
  /** Fins d'outil en cours de calcul (diffs) : attendues avant de rendre la main à la fin du tour. */
  private pendingEnds = new Set<Promise<void>>();
  /** Le tour lancé par `prompt` (premier `turn.started` reçu après l'envoi). */
  private ownTurn: string | null = null;
  private expectOwn = false;
  /** Tours de suite (continuation après une décision) commencés et pas finis. */
  private running = new Set<string>();
  /** Décisions et relectures de cartes en vol : le tour n'est pas fini tant qu'il en reste. */
  private inflight = new Set<Promise<unknown>>();
  /** Coût publié par tour (`turn.cost`), rendu à son `turn.done`. */
  private costs = new Map<string, TurnCostEvent>();
  private ownCost: TurnCostEvent | null = null;
  /** Carte → appel d'outil qui l'attend (marqueur du noyau, ou `call_id` de la carte). */
  private waitingCalls = new Map<string, string>();
  /** Cartes approuvées dont l'appel attend le `tool.result` de l'exécuteur (carte → appel). */
  private executing = new Map<string, string>();
  private emitText: ((s: string) => void) | null = null;
  /** `turn.done` du tour lancé par `prompt` reçu. */
  private ownDone = false;
  private wake: (() => void) | null = null;

  constructor(
    private readonly client: NokkerClient,
    private readonly hub: LocalEventHub,
    public readonly threadId: string,
    public readonly cwd: string,
    private readonly fs: EditorFs,
    private readonly texts: EditorTexts = EDITOR_TEXTS_FR,
  ) {}

  /** Session de code sur `cwd` : `resume: true` reprend le fil le plus récent de ce dossier (comme le client terminal),
   * sinon un fil neuf (`POST /v1/local/sessions`). */
  static async open(
    client: NokkerClient,
    hub: LocalEventHub,
    cwd: string,
    fs: EditorFs,
    opts: { resume?: boolean; threadId?: string; texts?: EditorTexts } = {},
  ): Promise<EditorSession> {
    let threadId = opts.threadId;
    if (!threadId && opts.resume) {
      const mine = (await client.listLocalSessions()).filter((s) => s.cwd === cwd);
      const best = mine.length ? mine.reduce((b, s) => ((s.last_turn_at ?? "") >= (b.last_turn_at ?? "") ? s : b)) : undefined;
      threadId = best?.thread_id;
    }
    if (!threadId) threadId = (await client.createLocalSession({ cwd })).thread_id;
    const s = new EditorSession(client, hub, threadId, cwd, fs, opts.texts);
    s.attach();
    return s;
  }

  /** Commence à écouter les événements du fil. */
  attach(): void {
    if (this.unlisten) return;
    this.unlisten = this.hub.listen(this.threadId, (e) => this.onEvent(e), () => void this.track(this.refreshApprovals()));
  }

  dispose(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.abort?.abort();
    this.wake?.();
  }

  setSink(sink: EditorSink): void {
    this.sink = sink;
  }

  get busy(): boolean {
    return this.inTurn;
  }

  /** Cartes ouvertes de ce fil, telles que connues ici. */
  openCards(): EditorApprovalCard[] {
    return [...this.cards.values()];
  }

  /** Historique du fil (`GET /v1/threads/{id}`) ; vide pour un fil sans tour. */
  async history(): Promise<ThreadMessage[]> {
    try {
      return (await this.client.getThread(this.threadId)).messages;
    } catch (err) {
      if (err instanceof NokkerApiError && err.status === 404) return [];
      throw err;
    }
  }

  /**
   * Un tour, vu de l'éditeur : la demande, PUIS les tours de suite que lancent les décisions de ses cartes. Sur le noyau,
   * une carte rend la main au modèle (l'outil répond « en attente d'approbation ») ; une approbation exécute l'outil (son
   * `tool.result` porte `approval_id`) puis relance un tour sur le même fil, dans la file du fil ; la promesse ne se
   * résout qu'une fois tout cela fini (plus de carte ouverte, plus de décision en vol, plus d'outil approuvé sans
   * résultat, plus de tour de suite en cours), ou à l'annulation.
   */
  async prompt(text: string, sink: EditorSink, opts: { attachments?: ChatAttachment[] } = {}): Promise<TurnOutcome> {
    if (this.inTurn) throw new Error("un tour est déjà en cours sur cette session");
    this.inTurn = true;
    this.sink = sink;
    this.cancelled = false;
    this.decisionsThisTurn = 0;
    this.ownTurn = null;
    this.ownCost = null;
    this.ownDone = false;
    this.expectOwn = true;
    const done = new Promise<void>((r) => (this.doneResolve = r));
    this.abort = new AbortController();
    let full = "";
    let segment = "";
    let emittedAny = false;
    const emit = (s: string): void => {
      if (!s) return;
      emittedAny = true;
      this.sink.onText?.(s);
    };
    // Texte d'un tour de suite : un paragraphe à part.
    this.emitText = (s) => {
      emit(`${emittedAny ? "\n\n" : ""}${s}`);
      segment = "";
    };
    try {
      await this.hub.ready();
      await this.client.streamChatCompletion(
        this.threadId,
        [{ role: "user", content: text }],
        (chunk) => {
          full = applyChatChunk(full, chunk);
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          if (chunk.nokker?.final) {
            // Le chunk final porte la réponse entière : n'ajouter que ce qui n'est pas déjà à l'écran (aux blancs près).
            const rest = suffixAfter(full, segment);
            if (rest !== null) emit(rest);
            else if (this.sink.onTextReplace) this.sink.onTextReplace(full);
            else emit(`${emittedAny ? "\n\n" : ""}${full}`);
            segment = full;
            return;
          }
          if (chunk.nokker?.reset) {
            // L'appel modèle a fini en outils : le texte suivant est un nouveau paragraphe.
            segment = "";
          }
          if (!delta) return;
          emit(`${segment === "" && emittedAny ? "\n\n" : ""}${delta}`);
          segment += delta;
        },
        "nokker",
        { signal: this.abort.signal, ...(opts.attachments?.length ? { attachments: opts.attachments } : {}) },
      );
    } catch (err) {
      if (!this.cancelled) {
        this.finishPrompt();
        throw err;
      }
    }
    // `turn.cost` puis `turn.done` passent par /v1/events : la réponse peut arriver avant eux.
    await Promise.race([done, new Promise((r) => setTimeout(r, TURN_DONE_WAIT_MS))]);
    this.expectOwn = false;
    if (this.ownCost) this.sink.onCost?.(this.ownCost);
    await this.settle();
    await Promise.race([Promise.all([...this.pendingEnds]), new Promise((r) => setTimeout(r, 1000))]);
    const cost = this.ownCost;
    const stopReason = this.cancelled ? "cancelled" : "end_turn";
    this.finishPrompt();
    return { stopReason, reply: full, cost };
  }

  private finishPrompt(): void {
    this.doneResolve = null;
    this.abort = null;
    this.emitText = null;
    this.expectOwn = false;
    this.inTurn = false;
  }

  /** Attend que la suite du tour soit finie : cartes ouvertes, décisions en vol, tours de suite. */
  private async settle(): Promise<void> {
    let quiet = 0;
    while (!this.cancelled && this.unlisten) {
      const busy = this.cards.size > 0 || this.inflight.size > 0 || this.running.size > 0 || this.executing.size > 0;
      if (!busy) {
        // Les événements d'un tour de suite peuvent suivre de peu la réponse de la décision.
        if (++quiet >= 2) return;
      } else quiet = 0;
      await new Promise<void>((r) => {
        this.wake = r;
        setTimeout(r, busy ? 1000 : 300);
      });
      this.wake = null;
    }
  }

  private track<T>(p: Promise<T>): Promise<T> {
    const q = p.finally(() => {
      this.inflight.delete(q);
      this.wake?.();
    });
    this.inflight.add(q);
    q.catch(() => undefined);
    return q;
  }

  /** Arrête le tour (`POST /v1/threads/{id}/cancel`) ; le flux se ferme par `turn.done {cancelled}`. Coupe la
   * connexion du tour si le noyau ne l'a pas fermée après `graceMs`. */
  async cancel(graceMs = 3000): Promise<void> {
    if (!this.inTurn) return;
    this.cancelled = true;
    this.wake?.();
    try {
      await this.client.cancelTurn(this.threadId);
    } catch {
      // noyau injoignable : on coupe la connexion tout de suite
      this.abort?.abort();
    }
    const abort = this.abort;
    const timer = setTimeout(() => abort?.abort(), graceMs) as unknown as { unref?: () => void };
    timer.unref?.();
    for (const id of [...this.cards.keys()]) this.closeCard(id, "cancelled");
    // Les suites en file sont abandonnées par le noyau (leur `tool.result` en erreur fermera l'appel s'il arrive).
    this.executing.clear();
  }

  /** Décide une carte avec l'un des choix proposés. Une seule décision par carte ; jamais une carte forte ; au plus
   * `MAX_DECISIONS_PER_TURN` par tour. Renvoie `false` si la décision n'a pas été envoyée. La réponse part tout de suite
   * (LOKKAL.md §7.4.3) : le noyau range l'outil et le tour de suite dans la file du fil, derrière le tour qui a posé la
   * carte ; l'appel se ferme sur le `tool.result` de l'exécuteur. */
  async decide(approvalId: string, choice: LocalChoice): Promise<boolean> {
    const card = this.cards.get(approvalId);
    if (!card || this.decided.has(approvalId) || !card.choices) return false;
    if (!card.choices.some((c) => c.id === choice.id && c.rule === choice.rule)) return false;
    if (this.decisionsThisTurn >= MAX_DECISIONS_PER_TURN) return false;
    this.decided.add(approvalId);
    this.decisionsThisTurn += 1;
    const { decision, scope } = choiceToDecision(choice.id);
    try {
      const res = await this.track(this.client.decideLocalApproval(approvalId, { decision, scope, ...(choice.rule ? { rule: choice.rule } : {}) }));
      if (res.call_id && !this.waitingCalls.has(approvalId)) this.waitingCalls.set(approvalId, res.call_id);
      this.closeCard(approvalId, res.status ?? (decision === "approve" ? "approved" : "rejected"), res.result_summary ?? res.error);
      return true;
    } catch (err) {
      // 409 : décidée ailleurs entre-temps (terminal, téléphone) ou expirée.
      if (err instanceof NokkerApiError && err.status === 409) {
        this.closeCard(approvalId, "closed");
        return false;
      }
      // Réponse perdue alors que le noyau a déjà publié la décision : elle compte.
      if (!this.cards.has(approvalId)) return true;
      throw err;
    }
  }

  /** Relit les cartes en attente de ce fil (et de ses sous-agents) par l'API. */
  async refreshApprovals(fallback?: Approval): Promise<void> {
    let list: Approval[];
    try {
      list = (await this.client.listLocalApprovals()).filter((a) => rootThreadOf(a.thread_id) === this.threadId);
    } catch {
      list = fallback ? [fallback] : [];
    }
    for (const a of list) {
      if (a.status !== "pending" || this.cards.has(a.id) || this.decided.has(a.id)) continue;
      const card: EditorApprovalCard = {
        approval: a,
        choices: editorCannotDecide(a) ? null : localChoices(a),
        forwarded: a.forwarded === true || this.forwardedIds.has(a.id),
        callId: this.waitingCalls.get(a.id) ?? a.call_id ?? this.callIdFor(a),
      };
      if (a.call_id && !this.waitingCalls.has(a.id) && this.tools.has(a.call_id)) this.waitingCalls.set(a.id, a.call_id);
      this.cards.set(a.id, card);
      this.sink.onApproval?.(card);
    }
  }

  private callIdFor(a: Approval): string | null {
    const open = [...this.tools.values()].filter((t) => t.name === a.tool_name && t.status === "in_progress");
    const hit = [...open].reverse().find((t) => sameArgs(t.args, a.arguments)) ?? open[open.length - 1];
    return hit?.callId ?? null;
  }

  /**
   * Ferme une carte. L'appel qui l'attendait : approuvé, il reste « en cours » jusqu'au `tool.result` de l'exécuteur
   * (la vraie sortie de l'outil, LOKKAL.md §7.4.9) ; refusé, expiré ou annulé, il se termine ici (un refus ne publie pas
   * de `tool.result`). `executed`/`failed` (noyau d'avant le 25.10, qui répondait après l'outil) le termine aussi, avec
   * le résumé de la carte.
   */
  private closeCard(id: string, status: string, summary?: string | null): void {
    const callId = this.waitingCalls.get(id) ?? (status !== "approved" ? this.executing.get(id) : undefined);
    this.waitingCalls.delete(id);
    this.forwardedIds.delete(id);
    if (status !== "approved") this.executing.delete(id);
    if (callId) {
      const t = this.tools.get(callId);
      if (t && t.status === "in_progress") {
        if (status === "approved") {
          this.executing.set(id, callId);
        } else {
          const ok = status === "executed";
          const end: EditorToolCall = {
            ...t,
            status: ok ? "completed" : "failed",
            preview:
              summary ??
              (ok
                ? this.texts.approvedExecuted
                : status === "failed"
                  ? this.texts.executionFailed
                  : status === "expired"
                    ? this.texts.cardExpired
                    : this.texts.rejected),
          };
          this.tools.set(callId, end);
          this.sink.onToolEnd?.(end);
        }
      }
    }
    if (!this.cards.delete(id)) return;
    this.sink.onApprovalClosed?.(id, status);
    this.wake?.();
  }

  private onEvent(e: NokkerEvent): void {
    switch (e.type) {
      case "tool.call": {
        const depth = e.thread_id === this.threadId ? 0 : 1;
        const args = e.args ?? (e.args_preview ? { aperçu: e.args_preview } : {});
        const edits = fileEditsOf(e.name, args)
          .map((edit) => ({ edit, host: hostPathOf(edit.path, this.cwd) }))
          .filter((x): x is { edit: FileEdit; host: string } => x.host !== null)
          // Lu tout de suite : le noyau n'a en général pas encore écrit (sinon `reconstructBefore` prend le relais).
          .map((x) => ({ ...x, before: this.fs.read(x.host) }));
        if (edits.length) this.edits.set(e.call_id, edits);
        const path = typeof args.path === "string" ? hostPathOf(args.path, this.cwd) : null;
        const t: EditorToolCall = {
          callId: e.call_id,
          name: e.name,
          effect: e.effect ?? null,
          args,
          status: "in_progress",
          preview: null,
          ms: null,
          depth,
          locations: edits.length ? edits.map((x) => x.host) : path ? [path] : [],
          diffs: [],
        };
        this.tools.set(e.call_id, t);
        this.sink.onToolStart?.(t);
        return;
      }
      case "tool.result": {
        if (!e.call_id) return; // appel direct (`/v1/local/tools/call`) : pas un outil du tour
        const t = this.tools.get(e.call_id);
        if (e.approval_id) {
          // Sortie de l'exécuteur après la carte (même `call_id` que l'appel resté en attente).
          this.executing.delete(e.approval_id);
          this.waitingCalls.delete(e.approval_id);
          this.wake?.();
        }
        if (!t) return;
        const waiting = e.approval_id ? undefined : e.preview?.match(PENDING_MARKER)?.[1];
        if (waiting && !e.is_error) {
          // L'outil attend sa carte : il reste « en cours » jusqu'à la décision.
          this.waitingCalls.set(waiting, t.callId);
          const card = this.cards.get(waiting);
          if (card && !card.callId) card.callId = t.callId;
          return;
        }
        const ok = e.is_error !== undefined ? !e.is_error : e.ok !== false;
        const edits = this.edits.get(e.call_id) ?? [];
        this.edits.delete(e.call_id);
        const p: Promise<void> = this.diffsOf(ok ? edits : [])
          .catch(() => [] as EditorDiff[])
          .then((diffs) => {
            const end: EditorToolCall = { ...t, status: ok ? "completed" : "failed", preview: e.preview ?? null, ms: e.ms ?? null, effect: t.effect ?? e.effect ?? null, diffs };
            this.tools.set(t.callId, end);
            this.sink.onToolEnd?.(end);
          })
          .finally(() => this.pendingEnds.delete(p));
        this.pendingEnds.add(p);
        return;
      }
      case "approval.requested":
        void this.track(this.refreshApprovals(e.approval));
        return;
      case "approval.forwarded": {
        this.forwardedIds.add(e.approval_id);
        const card = this.cards.get(e.approval_id);
        if (card && !card.forwarded) {
          const next = { ...card, forwarded: true };
          this.cards.set(card.approval.id, next);
          this.sink.onApprovalUpdate?.(next);
        }
        return;
      }
      case "approval.decided":
        this.closeCard(e.approval_id, e.decision);
        return;
      case "subagent.started":
        this.sink.onNotice?.(this.texts.subagentStarted(e.goal));
        return;
      case "subagent.finished":
        this.sink.onNotice?.(this.texts.subagentFinished(e.status, e.commits ?? null));
        return;
      case "attachment.skipped":
        if (e.thread_id === this.threadId) this.sink.onNotice?.(this.texts.imageSkipped);
        return;
      case "turn.started":
        if (e.thread_id !== this.threadId) return;
        if (this.expectOwn && this.ownTurn === null) this.ownTurn = e.turn_id;
        else if (e.turn_id !== this.ownTurn) this.running.add(e.turn_id);
        this.wake?.();
        return;
      case "turn.delta":
        // Le texte du tour lancé ici arrive par le flux de chat ; celui d'un tour de suite n'arrive que par cet événement.
        if (e.thread_id === this.threadId && e.turn_id !== this.ownTurn && e.text) {
          if (this.emitText) this.emitText(e.text);
          else this.sink.onText?.(e.text);
        }
        return;
      case "turn.cost":
        if (e.thread_id !== this.threadId) return;
        if (e.turn_id === this.ownTurn || (this.expectOwn && this.ownTurn === null)) this.ownCost = e;
        else this.costs.set(e.turn_id, e);
        return;
      case "turn.done":
        if (e.thread_id !== this.threadId) return;
        if (e.turn_id === this.ownTurn || (this.expectOwn && this.ownTurn === null)) {
          if (e.cancelled) this.cancelled = true;
          this.ownDone = true;
          this.doneResolve?.();
        } else {
          this.running.delete(e.turn_id);
          const c = this.costs.get(e.turn_id);
          this.costs.delete(e.turn_id);
          if (c) this.sink.onCost?.(c);
        }
        this.wake?.();
        return;
      default:
        return;
    }
  }

  private async diffsOf(edits: Array<{ edit: FileEdit; host: string; before: Promise<string | null> }>): Promise<EditorDiff[]> {
    const out: EditorDiff[] = [];
    for (const { edit, host, before: beforeP } of edits) {
      const before = await beforeP;
      const after = await this.fs.read(host);
      const relPath = host.slice(this.cwd.replace(/[\\/]+$/, "").length + 1);
      if (after === null) {
        if (before !== null) out.push({ path: host, relPath, oldText: before, newText: "", fragment: false });
        continue;
      }
      if (before !== null && before !== after) {
        out.push({ path: host, relPath, oldText: before, newText: after, fragment: false });
        continue;
      }
      // Lecture « avant » trop tardive (ou fichier inchangé) : on refait l'ancien texte, sans deviner.
      const rebuilt = reconstructBefore(after, edit);
      if (rebuilt !== null && rebuilt !== after) {
        out.push({ path: host, relPath, oldText: rebuilt, newText: after, fragment: false });
      } else if (edit.kind === "write" && before === null) {
        out.push({ path: host, relPath, oldText: null, newText: after, fragment: false });
      } else if (edit.kind === "replace" && edit.oldFragment !== undefined && edit.newFragment !== undefined && edit.oldFragment !== edit.newFragment) {
        out.push({ path: host, relPath, oldText: edit.oldFragment, newText: edit.newFragment, fragment: true });
      }
    }
    return out;
  }
}
