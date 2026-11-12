$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeHome = (Get-Content (Join-Path $root ".tools\node-home.txt") -Raw).Trim()
$node = Join-Path $nodeHome "node.exe"
if (-not (Test-Path $node)) {
  Write-Error "找不到 Node：$node"
  exit 1
}
$env:Path = "$nodeHome;$env:Path"
Set-Location $root
Write-Host "WebAI 控制台  http://127.0.0.1:3080/"
& $node (Join-Path $root "console\server.mjs")
