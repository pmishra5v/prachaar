# Runs Prachaar on your own computer with the real Gemini model on Vertex AI,
# signed in as YOU (your `gcloud auth login`). Nothing is deployed to Google Cloud.
#
#   cd "$env:USERPROFILE\Desktop\prachaar-ai"
#   powershell -ExecutionPolicy Bypass -File .\start-local.ps1
#
# Options:
#   -Port 8085                         use a specific port (otherwise the first free one is picked)
#   -Model "gemini-2.5-flash"          main model (default gemini-3.8-flash)
#   -Fallback ""                       turn off the backup model
#   -NoAI                              run without AI (scripted demo mode only)
#   -Store firestore                   save to the real Firestore database instead of data\svas-main.json
#   -NoVoice                           start without the Sarvam voice key (mic falls back to the browser)
#   -ResetVoiceKey                     ask for the Sarvam API key again (e.g. after rotating it)
# Stop the app with Ctrl+C.
param(
  [int]$Port = 0,
  [string]$ProjectId = "personalproject-507904",
  [string]$Model = "gemini-3.8-flash",
  [string]$GeminiRegion = "",
  [string]$Fallback = "gemini-2.5-flash@asia-south1",
  [switch]$NoAI,
  [ValidateSet("file","firestore")][string]$Store = "file",
  [switch]$NoVoice,
  [switch]$ResetVoiceKey
)
Set-Location $PSScriptRoot

# ---- 1. Node.js ------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js is not installed. Installing Node.js LTS with winget..." -ForegroundColor Yellow
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  Write-Host "Done. Close this window, open a NEW PowerShell window and run start-local.ps1 again." -ForegroundColor Yellow
  exit 1
}
$major = [int]((node -v).TrimStart("v").Split(".")[0])
if ($major -lt 18) { Write-Host "Node.js $(node -v) is too old. Run: winget upgrade OpenJS.NodeJS.LTS" -ForegroundColor Red; exit 1 }
Write-Host "Node.js $(node -v) found." -ForegroundColor Green

# ---- 2. Ports ----------------------------------------------------------------
Write-Host ""
Write-Host "Ports already in use on this computer (3000-9999):" -ForegroundColor Cyan
$listening = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -ge 3000 -and $_.LocalPort -le 9999 } |
  Sort-Object LocalPort -Unique
if ($listening) {
  foreach ($c in $listening) {
    $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    Write-Host ("  {0,5}  {1}" -f $c.LocalPort, $(if ($proc) { $proc.ProcessName } else { "unknown" }))
  }
} else { Write-Host "  (none)" }

function Test-PortFree([int]$p) {
  if (Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) { return $false }
  try { $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $p); $l.Start(); $l.Stop(); return $true }
  catch { return $false }
}
if ($Port) {
  if (-not (Test-PortFree $Port)) { Write-Host "Port $Port is already in use. Pick another with -Port, or leave it out to auto-pick." -ForegroundColor Red; exit 1 }
} else {
  foreach ($p in 8080, 8081, 8085, 8088, 8090, 3000, 3001, 5050, 7070) { if (Test-PortFree $p) { $Port = $p; break } }
  if (-not $Port) { Write-Host "No free port found in the usual list. Use -Port <number>." -ForegroundColor Red; exit 1 }
}
Write-Host "Using port $Port." -ForegroundColor Green
Set-Content -Path ".local-port" -Value $Port -Encoding ascii

# ---- 3. Google login (for the AI) --------------------------------------------
if (-not $NoAI -or $Store -eq "firestore") {
  if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) { Write-Host "gcloud not found. Install the Google Cloud CLI or run with -NoAI." -ForegroundColor Red; exit 1 }
  $acct = (gcloud config get-value account 2>$null)
  if (-not $acct) { gcloud auth login }
  $tokenOk = (gcloud auth print-access-token 2>$null)
  if (-not $tokenOk) { Write-Host "Could not get a Google token. Run: gcloud auth login" -ForegroundColor Red; exit 1 }
  Write-Host "Signed in to Google as $(gcloud config get-value account 2>$null)." -ForegroundColor Green
}

# ---- 4. Voice key (Sarvam AI) ----------------------------------------------------
# Kept OUTSIDE the project folder so it is never uploaded or deployed with the code.
$keyDir  = Join-Path $env:USERPROFILE ".prachaar"
$keyFile = Join-Path $keyDir "sarvam.key"
$env:SARVAM_API_KEY = ""
if (-not $NoVoice) {
  if ($ResetVoiceKey -and (Test-Path $keyFile)) { Remove-Item $keyFile -Force }
  if (-not (Test-Path $keyFile)) {
    Write-Host ""
    Write-Host "Voice: paste your Sarvam API key (input is hidden). Press Enter to skip voice for now." -ForegroundColor Cyan
    $sec = Read-Host -AsSecureString "Sarvam API key"
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    if ($plain.Trim()) {
      New-Item -ItemType Directory -Force -Path $keyDir | Out-Null
      Set-Content -Path $keyFile -Value $plain.Trim() -NoNewline -Encoding ascii
      icacls $keyFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null   # only you can read it
      Write-Host "Saved to $keyFile (only your Windows account can read it)." -ForegroundColor Green
    }
    $plain = $null
  }
  if (Test-Path $keyFile) { $env:SARVAM_API_KEY = (Get-Content $keyFile -Raw).Trim(); Write-Host "Voice: Sarvam key loaded." -ForegroundColor Green }
  else { Write-Host "Voice: no Sarvam key - the mic will use the browser's basic speech recognition." -ForegroundColor Yellow }
}

# ---- 5. Start ----------------------------------------------------------------
$env:PORT = "$Port"
$env:HOST = "127.0.0.1"          # only reachable from this computer
$env:LOCAL = "1"
$env:GOOGLE_CLOUD_PROJECT = $ProjectId
$env:ANTHROPIC_API_KEY = ""
$env:USE_VERTEX = ""
$env:STORE = $Store
if ($NoAI) {
  $env:PROVIDER = "none"
} else {
  if (-not $GeminiRegion) { $GeminiRegion = if ($Model -like "gemini-3*") { "global" } else { "asia-south1" } }
  $env:PROVIDER = "gemini"
  $env:MODEL = $Model
  $env:GEMINI_REGION = $GeminiRegion
  $env:FALLBACK_MODEL = $Fallback
}
$url = "http://localhost:$Port"
Write-Host ""
Write-Host "Starting Prachaar at $url   (Ctrl+C to stop)" -ForegroundColor Cyan
Write-Host "To check the AI connection, open a second PowerShell here and run: .\test-local.ps1" -ForegroundColor Cyan
Write-Host "Every AI step and every save is logged below." -ForegroundColor Cyan
if ($Store -eq "file") { Write-Host "Campaigns and offers are saved in $PSScriptRoot\data\svas-main.json (Reset demo in the app clears them)." -ForegroundColor Cyan }
Write-Host ""
Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile -Command Start-Sleep 2; Start-Process '$url'"
node server.js
