#!/usr/bin/env bash
# Compile Wire to a standalone bun executable for every supported target.
#
# Targets: darwin-arm64 (Apple Silicon), darwin-x64, linux-arm64, linux-x64.
# bun --compile bundles the runtime + all deps + bun:sqlite, so the
# resulting binaries have no runtime dependencies.
#
# Output: dist/wire-<target>[.zip] per target. Zips are what a release
# installer downloads; the raw binary is kept alongside for local
# smoke-tests.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

mkdir -p dist

# shellcheck disable=SC2207
TARGETS=(
  "bun-darwin-arm64"
  "bun-darwin-x64"
  "bun-linux-arm64"
  "bun-linux-x64"
)

VERSION="$(bun -e 'console.log((await import("./package.json", { with: { type: "json" } })).default.version)')"
echo "Building wire v${VERSION} for ${#TARGETS[@]} targets…"

for target in "${TARGETS[@]}"; do
  short="${target#bun-}"
  outfile="dist/wire-${short}"
  echo "  → ${target} → ${outfile}"
  bun build --compile --target="${target}" ./src/index.ts --outfile "${outfile}"
  # Bundle a README + LICENSE alongside the binary in a zip so single-file
  # downloads carry install instructions.
  zipfile="${outfile}.zip"
  rm -f "${zipfile}"
  (
    cd dist
    cp -f "../LICENSE" ./LICENSE 2>/dev/null || true
    zip -q "wire-${short}.zip" "wire-${short}" LICENSE 2>/dev/null || zip -q "wire-${short}.zip" "wire-${short}"
  )
done

echo
echo "Done. Artifacts in dist/:"
ls -lh dist/ | awk 'NR>1 {print "  "$0}'
