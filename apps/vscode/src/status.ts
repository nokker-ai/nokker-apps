/**
 * Barre d'état (palier, modèle, coût du tour) et notifications de cartes. Pur (sans API VS Code).
 */
import { formatCostLine, type CostLang, type TurnCostEvent } from "@nokker-apps/sdk";
import { choiceLabel, type Translate } from "./i18n.js";
import type { ViewCard } from "./protocol.js";

export interface StatusInfo {
  connected: boolean;
  busy: boolean;
  /** Palier du dernier tour (`turn.done.tier`, sinon le palier du modèle principal de `turn.cost`). */
  tier: string | null;
  /** Modèle principal du dernier tour (le plus de jetons). */
  model: string | null;
  /** Ligne de coût du dernier tour. */
  turnCost: string | null;
  /** Cartes en attente dans la session affichée. */
  cards: number;
  error: string | null;
}

export const EMPTY_STATUS: StatusInfo = { connected: false, busy: false, tier: null, model: null, turnCost: null, cards: 0, error: null };

/** Modèle principal et son palier, d'après `turn.cost.models`. */
export function mainModel(cost: Pick<TurnCostEvent, "models">): { model: string | null; tier: string | null } {
  const models = [...(cost.models ?? [])].sort((a, b) => (b.total_tokens ?? 0) - (a.total_tokens ?? 0));
  const m = models[0];
  return { model: m?.model ?? null, tier: m?.tiers?.[0] ?? null };
}

export function costOf(cost: TurnCostEvent, lang: CostLang): string {
  return formatCostLine(cost, lang);
}

/** Texte et info-bulle de la barre d'état. Icônes : codicons de VS Code (`$(…)`). */
export function statusBar(t: Translate, s: StatusInfo): { text: string; tooltip: string } {
  if (s.error) return { text: `$(warning) Nokker`, tooltip: s.error };
  if (!s.connected) return { text: `$(debug-disconnect) Nokker`, tooltip: t("Nokker: not connected to the local kernel") };
  const parts = [s.busy ? "$(sync~spin) Nokker" : "Nokker"];
  if (s.tier) parts.push(s.tier);
  if (s.model) parts.push(s.model);
  if (s.turnCost) parts.push(s.turnCost);
  let text = parts.join(" · ");
  if (s.cards) text += ` $(bell) ${s.cards}`;
  const tip = [
    s.busy ? t("A turn is running") : t("Ready"),
    s.tier ? t("Tier: {0}", s.tier) : null,
    s.model ? t("Model: {0}", s.model) : null,
    s.turnCost ? t("Last turn: {0}", s.turnCost) : null,
    s.cards ? t("{0} card(s) waiting", s.cards) : null,
  ].filter(Boolean);
  return { text, tooltip: tip.join("\n") };
}

export interface CardNotification {
  text: string;
  /** Boutons (cartes standard seulement) : index du choix dans la carte. */
  actions: Array<{ label: string; index: number }>;
  severity: "info" | "warning";
}

/**
 * Notification d'une carte. Carte standard : « Une fois », « Pour cette session », « Refuser » (les règles « Toujours »
 * restent dans le panneau, où la règle exacte s'affiche). Carte FORTE : aucun bouton, seulement où elle attend
 * (`strongText`, texte de `strongCardText` du SDK) — elle ne se décide jamais depuis l'éditeur.
 */
export function cardNotification(t: Translate, c: ViewCard): CardNotification {
  const what = `${c.tool}${c.target ? ` ${c.target}` : ""}`;
  const short = what.length > 140 ? `${what.slice(0, 139)}…` : what;
  if (!c.choices) {
    return { text: `${c.strongText ?? ""} (${short})`, actions: [], severity: "warning" };
  }
  const actions: CardNotification["actions"] = [];
  for (const id of ["once", "session", "reject"] as const) {
    const ch = c.choices.find((x) => x.id === id);
    if (ch) actions.push({ label: choiceLabel(t, ch, c.tool), index: ch.index });
  }
  return { text: t("Nokker: an action waits for your approval ({0})", short), actions, severity: "info" };
}
