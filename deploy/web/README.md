# Image web Nokker

`docker build -f deploy/web/Dockerfile -t nokker-web .` depuis la racine de nokker-apps. nginx statique sur le port 8080,
`/healthz`, repli SPA. `/v1/` est routé vers le noyau à l'ingress (même origine, pas de proxy ici).

## PWA : service worker, cache, mise à jour

- `apps/web/public/sw.js` met en cache la coquille et `/assets/*`, jamais `/v1/*`. Le plugin vite pose un identifiant de
  build dans `dist/sw.js` (hash des noms d'assets) : un déploiement qui change le contenu change `sw.js`, le navigateur
  installe la nouvelle version, purge l'ancien cache et la page propose « Recharger ».
- nginx sert `/sw.js` et `/manifest.webmanifest` en `no-cache`.

## Kill-switch PWA

Si la PWA pose problème (écran figé sur une vieille version, cache fautif), servir l'image construite ainsi :

    docker build -f deploy/web/Dockerfile --build-arg PWA_KILL=1 -t nokker-web:<tag> .

Effet : `dist/sw.js` est remplacé par `deploy/web/sw-kill.js` et la page ne s'enregistre plus. Les navigateurs qui ont
déjà un service worker vérifient `/sw.js` à la navigation suivante (nginx : `no-cache`), reçoivent le kill-switch, qui vide
tous les caches, se désenregistre et recharge les onglets ouverts. Pas besoin d'attendre que les navigateurs oublient
l'ancien. Pour réactiver la PWA : redéployer l'image construite sans `PWA_KILL`.

Limite : un appareil hors-ligne, ou qui n'ouvre pas Nokker, garde l'ancien service worker jusqu'à sa prochaine visite.

## Apps natives (Capacitor)

`/.well-known/apple-app-site-association` (JSON, sans extension) et `/.well-known/assetlinks.json` : déposer les fichiers
dans `apps/web/public/.well-known/`, nginx a déjà les locations. Il faut les vrais Team ID et empreinte SHA-256 des
comptes développeur.
