/**
 * Texte reconnu SUR L'APPAREIL (LOKKAL-PHONE §4.3.1, lot P9) — plugin natif `NokkerText` (Vision, Speech sur
 * l'appareil). Trois gestes, trois sources du contrat :
 * - « Envoyer le texte, pas la photo » sur une image du composeur → `device_ocr` (contenu de tiers) ;
 * - fichier audio joint → `device_stt` (contenu de tiers, rendu en [Transcription]) ;
 * - note dictée au micro du composeur → `device_dictation` (le message de la personne).
 * Jamais de reconnaissance en ligne : sans reconnaissance sur l'appareil pour la langue, on le dit.
 */
import { TEXT_ATTACHMENT_MAX_CHARS, TEXT_ATTACHMENT_NAME_MAX, TEXT_ATTACHMENTS_MAX, type TextAttachment, type TextSource } from "@nokker-apps/sdk";
import { isNativeShell } from "./native.js";

export interface TextPlugin {
  ocrImage(o: { data_url: string }): Promise<{ text: string }>;
  speechStatus(o?: { lang?: string }): Promise<{ speech: string; microphone: string; on_device: boolean }>;
  requestSpeech(o?: { lang?: string }): Promise<{ speech: string; microphone: string; on_device: boolean }>;
  /** `max_s` (5…120) ; `end_on_silence` : arrêt au premier silence (dictée lancée par trois coups). */
  dictationStart(o?: { lang?: string; max_s?: number; end_on_silence?: boolean }): Promise<{ started: boolean; max_s: number }>;
  dictationStop(): Promise<{ text: string; duration_s: number }>;
  /** Dictée arrêtée par l'app (durée maximale, arrière-plan) : le texte attend `dictationStop`. */
  addListener?(ev: "dictationEnded", cb: (r: { text: string; duration_s: number; reason: string }) => void): Promise<{ remove?: () => void }> | { remove?: () => void };
  transcribeAudio(o: { data_url: string; name?: string; lang?: string }): Promise<{ text: string; duration_s: number }>;
}

export function textPlugin(w: unknown = globalThis): TextPlugin | undefined {
  return isNativeShell(w) ? (w as { Capacitor?: { Plugins?: { NokkerText?: TextPlugin } } }).Capacitor?.Plugins?.NokkerText : undefined;
}

export const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;

/** Pièce texte du contrat : nom coupé à 80 caractères (sans caractères de contrôle), texte à 20 000. */
export function textAttachment(source: TextSource, name: string, text: string, extra: Pick<TextAttachment, "lang" | "pages" | "duration_s"> = {}): TextAttachment {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() || "texte";
  return { kind: "text", source, name: [...clean].slice(0, TEXT_ATTACHMENT_NAME_MAX).join(""), text: text.slice(0, TEXT_ATTACHMENT_MAX_CHARS), ...extra };
}

/** Encore une place pour une pièce texte dans ce message ? */
export const canAddText = (list: TextAttachment[]): boolean => list.length < TEXT_ATTACHMENTS_MAX;

/** Code d'un refus du plugin → clé de texte de l'interface. */
export function textRefusal(err: unknown): "unavailable_on_device" | "denied" | "failed" {
  const m = String((err as { message?: unknown; code?: unknown })?.code ?? (err as { message?: unknown })?.message ?? err);
  if (m.includes("unavailable_on_device")) return "unavailable_on_device";
  if (m.includes("denied")) return "denied";
  return "failed";
}
