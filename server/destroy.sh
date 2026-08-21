#!/usr/bin/env bash
set -Eeuo pipefail

project="${EAGLER_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
region="${EAGLER_REGION:-us-west1}"
zone="${EAGLER_ZONE:-us-west1-b}"
instance="${EAGLER_INSTANCE:-terminal-minceraft-eaglercraft}"
network="${EAGLER_NETWORK:-terminal-minceraft-eaglercraft}"
subnet="${EAGLER_SUBNET:-terminal-minceraft-eaglercraft-us-west1}"
address_name="${EAGLER_ADDRESS:-terminal-minceraft-eaglercraft-ip}"
firewall_rule="${EAGLER_FIREWALL:-terminal-minceraft-eaglercraft-ws}"

echo "Tearing down Eaglercraft server in project ${project} (${zone})"
echo "This deletes the VM, network, firewall, and static IP."
read -r -p "Continue? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || exit 0

gcloud compute instances delete "$instance" --project="$project" --zone="$zone" --quiet 2>/dev/null && echo "VM deleted" || echo "VM not found"
gcloud compute firewall-rules delete "$firewall_rule" --project="$project" --quiet 2>/dev/null && echo "Firewall deleted" || echo "Firewall not found"
gcloud compute networks subnets delete "$subnet" --project="$project" --region="$region" --quiet 2>/dev/null && echo "Subnet deleted" || echo "Subnet not found"
gcloud compute addresses delete "$address_name" --project="$project" --region="$region" --quiet 2>/dev/null && echo "IP released" || echo "IP not found"
gcloud compute networks delete "$network" --project="$project" --quiet 2>/dev/null && echo "Network deleted" || echo "Network not found"

echo "Done. Billing stops immediately."
