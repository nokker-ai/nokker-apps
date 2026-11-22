/**
 * Historique de navigation de la coque (LOKKAL-PHONE §1.1 W2) : chaque vue ouverte (Mon compte, Connecteurs…) et le
 * tiroir des sessions au téléphone sont des entrées d'historique. Le bouton retour (navigateur, geste iOS, bouton
 * Android de l'app) ferme d'abord le tiroir, puis revient à la vue d'avant, puis au fil d'avant (le fil est dans le
 * hash `#/t/<id>`, suivi par le store) ; dans l'app, au bout de l'historique, il quitte.
 *
 * Pur et testable : `createNav` ne connaît qu'un objet qui ressemble à `window.history` et un rappel d'état.
 */

export interface NavEntry {
  nk: 1;
  tab: string;
  drawer: boolean;
}

export interface HistoryLike {
  readonly state: unknown;
  pushState(data: unknown, unused: string, url?: string | null): void;
  replaceState(data: unknown, unused: string, url?: string | null): void;
  back(): void;
}

export const isEntry = (s: unknown): s is NavEntry => !!s && typeof s === "object" && (s as { nk?: unknown }).nk === 1 && typeof (s as { tab?: unknown }).tab === "string";

export interface Nav {
  /** Ouvre une vue : nouvelle entrée (rien si c'est déjà elle). */
  go(tab: string): void;
  /** Tiroir des sessions (téléphone) : ouvrir pousse une entrée ; le fermer revient en arrière si c'est elle. `then` :
   * ce qu'on y a choisi (un fil, une vue), appliqué APRÈS le retour (asynchrone) — sinon le retour défait le choix, et
   * une entrée remplacée resterait morte dans l'historique. */
  openDrawer(): void;
  closeDrawer(then?: () => void): void;
  /** À brancher sur `popstate` : rend l'état à afficher (ou rien si l'entrée n'est pas à nous). */
  onPop(state: unknown): NavEntry | null;
  current(): NavEntry;
}

export function createNav(h: HistoryLike, initialTab: string, apply: (e: NavEntry) => void): Nav {
  let cur: NavEntry = { nk: 1, tab: initialTab, drawer: false };
  let pending: (() => void) | null = null;
  // L'entrée d'arrivée devient la nôtre (sans changer l'adresse), en gardant ce que d'autres y ont mis.
  h.replaceState({ ...(h.state && typeof h.state === "object" ? h.state : {}), ...cur }, "");
  const set = (e: NavEntry): void => {
    cur = e;
    apply(e);
  };
  return {
    go(tab) {
      if (tab === cur.tab && !cur.drawer) return;
      // Choisir une vue depuis le tiroir ouvert : l'entrée du tiroir est remplacée (retour = vue d'avant, pas le tiroir).
      const e: NavEntry = { nk: 1, tab, drawer: false };
      if (cur.drawer) h.replaceState(e, "");
      else h.pushState(e, "");
      set(e);
    },
    openDrawer() {
      if (cur.drawer) return;
      const e: NavEntry = { ...cur, drawer: true };
      h.pushState(e, "");
      set(e);
    },
    closeDrawer(then) {
      if (cur.drawer && isEntry(h.state) && h.state.drawer) {
        pending = then ?? null;
        h.back();
        return;
      }
      if (cur.drawer) set({ ...cur, drawer: false });
      then?.();
    },
    onPop(state) {
      const then = pending;
      pending = null;
      if (!isEntry(state)) {
        // Entrée d'un autre (lien #/t/… suivi par le store) : on ferme seulement le tiroir.
        if (cur.drawer) set({ ...cur, drawer: false });
        then?.();
        return null;
      }
      set({ nk: 1, tab: state.tab, drawer: state.drawer });
      then?.();
      return cur;
    },
    current: () => cur,
  };
}

/** Changer de fil : nouvelle entrée (le retour ramène au fil d'avant) ; le premier fil choisi remplace l'entrée. */
export function threadUrl(h: HistoryLike, id: string, push: boolean, route = `#/t/${id}`): void {
  const state = h.state && typeof h.state === "object" ? { ...(h.state as object), drawer: false } : null;
  if (push) h.pushState(state, "", route);
  else h.replaceState(state, "", route);
}
