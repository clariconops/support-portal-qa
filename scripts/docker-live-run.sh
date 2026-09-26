#!/bin/sh
# Typecheck + live end-to-end run of the automation features against the
# running stack, executed from inside a container (host has no Node).
set -e
cd /app

echo "== typecheck =="
node ./node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
echo "TYPECHECK_OK"

echo "== live run: webchat-automation + automation flows =="
node ./node_modules/tsx/dist/cli.mjs src/cli.ts run --feature webchat-automation automation --env local

echo "LIVE_RUN_DONE"

