# apps/mobile — coque native Nokker (Capacitor 8)

Lot P2 de `docs/LOKKAL-PHONE.md` (dépôt nokker) : la webapp `apps/web` est **dans le paquet** (`webDir: ../web/dist`,
jamais de `server.url` : une faille du site ne donnerait pas le pont natif). iOS d'abord, identifiant `ai.nokker.app`.

```
pnpm install
pnpm --filter @nokker-apps/mobile build:ios   # web (API https://app.nokker.ai, build de magasin iOS) + cap sync ios
open apps/mobile/ios/App/App.xcodeproj        # sur un Mac (Xcode 26)
```

CI (phase S, simulateur, sans signature) : `scripts/ios-ci/smoke.sh` prend ce dossier dès que `ios/App` existe.
Icône et écran de lancement : `python3 apps/mobile/scripts/brand_assets.py` (depuis `packages/brand`).

Plugins : App (retour, cycle de vie), Browser (liens web et SSO dans SFSafariViewController), Haptics, Keyboard
(`resize: native`), StatusBar, SplashScreen. Le web les enregistre seulement dans la coque (`src/platform/plugins.ts`).

## Partager vers Nokker (lot P5a)

Extension de partage iOS (`ios/App/ShareExtension`, `ai.nokker.app.share`) : texte, adresse web, 4 images, 4 PDF. Elle
dépose le partage dans l'App Group `group.ai.nokker.app` (`share/<id>/manifest.json`, images JPEG ≤ 2048 px, texte des
PDF extrait sur l'appareil par PDFKit, 20 000 caractères), puis ouvre `nokker://share/<id>`. L'app lit la boîte par le
plugin maison `NokkerShare` (`App/NokkerSharePlugin.swift`, enregistré par `NokkerViewController`) ; l'interface ouvre un
nouveau fil avec la pièce DANS le composeur : la personne ajoute sa phrase et envoie. Rien ne part tout seul.

CI : extension embarquée et point d'extension vérifiés ; un partage de test déposé dans le conteneur du groupe puis
`nokker://share/ci-smoke` ouvert (capture `share.png`). Signature ad hoc (`-`) pour que le simulateur ouvre le groupe.

## Zones et scénarios d'arrivée et de départ (lot P6)

Plugin maison `NokkerZones` (`App/NokkerZonesPlugin.swift`, Core Location, régions circulaires ≥ 150 m, 18 au plus) et
carte native `ZonePickerViewController` (MapKit : épingle fixe au centre, cercle du rayon). Les zones (centre, rayon)
restent dans les données de l'app ; le noyau ne reçoit que le nom, l'id, les scénarios choisis et les transitions
(`PUT /v1/me/zones`, `POST /v1/me/zones/{id}/event {event_id, event, at}`). Les transitions sont mises en file sur
l'appareil et envoyées par l'interface au lancement, au retour au premier plan et à chaque transition (Mon compte →
Mes zones). Divulgation exacte de LOKKAL-PHONE §5 avant l'invite système ; « Toujours » seulement pour une zone qui a
un scénario.

CI : position « Toujours » accordée (`simctl privacy`), zone posée dans les données de l'app, position simulée dehors
→ dedans → dehors (`simctl location`), journal « NokkerZones: enter/exit ».

## Agenda, contacts et rappels du téléphone (lot P8, lecture)

Plugin maison `NokkerPim` (`App/NokkerPimPlugin.swift`, EventKit et Contacts, lecture seule, accès complet iOS 17).
Rien n'est copié d'avance : le noyau envoie `device.request` sur le flux d'événements de l'app pendant un tour, l'app
lit (50 éléments, champs minimaux, notes ≤ 300) et répond `POST /v1/me/device-requests/{id}/result`. Côté modèle,
l'agenda du téléphone est un agenda de plus dans la liste de 068 (chaque champ clôturé comme un contenu de tiers).
Phase S : seul l'agenda est branché ; contacts et rappels « bientôt » dans Mon compte → Cet appareil (jamais déclarés).

CI : accès accordés (`simctl privacy`), autotest du plugin en debug (drapeau `nokker-ci-pim`) qui pose et relit un
événement, un contact et un rappel.

## Texte reconnu sur l'appareil (lot P9)

Plugin maison `NokkerText` (`App/NokkerTextPlugin.swift`) : Vision pour le texte d'une photo, Speech TOUJOURS sur
l'appareil (`requiresOnDeviceRecognition` ; sans reconnaissance locale pour la langue : refus, jamais en ligne).
Trois gestes du composeur, trois sources du contrat : « Texte seul » sur une image → `device_ocr` ; audio joint →
`device_stt` ; micro → `device_dictation` (le message de la personne). Le texte reconnu s'affiche, modifiable, avant
d'être joint ; il part comme pièce du message de la personne (`attachments`, kind `text`), jamais comme résultat d'outil.

CI : autotest OCR (drapeau `nokker-ci-text`) sur une image générée « NOKKER 2026 » ; la transcription n'est pas
prouvée en simulateur (souvent pas de reconnaissance locale, pas de micro).

## À recetter sur appareil (le simulateur ne le prouve pas)

- Dictée au micro et transcription d'un audio joint (fr, en), reconnaissance sur l'appareil, invites micro et parole ;
  « Texte seul » sur une vraie photo (facture, ticket).

- Agenda : invite « accès complet » au premier interrupteur, vrais agendas (iCloud, Exchange) et une demande de Nina
  pendant une conversation (la ligne « Agenda du téléphone lu : N événements »).

- Zones : arrivée et départ réels (marche, voiture), app tuée puis relancée par iOS au franchissement ; l'invite
  « Toujours » et le rappel d'iOS ; la carte native au doigt. Envoi immédiat app tuée : lot P7 (jeton du nœud).

- Feuille de partage réelle depuis Safari, Photos, Fichiers (texte, adresse, images, PDF) et l'ouverture de Nokker
  par l'extension (chaîne des répondeurs) ; sinon, reprise du partage à la prochaine ouverture.
- App Group avec un vrai profil signé (compte Apple, identifiants `ai.nokker.app` et `ai.nokker.app.share`).

- Vibrations (Haptics) et toc toc toc au micro.
- Clavier : composeur visible clavier ouvert, rotation.
- Zones sûres sur un iPhone à île dynamique, en paysage.
- Liens universels et Associated Domains (compte Apple, lot P3).
- Passkeys natives et Face ID (lot P3).
- Nœud téléphone (P7) : la clé en Secure Enclave sur un vrai iPhone (« key_storage: secure_enclave »), le jeton scellé
  ouvert par la clé d'accord de l'enclave, l'effacement du trousseau après une réinstallation.
- Pages par le téléphone (P11) : un vrai fetch épinglé en Wi-Fi puis en données mobiles (case « Aussi en données
  mobiles » cochée et décochée → refus `cellular_off`), mode données réduites d'iOS (`constrained`), batterie sous 20 %
  hors charge (`low_battery`), NAT64 d'un réseau cellulaire IPv6 seul.
- Masquage (P9b) : dans le journal, « NokkerVault: self-test redact ok (… protection NSFileProtectionComplete) » ; au
  simulateur la ligne dit « n/a (simulator) », sur l'appareil tout autre valeur fait échouer l'autotest. Vérifier aussi
  qu'un fichier du coffre est illisible appareil verrouillé et absent d'une sauvegarde.
- Nœud maison (P10a) : ajouter l'entitlement `com.apple.developer.networking.wifi-info` au profil (P3) ; « Ce Wi-Fi est
  celui de la maison » avec la position autorisée → `home_wifi` vrai, puis faux sur un autre Wi-Fi et en données
  mobiles ; invite iOS « réseau local » au premier contact de HA ; un vrai Home Assistant sur l'iPad en Wi-Fi maison
  (http `.local` et IP privée, https avec un certificat valide pour le nom) ; un `.local` qui résout vers une adresse
  publique est refusé ; écran gardé allumé au premier plan en mode maison ; jeton saisi dans le champ natif, absent de
  la WebView et des journaux. Les actions (`ha.call_service`, `ha.notify`, `ha.tracker_see`) restent refusées
  (`attestation_required`) tant que l'attestation de l'appareil n'existe pas.
- Actions sur la maison (P3, avec l'attestation ; noyau P10a) : le noyau pose `attestation` (JWT ES256
  `nokker-phone-task`) sur la tâche d'une action et `origin` peut porter `decision`. À faire :
  - ajouter ces deux champs à `PhoneTask` (SDK) ;
  - vérifier le JWT sur l'appareil : JWKS du lien, `aud` = machine_id, `exp` ≤ 120 s, `op` et `task_id` identiques,
    `args_sha256` recalculé sur les arguments reçus ;
  - pour une décision `direct`, refuser `lock`, `alarm_control_panel`, `valve`, `siren`, `camera`, `script` et
    `automation`, ainsi que les `cover` de classe garage, door ou gate, ou sans classe, même avec un JWT valide ;
  - garder la liste blanche locale des entités ;
  - lever alors le refus `attestation_required` de NokkerNodePlugin pour `ha.call_service`, `ha.notify` et
    `ha.tracker_see`.
- Écran mural (P10b) : sur une tablette AVEC code, mise en place → session fermée (rouvrir l'app mène au mur, pas à
  un compte) ; sortie par 3 s d'appui puis Face ID / Touch ID / code (invite NSFaceIDUsageDescription au premier
  usage), refus → le mur reste ; sur un appareil SANS code, mise en place refusée ; luminosité 0,15 de 22:00 à 07:00,
  rendue le matin, en arrière-plan et à la sortie ; écran jamais en veille tant que le mur est affiché.
- Écran mural sur Android (lot Android, décision dev 06.11) : même règle qu'iOS. Sortie par BiometricPrompt avec
  `BIOMETRIC_STRONG | DEVICE_CREDENTIAL` ; appareil sans verrouillage (`KeyguardManager.isDeviceSecure` faux) refusé
  comme mur ; la mise en place ferme la session d'office ; textes Android figés à la relecture des textes quand ils existent.
- Caméra de veille (P10c) — divulgation : la détection se fait sur l'appareil ; « personne » est une CLASSE de
  mouvement (Vision, VNDetectHumanRectanglesRequest), jamais une identité : aucune reconnaissance de visage, aucune
  identification. Le noyau et le modèle ne reçoivent que du texte (heure, « personne » ou « mouvement », nom de la
  caméra) ; aucune image ne quitte le réseau local en v1. Vignettes : 24 h, 200 Mo au plus, protection `complete`,
  hors sauvegarde, effacées avec le nœud ; lues seulement depuis le Wi-Fi de la maison, chiffrées de bout en bout
  (AES-256-GCM, clé par demande, URL LAN à usage unique). Un bandeau « Caméra de veille active » reste visible tant
  qu'elle tourne. L'aide de mise en place rappelle d'informer le foyer et les visiteurs.
- Caméra de veille (P10c), à recetter sur appareil (P3) : invite NSCameraUsageDescription ; détection réelle à 2 i/s
  (personne, mouvement, anti-rafale d'une minute) ; veille seulement branché, en mode maison, au premier plan ; arrêt
  et bandeau retiré en arrière-plan ; bandeau visible par-dessus l'écran mural ; vignette vue depuis un autre
  téléphone du titulaire sur le même Wi-Fi (invite « réseau local » des deux côtés), refusée hors Wi-Fi maison et à
  la 2e lecture ; protection `complete` des fichiers sur l'appareil ; échauffement et batterie sur plusieurs heures.
- Micro en mode maison (décisions dev 06.11) : par défaut aucune écoute permanente — seuls la caméra de veille (native,
  avec bandeau, sans son) et la dictée lancée par un geste du titulaire utilisent la caméra ou le micro. Exception
  voulue par le produit : « Frapper pour appeler » NATIF (NokkerKnock.swift), éteint par défaut, allumé seulement par le
  propriétaire (Face ID, Touch ID ou code), bandeau permanent avec « Couper » sans authentification. Le « toc toc toc »
  de la page (web, getUserMedia) reste coupé et ne peut pas être relancé (setKnockBlocked), sans reprise automatique à la sortie ;
  deuxième couche native (lot P10d) : la WebView se voit refuser micro et caméra dans ces modes. La dictée : bouton
  en état « enregistrement » pendant l'écoute, arrêt automatique à la fin (durée maximale) et en arrière-plan, micro
  réellement libéré (moteur, prise, session audio). Sur l'écran mural, aucune session : ni composeur, ni dictée.
- Frapper pour appeler sur le nœud maison (à recetter sur appareil, P3) : allumage refusé sans Face ID / code, accepté
  avec ; invite micro au premier allumage ; bandeau visible par-dessus tout, « Couper » sans authentification puis la
  phrase « Écoute coupée… » 8 s ; trois coups sur bois, verre, porte et claps → « oui ? » puis UNE dictée arrêtée au
  silence, envoyée en tour de la voix du foyer (wall_voice, jeton nkw_ du nœud ; JAMAIS la session complète) ; quatre coups ou plus (série) → rien ; arrière-plan → indicateur micro d'iOS éteint,
  reprise au retour ; mode maison quitté ou nœud oublié → éteint. Mesures : CPU du JSContext (sans JIT) et batterie
  sur plusieurs heures ; au-delà de ~5 % d'un cœur, portage vDSP (réserve validée par dev). Écran mural : pas encore.
  INDISPONIBLE tant que la voix du foyer n'est pas en prod (`NokkerKnock.available` = false : réglage caché, allumage refusé).
- Dictée (à recetter sur appareil, P3 ; le simulateur n'a pas de reconnaissance sur l'appareil) : arrêt automatique à
  la durée maximale et au passage en arrière-plan, indicateur micro d'iOS éteint juste après, texte retrouvé dans le
  composeur, bouton sorti de l'état « enregistrement ».
- Découverte (P10d), à recetter sur appareil : invite « réseau local » ; refus → local_network_denied ; un Mac, un
  iPhone ou un iPad du foyer jamais listés ; aucun service annoncé par l'iPad (vérifier avec un navigateur Bonjour).
