#!/usr/bin/env bash
# Binaires autonomes du client : apps/cli/dist/nokker-<os>-<arch>[.exe] (+ .sha256, sortie de sha256sum).
#   scripts/build-bin.sh                 les 6 cibles
#   scripts/build-bin.sh linux-x64 ...   seulement celles-ci
# Version figée dans le binaire : $NOKKER_RELEASE_VERSION, sinon "version" de package.json.
# Prérequis : bun (>= 1.4, $BUN ou ~/.bun/bin/bun). Compilation croisée : bun télécharge le runtime de la cible.
set -euo pipefail
cd "$(dirname "$0")/.."
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
[ -x "$BUN" ] || { echo "bun introuvable (définir \$BUN)" >&2; exit 1; }
VERSION="${NOKKER_RELEASE_VERSION:-$(node -p "require('./package.json').version")}"
TARGETS=("$@")
[ ${#TARGETS[@]} -gt 0 ] || TARGETS=(linux-x64 linux-arm64 darwin-x64 darwin-arm64 windows-x64 windows-arm64)
mkdir -p dist
fail=0
for t in "${TARGETS[@]}"; do
  ext=""; [ "${t%%-*}" = "windows" ] && ext=".exe"
  out="dist/nokker-${t}${ext}"
  echo "→ ${out} (version ${VERSION})"
  if "$BUN" scripts/build-bin.ts "$t" "$VERSION" "$out"; then
    (cd dist && sha256sum "nokker-${t}${ext}" > "nokker-${t}${ext}.sha256")
  else
    echo "✗ ${t} : échec de compilation" >&2; fail=1
  fi
done
exit $fail
