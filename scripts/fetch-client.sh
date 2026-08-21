#!/usr/bin/env bash
# Fetch the EaglercraftX client this wrapper runs.
#
# The game is not in this repository and never will be. It is one self-contained
# html file, pinned here to an exact commit and an exact sha256, downloaded on
# your machine at install time.
#
#   scripts/fetch-client.sh                 download it to web/client.html
#   scripts/fetch-client.sh --to <path>     download it somewhere else
#   scripts/fetch-client.sh --print-sha     print the sha256 it expects
#
# If you already have an EaglercraftX 1.8 offline client, you do not need this:
#   terminal-eaglercraft --client /path/to/your/client.html
set -euo pipefail

# EaglercraftX 1.8 (build dated 2024-11-18) with EaglerForge's mod loader
# injected. The EaglerForge build is used because the plain offline builds of
# EaglercraftX 1.8 in the archive are multiplayer only, and this one keeps the
# integrated server, so singleplayer and shared worlds both work.
CLIENT_SHA256="b5f129d8da5356dc32da4630f4af5759b76ea4a61d0272255af879ff9363721e"
CLIENT_BYTES="77252064"
CLIENT_COMMIT="1516a36afafea3011ede90bd42157fe4a9f94e42"
CLIENT_PATH="processed.html"
CLIENT_REPO="Eaglercraft-Archive/injected-eaglerforge"

# Two hosts, one file. The sha256 is what decides whether a download is the
# right one, so a mirror is only ever a second chance at reaching the same bytes.
URLS=(
  "https://raw.githubusercontent.com/$CLIENT_REPO/$CLIENT_COMMIT/$CLIENT_PATH"
  "https://github.com/$CLIENT_REPO/raw/$CLIENT_COMMIT/$CLIENT_PATH"
)

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/web/client.html"

while [ $# -gt 0 ]; do
  case "$1" in
    --to) DEST="${2:?--to needs a path}"; shift 2 ;;
    --to=*) DEST="${1#*=}"; shift ;;
    --print-sha) echo "$CLIENT_SHA256"; exit 0 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "fetch-client: unknown option $1" >&2; exit 2 ;;
  esac
done

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else echo "fetch-client: no shasum or sha256sum on this machine" >&2; exit 1
  fi
}

if [ -f "$DEST" ] && [ "$(sha256_of "$DEST")" = "$CLIENT_SHA256" ]; then
  echo "  client already here: $DEST"
  exit 0
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

for url in "${URLS[@]}"; do
  echo "  downloading the eaglercraft client (74 MB)"
  if curl -fL --retry 2 --retry-delay 2 --progress-bar "$url" -o "$TMP"; then
    got="$(sha256_of "$TMP")"
    if [ "$got" = "$CLIENT_SHA256" ]; then
      mkdir -p "$(dirname "$DEST")"
      mv "$TMP" "$DEST"
      trap - EXIT
      echo "  verified sha256 $CLIENT_SHA256"
      echo "  installed to $DEST"
      exit 0
    fi
    echo "  that download is not the pinned client" >&2
    echo "    expected $CLIENT_SHA256 ($CLIENT_BYTES bytes)" >&2
    echo "    got      $got ($(wc -c <"$TMP" | tr -d ' ') bytes)" >&2
  fi
done

cat >&2 <<EOF

terminal-eaglercraft: could not get the client.

The archive it comes from has been taken down before, and may be again. If that
has happened, find an EaglercraftX 1.8 offline client with singleplayer in it
and point the game at your own copy:

  terminal-eaglercraft --client /path/to/your/client.html

EOF
exit 1
