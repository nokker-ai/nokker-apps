/**
 * Logique de session CLI, SANS Ink — c'est la partie testée par `test/integration.test.ts` (CLI ↔
 * mock-server) ; `ui/App.tsx` n'est qu'une vue par-dessus ces mêmes méthodes. Séparer les deux
 * évite de tester un rendu de terminal (fragile, peu utile) pour vérifier le contrat réseau.
 */
import { randomBytes } from "node:crypto";
import {
  NokkerClient,
  applyChatChunk,
  type Approval,
  type LocalApprovalResult,
  type Bubble,
  type ApprovalScope,
  type ChatCompletionChunk,
  type LocalCostTotals,
  type LocalSessionSummary,
  type LocalToolName,
  type LocalToolOutcome,
  type EventSubscription,
  type NokkerEvent,
  type SessionMessageResult,
  type Thread,
  type ThreadView,
  type TransferMode,
  type TransferResult,
} from "@nokker-apps/sdk";
import type { DeviceIdentity } from "./auth.js";
import { signWithDevice } from "./auth.js";

export class StrongApprovalRequiresDeviceError extends Error {
  constructor() {
    super("Une approbation de niveau strong exige une preuve biométrique (téléphone) — jamais de TOTP ni de clé logicielle (APPROVALS.md §1).");
  }
}

export interface CliSessionHandlers {
  onEvent?: (event: NokkerEvent) => void;
  onError?: (err: unknown) => void;
  onReconnected?: () => void;
  onConnected?: () => void;
}

export class CliSession {
  public threadId: string;
  /** Dossier de la session locale (`null` = fil ordinaire). */
  public cwd: string | null = null;
  private turn: AbortController | null = null;
  /** Utilisateur résolu par la connexion (`SessionToken.user`) — requis pour `totp_user`
   * (APPROVALS.md §3.5) ; `setUser` est appelé après `login()`/`loadSession()` par l'appelant. */
  private user: string | null = null;

  constructor(
    private readonly client: NokkerClient,
    private readonly identity: DeviceIdentity | null,
    threadId = newThreadId(),
    user: string | null = null,
  ) {
    this.threadId = threadId;
    this.user = user;
  }

  setUser(user: string): void {
    this.user = user;
  }

  /** Nouveau fil ordinaire (jamais envoyé au serveur avant le premier message). */
  newThread(): void {
    this.threadId = newThreadId();
    this.cwd = null;
  }

  /** Session de code sur `cwd` : reprend le fil local le plus récent de ce dossier, sinon en crée un
   * (LOKKAL.md §7.4.1). Renvoie l'historique du fil repris (vide pour un fil neuf). */
  async openLocal(cwd: string): Promise<{ resumed: boolean; messages: ThreadView["messages"] }> {
    const mine = (await this.client.listLocalSessions()).filter((s) => s.cwd === cwd);
    // La plus récente : plus grand `last_turn_at` s'il est connu, sinon la dernière de la liste (le noyau les liste
    // de la plus ancienne à la plus récente).
    const existing = mine.length
      ? mine.reduce((best, s) => ((s.last_turn_at ?? "") >= (best.last_turn_at ?? "") ? s : best))
      : undefined;
    // Fil connu pour ce dossier : on le reprend sans rappeler POST (le noyau ouvre un fil neuf à chaque POST, `resume`
    // ou non — il laisserait des fils vides).
    this.threadId = existing ? existing.thread_id : (await this.client.createLocalSession({ cwd })).thread_id;
    this.cwd = cwd;
    if (!existing) return { resumed: false, messages: [] };
    try {
      return { resumed: true, messages: (await this.client.getThread(this.threadId)).messages };
    } catch {
      return { resumed: true, messages: [] }; // fil sans tour encore (404 côté noyau)
    }
  }

  /** Appel d'un outil du noyau sur ce fil (route locale proposée) : 200 {content, is_error} ou 202 {approval_id}. */
  callTool(name: LocalToolName, args: Record<string, unknown> = {}): Promise<LocalToolOutcome> {
    return this.client.callLocalTool(this.threadId, name, args);
  }

  /** `/cost` : totaux de ce fil (sous-agents compris) et du jour, lus sur `GET /v1/local/cost` (lecture seule). */
  getCost(): Promise<LocalCostTotals> {
    return this.client.getLocalCost(this.threadId);
  }

  listLocalSessions(): Promise<LocalSessionSummary[]> {
    return this.client.listLocalSessions();
  }

  /** Échap / `/cancel` : demande au noyau d'arrêter le tour ; le flux se ferme par `turn.done {cancelled}`. */
  async cancel(): Promise<boolean> {
    const r = await this.client.cancelTurn(this.threadId);
    return r.cancelled || r.approvals_cancelled > 0;
  }

  /** Coupe la connexion du tour en cours (dernier recours, p. ex. au départ). */
  abortStream(): void {
    this.turn?.abort();
  }

  subscribeEvents(handlers: CliSessionHandlers): EventSubscription {
    return this.client.subscribeEvents({
      onEvent: (e) => handlers.onEvent?.(e),
      onError: handlers.onError,
      onReconnected: handlers.onReconnected,
      onConnected: handlers.onConnected,
    });
  }

  /** Envoie un message et restitue la réponse en flux (SSE `/v1/chat/completions`). `fullText` = texte courant
   * (reset et chunk final appliqués, `applyChatChunk`) : l'afficher tel quel, ne pas concaténer les deltas. */
  async sendMessage(
    text: string,
    onChunk: (chunk: ChatCompletionChunk, fullText: string) => void,
  ): Promise<string> {
    // Le noyau ne lit que le DERNIER message utilisateur (l'historique vit côté serveur).
    let full = "";
    this.turn = new AbortController();
    try {
      await this.client.streamChatCompletion(
        this.threadId,
        [{ role: "user", content: text }],
        (chunk) => {
          full = applyChatChunk(full, chunk);
          onChunk(chunk, full);
        },
        "nokker",
        { signal: this.turn.signal },
      );
    } finally {
      this.turn = null;
    }
    return full;
  }

  listThreads(): Promise<Thread[]> {
    return this.client.listThreads();
  }

  /** `/new <titre>` (BUBBLES.md §1) : un VRAI fil permanent côté serveur, pas seulement un id local
   * (contrairement à `newThread()`, qui reste l'ouverture par défaut avant le premier message). */
  async createNamedThread(title: string): Promise<Thread> {
    const thread = await this.client.createThread(title);
    this.threadId = thread.id;
    this.cwd = null;
    return thread;
  }

  /** `/sessions <requête>` / `/goto <session>` : bascule sur un fil EXISTANT et recharge son historique
   * (sinon la CLI répond hors contexte sur le fil qu'on vient de rejoindre). */
  async switchThread(id: string): Promise<ThreadView> {
    const view = await this.client.getThread(id);
    this.threadId = view.thread.id;
    return view;
  }

  /** Bulles ouvertes du fil courant (BUBBLES.md §2) — `includeClosed` seulement pour `/bubble <id>`
   * sur une bulle déjà fermée (lecture a posteriori, pas l'usage par défaut de `/bubbles`). */
  listBubbles(includeClosed = false): Promise<Bubble[]> {
    return this.client.listBubbles(this.threadId, { includeClosed });
  }

  getBubble(id: string): Promise<Bubble> {
    return this.client.getBubble(id);
  }

  /** `/send <bulle> <session> [--copy]` → Déplacer (`move`) ou Copier (`copy`), BUBBLES.md §3. */
  transferBubble(id: string, toThread: string, mode: TransferMode): Promise<TransferResult> {
    return this.client.transferBubble(id, toThread, mode);
  }

  /** `/ask <session> <texte>` : §4, `ask: true` lance un tour dans `toThread`, sa réponse revient ici
   * par une bulle `notify` (jamais une attente synchrone — la CLI ne bloque pas sur la réponse). */
  sendAsk(toThread: string, text: string): Promise<SessionMessageResult> {
    return this.client.sendSessionMessage(toThread, { from_thread: this.threadId, text, ask: true });
  }

  listApprovals(status?: Approval["status"]): Promise<Approval[]> {
    return this.client.listApprovals(status);
  }

  getApproval(id: string): Promise<Approval> {
    return this.client.getApproval(id);
  }

  /** Carte d'une session locale (`POST /v1/local/approvals/{id}/decide`) : jeton local, sans signature. `always` écrit la règle
   * choisie (`rule`, l'une des `suggested_rules`) dans les réglages de l'utilisateur côté noyau. */
  /** Répond tout de suite (LOKKAL.md §7.4.3) : l'issue de l'outil arrive par son `tool.result`. */
  decideLocal(approvalId: string, decision: "approve" | "reject", scope: ApprovalScope = "once", rule?: string): Promise<LocalApprovalResult> {
    return this.client.decideLocalApproval(approvalId, { decision, scope, ...(rule ? { rule } : {}) });
  }

  /** Cartes en attente des sessions locales, avec les `suggested_rules` calculées par le noyau. */
  listLocalApprovals(): Promise<Approval[]> {
    return this.client.listLocalApprovals();
  }

  /** Ce fil (ou un `<fil>/sa-…` de sous-agent) est-il celui de la session locale ? Si oui, ses cartes se décident par
   * les routes locales. */
  isLocalThread(threadId: string): boolean {
    return this.cwd !== null && (threadId === this.threadId || threadId.startsWith(`${this.threadId}/sa-`));
  }

  /** Signature logicielle de la clé d'appareil — UNIQUEMENT pour une carte `standard` (APPROVALS.md §1 : « simple
   * signature logicielle » suffit). Le vrai noyau refuse cette preuve sur `strong` (`ProofInvalid`) : la CLI ne
   * signe donc plus jamais une carte forte, elle attend qu'elle soit décidée sur téléphone. */
  async decideByDevice(approval: Approval | string, decision: "approve" | "reject"): Promise<Approval> {
    if (!this.identity) throw new Error("Aucun appareil enrôlé — lancer /login d'abord.");
    const a = typeof approval === "string" ? await this.client.getApproval(approval) : approval;
    if (a.strength !== "standard") throw new StrongApprovalRequiresDeviceError();
    const { challenge } = await this.client.requestChallenge(a.id);
    const signature = await signWithDevice(this.identity.privateKey, challenge, decision);
    return this.client.decideApproval(a.id, {
      decision,
      device_id: this.identity.deviceId,
      challenge,
      signature,
    });
  }

  /** Niveau `standard` uniquement — jamais `strong` (APPROVALS.md §1, appliqué ici AVANT l'appel
   * réseau : le serveur refuse aussi, mais l'UI ne doit même pas proposer l'option). Le défi reste
   * obligatoire même sur ce chemin (anti-rejeu/anti-falsification, APPROVALS.md §2/§3.5). */
  async decideByTotp(approval: Approval, decision: "approve" | "reject", totp: string): Promise<Approval> {
    if (approval.strength !== "standard") {
      throw new StrongApprovalRequiresDeviceError();
    }
    if (!this.user) throw new Error("Utilisateur non résolu — lancer /login d'abord.");
    const { challenge } = await this.client.requestChallenge(approval.id);
    return this.client.decideApproval(approval.id, { decision, challenge, totp, totp_user: this.user });
  }
}

function newThreadId(): string {
  return `th_${randomBytes(6).toString("hex")}`;
}
