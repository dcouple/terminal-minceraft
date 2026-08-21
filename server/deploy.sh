#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

project="${EAGLER_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
region="${EAGLER_REGION:-us-west1}"
zone="${EAGLER_ZONE:-us-west1-b}"
machine_type="${EAGLER_MACHINE_TYPE:-e2-standard-4}"
instance="${EAGLER_INSTANCE:-terminal-minceraft-eaglercraft}"
network="${EAGLER_NETWORK:-terminal-minceraft-eaglercraft}"
subnet="${EAGLER_SUBNET:-terminal-minceraft-eaglercraft-us-west1}"
address_name="${EAGLER_ADDRESS:-terminal-minceraft-eaglercraft-ip}"
firewall_rule="${EAGLER_FIREWALL:-terminal-minceraft-eaglercraft-ws}"
network_tag="terminal-minceraft-eaglercraft"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required: https://cloud.google.com/sdk/docs/install" >&2
  exit 1
fi

active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1)"
if [[ -z "$active_account" ]]; then
  echo "No active gcloud login. Run: gcloud auth login" >&2
  exit 1
fi

if [[ -z "$project" || "$project" == "(unset)" ]]; then
  echo "No GCP project selected. Run: gcloud config set project <project-id>" >&2
  exit 1
fi

bundle_file="$(mktemp)"
cleanup() { rm -f "$bundle_file"; }
trap cleanup EXIT

cp "${script_dir}/vm-startup.sh" "$bundle_file"
tar -czf - \
  -C "$script_dir" \
  Dockerfile \
  docker-compose.yml \
  .dockerignore \
  docker \
  config \
  | base64 >> "$bundle_file"

echo "Deploying as ${active_account} to project ${project} (${zone})"

gcloud services enable compute.googleapis.com --project="$project"

if ! gcloud compute networks describe "$network" --project="$project" >/dev/null 2>&1; then
  gcloud compute networks create "$network" \
    --project="$project" --subnet-mode=custom --bgp-routing-mode=regional
fi

if ! gcloud compute networks subnets describe "$subnet" \
  --project="$project" --region="$region" >/dev/null 2>&1; then
  gcloud compute networks subnets create "$subnet" \
    --project="$project" --network="$network" --region="$region" \
    --range=10.42.0.0/24 --enable-private-ip-google-access=false
fi

if ! gcloud compute firewall-rules describe "$firewall_rule" \
  --project="$project" >/dev/null 2>&1; then
  gcloud compute firewall-rules create "$firewall_rule" \
    --project="$project" --network="$network" --direction=INGRESS \
    --priority=1000 --action=ALLOW --rules=tcp:5200 \
    --source-ranges=0.0.0.0/0 --target-tags="$network_tag" \
    --description="Public Eaglercraft WebSocket endpoint only"
fi

if ! gcloud compute addresses describe "$address_name" \
  --project="$project" --region="$region" >/dev/null 2>&1; then
  gcloud compute addresses create "$address_name" \
    --project="$project" --region="$region" --network-tier=PREMIUM
fi

external_ip="$(gcloud compute addresses describe "$address_name" \
  --project="$project" --region="$region" --format='value(address)')"

if gcloud compute instances describe "$instance" \
  --project="$project" --zone="$zone" >/dev/null 2>&1; then
  echo "Updating existing VM..."
  gcloud compute instances add-metadata "$instance" \
    --project="$project" --zone="$zone" \
    --metadata=block-project-ssh-keys=TRUE,enable-oslogin=FALSE,serial-port-enable=TRUE \
    --metadata-from-file=startup-script="$bundle_file"
  gcloud compute instances reset "$instance" --project="$project" --zone="$zone"
else
  gcloud compute instances create "$instance" \
    --project="$project" --zone="$zone" --machine-type="$machine_type" \
    --subnet="$subnet" --address="$external_ip" --network-tier=PREMIUM \
    --tags="$network_tag" --image-family=ubuntu-2404-lts-amd64 \
    --image-project=ubuntu-os-cloud --boot-disk-size=50GB \
    --boot-disk-type=pd-balanced --boot-disk-auto-delete \
    --no-service-account --no-scopes \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --metadata=block-project-ssh-keys=TRUE,enable-oslogin=FALSE,serial-port-enable=TRUE \
    --metadata-from-file=startup-script="$bundle_file"
fi

browser_url="http://${external_ip}:5200"
join_url="ws://${external_ip}:5200"

echo
echo "Waiting for the server to start..."
ready=false
for attempt in $(seq 1 60); do
  if curl --fail --silent --max-time 5 "$browser_url/" >/dev/null 2>&1; then
    ready=true; break
  fi
  if [ "$(( attempt % 6 ))" -eq 0 ]; then
    echo "Still starting (${attempt}0 seconds elapsed)..."
  fi
  sleep 10
done

echo
echo "Browser client: ${browser_url}"
echo "JOIN URL:       ${join_url}"
echo
if [[ "$ready" == true ]]; then
  echo "The endpoint is responding. Test both clients before tweeting."
else
  echo "The VM exists but the endpoint is not responding yet." >&2
  echo "Inspect: gcloud compute instances get-serial-port-output ${instance} --zone=${zone} --project=${project}" >&2
  exit 1
fi
