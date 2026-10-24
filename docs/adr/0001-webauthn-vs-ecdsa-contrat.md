# ADR 0001 — WebAuthn/passkey (web) vs signature ECDSA brute (contrat)

- Statut : **accepté pour le développement client, à valider côté noyau**
- Date : 18.10.2026
- Contexte : `apps/web`, `packages/mock-server`

## Problème

`APPROVALS.md` §3 définit une preuve unique pour toutes les plates-formes :

> Signature ECDSA P-256 SHA-256, base64url, **format IEEE P1363** (WebCrypto). [...] La décision est
> incluse dans la signature : on signe `challenge + "." + decision`.

C'est exactement ce que fait `apps/cli` (`crypto.subtle.sign`, WebCrypto, P1363 par construction).

Mais le navigateur ne laisse personne manipuler une clé privée biométrique directement : WebAuthn
(passkey) est le seul mécanisme standard qui déclenche Touch ID/Face ID/Windows Hello depuis une page
web, et il impose SA PROPRE forme de signature :

1. Les données signées ne sont pas `challenge + "." + decision` mais
   `authenticatorData ‖ SHA-256(clientDataJSON)` — deux structures opaques produites par le
   navigateur/l'authentificateur, pas un texte qu'on choisit.
2. `clientDataJSON` a un schéma **figé par la spec** (`{type, challenge, origin, crossOrigin}`) : on
   ne peut pas y glisser un champ `decision` arbitraire.
3. La signature ECDSA rendue par WebAuthn est en **DER** (`SEQUENCE { INTEGER r, INTEGER s }`), pas en
   P1363 (r‖s de taille fixe) — WebCrypto `sign`/`verify` natif attend du P1363, pas du DER.
4. L'enrôlement ne donne pas directement une clé publique "comme CLIENT-API.md l'attend" : l'objet
   d'attestation est en CBOR ; il faut soit le parser, soit s'appuyer sur
   `response.getPublicKey()` (WebAuthn niveau 3) qui rend déjà du SPKI DER — disponible sur
   Chrome/Edge/Firefox récents, **pas sur Safari** à ce jour (limite connue, pas un bug de ce
   chantier).

Donc une implémentation WebAuthn au pied de la lettre du contrat est impossible : il faut une
variante, et il y a un vrai risque qu'une décision signée par passkey ne soit pas réellement liée au
choix approuver/refuser si on l'implémente négligemment (ex. si on ignore `decision` et qu'on signe
juste le nonce, un refus intercepté pourrait être rejoué comme une approbation).

## Décision

**Variante implémentée ici** (dans `apps/web/src/webauthn.ts` ET `packages/mock-server/src/webauthn.ts`,
donc testée en bout en bout dans le mock) :

1. **Enrôlement** : `apps/web` utilise `response.getPublicKey()` → la clé publique SPKI DER est
   envoyée telle quelle à `POST /v1/devices`, dans le **même champ** `publicKeySpkiB64` que la CLI.
   Le serveur n'a donc besoin que d'UNE seule routine de vérification de clé publique, partagée par
   tous les clients (pas de branche "format WebAuthn" côté stockage).
2. **Lier la décision à la signature** : le `challenge` WebAuthn envoyé à `navigator.credentials.get`
   n'est pas le nonce du contrat tel quel, mais **`SHA-256(challenge_contrat + "." + decision)`** —
   32 octets bruts. Comme WebAuthn signe bel et bien `clientDataJSON` (qui embarque ce `challenge`),
   la décision finit cryptographiquement liée à la signature, exactement comme l'exige APPROVALS.md
   §3 — juste transportée différemment.
3. **Vérification côté serveur** : reçoit `{challenge (texte canonique du contrat), decision,
   webauthn: {clientDataJSON, authenticatorData, signature}}` ; recalcule
   `attendu = SHA-256(challenge + "." + decision)`, vérifie que `clientDataJSON.challenge` (décodé)
   vaut `attendu`, convertit la signature **DER → IEEE P1363** (`derToP1363`, ~20 lignes, implémentée
   dans `packages/mock-server/src/webauthn.ts`), puis vérifie l'ECDSA sur
   `authenticatorData ‖ SHA-256(clientDataJSON)` avec la clé publique de l'appareil.
4. Même mécanique pour `POST /v1/sessions` (sans suffixe `.decision`, qui n'a pas de sens pour une
   connexion).

Propriétés obtenues : la preuve reste "signature ECDSA P-256 SHA-256 par la clé de l'appareil" au
sens large du contrat (même clé publique enregistrée, même courbe, même hash) ; la décision est
toujours incluse dans ce qui est signé ; rien n'est accepté sans confirmation biométrique réelle
(`userVerification: "required"`).

## Conséquences

- `packages/sdk` reste inchangé par ce choix (`signing.ts` ne connaît que la variante brute, utilisée
  par `apps/cli`) — la conversion DER→P1363 et la variante "challenge = hash(contrat+décision)" ne
  vivent que côté web/mock, pas dans le SDK partagé : si le noyau réel adopte une forme différente,
  seuls ces deux fichiers bougent.
- **Safari non supporté** pour l'instant (pas de `getPublicKey()`) — acceptable pour une démo de dev,
  à lever avant un lancement public (parser `attestationObject` en CBOR, ou attendre le support
  Safari).
- **À valider côté noyau** avant d'écrire le vrai serveur de `/v1/approvals/{id}/decision` : ce champ
  `webauthn` et cette convention de hachage du challenge ne sont QUE dans le mock. S'il existe déjà
  une décision d'architecture noyau sur ce sujet, elle prime sur cet ADR.

## Alternatives rejetées

- **Réclamer une signature WebCrypto brute (pas de passkey) en web** : reviendrait à générer une clé
  extractible en `localStorage`/IndexedDB non chiffré — pire posture de sécurité que ce que WebAuthn
  offre, et ça viole l'esprit d'APPROVALS.md §1 (preuve "libérée par biométrie" pour `strong`).
- **Stocker le couple `(challenge, decision)` côté serveur et accepter n'importe quel `clientDataJSON.
  challenge` tant qu'il matche un nonce connu, sans lier `decision`** : rejeté — un refus intercepté
  par un attaquant actif pourrait alors être renvoyé comme approbation avec la même signature.
