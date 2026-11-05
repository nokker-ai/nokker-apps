/**
 * BYOK sur nokker.ai (lot du 05.11.2026) : dans Mon compte → Modèles, le client choisit entre le Router (son plan)
 * et sa propre inférence compatible OpenAI. Contrat annoncé par Nokker dev (branche noyau p2/cloud-byok, forme à
 * confirmer à la livraison) :
 * - `GET /v1/account/models` → {default:"router"|"byok:<nom>", byok:[{name,base_url,model,has_key,ok?}], entitled}
 * - `PUT /v1/account/models` {default, byok?:[{name,base_url,model,api_key?}]} — `byok` REMPLACE la liste ; une clé
 *   omise reste au coffre ; la clé n'est jamais relue.
 * - `POST /v1/account/models/test` {base_url, api_key?} → même forme que l'essai Lokkal.
 * `entitled` faux : la formule du compte ne comprend pas le BYOK (formule « BYOK » ou Solo). URL en https seulement.
 */
import type { LocalModelTestRequest, LocalModelTestResult } from "./local-setup.js";

export type AccountDefaultModel = "router" | `byok:${string}`;

export interface AccountByokModel {
  name: string;
  base_url: string;
  model?: string | null;
  /** `null` : coffre des clés indisponible. */
  has_key: boolean | null;
  /** Dernier test fait par le serveur. */
  ok?: boolean | null;
  /** Modèles listés par `GET <base_url>/models` (absent si vide). */
  models?: string[];
}

export interface AccountModels {
  default: AccountDefaultModel;
  /** Ce que les tours utilisent ; `"none"` : formule BYOK sans modèle utilisable (un tour répond `byok:not_configured`). */
  effective: AccountDefaultModel | "none";
  /** Faux en formule `byok` : pas de Router, l'option n'est pas proposée. Absent (noyau d'avant 43fb3b4) : vrai. */
  router_included?: boolean;
  byok: AccountByokModel[];
  entitled: boolean;
}

/** Au plus 8 entrées ; nom `[A-Za-z0-9][A-Za-z0-9_.-]{0,31}`. */
export const ACCOUNT_BYOK_MAX = 8;
export const ACCOUNT_BYOK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

export interface AccountByokInput {
  name: string;
  base_url: string;
  model?: string;
  api_key?: string;
}

export interface PutAccountModelsRequest {
  default?: AccountDefaultModel;
  byok?: AccountByokInput[];
}

export interface AccountModelTestRequest extends LocalModelTestRequest {
  model?: string;
}

export interface AccountModelTestResult extends LocalModelTestResult {
  /** Présent si `model` est donné : ce modèle figure-t-il dans la liste ? */
  model_listed?: boolean;
}
