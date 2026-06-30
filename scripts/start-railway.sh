#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="${RAILWAY_VOLUME_MOUNT_PATH:-/data}"
CONFIG_PATH="${CONFIG_PATH:-$CONFIG_DIR/config.yaml}"
STORAGE_MODE="${NANOLLM_STORAGE:-sqlite}"
MAX_OLD_SPACE_SIZE="${NANOLLM_MAX_OLD_SPACE_SIZE:-700}"

mkdir -p "$(dirname "$CONFIG_PATH")"

if [ ! -f "$CONFIG_PATH" ]; then
  if [ -z "${NANOLLM_AUTH_TOKEN:-}" ]; then
    echo "Missing NANOLLM_AUTH_TOKEN. Set it in Railway Variables before the first start." >&2
    exit 1
  fi

  cat > "$CONFIG_PATH" <<EOF
server:
  auth:
    token: ${NANOLLM_AUTH_TOKEN}

models: []
fallback: {}
EOF

  echo "Initialized nanollm config at $CONFIG_PATH"
fi

HOME="$CONFIG_DIR" node --max-old-space-size="$MAX_OLD_SPACE_SIZE" dist/server.js --config "$CONFIG_PATH" --storage "$STORAGE_MODE"
