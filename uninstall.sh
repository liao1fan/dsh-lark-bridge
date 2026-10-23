#!/bin/bash
# dsh-lark-bridge 卸载脚本
set -e
PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_HOME="$HOME/.dsh/dsh-lark-bridge"

echo "── 停止服务 ──"
pkill -f "node.*bridge[.]mjs" 2>/dev/null || true
pkill -f "watchdog-loop[.]sh" 2>/dev/null || true
sleep 1
echo "  ✅ 已停止"

echo "── 移除 web 插件挂载 ──"
WEB_PROFILE="$HOME/.dsh/profiles/web"
if [ -f "$WEB_PROFILE/package.json" ]; then
  python3 - "$WEB_PROFILE/package.json" << 'PYEOF'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d.get("dependencies", {}).pop("dsh-bridge-control", None)
bundles = d.get("dsh", {}).get("profile", {}).get("bundles", [])
if "dsh-bridge-control" in bundles:
    bundles.remove("dsh-bridge-control")
json.dump(d, open(p, "w"), indent=2)
print("  ✅ 已从 web profile 移除")
PYEOF
fi
rm -f "$WEB_PROFILE/node_modules/dsh-bridge-control" 2>/dev/null || true

echo "── 移除 SKILL ──"
rm -f "$HOME/.agents/skills/dsh-lark-bridge.md" 2>/dev/null || true

echo "── 删除安装目录 ──"
rm -rf "$BRIDGE_HOME"
echo "  ✅ 已删除 $BRIDGE_HOME"

echo ""
echo "✅ 卸载完成。飞书斜杠命令仍保留（可通过开发者后台清理）。"
