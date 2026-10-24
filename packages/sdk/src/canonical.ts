/**
 * JSON canonique — APPROVALS.md §2 : « empreinte `args_sha256` (JSON canonique : clés triées, sans
 * espaces, UTF-8) ». Même règle pour le défi (§3 : `{"approval_id","args_sha256","nonce","exp",
 * "aud":"nokker-approval"}`). Implémentation volontairement minimale (pas de `JSON.stringify` nu,
 * qui ne trie pas les clés et peut varier d'un moteur JS à l'autre sur l'ordre d'insertion).
 *
 * `sha256Hex` utilise `@noble/hashes` (pur JS, zéro dépendance native) plutôt que `node:crypto` ou
 * `WebCrypto` : ça tourne identiquement sous Node, dans un navigateur et sous React Native (où ni
 * `node:crypto` ni toujours `crypto.subtle` ne sont disponibles sans polyfill).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** Trie récursivement les clés d'un objet JSON-compatible (tableaux non triés : l'ordre y est sémantique). */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, sortKeysDeep(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
  }
  return value;
}

/** JSON canonique : clés triées (récursivement), aucun espace, UTF-8 (string JS = UTF-16 en mémoire,
 * mais l'encodage UTF-8 n'intervient qu'au moment du hash — voir `sha256Hex`). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

const textEncoder = new TextEncoder();

/** SHA-256 hex d'une chaîne, encodée en UTF-8 — c'est `argsSha256`/la signature du défi du contrat. */
export function sha256Hex(input: string): string {
  return bytesToHex(sha256(textEncoder.encode(input)));
}

/** Empreinte canonique des arguments d'un appel d'outil — APPROVALS.md §2. */
export function argsSha256(args: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(args));
}
