import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Bubble as BubbleT, TransferMode } from "@nokker-apps/sdk";
import { bubbleTheme } from "@nokker-apps/brand";
import { tr } from "../i18n/index.js";
import { useStore } from "../context.js";
import { Icon } from "../icons.js";
import { bubbleLabel, statusLabel } from "../bubbles/kinds.js";
import { loadPositions, loadViews, savePositions, saveViews, type BubblePositions, type BubbleViews } from "../viewState.js";
import { arrange, placeNew, type Rect } from "../placement.js";
import { Bubble, type Popover } from "./Bubble.js";
import { DropMenu } from "./DropMenu.js";
import { anchor, displayTitle } from "../showme/model.js";

interface Rendered {
  b: BubbleT;
  leaving: boolean;
  flying: boolean;
  entering: boolean;
}

interface DragState {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  offX: number;
  offY: number;
  layerLeft: number;
  layerTop: number;
  started: boolean;
  origin: { x?: number; y?: number };
  target: string | null;
}

const LEAVE_MS = 460;
const FLY_MS = 1000;

/** Bulle d'approbation encore à décider (ni terminée ni échouée). */
const pendingApproval = (b: BubbleT): boolean => b.kind === "approval" && b.status !== "done" && b.status !== "failed";
const ENTER_MS = 700;

/**
 * Calque des bulles FLOTTANTES (pas de colonne). Sur grand écran, chaque bulle a une position libre mémorisée par
 * fil ; une nouvelle bulle se pose en cascade dans une zone libre (sans couvrir la dernière réponse de Nina ni la
 * saisie), la plus récente devant ; un clic la ramène devant ; « Ranger » (`arrangeTick`) les rassemble en colonnes
 * à droite. Glisser sur une session du tiroir ouvre Déplacer / Copier.
 * Sur petit écran (`inline`) : bandeau au-dessus du chat, bulles réduites en pastilles, pas de glisser
 * (« Envoyer vers… » reste disponible, comme au clavier).
 */
export function BubbleLayer({
  inline,
  onDropTarget,
  arrangeTick = 0,
}: {
  inline: boolean;
  onDropTarget: (id: string | null) => void;
  arrangeTick?: number;
}): React.ReactElement {
  const store = useStore();
  const { bubbles, threads, current, flying, focusBubble } = store;
  const [views, setViews] = useState<BubbleViews>(() => loadViews());
  const [positions, setPositions] = useState<BubblePositions>(() => loadPositions());
  const [arranging, setArranging] = useState(false);
  const [rendered, setRendered] = useState<Rendered[]>([]);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [popover, setPopover] = useState<{ id: string; kind: Popover } | null>(null);
  const [dropMenu, setDropMenu] = useState<{ bubble: BubbleT; threadId: string; top: number; left: number; origin: { x?: number; y?: number } } | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  /** La marge à droite du fil est plus étroite qu'une bulle (≈ 1280 px) : mode « pile » — pas de position libre, seules la
   * carte en attente la plus récente et la dernière bulle active sont dépliées, les autres se replient sur leur en-tête et
   * s'empilent en bas de la marge. La colonne du fil n'est jamais recouverte. */
  const [narrow, setNarrow] = useState(false);
  const [stack, setStack] = useState<Record<string, { x: number; y: number }>>({});
  /** Bulles déplacées à la main (ou rangées) pendant cette session : elles gardent leur position, hors pile. */
  const dragged = useRef(new Set<string>());
  /** Bulles repliées d'office faute de place (la pile dépliée dépasserait la pile repliée). */
  const [forced, setForced] = useState<Set<string>>(new Set());
  /** En-têtes repliées sans place dans la pile : masquées, comptées par la pastille « +N ». */
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [pileY, setPileY] = useState(0);
  const layerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => saveViews(views), [views]);
  useEffect(() => savePositions(positions), [positions]);

  const threadKey = current?.id ?? "_";
  const posOf = (id: string): { x: number; y: number } | undefined => positions[threadKey]?.[id];
  const setPos = useCallback(
    (patch: Record<string, { x: number; y: number } | undefined>) =>
      setPositions((p) => {
        const cur = { ...(p[threadKey] ?? {}) };
        for (const [id, v] of Object.entries(patch)) {
          if (v) cur[id] = v;
          else delete cur[id];
        }
        return { ...p, [threadKey]: cur };
      }),
    [threadKey],
  );

  // Diff des bulles visibles → animations d'entrée et de sortie (fantôme gardé le temps de l'animation).
  useEffect(() => {
    setRendered((prev) => {
      const out: Rendered[] = [];
      for (const r of prev) {
        const nb = bubbles.find((b) => b.id === r.b.id);
        if (nb) out.push({ ...r, b: nb, leaving: false });
        else out.push(r.leaving ? r : { ...r, leaving: true, flying: flying.has(r.b.id) });
      }
      for (const b of bubbles) if (!prev.some((r) => r.b.id === b.id)) out.push({ b, leaving: false, flying: false, entering: true });
      return out;
    });
    // La plus récente devant.
    setOrder((o) => {
      const known = new Set(o);
      const fresh = bubbles.filter((b) => !known.has(b.id)).sort((a, b) => a.created_at.localeCompare(b.created_at));
      return fresh.length ? [...o, ...fresh.map((b) => b.id)] : o;
    });
  }, [bubbles, flying]);

  useEffect(() => {
    for (const r of rendered) {
      const key = `${r.b.id}:${r.leaving ? "leave" : r.entering ? "enter" : ""}`;
      if ((r.leaving || r.entering) && !timers.current.has(key)) {
        const t = setTimeout(
          () => {
            timers.current.delete(key);
            setRendered((list) =>
              r.leaving ? list.filter((x) => !(x.b.id === r.b.id && x.leaving)) : list.map((x) => (x.b.id === r.b.id ? { ...x, entering: false } : x)),
            );
          },
          r.leaving ? (r.flying ? FLY_MS : LEAVE_MS) : ENTER_MS,
        );
        timers.current.set(key, t);
      }
    }
  }, [rendered]);

  const bringToFront = useCallback((id: string) => setOrder((o) => [...o.filter((x) => x !== id), id]), []);

  const onGripDown = useCallback(
    (b: BubbleT) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || inline) return;
      const el = (e.currentTarget as HTMLElement).closest(".bubble");
      const layer = layerRef.current;
      if (!el || !layer) return;
      const r = el.getBoundingClientRect();
      const L = layer.getBoundingClientRect();
      bringToFront(b.id);
      setPopover(null);
      dragRef.current = {
        id: b.id,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        offX: e.clientX - r.left,
        offY: e.clientY - r.top,
        layerLeft: L.left,
        layerTop: L.top,
        started: false,
        origin: { ...posOf(b.id) },
        target: null,
      };
      e.preventDefault();
    },
    [bringToFront, inline, views],
  );

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      if (!d.started && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
      d.started = true;
      const x = e.clientX - d.offX - d.layerLeft;
      const y = e.clientY - d.offY - d.layerTop;
      setDrag({ id: d.id, x, y });
      const bubble = bubbles.find((b) => b.id === d.id);
      let target: string | null = null;
      for (const row of document.querySelectorAll<HTMLElement>("[data-thread-id]")) {
        const rr = row.getBoundingClientRect();
        if (e.clientX >= rr.left && e.clientX <= rr.right && e.clientY >= rr.top && e.clientY <= rr.bottom) {
          const id = row.dataset.threadId ?? null;
          const from = bubble?.thread_id ?? (bubble?.kind === "notify" ? bubble.state.from_thread : null);
          target = id && id !== from ? id : null;
        }
      }
      if (target !== d.target) {
        d.target = target;
        onDropTarget(target);
      }
    };
    const up = (e: PointerEvent): void => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      dragRef.current = null;
      if (!d.started) return;
      const x = e.clientX - d.offX - d.layerLeft;
      const y = e.clientY - d.offY - d.layerTop;
      setDrag(null);
      const row = d.target ? document.querySelector<HTMLElement>(`[data-thread-id="${d.target}"]`) : null;
      const rr = row?.getBoundingClientRect();
      // Déposée sur une session : la bulle se range sous le menu Déplacer/Copier, à droite du tiroir — la
      // session ciblée reste visible (surlignée) et rien ne sort de l'écran.
      dragged.current.add(d.id);
      setPos({ [d.id]: rr ? { x: rr.right + 10 - d.layerLeft, y: rr.top + 108 - d.layerTop } : { x: Math.max(0, x), y: Math.max(0, y) } });
      if (d.target) {
        const bubble = bubbles.find((b) => b.id === d.id);
        if (bubble && rr) setDropMenu({ bubble, threadId: d.target, top: rr.top, left: rr.right + 10, origin: d.origin });
        else onDropTarget(null);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [bubbles, onDropTarget, setPos]);

  const restore = useCallback(
    (id: string, origin: { x?: number; y?: number }) => setPos({ [id]: origin.x !== undefined ? { x: origin.x, y: origin.y! } : undefined }),
    [setPos],
  );

  const finishDrop = (mode: TransferMode | null): void => {
    const m = dropMenu;
    if (!m) return;
    setDropMenu(null);
    onDropTarget(null);
    if (mode === null || mode === "copy") restore(m.bubble.id, m.origin);
    if (mode) void store.transfer(m.bubble, m.threadId, mode);
  };

  // Plus récente en haut, notifications d'abord : ce qui vient d'arriver est sous les yeux.
  // Une approbation en attente passe devant tout : on ne doit jamais avoir à chercher la carte qu'il faut décider.
  const rank = (r: Rendered): string => `${pendingApproval(r.b) ? "2" : r.b.kind === "notify" ? "1" : "0"}${r.b.created_at}`;
  // Une notify émise DEPUIS le fil où l'on est (on vient d'écrire à une autre session) n'apprend rien : masquée.
  const fromHere = (b: BubbleT): boolean => b.kind === "notify" && b.state.from_thread === current?.id;
  const visible = rendered.filter((r) => !views[r.b.id]?.hidden && !fromHere(r.b)).sort((a, b) => rank(b).localeCompare(rank(a)));

  // Téléphone : le bandeau se replie en une ligne dès qu'on lit (défilement du chat) ou qu'on écrit, se déplie d'un tap
  // et quand une nouvelle bulle arrive. Le chat garde la place (retour de test, 27.10).
  const [folded, setFolded] = useState(false);
  const liveCount = visible.filter((r) => !r.leaving).length;
  const seenCount = useRef(liveCount);
  useEffect(() => {
    if (liveCount > seenCount.current) setFolded(false);
    seenCount.current = liveCount;
  }, [liveCount]);
  useEffect(() => {
    if (!inline) return;
    const fold = (e: Event): void => {
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest(".chat-scroll") || t?.id === "nk-composer") setFolded(true);
    };
    const opts = { capture: true, passive: true };
    document.addEventListener("wheel", fold, opts);
    document.addEventListener("touchmove", fold, opts);
    document.addEventListener("focusin", fold);
    document.addEventListener("input", fold, true);
    return () => {
      document.removeEventListener("wheel", fold, opts);
      document.removeEventListener("touchmove", fold, opts);
      document.removeEventListener("focusin", fold);
      document.removeEventListener("input", fold, true);
    };
  }, [inline]);
  // Par défaut, seules les bulles les plus récentes sont déployées (1 sur mobile, 3 sur grand écran) ; les autres
  // se réduisent à leur en-tête — on ne garde sous les yeux que ce dont on a besoin.
  const recent = new Set(
    [...bubbles]
      .filter((b) => b.kind !== "notify")
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, inline ? 1 : 3)
      .map((b) => b.id),
  );
  // Mode pile : dépliées seulement la carte en attente la plus récente et la dernière bulle active.
  const narrowExpanded = new Set<string>();
  if (narrow) {
    const live = visible.filter((r) => !r.leaving).map((r) => r.b);
    const newest = (a: BubbleT[]): BubbleT | undefined => [...a].sort((x, y) => y.created_at.localeCompare(x.created_at))[0];
    const pend = newest(live.filter(pendingApproval));
    if (pend) narrowExpanded.add(pend.id);
    const others = live.filter((b) => !pendingApproval(b) && !forced.has(b.id));
    const act = newest(others.filter((b) => b.status === "working")) ?? newest(others.filter((b) => b.kind !== "notify"));
    if (act) narrowExpanded.add(act.id);
  }
  const isCollapsed = (id: string): boolean => {
    const v = views[id]?.collapsed;
    if (v !== undefined) return v;
    if (narrow) return !narrowExpanded.has(id);
    const b = bubbles.find((x) => x.id === id);
    return !(b?.kind === "notify" || (b && pendingApproval(b)) || recent.has(id));
  };
  const W = layerRef.current?.clientWidth ?? 1400;
  const H = layerRef.current?.clientHeight ?? 900;

  // Mesures DOM relatives au calque.
  const rel = useCallback((el: Element | null): Rect | null => {
    const layer = layerRef.current;
    if (!el || !layer) return null;
    const L = layer.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left - L.left, y: r.top - L.top, w: r.width, h: r.height };
  }, []);
  const usable = useCallback((): Rect => {
    const layer = layerRef.current;
    // Appelé par une minuterie ou un redimensionnement juste après un démontage : rien à poser.
    if (!layer) return { x: 0, y: 0, w: 0, h: 0 };
    const drawer = rel(document.querySelector(".drawer"));
    const top = rel(document.querySelector(".topbar"));
    const x = (drawer ? drawer.x + drawer.w : 0) + 16;
    const y = (top ? top.y + top.h : 0) + 14;
    return { x, y, w: layer.clientWidth - x - 20, h: layer.clientHeight - y - 16 };
  }, [rel]);
  // Taille NON transformée (offsetWidth/Height) : pendant l'animation d'entrée (scale .82) le rectangle affiché
  // est plus petit que la bulle, et la poser d'après lui la ferait déborder à droite.
  const bubbleRect = useCallback((id: string): Rect | null => {
    const el = layerRef.current?.querySelector<HTMLElement>(`[data-bubble-id="${id}"]`);
    return el ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : null;
  }, []);

  // Largeur des bulles : 420 px, ou la marge libre à droite du fil (≥ 280 px) quand elle est plus étroite — à 1280 px la
  // marge fait ~293 px : des bulles de 420 px recouvriraient le bout droit des messages.
  useLayoutEffect(() => {
    if (inline) return;
    const apply = (): void => {
      const layer = layerRef.current;
      if (!layer) return;
      const c = rel(document.querySelector(".composer"));
      const free = c ? layer.clientWidth - (c.x + c.w) - 16 - 20 : 420;
      layer.style.setProperty("--bubble-w", `${free < 420 ? Math.max(280, Math.round(free)) : 420}px`);
      setNarrow(free < 420);
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inline, threadKey]);

  /** Les 3 derniers messages du fil (toutes origines) et la saisie : ce qu'une bulle ne doit pas couvrir. */
  const lastMessageRects = (): Rect[] => {
    const msgs = [...document.querySelectorAll(".chat .msg")].slice(-3);
    return [...msgs.map((m) => rel(m)), rel(document.querySelector(".composer"))].filter(Boolean) as Rect[];
  };
  /** La colonne du fil (sa largeur = celle de la saisie), sur toute la hauteur : les bulles se posent dans la marge à droite. */
  const threadColumn = (): Rect[] => {
    const c = rel(document.querySelector(".composer")) ?? rel(document.querySelector(".chat-inner"));
    const b = usable();
    return c ? [{ x: c.x, y: b.y, w: c.w, h: b.h }] : [];
  };
  // Pose des nouvelles bulles (avant peinture : elles sont rendues invisibles le temps d'être mesurées).
  const unplaced = inline || narrow ? [] : rendered.filter((r) => !r.leaving && !posOf(r.b.id)).map((r) => r.b.id);
  useLayoutEffect(() => {
    if (inline || !unplaced.length || !layerRef.current) return;
    const bounds = usable();
    const forbidden = lastMessageRects();
    const soft = threadColumn();
    const placed: Rect[] = rendered
      .filter((r) => !unplaced.includes(r.b.id) && posOf(r.b.id))
      .map((r) => {
        const p = posOf(r.b.id)!;
        const m = bubbleRect(r.b.id);
        return { x: p.x, y: p.y, w: m?.w ?? 420, h: m?.h ?? 200 };
      });
    const patch: Record<string, { x: number; y: number }> = {};
    const ordered = [...unplaced].sort((a, b) => {
      const ba = bubbles.find((x) => x.id === a)?.created_at ?? "";
      const bb = bubbles.find((x) => x.id === b)?.created_at ?? "";
      return ba.localeCompare(bb);
    });
    for (const id of ordered) {
      const m = bubbleRect(id);
      const size = { w: m?.w ?? 420, h: Math.min(m?.h ?? 240, bounds.h) };
      const pos = placeNew({ area: { w: W, h: H }, bounds, size, forbidden, others: placed, soft, index: placed.length });
      patch[id] = pos;
      placed.push({ ...pos, ...size });
    }
    setPos(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unplaced.join(","), inline, narrow]);

  // Mode pile : dépliées en haut de la marge (carte en attente d'abord), repliées empilées en bas (la plus récente tout en bas).
  const stackSig = `${narrow}|${[...forced].join(",")}|${visible.filter((r) => !r.leaving).map((r) => `${r.b.id}${isCollapsed(r.b.id) ? "c" : "o"}`).join(",")}`;
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (inline || !narrow || !layer) return;
    const compute = (): void => {
      const area = usable();
      const live = visible.filter((r) => !r.leaving && !dragged.current.has(r.b.id));
      const sizeOf = (id: string): { w: number; h: number } => {
        const m = bubbleRect(id);
        return { w: m?.w ?? 292, h: m?.h ?? 40 };
      };
      const byNew = (a: Rendered, b: Rendered): number => b.b.created_at.localeCompare(a.b.created_at);
      const open = live.filter((r) => !isCollapsed(r.b.id)).sort((a, b) => Number(pendingApproval(b.b)) - Number(pendingApproval(a.b)) || byNew(a, b));
      const shut = live.filter((r) => isCollapsed(r.b.id)).sort(byNew);
      const pos: Record<string, { x: number; y: number }> = {};
      let top = area.y;
      for (const r of open) {
        const { w, h } = sizeOf(r.b.id);
        pos[r.b.id] = { x: Math.round(layer.clientWidth - 20 - w), y: Math.round(top) };
        top += h + 10;
      }
      const end = area.y + area.h;
      const hs = shut.map((r) => sizeOf(r.b.id).h);
      const gap = 4;
      // Les en-têtes repliées ne se chevauchent jamais (cibles ≥ 24 px, lisibles) : on en garde autant qu'il en tient sous la
      // pile dépliée, les plus récentes d'abord ; les autres sont masquées et comptées dans la pastille « +N ».
      const room = end - top;
      let used = 0;
      let shown = 0;
      const hide: string[] = [];
      shut.forEach((r, i) => {
        const { w, h } = sizeOf(r.b.id);
        if (used + h > room && !(i === 0)) {
          hide.push(r.b.id);
          return;
        }
        shown++;
        pos[r.b.id] = { x: Math.round(layer.clientWidth - 20 - w), y: Math.round(end - used - h) };
        used += h + gap;
      });
      const bottom = end - used + gap;
      setHiddenIds((prev) => (prev.join() === hide.join() ? prev : hide));
      void shown;
      setPileY(Math.round(end - used + gap - 28));
      // La pile dépliée touche la pile repliée : on replie la dernière bulle active (jamais la carte en attente).
      const last = open.filter((r) => !pendingApproval(r.b)).pop();
      if (top > bottom + 6 && last && !forced.has(last.b.id)) {
        setForced((f) => new Set(f).add(last.b.id));
        return;
      }
      setStack((prev) => {
        const a = JSON.stringify(prev);
        const b = JSON.stringify({ ...prev, ...pos });
        return a === b ? prev : { ...prev, ...pos };
      });
    };
    compute();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(compute);
    layer.querySelectorAll("[data-bubble-id]").forEach((el) => ro?.observe(el));
    return () => ro?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stackSig, inline]);

  // Une bulle posée qui GRANDIT ensuite (image d'un « montre-moi », réponses, étapes) remonte pour rester dans la
  // fenêtre : la pose ne connaît que sa taille d'origine, et une bulle plus bas que le bord ne se lit plus.
  useEffect(() => {
    const layer = layerRef.current;
    if (inline || !layer || typeof ResizeObserver === "undefined") return;
    const fit = (): void => {
      const b = usable();
      const bottom = b.y + b.h;
      const patch: Record<string, { x: number; y: number }> = {};
      layer.querySelectorAll<HTMLElement>("[data-bubble-id]").forEach((el) => {
        const id = el.dataset.bubbleId ?? "";
        const p = posOf(id);
        if (!p) return;
        const over = p.y + el.offsetHeight - bottom;
        if (over > 1) {
          const y = Math.max(b.y, Math.round(p.y - over));
          if (y !== p.y) patch[id] = { x: p.x, y };
        }
      });
      if (Object.keys(patch).length) setPos(patch);
    };
    const ro = new ResizeObserver(fit);
    layer.querySelectorAll("[data-bubble-id]").forEach((el) => ro.observe(el));
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendered.length, positions, inline, threadKey]);

  // « Ranger » : colonnes depuis la droite, la plus récente en haut.
  useEffect(() => {
    if (!arrangeTick || inline || !layerRef.current) return;
    const items = [...bubbles]
      .filter((b) => !views[b.id]?.hidden)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((b) => {
        const m = bubbleRect(b.id);
        return { id: b.id, w: m?.w ?? 420, h: m?.h ?? 200 };
      });
    setArranging(true);
    items.forEach((i) => dragged.current.add(i.id));
    setPos(arrange(items, usable()));
    setOrder(items.map((i) => i.id).reverse());
    const t = setTimeout(() => setArranging(false), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrangeTick]);

  const renderBubble = (r: Rendered, style?: React.CSSProperties): React.ReactElement => {
    const b = r.b;
    return (
      <Bubble
        key={b.id}
        bubble={b}
        threads={threads}
        currentThread={current?.id ?? null}
        collapsed={isCollapsed(b.id)}
        entering={r.entering}
        leaving={r.leaving}
        flying={r.flying}
        dragging={drag?.id === b.id}
        focused={focusBubble === b.id}
        draggable={!inline && !r.leaving}
        {...(style ? { style } : {})}
        popover={popover?.id === b.id ? popover.kind : null}
        onPopover={(kind) => {
          setPopover(kind ? { id: b.id, kind } : null);
          bringToFront(b.id);
        }}
        onToggle={() => setViews((v) => ({ ...v, [b.id]: { ...v[b.id], collapsed: !isCollapsed(b.id) } }))}
        onClose={() => {
          if (b.shared) setViews((v) => ({ ...v, [b.id]: { ...v[b.id], hidden: true } }));
          else void store.closeBubble(b);
        }}
        onShare={(req) => void store.share(b, req)}
        onSendTo={(to, mode) => {
          setPopover(null);
          void store.transfer(b, to, mode);
        }}
        onGripDown={onGripDown(b)}
        onActivate={() => bringToFront(b.id)}
      />
    );
  };

  if (inline && folded && liveCount) {
    const top = visible.find((r) => !r.leaving)!.b;
    return (
      <section className="bubble-inline folded" aria-label={tr("Session bubbles")}>
        <button type="button" className="bubble-fold" aria-expanded={false} aria-label={tr("Show the {0} bubble(s), latest: {1}", liveCount, displayTitle(top))} onClick={() => setFolded(false)}>
          <Icon name={bubbleTheme(top.kind).icon} size={14} />
          <span className="bubble-fold-title">{displayTitle(top)}</span>
          <span className="tab-count">{liveCount}</span>
          <Icon name="chevronDown" size={16} />
        </button>
      </section>
    );
  }

  if (inline) {
    const chips = visible.filter((r) => isCollapsed(r.b.id) && !r.leaving);
    const open = visible.filter((r) => !isCollapsed(r.b.id) || r.leaving);
    return (
      <section className="bubble-inline" aria-label={tr("Session bubbles")} {...anchor("bubbles")}>
        {chips.length ? (
          <div className="chip-row" aria-label={tr("Collapsed bubbles")}>
            {chips.map(({ b }) => {
              const t = bubbleTheme(b.kind);
              return (
                <button
                  key={b.id}
                  type="button"
                  className={`bubble-chip ${b.status === "working" ? "working" : ""}`}
                  style={{ "--k-l": t.light, "--krgb-l": t.lightRgb, "--k-d": t.color, "--krgb-d": t.rgb } as React.CSSProperties}
                  aria-label={tr("Expand the bubble {0} {1}, {2}", bubbleLabel(b.kind), displayTitle(b), statusLabel(b, Date.now()))}
                  onClick={() => setViews((v) => ({ ...v, [b.id]: { ...v[b.id], collapsed: false } }))}
                >
                  <Icon name={t.icon} size={14} />
                  {bubbleLabel(b.kind)}
                  <span className="chip-status">· {statusLabel(b, Date.now())}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="inline-stack">{open.map((r) => renderBubble(r))}</div>
      </section>
    );
  }

  return (
    <div className={`bubble-layer ${arranging ? "arranging" : ""} ${narrow ? "pile" : ""}`} ref={layerRef} {...anchor("bubbles")}>
      {visible.map((r) => {
        const placed = drag?.id === r.b.id ? drag : narrow && !dragged.current.has(r.b.id) ? stack[r.b.id] : posOf(r.b.id);
        const z = 10 + Math.max(0, order.indexOf(r.b.id)) + (drag?.id === r.b.id ? 500 : 0) + (r.b.kind === "notify" ? 200 : 0) + (pendingApproval(r.b) ? 300 : 0);
        return renderBubble(r, {
          position: "absolute",
          left: placed ? Math.max(0, Math.min(placed.x, W - 160)) : 0,
          top: placed ? Math.max(0, Math.min(placed.y, H - 56)) : 0,
          zIndex: z,
          ...(placed && !(narrow && hiddenIds.includes(r.b.id)) ? {} : { visibility: "hidden" as const, pointerEvents: "none" as const }),
        });
      })}
      {narrow && hiddenIds.length ? (
        <span className="pile-more" style={{ top: pileY }} title={tr("{0} other bubble(s) folded: close one to see the next.", hiddenIds.length)}>
          +{hiddenIds.length}
        </span>
      ) : null}
      {dropMenu ? (
        <DropMenu
          bubbleTitle={displayTitle(dropMenu.bubble)}
          threadTitle={threads.find((t) => t.id === dropMenu.threadId)?.title ?? "?"}
          top={dropMenu.top}
          left={dropMenu.left}
          onPick={(mode) => finishDrop(mode)}
          onCancel={() => finishDrop(null)}
        />
      ) : null}
    </div>
  );
}
