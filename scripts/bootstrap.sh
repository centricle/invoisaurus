#!/bin/sh
#
# Takes a fresh checkout to a running app in one command.
# Safe to re-run: every step is idempotent.
#
#   ./scripts/bootstrap.sh      or      npm run setup
#
set -e

cd "$(dirname "$0")/.."

# Minor-level, not major: `npm test` passes a glob to `node --test` and lets the
# test runner expand it, which older 22.x cannot do. It matches nothing there
# and reports a passing run of zero tests, which is the worst way to fail.
REQUIRED=22.6.0

if ! command -v node >/dev/null 2>&1; then
  echo "Node is not installed. This app needs Node ${REQUIRED} or newer." >&2
  echo "See https://nodejs.org for an installer, or use nvm." >&2
  exit 1
fi

if ! node -e '
  const need = process.argv[1].split(".").map(Number);
  const have = process.versions.node.split(".").map(Number);
  process.exit(have[0] > need[0] || (have[0] === need[0] && have[1] >= need[1]) ? 0 : 1);
' "$REQUIRED"; then
  echo "Node $(node -v) found, but this app needs Node ${REQUIRED} or newer." >&2
  echo "The server uses --watch, and the tests are run through the built-in runner." >&2
  exit 1
fi

echo "==> Node $(node -v)"

echo "==> Installing dependencies"
npm install

# The compiled stylesheet is not committed, so a fresh clone has none. Without
# this the app runs but every page is unstyled, which reads as broken.
echo "==> Building CSS"
npm run css:build

echo "==> Seeding demo data"
node scripts/seed.mjs

# The port the app will actually bind, asked of the app rather than repeated
# here. A copy of the default drifts silently and sends a first-time reader
# to the wrong URL at the one moment they cannot tell what is wrong.
PORT_IN_USE=$(node --input-type=module -e 'import {PORT} from "./src/config.js"; console.log(PORT)')
cat <<MSG

Done. Start it with:

  npm run dev

Then open http://localhost:${PORT_IN_USE}

The demo vendor, client and invoice are fictional. Remove them with:

  npm run seed -- --remove
MSG
