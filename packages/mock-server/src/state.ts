/**
 * État en mémoire du mock-server — RAZ à chaque redémarrage (c'est un outil de dev, pas une base).
 * Reproduit `docs/CLIENT-API.md`, `APPROVALS.md` et `BUBBLES.md` SAUF simplifications
 * explicitement commentées (le vrai serveur de ces routes n'existe pas encore côté noyau).
 */
import type { MockPage } from "./pages.js";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LocalMemoryStatus, PermissionSettings } from "@nokker-apps/sdk";
import type {
  Agent,
  Approval,
  ApprovalDecisionKind,
  Bubble,
  DecidedVia,
  Device,
  NokkerEvent,
  Thread,
  ThreadMessage,
} from "@nokker-apps/sdk";
import { MockHttpError } from "./errors.js";
import { publishTurnCost } from "./cost.js";

/** Simplification dev : un seul utilisateur connecté, pas de multi-tenant ni de filtrage des
 * événements par appartenance (BUBBLES.md §6) — tous les fils appartiennent à `alice`. */
export const MOCK_USER = "alice";
/** Utilisateurs connus (cibles valides d'un partage à des membres, BUBBLES.md §2). */
/** Identité donnée au jeton local (LOKKAL.md §7.4.5) : distincte de toute clé d'API. */
export const LOCAL_OWNER = "local-owner";
export const KNOWN_USERS = ["alice", "bob"] as const;

/** `GET /v1/users` (BUBBLES.md §9.2) : même mise en forme que le noyau (nom capitalisé, 2 initiales). */
export function knownUsersJson(): { id: string; name: string; initials: string }[] {
  return KNOWN_USERS.map((id) => {
    const words = id.split(/[_\-\s]+/).filter(Boolean);
    const name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    const initials = (words.length > 1 ? words[0]!.charAt(0) + words[1]!.charAt(0) : words[0]!.slice(0, 2)).toUpperCase();
    return { id, name, initials };
  });
}

export interface MockSessionRecord {
  token: string;
  deviceId: string;
  expiresAt: string;
}

export interface MockChallengeRecord {
  nonce: string;
  exp: number; // epoch ms
  /** `approval_id` du défi — une vraie approbation OU `"login:<device_id>"` pour une connexion
   * (APPROVALS.md §3.2/§3.6, même champ côté noyau). */
  scope: string;
  used: boolean;
}

/** Un tour (noyau : `Turn`) — donne un message user + un message assistant de même `index`. */
export interface MockTurn {
  index: number;
  user: string;
  reply: string;
  sender: string | null;
  channel: string;
  created_at: string;
  /** X7 : images jointes au message user (octets dans `MockState.images`). */
  images?: { sha256: string; media_type: string; size: number; name?: string | null }[];
}

export interface MockThreadRecord {
  thread: Thread;
  turns: MockTurn[];
  /** Boîte de contexte (§8) : blocs reçus, vidés au début du PROCHAIN tour du fil. */
  box: string[];
}

export interface MockStateOptions {
  /** Multiplicateur des délais de la démo (1 = temps réel ; les tests passent 0.01). */
  speed?: number;
  /** Dossier de config utilisateur (`settings.json`, `local-token`). `null`/absent : réglages gardés en mémoire seulement. */
  configDir?: string | null;
  /** Racines déclarées pour les sessions locales ; `null`/absent = tout accepter. */
  localRoots?: string[] | null;
  /** Version minimale du client annoncée par `/healthz`. */
  minClientVersion?: string | null;
  /** Les appareils enrôlés restent `pending` jusqu'à `POST /v1/devices/{id}/confirm` (flux réel, APPROVALS.md §3.1). */
  devicePending?: boolean;
  /** Cartes des sessions locales : `inline` (le tour attend la décision, historique du mock) ou `kernel` (comme le noyau :
   * l'outil répond « en attente d'approbation [approval:<id>] », le tour finit ; la décision répond tout de suite, puis
   * l'outil s'exécute et un tour de suite tourne, dans la file du fil — LOKKAL.md §7.4.9). Défaut :
   * `$MOCK_APPROVAL_STYLE`, sinon `inline`. */
  approvalStyle?: "inline" | "kernel";
  /** Machine liée à un compte nokker.ai : ses cartes fortes partent au téléphone (`forwarded`, `approval.forwarded`,
   * LOKKAL.md §7.3). Défaut : non liée (elles se décident au terminal). */
  strongRelay?: boolean;
}

/** Suite d'un tour arrêté sur une carte (style `kernel`) : jouée après une approbation, verrou du fil tenu — l'outil
 * de la carte (son `tool.result` d'exécuteur) puis le tour de suite. Un refus ne la joue pas. */
export interface PendingContinuation {
  threadId: string;
  run: () => Promise<void>;
}

export interface LocalSessionMeta {
  cwd: string;
  root: string;
  backend: string;
}

/** Tour de session locale en cours (annulable). */
export interface ActiveTurn {
  turnId: string;
  abort: AbortController;
}

export type ApprovalOutcome = "approved" | "rejected" | "expired" | "cancelled";

/** Stockage interne — porte la clé publique en PLUS de la forme `Device` canonique (jamais
 * renvoyée au client, APPROVALS.md §5 : "jamais `public_key_spki` dans une réponse" ;
 * `deviceToJson` filtre ce champ à la sortie). */
export interface MockDeviceRecord extends Device {
  publicKeySpkiB64Url: string;
}

/** Forme CANONIQUE renvoyée au client (APPROVALS.md §5) — jamais la clé publique. */
export function deviceToJson(d: MockDeviceRecord): Device {
  const { publicKeySpkiB64Url, ...rest } = d;
  void publicKeySpkiB64Url;
  return rest;
}

export class MockState {
  devices = new Map<string, MockDeviceRecord>();
  sessions = new Map<string, MockSessionRecord>();
  threads = new Map<string, MockThreadRecord>();
  bubbles = new Map<string, Bubble>();
  agents = new Map<string, Agent>();
  /** X7 : octets des images par sha256 (le mock ne cloisonne pas par locataire). */
  images = new Map<string, { bytes: Buffer; media_type: string }>();
  pages = new Map<string, MockPage>();
  approvals = new Map<string, Approval>();
  /** clé = nonce */
  challenges = new Map<string, MockChallengeRecord>();
  /** Jetons d'invitation de démo déjà acceptés (usage unique). */
  usedInvitations = new Set<string>();
  /** Connecteurs reliés (un par nature) ; le secret n'est JAMAIS gardé, même en démo. */
  connectors = new Map<string, { settings: Record<string, unknown>; connectedAt: string; lastOkAt: string | null }>();
  sseClients = new Set<(event: NokkerEvent) => void>();
  localSessions = new Map<string, LocalSessionMeta>();
  activeTurns = new Map<string, ActiveTurn>();
  approvalWaiters = new Map<string, (o: ApprovalOutcome) => void>();
  /** Style `kernel` : suites de tour en attente d'une décision, par carte. */
  continuations = new Map<string, PendingContinuation>();
  /** Modifiable en cours de route (tests). */
  approvalStyle: "inline" | "kernel";
  /** Machine liée : cartes fortes déposées chez nokker.ai (modifiable, tests). */
  strongRelay: boolean;
  /** Délai du dépôt après la pose de la carte (ms, mis à l'échelle de `speed`). */
  strongRelayMs = 300;
  /** `GET /v1/local/memory` (LOKKAL.md §7.13.6) : mémoire longue directe saine par défaut ; modifiable (tests). */
  memory: LocalMemoryStatus = {
    mode: "direct",
    ok: true,
    projects: ["u-local"],
    profile: "leger",
    store: { ok: true, notes: 12, chunks: 48, generation: 1, model: "embeddinggemma-300m" },
    embed: { ok: true, dim: 768, ms: 14 },
    last_recall_ms: 230,
  };
  /** File par fil (LOKKAL.md §7.4.9) : queue de la chaîne des verrous, par fil racine. */
  private threadLocks = new Map<string, Promise<void>>();
  /** Fil racine → nombre d'annulations : une suite de décision en file d'avant l'annulation est abandonnée. */
  cancelEpochs = new Map<string, number>();
  /** Règles `allow` posées par `scope: session`, par fil (mémoire seulement). */
  sessionRules = new Map<string, string[]>();
  /** Jeton local (`local-token`), absent si le mock n'en a pas écrit. */
  localToken: string | null = null;
  localTokenPath: string | null = null;
  readonly configDir: string | null;
  readonly localRoots: string[] | null;
  readonly minClientVersion: string | null;
  readonly devicePending: boolean;
  private memSettings: PermissionSettings = {};
  readonly speed: number;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(opts: MockStateOptions = {}) {
    this.speed = opts.speed ?? 1;
    this.configDir = opts.configDir ?? null;
    this.localRoots = opts.localRoots ?? null;
    this.minClientVersion = opts.minClientVersion ?? null;
    this.devicePending = opts.devicePending ?? false;
    this.approvalStyle = opts.approvalStyle ?? (process.env.MOCK_APPROVAL_STYLE === "kernel" ? "kernel" : "inline");
    this.strongRelay = opts.strongRelay ?? false;
  }

  // -- Réglages de permission (~/.config/nokker/settings.json, relus à chaque appel) ------------

  get settingsPath(): string | null {
    return this.configDir ? join(this.configDir, "settings.json") : null;
  }

  readSettings(): PermissionSettings {
    const path = this.settingsPath;
    if (!path) return this.memSettings;
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as { permissions?: PermissionSettings };
      return raw.permissions ?? {};
    } catch {
      return {};
    }
  }

  /** `scope: always` : ajoute la règle à `permissions.allow` (dédoublonnée à l'identique, autres clés conservées). */
  addAllowRule(rule: string): boolean {
    const path = this.settingsPath;
    if (!path) {
      const allow = (this.memSettings.allow ??= []);
      if (allow.includes(rule)) return false;
      allow.push(rule);
      return true;
    }
    let doc: Record<string, unknown> = {};
    try {
      doc = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    } catch {
      doc = {};
    }
    const perms = (typeof doc.permissions === "object" && doc.permissions !== null ? doc.permissions : {}) as PermissionSettings;
    const allow = Array.isArray(perms.allow) ? perms.allow : [];
    if (allow.includes(rule)) return false;
    perms.allow = [...allow, rule];
    doc.permissions = perms;
    if (!existsSync(this.configDir!)) mkdirSync(this.configDir!, { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return true;
  }

  /** Réglages effectifs d'un fil : fichier utilisateur + règles de session. */
  effectiveSettings(threadId: string): PermissionSettings {
    const s = this.readSettings();
    return { ...s, allow: [...(s.allow ?? []), ...(this.sessionRules.get(threadId) ?? [])] };
  }

  addSessionRule(threadId: string, rule: string): void {
    const list = this.sessionRules.get(threadId) ?? [];
    if (!list.includes(rule)) list.push(rule);
    this.sessionRules.set(threadId, list);
  }

  /** Prend une place dans la file du fil (premier arrivé, premier servi) ; résout avec la fonction qui la rend. La place
   * est réservée dès l'appel : deux décisions A puis B passent dans cet ordre. */
  lockThread(threadId: string): Promise<() => void> {
    const root = threadId.split("/sa-")[0]!;
    const prev = this.threadLocks.get(root) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.threadLocks.set(root, tail);
    return prev.then(() => () => {
      release();
      if (this.threadLocks.get(root) === tail) this.threadLocks.delete(root);
    });
  }

  /** Un tour tourne ou attend dans la file du fil. */
  threadBusy(threadId: string): boolean {
    return this.threadLocks.has(threadId.split("/sa-")[0]!);
  }

  /** Annule le tour en cours du fil (et de ses sous-fils `<fil>/sa-…`) ; les cartes en attente sont retirées. */
  cancelTurn(threadId: string): { cancelled: boolean; approvals_cancelled: number } {
    const root = threadId.split("/sa-")[0]!;
    this.cancelEpochs.set(root, (this.cancelEpochs.get(root) ?? 0) + 1);
    const ids = [threadId, ...[...this.activeTurns.keys()].filter((k) => k.startsWith(`${threadId}/sa-`))];
    let cancelled = false;
    let approvals = 0;
    for (const id of ids) {
      const active = this.activeTurns.get(id);
      if (active) {
        active.abort.abort();
        cancelled = true;
      }
      for (const a of this.approvals.values()) {
        if ((a.thread_id === id || a.thread_id.startsWith(`${id}/sa-`)) && a.status === "pending") {
          const waiter = this.approvalWaiters.get(a.id);
          if (waiter) waiter("cancelled");
          else {
            // Style `kernel` : aucune boucle n'attend la carte ; elle est retirée (comme `mark_failed` du noyau).
            a.status = "failed";
            a.error = "annulé par l'utilisateur";
            this.continuations.delete(a.id);
            this.publish({ type: "approval.decided", approval_id: a.id, decision: "failed", by: LOCAL_OWNER, via: "local" });
          }
          approvals++;
        }
      }
    }
    return { cancelled, approvals_cancelled: approvals };
  }

  publish(event: NokkerEvent): void {
    for (const send of this.sseClients) send(event);
  }

  /** setTimeout suivi (annulé par `dispose`) et mis à l'échelle de `speed`. */
  later(ms: number, fn: () => void): void {
    if (this.disposed) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.disposed) fn();
    }, Math.max(0, Math.round(ms * this.speed)));
    this.timers.add(t);
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  userForToken(token: string): string | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (Date.parse(session.expiresAt) < Date.now()) return null;
    return MOCK_USER;
  }

  // -- Fils ------------------------------------------------------------------------------

  createThread(title: string, opts: { id?: string; members?: string[] } = {}): MockThreadRecord {
    const now = new Date().toISOString();
    const rec: MockThreadRecord = {
      thread: {
        id: opts.id ?? hexId("th"),
        title,
        owner: MOCK_USER,
        members: opts.members ?? [MOCK_USER],
        created_at: now,
        updated_at: now,
        working: false,
        unread: 0,
        bubble_count: 0,
        last_snippet: "",
      },
      turns: [],
      box: [],
    };
    this.threads.set(rec.thread.id, rec);
    return rec;
  }

  /** Un `X-Session-Id` inconnu crée le fil à la volée (titre = 48 premiers caractères, §1). */
  ensureThread(threadId: string, firstText = ""): MockThreadRecord {
    const existing = this.threads.get(threadId);
    if (existing) return existing;
    return this.createThread(firstText.slice(0, 48) || "Nouveau fil", { id: threadId });
  }

  /** Ajoute un tour (user + reply) et publie turn.started / turn.delta (UNIQUE) / turn.cost / turn.done (§8). */
  appendTurn(threadId: string, user: string, reply: string, opts: { sender?: string | null; channel?: string; silent?: boolean; images?: MockTurn["images"] } = {}): MockTurn {
    const rec = this.ensureThread(threadId, user);
    const turn: MockTurn = {
      index: rec.turns.length,
      user,
      reply,
      sender: opts.sender === undefined ? MOCK_USER : opts.sender,
      channel: opts.channel ?? "web",
      created_at: new Date().toISOString(),
      ...(opts.images?.length ? { images: opts.images } : {}),
    };
    rec.turns.push(turn);
    rec.thread.updated_at = turn.created_at;
    if (reply) rec.thread.last_snippet = reply.slice(0, 80);
    if (!opts.silent) {
      const turn_id = `${threadId}:${turn.index}`;
      this.publish({ type: "turn.started", thread_id: threadId, turn_id });
      if (reply) this.publish({ type: "turn.delta", thread_id: threadId, turn_id, text: reply });
      publishTurnCost(this, threadId, turn_id, user, reply);
      this.publish({
        type: "turn.done",
        thread_id: threadId,
        turn_id,
        usage: { prompt_tokens: user.length, completion_tokens: reply.length, total_tokens: user.length + reply.length },
        tier: "mock",
      });
    }
    return turn;
  }

  /** Messages du fil : `before` = index de tour exclu, `limit` = nombre de TOURS (§8). */
  messagesOf(threadId: string, before?: number, limit = 50): ThreadMessage[] {
    const rec = this.threads.get(threadId);
    if (!rec) return [];
    const turns = rec.turns.filter((t) => before === undefined || t.index < before).slice(-Math.max(1, Math.min(200, limit)));
    const out: ThreadMessage[] = [];
    for (const t of turns) {
      out.push({ index: t.index, role: "user", content: t.user, sender: t.sender, channel: t.channel, created_at: t.created_at, ...(t.images ? { images: t.images } : {}) });
      out.push({ index: t.index, role: "assistant", content: t.reply, created_at: t.created_at });
    }
    return out;
  }

  pushContext(threadId: string, block: string): void {
    this.threads.get(threadId)?.box.push(block);
  }

  drainContext(threadId: string): string[] {
    const rec = this.threads.get(threadId);
    if (!rec) return [];
    const out = rec.box;
    rec.box = [];
    return out;
  }

  /** 404 fil inconnu, 403 pas membre (§8). */
  requireMember(threadId: string, user: string | null): MockThreadRecord {
    const rec = this.threads.get(threadId);
    if (!rec) throw new MockHttpError(404, "fil inconnu");
    if (user === LOCAL_OWNER) return rec;
    if (user && rec.thread.owner !== user && !rec.thread.members.includes(user)) throw new MockHttpError(403, "pas membre de ce fil");
    return rec;
  }

  setWorking(threadId: string, working: boolean): void {
    const rec = this.threads.get(threadId);
    if (!rec || rec.thread.working === working) return;
    rec.thread.working = working;
    this.publishThread(threadId);
  }

  publishThread(threadId: string): void {
    const rec = this.threads.get(threadId);
    if (!rec) return;
    rec.thread.bubble_count = this.openBubblesOf(threadId).length;
    this.publish({ type: "thread.updated", thread: { ...rec.thread } });
  }

  sortedThreads(): Thread[] {
    for (const id of this.threads.keys()) {
      const rec = this.threads.get(id)!;
      rec.thread.bubble_count = this.openBubblesOf(id).length;
    }
    return [...this.threads.values()].map((r) => ({ ...r.thread })).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  openBubblesOf(threadId: string): Bubble[] {
    return [...this.bubbles.values()].filter((b) => b.thread_id === threadId && b.closed_at === null);
  }

  findThreadByTitle(term: string): MockThreadRecord | undefined {
    const n = normalize(term);
    const all = [...this.threads.values()];
    return all.find((r) => normalize(r.thread.title) === n) ?? all.find((r) => normalize(r.thread.title).startsWith(n)) ??
      all.find((r) => normalize(r.thread.title).includes(n));
  }

  // -- Approbations -------------------------------------------------------------------------

  pendingApprovalForThread(threadId: string): Approval | undefined {
    for (const a of this.approvals.values()) {
      if (a.thread_id === threadId && a.status === "pending") return a;
    }
    return undefined;
  }

  expireStaleApprovals(): void {
    const now = Date.now();
    for (const a of this.approvals.values()) {
      if (a.status === "pending" && Date.parse(a.expires_at) < now) {
        a.status = "expired";
      }
    }
  }
}

export function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** Identifiants du contrat BUBBLES.md : préfixe + 12 hex (`th_…`, `bu_…`). */
export function hexId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

/** minuscules, sans accents ni ponctuation superflue — pour interpréter le chat de démo. */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[«»"'’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function finalizeDecision(
  state: MockState,
  approval: Approval,
  decision: ApprovalDecisionKind,
  via: DecidedVia,
  decidedBy: string = MOCK_USER,
): void {
  const now = new Date().toISOString();
  approval.status = decision === "approve" ? "approved" : "rejected";
  approval.decided_by = decidedBy;
  approval.decided_via = via;
  approval.decided_at = now;
  // `approval.decided` publie le STATUT posé (`"approved"`/`"rejected"`), pas le verbe de la
  // requête — APPROVALS.md §2, `BaseApprovals.decide`.
  state.publish({ type: "approval.decided", approval_id: approval.id, decision: approval.status, by: decidedBy, via });
  // Exécution + tour de continuation (APPROVALS.md §2) — simulé : pas de vrai outil appelé.
  let summary: string;
  if (decision === "approve") {
    approval.status = "executed";
    approval.result_summary = `exécuté (démo, décidé par ${decidedBy} via ${via}).`;
    summary = `[Approbation] outil « ${approval.tool_name} » exécuté (décidé par ${decidedBy} via ${via}).`;
  } else {
    summary = `[Approbation] refusé par ${decidedBy} (via ${via}).`;
  }
  state.appendTurn(approval.thread_id, "", summary, { channel: "approval", sender: null });
  state.publishThread(approval.thread_id);
}
