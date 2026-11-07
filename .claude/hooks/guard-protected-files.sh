#!/usr/bin/env bash
# PreToolUse guard. Refuses writes to files that must not be edited by hand.
#
#   .env*            real credentials live here; .env*.example is fine
#   pnpm-lock.yaml   only pnpm may write this
#   prisma/migrations/*.sql   an applied migration is immutable; create a new one
#
# Exit 2 blocks the tool call and shows stderr to Claude.
set -euo pipefail

path=$(python3 -I -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print(""); sys.exit(0)
print(d.get("tool_input", {}).get("file_path", "") or "")
')

[ -z "$path" ] && exit 0
base=$(basename "$path")

case "$base" in
  *.example) exit 0 ;;
esac

case "$base" in
  .env|.env.*)
    echo "Blocked: $base holds real credentials. Edit .env.example instead, and tell the user which variable to set locally." >&2
    exit 2
    ;;
  pnpm-lock.yaml|package-lock.json|yarn.lock)
    echo "Blocked: $base is generated. Change dependencies with 'pnpm add/remove' so the lockfile stays consistent." >&2
    exit 2
    ;;
esac

case "$path" in
  *prisma/migrations/*.sql)
    echo "Blocked: an applied migration is immutable — editing it desyncs every database that already ran it. Create a new migration with 'pnpm prisma:migrate' instead." >&2
    exit 2
    ;;
esac

exit 0
