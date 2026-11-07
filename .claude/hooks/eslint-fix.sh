#!/usr/bin/env bash
# PostToolUse: auto-fix the file that was just edited, and report anything
# eslint could not fix so it gets dealt with now rather than at pre-push.
#
# There is no Prettier in this project, so eslint is the whole formatting and
# lint story. Exit 2 hands the remaining messages back to Claude.
#
# --max-warnings 0 is deliberate and stricter than `pnpm lint`. The repo is at
# zero eslint output today, so any warning this reports is one that was just
# introduced -- usually an unused import or variable left behind by an edit.
# Drop the flag if that ever stops being true.
set -uo pipefail

path=$(python3 -I -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print(""); sys.exit(0)
print(d.get("tool_input", {}).get("file_path", "") or "")
')

case "$path" in
  *.ts) ;;
  *) exit 0 ;;
esac

[ -f "$path" ] || exit 0

cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

out=$(pnpm exec eslint --fix --max-warnings 0 "$path" 2>&1)
status=$?

if [ $status -ne 0 ]; then
  echo "eslint still reports problems in $path after --fix:" >&2
  echo "$out" >&2
  exit 2
fi

exit 0
