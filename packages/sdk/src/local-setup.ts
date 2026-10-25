/**
 * Lokkal — réglage du premier lancement (`/v1/local/*`), servi par le noyau local sur http://127.0.0.1:<port>.
 * Contrat : docs/LOKKAL.md §7.1 (setup, test de modèle) et §7.2 (lien avec un compte nokker.ai) du dépôt nokker.
 *
 * Toutes ces routes exigent le jeton local en `Authorization: Bearer` (`client.setToken`) : 401 sans lui (§7.1).
 * Formes alignées sur le noyau réel (`nokker/local/{api,setup}.py` de `p2/lokkal`). Les erreurs ont la forme de la
 * bêta, `{error:{message}}`, sans code : 400 entrée invalide, 401 jeton local requis, 403 Host refusé, 502 service de lien
 * nokker.ai indisponible, 503 coffre sans `NOKKER_LOCAL_SECRET_KEY`.
 * `connectors` est toujours `[]` dans la vue du noyau : les connecteurs passent par leurs routes propres.
 */
import type { ConnectorCard } from "./onboarding.js";

export type LocalRuntime = "ollama" | "llamacpp" | "vllm";

export interface LocalRouterInfo {
  /** Compte nokker.ai lié (flux d'appareil) : le Router devient utilisable comme modèle par défaut. */
  linked: boolean;
  /** Libellé public du compte lié (adresse), jamais la clé du Router. `null` ou absent tant que rien n'est lié. */
  account?: string | null;
  /** Modèle servi par le Router (noyau ≥ c8f861f), ex. `qwen/qwen3.5-397b-a17b`. */
  model?: string;
}

/**
 * Un point d'accès « ma propre clé ». La clé n'est jamais renvoyée : `has_key` dit seulement si le coffre en tient une
 * sous ce nom. La vue ne porte PAS la liste des modèles du point d'accès (seulement celui retenu, `model`) ;
 * `ok` est ce que le client a envoyé au dernier PUT (essai réussi), `null` si rien.
 */
export interface LocalByokModel {
  name: string;
  base_url: string;
  model?: string | null;
  ok?: boolean | null;
  has_key: boolean;
}

/** Modèle local détecté (Ollama sur `host.docker.internal:11434`, ou `localhost` hors container). */
export interface LocalRuntimeModel {
  runtime: LocalRuntime;
  url: string;
  models: string[];
}

/** `"router"`, `"byok:<name>"` ou `"local:<url>|<modèle>"` (le noyau ne contrôle que le préfixe). */
export type LocalDefaultModel = string;

/** PROPOSITION : la bêta n'a pas de liste de canaux. `pending` : code d'appairage émis, pas encore utilisé. */
export interface LocalChannelCard {
  kind: "telegram";
  state: "absent" | "pending" | "linked";
}

/** `GET /v1/local/setup`. `default` est `null` tant que rien n'est choisi (premier lancement). */
export interface LocalSetup {
  done: boolean;
  models: {
    router: LocalRouterInfo;
    byok: LocalByokModel[];
    local: LocalRuntimeModel[];
  };
  default: LocalDefaultModel | null;
  connectors: ConnectorCard[];
  channels: LocalChannelCard[];
}

/** `POST /v1/local/setup/models/test` — la clé sert à l'essai, n'est jamais renvoyée ni journalisée. */
export interface LocalModelTestRequest {
  base_url: string;
  api_key?: string;
}

/**
 * Réponse 200 même si `ok` est faux. `error` est un texte libre du noyau : nom d'exception httpx (`ConnectError`,
 * `ReadTimeout`…), `HTTP 401`, ou `base_url http(s) requise` ; absent quand `ok`. `latency_ms` est `null` sans réponse.
 */
export interface LocalModelTestResult {
  ok: boolean;
  models: string[];
  latency_ms: number | null;
  error?: string | null;
}

/**
 * Entrée de `PUT /v1/local/setup/models`. `api_key` est rangée dans le coffre local sous `byok:<name>` ; omise, la clé
 * déjà rangée est gardée. `model` (modèle retenu sur ce point d'accès) et `ok` (essai réussi) sont tenus tels quels.
 */
export interface LocalByokInput {
  name: string;
  base_url: string;
  model?: string;
  ok?: boolean;
  api_key?: string;
}

/** `byok` REMPLACE la liste stockée (une entrée absente disparaît) ; absent, la liste est gardée. */
export interface PutLocalModelsRequest {
  default?: LocalDefaultModel;
  byok?: LocalByokInput[];
}

/** `POST /v1/local/link/start` : démarre le flux d'appareil (comme `gh auth login`). */
export interface LocalLinkStart {
  /** Code court à saisir sur `verification_uri`, ex. `KMRT-4829`. */
  user_code: string;
  /** Toujours https://app.nokker.ai/link. */
  verification_uri: string;
  /** Secondes de validité du code. */
  expires_in: number;
  /** Secondes minimales entre deux sondages de `GET /v1/local/link/status`. */
  interval: number;
}

/** `GET /v1/local/link/status`. `unlinked` : ni flux en cours ni clé ; `expired` : un flux commencé puis échu. `approved` : la clé du Router (inférence seulement, révocable depuis « mes machines ») est rangée dans le coffre local. */
export interface LocalLinkStatus {
  state: "pending" | "approved" | "expired" | "denied" | "unlinked";
  account?: string | null;
  /** Le compte peut publier des pages (§7.26 ; abonné ou compte vérifié, dit par nokker.ai). Absent : inconnu. */
  pages_public?: boolean;
}

/** `DELETE /v1/local/link` : la clé du Router est révoquée au mieux puis effacée du coffre. */
export interface LocalLinkRemoved {
  state: "unlinked";
}
