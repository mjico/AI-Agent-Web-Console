$ErrorActionPreference = "Continue"
$root = "D:\AI_Proj\webAI"
$start = Join-Path $root "start-console.ps1"

function Test-ConsolePort {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $wait = $client.BeginConnect("127.0.0.1", 3080, $null, $null)
    if (-not $wait.AsyncWaitHandle.WaitOne(400, $false)) {
      return $false
    }
    $client.EndConnect($wait)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

if (-not (Test-ConsolePort)) {
  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $start
  ) -WindowStyle Minimized | Out-Null
}

$cwd = (Get-Location).Path
if (-not (Test-Path -LiteralPath (Join-Path $cwd "bot\agent.ts"))) {
  exit 0
}

$healthy = $false
for ($i = 0; $i -lt 40; $i++) {
  try {
    $health = Invoke-RestMethod "http://127.0.0.1:3080/api/health" -TimeoutSec 2
    if ($health.ok) {
      $healthy = $true
      break
    }
  } catch {
    # 控制台还在启动
  }
  Start-Sleep -Milliseconds 500
}
if (-not $healthy) {
  Write-Host "网页服务还没就绪，继续启动 CLI。"
  exit 0
}

function Get-ProjectId([string]$name) {
  $id = $name.ToLowerInvariant() -replace "[^a-z0-9_-]", "-"
  $id = $id.Trim("-")
  if ($id -notmatch "^[a-z]") { $id = "agent-$id" }
  if ($id.Length -gt 64) { $id = $id.Substring(0, 64).Trim("-") }
  if ($id -notmatch "^[a-z][a-z0-9_-]{0,63}$") { $id = "agent" }
  return $id
}

try {
  $list = Invoke-RestMethod "http://127.0.0.1:3080/api/projects" -TimeoutSec 5
  $here = [IO.Path]::GetFullPath($cwd).TrimEnd("\")
  $existing = @($list.projects) | Where-Object {
    $_.projectDir -and ([IO.Path]::GetFullPath([string]$_.projectDir).TrimEnd("\") -eq $here)
  } | Select-Object -First 1
  if ($existing) {
    $targetId = $existing.id
  } else {
    $targetId = Get-ProjectId (Split-Path $cwd -Leaf)
    $taken = @($list.projects | ForEach-Object { $_.id })
    $base = $targetId
    $n = 2
    while ($taken -contains $targetId) {
      $suffix = "-$n"
      $room = 64 - $suffix.Length
      $targetId = $base.Substring(0, [Math]::Min($base.Length, $room)) + $suffix
      $n++
    }
    $body = @{ id = $targetId; name = (Split-Path $cwd -Leaf); projectDir = $here } | ConvertTo-Json -Compress
    Invoke-RestMethod "http://127.0.0.1:3080/api/projects" -Method Post -ContentType "application/json; charset=utf-8" -Body $body -TimeoutSec 20 | Out-Null
  }
  if ($list.activeId -ne $targetId) {
    $switch = @{ id = $targetId } | ConvertTo-Json -Compress
    Invoke-RestMethod "http://127.0.0.1:3080/api/project/switch" -Method Post -ContentType "application/json; charset=utf-8" -Body $switch -TimeoutSec 70 | Out-Null
  }
  Write-Host "WebAI  http://127.0.0.1:3080/  项目 $targetId"
} catch {
  Write-Host ("网页项目切换失败，继续启动 CLI：" + $_.Exception.Message)
}
exit 0
