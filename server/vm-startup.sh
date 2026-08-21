#!/usr/bin/env bash
set -e

# Install Docker if not present
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | bash
fi

# Install Docker Compose plugin if not present
if ! docker compose version >/dev/null 2>&1; then
  apt-get update && apt-get install -y docker-compose-plugin
fi

# Extract the server bundle from the base64 payload appended after this script
MARKER="__SERVER_BUNDLE__"
SCRIPT_PATH="$(readlink -f "$0")"
BUNDLE_START=$(grep -n "$MARKER" "$SCRIPT_PATH" | tail -1 | cut -d: -f1)

if [ -n "$BUNDLE_START" ]; then
  BUNDLE_START=$((BUNDLE_START + 1))
  mkdir -p /opt/eaglercraft
  tail -n "+$BUNDLE_START" "$SCRIPT_PATH" | base64 -d | tar xzf - -C /opt/eaglercraft
  cd /opt/eaglercraft
  docker compose up -d --build
fi

exit 0
__SERVER_BUNDLE__
