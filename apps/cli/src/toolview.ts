/**
 * Modèle d'affichage des appels d'outils — pur (sans Ink), testé par `test/toolview.test.ts`.
 * `tool.call` et `tool.result` sont reliés par `call_id` (jamais par nom : deux `terminal` se suivent).
 *
 * Écriture en direct (X22, BUBBLES.md §6) : les `tool.input.delta` d'un `write_file`/`patch`/`page_create` arrivent
 * AVANT son `tool.call` ; le premier crée la ligne (provisoire), les suivants accumulent le texte vivant affiché sous
 * elle. Le `tool.call` met la ligne à jour (pas de doublon), le `tool.result` replie le bloc, `turn.done` replie tout
 * (et retire une ligne jamais appelée : rien n'a été exécuté).
 *
 * Carte posée par le modèle (LOKKAL.md §7.4.9) : le premier `tool.result` dit « en attente d'approbation
 * [approval:<id>] » et la ligne reste ouverte (⏸) ; approuvée, l'outil s'exécute en fond et son vrai résultat arrive
 * par un second `tool.result` du même `call_id` (avec `approval_id`) ; refusée ou expirée, `approval.decided` la ferme.
 */
import { homedir } from "node:os";
import { liveTail, type LocalToolEffect, type NokkerEvent } from "@nokker-apps/sdk";
import { t } from "./i18n/index.js";

export interface ToolLine {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  effect: LocalToolEffect | null;
  /** `null` = en cours. */
  ok: boolean | null;
  ms: number | null;
  /** Appel refusé d'emblée (permissions) : raison courte déjà traduite ; absent = pas refusé. */
  refused?: string | null; // texte déjà traduit de ce qui suit « — » : « refused: <raison> » ou « refused by you »
  /** Aperçu du résultat (3 lignes au plus). */
  preview: string | null;
  /** 1 = ligne de sous-agent (indentée). */
  depth: number;
  /** Texte que le modèle est en train d'écrire (`tool.input.delta`) ; `null` = pas de bloc vivant (ou replié). */
  live?: string | null;
  /** Dernier `seq` appliqué au bloc vivant. */
  liveSeq?: number;
  /** Le direct s'est arrêté (appel trop gros) : « … » sous les lignes. */
  truncated?: boolean;
  /** `tool.call` reçu (sinon la ligne ne vient que du direct). */
  called?: boolean;
  turnId?: string | null;
  /** Carte que l'appel attend (`[approval:<id>]` du noyau) ; `null`/absent : aucune. */
  approvalId?: string | null;
  /** Carte approuvée : l'outil tourne (ou attend son tour dans la file du fil). */
  approved?: boolean;
}

/** Marqueur du `tool.result` « en attente » d'un appel qui a posé une carte. */
const PENDING_MARKER = /\[approval:([\w-]+)\]/;

/** Nombre de lignes écrites qui défilent sous la ligne de l'outil. */
export const LIVE_WINDOW = 6;

/** Effet en clair, dans la langue de l'interface ; `null` pour un effet inconnu. */
export function effectName(effect: LocalToolEffect | string): string | null {
  switch (effect) {
    case "read":
      return t("read");
    case "write":
      return t("write");
    case "destructive":
      return t("destructive");
    case "send_external":
      return t("send");
    case "spend":
      return t("spend");
    case "secret":
      return t("secret");
    default:
      return null;
  }
}

export const EFFECT_COLOR: Record<LocalToolEffect, string> = {
  read: "gray",
  write: "cyan",
  destructive: "redBright",
  send_external: "yellow",
  spend: "yellow",
  secret: "magenta",
};

/** Montage du dossier de la session dans le bac à sable docker du noyau (`WORKSPACE_MOUNT` de nokker/tools/code.py,
 * `CodeToolSource.mount`). Le noyau ne l'envoie PAS au client (`POST /v1/local/sessions` rend `{thread_id, cwd}`) :
 * valeur par défaut du noyau, supposée ici. En backend `local` (sans bac à sable) les chemins sont déjà réels. */
export const SANDBOX_MOUNT = "/workspace";

let workspaceView: { mount: string; local: string } | null = null;

/** Dossier local de la session de code affichée (`null` : fil ordinaire, aucune réécriture). Posé par l'App à
 * l'ouverture et au changement de session ; le mode `-p` ne le pose pas (sa sortie JSON garde les chemins du noyau). */
export function setWorkspaceView(local: string | null, mount: string | null = SANDBOX_MOUNT): void {
  // `mount` : le `workspace` rendu par le noyau (chaîne : montage ; `null` : pas de montage, rien n'est traduit) ;
  // absent (ancien noyau) : le montage par défaut `/workspace`.
  if (!local || !mount) {
    workspaceView = null;
    return;
  }
  const home = homedir();
  const shown = home && (local === home || local.startsWith(home + "/")) ? `~${local.slice(home.length)}` : local;
  workspaceView = { mount: mount.replace(/\/+$/, ""), local: shown.replace(/\/+$/, "") || "/" };
}

/** Réécrit pour l'écran les chemins du bac à sable (`/workspace/calc.py`) en chemins du dossier de l'utilisateur
 * (`~/nokker/calc/calc.py`). Seulement un chemin entier qui COMMENCE par le montage (`/workspace`, `/workspace/…`), pas
 * `/workspaces` ni `/x/workspace`. Affichage seulement : arguments, résultats et requêtes ne passent jamais par ici. */
export function displayPath(text: string): string {
  const v = workspaceView;
  if (!v || !text.includes(v.mount)) return text;
  const esc = v.mount.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[\\s"'\`=:(\\[,<>])${esc}(?=$|[/\\s"'\`)\\],:;<>])`, "gm");
  return text.replace(re, (_m, pre: string) => pre + v.local);
}

/** Cible lisible : la commande pour `terminal`, sinon le chemin, le motif ou le premier champ texte (chemins du bac à
 * sable réécrits en chemins locaux, `displayPath`). */
export function toolTarget(name: string, args: Record<string, unknown>): string {
  return displayPath(rawToolTarget(name, args));
}

function rawToolTarget(name: string, args: Record<string, unknown>): string {
  if (name === "terminal" && typeof args.command === "string") return args.command;
  for (const key of ["path", "pattern", "query", "url", "goal", "command"]) {
    const v = args[key];
    if (typeof v === "string" && v) return v;
  }
  // `delegate {tasks: [{goal}]}` : aucun champ texte à plat — la carte affichait « Cible : » vide.
  if (Array.isArray(args.tasks)) {
    const goals = args.tasks.map((x) => (x && typeof x === "object" ? (x as { goal?: unknown }).goal : null)).filter((g): g is string => typeof g === "string" && g !== "");
    if (goals.length) return (goals.length > 1 ? `${goals[0]!.slice(0, 70)} (+${goals.length - 1})` : goals[0]!).slice(0, 90);
  }
  const first = Object.values(args).find((v) => typeof v === "string") as string | undefined;
  return first ? first.slice(0, 80) : "";
}

/** `⟳ patch src/app.py (écriture)` en cours ; `✓ patch src/app.py 120 ms` à la fin ; `✗ …` en échec. */
export function formatToolLine(l: ToolLine): string {
  const target = toolTarget(l.name, l.args);
  const head = `${l.name}${target ? ` ${target}` : ""}`;
  if (l.ok === null && l.approvalId) return l.approved ? t("⟳ {0} (approved, running…)", head) : t("⏸ {0} (waiting for approval)", head);
  if (l.ok === null) return `⟳ ${head}${l.effect ? ` (${effectName(l.effect) ?? l.effect})` : ""}`;
  if (l.refused) return `✗ ${head} — ${l.refused}`;
  return `${l.ok ? "✓" : "✗"} ${head}${l.ms !== null ? ` ${l.ms} ms` : ""}`;
}

function isRefused(e: { status?: string; is_error?: boolean; reason?: string }): boolean {
  return e.status === "refused" || (e.is_error === true && typeof e.reason === "string" && /^permissions:/.test(e.reason));
}

/** Ce qui suit « — » sur la ligne d'un appel refusé : la personne a refusé la carte (reason « declined ») : « refused by you » ;
 * sinon refus d'emblée par les permissions : « refused: <raison> ». */
export function refusedText(reason: string | undefined): string {
  return (reason ?? "").replace(/^permissions:/, "") === "declined" ? t("refused by you") : t("refused: {0}", refusedReason(reason));
}

/** Raison courte d'un refus (`permissions:no_code_session`, `plan_mode`, `deny_rule`, `hardline`…). */
export function refusedReason(reason: string | undefined): string {
  const r = (reason ?? "").replace(/^permissions:/, "");
  switch (r) {
    case "no_code_session":
      return t("no code session open");
    case "plan_mode":
      return t("plan mode: read-only");
    case "deny_rule":
      return t("blocked by one of your rules");
    case "hardline":
      return t("never allowed");
    case "":
      return t("not allowed");
    default:
      return r.replace(/_/g, " ");
  }
}

/** Balise d'enveloppe du noyau (`<untrusted-data kind="terminal:output" id="…">`, `</untrusted-data id="…">`) : elle
 * clôture pour le MODÈLE la sortie d'un tiers (nokker/qa/untrusted.py) ; le noyau neutralise toute balise semblable dans
 * le contenu (« [balise retirée] »), donc une vraie balise ne vient que de lui. */
const ENVELOPE_TAG = /<\/?untrusted-data\b[^>\n]*>/g;

/** Retire l'enveloppe à l'affichage : une ligne qui n'est qu'une balise disparaît, une balise en ligne est ôtée ; le
 * contenu reste intact. Le texte n'est modifié que pour l'écran (export, modèle et noyau ne passent pas par ici). */
export function stripEnvelope(text: string): string {
  if (!text.includes("untrusted-data")) return text;
  return text
    .split("\n")
    .filter((l) => !(l.trim() !== "" && l.replace(ENVELOPE_TAG, "").trim() === ""))
    .map((l) => l.replace(ENVELOPE_TAG, ""))
    .join("\n");
}

export function previewLines(preview: string | null): string[] {
  return preview ? displayPath(stripEnvelope(preview)).split("\n").slice(0, 3) : [];
}

/** Les dernières lignes du bloc vivant (au plus `n`, coupées à `width`) ; vide sans bloc. */
export function liveLines(line: ToolLine, n = LIVE_WINDOW, width = Infinity): string[] {
  return line.live ? liveTail(line.live, n, width) : [];
}

/** Applique un événement au tableau de lignes d'outils (immuable). Renvoie le même tableau si l'événement
 * ne concerne pas les outils. Les anciens noyaux (sans `effect`/`args`) restent affichables via `args_preview`. */
export function applyToolEvent(lines: ToolLine[], e: NokkerEvent): ToolLine[] {
  switch (e.type) {
    case "tool.input.delta": {
      const i = lines.findIndex((l) => l.callId === e.call_id);
      const prev = i >= 0 ? lines[i]! : null;
      if (e.discarded) {
        if (!prev) return lines;
        // Proposition abandonnée : la ligne disparaît si l'outil n'a jamais été appelé, sinon seul le bloc se replie.
        return prev.called ? lines.map((l, k) => (k === i ? { ...l, live: null } : l)) : lines.filter((_, k) => k !== i);
      }
      if (prev && (prev.ok !== null || prev.truncated || (prev.liveSeq ?? -1) >= e.seq)) return lines;
      const args = prev?.args.path || !e.path ? prev?.args ?? {} : { ...prev?.args, path: e.path };
      const next: ToolLine = {
        callId: e.call_id,
        name: prev?.name ?? e.name,
        args,
        effect: prev?.effect ?? "write",
        ok: null,
        ms: null,
        preview: null,
        depth: prev?.depth ?? 0,
        live: (prev?.live ?? "") + (e.text ?? ""),
        liveSeq: e.seq,
        truncated: e.truncated === true,
        called: prev?.called ?? false,
        turnId: e.turn_id,
      };
      return prev ? lines.map((l, k) => (k === i ? next : l)) : [...lines, next];
    }
    case "tool.call": {
      const args = e.args ?? (e.args_preview ? { preview: e.args_preview } : {});
      const i = lines.findIndex((l) => l.callId === e.call_id);
      if (i >= 0) {
        // Ligne née du direct : on la complète (arguments caviardés du noyau, effet) au lieu d'en ajouter une.
        return lines.map((l, k) => (k === i ? { ...l, name: e.name, args: { ...l.args, ...args }, effect: e.effect ?? l.effect, called: true, turnId: e.turn_id } : l));
      }
      return [...lines, { callId: e.call_id, name: e.name, args, effect: e.effect ?? null, ok: null, ms: null, preview: null, depth: 0, called: true, turnId: e.turn_id }];
    }
    case "tool.result": {
      const waiting = e.approval_id ? undefined : e.preview?.match(PENDING_MARKER)?.[1];
      if (waiting && !e.is_error) {
        // L'outil n'a pas tourné : la ligne reste ouverte jusqu'à la décision (puis la vraie sortie).
        return lines.map((l) => (l.callId === e.call_id ? { ...l, approvalId: waiting, approved: false, live: null } : l));
      }
      return lines.map((l) =>
        l.callId === e.call_id
          ? {
              ...l,
              ok: e.is_error !== undefined ? !e.is_error : e.ok !== false,
              ms: e.ms ?? null,
              ...(isRefused(e) ? { ok: false, refused: refusedText(e.reason) } : {}),
              // Refus par la personne : la ligne dit déjà « refused by you » ; l'aperçu du noyau (« refusé par <identifiant
              // interne> ») n'est jamais montré.
              preview: isRefused(e) && (e.reason ?? "").replace(/^permissions:/, "") === "declined" ? null : e.preview ?? null,
              effect: l.effect ?? e.effect ?? null,
              live: null,
              approvalId: null,
              approved: false,
            }
          : l,
      );
    }
    case "approval.decided": {
      if (!lines.some((l) => l.approvalId === e.approval_id && l.ok === null)) return lines;
      if (e.decision === "approved") return lines.map((l) => (l.approvalId === e.approval_id && l.ok === null ? { ...l, approved: true } : l));
      // Refus, expiration, annulation : rien n'a été exécuté, et le noyau ne publie pas de `tool.result`.
      const why = e.decision === "expired" ? t("approval expired — not run") : e.decision === "rejected" ? t("rejected — not run") : t("not run");
      return lines.map((l) => (l.approvalId === e.approval_id && l.ok === null ? { ...l, ok: false, preview: why, approvalId: null, approved: false } : l));
    }
    case "turn.done": {
      if (!lines.some((l) => l.turnId === e.turn_id && (l.live != null || !l.called))) return lines;
      return lines
        .filter((l) => !(l.turnId === e.turn_id && !l.called && l.ok === null))
        .map((l) => (l.turnId === e.turn_id && l.live != null ? { ...l, live: null } : l));
    }
    default:
      return lines;
  }
}
