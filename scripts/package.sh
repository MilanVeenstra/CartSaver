#!/bin/bash
#
# Build the upload for the Chrome Web Store: only what the extension needs
# (manifest.json, _locales, icons, src), with manifest.json at the root.
#
#   bash scripts/package.sh
#
# Writes dist/extension/ (the exact folder that is zipped, to load and check
# it) and dist/cart-saver-<version>.zip, and prints the ZIP's SHA-256.
# Tests, docs, scripts and anything local (build-id.txt, keys) stay out.

set -euo pipefail

cd "$(dirname "$0")/.."
version="$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')"
out="dist/extension"
zip="dist/cart-saver-${version}.zip"

rm -rf "$out" "$zip"
mkdir -p "$out"
cp manifest.json "$out/"
cp -R _locales icons src "$out/"

# The store gives the extension its own key: an upload carries none.
python3 - "$out/manifest.json" <<'EOF'
import json, sys
path = sys.argv[1]
manifest = json.load(open(path))
manifest.pop("key", None)
json.dump(manifest, open(path, "w"), indent=2, ensure_ascii=False)
open(path, "a").write("\n")
EOF

# Nothing that does not belong in a public upload.
if find "$out" \( -name '*.pem' -o -name '.DS_Store' -o -name 'build-id.txt' -o -type l \) | grep -q .; then
  echo "Refusing: keys, symlinks or local files in $out" >&2
  exit 1
fi

# Same bytes for the same files: fixed dates and order.
find "$out" -exec touch -t 198001010000 {} +
(cd "$out" && find . -type f | LC_ALL=C sort | sed 's|^\./||' | zip -X -q -9 "../$(basename "$zip")" -@)

echo "$zip"
if command -v shasum >/dev/null; then shasum -a 256 "$zip"; else sha256sum "$zip"; fi
