/**
 * Messages entre l'extension (Node) et le panneau (webview). Le panneau n'a ni jeton ni accès réseau : tout passe par
 * l'extension.
 */

export interface ViewChoice {
  /** Index dans les choix de la carte (renvoyé tel quel par le panneau). */
  index: number;
  id: "once" | "session" | "always" | "reject";
  key: string;
  label: string;
  rule?: string;
}

export interface ViewCard {
  id: string;
  tool: string;
  target: string;
  effect: string;
  reason: string;
  /** `null` : carte forte, jamais décidée depuis le panneau. */
  choices: ViewChoice[] | null;
  /** Carte forte déposée chez nokker.ai (elle attend le téléphone) ; faux : à décider dans le terminal. */
  forwarded: boolean;
  /** Carte forte : ce que le panneau affiche à la place des boutons (où elle attend) ; `null` sinon. Une carte déjà
   * affichée peut être renvoyée (même `id`) quand elle part au téléphone : le panneau met ce texte à jour. */
  strongText: string | null;
  expiresAt: string;
}

export interface ViewDiff {
  id: string;
  relPath: string;
  fragment: boolean;
  created: boolean;
}

export interface ViewTool {
  callId: string;
  name: string;
  target: string;
  effect: string | null;
  status: "in_progress" | "completed" | "failed";
  preview: string | null;
  ms: number | null;
  depth: number;
  diffs: ViewDiff[];
}

export interface ViewContextItem {
  id: string;
  label: string;
}

/** Bloc vivant d'une écriture en direct (X22) : les dernières lignes proposées par le modèle. */
export interface ViewLive {
  callId: string;
  name: string;
  path: string | null;
  tail: string[];
  truncated: boolean;
  done: boolean;
  discarded: boolean;
}

export type ToView =
  | { type: "state"; connected: boolean; busy: boolean; folder: string | null; server: string; threadId: string | null; error: string | null }
  | { type: "history"; messages: Array<{ role: "user" | "assistant"; text: string }> }
  | { type: "user"; text: string; context: string[] }
  | { type: "text"; append: string }
  | { type: "textReplace"; text: string }
  | { type: "tool"; tool: ViewTool }
  | { type: "card"; card: ViewCard }
  | { type: "cardClosed"; id: string; status: string }
  | { type: "cost"; line: string }
  | { type: "notice"; text: string }
  | { type: "turnEnd"; stopReason: "end_turn" | "cancelled" | "error" }
  | { type: "context"; items: ViewContextItem[] }
  | { type: "live"; live: ViewLive }
  | { type: "review"; files: number; pending: number }
  | { type: "prefill"; text: string }
  | { type: "error"; text: string };

export type FromView =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "cancel" }
  | { type: "decide"; id: string; index: number }
  | { type: "openDiff"; id: string }
  | { type: "removeContext"; id: string }
  | { type: "newThread" }
  | { type: "reconnect" }
  | { type: "openLive"; callId: string }
  | { type: "pickFile" }
  | { type: "openReview" };
