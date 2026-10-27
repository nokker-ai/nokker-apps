/**
 * Passkey/WebAuthn côté navigateur — voir `docs/adr/0001-webauthn-vs-ecdsa-contrat.md` pour
 * l'écart avec la signature ECDSA brute attendue par le contrat, et la variante implémentée ici
 * ET côté `packages/mock-server/src/webauthn.ts` (le `challenge` WebAuthn transporte
 * `SHA-256(challenge_contrat + "." + decision)`, pas le nonce du contrat tel quel).
 *
 * `credential.response.getPublicKey()` (WebAuthn L3, Chrome/Edge/Firefox récents — PAS Safari à ce
 * jour, limite notée dans l'ADR) rend directement la clé publique en SPKI DER : on évite ainsi de
 * parser l'`attestationObject` CBOR à la main, et la clé est dans le MÊME format que celle de la
 * CLI (`apps/cli`), donc vérifiable côté serveur par le même code.
 */

import { tr } from "./i18n/index.js";

const rpName = (): string => tr("Nokker (provisional name)");

/** base64url SANS padding — forme canonique attendue par le contrat pour `public_key_spki` et les
 * champs WebAuthn (APPROVALS.md §3.1/§3.4). */
function toB64Url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64Url(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  // Type de retour explicitement paramétré en `ArrayBuffer` (et non `Uint8Array.from`, qui infère
  // `ArrayBufferLike`) — le typage DOM de `allowCredentials[].id` (BufferSource) refuse le second.
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface PasskeyRegistration {
  /** base64url SANS padding — à poser tel quel dans `public_key_spki` (APPROVALS.md §3.1). */
  publicKeySpkiB64Url: string;
  credentialIdB64Url: string;
}

export async function registerPasskey(userLabel: string): Promise<PasskeyRegistration> {
  if (!window.PublicKeyCredential) {
    throw new Error(tr("WebAuthn is unavailable in this browser — passkey not possible."));
  }
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: rpName() },
      user: { id: userId, name: userLabel, displayName: userLabel },
      challenge,
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256 (ECDSA P-256 SHA-256)
      authenticatorSelection: { userVerification: "required" },
      timeout: 60_000,
      attestation: "none",
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error(tr("Passkey enrolment cancelled."));

  const response = credential.response as AuthenticatorAttestationResponse & { getPublicKey?: () => ArrayBuffer | null };
  const spki = response.getPublicKey?.();
  if (!spki) {
    throw new Error(tr("This browser does not return the SPKI public key (getPublicKey) — Safari in particular. Use Chrome/Edge/Firefox for this demo, or implement CBOR parsing (see the ADR)."));
  }
  return { publicKeySpkiB64Url: toB64Url(spki), credentialIdB64Url: toB64Url(credential.rawId) };
}

/** Forme snake_case du contrat (`WebAuthnProof`, APPROVALS.md §3.4/§3.6) — trois champs en base64url. */
export interface WebAuthnDecisionProof {
  client_data_json: string;
  authenticator_data: string;
  signature: string;
}

/** Signe `challenge + "." + suffix` via passkey (le texte lui-même n'est PAS signé directement :
 * c'est son SHA-256 qui devient le `challenge` WebAuthn, voir l'ADR). `suffix` omis pour une
 * connexion (APPROVALS.md §3.6 : `SHA-256(challenge)` SANS suffixe) ; `"approve"`/`"reject"` pour
 * une décision (§3.4). */
export async function signDecisionWithPasskey(
  credentialIdB64Url: string,
  challenge: string,
  suffix?: string,
): Promise<WebAuthnDecisionProof> {
  const payload = suffix === undefined ? challenge : `${challenge}.${suffix}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)));
  const credentialId = fromB64Url(credentialIdB64Url);

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: digest,
      allowCredentials: [{ id: credentialId, type: "public-key" }],
      userVerification: "required",
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new Error(tr("Passkey signature cancelled."));

  const response = assertion.response as AuthenticatorAssertionResponse;
  return {
    client_data_json: toB64Url(response.clientDataJSON),
    authenticator_data: toB64Url(response.authenticatorData),
    signature: toB64Url(response.signature),
  };
}
