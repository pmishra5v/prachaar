#!/usr/bin/env bash
# Deploys Prachar AI CMO to Google Cloud Run (Mumbai region) and prints the public URL.
# Run in Google Cloud Shell from inside this folder:  bash deploy.sh
set -euo pipefail

SERVICE="prachar-ai-cmo"
REGION="${REGION:-asia-south1}"          # Mumbai
SECRET="anthropic-api-key"

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
if [[ -z "${PROJECT_ID}" ]]; then
  read -rp "Google Cloud project ID: " PROJECT_ID
fi
gcloud config set project "${PROJECT_ID}" >/dev/null
echo "Project: ${PROJECT_ID}   Region: ${REGION}"

echo "Enabling Cloud Run, Cloud Build, Artifact Registry and Secret Manager (first run takes a minute)…"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com

if ! gcloud secrets describe "${SECRET}" >/dev/null 2>&1; then
  read -rsp "Paste your Anthropic API key (input hidden): " KEY; echo
  printf '%s' "${KEY}" | gcloud secrets create "${SECRET}" --replication-policy=automatic --data-file=-
  unset KEY
else
  echo "Secret ${SECRET} already exists — reusing it. (To change the key: gcloud secrets versions add ${SECRET} --data-file=-)"
fi

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
RUN_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud secrets add-iam-policy-binding "${SECRET}" \
  --member="serviceAccount:${RUN_SA}" --role="roles/secretmanager.secretAccessor" >/dev/null

EXTRA_ENV=""
if [[ -n "${ACCESS_CODE:-}" ]]; then EXTRA_ENV="--set-env-vars=ACCESS_CODE=${ACCESS_CODE}"; fi

echo "Building and deploying…"
gcloud run deploy "${SERVICE}" \
  --source . \
  --region "${REGION}" \
  --allow-unauthenticated \
  --set-secrets "ANTHROPIC_API_KEY=${SECRET}:latest" \
  --set-env-vars "MODEL=${MODEL:-claude-haiku-4-5}" \
  ${EXTRA_ENV} \
  --memory 256Mi --cpu 1 --min-instances 0 --max-instances 2 --concurrency 40 \
  --quiet

URL="$(gcloud run services describe "${SERVICE}" --region "${REGION}" --format='value(status.url)')"
echo
echo "Done. Public URL: ${URL}"
