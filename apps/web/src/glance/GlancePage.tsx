/**
 * Page `/glance`: what matters now, sized for display glasses (small see-through screen, ~600 px square, black is
 * transparent there). One page at a time, large type, read only — a card is decided on the phone or the computer.
 * Input on Meta Ray-Ban Display web apps: the touchpad and the Neural Band become ArrowUp/Down/Left/Right and Enter, no
 * mouse, touch or keyboard, fixed 600 × 600 viewport, no scrolling, pure black = transparent
 * (wearables.developer.meta.com/docs/develop/webapps/build/). Arrows and Enter move; a tap / swipe still works when the
 * page is opened in a phone browser. The Back gesture is left to the system (no history entry is pushed here).
 * Refreshes every minute and when the page comes back to the front.
 * Sign-in: the glasses never hold a full session. They are paired with a code from the phone (My account → Glasses)
 * and keep a read-only `nkg_` token (core AMBIENT.md §6) that opens only `GET /v1/glance` — one read per minute.
 * Without a token, a browser that is already signed in (a computer, the mock) reads with its own session.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NokkerApiError } from "@nokker-apps/sdk";
import { createClient } from "../api.js";
import { shellLang, tr } from "../i18n/index.js";
import { useNokker } from "../store.js";
import { cleanSummary, fromView, pagesOf, step, strengthHint, summaryLines, toolLabel, type GlanceData } from "./model.js";

const REFRESH_MS = 60_000;
/** The core accepts at most 2 reads per minute per glance token (429 `glance_rate`): never two reads closer than this,
 * coming back to the front included. */
export const MIN_GAP_MS = 30_000;
const TOKEN_KEY = "nokker.glance.token";

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the pairing lasts for this page only */
  }
}

const apiCode = (e: unknown): string | undefined => (e instanceof NokkerApiError ? ((e.body as { error?: { code?: string } } | undefined)?.error?.code ?? undefined) : undefined);

/** First run on the glasses: type the code shown on the phone (the glasses open their own text composer on the field). */
function PairScreen({ onToken }: { onToken: (token: string) => void }): React.ReactElement {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onToken((await createClient().claimGlance(code)).token);
    } catch (e) {
      const k = apiCode(e);
      setError(k === "too_many_attempts" ? tr("Too many tries: wait a moment, then try again.") : k === "unknown_code" ? tr("Unknown or expired code: ask for a new one on the phone.") : tr("Nokker cannot be reached right now."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="glance glance-pair">
      <h1 className="glance-label">{tr("Pair these glasses")}</h1>
      <form
        className="glance-page"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          // No Tab key on the glasses: Up / Down move between the field and the button (Left / Right stay in the field).
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          const f = [...e.currentTarget.querySelectorAll<HTMLElement>("input, button:not([disabled])")];
          const i = f.indexOf(document.activeElement as HTMLElement);
          const next = f[(i + (e.key === "ArrowDown" ? 1 : -1) + f.length) % f.length];
          if (next) {
            e.preventDefault();
            next.focus();
          }
        }}
      >
        <p className="glance-text">{tr("On your phone: My account → Glasses → Pair glasses. Then type the code here.")}</p>
        <label htmlFor="glance-code" className="sr-only">
          {tr("Pairing code")}
        </label>
        <input id="glance-code" className="glance-input" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="ABCD-EFGH" autoFocus />
        <button type="submit" className="glance-btn" disabled={busy || !code.trim()}>
          {tr("Pair")}
        </button>
        {error ? (
          <p className="glance-hint strong" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </main>
  );
}

function clock(lang: string, at = new Date()): string {
  return at.toLocaleTimeString(lang === "fr" ? "fr-CH" : "en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function GlancePage(): React.ReactElement {
  const store = useNokker();
  const { client, access } = store;
  const [token, setToken] = useState<string | null>(readToken);
  const glanceClient = useMemo(() => {
    if (!token) return null;
    const c = createClient();
    c.setToken(token);
    return c;
  }, [token]);
  // Who reads: the glance token first; else a session this browser already has; else the pairing screen.
  const source = token ? "token" : access === "ready" ? "session" : access === "booting" ? "wait" : "pair";
  const lang = shellLang();
  const [data, setData] = useState<GlanceData | null>(null);
  const [failed, setFailed] = useState(false);
  const [at, setAt] = useState(() => new Date());
  const [page, setPage] = useState(0);
  const touchX = useRef<number | null>(null);

  const lastRead = useRef(0);
  const notBefore = useRef(0);
  const load = useCallback(async (): Promise<void> => {
    if (glanceClient) {
      const now = Date.now();
      if (now - lastRead.current < MIN_GAP_MS || now < notBefore.current) return; // the next tick will read
      lastRead.current = now;
      try {
        setData(fromView(await glanceClient.getGlance()));
        setFailed(false);
      } catch (e) {
        if (e instanceof NokkerApiError && e.status === 429) {
          // Too many reads: keep the last view, say « offline », and wait as long as the server asks.
          notBefore.current = Date.now() + (e.retryAfterS ?? 60) * 1000;
          setFailed(true);
        } else if (e instanceof NokkerApiError && e.status === 401) {
          // Revoked from the phone, or unknown: back to the pairing screen.
          writeToken(null);
          setToken(null);
          setData(null);
        } else setFailed(true);
      }
      setAt(new Date());
      return;
    }
    try {
      const [brief, cards, incidents] = await Promise.all([
        client
          .getBrief()
          .then(async ({ agent }) => (agent ? ((await client.listAgentRuns(agent.id, { limit: 1 })).runs[0] ?? null) : null))
          .catch(() => null),
        client.listApprovals("pending"),
        client
          .listIncidents({ state: "live", limit: 20 })
          .then((r) => r.incidents)
          .catch(() => null),
      ]);
      setData({ brief, cards, liveIncidents: incidents });
      setFailed(false);
    } catch {
      setFailed(true);
    }
    setAt(new Date());
  }, [client, glanceClient]);

  useEffect(() => {
    if (source !== "token" && source !== "session") return;
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    const back = (): void => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", back);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", back);
    };
  }, [source, load]);

  const pages = data ? pagesOf(data) : [];
  const total = pages.length;
  const current = Math.min(page, Math.max(0, total - 1));
  const go = useCallback((delta: 1 | -1) => setPage((p) => step(Math.min(p, Math.max(0, total - 1)), total, delta)), [total]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement) return; // the pairing form
      // On the glasses, the touchpad and the band arrive as arrow keys and Enter (no pointer, no touch); Enter is the
      // activation gesture, so it moves on too. Space / Page keys: a keyboard or a remote in a browser preview.
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "Enter" || e.key === " " || e.key === "PageDown") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  useEffect(() => {
    document.title = `${tr("At a glance")} · Nokker`;
    document.documentElement.classList.add("glance-root");
    return () => document.documentElement.classList.remove("glance-root");
  }, []);

  if (source === "pair")
    return (
      <PairScreen
        onToken={(t) => {
          writeToken(t);
          setToken(t);
        }}
      />
    );

  const p = pages[current];
  let body: React.ReactNode = <p className="glance-big">{tr("loading…")}</p>;
  if (failed && !data) body = <p className="glance-big">{tr("Nokker cannot be reached right now.")}</p>;
  else if (data && p?.kind === "summary") {
    body = (
      <ul className="glance-lines">
        {summaryLines(data).map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    );
  } else if (data && p?.kind === "brief" && data.brief?.summary) {
    body = (
      <>
        <h2 className="glance-label">{tr("Morning brief")}</h2>
        <p className="glance-text">{cleanSummary(data.brief.summary)}</p>
      </>
    );
  } else if (data && p?.kind === "card") {
    const c = data.cards[p.index]!;
    body = (
      <>
        <h2 className="glance-label">{tr("Card {0} of {1}", p.index + 1, data.cards.length)}</h2>
        <p className="glance-big">{toolLabel(c.tool_name)}</p>
        {c.reason ? <p className="glance-text">{c.reason}</p> : null}
        <p className={`glance-hint ${c.strength === "strong" ? "strong" : ""}`}>{strengthHint(c.strength)}</p>
      </>
    );
  }

  return (
    <main
      className="glance"
      aria-label={tr("At a glance")}
      onClick={(e) => {
        if (total < 2) return;
        go(e.clientX < window.innerWidth / 2 ? -1 : 1);
      }}
      onTouchStart={(e) => (touchX.current = e.touches[0]?.clientX ?? null)}
      onTouchEnd={(e) => {
        const x0 = touchX.current;
        const x1 = e.changedTouches[0]?.clientX;
        touchX.current = null;
        if (x0 === null || x1 === undefined || Math.abs(x1 - x0) < 40 || total < 2) return;
        e.preventDefault(); // a swipe is not also a tap
        go(x1 < x0 ? 1 : -1);
      }}
    >
      <header className="glance-head">
        <span className="glance-clock">{clock(lang, at)}</span>
        <span className={`glance-conn ${failed ? "off" : ""}`}>{failed ? tr("offline") : "Nokker"}</span>
      </header>
      <section className="glance-page" aria-live="polite" aria-atomic="true">
        {body}
      </section>
      {total > 1 ? (
        <footer className="glance-foot">
          <span className="sr-only">{tr("Page {0} of {1}", current + 1, total)}</span>
          {pages.map((_, i) => (
            <span key={i} className={`glance-dot ${i === current ? "on" : ""}`} aria-hidden="true" />
          ))}
        </footer>
      ) : null}
    </main>
  );
}
