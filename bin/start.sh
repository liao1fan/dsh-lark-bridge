#!/bin/bash
# dsh-lark-bridge 启动/重启脚本（可移植，自动发现路径）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PKG_ROOT"
pkill -f "node.*bin/bridge" 2>/dev/null
sleep 1
mkdir -p config
setsid nohup node bin/bridge.mjs >> config/bridge.log 2>&1 < /dev/null &
echo "bridge pid: $! (root: $PKG_ROOT)"
