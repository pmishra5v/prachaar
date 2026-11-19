# Checks the locally running Prachar (start it first with start-local.ps1).
#   powershell -ExecutionPolicy Bypass -File .\test-local.ps1
param([int]$Port = 0)
Set-Location $PSScriptRoot
if (-not $Port) { $Port = [int](Get-Content ".local-port" -ErrorAction SilentlyContinue) }
if (-not $Port) { Write-Host "Start the app first with start-local.ps1" -ForegroundColor Red; exit 1 }
$base = "http://localhost:$Port"

Write-Host "1. App is running at $base ..." -NoNewline
try { $h = Invoke-RestMethod "$base/api/health" -TimeoutSec 5; Write-Host " OK" -ForegroundColor Green }
catch { Write-Host " FAILED - is start-local.ps1 still running?" -ForegroundColor Red; exit 1 }
Write-Host ("   AI: {0}  provider: {1}  model: {2}  backup: {3}" -f $h.ai, $h.provider, $h.model, $h.fallback)
if (-not $h.ai) { Write-Host "   AI is off (demo mode only)."; exit 0 }

Write-Host "2. Asking the AI model for a one-word reply ..." -NoNewline
try {
  $t = Invoke-RestMethod "$base/api/selftest" -TimeoutSec 120
  Write-Host (" OK in {0} ms" -f $t.ms) -ForegroundColor Green
  Write-Host ("   answered by: {0}   signed in via: {1}   project: {2}" -f $t.model, $t.auth, $t.project)
} catch {
  Write-Host " FAILED" -ForegroundColor Red
  try { $body = $_.ErrorDetails.Message | ConvertFrom-Json; Write-Host ("   " + ($body.reply | ConvertTo-Json -Depth 6 -Compress)) } catch { Write-Host "   $($_.Exception.Message)" }
  Write-Host "   Check the start-local window for the [gemini] line with the reason."
  exit 1
}
Write-Host ""
Write-Host "All good. Now test in the browser ($base):" -ForegroundColor Green
Write-Host "  - What should I promote this week?"
Write-Host "  - 20% off on Swift brake pads, send to garages on WhatsApp and Instagram"
Write-Host "      -> a DRAFT card must appear in the Campaigns panel; tap Approve & send"
Write-Host "  - 15% off Ape brake shoes for 10 days, WhatsApp to fleet owners in Telugu"
Write-Host "  - Boost the Swift brake pad offer on Instagram with Rs 300 a day for 5 days"
