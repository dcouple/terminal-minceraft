#!/usr/bin/env bash
# Build the EaglercraftX 1.8 client this wrapper runs, from source, here.
#
# The game is not in this repository and never will be. Instead the installer
# compiles it on your machine: lax1dude's own build tools decompile the
# Minecraft 1.8.8 jar (downloaded from Mojang's servers), apply the Eaglercraft
# patch files, compile that with TeaVM, and pack the result into one
# self-contained html file. EaglerForge's injector is run over the output so
# the agent support keeps working.
#
#   scripts/build-client.sh                  build into web/client.html
#   scripts/build-client.sh --to <path>      build somewhere else
#   scripts/build-client.sh --plain          skip the EaglerForge injection
#   scripts/build-client.sh --force          rebuild even if nothing changed
#
# Everything downloaded and built lands in a cache under ~/.cache, so a second
# install only redoes what changed. Nothing here is quick: count on ten to
# forty minutes and about six gigabytes of memory the first time.
#
# If you already have an EaglercraftX 1.8 offline client you would rather use:
#   terminal-minceraft --client /path/to/your/client.html
set -euo pipefail

# --- pins -------------------------------------------------------------------
# Every input is pinned to an exact commit or an exact sha256, so a build is
# reproducible and a mirror can only ever hand back the same bytes.
SOURCE_REPO="https://gitflic.ru/project/lax1dude/eaglercraft-1_8.git"
SOURCE_COMMIT="332a7bb11fe2f26e047eb43c87e7633b8d757b19"

MINECRAFT_JAR_URL="https://piston-data.mojang.com/v1/objects/0983f08be6a4e624f5d85689d1aca869ed99c738/client.jar"
MINECRAFT_JAR_SHA256="9481ed51d7fc4be54ec38c509f84124fbac5d9fea238bbde5b2e6c4f753b1ac8"

ASSETS_INDEX_URL="https://launchermeta.mojang.com/v1/packages/f6ad102bcaa53b1a58358f16e376d548d44933ec/1.8.json"
ASSETS_INDEX_SHA256="14e3aa58cf578fd8573985ca96bf075d8be05477be988664a09446c7a76f4142"

MCP_ZIP_URL="https://github.com/leijurv/MineBot/raw/refs/heads/master/mcp918.zip"
MCP_ZIP_SHA256="c936dffb3007110b24538da5f334c28ec83c6787a56cc4c63fd840cdff306eb0"

# EaglerForgeInjector is cloned rather than taken from npm because the
# published package does not ship one of its own dependencies.
EAGLERFORGE_REPO="https://github.com/EaglerForge/EaglerForgeInjector.git"
EAGLERFORGE_COMMIT="cee455d7ecad5f88e2a7c6dd9905d56835059e21"

MAVEN_CENTRAL="https://repo1.maven.org/maven2/"
OFFLINE_TEMPLATE="sources/setup/workspace_template/target_teavm_javascript/javascript/OfflineDownloadTemplate.txt"

CACHE="${TERMINAL_MINCERAFT_BUILD_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/terminal-minceraft}"
DEST=""
PLAIN=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --to) DEST="${2:?--to needs a path}"; shift 2 ;;
    --to=*) DEST="${1#*=}"; shift ;;
    --plain) PLAIN=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "build-client: unknown option $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -n "$DEST" ] || DEST="$ROOT/web/client.html"

STAMP="$DEST.stamp"
PIN="$(printf '%s\n%s\n%s\n%s\n%s\n%s' \
  "$SOURCE_COMMIT" "$MINECRAFT_JAR_SHA256" "$ASSETS_INDEX_SHA256" \
  "$MCP_ZIP_SHA256" "$EAGLERFORGE_COMMIT" "plain=$PLAIN" | sha256sum | cut -d' ' -f1)"

if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$PIN" ] && [ -f "$DEST" ] && [ "$FORCE" -eq 0 ]; then
  echo "  client already built: $DEST"
  exit 0
fi

# --- tools ------------------------------------------------------------------
need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "build-client: $1 is required to compile the client: $2" >&2; exit 1; }
}
need git "https://git-scm.com"
need ffmpeg "your package manager (apt install ffmpeg, brew install ffmpeg)"
need node "https://nodejs.org"
need npm "comes with node"

# TeaVM 0.9.2 cannot read the class files newer JVMs emit, so the build has
# to run on an older one. Java 17 is what upstream recommends and what this
# script is tested with. Point TERMINAL_MINCERAFT_JAVA at one if PATH has
# something newer.
JAVA_BIN="${TERMINAL_MINCERAFT_JAVA:-java}"
JVER="$("$JAVA_BIN" -version 2>&1 | head -n1 | sed 's/.*"\([0-9]*\)\..*/\1/')" || JVER=""
{ [ "${JVER:-0}" -ge 17 ] && [ "${JVER:-0}" -le 21 ]; } 2>/dev/null || {
  echo "build-client: java 17 is required to compile the client (found ${JVER:-none})" >&2
  echo "  apt install openjdk-17-jdk / brew install --cask temurin@17" >&2
  echo "  newer JVMs break the TeaVM compiler" >&2; exit 1; }

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1
  fi
}

fetch_pinned() {
  local url="$1" sha="$2" out="$3" bytes="$4" got
  if [ -f "$out" ] && [ "$(sha256_of "$out")" = "$sha" ]; then return 0; fi
  mkdir -p "$(dirname "$out")"
  curl -fL --retry 3 --retry-delay 2 --progress-bar "$url" -o "$out"
  got="$(sha256_of "$out")"
  if [ "$got" != "$sha" ]; then
    echo "build-client: $url did not match its pinned sha256" >&2
    echo "  expected $sha ($bytes bytes)" >&2
    echo "  got      $got ($(wc -c <"$out" | tr -d ' ') bytes)" >&2
    exit 1
  fi
}

# The heap the compiler needs for the decompile step. Three quarters of what
# the machine has, between two and eight gigabytes, unless told otherwise.
XMX="${TERMINAL_MINCERAFT_BUILD_XMX:-}"
if [ -z "$XMX" ]; then
  case "$(uname -s)" in
    Linux)  XMX="$(awk '/MemTotal/ { printf "%d", $2/1048576*0.75 }' /proc/meminfo)" ;;
    Darwin) XMX="$(echo $(( $(sysctl -n hw.memsize)/1073741824*3/4 )))" ;;
    *)      XMX=6 ;;
  esac
  [ "${XMX:-0}" -ge 8 ] && XMX=8
  [ "${XMX:-0}" -le 2 ] && XMX=2
fi

mkdir -p "$CACHE"
SRC="$CACHE/eaglercraft-1_8"
INPUTS="$CACHE/inputs"
OUT="$CACHE/out"
MVN="$CACHE/maven"

echo "  fetching the build inputs"

# The eaglercraft source tree: build tools, patch files, browser runtime.
# It deliberately contains no Minecraft code of its own.
if [ ! -d "$SRC/.git" ]; then
  rm -rf "$SRC"
  git clone -q --depth 1 "$SOURCE_REPO" "$SRC"
fi
if [ "$(git -C "$SRC" rev-parse HEAD)" != "$SOURCE_COMMIT" ]; then
  git -C "$SRC" fetch -q --unshallow origin 2>/dev/null || git -C "$SRC" fetch -q origin
  git -C "$SRC" checkout -q "$SOURCE_COMMIT"
fi

fetch_pinned "$MINECRAFT_JAR_URL" "$MINECRAFT_JAR_SHA256" "$INPUTS/client.jar" "8465313"
fetch_pinned "$ASSETS_INDEX_URL" "$ASSETS_INDEX_SHA256" "$INPUTS/1.8.json" "78494"
fetch_pinned "$MCP_ZIP_URL" "$MCP_ZIP_SHA256" "$INPUTS/mcp918.zip" "8429228"

CONFIG="$CACHE/config.json"
cat > "$CONFIG" <<EOF
{
  "repositoryFolder": "$SRC",
  "modCoderPack": "$INPUTS/mcp918.zip",
  "minecraftJar": "$INPUTS/client.jar",
  "assetsIndex": "$INPUTS/1.8.json",
  "outputDirectory": "$OUT",
  "temporaryDirectory": "$CACHE/tmp",
  "ffmpeg": "ffmpeg",
  "mavenURL": "$MAVEN_CENTRAL",
  "mavenLocal": "$MVN",
  "productionIndex": "$SRC/buildtools/production-index.html",
  "productionFavicon": "$SRC/buildtools/production-favicon.png",
  "generateOfflineDownload": true,
  "offlineDownloadTemplate": "$SRC/$OFFLINE_TEMPLATE",
  "minifying": false,
  "keepTemporaryFiles": false
}
EOF

echo "  compiling eaglercraftx 1.8 from source (this is the long part)"
echo "  progress: tail -f $CACHE/build.log"
if ! "$JAVA_BIN" -Xmx${XMX}G -cp "$SRC/buildtools/BuildTools.jar" \
    net.lax1dude.eaglercraft.v1_8.buildtools.gui.headless.CompileLatestClientHeadless \
    -y "$CONFIG" > "$CACHE/build.log" 2>&1; then
  echo "build-client: the compile failed, the log is at $CACHE/build.log" >&2
  tail -n 20 "$CACHE/build.log" >&2
  exit 1
fi

BUILT="$OUT/EaglercraftX_1.8_Offline_en_US.html"
[ -f "$BUILT" ] || { echo "build-client: the compile finished but produced no offline client" >&2; exit 1; }

mkdir -p "$(dirname "$DEST")"
if [ "$PLAIN" -eq 1 ]; then
  mv "$BUILT" "$DEST"
else
  echo "  injecting eaglerforge (needed for --agent)"
  EFI="$CACHE/eaglerforge-injector"
  if [ ! -d "$EFI/.git" ]; then
    rm -rf "$EFI"
    git clone -q --depth 1 "$EAGLERFORGE_REPO" "$EFI"
  fi
  [ "$(git -C "$EFI" rev-parse HEAD)" = "$EAGLERFORGE_COMMIT" ] || {
    echo "build-client: EaglerForgeInjector is not at its pinned commit, refusing to use it" >&2; exit 1; }
  (cd "$EFI" && npm ci --silent >> "$CACHE/build.log" 2>&1) || {
    echo "build-client: npm ci failed for the injector, see $CACHE/build.log" >&2; exit 1; }
  # The injector reads the whole client into memory and babel wants room,
  # hence the heap flag. Its output name has to end in .html or it silently
  # writes processed.html into the working directory instead.
  if ! NODE_OPTIONS="--max-old-space-size=16384" \
      node --max-old-space-size=16384 "$EFI/cli.js" "$BUILT" "$DEST.new.html" /eaglerforge \
      >> "$CACHE/build.log" 2>&1; then
    echo "build-client: eaglerforge injection failed, keeping the plain client" >&2
    tail -n 20 "$CACHE/build.log" >&2
    rm -f "$DEST.new.html"
    mv "$BUILT" "$DEST"
  fi
fi

if [ ! -f "$DEST" ]; then
  echo "build-client: no client ended up at $DEST" >&2
  exit 1
fi
echo "$PIN" > "$STAMP"
echo "  built $(du -h "$DEST" | cut -f1): $DEST"
