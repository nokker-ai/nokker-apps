/**
 * `/model` — modèles de la machine Lokkal, pur (sans Ink ni réseau), testé par `test/models.test.ts`.
 *
 * Ce que le noyau offre (p2/integ-gel-1511) :
 *  - `GET /v1/local/setup` : Routeur (lié ou non, modèle servi), entrées byok (nom, point d'accès, modèle retenu),
 *    modèles locaux détectés, `default` (`router` | `byok:<nom>` | `local:<url>|<modèle>`) ;
 *  - `PUT /v1/local/setup/models` : `{default}` change le défaut de TOUTE la machine. `byok` REMPLACE la liste stockée
 *    (une entrée absente disparaît, sa clé quitte le coffre) : la CLI n'envoie donc JAMAIS `byok`, seulement `default`.
 *  - AUCUN choix par session ni par fil : le champ `model` du corps de `/v1/chat/completions` est ignoré par le noyau,
 *    et il n'y a pas de route `…/sessions/{fil}/model`. `/model <nom>` ne peut donc que changer le défaut de la machine,
 *    après une carte de confirmation.
 */
import type { LocalDefaultModel, LocalSetup } from "@nokker-apps/sdk";
import { t } from "./i18n/index.js";

export interface ModelChoice {
  /** Valeur de `default` côté noyau. */
  id: LocalDefaultModel;
  kind: "router" | "byok" | "local";
  /** Nom court tapé après `/model` (`router`, nom de l'entrée byok, nom du modèle local). */
  name: string;
  /** Modèle servi, s'il est connu. */
  model: string | null;
  /** Le noyau accepte ce choix comme défaut (Routeur lié, entrée byok avec un modèle). */
  usable: boolean;
  /** Pourquoi le choix n'est pas utilisable (affiché), `null` s'il l'est. */
  why: string | null;
  isDefault: boolean;
}

/** Les modèles de la machine, dans l'ordre du réglage : Routeur, entrées byok, modèles locaux détectés. */
export function modelChoices(setup: LocalSetup): ModelChoice[] {
  const def = setup.default;
  const out: ModelChoice[] = [];
  const r = setup.models.router;
  out.push({
    id: "router",
    kind: "router",
    name: "router",
    model: r.model ?? null,
    usable: r.linked,
    why: r.linked ? null : t("no nokker.ai account linked"),
    isDefault: def === "router",
  });
  for (const b of setup.models.byok) {
    const id = `byok:${b.name}`;
    const model = b.model ?? null;
    out.push({ id, kind: "byok", name: b.name, model, usable: model !== null, why: model ? null : t("no model chosen on this endpoint"), isDefault: def === id });
  }
  for (const l of setup.models.local) {
    for (const m of l.models) {
      const id = `local:${l.url}|${m}`;
      out.push({ id, kind: "local", name: m, model: m, usable: true, why: null, isDefault: def === id });
    }
  }
  return out;
}

/** Libellé court d'un choix : `router (qwen/…)`, `byok:own (qwen3.8-27b)`, `local qwen3:8b (ollama)`. */
export function choiceTitle(c: ModelChoice): string {
  if (c.kind === "router") return c.model ? `router (${c.model})` : `router (${t("auto routing")})`;
  if (c.kind === "byok") return c.model ? `${c.id} (${c.model})` : c.id;
  return `local ${c.name}`;
}

/** Modèle affiché dans l'en-tête : le défaut de la machine, `null` s'il n'est pas connu (l'en-tête garde « routage auto »). */
export function headerModel(setup: LocalSetup | null): string | null {
  if (!setup?.default) return null;
  const hit = modelChoices(setup).find((c) => c.isDefault);
  if (!hit) return setup.default;
  if (hit.kind === "router") return hit.model ?? t("auto routing");
  return hit.kind === "byok" ? (hit.model ? `${hit.id} · ${hit.model}` : hit.id) : hit.name;
}

/** Aucun modèle réglé : pas de défaut choisi ET pas de Router relié (relié sans choix, les paliers de la config servent,
 * comme `setup.has_model` côté noyau). `false` si le réglage est inconnu : on ne l'affirme pas sans l'avoir lu. */
export function noModelSet(setup: LocalSetup | null): boolean {
  return !!setup && !setup.default && !setup.models.router.linked;
}

/** Texte de `/model` : la liste, le défaut, et ce que fait `/model <nom>`. */
export function formatModels(setup: LocalSetup): string {
  const choices = modelChoices(setup);
  const lines = [t("Models of this machine:")];
  for (const c of choices) {
    const mark = c.isDefault ? "›" : " ";
    const tail = c.isDefault ? `  ← ${t("default")}` : c.usable ? "" : `  (${c.why})`;
    lines.push(`  ${mark} ${choiceTitle(c)}${tail}`);
  }
  if (choices.length === 1 && !choices[0]!.usable) lines.push(`  ${t("No model ready: set one up in the web app (Settings → Models).")}`);
  lines.push(setup.default ? t("Default: {0}.", setup.default) : t("No default model chosen yet."));
  lines.push(t("The core cannot pick a model for a single session yet: /model <name> changes the default of the whole machine, after a confirmation."));
  return lines.join("\n");
}

export type ModelPick = { kind: "ok"; choice: ModelChoice } | { kind: "none"; query: string } | { kind: "ambiguous"; query: string; ids: string[] } | { kind: "unusable"; choice: ModelChoice };

/** `/model <requête>` : id exact (`byok:own`, `router`, `local:<url>|<m>`), puis nom court (`own`, `qwen3:8b`). */
export function pickModel(setup: LocalSetup, query: string): ModelPick {
  const q = query.trim();
  const choices = modelChoices(setup);
  const exact = choices.find((c) => c.id === q);
  const hits = exact ? [exact] : choices.filter((c) => c.name.toLowerCase() === q.toLowerCase());
  if (hits.length === 0) return { kind: "none", query: q };
  if (hits.length > 1) return { kind: "ambiguous", query: q, ids: hits.map((c) => c.id) };
  const choice = hits[0]!;
  return choice.usable ? { kind: "ok", choice } : { kind: "unusable", choice };
}
