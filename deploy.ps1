# Deploys the Prachaar AI CMO demo to Google Cloud Run (Mumbai, asia-south1).
# AI: Gemini 3.8 Flash on Vertex AI (global) by default, with Gemini 2.5 Flash in Mumbai as automatic backup.
#     Use -Provider claude for Claude Haiku 4.5 on Vertex AI (needs a quota increase on new projects).
# The app signs in to Vertex AI as the prachar-runtime service account.
#
# Run from PowerShell:
#   cd "$env:USERPROFILE\Desktop\prachaar-ai"
#   powershell -ExecutionPolicy Bypass -File .\deploy.ps1
#
# Optional:  -Provider claude          (switch to Claude on Vertex AI once your quota is approved)
#            -Model "gemini-3.8-flash"  (smarter; runs on Google's global endpoint, not only Mumbai)
#            -Model "gemini-2.5-flash-lite"   (cheapest) or another model ID for the chosen provider
param(
  [string]$ProjectId  = "personalproject-507904",
  [string]$Region     = "asia-south1",
  [ValidateSet("gemini","claude")][string]$Provider = "gemini",
  [string]$Model      = "",
  [string]$GeminiRegion = "",
  [switch]$UpdateVoiceKey
)
Set-Location $PSScriptRoot
if (-not (Test-Path "dataset\insite-demo.json")) { Write-Host "dataset\insite-demo.json is missing - the app has no store data without it." -ForegroundColor Red; exit 1 }
gcloud config set project $ProjectId | Out-Null

$Runtime = "prachar-runtime@$ProjectId.iam.gserviceaccount.com"
if (-not $Model) { $Model = if ($Provider -eq "gemini") { "gemini-3.8-flash" } else { "claude-haiku-4-5@20251001" } }
if ($Provider -eq "gemini") {
  # Gemini 2.5 runs in Mumbai; newer Gemini 3.x models are served from Google's global endpoint
  if (-not $GeminiRegion) { $GeminiRegion = if ($Model -like "gemini-3*") { "global" } else { "asia-south1" } }
  $envVars = "PROVIDER=gemini,GEMINI_REGION=$GeminiRegion,MODEL=$Model,GOOGLE_CLOUD_PROJECT=$ProjectId"
} else {
  $envVars = "PROVIDER=claude,USE_VERTEX=1,VERTEX_REGION=global,MODEL=$Model,GOOGLE_CLOUD_PROJECT=$ProjectId"
}
Write-Host "AI: $Provider ($Model$(if ($Provider -eq 'gemini') { ", $GeminiRegion" }))" -ForegroundColor Cyan

# ---- Storage: Firestore (Native mode) in Mumbai keeps campaigns and offers ----
Write-Host "Checking Firestore storage..." -ForegroundColor Cyan
gcloud services enable firestore.googleapis.com | Out-Null
gcloud firestore databases describe --database="(default)" --format="value(name)" 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Creating Firestore database in $Region (one time)..." -ForegroundColor Cyan
  gcloud firestore databases create --database="(default)" --location=$Region --type=firestore-native
  if ($LASTEXITCODE -ne 0) { Write-Host "Could not create Firestore - copy the error above and send it to Claude." -ForegroundColor Red; exit 1 }
}
gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$Runtime" --role="roles/datastore.user" --condition=None -q | Out-Null
$envVars += ",STORE=firestore"

# ---- Voice: the Sarvam key goes to Secret Manager (never into the image) ----
$secretArgs = @()
$keyFile = Join-Path $env:USERPROFILE ".prachaar\sarvam.key"
if (Test-Path $keyFile) {
  gcloud services enable secretmanager.googleapis.com | Out-Null
  gcloud secrets describe sarvam-api-key 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Storing the Sarvam key in Secret Manager (one time)..." -ForegroundColor Cyan
    gcloud secrets create sarvam-api-key --replication-policy=automatic --data-file="$keyFile" | Out-Null
  } elseif ($UpdateVoiceKey) {
    gcloud secrets versions add sarvam-api-key --data-file="$keyFile" | Out-Null
    Write-Host "Updated the Sarvam key in Secret Manager." -ForegroundColor Cyan
  }
  gcloud secrets add-iam-policy-binding sarvam-api-key --member="serviceAccount:$Runtime" --role="roles/secretmanager.secretAccessor" -q | Out-Null
  $secretArgs = @("--set-secrets", "SARVAM_API_KEY=sarvam-api-key:latest")
  Write-Host "Voice: Sarvam key will be used from Secret Manager." -ForegroundColor Green
} else {
  Write-Host "Voice: no Sarvam key found ($keyFile). Run start-local.ps1 once to add it; the mic will use the browser's basic recognition." -ForegroundColor Yellow
}

Write-Host "Building and deploying to $Region (first time takes 3-5 minutes)..." -ForegroundColor Cyan
gcloud run deploy prachar-ai-cmo `
  --source . `
  --region $Region `
  --service-account $Runtime `
  --allow-unauthenticated `
  --set-env-vars $envVars `
  --memory 256Mi --cpu 1 --min-instances 0 --max-instances 2 --concurrency 40 `
  @secretArgs `
  --quiet
if ($LASTEXITCODE -ne 0) { Write-Host "Deploy failed - copy the error above and send it to Claude." -ForegroundColor Red; exit 1 }

$url = gcloud run services describe prachar-ai-cmo --region $Region --format="value(status.url)"
Write-Host ""
try {
  $h = Invoke-RestMethod "$url/api/health" -TimeoutSec 30
  if ($h.parts -gt 0) { Write-Host "Check: live app has $($h.parts) parts (dataset $($h.datasetVersion)), AI on: $($h.ai), voice on: $($h.voice)" -ForegroundColor Green }
  else { Write-Host "Check FAILED: the live app has no store data. Send this to Claude." -ForegroundColor Red }
} catch { Write-Host "Could not reach $url/api/health to check the data: $($_.Exception.Message)" -ForegroundColor Yellow }
Write-Host "Public URL: $url" -ForegroundColor Green
