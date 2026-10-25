import type { LocalByokModel, LocalRuntime, LocalRuntimeModel, LocalSetup } from "@nokker-apps/sdk";
import type { Lang } from "./i18n.js";

/**
 * Machine à états de la page `/setup` de Lokkal (premier lancement). Pure : tout ce qui touche au réseau, au
 * minuteur ou au DOM est dans `Setup.tsx`. Les clés d'API ne passent JAMAIS ici (ni état, ni action) : elles restent
 * dans le champ du formulaire, puis partent dans le `PUT /v1/local/setup/models`.
 */

export type LocalStep = "loading" | "unreachable" | "locked" | "models" | "connectors" | "channels" | "done";

/** Flux d'appareil (docs/LOKKAL.md §7.2) : `waiting` porte le code à afficher. */
export type LinkPhase =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "waiting"; code: string; uri: string; expiresAt: number; interval: number }
  /** `unavailable` : 502, nokker.ai ne sert pas encore le lien (pas une panne de l'utilisateur) ; `vault` : 503, le coffre n'a pas sa clé. */
  | { phase: "expired" | "denied" | "error" | "unavailable" | "vault" };

/** Un point d'accès « ma propre clé » (testé ici, ou relu du noyau) : son nom désigne la clé dans le coffre local. */
export interface ByokEntry {
  name: string;
  base_url: string;
  /** Modèle retenu sur ce point d'accès : c'est lui que Lokkal appelle. */
  model: string;
  /** Le coffre tient une clé sous ce nom (vrai dès l'ajout si une clé a été saisie). */
  hasKey: boolean;
  /** Essayée dans cette session mais pas encore envoyée au noyau (la clé est dans le champ du formulaire). */
  pending: boolean;
}

export interface LocalFlowState {
  step: LocalStep;
  lang: Lang;
  routerLinked: boolean;
  account?: string;
  link: LinkPhase;
  byok: ByokEntry[];
  local: LocalRuntimeModel[];
  /** `"router"`, `"byok:<name>"` ou `"local:<url>|<modèle>"` ; `null` tant que rien n'est choisi. */
  chosen: string | null;
  submitting: boolean;
  error?: string;
  /** Au moins un connecteur relié / un code Telegram émis (pour le récapitulatif). */
  connectorsLinked: boolean;
  telegramStarted: boolean;
  /** `POST /v1/local/setup/done` réussi. */
  finished: boolean;
}

export type LocalAction =
  | { type: "set_lang"; lang: Lang }
  | { type: "setup_loaded"; setup: LocalSetup }
  | { type: "setup_failed" }
  | { type: "setup_locked" }
  | { type: "retry" }
  | { type: "link_start" }
  | { type: "link_started"; code: string; uri: string; expiresAt: number; interval: number }
  | { type: "link_status"; state: "pending" | "approved" | "expired" | "denied" | "unlinked"; account?: string }
  | { type: "link_failed" }
  | { type: "link_unavailable" }
  | { type: "link_vault" }
  | { type: "byok_added"; name: string; base_url: string; model: string; hasKey: boolean }
  | { type: "byok_removed"; name: string }
  | { type: "choose"; value: string }
  | { type: "models_submit" }
  | { type: "models_saved"; setup: LocalSetup }
  | { type: "models_failed"; error: string }
  | { type: "connectors_linked"; any: boolean }
  | { type: "telegram_started" }
  | { type: "next" }
  | { type: "finish_submit" }
  | { type: "finish_ok" }
  | { type: "finish_failed"; error: string };

export function initialLocalState(lang: Lang): LocalFlowState {
  return {
    step: "loading",
    lang,
    routerLinked: false,
    link: { phase: "idle" },
    byok: [],
    local: [],
    chosen: null,
    submitting: false,
    connectorsLinked: false,
    telegramStarted: false,
    finished: false,
  };
}

// -- Modèles disponibles ----------------------------------------------------

export interface DefaultOption {
  value: string;
  kind: "router" | "byok" | "local";
  /** Nom de la clé (byok) ou runtime (local) ; sert au libellé. */
  name: string;
  /** Modèle visé (byok et local). */
  model?: string;
}

/** Choix possibles pour le modèle par défaut, dans l'ordre de préférence : Router, mes clés, modèles locaux (un par modèle). */
export function defaultOptions(s: Pick<LocalFlowState, "routerLinked" | "byok" | "local">): DefaultOption[] {
  return [
    ...(s.routerLinked ? [{ value: "router", kind: "router" as const, name: "router" }] : []),
    ...s.byok.map((b) => ({ value: `byok:${b.name}`, kind: "byok" as const, name: b.name, model: b.model })),
    ...s.local.flatMap((l) => l.models.map((model) => ({ value: `local:${l.url}|${model}`, kind: "local" as const, name: l.runtime, model }))),
  ];
}

/** Entrées relues du noyau : une entrée sans modèle ou marquée non essayée ne sert pas de défaut, on ne la reprend pas. */
function byokFromView(list: LocalByokModel[]): ByokEntry[] {
  return list
    .filter((b) => b.ok !== false && !!b.model)
    .map((b) => ({ name: b.name, base_url: b.base_url, model: b.model as string, hasKey: b.has_key, pending: false }));
}

export function isAvailable(s: Pick<LocalFlowState, "routerLinked" | "byok" | "local">, value: string | null): boolean {
  return value !== null && defaultOptions(s).some((o) => o.value === value);
}

/** On ne quitte pas l'étape Modèles sans un modèle par défaut choisi ET disponible. */
export function canContinueModels(s: LocalFlowState): boolean {
  return s.step === "models" && !s.submitting && isAvailable(s, s.chosen);
}

/** Si rien n'est choisi, le premier modèle qui devient disponible l'est d'office (Router > clé > local). */
function withDefault(s: LocalFlowState): LocalFlowState {
  if (s.chosen !== null && isAvailable(s, s.chosen)) return s;
  const first = defaultOptions(s)[0];
  return { ...s, chosen: first ? first.value : null };
}

/** Nom de la clé dans le coffre : l'hôte de l'API, réduit à `[a-z0-9-]` (c'est ce que le noyau accepte). */
export function byokName(baseUrl: string): string {
  let host = "";
  try {
    host = new URL(baseUrl.trim()).hostname;
  } catch {
    host = baseUrl;
  }
  const n = host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return n || "cle";
}

/** Adresse acceptable pour un essai : http(s):// et un hôte non vide (le noyau juge ensuite si ça répond). */
export function validApiUrl(baseUrl: string): boolean {
  const m = /^https?:\/\/([^/?#\s]+)/.exec(baseUrl.trim());
  return !!m && !m[1]!.startsWith("@") && !m[1]!.startsWith(":");
}

export const RUNTIME_LABEL: Record<LocalRuntime, string> = { ollama: "Ollama", llamacpp: "llama.cpp", vllm: "vLLM" };

// -- Réducteur ----------------------------------------------------------------

export function reduceLocal(s: LocalFlowState, a: LocalAction): LocalFlowState {
  switch (a.type) {
    case "set_lang":
      return { ...s, lang: a.lang };
    case "setup_loaded": {
      if (s.step !== "loading") return s;
      const m = a.setup.models;
      const base: LocalFlowState = {
        ...s,
        step: "models",
        routerLinked: m.router.linked,
        account: m.router.account ?? undefined,
        byok: byokFromView(m.byok),
        local: m.local,
        chosen: a.setup.default,
        connectorsLinked: a.setup.connectors.some((c) => c.state !== "absent"),
        telegramStarted: a.setup.channels.some((c) => c.state !== "absent"),
        error: undefined,
      };
      return withDefault(base);
    }
    case "setup_failed":
      return s.step === "loading" ? { ...s, step: "unreachable" } : s;
    case "setup_locked":
      return s.step === "loading" ? { ...s, step: "locked" } : s;
    case "retry":
      return s.step === "unreachable" ? { ...s, step: "loading" } : s;
    case "link_start":
      if (s.step !== "models" || s.routerLinked || s.link.phase === "starting" || s.link.phase === "waiting") return s;
      return { ...s, link: { phase: "starting" } };
    case "link_started":
      return s.link.phase === "starting" ? { ...s, link: { phase: "waiting", code: a.code, uri: a.uri, expiresAt: a.expiresAt, interval: a.interval } } : s;
    case "link_status": {
      if (s.link.phase !== "waiting") return s;
      if (a.state === "pending") return s;
      if (a.state === "approved") return withDefault({ ...s, routerLinked: true, account: a.account ?? undefined, link: { phase: "idle" } });
      if (a.state === "unlinked") return { ...s, link: { phase: "idle" } };
      return { ...s, link: { phase: a.state } };
    }
    case "link_failed":
      return s.link.phase === "starting" || s.link.phase === "waiting" ? { ...s, link: { phase: "error" } } : s;
    case "link_unavailable":
      return s.link.phase === "starting" || s.link.phase === "waiting" ? { ...s, link: { phase: "unavailable" } } : s;
    case "link_vault":
      return s.link.phase === "starting" || s.link.phase === "waiting" ? { ...s, link: { phase: "vault" } } : s;
    case "byok_added": {
      if (s.step !== "models" || !a.model) return s;
      const entry: ByokEntry = { name: a.name, base_url: a.base_url, model: a.model, hasKey: a.hasKey, pending: true };
      return withDefault({ ...s, byok: [...s.byok.filter((b) => b.name !== a.name), entry], error: undefined });
    }
    case "byok_removed":
      return s.step === "models" ? withDefault({ ...s, byok: s.byok.filter((b) => b.name !== a.name), error: undefined }) : s;
    case "choose":
      return s.step === "models" && isAvailable(s, a.value) ? { ...s, chosen: a.value, error: undefined } : s;
    case "models_submit":
      return canContinueModels(s) ? { ...s, submitting: true, error: undefined } : s;
    case "models_saved": {
      if (s.step !== "models" || !s.submitting) return s;
      return { ...s, step: "connectors", submitting: false, byok: byokFromView(a.setup.models.byok), chosen: a.setup.default ?? s.chosen };
    }
    case "models_failed":
      return s.step === "models" && s.submitting ? { ...s, submitting: false, error: a.error } : s;
    case "connectors_linked":
      return { ...s, connectorsLinked: a.any };
    case "telegram_started":
      return { ...s, telegramStarted: true };
    case "next":
      if (s.step === "connectors") return { ...s, step: "channels" };
      if (s.step === "channels") return { ...s, step: "done" };
      return s;
    case "finish_submit":
      return s.step === "done" && !s.submitting && !s.finished && isAvailable(s, s.chosen) ? { ...s, submitting: true, error: undefined } : s;
    case "finish_ok":
      return s.step === "done" && s.submitting ? { ...s, submitting: false, finished: true } : s;
    case "finish_failed":
      return s.step === "done" && s.submitting ? { ...s, submitting: false, error: a.error } : s;
    default:
      return s;
  }
}

/** Sans Router, une phrase dit ce qui manque (passerelle, miroir) ; avec Router, rien. */
export function missingWithoutRouter(s: Pick<LocalFlowState, "routerLinked">): boolean {
  return !s.routerLinked;
}
