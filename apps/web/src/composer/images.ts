/**
 * Images jointes à la demande (X7) : collées, déposées ou choisies, envoyées en `image_url` `data:` (format OpenAI).
 * Limites provisoires côté client, à aligner sur le noyau (contrat demandé à dev le 25.10).
 */
import type { ChatContentPart } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface PendingImage {
  id: string;
  name: string;
  type: string;
  size: number;
  /** `data:<type>;base64,…` */
  dataUrl: string;
}

export type ImageRefusal = "type" | "size" | "count";

/** Pourquoi refuser un fichier, ou `null` s'il passe. `count` = combien d'images sont déjà jointes. */
export function refuseImage(file: { type: string; size: number }, count: number): ImageRefusal | null {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return "type";
  if (file.size > MAX_IMAGE_BYTES) return "size";
  if (count >= MAX_IMAGES) return "count";
  return null;
}

/** Texte du refus, dans la langue de l'interface au moment de l'appel. */
export function refusalText(r: ImageRefusal): string {
  if (r === "type") return tr("Format not accepted: PNG, JPEG, WebP or GIF.");
  if (r === "size") return tr("Image too large: 5 MB at most.");
  return tr("{0} images at most per message.", MAX_IMAGES);
}

/** Contenu du message : texte seul si aucune image (forme historique, le noyau la connaît), sinon parties. */
export function messageContent(text: string, images: Pick<PendingImage, "dataUrl">[]): string | ChatContentPart[] {
  if (images.length === 0) return text;
  const parts: ChatContentPart[] = [];
  if (text.trim()) parts.push({ type: "text", text });
  for (const im of images) parts.push({ type: "image_url", image_url: { url: im.dataUrl } });
  return parts;
}

export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error(tr("Could not read the file")));
    r.readAsDataURL(file);
  });
}
