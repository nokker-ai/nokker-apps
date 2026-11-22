/**
 * Page `/glance?wall=1` : l'écran mural du nœud maison (LOKKAL-PHONE §4.4, lot P10b), plein écran, lecture seule.
 * Grande horloge et date, prochain rendez-vous, nombre de cartes à décider, incidents en cours, et le résumé du brief
 * seulement si le titulaire l'a permis (le noyau filtre ; la page n'invente rien).
 *
 * Jeton : le `nkg_` du mur, lu dans le trousseau par le natif et gardé EN MÉMOIRE ici (jamais localStorage, cookie,
 * IndexedDB, URL ni journal). Aucun script tiers. Une lecture par minute (le noyau en permet deux). Nuit (22:00–07:00) :
 * thème sombre ici, luminosité réduite par le natif. Sortie : appui de 3 s dans le coin en haut à gauche, PUIS
 * biométrie ou code du propriétaire de l'appareil (décision dev 06.11) ; l'appareil n'a plus de session : on arrive sur
 * l'écran de connexion.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NokkerApiError, type GlanceHousehold, type GlanceView } from "@nokker-apps/sdk";
import { createClient } from "../api.js";
import { shellLang, tr } from "../i18n/index.js";
import { nodePlugin } from "../platform/node.js";
import { burnInShift, isNight, wallData } from "./wall.js";
import { FoyerView } from "./foyer/FoyerView.js";
import { availableViews, pickView, readWallView, saveWallView, stepView, type WallViewId } from "./views.js";
import { WallAvatar } from "./WallAvatar.js";
import { WallScreenView } from "./screen/WallScreenView.js";
import "./wall-views.css";

const viewName = (v: WallViewId): string => (v === "foyer" ? tr("Household") : v === "screen" ? tr("Screen") : tr("Clock"));
import { glowEnabled } from "../visual/glow.js";
import { WallGlow } from "../visual/WallGlow.js";
import { Orb } from "../voice/Orb.js";
import { installWallOrbHook, useWallVoiceState } from "../voice/orbState.js";

const REFRESH_MS = 60_000;
const MIN_GAP_MS = 30_000;
const EXIT_HOLD_MS = 3000;

type State = { kind: "loading" } | { kind: "unset" } | { kind: "ready" };

export function WallPage(): React.ReactElement {
  const plugin = nodePlugin();
  const lang = shellLang();
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [view, setView] = useState<GlanceView | null>(null);
  const [readAt, setReadAt] = useState<Date | null>(null);
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const lastRead = useRef(0);
  const notBefore = useRef(0);
  const hold = useRef<number | null>(null);
  // F1 : vue « Foyer » (GET /v1/glance/household, ETag), relue toutes les 60 s et juste après une coche.
  const [household, setHousehold] = useState<GlanceHousehold | null>(null);
  const etag = useRef<string | null>(null);
  const [guestBusy, setGuestBusy] = useState(false);
  const [wantedView, setWantedView] = useState<WallViewId | null>(() => readWallView());
  const swipe = useRef<{ x: number; y: number } | null>(null);
  // Voice orb slot: hidden (state "off") until the wall voice code sets a state.
  const voice = useWallVoiceState();
  useEffect(() => installWallOrbHook(), []);

  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await plugin?.wallToken?.().catch(() => null);
      if (!live) return;
      if (r?.token) {
        setToken(r.token);
        setState({ kind: "ready" });
        await plugin?.setWall?.({ on: true }).catch(() => undefined);
      } else setState({ kind: "unset" });
    })();
    return () => {
      live = false;
    };
  }, [plugin]);

  const client = useMemo(() => {
    if (!token) return null;
    const c = createClient();
    c.setToken(token);
    return c;
  }, [token]);

  const load = useCallback(async (): Promise<void> => {
    if (!client) return;
    const t = Date.now();
    if (t - lastRead.current < MIN_GAP_MS || t < notBefore.current) return;
    lastRead.current = t;
    try {
      setView(await client.getGlance());
      setReadAt(new Date());
      setOffline(false);
    } catch (e) {
      if (e instanceof NokkerApiError && e.status === 401) {
        // Révoqué depuis le téléphone : le jeton est oublié, la page le dit.
        await plugin?.setWallToken?.({}).catch(() => undefined);
        await plugin?.setWall?.({ on: false }).catch(() => undefined);
        setToken(null);
        setState({ kind: "unset" });
        return;
      }
      if (e instanceof NokkerApiError && e.status === 429) notBefore.current = Date.now() + (e.retryAfterS ?? 60) * 1000;
      setOffline(true);
    }
  }, [client, plugin]);

  useEffect(() => {
    if (!client) return;
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    const vis = (): void => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [client, load]);

  const loadHousehold = useCallback(async (): Promise<void> => {
    if (!client) return;
    try {
      const r = await client.getGlanceHousehold(etag.current);
      if (r.status === 304) return;
      etag.current = r.etag;
      setHousehold(r.household);
    } catch (e) {
      // 403/404 : noyau sans vue Foyer ou appareil qui n'est pas un mur → la page garde son rendu d'avant.
      if (e instanceof NokkerApiError && (e.status === 403 || e.status === 404)) setHousehold(null);
    }
  }, [client]);

  useEffect(() => {
    if (!client) return;
    void loadHousehold();
    const id = window.setInterval(() => void loadHousehold(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [client, loadHousehold]);

  const foyerActions = useMemo(
    () => ({
      task: async (id: string, done: boolean): Promise<void> => {
        await client!.glanceTaskDone(id, done);
        await loadHousehold();
      },
      shopping: async (id: string, done: boolean): Promise<void> => {
        await client!.glanceShoppingDone(id, done);
        await loadHousehold();
      },
    }),
    [client, loadHousehold],
  );

  // Mode invité : n'importe qui l'allume (il ne fait que masquer) ; l'éteindre demande le code de l'appareil.
  const setGuest = useCallback(
    async (on: boolean): Promise<void> => {
      if (!client) return;
      setGuestBusy(true);
      try {
        if (!on) {
          const r = await plugin?.authenticateExit?.({ reason: tr("Leave guest mode") }).catch(() => null);
          if (!r?.ok) return;
        }
        await client.setGlanceGuest(on);
        etag.current = null;
        await loadHousehold();
      } catch {
        /* la prochaine lecture dira l'état réel */
      } finally {
        setGuestBusy(false);
      }
    },
    [client, plugin, loadHousehold],
  );

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const [denied, setDenied] = useState(false);
  const exit = useCallback(async (): Promise<void> => {
    const r = await plugin?.authenticateExit?.({ reason: tr("Leave the wall screen") }).catch(() => null);
    if (!r?.ok) {
      setDenied(true);
      window.setTimeout(() => setDenied(false), 6000);
      return;
    }
    await plugin?.setWall?.({ on: false }).catch(() => undefined);
    window.location.assign("/");
  }, [plugin]);

  const night = isNight(now);
  const shift = burnInShift(now);
  const data = view ? wallData(view, now, lang) : null;
  const fg = night ? "#8c8c8c" : "#1d1d1f";
  // Nuit : discret mais lisible (≥ 4,5:1 sur noir pour le texte secondaire).
  const soft = night ? "#777777" : "#5b5b60";
  // Nuit : jamais la vue Foyer (pièce commune, écran sombre) — l'horloge et le prochain rendez-vous seulement.
  // Vues du mur : Foyer par défaut, Écran (V7) quand il est publié, l'ancien contenu en repli ; la nuit, l'ancien.
  const avail = availableViews({ foyer: !!household, screen: !!view?.screen });
  const current = pickView(avail, wantedView, night);
  const foyer = current === "foyer" ? household : null;
  const go = (v: WallViewId): void => {
    setWantedView(v);
    saveWallView(v);
  };
  return (
    <main
      className="wall"
      data-wall={state.kind}
      data-night={night ? "1" : "0"}
      data-wall-foyer={foyer ? (foyer.guest ? "guest" : "on") : "off"}
      data-wall-view={current}
      onPointerDown={(e) => (swipe.current = { x: e.clientX, y: e.clientY })}
      onPointerUp={(e) => {
        const s = swipe.current;
        swipe.current = null;
        if (!s || avail.length < 2) return;
        const dx = e.clientX - s.x;
        if (Math.abs(dx) > 80 && Math.abs(dx) > 2 * Math.abs(e.clientY - s.y)) go(stepView(avail, current, dx < 0 ? 1 : -1));
      }}
      style={{ position: "fixed", inset: 0, overflowX: "hidden", overflowY: foyer ? "auto" : "hidden", background: night ? "#000" : "#f5f2ec", color: fg, fontFamily: "inherit", display: "flex", alignItems: foyer ? "flex-start" : "center", justifyContent: "center", padding: foyer ? "3vmin" : "4vmin" }}
    >
      {glowEnabled() ? <WallGlow night={night} /> : null}
      <div
        aria-label={tr("Hold for 3 seconds to leave the wall screen")}
        role="button"
        tabIndex={0}
        data-wall-exit
        style={{ position: "fixed", top: 0, left: 0, width: 64, height: 64, zIndex: 6 }}
        onPointerDown={() => (hold.current = window.setTimeout(() => void exit(), EXIT_HOLD_MS))}
        onPointerUp={() => hold.current && window.clearTimeout(hold.current)}
        onPointerLeave={() => hold.current && window.clearTimeout(hold.current)}
        onKeyDown={(e) => {
          if (e.key === "Escape") void exit();
        }}
      />
      {current === "screen" && view?.screen ? (
        <div className="wall-screen-frame" data-wall-screen>
          <WallScreenView screen={view.screen} resolveUrl={(x) => client?.resolveUrl(x) ?? null} />
        </div>
      ) : (
      <div style={{ transform: `translate(${shift.x}px, ${shift.y}px)`, width: foyer ? "min(1800px, 100%)" : "min(1100px, 100%)", display: "flex", flexDirection: "column", gap: foyer ? "1.6vmin" : "2.4vmin" }}>
        {/* Vue Foyer : l'en-tête tient sur une ligne (horloge à gauche, le reste à côté) pour laisser la place aux tuiles. */}
        <div style={foyer ? { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.4em 2.4vmin" } : { display: "contents" }}>
        <time dateTime={now.toISOString()} data-wall-clock style={{ fontSize: foyer ? "clamp(44px, 10vmin, 120px)" : "clamp(64px, 22vmin, 220px)", fontWeight: 300, lineHeight: 1, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
          {now.toLocaleTimeString(lang === "fr" ? "fr-CH" : "en-GB", { hour: "2-digit", minute: "2-digit" })}
        </time>
        {/* Vue Foyer : l'avatar (V6) se range dans l'en-tête, à droite, sans couvrir les tuiles. */}
        {foyer && view?.avatar && view.show_brief && client ? <WallAvatar client={client} avatar={view.avatar} lang={view.lang ?? lang} briefId={view.brief_last_run?.run_id ?? null} now={now} inline /> : null}
        <div style={foyer ? { display: "flex", flexDirection: "column", gap: "0.3em", minWidth: 0, flex: "1 1 320px" } : { display: "contents" }}>
        <p style={{ margin: 0, fontSize: foyer ? "clamp(16px, 2.8vmin, 30px)" : "clamp(18px, 4.2vmin, 40px)", color: soft }}>
          {now.toLocaleDateString(lang === "fr" ? "fr-CH" : "en-GB", { weekday: "long", day: "numeric", month: "long" })}
        </p>
        {state.kind === "unset" ? (
          <p data-wall-unset style={{ margin: 0, fontSize: "clamp(18px, 3.6vmin, 34px)" }}>
            {tr("This device is not set up as a wall screen. Set it up on this device in My account → This phone.")}
          </p>
        ) : data ? (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: foyer ? "row" : "column", flexWrap: "wrap", gap: foyer ? "0.2em 1.4em" : "1.6vmin", fontSize: foyer ? "clamp(15px, 2.4vmin, 26px)" : "clamp(18px, 3.8vmin, 38px)", lineHeight: 1.25 }}>
            {data.event ? <li data-wall-event>{data.event}</li> : null}
            <li data-wall-cards>{data.cards}</li>
            {/* Vue Foyer (mur familial) : pas d'incidents techniques dans le bandeau ; ils restent dans l'app. */}
            {(foyer ? [] : data.incidents).map((t, i) => (
              <li key={i} data-wall-incident>
                {tr("Incident: {0}", t)}
              </li>
            ))}
            {data.brief ? (
              <li data-wall-brief style={{ color: soft, fontSize: "0.8em", overflowWrap: "anywhere" }}>
                {data.brief}
              </li>
            ) : null}
          </ul>
        ) : null}
        </div>
        </div>
        {foyer ? (
          <>
            {foyer.guest ? (
              <p data-wall-guest role="status" style={{ margin: 0, fontSize: "clamp(16px, 2.4vmin, 26px)", color: soft }}>
                {tr("Guest mode: private information is hidden.")}
              </p>
            ) : null}
            <FoyerView h={foyer} now={now} lang={lang} actions={foyerActions} />
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="fy-guest-btn"
                disabled={guestBusy}
                onClick={() => void setGuest(!foyer.guest)}
                data-wall-guest-toggle={foyer.guest ? "off" : "on"}
                style={{ minHeight: 56, padding: "0 1.2em", borderRadius: 999, border: "1px solid rgba(29,29,31,0.2)", background: "rgba(255,255,255,0.7)", color: fg, font: "inherit", fontSize: "clamp(16px, 2.2vmin, 24px)", cursor: "pointer" }}
              >
                {foyer.guest ? tr("Leave guest mode") : tr("Guest mode")}
              </button>
            </div>
          </>
        ) : null}
        {denied ? (
          <p data-wall-denied role="status" style={{ margin: 0, color: soft, fontSize: "clamp(14px, 2.4vmin, 22px)", ...(foyer ? { position: "fixed", left: "3vmin", bottom: "3vmin", maxWidth: "60vw", padding: "0.5em 0.9em", borderRadius: 12, background: night ? "#111" : "rgba(255,255,255,0.92)", boxShadow: "0 4px 16px rgba(0,0,0,0.12)" } : {}) }}>
            {tr("The wall screen stays on: leaving it needs the passcode of this device.")}
          </p>
        ) : null}
        {offline ? (
          <p data-wall-offline style={{ margin: 0, color: soft, fontSize: "clamp(14px, 2.4vmin, 22px)", ...(foyer ? { position: "fixed", left: "3vmin", bottom: "3vmin", maxWidth: "60vw", padding: "0.5em 0.9em", borderRadius: 12, background: night ? "#111" : "rgba(255,255,255,0.92)", boxShadow: "0 4px 16px rgba(0,0,0,0.12)" } : {}) }}>
            {!view ? tr("Waiting for the next reading.") : readAt ? tr("Offline: showing {0}.", readAt.toLocaleTimeString(lang === "fr" ? "fr-CH" : "en-GB", { hour: "2-digit", minute: "2-digit" })) : tr("Offline: showing the last reading.")}
          </p>
        ) : null}
      </div>
      )}
      {avail.length > 1 && !night ? (
        <nav className="wall-dots" aria-label={tr("Wall views")} data-wall-dots>
          {avail.map((v) => (
            <button key={v} type="button" aria-pressed={v === current} aria-label={viewName(v)} onClick={() => go(v)} data-wall-dot={v}>
              <span aria-hidden="true" />
            </button>
          ))}
        </nav>
      ) : null}
      {view?.avatar && view.show_brief && !night && client && !foyer ? <WallAvatar client={client} avatar={view.avatar} lang={view.lang ?? lang} briefId={view.brief_last_run?.run_id ?? null} now={now} /> : null}
      {voice !== "off" ? (
        <div className="wall-orb" data-wall-orb style={{ color: soft }}>
          <Orb state={voice} size="lg" />
        </div>
      ) : null}
    </main>
  );
}
