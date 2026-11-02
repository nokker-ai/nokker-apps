/**
 * Glance view for display glasses (core docs/AMBIENT.md §6): a read-only device token of scope « glance » that opens
 * ONLY `GET /v1/glance` (any other route → 403 `glance_scope`). The database keeps only the token's fingerprint.
 *
 *   POST   /v1/glance/pair {name?}          phone session (Lokkal: local token) → 201 GlanceOffer ; 409 too_many_glance
 *   POST   /v1/glance/claim {code}          no auth (the code is the proof)      → 201 GlanceClaim ; 404 unknown_code ; 429 too_many_attempts
 *   GET    /v1/glance                       Authorization: Bearer nkg_…           → 200 GlanceView ; 401 bad_glance_token | glance_token_required
 *   GET    /v1/glance/devices               owner session                        → {devices: GlanceDevice[]}
 *   DELETE /v1/glance/devices/{id}          owner session                        → {revoked: true} ; 404 not hers
 */
import type { Agent, AgentRun } from "./bubbles.js";
import type { Incident } from "./ops.js";
import type { Approval } from "./types.js";

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

export type GlanceReading = "brief" | "brief_last_run" | "approvals" | "incidents";

export interface GlanceView {
  brief: { agent: Agent | null } | null;
  brief_last_run: AgentRun | null;
  approvals: Approval[];
  incidents: Incident[];
  /** Readings that failed or are off (flag): their value is `null` / `[]`, never a 500. */
  unavailable: GlanceReading[];
  at: string;
}

export interface GlanceDevice {
  id: string;
  name: string;
  kind: "glance";
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
