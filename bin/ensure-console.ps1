$ErrorActionPreference = "Continue"
$root = "D:\AI_Proj\webAI"
$bin = Split-Path -Parent $MyInvocation.MyCommand.Path
$start = Join-Path $root "start-console.ps1"
$launchToken = ""
$passed = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $args.Count; $i++) {
  $token = [string]$args[$i]
  if ($token -eq "-LaunchToken" -and ($i + 1) -lt $args.Count) {
    $launchToken = [string]$args[$i + 1]
    $i++
    continue
  }
  $passed.Add($token)
}
if ($launchToken -match "^[A-Za-z0-9]+$") {
  $launchFile = Join-Path $env:TEMP "webai-launch-$launchToken.txt"
} else {
  $launchFile = Join-Path $bin "last-launch.txt"
}

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

function Wait-Console {
  for ($i = 0; $i -lt 40; $i++) {
    try {
      Invoke-RestMethod "http://127.0.0.1:3080/api/state" -TimeoutSec 2 | Out-Null
      return $true
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  return $false
}

function Get-ResumeId([string[]]$tokens) {
  for ($i = 0; $i -lt $tokens.Count; $i++) {
    $token = [string]$tokens[$i]
    if ($token -eq "--resume" -and ($i + 1) -lt $tokens.Count) { return [string]$tokens[$i + 1] }
    if ($token -like "--resume=*") { return $token.Substring(9) }
  }
  return $null
}

$cwdIndex = Join-Path $root "console\last-by-cwd.json"

$sessionIndex = Join-Path $root "console\cli-sessions.json"

function Resolve-Dir([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) { return $null }
  try {
    return [IO.Path]::GetFullPath($path).TrimEnd("\")
  } catch {
    return $null
  }
}

function Read-JsonFile([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try {
    return ([IO.File]::ReadAllText($path) | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Get-SavedChatId([string]$cwd) {
  $data = Read-JsonFile $cwdIndex
  if ($null -eq $data) { return $null }
  $rows = @($data)
  $here = Resolve-Dir $cwd
  if (-not $here) { return $null }
  foreach ($row in $rows) {
    $chatCwd = Resolve-Dir ([string]$row.cwd)
    if ($chatCwd -and $chatCwd -eq $here -and $row.chatId) { return [string]$row.chatId }
  }
  return $null
}

function Get-ConsoleChatId([string]$cwd) {
  $data = Read-JsonFile $sessionIndex
  if ($null -eq $data -or -not $data.chats) { return $null }
  $here = Resolve-Dir $cwd
  if (-not $here) { return $null }
  $best = $null
  $bestTime = [datetime]::MinValue
  foreach ($row in @($data.chats)) {
    $chatCwd = Resolve-Dir ([string]$row.cwd)
    if (-not $chatCwd -or $chatCwd -ne $here -or -not $row.chatId) { continue }
    $updated = [datetime]::MinValue
    if ($row.updatedAt) { [datetime]::TryParse([string]$row.updatedAt, [ref]$updated) | Out-Null }
    if ($updated -ge $bestTime) {
      $bestTime = $updated
      $best = [string]$row.chatId
    }
  }
  return $best
}

function Get-CursorChatId([string]$cwd) {
  $chatsRoot = Join-Path $env:USERPROFILE ".cursor\chats"
  if (-not (Test-Path -LiteralPath $chatsRoot)) { return $null }
  $here = Resolve-Dir $cwd
  if (-not $here) { return $null }
  $projectKey = (($cwd -replace ":", "") -replace "[\\/_]", "-")
  $transcriptRoot = Join-Path $env:USERPROFILE ".cursor\projects\$projectKey\agent-transcripts"
  $best = $null
  $bestTime = [int64]-1
  Get-ChildItem -LiteralPath $chatsRoot -Recurse -Filter meta.json -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $meta = [IO.File]::ReadAllText($_.FullName) | ConvertFrom-Json
      $chatCwd = Resolve-Dir ([string]$meta.cwd)
      if (-not $chatCwd -or $chatCwd -ne $here) { return }
      if ($_.Directory.Name -notmatch "^[0-9a-fA-F-]{36}$") { return }
      if (-not (Test-Path -LiteralPath (Join-Path $transcriptRoot $_.Directory.Name))) { return }
      $updated = 0L
      if ($null -ne $meta.updatedAtMs) { $updated = [int64]$meta.updatedAtMs }
      elseif ($null -ne $meta.createdAtMs) { $updated = [int64]$meta.createdAtMs }
      if ($updated -ge $bestTime) {
        $bestTime = $updated
        $best = $_.Directory.Name
      }
    } catch {
    }
  }
  return $best
}

function Save-ChatId([string]$cwd, [string]$chatId) {
  $here = Resolve-Dir $cwd
  if (-not $here -or [string]::IsNullOrWhiteSpace($chatId)) { return }
  $data = Read-JsonFile $cwdIndex
  $rows = @()
  if ($null -ne $data) { $rows = @($data) }
  $kept = New-Object System.Collections.Generic.List[object]
  $kept.Add(@{ cwd = $here; chatId = [string]$chatId }) | Out-Null
  foreach ($row in $rows) {
    $chatCwd = Resolve-Dir ([string]$row.cwd)
    if (-not $chatCwd -or $chatCwd -eq $here -or -not $row.chatId) { continue }
    $kept.Add(@{ cwd = $chatCwd; chatId = [string]$row.chatId }) | Out-Null
  }
  $json = ConvertTo-Json -InputObject @($kept.ToArray())
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [IO.File]::WriteAllText($cwdIndex, $json + "`n", $utf8)
}

$tokens = @($passed)
$hasContinue = $tokens -contains "--continue"
$resumeId = Get-ResumeId $tokens
$cwd = (Get-Location).Path
$mode = "plain"
$id = ""

if ($resumeId -match "^[0-9a-fA-F]{8}-") {
  $mode = "resume"
  $id = $resumeId
} elseif ($hasContinue) {
  $found = Get-SavedChatId $cwd
  if (-not $found) { $found = Get-ConsoleChatId $cwd }
  if (-not $found) { $found = Get-CursorChatId $cwd }
  if ($found) {
    $mode = "resume"
    $id = $found
  } else {
    Write-Host "没有找到这条目录可继续的会话，网页不会附着；CLI 会按 --continue 自己处理。"
    Write-Host ("当前目录：" + $cwd)
  }
} else {
  $real = Join-Path $env:LOCALAPPDATA "cursor-agent\agent.cmd"
  $created = (& $real create-chat 2>&1 | Out-String).Trim()
  $match = [regex]::Match($created, "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
  if ($match.Success) {
    $mode = "resume"
    $id = $match.Value
  } else {
    Write-Host "无法创建会话，继续启动 CLI。"
  }
}

if ($mode -eq "resume") {
  Save-ChatId $cwd $id
  $url = "http://127.0.0.1:3080/?chat=$id"
  if (Wait-Console) {
    try {
      $body = @{ chatId = $id; cwd = $cwd } | ConvertTo-Json -Compress
      Invoke-RestMethod "http://127.0.0.1:3080/api/attach" -Method Post -ContentType "application/json; charset=utf-8" -Body $body -TimeoutSec 10 | Out-Null
      Write-Host "WebAI  $url"
      Write-Host ("工作目录  " + $cwd)
      Start-Process $url | Out-Null
    } catch {
      Write-Host ("网页附着失败，继续启动 CLI：" + $_.Exception.Message)
      Write-Host "WebAI  $url"
    }
  } else {
    Write-Host "网页服务还没就绪，继续启动 CLI。"
    Write-Host "WebAI  $url"
  }
}

@(
  "mode=$mode"
  "id=$id"
) | Set-Content -LiteralPath $launchFile -Encoding ascii
exit 0
