#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  printf '\nTepora V3 source edition needs Node.js 22.16 or later.\n'
  read -r _
  exit 1
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22 || a===22 && b<16)process.exit(1)' || exit 1
exec node core/server.mjs --open
