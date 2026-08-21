# terminal-minceraft server

Host a public Eaglercraft multiplayer server on GCP so anyone can join from
terminal-minceraft or a browser.

## What you need

- A GCP account with billing enabled
- `gcloud` CLI installed

## Deploy

```bash
gcloud auth login
gcloud config set project <your-project-id>
cd server
bash deploy.sh
```

The script creates a VM, builds the Docker stack, and prints the join URL when
the server is ready. The whole thing takes about two minutes.

## Join

From terminal-minceraft: open Multiplayer, click Direct Connect, paste the
`ws://` URL the deploy script printed.

From a browser: open the `http://` URL in any browser. The Eaglercraft client
loads and connects.

## Voice chat

Voice chat is enabled. It uses WebRTC peer to peer, which means players who
turn it on can see each other's IP addresses. Players who leave voice off are
invisible to the voice layer. The setting is in the Eaglercraft options menu,
off by default.

## Security

The server runs in offline mode (every public Eaglercraft server does, because
browser clients cannot do Mojang authentication). Only the WebSocket port (5200)
is open. SSH, ICMP, and all other ports are firewalled. The VM runs with no
service account and no GCP API scopes.

The game runs inside a browser sandbox (chromium via terminal-browser, or any
browser). JavaScript cannot escape to the host OS. Your server controls the
client code it serves.

## Tear down

```bash
bash destroy.sh
```

Deletes the VM, network, firewall rule, and static IP. Billing stops
immediately.

## Configuration

Environment variables for deploy.sh:

| Variable | Default | What it sets |
|---|---|---|
| EAGLER_PROJECT | gcloud default | GCP project |
| EAGLER_REGION | us-west1 | Region |
| EAGLER_ZONE | us-west1-b | Zone |
| EAGLER_MACHINE_TYPE | e2-standard-4 | VM size (4 vCPU, 16GB for 50+ players) |

Server config lives in `config/server.properties`. The world seed, max players,
view distance, and game mode are all there.
