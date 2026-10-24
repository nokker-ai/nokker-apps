/**
 * Types du contrat client Nokker — `docs/CLIENT-API.md` et
 * `docs/APPROVALS.md` (18.10.2026) font foi. Le serveur qui implémente CES routes
 * est en cours d'écriture ailleurs ; seul `/v1/chat/completions` (SSE compatible OpenAI) existe
 * déjà dans `nokker/api/server.py`. `packages/mock-server` implémente tout le reste en mémoire
 * pour développer les clients sans attendre le noyau.
 */

import type { BubbleEvent } from "./bubbles.js";

// ---------------------------------------------------------------------------
// Identité / sessions (APPROVALS.md §3, §3.6, §5 — forme CANONIQUE du noyau, snake_case)
// ---------------------------------------------------------------------------

/** Utilisateur VÉRIFIÉ (contrat : "alice", "bob"...). */
export type VerifiedUser = string;

/** Réponse de `POST /v1/sessions` (APPROVALS.md §3.6/§5). */
export interface SessionToken {
  token: string;
  user: VerifiedUser;
  device_id: string;
  /** ISO 8601. Durée 12h (`BaseApprovals.session_ttl_s`), pas de renouvellement (APPROVALS.md §6). */
  expires_at: string;
}

/** Statut d'un appareil enrôlé (APPROVALS.md §3.1 : "pending jusqu'à confirmation"). */
export type DeviceStatus = "pending" | "approved" | "revoked";

/** Forme CANONIQUE de `POST`/`GET /v1/devices` et de la réponse de `POST /v1/devices/{id}/confirm`
 * (APPROVALS.md §5, `nokker/api/server.py::device_to_json`) — JAMAIS `public_key_spki` dans une
 * réponse (inutile au client une fois l'enrôlement fait). */
export interface Device {
  id: string;
  /** Identifiant COURT (6 car. hex) pour la confirmation humaine (APPROVALS.md §3.1). */
  code: string;
  name: string;
  user: VerifiedUser;
  status: DeviceStatus;
  created_at: string;
  approved_at: string | null;
  approved_via: string | null;
}

/** Corps de `POST /v1/devices` (APPROVALS.md §3.1). */
export interface EnrollDeviceRequest {
  name: string;
  /** SPKI DER, base64url SANS padding (le noyau accepte le base64 standard en repli, mais le
   * client émet toujours la forme canonique — `signing.ts::base64UrlEncode`). */
  public_key_spki: string;
  /** APPROVALS.md §3.1bis : navigateur sans identité préalable — utilisateur DÉCLARÉ ; l'appareil reste `pending`
   * (aucun droit) jusqu'à confirmation par l'hôte ou le TOTP de cet utilisateur. */
  user?: string;
}

/** Corps de `POST /v1/devices/{id}/confirm` (APPROVALS.md §3.1 — TOTP déjà enrôlé côté serveur,
 * hors API). */
export interface ConfirmDeviceRequest {
  totp: string;
  user: string;
}

/** Les trois champs WebAuthn transportés en base64url (ADR `nokker-apps/docs/adr/0001-*.md`). */
export interface WebAuthnProof {
  client_data_json: string;
  authenticator_data: string;
  signature: string;
}

/** Défi signé — même structure pour une approbation (APPROVALS.md §3.2) et une connexion (§3.6).
 * `exp` est un epoch SECONDES (nombre), jamais une chaîne ISO (APPROVALS.md §5). */
export interface Challenge {
  /** JSON canonique (clés triées) à resigner tel quel. */
  challenge: string;
  nonce: string;
  exp: number;
}

/** Corps de `POST /v1/sessions` (APPROVALS.md §3.6) : signature brute sur `challenge + ".login"`
 * (IEEE P1363, base64url) OU preuve WebAuthn (challenge WebAuthn = `SHA-256(challenge)` SANS
 * suffixe — une connexion n'a pas de « décision » à lier). */
export interface CreateSessionRequest {
  device_id: string;
  challenge: string;
  signature?: string;
  webauthn?: WebAuthnProof;
}

// ---------------------------------------------------------------------------
// Fils / tours (§ Ressources)
// ---------------------------------------------------------------------------

export type Channel = "cli" | "web" | "desktop" | "mobile" | "telegram" | "api" | "local-direct";

/** @deprecated forme CLIENT-API.md d'avant BUBBLES.md — `GET /v1/threads` renvoie désormais `Thread` (bubbles.ts). */
export interface ThreadSummary {
  id: string;
  title: string;
  lastTurnAt: string | null;
  channel: Channel;
}

export type ToolEffect = "READ" | "SEND_EXTERNAL" | "SEND_BULK" | "SPEND" | "DESTRUCTIVE" | "NONE";

export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  effect: ToolEffect;
  ok: boolean | null;
  summary: string | null;
}

export interface TurnRecord {
  threadId: string;
  turnIndex: number;
  channel: Channel;
  userText: string;
  reply: string;
  toolCalls: ToolCallRecord[];
  approvalIds: string[];
  createdAt: string;
}

/** @deprecated remplacé par `ThreadView` (bubbles.ts, BUBBLES.md §1). */
export interface ThreadDetail extends ThreadSummary {
  turns: TurnRecord[];
}

// ---------------------------------------------------------------------------
// Approbations (APPROVALS.md)
// ---------------------------------------------------------------------------

/** `strong` : clé d'appareil libérée par biométrie (ou WebAuthn/passkey avec UV) — jamais de TOTP.
 * `standard` : `strong` OU TOTP OU simple signature logicielle (APPROVALS.md §1). */
export type ApprovalStrength = "strong" | "standard";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "executed" | "failed";
/** `"signature"` (clé logicielle), `"signature+telegram"` (Mini App, `init_data` vérifié),
 * `"webauthn"` (passkey), `"totp"` — APPROVALS.md §3. */
export type DecidedVia = "signature" | "signature+telegram" | "webauthn" | "totp" | "local";

/** Forme CANONIQUE de `GET /v1/approvals/{id}` et des éléments de `GET /v1/approvals?status=…`
 * (APPROVALS.md §5, `nokker/api/server.py::approval_to_json`) — snake_case exact du noyau. */
export interface Approval {
  id: string;
  thread_id: string;
  turn_index: number;
  channel: Channel;
  tool_name: string;
  arguments: Record<string, unknown>;
  /** JSON canonique (clés triées, sans espaces, UTF-8) de `arguments`, hashé SHA-256, hex. */
  args_sha256: string;
  /** Dérivé de `rule` (`"effect:xxx[:...]"` → `"xxx"`) pour l'affichage ; `null` sinon — ce n'est
   * PAS un champ propre d'`Approval` côté noyau. */
  effect: string | null;
  rule: string;
  reason: string;
  /** Avis de Nina — jamais rempli aujourd'hui, le champ existe déjà (APPROVALS.md §6). */
  advice: string | null;
  strength: ApprovalStrength;
  status: ApprovalStatus;
  created_at: string;
  expires_at: string;
  decided_by: VerifiedUser | null;
  decided_via: DecidedVia | null;
  decided_at: string | null;
  result_summary: string | null;
  error: string | null;
  /** Calculé PAR LE NOYAU, présent dans `GET /v1/local/approvals` (pas forcément dans `approval.requested`) :
   * terminal → [`terminal(<cmd>)`, `terminal(<2 premiers mots>*)`] ; fichier → [`<outil>(<chemin>)`, `<outil>(<dossier>/**)`] ;
   * carte forte → []. Absent/vide = pas d'« always ». */
  suggested_rules?: string[];
}

export type ApprovalDecisionKind = "approve" | "reject";

/** Signature brute (CLI, Mini App Telegram) — signe `challenge + "." + decision`, IEEE P1363,
 * base64url (APPROVALS.md §3.3). */
export interface SignedApprovalDecision {
  decision: ApprovalDecisionKind;
  device_id: string;
  challenge: string;
  signature: string;
}

/** WebAuthn/passkey (web) — le challenge WebAuthn transporte `SHA-256(challenge + "." + decision)`
 * (APPROVALS.md §3.4). */
export interface WebAuthnApprovalDecision {
  decision: ApprovalDecisionKind;
  device_id: string;
  challenge: string;
  webauthn: WebAuthnProof;
}

/** TOTP (niveau `standard` SEULEMENT, APPROVALS.md §3.5) — `challenge` reste obligatoire : la
 * vérification du nonce/anti-falsification d'`args_sha256` se fait sur TOUS les chemins de preuve,
 * pas seulement la signature (`BaseApprovals.decide`). */
export interface TotpApprovalDecision {
  decision: ApprovalDecisionKind;
  challenge: string;
  totp: string;
  /** Alias serveur accepté : `"user"`. Le SDK émet toujours `totp_user`. */
  totp_user: string;
}

/** Portée d'une décision locale (LOKKAL.md §7.4.3) : `session` = règle `allow` en mémoire pour le fil ;
 * `always` = règle écrite dans `~/.config/nokker/settings.json` (jamais sur une carte `strong`). */
export type ApprovalScope = "once" | "session" | "always";

export type ApprovalDecisionRequest = SignedApprovalDecision | WebAuthnApprovalDecision | TotpApprovalDecision;

/** Corps de `POST /v1/local/approvals/{id}/decide` (jeton local). 400 si `rule` ∉ `suggested_rules` ou si la carte est
 * `strong` avec `scope` ≠ `once` ; 409 si la carte n'est plus en attente. L'action s'exécute puis le tour reprend. */
export interface LocalApprovalDecision {
  decision: ApprovalDecisionKind;
  scope: ApprovalScope;
  /** `always` : l'une des `suggested_rules` de la carte. */
  rule?: string;
}

/** Réponse : la carte finale + la portée et la règle effectivement écrite. */
export type LocalApprovalResult = Approval & { scope: ApprovalScope; rule?: string | null };

// ---------------------------------------------------------------------------
// Événements SSE (`/v1/events`)
// ---------------------------------------------------------------------------

/** Événements de tour — forme du noyau (BUBBLES.md §6 + §8, branche p1/bubbles c4d04ff) : snake_case,
 * `turn_id` = `<thread_id>:<index du tour>`. Sur le SSE du noyau, le type est dans la ligne `event:` et
 * pas dans `data` : `subscribeEvents` le recopie dans `type`. */
export interface TurnStartedEvent {
  type: "turn.started";
  thread_id: string;
  turn_id: string;
}

/** UNIQUE par tour tant que le noyau ne streame pas token par token : la réponse complète, juste avant
 * `turn.done`. Un client doit savoir l'afficher comme s'il s'agissait d'un flux (un seul morceau). */
export interface TurnDeltaEvent {
  type: "turn.delta";
  thread_id: string;
  turn_id: string;
  text: string;
}

/** Effet d'un outil en session locale (LOKKAL.md §7.4.2). */
export type LocalToolEffect = "read" | "write" | "destructive" | "send_external" | "spend" | "secret";

export interface ToolCallEvent {
  type: "tool.call";
  thread_id: string;
  turn_id: string;
  call_id: string;
  name: string;
  /** Session locale : effet de l'appel. Absent sur les anciens noyaux. */
  effect?: LocalToolEffect;
  /** Session locale : arguments complets mais caviardés (gros champs tronqués à 200 car.). */
  args?: Record<string, unknown>;
  /** Compat : ancienne forme (≤ 200 caractères, caviardé). Les nouveaux champs (`args`, ≤ 2000 car.) priment. */
  args_preview?: string;
}

export interface ToolResultEvent {
  type: "tool.result";
  thread_id: string;
  turn_id?: string;
  /** Absent sur le `tool.result` d'une carte issue d'un appel direct (`POST /v1/local/tools/call`) : apparier par `approval_id`. */
  call_id?: string;
  name: string;
  /** `true` si l'outil est revenu en erreur (refus de permission compris, p. ex. « permissions:hardline »). */
  is_error?: boolean;
  /** Compat (ancien format) : `!is_error`. Lire `is_error` d'abord. */
  ok?: boolean;
  ms?: number;
  effect?: LocalToolEffect;
  /** Route locale d'appel d'outil : carte à l'origine de l'appel (le résultat d'un `checkpoint_restore` approuvé arrive ici). */
  approval_id?: string;
  /** Résultat complet (non tronqué) d'un appel par `POST /v1/local/tools/call` ; `preview` en garde le début. */
  content?: string;
  /** Caviardé, tronqué à 1200 caractères par le noyau ; la CLI n'en montre que 3 lignes. */
  preview?: string;
}

/** Sous-agents (LOKKAL.md §7.4.4). */
export interface SubagentStartedEvent {
  type: "subagent.started";
  thread_id: string;
  parent_turn: string;
  child_id: string;
  goal: string;
}

export interface SubagentProgressEvent {
  type: "subagent.progress";
  thread_id?: string;
  child_id: string;
  tool: string;
  ms: number;
}

export interface SubagentFinishedEvent {
  type: "subagent.finished";
  thread_id?: string;
  child_id: string;
  status: string;
  commits: number;
  dirty: boolean;
}

export interface ApprovalRequestedEvent {
  type: "approval.requested";
  approval: Approval;
}

export interface ApprovalDecidedEvent {
  type: "approval.decided";
  approval_id: string;
  /** Le STATUT posé par la décision (`"approved"`/`"rejected"`, APPROVALS.md §2 — `BaseApprovals.decide`
   * publie `approval.status`, pas `decision` au sens de la requête). */
  decision: ApprovalStatus;
  by: VerifiedUser;
  via: DecidedVia;
}

export interface TurnUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface TurnDoneEvent {
  type: "turn.done";
  thread_id: string;
  turn_id: string;
  usage: TurnUsage;
  tier?: string;
  cost_chf?: number;
  /** `true` quand le tour a été arrêté par `POST /v1/threads/{id}/cancel`. */
  cancelled?: boolean;
}

/** `turn_id` du noyau → `{thread_id, index}` (l'index est après le DERNIER « : »). */
export function parseTurnId(turnId: string): { thread_id: string; index: number } | null {
  const i = turnId.lastIndexOf(":");
  if (i <= 0) return null;
  const index = Number(turnId.slice(i + 1));
  return Number.isInteger(index) ? { thread_id: turnId.slice(0, i), index } : null;
}

export type NokkerEvent =
  | TurnStartedEvent
  | TurnDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | SubagentStartedEvent
  | SubagentProgressEvent
  | SubagentFinishedEvent
  | ApprovalRequestedEvent
  | ApprovalDecidedEvent
  | TurnDoneEvent
  | BubbleEvent;

export const NOKKER_EVENT_TYPES = [
  "turn.started",
  "turn.delta",
  "tool.call",
  "tool.result",
  "subagent.started",
  "subagent.progress",
  "subagent.finished",
  "approval.requested",
  "approval.decided",
  "turn.done",
  "thread.updated",
  "thread.deleted",
  "bubble.created",
  "bubble.updated",
  "bubble.closed",
  "bubble.transferred",
  "session.message",
  "agent.created",
] as const satisfies readonly NokkerEvent["type"][];

// ---------------------------------------------------------------------------
// Chat completions — compatible OpenAI, SEULE route déjà implémentée côté noyau.
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
}

export interface ChatCompletionChunkDelta {
  role?: "assistant";
  content?: string;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: ChatCompletionChunkDelta;
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /**
   * Extension Nokker (opt-in `X-Nokker-Stream-Tokens: 1`, CLIENT-API.md §Streaming) : `reset` = vider le texte
   * reçu jusqu'ici AVANT d'appliquer le delta de ce chunk (l'appel modèle a fini en outils, ou chunk final) ;
   * `final` = ce chunk porte la réponse complète qui fait foi.
   */
  nokker?: { reset?: boolean; final?: boolean };
  /** Erreur du tour survenue après les en-têtes SSE (le noyau ne peut plus répondre en HTTP 500). */
  error?: { message?: string };
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ---------------------------------------------------------------------------
// Session de code locale (LOKKAL.md §7.4.1)
// ---------------------------------------------------------------------------

export interface CreateLocalSessionRequest {
  /** Dossier de travail ; doit être sous une racine déclarée du compose (403 sinon). */
  cwd: string;
  /** Reprise d'un fil local existant. */
  resume?: string;
}

/** `POST /v1/local/sessions` → 201 `{thread_id, cwd}`. */
export interface LocalSession {
  thread_id: string;
  cwd: string;
}

/** `GET /v1/local/sessions` → `{sessions: [{thread_id, cwd}]}` ; `title` et `last_turn_at` ne sont pas garantis. */
export interface LocalSessionSummary {
  thread_id: string;
  cwd: string;
  title?: string;
  last_turn_at?: string | null;
}

/** Réponse (202) de `POST /v1/threads/{id}/cancel` : cartes en attente du fil et de ses `/sa-` retirées. */
export interface CancelResult {
  cancelled: boolean;
  approvals_cancelled: number;
}

/** `GET /healthz` — champs optionnels annoncés par le serveur. */
export interface Healthz {
  status?: string;
  version?: string;
  /** Version minimale du client acceptée par le serveur (semver). */
  min_client_version?: string;
  /** Mock de dev uniquement. */
  mock?: boolean;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Route locale d'appel d'outil (PROPOSÉE au noyau, nom susceptible de changer : voir LOCAL_TOOL_CALL_PATH)
// ---------------------------------------------------------------------------

export type LocalToolName =
  | "checkpoint_list"
  | "checkpoint_diff"
  | "checkpoint_create"
  | "checkpoint_restore"
  | "skill_list"
  | "skill_view"
  | "todo";

export interface LocalToolCallRequest {
  thread_id: string;
  name: LocalToolName;
  arguments: Record<string, unknown>;
}

/** 200 : outil exécuté. `content` est une chaîne (JSON pour les outils structurés, texte pour `checkpoint_diff`,
 * Markdown pour `skill_view`). */
export interface LocalToolResult {
  content: string;
  is_error: boolean;
}

/** 202 : l'effet exige une carte ; le résultat arrivera dans un événement `tool.result` (champ `approval_id`). */
export interface LocalToolPending {
  approval_id: string;
}

export type LocalToolOutcome = LocalToolResult | LocalToolPending;

export interface CheckpointInfo {
  hash: string;
  short_hash: string;
  timestamp: string;
  reason: string;
  files_changed: number;
  insertions?: number;
  deletions?: number;
}

/** `content` de `checkpoint_diff`. */
export interface CheckpointDiff {
  stat?: string;
  diff?: string;
  message?: string;
}

/** `content` de `todo` (lecture seule). */
export interface TodoResult {
  todos: TodoItem[];
  revision?: number;
  summary?: { total: number; pending: number; in_progress: number; completed: number; cancelled: number };
}

export interface CheckpointRestoreResult {
  success: boolean;
  restored_files: string[];
  skipped_user_edits: string[];
  error?: string;
}

export interface SkillInfo {
  name: string;
  category: string;
  description: string;
  source: string;
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}
