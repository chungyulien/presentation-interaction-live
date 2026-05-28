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

New-Item -ItemType Directory -Force -Path $toolsDir, $logsDir | Out-Null

if (!(Test-Path $cloudflared)) {
  $downloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
  Invoke-WebRequest -Uri $downloadUrl -OutFile $cloudflared
}

if (!(Test-Path $nodePath)) {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if (!$nodeCommand) {
    throw "找不到 Node.js。請先安裝 Node.js，或在 Codex 內建執行環境中啟動。"
  }
  $nodePath = $nodeCommand.Source
}

try {
  Invoke-RestMethod "http://localhost:4000/api/health" -TimeoutSec 2 | Out-Null
} catch {
  Start-Process -FilePath $nodePath -ArgumentList @((Join-Path $projectRoot "server\index.js")) -WorkingDirectory $projectRoot -RedirectStandardOutput $serverLog -RedirectStandardError $serverErrorLog -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 2
}

if (Test-Path $tunnelLog) {
  Remove-Item -LiteralPath $tunnelLog -Force
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
  throw "公開網址建立失敗，請查看 $tunnelLog。"
}

Write-Host ""
Write-Host "臨時公開網址：$publicUrl"
Write-Host "講者端：$publicUrl"
Write-Host "觀眾端：請先在講者端建立房間，再掃描 QR Code 或輸入 PIN。"
Write-Host ""
Write-Host "注意：這是 Cloudflare Quick Tunnel 臨時網址，關閉電腦或停止背景程式後就會失效。"
