# WA Box: set up and start a local copy (Windows PowerShell). Safe to run again.
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
# Optional, before running:  $env:ADMIN_USER="you@example.com"; $env:ORG_NAME="Acme"; $env:GROUP_KEYWORDS="Cohort,Batch"
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

function Say($m)  { Write-Host "> $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host "x $m" -ForegroundColor Red; exit 1 }

# 1. Docker
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'Docker is not installed. Install Docker Desktop: https://docs.docker.com/desktop/install/windows-install/' }
docker compose version *> $null; if ($LASTEXITCODE -ne 0) { Fail 'Docker Compose v2 is missing. Update Docker Desktop.' }
docker info *> $null; if ($LASTEXITCODE -ne 0) { Fail 'Docker Desktop is not running. Open it, wait for "Engine running", and run this again.' }

# 2. .env with fresh secrets (never overwrites an existing one)
if (-not (Test-Path .env)) {
  Say 'Making .env with a fresh engine key'
  $bytes = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $key = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  $port = if ($env:PORT) { $env:PORT } else { '3000' }
  $admin = if ($env:ADMIN_USER) { $env:ADMIN_USER } else { 'admin' }
  (Get-Content .env.example) `
    -replace '^WA_ENGINE_KEY=.*', "WA_ENGINE_KEY=$key" `
    -replace '^ADMIN_USER=.*', "ADMIN_USER=$admin" `
    -replace '^ORG_NAME=.*', "ORG_NAME=$($env:ORG_NAME)" `
    -replace '^GROUP_KEYWORDS=.*', "GROUP_KEYWORDS=$($env:GROUP_KEYWORDS)" `
    -replace '^PORT=.*', "PORT=$port" | Set-Content -Encoding ascii .env
} else { Say 'Using the existing .env' }
$PORT = ((Select-String -Path .env -Pattern '^PORT=(.*)').Matches.Groups[1].Value); if (-not $PORT) { $PORT = '3000' }

# 3. Build (runs the safety tests) and start
Say 'Building and starting. The first time takes 3-10 minutes (it downloads Chrome for the WhatsApp engine).'
docker compose -f docker-compose.local.yml up -d --build
if ($LASTEXITCODE -ne 0) { Fail 'The build failed. Scroll up for the reason.' }

# 4. Wait until it answers
Say "Waiting for WA Box to answer on http://localhost:$PORT"
$ok = $false
for ($i = 0; $i -lt 90; $i++) {
  try { Invoke-WebRequest -UseBasicParsing "http://localhost:$PORT/healthz" -TimeoutSec 2 | Out-Null; $ok = $true; break } catch { Start-Sleep 2 }
}
if (-not $ok) { Fail "WA Box didn't start in 3 minutes. See: docker compose -f docker-compose.local.yml logs wabox" }

$user = ((Select-String -Path .env -Pattern '^ADMIN_USER=(.*)').Matches.Groups[1].Value)
$line = docker compose -f docker-compose.local.yml logs wabox 2>$null | Select-String 'One-time password: (.*)' | Select-Object -Last 1
Write-Host ''
Write-Host 'WA Box is running' -ForegroundColor Green
Write-Host "  Open:      http://localhost:$PORT"
Write-Host "  Username:  $user"
if ($line) { Write-Host "  Password:  $($line.Matches.Groups[1].Value.Trim())   (one-time; you'll choose your own after signing in)" }
else { Write-Host '  Password:  the ADMIN_PASSWORD in .env, or the one you already chose' }
Write-Host ''
Write-Host '  It starts in practice mode: nothing reaches WhatsApp until you press "Go live".'
Write-Host '  Next: WhatsApp & groups -> scan the QR code with WhatsApp on your phone (Linked devices).'
Write-Host '  Stop: docker compose -f docker-compose.local.yml down    (your data stays)'
