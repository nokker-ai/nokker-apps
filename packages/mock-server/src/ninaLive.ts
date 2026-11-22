/**
 * Nina en direct (V6 live) — mock des routes noyau `/v1/nina-live/*` (docs/AVATAR.md §5 du noyau).
 * Sans `MOCK_NINA_LIVE_CREDS` : 404 (drapeau éteint), le composant retombe sur le rig 2D.
 * Avec `MOCK_NINA_LIVE_CREDS=<fichier json {url, token}>` (salle LiveKit ouverte à l'avance par un outil de recette) :
 * la session rend ces identifiants, pour une recette du vrai flux vidéo dans le build.
 */
import { readFileSync } from "node:fs";

type Send = (status: number, payload: unknown, headers?: Record<string, string>) => void;
const RE = /^\/v1\/nina-live\/(session|usage|session\/([A-Za-z0-9_-]{1,80})\/end)$/;
let seconds = 0;
let started = 0;

export function handleNinaLive(user: string | null, method: string, path: string, send: Send): boolean {
  const m = RE.exec(path);
  if (!m) return false;
  const file = process.env.MOCK_NINA_LIVE_CREDS;
  if (!file) return send(404, { error: { code: "not_found" } }), true;
  if (!user) return send(401, { error: { message: "unauthorized" } }), true;
  const usage = () => ({ sessions: started ? 1 : 0, seconds, usd_estimate: Math.round((seconds / 60) * 0.2 * 100) / 100, usd_per_min: 0.2, max_session_s: 600 });
  if (m[1] === "session" && method === "POST") {
    const creds = JSON.parse(readFileSync(file, "utf8")) as { url: string; token: string };
    started = Date.now();
    return send(201, { session_id: "rs_mock", livekit: { url: creds.url, token: creds.token }, thread_id: "nina-live", max_duration_s: 600 }, { "Cache-Control": "no-store" }), true;
  }
  if (m[2] && method === "POST") {
    if (started) seconds += Math.round((Date.now() - started) / 1000);
    started = 0;
    return send(200, usage()), true;
  }
  if (m[1] === "usage" && method === "GET") return send(200, usage()), true;
  return send(404, { error: { code: "not_found" } }), true;
}
