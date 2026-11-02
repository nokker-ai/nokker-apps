/**
 * Navigation de la coque : le chat est la vue principale ; les autres vues ne sont plus une rangée d'onglets en haut.
 * - `work` : vues de travail, dans le tiroir sous la marque (Crew, Code, Incidents, Plan) ;
 * - `settings` : compte et réglages, derrière le menu du compte en haut à droite (Équipe, Foyer, Packs, Connecteurs,
 *   Machine, Mon compte).
 * Toutes restent aussi dans la palette de commandes (Ctrl/⌘ K). Une vue n'apparaît que si son drapeau la sert.
 */
import type { IconName } from "../icons.js";

export type ViewId = "chat" | "crew" | "incidents" | "plan" | "team" | "household" | "packs" | "code" | "connectors" | "account" | "machine" | "learning" | "house" | "folder";

export interface NavView {
  id: Exclude<ViewId, "chat">;
  group: "work" | "settings";
  label: string;
  icon: IconName;
  /** Pastille : nombre d'agents, d'incidents vivants, d'invitations. */
  count?: number;
  /** Lecture d'écran de la pastille (sinon le nombre seul). */
  countLabel?: string;
  /** La pastille signale quelque chose qui attend (invitation, incident) : elle remonte sur le bouton du menu. */
  attention?: boolean;
}

export interface NavFlags {
  agents: number;
  /** `null` : drapeau éteint (vue absente). */
  liveIncidents: number | null;
  plan: boolean;
  teamInvites: number | null;
  householdInvites: number | null;
  packs: boolean;
  code: boolean;
  local: boolean;
  /** Apprentissage : nombre de décisions en attente (notes, règles suggérées) ; `null` : drapeaux éteints. */
  learning: number | null;
  /** « Maison » room (HOUSE-ROOM §6): served (`GET /v1/house` 200) or not. */
  house: boolean;
  /** Folder mode (FOLDER-MODE §6): on the Lokkal machine, `GET /v1/local/folder/runs` 200. Optional: off when absent. */
  folder?: boolean;
}

export interface NavLabels {
  team: string;
  household: string;
  connectors: string;
  account: string;
  incidents: (n: number) => string;
  invitations: (n: number) => string;
  learning: string;
  waiting: (n: number) => string;
  house: string;
  folder?: string;
}

/** Les vues disponibles, dans l'ordre d'affichage (travail d'abord, puis réglages ; « Mon compte » en dernier). */
export function navViews(f: NavFlags, l: NavLabels): NavView[] {
  const v: Array<NavView | false> = [
    f.house && { id: "house", group: "work", label: l.house, icon: "home" },
    { id: "crew", group: "work", label: "Crew", icon: "crew", count: f.agents },
    f.code && { id: "code", group: "work", label: "Code", icon: "code" },
    !!f.folder && { id: "folder", group: "work", label: l.folder ?? "Folder", icon: "folder" },
    f.liveIncidents !== null && {
      id: "incidents",
      group: "work",
      label: "Incidents",
      icon: "alert",
      ...(f.liveIncidents ? { count: f.liveIncidents, countLabel: l.incidents(f.liveIncidents), attention: true } : {}),
    },
    f.plan && { id: "plan", group: "work", label: "Plan", icon: "plan" },
    f.teamInvites !== null && {
      id: "team",
      group: "settings",
      label: l.team,
      icon: "users",
      ...(f.teamInvites ? { count: f.teamInvites, countLabel: l.invitations(f.teamInvites), attention: true } : {}),
    },
    f.householdInvites !== null && {
      id: "household",
      group: "settings",
      label: l.household,
      icon: "home",
      ...(f.householdInvites ? { count: f.householdInvites, countLabel: l.invitations(f.householdInvites), attention: true } : {}),
    },
    f.packs && { id: "packs", group: "settings", label: "Packs", icon: "box" },
    f.learning !== null && {
      id: "learning",
      group: "settings",
      label: l.learning,
      icon: "bot",
      ...(f.learning ? { count: f.learning, countLabel: l.waiting(f.learning), attention: true } : {}),
    },
    { id: "connectors", group: "settings", label: l.connectors, icon: "plug" },
    f.local && { id: "machine", group: "settings", label: "Machine", icon: "cpu" },
    { id: "account", group: "settings", label: l.account, icon: "user" },
  ];
  return v.filter((x): x is NavView => !!x);
}

/** Ce qui attend dans le menu du compte (invitations) : la pastille du bouton. */
export function settingsAttention(views: NavView[]): number {
  return views.filter((v) => v.group === "settings" && v.attention).reduce((n, v) => n + (v.count ?? 0), 0);
}

/** Recherche de la palette : chaque mot de la requête doit apparaître (sans accents ni casse) dans le texte. */
export function matches(query: string, ...texts: string[]): boolean {
  const norm = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const hay = norm(texts.join(" "));
  return norm(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}
