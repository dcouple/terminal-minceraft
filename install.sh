#!/usr/bin/env bash
# terminal-minceraft installer.
#
#   curl -fsSL https://raw.githubusercontent.com/dcouple/terminal-minceraft/main/install.sh | bash
#
# Pulls the wrapper out of the repo, installs terminal-browser if it is not
# already here, then compiles the EaglercraftX 1.8 client from source: the
# Minecraft 1.8.8 jar comes down from Mojang's own servers, lax1dude's build
# tools decompile and patch it, and EaglerForge is injected into the result.
# The first install takes a while; after that the cache makes it quick.
set -euo pipefail

REPO="${TERMINAL_MINCERAFT_REPO:-dcouple/terminal-minceraft}"
BRANCH="${TERMINAL_MINCERAFT_BRANCH:-main}"
BIN_HOME="${XDG_BIN_HOME:-$HOME/.local/bin}"
APP="${TERMINAL_MINCERAFT_INSTALL_ROOT:-$HOME/.local/lib/terminal-minceraft}"

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) echo "terminal-minceraft needs macOS or Linux (the kitty graphics protocol is thin on Windows)" >&2; exit 1 ;;
esac

for tool in curl tar git ffmpeg java node npm; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "terminal-minceraft: $tool is required to build the client" >&2
    case "$tool" in
      git)   echo "  https://git-scm.com" ;;
      ffmpeg) echo "  apt install ffmpeg / brew install ffmpeg" ;;
      java)  echo "  apt install openjdk-17-jdk / brew install --cask temurin@17 (java 17, not newer)" ;;
      node|npm) echo "  https://nodejs.org" ;;
    esac
    exit 1; }
done

# The client compile runs on TeaVM, which cannot read the class files that
# JVMs newer than Java 21 emit.
JVER="$(java -version 2>&1 | head -n1 | sed 's/.*"\([0-9]*\)\..*/\1/')"
if [ "${JVER:-0}" -lt 17 ] 2>/dev/null || [ "${JVER:-0}" -gt 21 ] 2>/dev/null; then
  echo "terminal-minceraft: java 17 is required to build the client (found ${JVER:-none})" >&2
  echo "  install openjdk-17 and put it first on your PATH, or point" >&2
  echo "  TERMINAL_MINCERAFT_JAVA at it, then run this again" >&2
  exit 1
fi

echo "terminal-minceraft"

# --- terminal-browser -------------------------------------------------------
# It does the actual work of putting chromium pixels in the terminal, so it is
# not optional. Installing it also gets us a javascript runtime for free.
if ! command -v terminal-browser >/dev/null 2>&1 && [ ! -x "$BIN_HOME/terminal-browser" ]; then
  echo "  installing terminal-browser first"
  curl -fsSL https://terminal-browser.sh/install | bash
fi

# --- the wrapper ------------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "  downloading terminal-minceraft"
curl -fsSL --retry 3 --retry-delay 2 \
  "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" \
  | tar -xz -C "$TMP" --strip-components=1

[ -f "$TMP/bin/terminal-minceraft" ] || {
  echo "terminal-minceraft: the download is missing the wrapper" >&2; exit 1; }
chmod +x "$TMP/bin/terminal-minceraft" "$TMP/scripts/"*.sh "$TMP/scripts/"*.py 2>/dev/null || true

# --- the game ---------------------------------------------------------------
# Not in the repo, not a download either: compiled here from lax1dude's source
# at a pinned commit, from the official 1.8.8 jar, every time something changed.
# The cache under ~/.cache keeps an unchanged rebuild to seconds.
"$TMP/scripts/build-client.sh" --to "$TMP/web/client.html"

# Unpack beside the target and rename over it, so a failed install never leaves
# half a tree behind.
mkdir -p "$(dirname "$APP")"
rm -rf "$APP.new" "$APP.old"
mv "$TMP" "$APP.new"
trap - EXIT
[ -d "$APP" ] && mv "$APP" "$APP.old"
mv "$APP.new" "$APP"
rm -rf "$APP.old"

mkdir -p "$BIN_HOME"
ln -sf "$APP/bin/terminal-minceraft" "$BIN_HOME/terminal-minceraft"

echo "  installed to $APP"

# --- terminal check ---------------------------------------------------------
# Only terminals that speak the kitty graphics protocol can show the game.
case "${TERM_PROGRAM:-}${TERM:-}" in
  *ghostty*|*kitty*|*WezTerm*|*wezterm*|*cmux*|*vscode*) ;;
  *)
    echo
    echo "  note: this terminal may not support the kitty graphics protocol."
    echo "  ghostty, kitty, WezTerm, cmux and VS Code's terminal all do."
    echo "  macOS:  brew install --cask ghostty"
    ;;
esac

case ":$PATH:" in
  *":$BIN_HOME:"*)
    echo
    echo "  run: terminal-minceraft"
    ;;
  *)
    echo
    echo "  add $BIN_HOME to your PATH:"
    case "${SHELL:-}" in
      */zsh)  echo "    echo 'export PATH=\"$BIN_HOME:\$PATH\"' >> ~/.zshrc && exec zsh" ;;
      */bash) echo "    echo 'export PATH=\"$BIN_HOME:\$PATH\"' >> ~/.bashrc && exec bash" ;;
      *)      echo "    export PATH=\"$BIN_HOME:\$PATH\"" ;;
    esac
    ;;
esac
