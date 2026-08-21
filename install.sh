#!/usr/bin/env bash
# terminal-eaglercraft installer.
#
#   curl -fsSL https://raw.githubusercontent.com/dcouple/terminal-eaglercraft/main/install.sh | bash
#
# Pulls the wrapper out of the repo, installs terminal-browser if it is not
# already here, downloads the EaglercraftX client and checks its sha256, and
# drops a terminal-eaglercraft on your PATH.
set -euo pipefail

REPO="${TERMINAL_EAGLERCRAFT_REPO:-dcouple/terminal-eaglercraft}"
BRANCH="${TERMINAL_EAGLERCRAFT_BRANCH:-main}"
BIN_HOME="${XDG_BIN_HOME:-$HOME/.local/bin}"
APP="${TERMINAL_EAGLERCRAFT_INSTALL_ROOT:-$HOME/.local/lib/terminal-eaglercraft}"

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) echo "terminal-eaglercraft needs macOS or Linux (the kitty graphics protocol is thin on Windows)" >&2; exit 1 ;;
esac

for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || { echo "terminal-eaglercraft: $tool is required" >&2; exit 1; }
done

echo "terminal-eaglercraft"

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

echo "  downloading terminal-eaglercraft"
curl -fsSL --retry 3 --retry-delay 2 \
  "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" \
  | tar -xz -C "$TMP" --strip-components=1

[ -f "$TMP/bin/terminal-eaglercraft" ] || {
  echo "terminal-eaglercraft: the download is missing the wrapper" >&2; exit 1; }
chmod +x "$TMP/bin/terminal-eaglercraft" "$TMP/scripts/"*.sh "$TMP/scripts/"*.py 2>/dev/null || true

# --- the game ---------------------------------------------------------------
# The client is 74 MB and is not in the repo, so an upgrade reuses the copy that
# is already on disk rather than pulling it down again. fetch-client.sh checks
# the sha256 either way.
if [ -f "$APP/web/client.html" ]; then
  cp "$APP/web/client.html" "$TMP/web/client.html" 2>/dev/null || true
fi
"$TMP/scripts/fetch-client.sh" --to "$TMP/web/client.html"

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
ln -sf "$APP/bin/terminal-eaglercraft" "$BIN_HOME/terminal-eaglercraft"

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
    echo "  run: terminal-eaglercraft"
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
