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
  /** Appel d'outil resté « en attente » dans le tour qui a posé la carte (LOKKAL.md §7.4.9) : le `tool.result` de
   * l'exécuteur porte ce même `call_id`. `null` (ou absent, noyau d'avant le 25.10) : carte d'appel direct, carte
   * distante. */
  call_id?: string | null;
  /** Calculé PAR LE NOYAU, présent dans `GET /v1/local/approvals` (pas forcément dans `approval.requested`) :
   * terminal → [`terminal(<cmd>)`, `terminal(<2 premiers mots>*)`] ; fichier → [`<outil>(<chemin>)`, `<outil>(<dossier>/**)`] ;
   * carte forte → []. Absent/vide = pas d'« always ». */
  suggested_rules?: string[];
  /** Présent dans `GET /v1/local/approvals` (noyau du 25.10, LOKKAL.md §7.3) : carte forte déposée chez nokker.ai, le
   * lien de décision est parti au téléphone. Faux ou absent : machine non liée, ou dépôt pas encore fait (il sera
   * annoncé par `approval.forwarded`) — elle se décide au terminal. */
  forwarded?: boolean;
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
 * `strong` avec `scope` ≠ `once` ; 409 si la carte n'est plus en attente. La réponse part tout de suite ; l'outil et le
 * tour de suite tournent en fond (LOKKAL.md §7.4.3, §7.4.9). */
export interface LocalApprovalDecision {
  decision: ApprovalDecisionKind;
  scope: ApprovalScope;
  /** `always` : l'une des `suggested_rules` de la carte. */
  rule?: string;
}

/** Ce qui tourne après une décision locale : `running` (l'outil et le tour de suite partent tout de suite), `queued` (un
 * tour tourne ou attend sur le fil : ils passeront après, dans l'ordre des décisions), `none` (refus : rien). */
export type ApprovalContinuation = "running" | "queued" | "none";

/** Réponse de `POST /v1/local/approvals/{id}/decide` (LOKKAL.md §7.4.3) : `202` (`running`/`queued`) ou `200` (`none`),
 * TOUT DE SUITE. `status` vaut `approved` ou `rejected` (plus `executed`/`failed`, sauf noyau d'avant le 25.10) :
 * l'issue de l'outil arrive par le `tool.result` de l'exécuteur (`approval_id` + `call_id` de l'appel en attente), la
 * suite par les `turn.*` du fil. `rule` : `null` pour `scope: "once"`. */
export type LocalApprovalResult = Approval & {
  approval_id: string;
  scope: ApprovalScope;
  rule?: string | null;
  continuation: ApprovalContinuation;
  call_id: string | null;
};

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
  /** Carte à l'origine de ce résultat. Avec `call_id` : sortie publiée par l'exécuteur après une carte approuvée posée
   * par le modèle, même `call_id` que l'appel resté « en attente », `turn_id` = le tour qui a posé la carte (aussi en
   * échec : outil en erreur, arguments changés, annulation), AVANT le tour de suite (LOKKAL.md §7.4.9). Sans `call_id` :
   * carte d'un appel direct (`POST /v1/local/tools/call`, le résultat d'un `checkpoint_restore` approuvé arrive ici). */
  approval_id?: string;
  /** Résultat complet (non tronqué) d'un appel par `POST /v1/local/tools/call` ; `preview` en garde le début. */
  content?: string;
  /** Caviardé, tronqué à 1200 caractères par le noyau ; la CLI n'en montre que 3 lignes. */
  preview?: string;
}

/** Écriture en direct (lot X22, BUBBLES.md §6) : pendant que le modèle écrit les arguments de `write_file`, `patch` ou
 * `page_create`, AVANT le `tool.call` du même `call_id` (rien n'est écrit sur le disque avant l'exécution normale de
 * l'outil). `text` est un morceau À AJOUTER, déjà caviardé. Au plus un événement par `call_id` toutes les 100 ms (ou
 * 2 Ko). Le bloc se clôt par le `tool.result` du même `call_id`, ou à défaut par le `turn.done` du tour. Seulement
 * pour un tour streamé (`X-Nokker-Stream-Tokens: 1`). */
export interface ToolInputDeltaEvent {
  type: "tool.input.delta";
  thread_id: string;
  turn_id: string;
  call_id: string;
  name: "write_file" | "patch" | "page_create" | (string & {});
  /** 0, 1, 2… par `call_id` : un `seq` déjà vu (ou plus petit) est ignoré. */
  seq: number;
  /** Morceau à ajouter au texte déjà reçu ; peut être vide (annonce du chemin, événement final). */
  text: string;
  /** Dès qu'il est connu, répété ensuite ; patch V4A : le fichier du dernier en-tête `*** Update/Add File:` vu. */
  path?: string;
  /** Champ streamé : `content` (write_file), `new_string` ou `patch` (patch) ; absent pour `page_create`. */
  field?: "content" | "new_string" | "patch" | (string & {});
  /** Dernier événement : le direct s'arrête (appel trop gros) ; garder ce qui est affiché et marquer « … ». */
  truncated?: boolean;
  /** Proposition abandonnée (flux coupé, appel rejoué) : retirer le bloc ; aucun `tool.result` ne suivra. */
  discarded?: boolean;
}

/** Sous-agents (LOKKAL.md §7.4.4, arrière-plan §7.22). Formes publiées par le noyau : `subagent.started {thread_id,
 * parent_thread_id, parent_turn, child_id, child_thread_id, goal, background?}`, `subagent.progress {parent_thread_id,
 * child_id, tool, ms}`, `subagent.finished {parent_thread_id, child_id, status, commits, dirty, kept, background?,
 * exit_reason?, resumed?}`. `parent_thread_id` relie l'événement au fil parent (seul `started` porte `thread_id`). */
export interface SubagentStartedEvent {
  type: "subagent.started";
  thread_id: string;
  parent_thread_id?: string;
  /** Numéro du tour du parent (noyau) ; les anciens mocks envoyaient l'id du tour. */
  parent_turn: number | string;
  child_id: string;
  /** `<parent>/sa-<id>` : le fil de l'enfant (ses cartes y sont posées). */
  child_thread_id?: string;
  goal: string;
  /** Enfant de fond (`delegate(background: true)`, §7.22) : le tour du parent n'attend pas. */
  background?: boolean;
}

export interface SubagentProgressEvent {
  type: "subagent.progress";
  thread_id?: string;
  parent_thread_id?: string;
  child_id: string;
  tool: string;
  ms: number;
}

/** `status` : `completed | failed | interrupted` (noyau). */
export type SubagentStatus = "completed" | "failed" | "interrupted" | (string & {});

export interface SubagentFinishedEvent {
  type: "subagent.finished";
  thread_id?: string;
  parent_thread_id?: string;
  child_id: string;
  status: SubagentStatus;
  commits: number;
  dirty: boolean;
  /** Worktree conservé (commits, arbre modifié, annulé ou en attente d'une carte). */
  kept?: boolean;
  background?: boolean;
  /** `completed | error | approval_pending | escalated | cancelled | …` (enfants de fond et repris). */
  exit_reason?: string | null;
  /** Fin d'un enfant repris après sa carte (§7.22.7). */
  resumed?: boolean;
}

/** Fil parent d'un événement `subagent.*` (`parent_thread_id`, sinon `thread_id`). */
export function subagentParent(e: { parent_thread_id?: string; thread_id?: string }): string | undefined {
  return e.parent_thread_id ?? e.thread_id;
}

export interface ApprovalRequestedEvent {
  type: "approval.requested";
  approval: Approval;
}

/** Carte forte déposée chez nokker.ai (machine liée, LOKKAL.md §7.3) : elle attend aussi le téléphone. */
export interface ApprovalForwardedEvent {
  type: "approval.forwarded";
  approval_id: string;
  thread_id: string;
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

/** Images du tour non lues : le modèle n'a pas la vision (LOKKAL.md §7.6), une fois par tour. */
export interface AttachmentSkippedEvent {
  type: "attachment.skipped";
  thread_id: string;
  turn_id: string;
  count: number;
  reason: string;
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

// ---------------------------------------------------------------------------
// Coût par tour (LOKKAL.md §7.8, lot X2)
// ---------------------------------------------------------------------------

/** Montants par devise (`{"EUR": 0.0312}`) : la devise est celle du catalogue de prix du noyau, jamais convertie côté
 * client ; vide quand aucun modèle du tour n'a de prix (jetons seulement). */
export type CostByCurrency = Record<string, number>;

/** Jetons d'un ensemble d'appels modèle. `input_tokens` compte le cache (`cached_tokens` en est la part) et
 * `output_tokens` le raisonnement (`reasoning_tokens`) ; `null` = l'amont ne l'a déclaré pour aucun appel. */
export interface CostTokens {
  calls: number;
  input_tokens: number;
  cached_tokens: number | null;
  output_tokens: number;
  reasoning_tokens: number | null;
  total_tokens: number;
}

export interface ModelCost extends CostTokens {
  model: string;
  tiers: string[];
  /** `null` : modèle absent du catalogue de prix (jamais un prix inventé). */
  cost: CostByCurrency | null;
  price_source: string | null;
}

export interface CostSummary extends CostTokens {
  cost: CostByCurrency;
  unpriced_models: string[];
  models: ModelCost[];
}

/** Publié juste AVANT `turn.done` ; appels des sous-agents du tour compris (`subagent_calls`). */
export interface TurnCostEvent extends CostSummary {
  type: "turn.cost";
  thread_id: string;
  turn_id: string;
  subagent_calls: number;
}

/** `GET /v1/local/cost?thread_id=&day=` — `session` couvre le fil et ses sous-agents ; `day` tous les fils du jour UTC. */
export interface LocalCostTotals {
  session: (CostSummary & { thread_id: string; turns: number }) | null;
  day: CostSummary & { date: string; turns: number };
}

/** `GET /v1/local/memory` (jeton local, LOKKAL.md §7.13.6) — état de la mémoire longue, gardé 15 s par le noyau.
 * `ok: null` : pas de contrôle (`mcp` : le service distant a le sien ; `off` : aucune mémoire). `error` : la raison
 * d'une panne (DSN caviardé, jamais de mot de passe). */
export interface LocalMemoryStatus {
  mode: "direct" | "mcp" | "off";
  ok: boolean | null;
  error?: string;
  projects?: string[] | null;
  profile?: string | null;
  store?: { ok: boolean; notes?: number | null; chunks?: number | null; generation?: string | number | null; model?: string | null };
  embed?: { ok: boolean; dim?: number; ms?: number };
  last_error?: string;
  last_recall_ms?: number;
}

/** `turn_id` du noyau → `{thread_id, index}` (l'index est après le DERNIER « : »). */
export function parseTurnId(turnId: string): { thread_id: string; index: number } | null {
  const i = turnId.lastIndexOf(":");
  if (i <= 0) return null;
  const index = Number(turnId.slice(i + 1));
  return Number.isInteger(index) ? { thread_id: turnId.slice(0, i), index } : null;
}

import type { HookRanEvent, HookUntrustedEvent, MemoryForgottenEvent, MemoryNotedEvent, SkillUntrustedEvent } from "./local-machine.js";
import type { IncidentUpdatedEvent, PlanCardDeletedEvent, PlanCardUpdatedEvent, PlanProposalUpdatedEvent } from "./ops.js";

export type NokkerEvent =
  | IncidentUpdatedEvent
  | PlanCardUpdatedEvent
  | PlanCardDeletedEvent
  | PlanProposalUpdatedEvent
  | HookUntrustedEvent
  | HookRanEvent
  | SkillUntrustedEvent
  | MemoryNotedEvent
  | MemoryForgottenEvent
  | AttachmentSkippedEvent
  | TurnStartedEvent
  | TurnDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | ToolInputDeltaEvent
  | CheckpointCreatedEvent
  | SubagentStartedEvent
  | SubagentProgressEvent
  | SubagentFinishedEvent
  | ApprovalRequestedEvent
  | ApprovalForwardedEvent
  | ApprovalDecidedEvent
  | TurnCostEvent
  | TurnDoneEvent
  | BubbleEvent;

export const NOKKER_EVENT_TYPES = [
  "hook.untrusted",
  "hook.ran",
  "skill.untrusted",
  "memory.noted",
  "memory.forgotten",
  "attachment.skipped",
  "turn.started",
  "turn.delta",
  "tool.call",
  "tool.result",
  "tool.input.delta",
  "checkpoint.created",
  "subagent.started",
  "subagent.progress",
  "subagent.finished",
  "approval.requested",
  "approval.forwarded",
  "approval.decided",
  "turn.cost",
  "turn.done",
  "thread.updated",
  "thread.deleted",
  "bubble.created",
  "bubble.updated",
  "bubble.closed",
  "bubble.transferred",
  "session.message",
  "agent.created",
  "agent.updated",
  "agent.deleted",
  "agent.run",
  "incident.updated",
  "plan.card.updated",
  "plan.card.deleted",
  "plan.proposal.updated",
] as const satisfies readonly NokkerEvent["type"][];

// ---------------------------------------------------------------------------
// Chat completions — compatible OpenAI, SEULE route déjà implémentée côté noyau.
// ---------------------------------------------------------------------------

/** Partie d'un message multimodal (format OpenAI) : texte, ou image en `data:` (X7, dépôt d'images dans la demande). */
export type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];
}

/** Texte d'un message, quelle que soit sa forme (les images ne comptent pas). */
export function messageText(content: ChatMessage["content"]): string {
  return typeof content === "string" ? content : content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
}

/** Image jointe au DERNIER message user (LOKKAL.md §7.6) : octets en base64, data URL, ou chemin relatif au dossier de la
 * session locale (lu par le noyau). png, jpeg, webp, gif ; 5 Mo et 4 images par message ; le type est lu dans les octets. */
export type ChatAttachment =
  | { data: string; media_type?: string; name?: string }
  | { url: string }
  | { path: string };

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
  /** Reprise d'un fil local existant (alias de `thread_id` côté noyau depuis le 25.10 ; les deux, différents : 400). */
  resume?: string;
  thread_id?: string;
}

/** `POST /v1/local/sessions` → 201 `{thread_id, cwd}` ; `skills` quand le noyau lit les skills du dépôt (§7.21). */
export interface LocalSession {
  thread_id: string;
  cwd: string;
  /** Drapeau `local.project_skills` allumé seulement (sinon absent). */
  skills?: ProjectSkillsStatus;
}

/** Skills du dépôt d'une session (LOKKAL.md §7.21.3) : `untrusted` = invisibles tant que l'utilisateur ne fait pas
 * confiance à CE dossier et CETTE empreinte (`POST /v1/local/skills/trust`). */
export interface ProjectSkillsStatus {
  enabled: boolean;
  project: "absent" | "trusted" | "untrusted" | "invalid" | (string & {});
  /** Racine du dépôt (chemin réel côté noyau). */
  root: string;
  /** Empreinte de l'arbre `.nokker/skills` entier ; `null` sans arbre lisible. */
  sha256: string | null;
  count: number;
  notice: string | null;
}

/** `POST /v1/local/skills/trust` → 200. 409 : empreinte différente ; 404 : fil sans skills de dépôt (ou drapeau
 * éteint) ; 403 par la passerelle (jeton local seulement). */
export interface SkillsTrustResult {
  thread_id: string;
  root: string;
  sha256: string;
  trusted: true;
}

/** `GET /v1/local/sessions` → `{sessions: [{thread_id, cwd, title, last_turn_at, working, pending_approvals}]}` (§7.4.1).
 * Un noyau d'avant le 25.10 ne rend que `{thread_id, cwd}` : les autres champs sont facultatifs ici. */
export interface LocalSessionSummary {
  thread_id: string;
  cwd: string;
  /** `null` avant le premier tour. */
  title?: string | null;
  /** ISO 8601 UTC, fin du dernier tour rangé ; `null` sans tour. */
  last_turn_at?: string | null;
  /** Un tour tourne ou attend dans la file du fil (une décision de carte en file compte). */
  working?: boolean;
  /** Cartes en attente du fil ET de ses sous-agents `<fil>/sa-…`. */
  pending_approvals?: number;
}

/** Réponse (202) de `POST /v1/threads/{id}/cancel` : cartes en attente du fil et de ses `/sa-` retirées ; sous-agents
 * (fond et premier plan) arrêtés (`subagents_cancelled`, §7.22.4). */
export interface CancelResult {
  /** Le noyau rend l'id du fil annulé ; les anciens mocks, un booléen. */
  cancelled: boolean | string;
  approvals_cancelled: number;
  subagents_cancelled?: number;
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
  | "todo"
  /** Mémoire du projet (§7.11.7) : drapeau `local.project_memory` allumé seulement (sinon 403). */
  | "memory"
  /** Sous-agents en arrière-plan (§7.22.3) : sans `wait_s` hors tour (400 sinon). */
  | "delegate_status"
  /** §7.22.4 — PAS dans la liste blanche du noyau aujourd'hui (403) : `cancelSubagents` replie sur l'annulation du fil. */
  | "delegate_cancel";

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
  /** Tour qui a pris le point (§7.4.7, depuis le 25.10) : absents si le lien n'est pas connu (point d'avant, d'un autre
   * programme, ou noyau plus ancien) — jamais inventés. */
  thread_id?: string;
  turn_index?: number;
  /** Outil avant lequel la photo a été prise (`patch`, `checkpoint_create`, `checkpoint_restore`…). */
  tool?: string;
}

/** Point de retour nouveau (§7.4.7) : avant un outil non READ, `checkpoint_create`, point « avant retour ». */
export interface CheckpointCreatedEvent {
  type: "checkpoint.created";
  thread_id: string;
  turn_index: number;
  hash: string;
  tool: string;
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

/** `checkpoint_restore {hash, file}` (un fichier) : `{success, restored_to, reason?, directory?, file}` ; fichier ABSENT
 * du point (créé depuis, noyau du 25.10) : supprimé après un point « avant retour » vérifié — `deleted` (faux s'il
 * était déjà absent) et `snapshot` (le point « avant retour », d'où le faire revenir). */
export interface CheckpointFileRestoreResult {
  success: boolean;
  restored_to?: string;
  reason?: string;
  directory?: string;
  file?: string;
  deleted?: boolean;
  snapshot?: string;
  message?: string;
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

// ---------------------------------------------------------------------------
// Mémoire de projet (LOKKAL.md §7.11.7) : outil `memory {action: list|view|forget, name?}` par la route d'appel d'outil
// ---------------------------------------------------------------------------

export interface ProjectMemoryNote {
  name: string;
  kind: "rule" | "feedback" | "fact" | (string & {});
  scope: "project" | "user" | (string & {});
  title: string;
  /** `fil#tour` d'où vient la note. */
  origin?: string;
  derived_from?: "user" | "repo" | "agent" | (string & {});
  created?: string;
  links?: string[];
  locality?: string;
  /** Dans le noyau du message système (sinon rappelée par pertinence). */
  in_core?: boolean;
}

export interface ProjectMemorySection {
  name: string;
  title: string;
  in_core: boolean;
}

/** `memory {action: "list"}`. `project` : `null` sur un fil sans session de code. */
export interface ProjectMemoryList {
  project: string | null;
  notes: ProjectMemoryNote[];
  sources: { path: string; sections: ProjectMemorySection[] }[];
}

/** `memory {action: "view"}` : une note apprise (`text` en plus), ou une section d'un fichier d'instructions (`source`). */
export type ProjectMemoryView = (ProjectMemoryNote & { text: string }) | { name: string; source: string; title: string; text: string };

// ---------------------------------------------------------------------------
// Sous-agents en arrière-plan (LOKKAL.md §7.22.3) : `delegate_status` par la route d'appel d'outil
// ---------------------------------------------------------------------------

/** Vue d'un enfant : en cours (`queued|running|stopping`, `last_tool`) ou fini (résultat complet d'un `delegate`). */
export interface SubagentView {
  child_id: string;
  thread_id: string;
  task_index: number;
  goal: string;
  elapsed_s: number;
  status: "queued" | "running" | "stopping" | SubagentStatus;
  last_tool?: string;
  exit_reason?: string;
  summary?: string;
  error?: string;
  worktree?: { path: string; branch: string; commits?: number; dirty?: boolean; kept?: boolean; note?: string };
  isolated?: boolean;
  note?: string;
  tokens?: number;
  /** Montant en CHF (comptes du ledger du noyau). */
  cost?: number;
}

export interface DelegateStatusResult {
  children: SubagentView[];
  running: number;
  finished: number;
  unknown?: string[];
}

export interface DelegateCancelResult {
  cancelled: string[];
  unknown?: string[];
}
