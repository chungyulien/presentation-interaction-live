$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if (Test-Path $bundledNode) {
  & $bundledNode (Join-Path $projectRoot "server\index.js")
  exit $LASTEXITCODE
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) {
  & $nodeCommand.Source (Join-Path $projectRoot "server\index.js")
  exit $LASTEXITCODE
}

Write-Error "找不到 Node.js。請先安裝 Node.js，或在 Codex 內建執行環境中啟動。"
