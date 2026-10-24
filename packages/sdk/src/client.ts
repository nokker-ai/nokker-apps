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
  ChatCompletionChunk,
  ChatMessage,
  ConfirmDeviceRequest,
  CreateLocalSessionRequest,
  CreateSessionRequest,
  CancelResult,
  Healthz,
  LocalApprovalDecision,
  LocalToolName,
  LocalToolOutcome,
  LocalApprovalResult,
  LocalSession,
  LocalSessionSummary,
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
  AccountExportStart,
  AccountExportStatus,
  AccountConsentResult,
  AccountInfo,
  AccountUsage,
  BillingStatus,
} from "./account.js";
import type { LinkApproveResult, LinkDecision, LinkedMachines, LinkPending, RemoteApproval, RemoteDecision, RemoteDecisionProof } from "./link.js";
import type { PatchThreadRequest } from "./bubbles.js";
import type {
  Agent,
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

  /** Délie une machine : son jeton est révoqué, la passerelle se ferme (404 : machine inconnue de ce compte). */
  async revokeMachine(machineId: string): Promise<{ revoked: true }> {
    return this.request<{ revoked: true }>(`/v1/link/machines/${encodeURIComponent(machineId)}/revoke`, { method: "POST" });
  }

  /** Lance l'export (asynchrone, au plus un par jour : 429 `rate` sinon). */
  async startAccountExport(): Promise<AccountExportStart> {
    return this.request<AccountExportStart>("/v1/account/export", { method: "POST" });
  }

  async getAccountExport(id: string): Promise<AccountExportStatus> {
    return this.request<AccountExportStatus>(`/v1/account/exports/${encodeURIComponent(id)}`);
  }

  async deleteAccount(): Promise<AccountDeleteResult> {
    return this.request<AccountDeleteResult>("/v1/account/delete", { method: "POST" });
  }

  /** 404 tant que l'abonnement n'est pas activé côté noyau. */
  async getBillingStatus(): Promise<BillingStatus> {
    return this.request<BillingStatus>("/v1/billing/plan");
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
    opts: { liveTokens?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    const extra: Record<string, string> = { "X-Session-Id": threadId };
    if (opts.liveTokens !== false) extra["X-Nokker-Stream-Tokens"] = "1";
    const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { ...this.headers(extra), "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: true }),
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

/** Liste blanche des outils appelables par la route (tout autre nom : 403). */
export const LOCAL_TOOL_NAMES: readonly LocalToolName[] = [
  "checkpoint_list",
  "checkpoint_diff",
  "checkpoint_create",
  "checkpoint_restore",
  "skill_list",
  "skill_view",
  "todo",
];

/** Décode le `content` JSON d'un appel (null si ce n'est pas du JSON). */
export function parseToolJson<T>(content: string): T | null {
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}
