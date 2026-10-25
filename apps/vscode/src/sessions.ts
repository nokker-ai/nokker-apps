/**
 * Vue « Sessions » : les sessions de code du noyau local (`GET /v1/local/sessions`, forme du noyau `{thread_id, cwd}`),
 * avec leur état vivant (tour en cours, cartes en attente) et leur coût cumulé (`GET /v1/local/cost?thread_id=`).
 * Pur (sans API VS Code), testé contre le mock-server.
 *
 * - Titre, date, « travaille », cartes : la ligne de `GET /v1/local/sessions` les porte depuis le noyau du 25.10
 *   (`title`, `last_turn_at`, `working`, `pending_approvals`) ; un noyau plus ancien (`{thread_id, cwd}` seulement) :
 *   `GET /v1/threads` quand le fil y est (un fil sans tour peut ne pas y être : le nom du dossier sert).
 * - Vivant : un seul abonnement `/v1/events` pour toutes les sessions (`LocalEventHub.listenAll`) — `turn.started` /
 *   `turn.done` (et `thread.updated`) pour « travaille », `approval.*` pour les cartes (relues par l'API, jamais
 *   devinées), `turn.done` relit le coût de la session. Une session inconnue qui démarre un tour (ouverte par la CLI)
 *   relance la liste.
 */
import { formatCostLine, rootThreadOf, type Approval, type CostLang, type LocalEventHub, type LocalSessionSummary, type NokkerClient, type NokkerEvent, type Thread } from "@nokker-apps/sdk";

export interface SessionRow {
  threadId: string;
  cwd: string;
  title: string;
  /** Sous un dossier ouvert dans cette fenêtre : la session peut y être reprise. */
  inFolder: boolean;
  /** Session affichée dans le panneau. */
  current: boolean;
  working: boolean;
  /** Cartes en attente de la session (sous-agents compris). */
  cards: number;
  /** Dont cartes fortes (jamais décidées depuis l'éditeur). */
  strongCards: number;
  /** Coût cumulé (`12,4 k jetons · 0,03 €`), `null` si inconnu. */
  cost: string | null;
  updatedAt: string | null;
}

export interface SessionsOptions {
  /** Dossiers ouverts (chemins tels quels ET résolus : le noyau rend `cwd` résolu). */
  folders: () => string[];
  /** Fil affiché dans le panneau. */
  current: () => string | null;
  lang?: CostLang;
  /** Délai de regroupement des relectures (ms). */
  debounceMs?: number;
}

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");

export function underFolder(cwd: string, folders: string[]): boolean {
  const c = norm(cwd);
  return folders.some((f) => {
    const n = norm(f);
    return c === n || c.startsWith(`${n}/`);
  });
}

const basename = (p: string): string => norm(p).split("/").pop() || p;

/** Les sessions du dossier d'abord, puis les plus récentes ; à date égale (ou inconnue), la plus récemment ouverte (le
 * noyau liste dans l'ordre d'ouverture). */
export function sortRows(rows: SessionRow[], order: Map<string, number>): SessionRow[] {
  return [...rows].sort((a, b) => {
    if (a.inFolder !== b.inFolder) return a.inFolder ? -1 : 1;
    const da = a.updatedAt ?? "";
    const db = b.updatedAt ?? "";
    if (da !== db) return da < db ? 1 : -1;
    return (order.get(b.threadId) ?? 0) - (order.get(a.threadId) ?? 0);
  });
}

export class SessionsModel {
  private sessions: LocalSessionSummary[] = [];
  private threads = new Map<string, Thread>();
  private working = new Map<string, boolean>();
  private approvals: Approval[] = [];
  private approvalsRead = false;
  private costs = new Map<string, string | null>();
  private unlisten: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private loading: Promise<void> | null = null;
  error: string | null = null;

  constructor(
    private readonly client: NokkerClient,
    private readonly hub: LocalEventHub,
    private readonly opts: SessionsOptions,
  ) {
    this.unlisten = hub.listenAll(
      (e) => this.onEvent(e),
      () => this.later("all", () => this.refresh()),
    );
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  rows(): SessionRow[] {
    const folders = this.opts.folders();
    const current = this.opts.current();
    const order = new Map(this.sessions.map((s, i) => [s.thread_id, i]));
    const rows = this.sessions.map((s): SessionRow => {
      const th = this.threads.get(s.thread_id);
      const cards = this.approvals.filter((a) => rootThreadOf(a.thread_id) === s.thread_id);
      return {
        threadId: s.thread_id,
        cwd: s.cwd,
        title: s.title || th?.title || basename(s.cwd),
        inFolder: underFolder(s.cwd, folders),
        current: s.thread_id === current,
        working: this.working.get(s.thread_id) ?? s.working ?? th?.working ?? false,
        // Cartes relues par l'API (pour les fortes) ; liste illisible : le compte de la ligne du noyau.
        cards: this.approvalsRead ? cards.length : (s.pending_approvals ?? 0),
        strongCards: cards.filter((a) => a.strength === "strong").length,
        cost: this.costs.get(s.thread_id) ?? null,
        updatedAt: s.last_turn_at ?? th?.updated_at ?? null,
      };
    });
    return sortRows(rows, order);
  }

  /** Relit tout (sessions, fils, cartes, coûts). Les appels concurrents partagent la même relecture. */
  refresh(): Promise<void> {
    return (this.loading ??= this.load().finally(() => (this.loading = null)));
  }

  dispose(): void {
    this.unlisten?.();
    this.unlisten = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.listeners.clear();
  }

  private async load(): Promise<void> {
    try {
      this.sessions = await this.client.listLocalSessions();
      this.error = null;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.changed();
      return;
    }
    // Noyau du 25.10 : chaque ligne se décrit (`working` présent) ; sinon, titres et dates par `GET /v1/threads`.
    const described = this.sessions.every((s) => typeof s.working === "boolean");
    if (described) this.working.clear(); // la ligne du noyau vaut jusqu'au prochain événement
    const [threads, approvals] = await Promise.all([described ? Promise.resolve(null) : this.client.listThreads().catch(() => null), this.client.listLocalApprovals().catch(() => null)]);
    if (threads) this.threads = new Map(threads.map((t) => [t.id, t]));
    if (approvals) this.approvals = approvals.filter((a) => a.status === "pending");
    this.approvalsRead = approvals !== null;
    await Promise.all(this.sessions.slice(-50).map((s) => this.loadCost(s.thread_id, false)));
    this.changed();
  }

  private async loadCost(threadId: string, notify = true): Promise<void> {
    try {
      const totals = await this.client.getLocalCost(threadId);
      this.costs.set(threadId, totals.session && totals.session.turns > 0 ? formatCostLine(totals.session, this.opts.lang ?? "fr") : null);
    } catch {
      // noyau sans journal des coûts (404) : pas de coût affiché
      this.costs.set(threadId, null);
    }
    if (notify) this.changed();
  }

  private async loadApprovals(): Promise<void> {
    try {
      this.approvals = (await this.client.listLocalApprovals()).filter((a) => a.status === "pending");
      this.approvalsRead = true;
      this.changed();
    } catch {
      // relu au prochain événement
    }
  }

  private known(threadId: string): boolean {
    return this.sessions.some((s) => s.thread_id === threadId);
  }

  private onEvent(e: NokkerEvent): void {
    switch (e.type) {
      case "turn.started":
      case "turn.done": {
        const root = rootThreadOf(e.thread_id);
        if (root !== e.thread_id) return; // tour de sous-agent : le fil racine ne change pas d'état
        if (!this.known(root)) {
          this.later("all", () => this.refresh());
          return;
        }
        this.working.set(root, e.type === "turn.started");
        if (e.type === "turn.done") this.later(`cost:${root}`, () => this.loadCost(root));
        this.changed();
        return;
      }
      case "thread.updated": {
        const th = (e as { thread?: Thread }).thread;
        if (!th || !this.known(th.id)) return;
        this.threads.set(th.id, th);
        if (typeof th.working === "boolean") this.working.set(th.id, th.working);
        this.changed();
        return;
      }
      case "approval.requested":
      case "approval.decided":
      case "approval.forwarded":
        this.later("approvals", () => this.loadApprovals());
        return;
      default:
        return;
    }
  }

  private later(key: string, fn: () => Promise<void> | void): void {
    const prev = this.timers.get(key);
    if (prev) clearTimeout(prev);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void fn();
      }, this.opts.debounceMs ?? 150),
    );
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }
}
