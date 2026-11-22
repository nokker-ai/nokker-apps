/**
 * Persona de l'assistant (lot V6) : le nom, la voix et l'avatar 3D choisis par la personne. Routes du noyau :
 * `GET /v1/persona/catalog`, `GET|PUT /v1/persona`, `POST /v1/persona/preview` et la parole horodatée d'une réponse
 * `POST /v1/threads/{id}/messages/{index}/speech/timed`. Le catalogue est une liste FERMÉE : le client n'envoie que des
 * identifiants qu'il y a lus.
 */

/** Une voix du catalogue ; `langs` = langues qu'elle parle (`fr`, `en`…). */
export interface PersonaVoice {
  id: string;
  label: string;
  langs: string[];
}

/** Référence d'un avatar : l'identifiant ET sa version (le fichier GLB d'une version ne change jamais). */
export interface PersonaAvatarRef {
  id: string;
  version: number;
}

/** Un avatar du catalogue. `url` et `thumb` (WebP) sont des chemins relatifs servis par l'app, versionnés pour le
 * cache immuable. `kind` : `rig2d` = dossier de calques (`/avatars/<id>-v<version>/`, l'URL finit par « / ») ;
 * `gltf` = modèle 3D (`/avatars/<id>-v<version>.gltf`). Absent (ancien noyau) : déduit de l'URL. */
export interface PersonaAvatar extends PersonaAvatarRef {
  label: string;
  kind?: "rig2d" | "gltf";
  url: string;
  thumb: string;
}

export interface PersonaCatalog {
  voices: PersonaVoice[];
  avatars: PersonaAvatar[];
  /** Bornes du nom, en caractères (1 et 24 aujourd'hui). */
  name: { min: number; max: number };
  defaults: { name: string; voice_id: string; avatar: PersonaAvatarRef };
}

/** `GET /v1/persona` et réponse 200 du `PUT`. `defaulted` : rien n'a encore été choisi, ce sont les valeurs par défaut. */
export interface Persona {
  name: string;
  voice_id: string;
  avatar: PersonaAvatarRef;
  defaulted: boolean;
}

/** Corps du `PUT /v1/persona` : seuls les champs présents changent. */
export interface PutPersonaRequest {
  name?: string;
  voice_id?: string;
  avatar?: PersonaAvatarRef;
}

/** Codes des refus 400 du `PUT /v1/persona` (`{error: {code}}`). */
export type PersonaErrorCode = "bad_name" | "bad_voice" | "bad_avatar";

/** Corps du `POST /v1/persona/preview`. */
export interface PersonaPreviewRequest {
  voice_id: string;
  lang: string;
}

/** Parole horodatée : le MP3 en base64 et le minutage de chaque mot (millisecondes), pour la synchro labiale. */
export interface TimedSpeech {
  audio: string;
  mime: "audio/mpeg";
  words: string[];
  wtimes: number[];
  wdurations: number[];
}

/** Codes d'erreur de `…/speech/timed` (mêmes que la route `/speech`). */
export type TimedSpeechErrorCode = "not_found" | "not_a_reply" | "too_long" | "rate_limited" | "provider_failed" | "tts_off";

/** Une `TimedSpeech` bien formée : trois listes de même longueur, des nombres finis, un audio non vide. */
export function isTimedSpeech(v: unknown): v is TimedSpeech {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<TimedSpeech>;
  if (typeof s.audio !== "string" || !s.audio || s.mime !== "audio/mpeg") return false;
  if (!Array.isArray(s.words) || !Array.isArray(s.wtimes) || !Array.isArray(s.wdurations)) return false;
  const n = s.words.length;
  if (s.wtimes.length !== n || s.wdurations.length !== n) return false;
  return s.words.every((w) => typeof w === "string") && [...s.wtimes, ...s.wdurations].every((x) => typeof x === "number" && Number.isFinite(x));
}
