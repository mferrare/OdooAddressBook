#!/usr/bin/env bash
set -euo pipefail

VERSION=$(jq -r .version manifest.json)
OUT="odoo-address-book-${VERSION}.xpi"

zip -r "$OUT" . \
  --exclude "*.git*" \
  --exclude ".claude/*" \
  --exclude "package.sh" \
  --exclude "*.xpi" \
  --exclude "README.md"

echo "Packaged: $OUT"
