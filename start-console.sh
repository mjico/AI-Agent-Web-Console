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
  command -v node || true
}

NODE="$(find_node)"
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  echo "找不到 Node。请安装 node，或设置 WEB_AI_NODE。" >&2
  exit 1
fi
cd "$ROOT"
echo "WebAI 控制台启动中，监听 0.0.0.0:3080"
exec "$NODE" "$ROOT/console/server.mjs"
