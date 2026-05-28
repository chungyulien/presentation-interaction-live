$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$toolsDir = Join-Path $env:LOCALAPPDATA "CodexTools\cloudflared"
$cloudflared = Join-Path $toolsDir "cloudflared.exe"
$logsDir = Join-Path $projectRoot ".cloudflared"
$serverLog = Join-Path $logsDir "server.log"
$serverErrorLog = Join-Path $logsDir "server-error.log"
$tunnelLog = Join-Path $logsDir "tunnel.log"
$tunnelErrorLog = Join-Path $logsDir "tunnel-error.log"
$nodePath = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$serverPath = Join-Path $projectRoot "server\index.js"

New-Item -ItemType Directory -Force -Path $toolsDir, $logsDir | Out-Null
foreach ($logPath in @($serverLog, $serverErrorLog, $tunnelLog, $tunnelErrorLog)) {
  if (Test-Path $logPath) {
    Remove-Item -LiteralPath $logPath -Force
  }
}

if (!(Test-Path $cloudflared)) {
  $downloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
  Invoke-WebRequest -Uri $downloadUrl -OutFile $cloudflared
}

if (!(Test-Path $nodePath)) {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if (!$nodeCommand) {
    throw "Node.js was not found. Please install Node.js or run inside the bundled Codex runtime."
  }
  $nodePath = $nodeCommand.Source
}

try {
  Invoke-RestMethod "http://localhost:4000/api/health" -TimeoutSec 2 | Out-Null
} catch {
  Start-Process -FilePath $nodePath -ArgumentList "`"$serverPath`"" -WorkingDirectory $projectRoot -RedirectStandardOutput $serverLog -RedirectStandardError $serverErrorLog -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 2
}

Start-Process -FilePath $cloudflared -ArgumentList @("tunnel", "--url", "http://localhost:4000") -WorkingDirectory $projectRoot -RedirectStandardOutput $tunnelLog -RedirectStandardError $tunnelErrorLog -WindowStyle Hidden | Out-Null

$publicUrl = $null
for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
  Start-Sleep -Seconds 1
  if (Test-Path $tunnelLog) {
    $logText = (Get-Content -Raw $tunnelLog) + "`n" + (Get-Content -Raw $tunnelErrorLog -ErrorAction SilentlyContinue)
    $match = [regex]::Match($logText, "https://[a-zA-Z0-9-]+\.trycloudflare\.com")
    if ($match.Success) {
      $publicUrl = $match.Value
      break
    }
  }
}

if (!$publicUrl) {
  throw "Could not create a public preview URL. Check $tunnelLog."
}

Write-Host ""
Write-Host "Temporary public URL: $publicUrl"
Write-Host "Presenter URL: $publicUrl"
Write-Host "Audience: create a room first, then scan the QR Code or enter the PIN."
Write-Host ""
Write-Host "Note: this Cloudflare Quick Tunnel URL is temporary and stops working if this computer or the background tunnel stops."
