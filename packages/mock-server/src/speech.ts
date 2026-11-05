/**
 * Reading a reply aloud (core p2/tts-stream, contract of 03.11.2026), mock: flag `MOCK_TTS=1`.
 *   GET  /v1/speech                                   → {available, max_chars, format: "audio/mpeg"} ; 404 when off
 *   POST /v1/threads/{id}/messages/{index}/speech     → audio/mpeg in chunks (a quiet tone, whatever the text)
 *        404 not_found · 409 not_a_reply · 413 too_long ; errors only before the first byte
 * The text read is the reply of that turn, read by the server: the client never sends text.
 */
import type { ServerResponse } from "node:http";
import { DEMO_SPEECH_MP3_B64 } from "./speech-demo-mp3.js";
import type { MockState } from "./state.js";

export const SPEECH_MAX_CHARS = 4000;
const MP3 = Buffer.from(DEMO_SPEECH_MP3_B64, "base64");

const fail = (res: ServerResponse, status: number, code: string, message: string): true => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: { code, message } }));
  return true;
};

export function handleSpeech(state: MockState, user: string | null, method: string, path: string, res: ServerResponse): boolean {
  if (path === "/v1/speech" && method === "GET") {
    if (!state.tts) return fail(res, 404, "not_found", "tts éteinte");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ available: true, max_chars: SPEECH_MAX_CHARS, format: "audio/mpeg" }));
    return true;
  }
  const m = /^\/v1\/threads\/([^/]+)\/messages\/(\d+)\/speech$/.exec(path);
  if (!m || method !== "POST") return false;
  if (!state.tts) return fail(res, 503, "tts_off", "tts éteinte");
  let rec;
  try {
    rec = state.requireMember(decodeURIComponent(m[1]!), user);
  } catch {
    return fail(res, 404, "not_found", "fil inconnu");
  }
  const turn = rec.turns[Number(m[2])];
  if (!turn) return fail(res, 404, "not_found", "message inconnu");
  if (!turn.reply) return fail(res, 409, "not_a_reply", "ce tour n'a pas de réponse");
  if (turn.reply.length > SPEECH_MAX_CHARS) return fail(res, 413, "too_long", "réponse trop longue pour être lue");
  // Chunked, like the core relaying the provider's stream: the web starts playing on the first chunk.
  res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" });
  const CHUNK = 2048;
  let at = 0;
  const next = (): void => {
    if (res.destroyed) return;
    if (at >= MP3.length) return void res.end();
    res.write(MP3.subarray(at, at + CHUNK));
    at += CHUNK;
    setTimeout(next, 120 * state.speed);
  };
  next();
  return true;
}
