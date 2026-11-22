/**
 * ACCORD, écran « Appareils » — logique pure (testée sans navigateur) : empreintes à comparer, compte à rebours, texte
 * d'erreur de l'appairage, ligne d'un appareil. Contrat : nokker docs/ACCORD-DEVICE.md §2.
 */
import { NokkerApiError, type AccordDevice, type AccordPairError } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import { ago } from "../ops/model.js";

/** Les 8 caractères montrés des deux côtés (hôte `host_fp`, appareil `key8`), en deux groupes de 4 pour la lecture : la
 * personne les compare caractère par caractère avec l'écran de l'appareil. */
export function groupFingerprint(s: string): [string, string] {
  const f = s.slice(0, 8).toLowerCase();
  return [f.slice(0, 4), f.slice(4, 8)];
}

/** Lecture d'écran : les caractères un à un (« 9, f, 2, c … »), sinon « 9f2c » est lu comme un mot. */
export function spelled(s: string): string {
  return s.slice(0, 8).toLowerCase().split("").join(", ");
}

/** `m:ss` d'un nombre de secondes (jamais négatif) : « 1:42 ». */
export function countdown(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Le code attendu : exactement 6 chiffres (espaces tolérés, ôtés avant l'envoi). */
export function cleanCode(raw: string): string {
  return raw.replace(/\s+/g, "");
}
export const validCode = (raw: string): boolean => /^\d{6}$/.test(cleanCode(raw));

/** Code d'erreur de l'appairage (`{error:{code}}`), `null` si ce n'en est pas un. */
export function pairErrorCode(e: unknown): AccordPairError | null {
  if (!(e instanceof NokkerApiError)) return null;
  const c = e.code;
  return c === "bad_code" || c === "pairing_closed" || c === "pairing_locked" || c === "ambiguous" ? c : null;
}

/** Texte clair d'une erreur d'appairage ou d'ouverture de la fenêtre (dans la langue de l'interface). `lockedFor` :
 * secondes d'appairage bloqué connues (sinon 10 min, la durée du noyau). */
export function pairErrorText(e: unknown, lockedFor?: number): string {
  switch (pairErrorCode(e)) {
    case "bad_code":
      return tr("Wrong code. Check the digits on the device and try again.");
    case "pairing_locked":
      return tr("Pairing is blocked for {0} after three wrong codes. Try again later.", countdown(lockedFor && lockedFor > 0 ? lockedFor : 600));
    case "pairing_closed":
      return tr("The pairing window is closed. Click “Add a device” to open it again.");
    case "ambiguous":
      return tr("Several devices asked to pair with this code, so the window was closed. Start again and pair one device at a time.");
    default:
      if (e instanceof NokkerApiError && e.code === "bad_name") return tr("Name refused: 40 characters at most, no control characters.");
      return e instanceof NokkerApiError ? tr("The machine refused ({0}).", e.status) : tr("The machine is not responding.");
  }
}

/** Nom montré d'un appareil : celui que le noyau sert (le nom donné, sinon « ACCORD <key8> »). Un noyau plus ancien, qui n'en
 * sert pas : un nom générique (la clé est dans la ligne). */
export function deviceName(d: Pick<AccordDevice, "name">): string {
  return d.name?.trim() || tr("ACCORD device");
}

/** Le nom par défaut que le noyau donne à un appareil qu'on laisse sans nom (champ vide à l'enregistrement). */
export const defaultDeviceName = (key8: string): string => `ACCORD ${key8}`;

/** Nom saisi : 40 caractères au plus (les caractères visibles, pas les octets), sans caractère de contrôle ; vide = retour au nom
 * par défaut. Même règle que le noyau (NFC), pour refuser avant d'envoyer. */
export function validName(raw: string): boolean {
  const n = raw.normalize("NFC").trim();
  return [...n].length <= 40 && !/[\u0000-\u001f\u007f]/.test(n);
}

/** Dernière connexion d'un appareil, relative (« il y a 3 min ») ; jamais connecté : « jamais connecté ». */
export function lastSeenText(d: Pick<AccordDevice, "last_seen_at">, now = Date.now()): string {
  if (d.last_seen_at === null || d.last_seen_at === undefined) return tr("Never connected");
  return tr("Last seen {0}", ago(new Date(d.last_seen_at * 1000).toISOString(), now));
}

/** Appareils à lister : les actifs d'abord (plus récents en tête), puis les révoqués. */
export function sortDevices(list: readonly AccordDevice[]): AccordDevice[] {
  return [...list].sort((a, b) => Number(a.revoked) - Number(b.revoked) || b.paired_at - a.paired_at);
}

/** Date et heure courtes d'un horodatage Unix (secondes), dans la langue de l'interface. */
export function when(sec: number, lang: string): string {
  return new Date(sec * 1000).toLocaleString(lang === "fr" ? "fr-CH" : "en-GB", { dateStyle: "medium", timeStyle: "short" });
}
