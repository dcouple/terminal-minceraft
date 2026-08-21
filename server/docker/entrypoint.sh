#!/usr/bin/env bash
set -e

cd /srv/eaglercraft

# Download Paper 1.8.8 if not present
if [ ! -f server.jar ]; then
  echo "Downloading Paper 1.8.8..."
  curl -fsSL -o server.jar \
    "https://api.papermc.io/v2/projects/paper/versions/1.8.8/builds/445/downloads/paper-1.8.8-445.jar"
fi

# Download BungeeCord if not present
if [ ! -f bungee.jar ]; then
  echo "Downloading BungeeCord..."
  curl -fsSL -o bungee.jar \
    "https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar"
fi

# Download EaglercraftXBungee if not present
if [ ! -d bungee/plugins ]; then
  mkdir -p bungee/plugins
  echo "Downloading EaglercraftXBungee..."
  curl -fsSL -o bungee/plugins/EaglercraftXBungee.jar \
    "https://github.com/aspect-group/EaglercraftXBungeeReborn/releases/download/v1.3.1/EaglercraftXBungee-Reborn.jar" || \
  echo "EaglercraftXBungee download failed. You may need to provide the plugin manually."
fi

# Accept EULA
echo "eula=true" > eula.txt

# Start the game server in the background
echo "Starting Paper 1.8.8 server..."
bash server-run.sh &
SERVER_PID=$!

# Wait for the game server to start
echo "Waiting for game server to be ready..."
for i in $(seq 1 60); do
  if curl -s localhost:25565 >/dev/null 2>&1 || [ -f "world/level.dat" ]; then
    break
  fi
  sleep 2
done
sleep 5

# Start BungeeCord with Eaglercraft
echo "Starting BungeeCord + Eaglercraft proxy..."
cd bungee
cp /srv/eaglercraft/bungee/config.yml config.yml 2>/dev/null || true
bash /srv/eaglercraft/bungee-run.sh &
BUNGEE_PID=$!

# Wait for either to exit
wait -n $SERVER_PID $BUNGEE_PID
