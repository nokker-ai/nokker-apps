/**
 * Page `/kiosk` (drapeau web VITE_NOKKER_KIOSK=1, noyau `kiosk.enabled`) : l'écran HDMI d'un Lokkal, plein écran,
 * lecture seule. Grande horloge, tuiles locales (météo et départs du pack Essentiels, états de la maison filtrés par le
 * noyau), emplacement de Nina. « Mode perso » ouvre l'app normale, qui redemande sa clé (garde de 10 min, `mode.ts`).
 * Aucun agenda, aucun mail, aucune carte : le noyau n'en envoie pas, la page n'en invente pas.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NokkerApiError, type KioskView } from "@nokker-apps/sdk";
import { createClient } from "../api.js";
import { NinaRig } from "../avatar/NinaRig.js";
import { uiLang } from "../components/ConnectorsTab.js";
import { FoyerView, type FoyerActions } from "../glance/foyer/FoyerView.js";
import { burnInShift, isNight } from "../glance/wall.js";
import { asHousehold, fitScale, isDemoHousehold, kioskNight, kioskScreen, nextTile } from "./model.js";
import { KIOSK_TEXT as TEXT } from "./text.js";
import "./kiosk.css";

const REFRESH_MS = 30_000;
const NINA_URL = "/avatars/nina-v1/";
type Status = "loading" | "ready" | "need_key" | "off" | "on_machine";

const READ_ONLY: FoyerActions = {
  task: () => Promise.reject(new Error("read-only")),
  shopping: () => Promise.reject(new Error("read-only")),
};


const fmt = (s: string, ...a: string[]): string => a.reduce((o, x, i) => o.replace(`{${i}}`, x), s);

/** Taille du rendu de l'écran : celle d'une télé (le noyau le compose pour 1920×1080, lecture à 2 m, sans hauteur fixe). */
const SCREEN_W = 1920;
const SCREEN_H = 1080;

/** L'écran publié, EN ENTIER et sans défilement : rendu à 1920×1080 puis mis à l'échelle dans sa cellule (contenu entier,
 * centré). Page servie par le noyau sous sa propre CSP : sandbox sans aucune permission (ni script, ni même origine). */
function ScreenTile({ tile }: { tile: { key: string; title: string; url: string } }): React.ReactElement {
  const box = useRef<HTMLElement>(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = (): void => setScale(fitScale(el.clientWidth, el.clientHeight));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <section className="kk-screen" aria-label={tile.title} data-kiosk-screen ref={box}>
      <iframe
        key={tile.key}
        className="kk-screen-frame"
        title={tile.title}
        sandbox=""
        src={tile.url}
        referrerPolicy="no-referrer"
        style={{ width: SCREEN_W, height: SCREEN_H, transform: `translate(-50%, -50%) scale(${scale})`, visibility: scale > 0 ? "visible" : "hidden" }}
      />
    </section>
  );
}

export function KioskPage({ token, onPersonal }: { token: string | null; onPersonal: () => void }): React.ReactElement {
  const L = uiLang() === "en" ? "en" : "fr";
  const T = TEXT[L];
  const [view, setView] = useState<KioskView | null>(null);
  const [status, setStatus] = useState<Status>(token ? "loading" : "need_key");
  const [readAt, setReadAt] = useState<Date | null>(null);
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const notBefore = useRef(0);
  const client = useMemo(() => {
    if (!token) return null;
    const c = createClient();
    c.setToken(token);
    return c;
  }, [token]);

  const load = useCallback(async (): Promise<void> => {
    if (!client || Date.now() < notBefore.current) return;
    try {
      setView(await client.getKiosk());
      setReadAt(new Date());
      setOffline(false);
      setStatus("ready");
    } catch (e) {
      const st = e instanceof NokkerApiError ? e.status : 0;
      if (st === 401) return setStatus("need_key");
      if (st === 404) return setStatus("off");
      if (st === 403) return setStatus("on_machine");
      if (st === 429) notBefore.current = Date.now() + ((e as NokkerApiError).retryAfterS ?? 60) * 1000;
      setOffline(true);
    }
  }, [client]);

  useEffect(() => {
    if (!client) return;
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [client, load]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  // Chrome --kiosk est déjà plein écran ; lancé à la main, le premier geste demande le plein écran.
  useEffect(() => {
    const go = (): void => {
      if (!document.fullscreenElement && document.fullscreenEnabled) void document.documentElement.requestFullscreen?.().catch(() => undefined);
    };
    window.addEventListener("pointerdown", go, { once: true });
    return () => window.removeEventListener("pointerdown", go);
  }, []);

  const night = kioskNight(view, isNight(now)); // `kiosk.night: false` : tuiles et Nina aussi la nuit
  // Tuile « écran publié » (V7) : seulement quand le noyau en annonce un, jamais la nuit (horloge seule).
  const latest = !night && client ? kioskScreen(view, (u) => client.resolveUrl(u)) : null;
  const [shown, setShown] = useState<ReturnType<typeof nextTile>>(null);
  useEffect(() => setShown((cur) => nextTile(cur, latest, Date.now())), [latest?.key, latest?.url, now]);
  const tile = latest ? shown ?? latest : null;
  const demo = isDemoHousehold(view) && !night;
  const shift = burnInShift(now);
  const time = now.toLocaleTimeString(L === "en" ? "en-GB" : "fr-CH", { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString(L === "en" ? "en-GB" : "fr-CH", { weekday: "long", day: "numeric", month: "long" });
  const message = status === "need_key" ? T.needKey : status === "off" ? T.off : status === "on_machine" ? T.onMachine : null;

  return (
    <main className={"kk" + (night ? " kk-night" : "")} data-kiosk={status}>
      <div className="kk-inner" style={{ transform: `translate(${shift.x}px, ${shift.y}px)` }}>
      <header className="kk-top">
        <div className="kk-clock">
          <time dateTime={now.toISOString()} className="kk-time" data-kiosk-clock>{time}</time>
          <p className="kk-date">{date}</p>
        </div>
        {demo ? (
          <span className="kk-demo" data-kiosk-demo title={T.demoHint}>
            {T.demo}
          </span>
        ) : null}
        <button type="button" className="kk-personal" onClick={onPersonal} data-kiosk-personal>{T.personal}</button>
      </header>
      {message ? <p className="kk-msg" role="status">{message}</p> : null}
      <div className={"kk-body" + (tile ? " kk-has-screen" : "")}>
        <section className="kk-home" aria-label={T.home} {...({ inert: true } as object)}>
          {view && !night ? <FoyerView h={asHousehold(view)} now={now} lang={L} actions={READ_ONLY} /> : null}
          {offline && readAt ? <p className="kk-offline">{fmt(T.offline, readAt.toLocaleTimeString(L === "en" ? "en-GB" : "fr-CH", { hour: "2-digit", minute: "2-digit" }))}</p> : null}
        </section>
        {tile ? (
          <ScreenTile tile={tile} />
        ) : null}
        {view?.presenter.slot && !night ? (
          <aside className="kk-nina" aria-label={T.nina} data-kiosk-nina>
            <NinaRig avatarUrl={NINA_URL} framing="upper" />
          </aside>
        ) : null}
      </div>
      </div>
    </main>
  );
}
