#!/usr/bin/env bash
set -u
BIN="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$BIN/.." && pwd)"

find_node() {
  if [[ -n "${WEB_AI_NODE:-}" && -x "${WEB_AI_NODE}" ]]; then
    printf "%s" "$WEB_AI_NODE"
    return
  fi
  if [[ -f "$ROOT/.tools/node-home.txt" ]]; then
    local home
    home="$(tr -d '\r\n' < "$ROOT/.tools/node-home.txt")"
    if [[ -x "$home/bin/node" ]]; then printf "%s" "$home/bin/node"; return; fi
    if [[ -x "$home/node" ]]; then printf "%s" "$home/node"; return; fi
  fi
  local found=""
  found="$(command -v node || true)"
  if [[ -n "$found" && -x "$found" ]]; then printf "%s" "$found"; return; fi
  local agent_bin="${1:-}"
  if [[ -n "$agent_bin" ]]; then
    local agent_dir
    agent_dir="$(dirname "$(readlink -f "$agent_bin" 2>/dev/null || printf "%s" "$agent_bin")")"
    if [[ -x "$agent_dir/node" ]]; then printf "%s" "$agent_dir/node"; return; fi
  fi
  local versions="$HOME/.local/share/cursor-agent/versions"
  if [[ -d "$versions" ]]; then
    local newest=""
    newest="$(find "$versions" -mindepth 2 -maxdepth 2 -type f -name node -executable 2>/dev/null | sort | tail -n 1)"
    if [[ -n "$newest" ]]; then printf "%s" "$newest"; return; fi
  fi
}

find_agent() {
  if [[ -n "${CURSOR_AGENT_BIN:-}" && -e "${CURSOR_AGENT_BIN}" ]]; then
    printf "%s" "$CURSOR_AGENT_BIN"
    return
  fi
  local candidate
  for candidate in "$HOME/.local/bin/agent" "$HOME/.local/bin/cursor-agent" "$HOME/.local/share/cursor-agent/agent"; do
    if [[ -e "$candidate" ]]; then printf "%s" "$candidate"; return; fi
  done
  command -v agent || true
}

port_open() {
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 3080 >/dev/null 2>&1
    return
  fi
  (echo >/dev/tcp/127.0.0.1/3080) >/dev/null 2>&1
}

REAL="$(find_agent)"
NODE="$(find_node "$REAL")"
if [[ -z "$REAL" || ! -e "$REAL" ]]; then
  echo "Cursor CLI not found. Set CURSOR_AGENT_BIN or install ~/.local/bin/agent" >&2
  exit 1
fi
if [[ "$REAL" -ef "$BIN/cursor-web" ]]; then
  echo "CURSOR_AGENT_BIN points at the WebAI wrapper. Set it to the real Cursor agent." >&2
  exit 1
fi

if ! port_open; then
  if [[ -z "$NODE" || ! -x "$NODE" ]]; then
    echo "网页服务还没就绪，并且找不到 Node。" >&2
  else
    nohup "$ROOT/start-console.sh" >/tmp/webai-console.log 2>&1 &
  fi
fi

cwd="$(pwd)"
continue_flag=0
resume_id=""
rest=()
args=("$@")
i=0
while [[ $i -lt ${#args[@]} ]]; do
  a="${args[$i]}"
  case "$a" in
    --continue) continue_flag=1 ;;
    --resume)
      i=$((i + 1))
      resume_id="${args[$i]:-}"
      ;;
    --resume=*) resume_id="${a#--resume=}" ;;
    --force|--trust|--yolo) ;;
    *) rest+=("$a") ;;
  esac
  i=$((i + 1))
done

mode="plain"
id=""
uuid='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
if [[ "$resume_id" =~ $uuid ]]; then
  mode="resume"
  id="$resume_id"
elif [[ $continue_flag -eq 1 && -n "$NODE" ]]; then
  id="$("$NODE" - "$ROOT" "$cwd" "$HOME" <<'NODE'
const fs = require("fs");
const path = require("path");
const [root, cwd, home] = process.argv.slice(2);
function norm(value) {
  try { return path.resolve(value).replace(/[\\/]+$/, ""); } catch { return ""; }
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function projectKey(value) {
  return String(value).replace(/:/g, "").replace(/[\\/_]/g, "-");
}
function hasTranscript(chatId) {
  return fs.existsSync(path.join(home, ".cursor", "projects", projectKey(cwd), "agent-transcripts", chatId));
}
const here = norm(cwd);
const saved = readJson(path.join(root, "console", "last-by-cwd.json"));
const savedRows = Array.isArray(saved) ? saved : saved ? [saved] : [];
const savedHit = savedRows.find((row) => row && norm(row.cwd) === here && row.chatId);
if (savedHit) {
  process.stdout.write(String(savedHit.chatId));
  process.exit(0);
}
const sessions = readJson(path.join(root, "console", "cli-sessions.json"));
const chats = Array.isArray(sessions && sessions.chats) ? sessions.chats : [];
let best = "";
let bestTime = 0;
for (const row of chats) {
  if (!row || norm(row.cwd) !== here || !row.chatId) continue;
  const time = Date.parse(row.updatedAt || "") || 0;
  if (!best || time >= bestTime) {
    best = String(row.chatId);
    bestTime = time;
  }
}
if (best) {
  process.stdout.write(best);
  process.exit(0);
}
const chatsRoot = path.join(home, ".cursor", "chats");
let cursorBest = "";
let cursorTime = -1;
function walk(dir) {
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of names) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (entry.name !== "meta.json") continue;
    const chatId = path.basename(path.dirname(full));
    if (!/^[0-9a-fA-F-]{36}$/.test(chatId) || !hasTranscript(chatId)) continue;
    const meta = readJson(full);
    if (!meta || norm(meta.cwd) !== here) continue;
    const updated = Number(meta.updatedAtMs || meta.createdAtMs || 0);
    if (updated >= cursorTime) {
      cursorTime = updated;
      cursorBest = chatId;
    }
  }
}
walk(chatsRoot);
if (cursorBest) process.stdout.write(cursorBest);
NODE
)"
  if [[ "$id" =~ $uuid ]]; then
    mode="resume"
  else
    id=""
    echo "没有找到这条目录可继续的会话，网页不会附着；CLI 会按 --continue 自己处理。" >&2
    echo "当前目录：$cwd" >&2
  fi
elif [[ $continue_flag -eq 0 ]]; then
  created="$("$REAL" create-chat 2>&1 || true)"
  id="$(printf '%s\n' "$created" | grep -Eo "$uuid" | head -n 1 || true)"
  if [[ -n "$id" ]]; then
    mode="resume"
  else
    echo "无法创建会话，继续启动 CLI。" >&2
  fi
else
  echo "没有找到这条目录可继续的会话，网页不会附着；CLI 会按 --continue 自己处理。" >&2
fi

launch="${WEB_AI_LAUNCH:-${TMPDIR:-/tmp}/webai-launch-$$.txt}"
if [[ "$mode" == "resume" && -n "$id" && -z "$NODE" ]]; then
  echo "找不到 Node，网页不会附着这次会话。可设置 WEB_AI_NODE。" >&2
fi
if [[ "$mode" == "resume" && -n "$id" && -n "$NODE" ]]; then
  "$NODE" - "$ROOT" "$cwd" "$id" <<'NODE' || true
const fs = require("fs");
const path = require("path");
const [root, rawCwd, chatId] = process.argv.slice(2);
const cwd = path.resolve(rawCwd);
const file = path.join(root, "console", "last-by-cwd.json");
let rows = [];
try { rows = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
if (!Array.isArray(rows)) rows = rows ? [rows] : [];
const next = [{ cwd, chatId }, ...rows.filter((row) => {
  if (!row || !row.chatId || !row.cwd) return false;
  try { return path.resolve(row.cwd) !== cwd; } catch { return false; }
})];
fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
NODE
  ready=0
  for _ in $(seq 1 40); do
    if "$NODE" -e 'fetch("http://127.0.0.1:3080/api/state").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.5
  done
  url="http://127.0.0.1:3080/?chat=$id"
  if [[ $ready -eq 1 ]]; then
    if "$NODE" - "$id" "$cwd" <<'NODE'
const [id, cwd] = process.argv.slice(2);
fetch("http://127.0.0.1:3080/api/attach", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chatId: id, cwd }),
}).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1));
NODE
    then
      echo "WebAI  $url"
      echo "工作目录  $cwd"
      if command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 || true; fi
    else
      echo "网页附着失败，继续启动 CLI。" >&2
      echo "WebAI  $url"
    fi
  else
    echo "网页服务还没就绪，继续启动 CLI。" >&2
    echo "WebAI  $url"
  fi
fi

printf 'mode=%s\nid=%s\n' "$mode" "$id" > "$launch"
if [[ ${#rest[@]} -gt 0 ]]; then
  printf '%s\0' "${rest[@]}" > "$launch.rest"
else
  : > "$launch.rest"
fi
