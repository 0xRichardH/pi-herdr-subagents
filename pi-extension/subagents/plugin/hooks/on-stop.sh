#!/usr/bin/env bash
# Publish completion for Pi-spawned Claude sessions. Mode is set by the launcher,
# not inferred from the number or representation of historical user messages.
set -euo pipefail

if [ -z "${PI_CLAUDE_SENTINEL:-}" ]; then
  exit 0
fi

exec python3 "$(dirname "$0")/on-stop.py"
