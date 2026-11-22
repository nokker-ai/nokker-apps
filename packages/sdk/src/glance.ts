/**
 * Glance view for display glasses (core docs/AMBIENT.md §6): a read-only device token of scope « glance » that opens
 * ONLY `GET /v1/glance` (any other route → 403 `glance_scope`). The database keeps only the token's fingerprint.
 *
 *   POST   /v1/glance/pair {name?}          phone session (Lokkal: local token) → 201 GlanceOffer ; 409 too_many_glance
 *   POST   /v1/glance/claim {code}          no auth (the code is the proof)      → 201 GlanceClaim ; 404 unknown_code ; 429 too_many_attempts
 *   GET    /v1/glance                       Authorization: Bearer nkg_…           → 200 GlanceView ; 401 bad_glance_token | glance_token_required
 *   GET    /v1/glance/devices               owner session                        → {devices: GlanceDevice[]}
 *   DELETE /v1/glance/devices/{id}          owner session                        → {revoked: true} ; 404 not hers
 *   PATCH  /v1/glance/devices/{id} {show_brief}  owner session, WALL only        → GlanceDevice ; 400 not_wall
 *
 * Wall screen (LOKKAL-PHONE §4.4, lot P10b; decided by dev 06.11): a glance device paired with `surface: "wall"` sits
 * in a shared room, so the core sends the MINIMUM, filtered server side: card COUNT only (`approvals: []`), incident
 * titles only, no brief unless the owner turned `show_brief` on, next event of the OWNER's calendars with its title only
 * when `show_brief` is on. No presence in v1 (other members' data: household sharing lot).
 */
import type { Agent, AgentRun } from "./bubbles.js";
import type { Incident } from "./ops.js";
import type { Approval } from "./types.js";
import type { PersonaAvatarRef } from "./persona.js";

import type { GlanceScreen } from "./screens.js";

export interface GlanceOffer {
  offer_id: string;
  /** `XXXX-XXXX`, alphabet without 0/O, 1/I/L, U ; 5 minutes, single use. */
  code: string;
  /** Text of the QR code: `NOKKER-GLANCE:<code without dash>`, sent as is to `/claim`. */
  qr: string;
  expires_in: number;
}

export interface GlanceClaim {
  token: string;
  device: { id: string; name: string };
  scope: "glance";
}

export type GlanceReading = "brief" | "brief_last_run" | "approvals" | "incidents" | "next_event";
export type GlanceSurface = "glasses" | "wall";

/** First event of the next 24 h in the owner's CONNECTED calendars (never the phone's), an ongoing one included ;
 * `start`: a DATE `YYYY-MM-DD` for an all-day event, else ISO 8601 with offset ; wall: `title` (≤ 120 chars) only
 * when `show_brief` is on. A failure puts `next_event` in `unavailable` (core p2/glance-wall 2f9f656). */
export interface GlanceNextEvent {
  start: string;
  all_day: boolean;
  title?: string;
}

export interface GlanceView {
  brief: { agent: Agent | null } | null;
  brief_last_run: AgentRun | null;
  approvals: Approval[];
  incidents: Incident[];
  /** Readings that failed or are off (flag): their value is `null` / `[]`, never a 500. */
  unavailable: GlanceReading[];
  at: string;
  /** P10b: number of cards that wait (a wall gets this, never `approvals`). */
  approvals_count?: number;
  /** P10b: absent without a connected calendar. */
  next_event?: GlanceNextEvent | null;
  surface?: GlanceSurface;
  show_brief?: boolean;
  /** V6, mur seulement : l'avatar choisi par le titulaire (null : aucun) et la langue de sa voix. */
  avatar?: PersonaAvatarRef | null;
  lang?: string;
  /** V7 (core docs/SCREENS.md): the published screen of a WALL, `null` when none; absent when screens are off. */
  screen?: GlanceScreen | null;
}

export interface GlanceDevice {
  id: string;
  name: string;
  kind: "glance";
  /** P10b: `wall` for a wall screen (minimum view); absent = glasses. */
  surface?: GlanceSurface;
  /** Brief summary and event titles shown: always true for glasses; a wall starts at false (anyone in the room). */
  show_brief?: boolean;
  paired: boolean;
  revoked: boolean;
  created_at: string;
  last_seen_at: string | null;
  account_id?: string;
}

/** The code as typed (any case, with or without the dash) or the QR text: what `/claim` accepts, for a quick check. */
export function normalizeGlanceCode(input: string): string {
  return input
    .trim()
    .replace(/^NOKKER-GLANCE:/i, "")
    .replace(/[\s-]+/g, "")
    .toUpperCase();
}

export const GLANCE_TOKEN_PREFIX = "nkg_";
