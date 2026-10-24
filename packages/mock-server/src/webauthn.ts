/**
 * Vérification d'une assertion WebAuthn pour `apps/web` — voir l'écart documenté dans
 * `docs/adr/0001-webauthn-vs-ecdsa-contrat.md` : APPROVALS.md §3 attend une signature ECDSA P-256
 * **brute** (IEEE P1363) sur `challenge + "." + decision` ; WebAuthn signe
 * `authenticatorData || SHA-256(clientDataJSON)` et rend la signature en **DER**. La variante
 * ci-dessous (implémentée ici ET dans `apps/web/src/webauthn.ts`) lie la décision à la signature en
 * réutilisant le champ `challenge` de WebAuthn pour transporter `SHA-256(challenge + "." + decision)`
 * (bytes bruts, PAS le nonce du contrat lui-même) — c'est la variante proposée à valider côté noyau.
 */
import { webcrypto } from "node:crypto";

/** Décode base64url (SANS ou AVEC padding) ; le base64 standard passe aussi par cette conversion
 * sans effet (pas de `-`/`_` à remplacer) — même repli que le noyau (APPROVALS.md §3.1 : "base64
 * standard accepté en repli"). */
function base64ToBytes(b64: string): Uint8Array {
  const std = b64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = std.length % 4 === 0 ? "" : "=".repeat(4 - (std.length % 4));
  return new Uint8Array(Buffer.from(std + pad, "base64"));
}

/** Convertit une signature ECDSA DER (SEQUENCE INTEGER r INTEGER s) en IEEE P1363 (r‖s, taille fixe). */
export function derToP1363(der: Uint8Array, size = 32): Uint8Array {
  let offset = 2; // skip SEQUENCE tag + length
  function readInt(): Uint8Array {
    if (der[offset] !== 0x02) throw new Error("DER invalide : INTEGER attendu");
    offset += 1;
    let len = der[offset]!;
    offset += 1;
    let bytes = der.slice(offset, offset + len);
    offset += len;
    // retire les octets de signe nul en tête, puis bourre à `size`.
    while (bytes.length > size && bytes[0] === 0) bytes = bytes.slice(1);
    if (bytes.length < size) {
      const padded = new Uint8Array(size);
      padded.set(bytes, size - bytes.length);
      bytes = padded;
    }
    return bytes;
  }
  const r = readInt();
  const s = readInt();
  const out = new Uint8Array(size * 2);
  out.set(r, 0);
  out.set(s, size);
  return out;
}

export interface WebAuthnAssertion {
  clientDataJSONB64: string;
  authenticatorDataB64: string;
  signatureDERB64: string;
}

/** `expectedChallengeBytes` = SHA-256(canonicalChallenge + "." + decision) — voir en-tête de module. */
export async function verifyWebAuthnAssertion(
  publicKeySpkiB64Url: string,
  assertion: WebAuthnAssertion,
  expectedChallengeBytes: Uint8Array,
): Promise<{ ok: boolean; reason?: string }> {
  const clientDataBytes = base64ToBytes(assertion.clientDataJSONB64);
  let clientData: { type?: string; challenge?: string };
  try {
    clientData = JSON.parse(Buffer.from(clientDataBytes).toString("utf-8"));
  } catch {
    return { ok: false, reason: "clientDataJSON illisible" };
  }
  if (clientData.type !== "webauthn.get") return { ok: false, reason: `type inattendu: ${clientData.type}` };

  const gotChallenge = base64ToBytes((clientData.challenge ?? "").replace(/-/g, "+").replace(/_/g, "/"));
  if (
    gotChallenge.length !== expectedChallengeBytes.length ||
    !gotChallenge.every((b, i) => b === expectedChallengeBytes[i])
  ) {
    return { ok: false, reason: "challenge WebAuthn ne correspond pas à SHA-256(challenge.decision)" };
  }

  const authData = base64ToBytes(assertion.authenticatorDataB64);
  const clientDataHash = new Uint8Array(await webcrypto.subtle.digest("SHA-256", clientDataBytes));
  const signedData = new Uint8Array(authData.length + clientDataHash.length);
  signedData.set(authData, 0);
  signedData.set(clientDataHash, authData.length);

  const signatureDer = base64ToBytes(assertion.signatureDERB64);
  const signatureP1363 = derToP1363(signatureDer);

  const key = await webcrypto.subtle.importKey(
    "spki",
    base64ToBytes(publicKeySpkiB64Url),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const ok = await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signatureP1363, signedData);
  return ok ? { ok: true } : { ok: false, reason: "signature invalide" };
}
