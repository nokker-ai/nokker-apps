/**
 * Nina en direct (V6 live, drapeau noyau `nina_live`) : le noyau ouvre la session vidéo temps réel (Runway) pour le
 * titulaire et rend le jeton ÉPHÉMÈRE de la salle LiveKit — jamais une clé de fournisseur.
 *   POST /v1/nina-live/session {thread_id?} → 201 NinaLiveSession ; 403 not_titular | terms_outdated ;
 *        404 (éteint) | thread_not_found ; 409 session_busy ; 502/504 (fournisseur) ; 503 (clé absente)
 *   POST /v1/nina-live/session/{id}/end → 200 NinaLiveUsage
 *   GET  /v1/nina-live/usage → 200 NinaLiveUsage
 */
export interface NinaLiveSession {
  session_id: string;
  livekit: { url: string; token: string };
  /** Fil où Nina parle (celui demandé, sinon `nina-live`). */
  thread_id: string;
  max_duration_s: number;
}

export interface NinaLiveUsage {
  sessions: number;
  seconds: number;
  usd_estimate: number;
  usd_per_min: number;
  max_session_s: number;
}
