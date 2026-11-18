#!/usr/bin/env bash
set -eu
ROOT="$(cd "$(dirname "$0")" && pwd)"

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
  local versions="$HOME/.local/share/cursor-agent/versions"
  if [[ -d "$versions" ]]; then
    local newest=""
    newest="$(find "$versions" -mindepth 2 -maxdepth 2 -type f -name node -executable 2>/dev/null | sort | tail -n 1)"
    if [[ -n "$newest" ]]; then printf "%s" "$newest"; return; fi
  fi
}

NODE="$(find_node)"
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  echo "找不到 Node。请安装 node，或设置 WEB_AI_NODE。" >&2
  exit 1
fi
cd "$ROOT"
echo "WebAI 控制台启动中，监听 0.0.0.0:3080"
exec "$NODE" "$ROOT/console/server.mjs"
