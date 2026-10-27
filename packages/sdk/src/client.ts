/**
 * Client HTTP typé du contrat Nokker (CLIENT-API.md). Aucune dépendance au DOM : `fetch` est
 * injecté (par défaut `globalThis.fetch`, présent sous Node ≥ 18, dans tout navigateur et sous
 * React Native ≥ 0.71) — ça permet aussi de brancher un mock en test sans serveur réel.
 */
import type { FetchLike, RequestInitLike, ResponseLike } from "./events.js";
import { subscribeEvents, type EventSubscription } from "./events.js";
import { decodeUtf8Stream, parseJsonData, parseSSEFrames } from "./sse.js";
import type {
  Approval,
  ApprovalDecisionRequest,
  Challenge,
  ChatCompletion,
  ChatAttachment,
  ChatCompletionChunk,
  ChatMessage,
  ConfirmDeviceRequest,
  CreateLocalSessionRequest,
  CreateSessionRequest,
  CancelResult,
  Healthz,
  LocalApprovalDecision,
  LocalToolName,
  LocalCostTotals,
  LocalMemoryStatus,
  LocalToolOutcome,
  LocalApprovalResult,
  LocalSession,
  LocalSessionSummary,
  SkillsTrustResult,
  Device,
  EnrollDeviceRequest,
  NokkerEvent,
  SessionToken,
} from "./types.js";
import type {
  AcceptInvitationRequest,
  AcceptInvitationResult,
  ConnectorCard,
  ConnectorKind,
  ConnectorsListing,
  ConnectorTestResult,
  EmailLoginResult,
  EmailLoginStart,
  EmailLoginVerifyRequest,
  InvitationInfo,
  PutConnectorRequest,
  TelegramPairing,
  TermsDocument,
} from "./onboarding.js";
import type {
  AccountDeleteResult,
  AccountExport,
  AccountExportFile,
  AccountConsentResult,
  AccountInfo,
  AccountUsage,
  BillingStatus,
} from "./account.js";
import type { LocalProcess, LocalSecrets } from "./local-machine.js";
import type { PackDetail, PackInstallResult, PackRemoveResult, PackSummary } from "./packs.js";
import type { PageLocalityResult, PublishPageResult, UnpublishPageResult } from "./pages.js";
import type { LocalConnectorsListing, LocalMailCard, PutLocalMailRequest } from "./local-connectors.js";
import type { LocalMirrorPage, LocalMirrorProject, LocalMirrorStatus, MirrorSpace, QuarantinedNote } from "./mirror.js";
import type { AlertSource, AlertSourceSecret, BriefDelivery, Incident, IncidentState, PlanCard, PlanCardDetail, PlanCardInput, PlanContext, PlanProposal } from "./ops.js";
import type {
  MyInvitation,
  Project,
  ProjectAgentEntry,
  ProjectAuditEvent,
  ProjectBudgetCap,
  ProjectBudgetView,
  ProjectEntry,
  ProjectInvitation,
  ProjectMember,
  ProjectNote,
  ProjectRole,
  ProjectRules,
  ProjectSkill,
} from "./team.js";
import type {
  OidcCallbackRequest,
  OidcCallbackResult,
  OidcStart,
  OidcStartRequest,
  SsoAuditEvent,
  SsoBinding,
  SsoBindingInput,
  SsoConnection,
  SsoConnectionInput,
  SsoDomain,
} from "./sso.js";
import type { DeckView, LinkApproveResult, LinkDecision, LinkedMachines, LinkPending, RemoteApproval, RemoteDecision, RemoteDecisionProof } from "./link.js";
import type {
  LocalLinkStart,
  LocalLinkRemoved,
  LocalLinkStatus,
  LocalModelTestRequest,
  LocalModelTestResult,
  LocalSetup,
  PutLocalModelsRequest,
} from "./local-setup.js";
import type { Household, HouseholdApproval, HouseholdAttestation, HouseholdConsentRecord, HouseholdConsentText, HouseholdInvitation, HouseholdMember, HouseholdNote, HouseholdPolicy, HouseholdProfile, HouseholdQuarantined, ReceivedHouseholdInvitation } from "./household.js";
import type { PatchThreadRequest } from "./bubbles.js";
import type { CodeCredential, CodeSession, CodeSessionClosed, CodeSessionCreate, CodeSessionList, CodeSkillsTrusted, CodeToolName } from "./code-sessions.js";
import type {
  Agent,
  AgentRun,
  AgentRunPage,
  PatchAgentRequest,
  Bubble,
  CreateAgentRequest,
  KnownUser,
  BubbleActionResult,
  BubbleKind,
  CreateBubbleRequest,
  PageLink,
  PatchBubbleRequest,
  Preview,
  SessionMessageRequest,
  SessionMessageResult,
  ShareRequest,
  Thread,
  ThreadView,
  TransferMode,
  TransferResult,
} from "./bubbles.js";

export class NokkerApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "NokkerApiError";
  }

  /** Message d'erreur du serveur (`{"error": {"message"}}`), sinon le message HTTP. */
  get serverMessage(): string {
    const m = (this.body as { error?: { message?: unknown } } | undefined)?.error?.message;
    return typeof m === "string" ? m : this.message;
  }

  /** Code d'erreur machine : `{error: "<code>"}` (chaîne) ou `{error: {code}}`. */
  get code(): string | undefined {
    const e = (this.body as { error?: unknown } | undefined)?.error;
    if (typeof e === "string") return e;
    const c = (e as { code?: unknown } | null | undefined)?.code;
    return typeof c === "string" ? c : undefined;
  }

  /** 429 `export_limit` : instant ISO où une nouvelle demande sera acceptée. */
  get retryAt(): string | undefined {
    const r = (this.body as { retry_at?: unknown } | undefined)?.retry_at;
    return typeof r === "string" ? r : undefined;
  }

  /** 409 `if_version` périmé : version courante de la bulle (noyau §8), pour rejouer le PATCH. */
  get currentVersion(): number | undefined {
    const v = (this.body as { error?: { current_version?: unknown } } | undefined)?.error?.current_version;
    return typeof v === "number" ? v : undefined;
  }
}

export interface NokkerClientOptions {
  baseUrl: string;
  /** Jeton de session (`Authorization: Bearer <...>`). Peut être mis à jour après `/v1/sessions`. */
  token?: string;
  fetchImpl?: FetchLike;
  userAgent?: string;
}

function defaultFetch(): FetchLike {
  const g = globalThis as unknown as { fetch?: FetchLike };
  if (!g.fetch) {
    throw new Error(
      "Aucun fetch global disponible — passer `fetchImpl` explicitement (Node < 18, ou runtime RN sans polyfill).",
    );
  }
  // Lié à globalThis : `this.fetchImpl(...)` appellerait sinon le fetch du navigateur avec `this` = client
  // (« Illegal invocation » dans Chrome).
  return g.fetch.bind(globalThis);
}

export class NokkerClient {
  private baseUrl: string;
  private token: string | undefined;
  private fetchImpl: FetchLike;
  private userAgent: string | undefined;

  constructor(opts: NokkerClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? defaultFetch();
    this.userAgent = opts.userAgent;
  }

  setToken(token: string): void {
    this.token = token;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (this.userAgent) h["User-Agent"] = this.userAgent;
    return h;
  }

  private async request<T>(path: string, init: RequestInitLike = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(init.headers), ...(init.body ? { "Content-Type": "application/json" } : {}) },
    });
    const bodyText = await readAllText(res);
    let parsed: unknown = undefined;
    if (bodyText) {
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        parsed = bodyText;
      }
    }
    if (!res.ok) {
      throw new NokkerApiError(`${path} → ${res.status}`, res.status, parsed);
    }
    return parsed as T;
  }

  // -- Sessions / appareils ------------------------------------------------

  async createSession(req: CreateSessionRequest): Promise<SessionToken> {
    const token = await this.request<SessionToken>("/v1/sessions", { method: "POST", body: JSON.stringify(req) });
    this.token = token.token;
    return token;
  }

  async enrollDevice(req: EnrollDeviceRequest): Promise<Device> {
    return this.request<Device>("/v1/devices", { method: "POST", body: JSON.stringify(req) });
  }

  /** `POST /v1/devices/{id}/confirm` (APPROVALS.md §3.1) — confirme un appareil `pending` par TOTP
   * déjà enrôlé côté serveur (alternative à `python -m nokker devices approve <code>` sur l'hôte). */
  async confirmDevice(deviceId: string, req: ConfirmDeviceRequest): Promise<Device> {
    return this.request<Device>(`/v1/devices/${encodeURIComponent(deviceId)}/confirm`, {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  /** `POST /v1/devices/{id}/session-challenge` (APPROVALS.md §3.6) — ROUTE RÉELLE du noyau depuis
   * le 18.10.2026 (plus une extension du mock) : aucune identité requise, c'est ce défi signé qui en
   * établit une. */
  async requestSessionChallenge(deviceId: string): Promise<Challenge> {
    return this.request<Challenge>(`/v1/devices/${encodeURIComponent(deviceId)}/session-challenge`, { method: "POST" });
  }

  /** @deprecated renommée `requestSessionChallenge` — la route est désormais réelle côté noyau
   * (APPROVALS.md §3.6), ce n'est plus une extension du mock. Alias gardé pour ne pas casser un
   * appelant existant. */
  async requestSessionChallengeMockExtension(deviceId: string): Promise<Challenge> {
    return this.requestSessionChallenge(deviceId);
  }

  /** HORS CONTRAT, mock uniquement : jeton de démo sans appareil (navigateur hors contexte sécurisé,
   * où ni WebCrypto ni WebAuthn n'existent). Le noyau réel n'a pas — et ne doit pas avoir — cette route. */
  async demoSessionMockExtension(): Promise<SessionToken> {
    const token = await this.request<SessionToken>("/v1/dev/demo-session", { method: "POST" });
    this.token = token.token;
    return token;
  }

  /** `GET /healthz` (sans jeton). */
  async healthz(signal?: AbortSignal): Promise<Healthz> {
    return this.request<Healthz>("/healthz", signal ? { signal } : {});
  }

  // -- Session de code locale (LOKKAL.md §7.4) ------------------------------------------

  /** `POST /v1/local/sessions` — 403 si `cwd` n'est pas sous une racine déclarée. `resume` reprend un fil. */
  async createLocalSession(req: CreateLocalSessionRequest): Promise<LocalSession> {
    return this.request<LocalSession>("/v1/local/sessions", { method: "POST", body: JSON.stringify(req) });
  }

  /** Sessions ouvertes ET racines où une session peut s'ouvrir (`roots`, noyau 0bb77d3 ; absent avant : `[]`). Le web
   * servi par Lokkal (local ou passerelle) s'en sert pour son « + session de code ». */
  async listLocalSessionsAndRoots(): Promise<{ sessions: LocalSessionSummary[]; roots: string[] }> {
    const r = await this.request<LocalSessionSummary[] | { sessions?: LocalSessionSummary[]; roots?: string[] }>("/v1/local/sessions");
    return Array.isArray(r) ? { sessions: r, roots: [] } : { sessions: r.sessions ?? [], roots: r.roots ?? [] };
  }

  /** Le noyau répond `{"sessions": [...]}` ; un tableau nu (anciens mocks) est accepté aussi. */
  async listLocalSessions(): Promise<LocalSessionSummary[]> {
    const r = await this.request<LocalSessionSummary[] | { sessions?: LocalSessionSummary[] }>("/v1/local/sessions");
    return Array.isArray(r) ? r : (r.sessions ?? []);
  }

  /** `GET /v1/local/approvals` (jeton local) : cartes en attente des sessions locales, avec `suggested_rules` calculées
   * par le noyau. Accepte `{approvals: [...]}` et un tableau nu. */
  async listLocalApprovals(): Promise<Approval[]> {
    const r = await this.request<Approval[] | { approvals?: Approval[] }>("/v1/local/approvals");
    return Array.isArray(r) ? r : (r.approvals ?? []);
  }

  /** `POST /v1/local/approvals/{id}/decide` — décision locale (once|session|always). `POST /v1/approvals/{id}/decision`
   * reste réservé aux preuves d'appareil (web). */
  async decideLocalApproval(approvalId: string, req: LocalApprovalDecision): Promise<LocalApprovalResult> {
    return this.request<LocalApprovalResult>(`/v1/local/approvals/${encodeURIComponent(approvalId)}/decide`, {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  /** `POST /v1/local/tools/call` (jeton local, fil de session locale) : 200 `{content, is_error}` ou 202 `{approval_id}` si
   * l'effet exige une carte (le résultat suit dans `tool.result`, `approval_id`). Un refus par règle ou mode plan est un 200
   * `is_error: true`. 403 : outil hors liste blanche ; 404 : fil non local ; 400 : `todo` avec des arguments ; 409 : tour en cours.
   * Route PROPOSÉE : le chemin vit dans `LOCAL_TOOL_CALL_PATH`. */
  async callLocalTool(threadId: string, name: LocalToolName, args: Record<string, unknown> = {}): Promise<LocalToolOutcome> {
    return this.request<LocalToolOutcome>(LOCAL_TOOL_CALL_PATH, {
      method: "POST",
      body: JSON.stringify({ thread_id: threadId, name, arguments: args }),
    });
  }

  /** `GET /v1/local/cost` (jeton local, lecture seule, LOKKAL.md §7.8) : totaux de la session (fil + sous-agents) et du
   * jour UTC. Sans `threadId`, `session` vaut `null`. 404 : noyau sans journal des coûts. */
  async getLocalCost(threadId?: string, day?: string): Promise<LocalCostTotals> {
    const q = new URLSearchParams();
    if (threadId) q.set("thread_id", threadId);
    if (day) q.set("day", day);
    const qs = q.toString();
    return this.request<LocalCostTotals>(`/v1/local/cost${qs ? `?${qs}` : ""}`);
  }

  /** `GET /v1/local/memory` (jeton local, LOKKAL.md §7.13.6) : état de la mémoire longue (contrôle de `nokker doctor`).
   * 401 hors jeton local ; 404 : noyau d'avant la mémoire directe. */
  async getLocalMemory(signal?: AbortSignal): Promise<LocalMemoryStatus> {
    return this.request<LocalMemoryStatus>("/v1/local/memory", signal ? { signal } : {});
  }

  /** `POST /v1/local/skills/trust {thread_id, sha256}` (jeton local, LOKKAL.md §7.21.4) : faire confiance aux skills du
   * dépôt de ce fil, tels que relus (`sha256` rendue à l'ouverture ou par `skill.untrusted`). */
  async trustProjectSkills(threadId: string, sha256: string): Promise<SkillsTrustResult> {
    return this.request<SkillsTrustResult>("/v1/local/skills/trust", {
      method: "POST",
      body: JSON.stringify({ thread_id: threadId, sha256 }),
    });
  }

  /** `POST /v1/threads/{id}/cancel` (202) — arrête le tour en cours ; le flux se termine par `turn.done {cancelled: true}`. */
  async cancelTurn(threadId: string): Promise<CancelResult> {
    return this.request<CancelResult>(`/v1/threads/${encodeURIComponent(threadId)}/cancel`, { method: "POST" });
  }

  async listDevices(): Promise<Device[]> {
    return this.request<Device[]>("/v1/devices");
  }

  async deleteDevice(id: string): Promise<void> {
    await this.request<unknown>(`/v1/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  // -- Fils (BUBBLES.md §1) -------------------------------------------------------

  /** Fils de l'utilisateur, triés par `updated_at` desc. */
  async listThreads(): Promise<Thread[]> {
    return this.request<Thread[]>("/v1/threads");
  }

  async createThread(title: string): Promise<Thread> {
    return this.request<Thread>("/v1/threads", { method: "POST", body: JSON.stringify({ title }) });
  }

  async getThread(id: string, opts: { before?: number; limit?: number } = {}): Promise<ThreadView> {
    const qs = new URLSearchParams();
    if (opts.before !== undefined) qs.set("before", String(opts.before));
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    const q = qs.toString();
    return this.request<ThreadView>(`/v1/threads/${encodeURIComponent(id)}${q ? `?${q}` : ""}`);
  }

  /** `members` : propriétaire seulement (403), utilisateurs connus seulement (400). */
  async patchThread(id: string, patch: PatchThreadRequest): Promise<Thread> {
    return this.request<Thread>(`/v1/threads/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
  }

  /** Supprime la session (propriétaire seulement, 403 sinon). Ses bulles ouvertes sont fermées ; événement `thread.deleted`. */
  async deleteThread(id: string): Promise<{ deleted: string }> {
    return this.request<{ deleted: string }>(`/v1/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** §4 — une session écrit à une autre (`ask: true` lance un tour dans `toThread`, réponse 202). Il faut être
   * membre des deux fils (403 sinon) ; un fil ne s'écrit pas à lui-même (400). */
  async sendSessionMessage(toThread: string, req: SessionMessageRequest): Promise<SessionMessageResult> {
    return this.request<SessionMessageResult>(`/v1/threads/${encodeURIComponent(toThread)}/messages`, {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  // -- Bulles (BUBBLES.md §2-§3) -----------------------------------------------------

  async listBubbles(threadId: string, opts: { includeClosed?: boolean } = {}): Promise<Bubble[]> {
    const q = opts.includeClosed ? "?include_closed=1" : "";
    return this.request<Bubble[]>(`/v1/threads/${encodeURIComponent(threadId)}/bubbles${q}`);
  }

  async createBubble<K extends BubbleKind>(threadId: string, req: CreateBubbleRequest<K>): Promise<Bubble> {
    return this.request<Bubble>(`/v1/threads/${encodeURIComponent(threadId)}/bubbles`, {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async getBubble(id: string): Promise<Bubble> {
    return this.request<Bubble>(`/v1/bubbles/${encodeURIComponent(id)}`);
  }

  /** `if_version` → 409 (`NokkerApiError.status === 409`) si la bulle a bougé entre-temps. */
  async patchBubble(id: string, patch: PatchBubbleRequest): Promise<Bubble> {
    return this.request<Bubble>(`/v1/bubbles/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
  }

  async closeBubble(id: string): Promise<Bubble> {
    return this.request<Bubble>(`/v1/bubbles/${encodeURIComponent(id)}/close`, { method: "POST" });
  }

  /** Déplacer (`move`, même id) ou copier (`copy`, nouvel id) vers un autre fil — modifie son contexte au
   * prochain tour. Même fil → 400 ; une `notify` ne se transfère pas (400). */
  async transferBubble(id: string, toThread: string, mode: TransferMode): Promise<TransferResult> {
    return this.request<TransferResult>(`/v1/bubbles/${encodeURIComponent(id)}/transfer`, {
      method: "POST",
      body: JSON.stringify({ to_thread: toThread, mode }),
    });
  }

  /** LOKKAL §7.6 : octets d'une image d'un message (membres du fil). Avec l'en-tête d'auth : une balise `<img>` seule
   * ne l'enverrait pas — le web en fait une URL `blob:`. */
  async getThreadImage(threadId: string, sha256: string): Promise<Blob> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/threads/${encodeURIComponent(threadId)}/images/${encodeURIComponent(sha256)}`, { headers: this.headers() });
    if (!res.ok) throw new NokkerApiError(`image ${sha256.slice(0, 8)} → ${res.status}`, res.status, undefined);
    return await (res as unknown as Response).blob();
  }

  /** Remplace la liste de partage (membres = personnes, threads = fils). */
  async shareBubble(id: string, req: ShareRequest): Promise<Bubble> {
    return this.request<Bubble>(`/v1/bubbles/${encodeURIComponent(id)}/share`, { method: "POST", body: JSON.stringify(req) });
  }

  /** BUBBLES.md §10.3 — lien d'une page, demandé au Lokkal sur l'origine courante. En local : lien signé
   * `/v1/pages/{id}?exp=&sig=` (`embed` ignoré). Par la passerelle : le Lokkal obtient de nokker.ai un lien
   * `https://<nom>--pages.nokker.app/_auth?token=…` à USAGE UNIQUE (`embed` pour l'`<iframe>`) ; 502 si nokker.ai est
   * injoignable. Un lien par usage (iframe, onglet), redemandé à chaque montage et à chaque `bubble.updated`. */
  async getPageLink(pageId: string, opts: { embed?: boolean; download?: boolean } = {}): Promise<PageLink> {
    const body: Record<string, boolean> = { embed: opts.embed === true };
    // `download` : la page revient en pièce jointe (`Content-Disposition: attachment`), proposé à dev le 24.10.
    if (opts.download) body.download = true;
    return this.request<PageLink>(`/v1/pages/${encodeURIComponent(pageId)}/link`, { method: "POST", body: JSON.stringify(body) });
  }

  /** Depuis app.nokker.ai (« mes machines ») : nokker.ai signe un jeton pages (60 s, usage unique) pour la page d'une
   * machine liée ; `embed` pour l'`<iframe>` (le relais redirige vers une capacité d'URL, sans cookie tiers). Un lien
   * par usage : jamais réutilisé entre l'iframe et l'onglet. */
  async getGatewayPageLink(machineId: string, pageId: string, opts: { embed?: boolean } = {}): Promise<PageLink> {
    return this.request<PageLink>(`/v1/link/machines/${encodeURIComponent(machineId)}/pages-token`, {
      method: "POST",
      body: JSON.stringify({ page_id: pageId, embed: opts.embed === true }),
    });
  }

  /** Publier une page (§7.26) : 202 avec la carte forte à signer ; 409 `local_page` | `not_linked`, 403
   * `pages_public_not_allowed`, 400 index non booléen. */
  async publishPage(pageId: string, opts: { index?: boolean } = {}): Promise<PublishPageResult> {
    return this.request<PublishPageResult>(`/v1/pages/${encodeURIComponent(pageId)}/publish`, { method: "POST", body: JSON.stringify({ index: opts.index === true }) });
  }

  /** Dépublier : immédiat, sans carte ; l'URL publique meurt pour toujours. */
  async unpublishPage(pageId: string): Promise<UnpublishPageResult> {
    return this.request<UnpublishPageResult>(`/v1/pages/${encodeURIComponent(pageId)}/unpublish`, { method: "POST" });
  }

  /** Épingler la page sur la machine (`local` : ni copie ni publication ; une page publique est dépubliée). */
  async setPageLocality(pageId: string, locality: "local" | null): Promise<PageLocalityResult> {
    return this.request<PageLocalityResult>(`/v1/pages/${encodeURIComponent(pageId)}/locality`, { method: "PUT", body: JSON.stringify({ locality }) });
  }

  /** Déclenche une action (voir `BubbleActionResult`) : notify → fermée (+ `goto`) ; autre bulle → 202, un tour
   * du fil en tâche de fond. Action absente de la bulle → 404. */
  async bubbleAction(id: string, actionId: string): Promise<BubbleActionResult> {
    return this.request<BubbleActionResult>(
      `/v1/bubbles/${encodeURIComponent(id)}/actions/${encodeURIComponent(actionId)}`,
      { method: "POST" },
    );
  }

  // -- Onboarding du testeur (publiques : pas encore de session) ------------------------

  /** `GET /v1/onboarding/invitation?t=` — `{valid:false}` pour un jeton inconnu, expiré ou déjà utilisé. */
  async getInvitation(token: string): Promise<InvitationInfo> {
    return this.request<InvitationInfo>(`/v1/onboarding/invitation?t=${encodeURIComponent(token)}`);
  }

  async getTerms(lang: string): Promise<TermsDocument> {
    return this.request<TermsDocument>(`/v1/onboarding/terms?lang=${encodeURIComponent(lang)}`);
  }

  /** `POST /v1/onboarding/accept` — conditions + clé vérifiées avant de consommer le jeton. */
  async acceptInvitation(req: AcceptInvitationRequest): Promise<AcceptInvitationResult> {
    return this.request<AcceptInvitationResult>("/v1/onboarding/accept", { method: "POST", body: JSON.stringify(req) });
  }

  // -- Connexion par code mail (publiques) ---------------------------------------------------

  /** `POST /v1/auth/email/start` — répond toujours `{sent:true}` ; 429 quand la limite par adresse/IP est atteinte. */
  async startEmailLogin(email: string, lang: string): Promise<EmailLoginStart> {
    return this.request<EmailLoginStart>("/v1/auth/email/start", { method: "POST", body: JSON.stringify({ email, lang }) });
  }

  /** `POST /v1/auth/email/verify` — 401 `invalid_code` pour tout échec (faux, expiré, utilisé, adresse inconnue). */
  async verifyEmailCode(req: EmailLoginVerifyRequest): Promise<EmailLoginResult> {
    return this.request<EmailLoginResult>("/v1/auth/email/verify", { method: "POST", body: JSON.stringify(req) });
  }

  /** `POST /v1/auth/google/exchange` — échange le ticket posé par le retour OIDC contre un appareil actif. */
  async exchangeGoogleTicket(req: { ticket: string; name: string; public_key_spki: string }): Promise<EmailLoginResult> {
    return this.request<EmailLoginResult>("/v1/auth/google/exchange", { method: "POST", body: JSON.stringify(req) });
  }

  // -- Mon compte et abonnement (session requise) ----------------------------------------------

  /** nokker.ai, page `/gateway/authorize` : code d'autorisation (60 s, usage unique, lié au compte, à l'hôte et au
   * défi PKCE) pour se connecter à `<nom>.nokker.app`. 403 : cette machine n'est pas au compte. */
  async gatewayAuthorize(host: string, codeChallenge: string): Promise<{ code: string; redirect: string; expires_in: number }> {
    return this.request<{ code: string; redirect: string; expires_in: number }>("/v1/gateway/authorize", {
      method: "POST",
      body: JSON.stringify({ host, code_challenge: codeChallenge, code_challenge_method: "S256" }),
    });
  }

  async getAccount(): Promise<AccountInfo> {
    return this.request<AccountInfo>("/v1/account");
  }

  async setAccountConsent(scope: "training", granted: boolean): Promise<AccountConsentResult> {
    return this.request<AccountConsentResult>("/v1/account/consent", { method: "PUT", body: JSON.stringify({ scope, granted }) });
  }

  async getAccountUsage(): Promise<AccountUsage> {
    return this.request<AccountUsage>("/v1/account/usage");
  }

  /** Page `/link` : la machine derrière un code, SANS effet de bord (404 : code inconnu ou expiré, 429 : trop d'essais). */
  async getLinkPending(code: string): Promise<LinkPending> {
    return this.request<LinkPending>(`/v1/link/pending?code=${encodeURIComponent(code)}`);
  }

  /** Approuve ou refuse la liaison d'une machine au compte connecté (404 : code expiré entre-temps). */
  async decideLink(userCode: string, decision: LinkDecision): Promise<LinkApproveResult> {
    return this.request<LinkApproveResult>("/v1/link/approve", { method: "POST", body: JSON.stringify({ user_code: userCode, decision }) });
  }

  /** « Mes machines » : les machines Lokkal liées au compte connecté (les révoquées n'y sont plus). */
  async listMachines(): Promise<LinkedMachines> {
    return this.request<LinkedMachines>("/v1/link/machines");
  }

  /** Carte forte d'une machine liée, à signer depuis cet appareil (page `/approve/<machine>/<approbation>`). */
  async getMachineApproval(machineId: string, approvalId: string): Promise<RemoteApproval> {
    return this.request<RemoteApproval>(`/v1/link/machines/${encodeURIComponent(machineId)}/approvals/${encodeURIComponent(approvalId)}`);
  }

  /** Transmet la décision signée : 202 `{status: "forwarded"}` ; le statut final vient du Lokkal. */
  async decideMachineApproval(machineId: string, approvalId: string, decision: RemoteDecision, proof: RemoteDecisionProof): Promise<{ status: string }> {
    return this.request<{ status: string }>(
      `/v1/link/machines/${encodeURIComponent(machineId)}/approvals/${encodeURIComponent(approvalId)}/decision`,
      { method: "POST", body: JSON.stringify({ decision, proof }) },
    );
  }

  /** X15 : deck de toutes les machines (404 tant que `cloud_link.crew` est éteint : le web n'affiche pas la vue). */
  async getDeck(): Promise<DeckView> {
    return this.request<DeckView>("/v1/link/deck");
  }

  /** X15 : déménager un agent (`web`, `auto` ou `mc_…`). 409 `{error: {message, missing: [...]}}` : ce qui manque. */
  async moveAgent(id: string, to: string): Promise<Agent> {
    return this.request<Agent>(`/v1/agents/${encodeURIComponent(id)}/move`, { method: "POST", body: JSON.stringify({ to }) });
  }

  // -- Lokkal local (jeton local) : processus X6, coffre X4, hooks X3 ------------------------

  async listLocalProcesses(): Promise<{ processes: LocalProcess[] }> {
    return this.request<{ processes: LocalProcess[] }>("/v1/local/processes");
  }

  /** Lien signé (1 h) vers l'aperçu du port d'un processus ; 404 sans port ou arrêté. À ouvrir en iframe sandbox. */
  async getProcessLink(id: string): Promise<{ url: string; expires_at: string | number; port: number }> {
    return this.request<{ url: string; expires_at: string | number; port: number }>(`/v1/local/processes/${encodeURIComponent(id)}/link`, { method: "POST" });
  }

  async listLocalSecrets(): Promise<LocalSecrets> {
    return this.request<LocalSecrets>("/v1/local/secrets");
  }

  /** La valeur part une fois et n'est jamais renvoyée. Par la passerelle : 403 (elle traverserait le relais). */
  async putLocalSecret(name: string, value: string): Promise<{ name: string; updated_at: string | number }> {
    return this.request<{ name: string; updated_at: string | number }>(`/v1/local/secrets/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value }) });
  }

  async deleteLocalSecret(name: string): Promise<{ name: string; deleted: true }> {
    return this.request<{ name: string; deleted: true }>(`/v1/local/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
  }

  // -- Packs d'agents (LOKKAL §7.30 ; web : drapeau packs_web, éteint → 404) -------------------------

  async listPacks(): Promise<{ packs: PackSummary[]; refused?: string[] }> {
    return this.request<{ packs: PackSummary[]; refused?: string[] }>("/v1/packs");
  }
  async getPack(name: string): Promise<PackDetail> {
    return this.request<PackDetail>(`/v1/packs/${encodeURIComponent(name)}`);
  }
  /** 409 `machine_only` (avec `machine`) | `invalid_pack`, 422 `scan_refused` (`report`), 503 `no_scanner`, 404
   * `unknown_pack` | `unknown_thread`. Avec `thread_id` : cartes `agent_draft` posées ; `handoff` : relais vers la machine. */
  async installPack(name: string, req: { thread_id?: string; handoff?: boolean; bind?: Record<string, string> } = {}): Promise<PackInstallResult> {
    return this.request<PackInstallResult>(`/v1/packs/${encodeURIComponent(name)}/install`, { method: "POST", body: JSON.stringify(req) });
  }
  async proposePack(name: string, req: { thread_id: string; templates?: string[] }): Promise<{ pack: string; proposed: { template: string; bubble_id: string }[]; to_propose?: PackInstallResult["to_propose"] }> {
    return this.request(`/v1/packs/${encodeURIComponent(name)}/propose`, { method: "POST", body: JSON.stringify(req) });
  }
  /** Idempotent ; les agents créés depuis le pack restent (carte `pack_agents` dans `thread_id`). */
  async removePack(name: string, threadId?: string): Promise<PackRemoveResult> {
    return this.request<PackRemoveResult>(`/v1/packs/${encodeURIComponent(name)}${threadId ? `?thread_id=${encodeURIComponent(threadId)}` : ""}`, { method: "DELETE" });
  }
  /** Lokkal (jeton local) : `pack_list`. */
  async listLocalPacks(): Promise<{ packs: Omit<PackSummary, "web" | "machine">[]; refused?: string[] }> {
    return this.request<{ packs: Omit<PackSummary, "web" | "machine">[]; refused?: string[] }>("/v1/local/packs");
  }
  /** Lokkal (jeton local ; par la passerelle : 403) : même retrait que l'outil `pack_remove`. */
  async removeLocalPack(name: string, threadId?: string): Promise<PackRemoveResult> {
    return this.request<PackRemoveResult>(`/v1/local/packs/${encodeURIComponent(name)}/remove`, { method: "POST", body: JSON.stringify(threadId ? { thread_id: threadId } : {}) });
  }

  // -- Boîte mail de la machine (LOKKAL §7.25, jeton local ; passerelle : 403) -------------------

  async listLocalConnectors(): Promise<LocalConnectorsListing> {
    return this.request<LocalConnectorsListing>("/v1/local/connectors");
  }
  /** Testée (IMAP puis SMTP) avant d'être rangée : 400 réglages ou secret, 422 identifiants refusés, 502 injoignable. */
  async putLocalMail(req: PutLocalMailRequest): Promise<LocalMailCard> {
    return this.request<LocalMailCard>("/v1/local/connectors/mail", { method: "PUT", body: JSON.stringify(req) });
  }
  async testLocalMail(): Promise<ConnectorTestResult> {
    return this.request<ConnectorTestResult>("/v1/local/connectors/mail/test", { method: "POST" });
  }
  async deleteLocalMail(): Promise<{ revoked: boolean }> {
    return this.request<{ revoked: boolean }>("/v1/local/connectors/mail", { method: "DELETE" });
  }

  // -- Miroir de la machine (LOKKAL §7.23, jeton local) --------------------------------------------

  async getLocalMirror(): Promise<LocalMirrorStatus> {
    return this.request<LocalMirrorStatus>("/v1/local/mirror");
  }
  /** 202 avec l'état ; 409 en pause (copies effacées : reprendre d'abord). */
  async resyncLocalMirror(): Promise<LocalMirrorStatus> {
    return this.request<LocalMirrorStatus>("/v1/local/mirror/resync", { method: "POST" });
  }
  /** Reprise après effacement des copies : tout est renvoyé. */
  async resumeLocalMirror(): Promise<LocalMirrorStatus> {
    return this.request<LocalMirrorStatus>("/v1/local/mirror/resume", { method: "POST" });
  }
  async listLocalMirrorPages(): Promise<{ pages: LocalMirrorPage[]; space: MirrorSpace | null }> {
    return this.request<{ pages: LocalMirrorPage[]; space: MirrorSpace | null }>("/v1/local/mirror/pages");
  }
  /** « Garder en ligne » : copie servie machine éteinte (400 corps, 404 page inconnue, 409 `local_page`). */
  async setLocalMirrorPage(pageId: string, mirror: boolean): Promise<{ page_id: string; mirror: boolean }> {
    return this.request<{ page_id: string; mirror: boolean }>(`/v1/local/mirror/pages/${encodeURIComponent(pageId)}`, { method: "PUT", body: JSON.stringify({ mirror }) });
  }
  async listLocalMirrorProjects(): Promise<{ projects: LocalMirrorProject[] }> {
    return this.request<{ projects: LocalMirrorProject[] }>("/v1/local/mirror/projects");
  }
  async setLocalMirrorProject(project: string, mirror: boolean): Promise<{ project: string; mirror: boolean }> {
    return this.request<{ project: string; mirror: boolean }>(`/v1/local/mirror/projects/${encodeURIComponent(project)}`, { method: "PUT", body: JSON.stringify({ mirror }) });
  }

  /** Confiance aux hooks du dépôt de ce fil, pour CETTE empreinte (409 si le bloc a changé depuis l'ouverture). */
  async trustProjectHooks(threadId: string, sha256: string): Promise<{ thread_id: string; root: string; sha256: string; trusted: true }> {
    return this.request<{ thread_id: string; root: string; sha256: string; trusted: true }>("/v1/local/hooks/trust", {
      method: "POST",
      body: JSON.stringify({ thread_id: threadId, sha256 }),
    });
  }

  // -- X17 : projets d'équipe (session du compte ; 404 tant que le drapeau `team` est éteint) --------------

  private pj(id: string, tail = ""): string {
    return `/v1/projects/${encodeURIComponent(id)}${tail}`;
  }
  /** Un projet « SSO obligatoire » sans connexion SSO récente arrive réduit (`GatedProject`, §7.24). */
  async listProjects(): Promise<{ projects: ProjectEntry[]; invitations: number }> {
    return this.request<{ projects: ProjectEntry[]; invitations: number }>("/v1/projects");
  }
  async createProject(req: { name: string; description?: string }): Promise<Project> {
    return this.request<Project>("/v1/projects", { method: "POST", body: JSON.stringify(req) });
  }
  async getProject(id: string): Promise<Project> {
    return this.request<Project>(this.pj(id));
  }
  async patchProject(id: string, req: Partial<Pick<Project, "name" | "description" | "budget" | "mirror">> & { repos?: string[] }): Promise<Project> {
    return this.request<Project>(this.pj(id), { method: "PATCH", body: JSON.stringify(req) });
  }
  async deleteProject(id: string): Promise<{ deleted: true }> {
    return this.request<{ deleted: true }>(this.pj(id), { method: "DELETE" });
  }
  async listProjectMembers(id: string): Promise<{ members: ProjectMember[] }> {
    return this.request<{ members: ProjectMember[] }>(this.pj(id, "/members"));
  }
  async setProjectMemberRole(id: string, account: string, role: ProjectRole): Promise<ProjectMember> {
    return this.request<ProjectMember>(this.pj(id, `/members/${encodeURIComponent(account)}`), { method: "PATCH", body: JSON.stringify({ role }) });
  }
  async removeProjectMember(id: string, account: string): Promise<{ removed: true }> {
    return this.request<{ removed: true }>(this.pj(id, `/members/${encodeURIComponent(account)}`), { method: "DELETE" });
  }
  async listProjectInvitations(id: string): Promise<{ invitations: ProjectInvitation[] }> {
    return this.request<{ invitations: ProjectInvitation[] }>(this.pj(id, "/invitations"));
  }
  async inviteToProject(id: string, email: string, role: ProjectRole = "member"): Promise<ProjectInvitation> {
    return this.request<ProjectInvitation>(this.pj(id, "/invitations"), { method: "POST", body: JSON.stringify({ email, role }) });
  }
  async revokeProjectInvitation(id: string, iv: string): Promise<{ revoked: true }> {
    return this.request<{ revoked: true }>(this.pj(id, `/invitations/${encodeURIComponent(iv)}`), { method: "DELETE" });
  }
  async listMyInvitations(): Promise<{ invitations: MyInvitation[] }> {
    return this.request<{ invitations: MyInvitation[] }>("/v1/projects/invitations");
  }
  async answerInvitation(iv: string, accept: boolean): Promise<Project | { declined: true }> {
    return this.request<Project | { declined: true }>(`/v1/projects/invitations/${encodeURIComponent(iv)}/${accept ? "accept" : "decline"}`, { method: "POST" });
  }
  async listProjectSkills(id: string): Promise<{ skills: ProjectSkill[] }> {
    return this.request<{ skills: ProjectSkill[] }>(this.pj(id, "/skills"));
  }
  async putProjectSkill(id: string, name: string, req: { source: string; description?: string; requires_local?: boolean }): Promise<ProjectSkill> {
    return this.request<ProjectSkill>(this.pj(id, `/skills/${encodeURIComponent(name)}`), { method: "PUT", body: JSON.stringify(req) });
  }
  async removeProjectSkill(id: string, name: string): Promise<{ removed: true }> {
    return this.request<{ removed: true }>(this.pj(id, `/skills/${encodeURIComponent(name)}`), { method: "DELETE" });
  }
  async getProjectRules(id: string): Promise<{ rules: ProjectRules }> {
    return this.request<{ rules: ProjectRules }>(this.pj(id, "/rules"));
  }
  /** Restreindre seulement : `allow` ou `mode: auto` → 400 `rules_widen`. */
  async putProjectRules(id: string, rules: ProjectRules): Promise<{ rules: ProjectRules }> {
    return this.request<{ rules: ProjectRules }>(this.pj(id, "/rules"), { method: "PUT", body: JSON.stringify(rules) });
  }
  async listProjectSecrets(id: string): Promise<{ secrets: { name: string; description?: string | null }[] }> {
    return this.request<{ secrets: { name: string; description?: string | null }[] }>(this.pj(id, "/secrets"));
  }
  /** Un NOM et sa description, jamais une valeur (un corps avec `value` → 400 `secret_value_refused`). */
  async putProjectSecret(id: string, name: string, description?: string): Promise<{ name: string; description?: string | null }> {
    return this.request<{ name: string; description?: string | null }>(this.pj(id, `/secrets/${encodeURIComponent(name)}`), { method: "PUT", body: JSON.stringify({ description }) });
  }
  async removeProjectSecret(id: string, name: string): Promise<{ removed: true }> {
    return this.request<{ removed: true }>(this.pj(id, `/secrets/${encodeURIComponent(name)}`), { method: "DELETE" });
  }
  /** Projet en miroir seulement (409 `mirror_off` sinon). */
  async listProjectNotes(id: string, since?: string): Promise<{ notes: ProjectNote[]; cursor: string | number | null }> {
    return this.request<{ notes: ProjectNote[]; cursor: string | number | null }>(this.pj(id, `/notes${since ? `?since=${encodeURIComponent(since)}` : ""}`));
  }
  /** Versions remplacées ou oubliées des notes d'un projet d'équipe (maintainer ; §7.15, §7.23). */
  async listProjectQuarantine(id: string): Promise<{ quarantine: QuarantinedNote[] }> {
    return this.request<{ quarantine: QuarantinedNote[] }>(this.pj(id, "/notes/quarantine"));
  }
  /** Remet une version de la quarantaine en version courante (maintainer) ; la version courante y part à son tour.
   * 404 ligne inconnue, 409 `already_current`. */
  async restoreQuarantinedNote(id: string, quarantineId: number | string): Promise<{ note: ProjectNote }> {
    return this.request<{ note: ProjectNote }>(this.pj(id, `/notes/quarantine/${encodeURIComponent(String(quarantineId))}/restore`), { method: "POST" });
  }
  /** Les agents rattachés au projet par TOUS ses membres (§7.27.2) : les miens complets, ceux des autres réduits. */
  async listProjectAgents(id: string): Promise<{ agents: ProjectAgentEntry[] }> {
    return this.request<{ agents: ProjectAgentEntry[] }>(this.pj(id, "/agents"));
  }
  /** Son propriétaire, ou l'owner du projet (journalisé) ; 403 sinon, 404 hors du projet. */
  async disarmProjectAgent(id: string, agentId: string): Promise<{ agent: ProjectAgentEntry }> {
    return this.request<{ agent: ProjectAgentEntry }>(this.pj(id, `/agents/${encodeURIComponent(agentId)}/disarm`), { method: "POST" });
  }
  async getProjectBudget(id: string): Promise<ProjectBudgetView> {
    return this.request<ProjectBudgetView>(this.pj(id, "/budget"));
  }
  /** Owner ou maintainer ; `daily` et/ou `monthly`. */
  async putProjectBudget(id: string, budget: Partial<ProjectBudgetCap>): Promise<{ budget: ProjectBudgetCap }> {
    return this.request<{ budget: ProjectBudgetCap }>(this.pj(id, "/budget"), { method: "PUT", body: JSON.stringify(budget) });
  }
  async deleteProjectBudget(id: string): Promise<{ budget: null }> {
    return this.request<{ budget: null }>(this.pj(id, "/budget"), { method: "DELETE" });
  }
  /** Journal du projet (maintainer), le plus récent d'abord. */
  async getProjectAudit(id: string, limit?: number): Promise<{ events: ProjectAuditEvent[] }> {
    return this.request<{ events: ProjectAuditEvent[] }>(this.pj(id, `/audit${limit ? `?limit=${limit}` : ""}`));
  }

  // -- SSO OIDC des équipes (LOKKAL §7.24, drapeau `sso` ; éteint : 404) ------------------------

  async listSsoConnections(): Promise<{ connections: SsoConnection[] }> {
    return this.request<{ connections: SsoConnection[] }>("/v1/sso/connections");
  }
  /** 5 par compte ; une VALEUR de secret dans le corps → 400 `secret_value_refused` (elle passe par `setSsoClientSecret`). */
  async createSsoConnection(req: SsoConnectionInput): Promise<SsoConnection> {
    return this.request<SsoConnection>("/v1/sso/connections", { method: "POST", body: JSON.stringify(req) });
  }
  async getSsoConnection(id: string): Promise<SsoConnection> {
    return this.request<SsoConnection>(this.sc(id));
  }
  async patchSsoConnection(id: string, req: Partial<SsoConnectionInput>): Promise<SsoConnection> {
    return this.request<SsoConnection>(this.sc(id), { method: "PATCH", body: JSON.stringify(req) });
  }
  async deleteSsoConnection(id: string): Promise<{ deleted: true }> {
    return this.request<{ deleted: true }>(this.sc(id), { method: "DELETE" });
  }
  /** Écriture seule : la valeur part au coffre du noyau et ne revient jamais. */
  async setSsoClientSecret(id: string, value: string): Promise<{ client_secret: { name: string; set: true } }> {
    return this.request<{ client_secret: { name: string; set: true } }>(this.sc(id, "/client-secret"), { method: "PUT", body: JSON.stringify({ value }) });
  }
  async addSsoDomain(id: string, domain: string): Promise<SsoDomain> {
    return this.request<SsoDomain>(this.sc(id, "/domains"), { method: "POST", body: JSON.stringify({ domain }) });
  }
  /** 409 `not_verified` (TXT absent ou différent) | 409 `domain_claimed` | 503 `dns_unavailable`. */
  async verifySsoDomain(id: string, domain: string): Promise<SsoDomain> {
    return this.request<SsoDomain>(this.sc(id, `/domains/${encodeURIComponent(domain)}/verify`), { method: "POST" });
  }
  async removeSsoDomain(id: string, domain: string): Promise<{ removed: true }> {
    return this.request<{ removed: true }>(this.sc(id, `/domains/${encodeURIComponent(domain)}`), { method: "DELETE" });
  }
  async getSsoAudit(id: string, limit?: number): Promise<{ events: SsoAuditEvent[] }> {
    return this.request<{ events: SsoAuditEvent[] }>(this.sc(id, `/audit${limit ? `?limit=${limit}` : ""}`));
  }
  /** 404 sans lien ; 403 `forbidden` hors propriétaire. */
  async getProjectSso(projectId: string): Promise<SsoBinding> {
    return this.request<SsoBinding>(this.pj(projectId, "/sso"));
  }
  async putProjectSso(projectId: string, req: SsoBindingInput): Promise<SsoBinding> {
    return this.request<SsoBinding>(this.pj(projectId, "/sso"), { method: "PUT", body: JSON.stringify(req) });
  }
  async deleteProjectSso(projectId: string): Promise<{ removed: true }> {
    return this.request<{ removed: true }>(this.pj(projectId, "/sso"), { method: "DELETE" });
  }
  /** Public (sans session) : la clé de l'appareil est générée par l'appelant, comme pour le code e-mail. */
  async startOidc(req: OidcStartRequest): Promise<OidcStart> {
    return this.request<OidcStart>("/v1/auth/oidc/start", { method: "POST", body: JSON.stringify(req) });
  }
  /** Public : rend l'appareil enrôlé (`approved_via = "sso:<sc>"`) ; la session s'ouvre ensuite par le défi habituel. */
  async oidcCallback(req: OidcCallbackRequest): Promise<OidcCallbackResult> {
    return this.request<OidcCallbackResult>("/v1/auth/oidc/callback", { method: "POST", body: JSON.stringify(req) });
  }
  private sc(id: string, rest = ""): string {
    return `/v1/sso/connections/${encodeURIComponent(id)}${rest}`;
  }

  // ── X18 (LOKKAL §7.18) : incidents (drapeau `operate`) et plan (drapeau `plan`) ; drapeau éteint = 404.
  async listAlertSources(): Promise<{ sources: AlertSource[] }> {
    return this.request<{ sources: AlertSource[] }>("/v1/alerts/sources");
  }
  /** La clé (ou le jeton Bearer) n'est rendue qu'ICI et à la rotation. */
  async createAlertSource(req: { name: string; format: AlertSource["format"]; auth?: AlertSource["auth"] }): Promise<AlertSourceSecret> {
    return this.request<AlertSourceSecret>("/v1/alerts/sources", { method: "POST", body: JSON.stringify(req) });
  }
  async rotateAlertSource(id: string): Promise<AlertSourceSecret> {
    return this.request<AlertSourceSecret>(`/v1/alerts/sources/${encodeURIComponent(id)}/secret`, { method: "POST" });
  }
  async deleteAlertSource(id: string): Promise<{ deleted: true }> {
    return this.request<{ deleted: true }>(`/v1/alerts/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  async listIncidents(q: { state?: IncidentState | "live"; limit?: number; before?: string } = {}): Promise<{ incidents: Incident[]; next_before: string | null }> {
    const p = new URLSearchParams();
    if (q.state) p.set("state", q.state);
    if (q.limit) p.set("limit", String(q.limit));
    if (q.before) p.set("before", q.before);
    const qs = p.toString();
    return this.request<{ incidents: Incident[]; next_before: string | null }>(`/v1/incidents${qs ? `?${qs}` : ""}`);
  }
  async getIncident(id: string): Promise<Incident> {
    return this.request<Incident>(`/v1/incidents/${encodeURIComponent(id)}`);
  }
  async ackIncident(id: string): Promise<Incident> {
    return this.request<Incident>(`/v1/incidents/${encodeURIComponent(id)}/ack`, { method: "POST" });
  }
  async resolveIncident(id: string, note?: string): Promise<Incident> {
    return this.request<Incident>(`/v1/incidents/${encodeURIComponent(id)}/resolve`, { method: "POST", body: JSON.stringify(note ? { note } : {}) });
  }
  async listPlanCards(q: { project?: string; roots?: boolean } = {}): Promise<{ cards: PlanCard[] }> {
    const p = new URLSearchParams();
    if (q.project) p.set("project", q.project);
    if (q.roots) p.set("roots", "1");
    const qs = p.toString();
    return this.request<{ cards: PlanCard[] }>(`/v1/plan/cards${qs ? `?${qs}` : ""}`);
  }
  async createPlanCard(req: PlanCardInput & { title: string }): Promise<PlanCard> {
    return this.request<PlanCard>("/v1/plan/cards", { method: "POST", body: JSON.stringify(req) });
  }
  async getPlanCard(id: string): Promise<PlanCardDetail> {
    return this.request<PlanCardDetail>(`/v1/plan/cards/${encodeURIComponent(id)}`);
  }
  /** `status` sur une carte mère → 400 `computed`. */
  async patchPlanCard(id: string, req: PlanCardInput): Promise<PlanCard> {
    return this.request<PlanCard>(`/v1/plan/cards/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(req) });
  }
  /** Les filles remontent d'un cran (`lifted`). */
  async deletePlanCard(id: string): Promise<{ deleted: true; lifted: string[] }> {
    return this.request<{ deleted: true; lifted: string[] }>(`/v1/plan/cards/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  /** Ce que reçoit un fil (ou un agent) qui travaille sur la carte. */
  async getPlanContext(id: string): Promise<PlanContext> {
    return this.request<PlanContext>(`/v1/plan/cards/${encodeURIComponent(id)}/context`);
  }
  async attachPlanThread(id: string, threadId: string): Promise<PlanCard> {
    return this.request<PlanCard>(`/v1/plan/cards/${encodeURIComponent(id)}/threads`, { method: "POST", body: JSON.stringify({ thread_id: threadId }) });
  }
  async detachPlanThread(id: string, threadId: string): Promise<PlanCard> {
    return this.request<PlanCard>(`/v1/plan/cards/${encodeURIComponent(id)}/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
  }
  async listPlanProposals(q: { card_id?: string; state?: PlanProposal["state"] } = {}): Promise<{ proposals: PlanProposal[] }> {
    const p = new URLSearchParams();
    if (q.card_id) p.set("card_id", q.card_id);
    if (q.state) p.set("state", q.state);
    const qs = p.toString();
    return this.request<{ proposals: PlanProposal[] }>(`/v1/plan/proposals${qs ? `?${qs}` : ""}`);
  }
  async decidePlanProposal(id: string, decision: "accept" | "refuse"): Promise<{ proposal: PlanProposal; cards: PlanCard[] }> {
    return this.request<{ proposal: PlanProposal; cards: PlanCard[] }>(`/v1/plan/proposals/${encodeURIComponent(id)}/${decision}`, { method: "POST" });
  }
  async getBrief(): Promise<{ agent: Agent | null }> {
    return this.request<{ agent: Agent | null }>("/v1/plan/brief");
  }
  /** Crée (201) ou rend (200) l'agent « Brief du matin », armé. */
  async setBrief(req: { cron?: string; tz?: string; model?: string } = {}): Promise<{ agent: Agent }> {
    return this.request<{ agent: Agent }>("/v1/plan/brief", { method: "POST", body: JSON.stringify(req) });
  }
  async deleteBrief(): Promise<{ deleted: boolean }> {
    return this.request<{ deleted: boolean }>("/v1/plan/brief", { method: "DELETE" });
  }
  /** Livraison du brief (§7.18.5). */
  async getBriefDelivery(): Promise<BriefDelivery> {
    return this.request<BriefDelivery>("/v1/plan/brief/delivery");
  }
  /** 409 `no_telegram` | `no_mail_connector`, 503 `approvals_unavailable`, 400 `invalid`. Une adresse nouvelle pose une carte forte. */
  async putBriefDelivery(req: { telegram?: boolean; email?: string | null }): Promise<BriefDelivery> {
    return this.request<BriefDelivery>("/v1/plan/brief/delivery", { method: "PUT", body: JSON.stringify(req) });
  }

  /** Délie une machine : son jeton est révoqué, la passerelle se ferme (404 : machine inconnue de ce compte). */
  async revokeMachine(machineId: string): Promise<{ revoked: true }> {
    return this.request<{ revoked: true }>(`/v1/link/machines/${encodeURIComponent(machineId)}/revoke`, { method: "POST" });
  }

  /** Construit l'export tout de suite (202 `ready`) ; au plus un par 24 h : 429 `export_limit` + `retry_at`. */
  async startAccountExport(): Promise<AccountExport> {
    return this.request<AccountExport>("/v1/account/export", { method: "POST" });
  }

  async getAccountExport(id: string): Promise<AccountExport> {
    return this.request<AccountExport>(`/v1/account/exports/${encodeURIComponent(id)}`);
  }

  /** Télécharge le JSON de l'export (route authentifiée : un simple lien ne porterait pas le jeton). 410 `export_expired` après 24 h. */
  async downloadAccountExport(id: string): Promise<AccountExportFile> {
    const path = `/v1/account/exports/${encodeURIComponent(id)}/download`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: this.headers() });
    const text = await readAllText(res);
    if (!res.ok) {
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* corps non JSON conservé tel quel */
      }
      throw new NokkerApiError(`${path} → ${res.status}`, res.status, parsed);
    }
    return { filename: `nokker-export-${id}.json`, json: text };
  }

  /** Pose la carte d'approbation forte de suppression (202). L'effacement n'a lieu qu'une fois la carte accordée. */
  async deleteAccount(): Promise<AccountDeleteResult> {
    return this.request<AccountDeleteResult>("/v1/account/delete", { method: "POST" });
  }

  /** 404 tant que l'abonnement n'est pas activé côté noyau. */
  async getBillingStatus(): Promise<BillingStatus> {
    return this.request<BillingStatus>("/v1/billing/plan");
  }

  // ── X23 (LOKKAL §7.29) : le foyer. Drapeau `household` éteint = 404 partout ; sans foyer, GET /v1/household = 404.
  async getHousehold(): Promise<Household> {
    return this.request<Household>("/v1/household");
  }
  /** 409 `household_exists` ; 402 `plan_required` quand la facturation exige Famille ou Large. */
  async createHousehold(name?: string): Promise<Household> {
    return this.request<Household>("/v1/household", { method: "POST", body: JSON.stringify(name ? { name } : {}) });
  }
  async deleteHousehold(): Promise<{ deleted: true }> {
    return this.request<{ deleted: true }>("/v1/household", { method: "DELETE" });
  }
  async getHouseholdConsentText(lang: "fr" | "en"): Promise<HouseholdConsentText> {
    return this.request<HouseholdConsentText>(`/v1/household/consent?lang=${lang}`);
  }
  async listHouseholdConsents(): Promise<{ consents: HouseholdConsentRecord[] }> {
    return this.request<{ consents: HouseholdConsentRecord[] }>("/v1/household/consents");
  }
  async listHouseholdInvitations(): Promise<{ invitations: HouseholdInvitation[] }> {
    return this.request<{ invitations: HouseholdInvitation[] }>("/v1/household/invitations");
  }
  async inviteToHousehold(email: string, profile: HouseholdProfile = "adult", attestation?: HouseholdAttestation): Promise<HouseholdInvitation> {
    return this.request<HouseholdInvitation>("/v1/household/invitations", { method: "POST", body: JSON.stringify({ email, profile, ...(attestation ? { attestation } : {}) }) });
  }
  async revokeHouseholdInvitation(id: string): Promise<{ revoked: true }> {
    return this.request<{ revoked: true }>(`/v1/household/invitations/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  async listReceivedHouseholdInvitations(): Promise<{ invitations: ReceivedHouseholdInvitation[] }> {
    return this.request<{ invitations: ReceivedHouseholdInvitation[] }>("/v1/household/invitations/received");
  }
  async answerHouseholdInvitation(id: string, accept: boolean): Promise<Household | { declined: true }> {
    return this.request<Household | { declined: true }>(`/v1/household/invitations/${encodeURIComponent(id)}/${accept ? "accept" : "decline"}`, { method: "POST" });
  }
  /** Le payeur retire un membre ; un adulte se retire lui-même (« Quitter »). 409 `payer_fixed`, 403 `minor_cannot_leave`. */
  async removeHouseholdMember(account: string): Promise<{ removed: true }> {
    return this.request<{ removed: true }>(`/v1/household/members/${encodeURIComponent(account)}`, { method: "DELETE" });
  }
  /** `null` = aucun plafond ; `resetHouseholdCap` = retour au défaut. */
  async setHouseholdCap(account: string, turnsPerDay: number | null): Promise<HouseholdMember> {
    return this.request<HouseholdMember>(`/v1/household/members/${encodeURIComponent(account)}/cap`, { method: "PUT", body: JSON.stringify({ turns_per_day: turnsPerDay }) });
  }
  async resetHouseholdCap(account: string): Promise<HouseholdMember> {
    return this.request<HouseholdMember>(`/v1/household/members/${encodeURIComponent(account)}/cap`, { method: "DELETE" });
  }
  async setHouseholdProfile(account: string, profile: HouseholdProfile, attestation?: HouseholdAttestation): Promise<HouseholdMember> {
    return this.request<HouseholdMember>(`/v1/household/members/${encodeURIComponent(account)}/profile`, { method: "PUT", body: JSON.stringify({ profile, ...(attestation ? { attestation } : {}) }) });
  }
  async renewHouseholdConsent(account: string, attestation: HouseholdAttestation): Promise<HouseholdMember> {
    return this.request<HouseholdMember>(`/v1/household/members/${encodeURIComponent(account)}/consent`, { method: "POST", body: JSON.stringify({ attestation }) });
  }
  /** Le profil passe `suspended` : plus aucun tour. */
  async revokeHouseholdConsent(account: string): Promise<HouseholdMember> {
    return this.request<HouseholdMember>(`/v1/household/members/${encodeURIComponent(account)}/consent`, { method: "DELETE" });
  }
  async getHouseholdPolicy(): Promise<HouseholdPolicy> {
    return this.request<HouseholdPolicy>("/v1/household/policy");
  }
  async setHouseholdPolicy(p: Partial<HouseholdPolicy>): Promise<HouseholdPolicy> {
    return this.request<HouseholdPolicy>("/v1/household/policy", { method: "PUT", body: JSON.stringify(p) });
  }
  async listHouseholdNotes(since?: number): Promise<{ notes: HouseholdNote[]; cursor: number | null }> {
    return this.request<{ notes: HouseholdNote[]; cursor: number | null }>(`/v1/household/notes${since != null ? `?since=${since}` : ""}`);
  }
  async putHouseholdNote(name: string, note: { kind: HouseholdNote["kind"]; title: string; text: string; base_sha?: string; deleted?: boolean }): Promise<{ note: HouseholdNote | null; accepted: number; skipped: number; quarantined: number; refused: number }> {
    return this.request(`/v1/household/notes/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(note) });
  }
  async forgetHouseholdNote(name: string): Promise<{ forgotten: boolean }> {
    return this.request<{ forgotten: boolean }>(`/v1/household/notes/${encodeURIComponent(name)}`, { method: "DELETE" });
  }
  async listHouseholdQuarantine(): Promise<{ quarantine: HouseholdQuarantined[] }> {
    return this.request<{ quarantine: HouseholdQuarantined[] }>("/v1/household/notes/quarantine");
  }
  async restoreHouseholdQuarantine(id: string): Promise<{ note: HouseholdNote }> {
    return this.request<{ note: HouseholdNote }>(`/v1/household/notes/quarantine/${encodeURIComponent(id)}/restore`, { method: "POST" });
  }
  async listHouseholdApprovals(): Promise<{ approvals: HouseholdApproval[] }> {
    return this.request<{ approvals: HouseholdApproval[] }>("/v1/household/approvals");
  }
  async householdApprovalChallenge(id: string, member: string): Promise<{ challenge: string; nonce: string; exp: number }> {
    return this.request<{ challenge: string; nonce: string; exp: number }>(`/v1/household/approvals/${encodeURIComponent(id)}/challenge`, { method: "POST", body: JSON.stringify({ member }) });
  }
  /** Seul le représentant décide, depuis SES appareils (passkey UV ou Mini App). */
  async householdApprovalDecision(
    id: string,
    body: { member: string; decision: "approve" | "reject"; challenge: string; device_id: string; signature?: string; init_data?: string; webauthn?: { client_data_json: string; authenticator_data: string; signature: string } },
  ): Promise<HouseholdApproval["approval"]> {
    return this.request<HouseholdApproval["approval"]>(`/v1/household/approvals/${encodeURIComponent(id)}/decision`, { method: "POST", body: JSON.stringify(body) });
  }

  // ── LOKKAL §7.28 : sessions de code d'un compte. Drapeau `code.enabled` éteint = 404 partout ; le jeton local : 403
  // `account_required`.
  async listCodeSessions(): Promise<CodeSessionList> {
    return this.request<CodeSessionList>("/v1/code/sessions");
  }
  /** 409 `session_limit` ; 400 `bad_mode`, `bad_repo`, `host_not_allowed`… ; 502 `clone_failed` ; 503 `git_missing`. */
  async createCodeSession(body: CodeSessionCreate = {}): Promise<CodeSession> {
    return this.request<CodeSession>("/v1/code/sessions", { method: "POST", body: JSON.stringify(body) });
  }
  async getCodeSession(id: string): Promise<CodeSession> {
    return this.request<CodeSession>(`/v1/code/sessions/${encodeURIComponent(id)}`);
  }
  /** Ferme (bac à sable libéré, espace gardé) ; `purge` efface aussi l'espace de travail et les points de retour. */
  async closeCodeSession(id: string, purge = false): Promise<CodeSessionClosed> {
    return this.request<CodeSessionClosed>(`/v1/code/sessions/${encodeURIComponent(id)}${purge ? "?purge=1" : ""}`, { method: "DELETE" });
  }
  /** Confiance du propriétaire à l'arbre `.nokker/skills` de la session, pour CETTE empreinte (lue dans `skills.sha256`). */
  async trustCodeSessionSkills(id: string, sha256: string): Promise<CodeSkillsTrusted> {
    return this.request<CodeSkillsTrusted>(`/v1/code/sessions/${encodeURIComponent(id)}/skills/trust`, { method: "POST", body: JSON.stringify({ sha256 }) });
  }
  /** Points de retour de la session, hors tour, avec les portes de la boucle : 200 `{content, is_error}`, ou 202
   * `{approval_id}` (une restauration : carte forte, décidée par `/v1/approvals/{id}/decision`). 409 `turn_running`. */
  async callCodeSessionTool(id: string, name: CodeToolName, args: Record<string, unknown> = {}): Promise<LocalToolOutcome> {
    return this.request<LocalToolOutcome>(`/v1/code/sessions/${encodeURIComponent(id)}/tools/call`, { method: "POST", body: JSON.stringify({ name, arguments: args }) });
  }
  async listCodeCredentials(): Promise<{ credentials: CodeCredential[] }> {
    return this.request<{ credentials: CodeCredential[] }>("/v1/code/credentials");
  }
  /** Valeur `jeton` ou `utilisateur:jeton`, en écriture seule : rien ne la relit. */
  async putCodeCredential(name: string, value: string): Promise<{ name: string; set: true }> {
    return this.request<{ name: string; set: true }>(`/v1/code/credentials/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value }) });
  }
  async deleteCodeCredential(name: string): Promise<{ name: string; deleted: true }> {
    return this.request<{ name: string; deleted: true }>(`/v1/code/credentials/${encodeURIComponent(name)}`, { method: "DELETE" });
  }

  async billingCheckout(plan: string): Promise<{ url: string }> {
    return this.request<{ url: string }>("/v1/billing/checkout", { method: "POST", body: JSON.stringify({ plan }) });
  }

  async billingPortal(): Promise<{ url: string }> {
    return this.request<{ url: string }>("/v1/billing/portal", { method: "POST" });
  }

  // -- Connecteurs (session requise) ------------------------------------------------------

  async listConnectors(): Promise<ConnectorsListing> {
    return this.request<ConnectorsListing>("/v1/connectors");
  }

  /** Testé côté serveur AVANT d'être enregistré ; une erreur n'écrit rien. */
  async putConnector(kind: ConnectorKind, req: PutConnectorRequest): Promise<ConnectorCard> {
    return this.request<ConnectorCard>(`/v1/connectors/${kind}`, { method: "PUT", body: JSON.stringify(req) });
  }

  async testConnector(kind: ConnectorKind): Promise<ConnectorTestResult> {
    return this.request<ConnectorTestResult>(`/v1/connectors/${kind}/test`, { method: "POST" });
  }

  async deleteConnector(kind: ConnectorKind): Promise<{ revoked: boolean }> {
    return this.request<{ revoked: boolean }>(`/v1/connectors/${kind}`, { method: "DELETE" });
  }

  // -- Lokkal : réglage du premier lancement (docs/LOKKAL.md §7) ------------------------------

  async getLocalSetup(): Promise<LocalSetup> {
    return this.request<LocalSetup>("/v1/local/setup");
  }

  /** Essai d'un point d'accès « ma propre clé » ; la clé n'est jamais renvoyée. 200 même si `ok` est faux. */
  async testLocalModel(req: LocalModelTestRequest): Promise<LocalModelTestResult> {
    return this.request<LocalModelTestResult>("/v1/local/setup/models/test", { method: "POST", body: JSON.stringify(req) });
  }

  /** Modèle par défaut et clés de l'utilisateur ; rend le réglage à jour (forme de `getLocalSetup`). */
  async putLocalModels(req: PutLocalModelsRequest): Promise<LocalSetup> {
    return this.request<LocalSetup>("/v1/local/setup/models", { method: "PUT", body: JSON.stringify(req) });
  }

  /** Marque le réglage comme terminé (rend `{done:true}`, sans condition côté noyau). */
  async finishLocalSetup(): Promise<{ done: true }> {
    return this.request<{ done: true }>("/v1/local/setup/done", { method: "POST" });
  }

  /** Démarre le flux d'appareil pour lier Lokkal à un compte nokker.ai (docs/LOKKAL.md §7.2). */
  async startLocalLink(): Promise<LocalLinkStart> {
    return this.request<LocalLinkStart>("/v1/local/link/start", { method: "POST" });
  }

  /** Sondage du flux d'appareil (404 `no_link_in_progress` sans flux). */
  async getLocalLinkStatus(): Promise<LocalLinkStatus> {
    return this.request<LocalLinkStatus>("/v1/local/link/status");
  }

  /** Délie Lokkal du compte : la clé du Router est effacée du coffre local et révoquée côté nokker.ai. */
  async unlinkLocal(): Promise<LocalLinkRemoved> {
    return this.request<LocalLinkRemoved>("/v1/local/link", { method: "DELETE" });
  }

  // -- Telegram (contrat C4) ---------------------------------------------------------------

  async createTelegramPairing(): Promise<TelegramPairing> {
    return this.request<TelegramPairing>("/v1/telegram/pairing", { method: "POST" });
  }

  // -- Aperçus (BUBBLES.md §5) -------------------------------------------------------

  async getPreview(url: string): Promise<Preview> {
    return this.request<Preview>(`/v1/previews?url=${encodeURIComponent(url)}`);
  }

  /** URL absolue d'une image re-servie par le noyau, à poser dans un `<img>`. Le noyau la SIGNE
   * (`/v1/previews/img/<sha>?exp=&sig=`, §9.3, TTL 24 h) : la chaîne de requête est gardée telle quelle, aucun
   * jeton n'est ajouté (un `<img>` ne pose jamais `Authorization`). */
  resolveUrl(path: string | null | undefined): string | null {
    if (!path) return null;
    if (/^https?:\/\//.test(path)) return path;
    return `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
  }

  // -- Notifications, utilisateurs, Crew (BUBBLES.md §9) ------------------------------

  /** §9.1 — bulles `notify` ouvertes adressées à l'appelant (pour qu'un rechargement ne les perde pas). */
  async listNotifications(): Promise<Bubble[]> {
    return this.request<Bubble[]>("/v1/notifications");
  }

  /** §9.2 — utilisateurs connus (cibles du partage, membres d'un fil). */
  async listUsers(): Promise<KnownUser[]> {
    return this.request<KnownUser[]>("/v1/users");
  }

  /** §9.4 — agents du Crew. */
  async listAgents(): Promise<Agent[]> {
    return this.request<Agent[]>("/v1/agents");
  }

  /** §9.4 — `status` vaut toujours `armed` à la création ; `name`/`role` requis (400 sinon). */
  async createAgent(req: CreateAgentRequest): Promise<Agent> {
    return this.request<Agent>("/v1/agents", { method: "POST", body: JSON.stringify(req) });
  }

  // §9.5 (X14) — moteur du Crew. Le clic de l'humain EST la décision ; seul `arm` avec une écriture levée
  // (`auto_approve`) demande une carte forte (202 `{approval_id}`).
  private agentPath(id: string, tail = ""): string {
    return `/v1/agents/${encodeURIComponent(id)}${tail}`;
  }

  /** Changer trigger, tools, auto_approve ou secrets d'un agent armé le remet en `paused`. */
  async patchAgent(id: string, req: PatchAgentRequest): Promise<Agent> {
    return this.request<Agent>(this.agentPath(id), { method: "PATCH", body: JSON.stringify(req) });
  }

  /** 200 : l'agent armé ; 202 `{approval_id, agent}` : une carte forte d'abord (règle d'écriture pas encore approuvée
   * sous cette forme) ; un second `arm` pendant l'attente rend la même carte. */
  async armAgent(id: string): Promise<Agent | { approval_id: string; agent: Agent }> {
    return this.request<Agent | { approval_id: string; agent: Agent }>(this.agentPath(id, "/arm"), { method: "POST" });
  }

  async getAgent(id: string): Promise<Agent> {
    return this.request<Agent>(this.agentPath(id));
  }

  /** Agent déclenché par `webhook:<id>` : nouvelle clé, rendue UNE seule fois (503 sans moteur). */
  async rotateAgentWebhookSecret(id: string): Promise<{ secret: string; url?: string }> {
    return this.request<{ secret: string; url?: string }>(this.agentPath(id, "/webhook-secret"), { method: "POST" });
  }

  /** L'agent passe `paused` ; un passage en cours continue (l'annuler à part). */
  async disarmAgent(id: string): Promise<Agent> {
    return this.request<Agent>(this.agentPath(id, "/disarm"), { method: "POST" });
  }

  /** Lancer maintenant (tout statut sauf `running`) : 202 `{run_id}`. */
  async runAgent(id: string): Promise<{ run_id: string }> {
    return this.request<{ run_id: string }>(this.agentPath(id, "/run"), { method: "POST" });
  }

  /** 204 ; un passage en cours est annulé d'abord, les fils des passages restent. */
  async deleteAgent(id: string): Promise<void> {
    await this.request<unknown>(this.agentPath(id), { method: "DELETE" });
  }

  async listAgentRuns(id: string, opts: { limit?: number; before?: string } = {}): Promise<AgentRunPage> {
    const q = new URLSearchParams();
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.before) q.set("before", opts.before);
    const qs = q.toString();
    return this.request<AgentRunPage>(this.agentPath(id, `/runs${qs ? `?${qs}` : ""}`));
  }

  async cancelAgentRun(id: string, runId: string): Promise<AgentRun> {
    return this.request<AgentRun>(this.agentPath(id, `/runs/${encodeURIComponent(runId)}/cancel`), { method: "POST" });
  }

  /** @deprecated `GET /v1/agents` est au contrat (§9.4) : utiliser `listAgents`. */
  async listAgentsMockExtension(): Promise<Agent[]> {
    return this.listAgents();
  }


  // -- Approbations -----------------------------------------------------------------

  async listApprovals(status?: Approval["status"]): Promise<Approval[]> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.request<Approval[]>(`/v1/approvals${qs}`);
  }

  async getApproval(id: string): Promise<Approval> {
    return this.request<Approval>(`/v1/approvals/${encodeURIComponent(id)}`);
  }

  async requestChallenge(approvalId: string): Promise<Challenge> {
    return this.request<Challenge>(`/v1/approvals/${encodeURIComponent(approvalId)}/challenge`, {
      method: "POST",
    });
  }

  async decideApproval(approvalId: string, decision: ApprovalDecisionRequest): Promise<Approval> {
    return this.request<Approval>(`/v1/approvals/${encodeURIComponent(approvalId)}/decision`, {
      method: "POST",
      body: JSON.stringify(decision),
    });
  }

  // -- Événements -----------------------------------------------------------------

  subscribeEvents(handlers: {
    onEvent: (event: NokkerEvent) => void;
    onReconnected?: () => void;
    onConnected?: () => void;
    onError?: (err: unknown) => void;
  }): EventSubscription {
    if (!this.token) throw new Error("subscribeEvents nécessite un jeton de session");
    return subscribeEvents({
      baseUrl: this.baseUrl,
      token: () => this.token ?? "",
      fetchImpl: this.fetchImpl,
      ...handlers,
    });
  }

  // -- Chat completions (seule route déjà implémentée côté noyau, server.py) ----------

  /** Tour non-streamé : renvoie la complétion complète. */
  async chatCompletion(threadId: string, messages: ChatMessage[], model = "nokker"): Promise<ChatCompletion> {
    return this.request<ChatCompletion>("/v1/chat/completions", {
      method: "POST",
      headers: { "X-Session-Id": threadId },
      body: JSON.stringify({ model, messages, stream: false }),
    });
  }

  /**
   * Tour streamé : appelle `onChunk` pour chaque frame SSE OpenAI-compatible, jusqu'à `[DONE]`.
   *
   * Pose `X-Nokker-Stream-Tokens: 1` (jetons en direct, CLIENT-API.md §Streaming) sauf `liveTokens: false` :
   * le flux peut alors contenir des chunks `nokker.reset` et un chunk final `nokker.final` qui REMPLACE le texte
   * reçu — utiliser `applyChatChunk` pour tenir le texte courant, jamais une concaténation naïve. Les
   * commentaires SSE (`: ping`, battement du noyau toutes les ~10 s) sont ignorés par le parseur. Un chunk
   * `{"error"}` (erreur du tour après les en-têtes) lève une `NokkerApiError` (statut 500).
   */
  async streamChatCompletion(
    threadId: string,
    messages: ChatMessage[],
    onChunk: (chunk: ChatCompletionChunk) => void,
    model = "nokker",
    opts: { liveTokens?: boolean; signal?: AbortSignal; attachments?: ChatAttachment[] } = {},
  ): Promise<void> {
    const extra: Record<string, string> = { "X-Session-Id": threadId };
    if (opts.liveTokens !== false) extra["X-Nokker-Stream-Tokens"] = "1";
    const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { ...this.headers(extra), "Content-Type": "application/json" },
      // Images du dernier message user (LOKKAL.md §7.6) : `attachments` à côté de `content`, jamais d'adresse http(s).
      body: JSON.stringify({ model, messages, stream: true, ...(opts.attachments?.length ? { attachments: opts.attachments } : {}) }),
      timeout: false, // un tour peut attendre une approbation plus de 5 min (délai d'inactivité par défaut de bun)
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok || !res.body) {
      const bodyText = await readAllText(res);
      throw new NokkerApiError(`/v1/chat/completions → ${res.status}`, res.status, bodyText);
    }
    const text = decodeUtf8Stream(asAsyncIterable(res.body));
    for await (const frame of parseSSEFrames(text)) {
      const chunk = parseJsonData<ChatCompletionChunk>(frame);
      if (!chunk) continue;
      if (chunk.error) {
        throw new NokkerApiError(chunk.error.message ?? "erreur du tour", 500, { error: chunk.error });
      }
      onChunk(chunk);
    }
  }
}

/**
 * Texte courant d'une réponse streamée après ce chunk : `nokker.reset` vide d'abord, puis le delta s'ajoute.
 * Sans extension Nokker (gateway, ancien noyau), c'est la concaténation OpenAI habituelle.
 */
export function applyChatChunk(current: string, chunk: ChatCompletionChunk): string {
  const base = chunk.nokker?.reset ? "" : current;
  const delta = chunk.choices?.[0]?.delta?.content;
  return delta ? base + delta : base;
}

async function readAllText(res: ResponseLike): Promise<string> {
  if (!res.body) return "";
  const decoder = new TextDecoder("utf-8");
  let out = "";
  for await (const part of asAsyncIterable(res.body)) {
    out += decoder.decode(part, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function asAsyncIterable(body: NonNullable<ResponseLike["body"]>): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in body) return body as AsyncIterable<Uint8Array>;
  const streamLike = body as { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } };
  return {
    async *[Symbol.asyncIterator]() {
      const reader = streamLike.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) yield value;
      }
    },
  };
}

/** Chemin de la route locale d'appel d'outil (proposée au noyau ; à renommer ici seulement). */
export const LOCAL_TOOL_CALL_PATH = "/v1/local/tools/call";

/** Liste blanche des outils appelables par la route (tout autre nom : 403) : les 7 de base, plus `memory` (drapeau
 * `local.project_memory`) et `delegate_status` (serveur local, sous-agents en arrière-plan). `delegate_cancel` n'y est
 * pas (403 du noyau). */
export const LOCAL_TOOL_NAMES: readonly LocalToolName[] = [
  "checkpoint_list",
  "checkpoint_diff",
  "checkpoint_create",
  "checkpoint_restore",
  "skill_list",
  "skill_view",
  "todo",
  "memory",
  "delegate_status",
];

/** Décode le `content` JSON d'un appel (null si ce n'est pas du JSON). */
export function parseToolJson<T>(content: string): T | null {
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}
