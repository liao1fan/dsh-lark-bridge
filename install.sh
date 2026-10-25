#!/bin/bash
# ============================================================
# dsh-lark-bridge 一键安装脚本
# 用法：将 dsh-lark-bridge 包放到任意目录，运行 install.sh
# ============================================================
set -e

PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_NAME="dsh-lark-bridge"
BRIDGE_HOME="$HOME/.dsh/dsh-lark-bridge"

echo "╔════════════════════════════════════════════════════╗"
echo "║      dsh-lark-bridge 即插即用安装器                ║"
echo "╚════════════════════════════════════════════════════╝"
echo ""
echo "包目录: $PKG_DIR"
echo ""

# --------------------------------------------------
# 1. 环境检测
# --------------------------------------------------
echo "── [1/7] 环境检测 ──"

# 检查 node
if ! command -v node &>/dev/null; then
  echo "❌ 未找到 node，请先安装 Node.js >= 20"
  exit 1
fi
NODE_VER=$(node --version)
echo "  ✅ node $NODE_VER"

# 检查 dsh
if ! command -v dsh &>/dev/null; then
  echo "❌ 未找到 dsh，请先安装: npm i -g @deepseek-ai/dsh"
  exit 1
fi
DSH_BIN=$(readlink -f $(which dsh) 2>/dev/null || which dsh)
echo "  ✅ dsh: $DSH_BIN"

# 检查 lark-cli
if ! command -v lark-cli &>/dev/null; then
  echo "❌ 未找到 lark-cli"
  echo "  安装方式：npm i -g @lark-cli/lark-cli  或参照官方文档"
  exit 1
fi
LARK_VER=$(lark-cli --version 2>/dev/null | head -1)
echo "  ✅ lark-cli: $LARK_VER"

# 检查 lark-cli 认证
AUTH_JSON=$(lark-cli auth status --json 2>/dev/null)
AUTH_OK=$(echo "$AUTH_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); u=d.get('identities',{}).get('user',{}); print(u.get('status','') == 'ready' or 'needs_refresh' in u.get('status',''))" 2>/dev/null || echo "False")
if [ "$AUTH_OK" != "True" ]; then
  echo "  ⚠️  lark-cli 未认证或需要刷新"
  echo "  请先运行: lark-cli auth login --domain all"
  echo "  然后重新运行本脚本"
  exit 1
fi
APP_ID=$(echo "$AUTH_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('appId',''))" 2>/dev/null)
echo "  ✅ lark app: $APP_ID"

# 检查 flock（用于锁探测）
if ! command -v flock &>/dev/null; then
  echo "  ⚠️  flock 不可用，跨终端锁检测将退化"
fi

echo ""

# --------------------------------------------------
# 2. 安装目录 + Token
# --------------------------------------------------
echo "── [2/7] 部署文件 ──"

mkdir -p "$BRIDGE_HOME/bin" "$BRIDGE_HOME/config" "$BRIDGE_HOME/web-plugin/lib"

# 复制核心文件
cp "$PKG_DIR/bin/bridge.mjs" "$BRIDGE_HOME/bin/"
cp "$PKG_DIR/bin/start.sh" "$BRIDGE_HOME/bin/"
cp "$PKG_DIR/bin/watchdog-loop.sh" "$BRIDGE_HOME/bin/"
cp "$PKG_DIR/web-plugin/package.json" "$BRIDGE_HOME/web-plugin/"
cp "$PKG_DIR/web-plugin/cordis.patch.yml" "$BRIDGE_HOME/web-plugin/"
cp "$PKG_DIR/web-plugin/lib/index.js" "$BRIDGE_HOME/web-plugin/lib/"

chmod +x "$BRIDGE_HOME/bin/"*.sh

# 生成 token（每次安装重新生成）
if [ -f "$BRIDGE_HOME/config/web-control-token" ]; then
  echo "  ♻️  复用已有 token"
else
  openssl rand -hex 24 > "$BRIDGE_HOME/config/web-control-token"
  chmod 600 "$BRIDGE_HOME/config/web-control-token"
  echo "  ✅ 生成 web-control-token"
fi

# 复制 SKILL.md
if [ -f "$PKG_DIR/SKILL.md" ]; then
  cp "$PKG_DIR/SKILL.md" "$BRIDGE_HOME/"
  mkdir -p "$HOME/.agents/skills"
  ln -sf "$BRIDGE_HOME/SKILL.md" "$HOME/.agents/skills/dsh-lark-bridge.md" 2>/dev/null || true
  echo "  ✅ SKILL.md 已安装到 ~/.agents/skills/"
fi

echo "  ✅ 文件部署到 $BRIDGE_HOME"
echo ""

# --------------------------------------------------
# 3. 自动发现用户信息和聊天 ID
# --------------------------------------------------
echo "── [3/7] 自动发现用户信息 ──"

# 获取 open_id
USER_INFO=$(lark-cli api GET /open-apis/authen/v1/user_info --as user 2>/dev/null)
OPEN_ID=$(echo "$USER_INFO" | python3 -c "import json,sys; print(json.load(sys.stdin).get('data',{}).get('open_id',''))" 2>/dev/null)
USER_NAME=$(echo "$USER_INFO" | python3 -c "import json,sys; print(json.load(sys.stdin).get('data',{}).get('name',''))" 2>/dev/null)

if [ -z "$OPEN_ID" ]; then
  echo "  ❌ 无法获取 open_id，请检查 lark-cli 认证"
  exit 1
fi
echo "  ✅ 用户: $USER_NAME ($OPEN_ID)"

# 获取 bot 的 open_id
BOT_INFO=$(lark-cli api GET /open-apis/bot/v3/info --as bot 2>/dev/null)
BOT_OPEN_ID=$(echo "$BOT_INFO" | python3 -c "import json,sys; print(json.load(sys.stdin).get('data',{}).get('open_id',''))" 2>/dev/null)

# 获取 bot 与用户的 P2P chat_id
CHAT_ID=$(lark-cli im +messages-send --as bot --user-id "$OPEN_ID" --text "🔧 dsh-lark-bridge 安装测试" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('data',{}).get('chat_id',''))" 2>/dev/null)

if [ -z "$CHAT_ID" ]; then
  echo "  ⚠️  无法自动获取 chat_id（bot 可能无法主动发消息）"
  echo "  请手动与 bot 发一条消息后再重新运行"
  CHAT_ID="PENDING"
else
  echo "  ✅ 私聊 chat_id: $CHAT_ID"
fi

# 获取 dsh web 端口（探测）
WEB_PORT=3090
for p in 3090 3091 3092 3093 3094 3095; do
  if curl -s -m 1 "http://127.0.0.1:$p/" >/dev/null 2>&1; then
    WEB_PORT=$p
    break
  fi
done
echo "  ✅ dsh web 端口: $WEB_PORT (自动探测)"
echo ""

# --------------------------------------------------
# 4. 生成配置
# --------------------------------------------------
echo "── [4/7] 生成配置 ──"

CONFIG_FILE="$BRIDGE_HOME/config/bridge.config.json"

# 如果已有配置，保留 allowUsers 并更新
EXISTING_ALLOW_USERS=""
if [ -f "$CONFIG_FILE" ]; then
  EXISTING_ALLOW_USERS=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('allowUsers',[''])[0])" 2>/dev/null || echo "")
fi

if [ -n "$EXISTING_ALLOW_USERS" ] && [ "$EXISTING_ALLOW_USERS" != "$OPEN_ID" ]; then
  # 合并
  ALLOW_USERS=$(python3 -c "import json; l=json.load(open('$CONFIG_FILE')).get('allowUsers',[]); print(json.dumps(list(set(l + ['$OPEN_ID']))))")
else
  ALLOW_USERS="[\"$OPEN_ID\"]"
fi

cat > "$CONFIG_FILE" << CONFIGEOF
{
  "allowUsers": $ALLOW_USERS,
  "defaultCwd": "$HOME",
  "defaultModel": "${DSH_DEFAULT_MODEL:-}",
  "maxListItems": 20,
  "firstStatusDelayMs": 12000,
  "statusIntervalMs": 10000,
  "maxMessageChars": 9000,
  "recentWorkspaceCount": 8,
  "greetOnStart": true,
  "autoApprovePermissions": true,
  "testChats": [],
  "poll": { "enabled": true, "intervalMs": 3000, "chats": [$([ "$CHAT_ID" != "PENDING" ] && echo "\"$CHAT_ID\"" || echo "")] },
  "stream": { "enabled": true, "intervalMs": 2000, "maxCardChars": 20000 },
  "dashboard": { "intervalMs": 5000 },
  "watch": { "timeoutMs": 1800000 },
  "takeover": { "timeoutMs": 300000 },
  "idleReleaseMs": 600000,
  "stalledTurnMs": 120000,
  "webControl": { "url": "http://127.0.0.1:$WEB_PORT/bridge-control" }
}
CONFIGEOF

echo "  ✅ 配置生成: $CONFIG_FILE"
echo ""

# --------------------------------------------------
# 5. 安装 web 插件
# --------------------------------------------------
echo "── [5/7] 安装 web 插件 ──"

DSH_NPM_PREFIX=$(npm prefix -g 2>/dev/null || echo "")
WEB_PROFILE_DIR="$HOME/.dsh/profiles/web"

if [ -d "$WEB_PROFILE_DIR" ]; then
  # 链接插件
  ln -sfn "$BRIDGE_HOME/web-plugin" "$WEB_PROFILE_DIR/node_modules/dsh-bridge-control" 2>/dev/null || {
    mkdir -p "$WEB_PROFILE_DIR/node_modules"
    ln -sfn "$BRIDGE_HOME/web-plugin" "$WEB_PROFILE_DIR/node_modules/dsh-bridge-control"
  }

  # 添加到 bundle
  python3 - "$WEB_PROFILE_DIR/package.json" << 'PYEOF'
import json, sys, os
p = sys.argv[1]
d = json.load(open(p))
d.setdefault("dependencies", {})["dsh-bridge-control"] = f"file://{os.path.expanduser('~/.dsh/dsh-lark-bridge/web-plugin')}"
bundles = d.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
if "dsh-bridge-control" not in bundles:
    bundles.append("dsh-bridge-control")
json.dump(d, open(p, "w"), indent=2)
print("  ✅ web profile 已挂载 bridge-control 插件")
PYEOF
else
  echo "  ⚠️  web profile 不存在 ($WEB_PROFILE_DIR)"
  echo "  插件将在首次运行 dsh web 时自动加载"
fi

# 配置 ACP profile（模型路由）
# 不写死任何具体网关/模型：优先保留已有配置，其次读环境变量，都没有则跳过
ACP_PATCH="$HOME/.dsh/profiles/acp/cordis.patch.yml"
if [ -d "$HOME/.dsh/profiles/acp" ]; then
  EXIST_PROVIDER=""; EXIST_MODEL=""
  if [ -f "$ACP_PATCH" ]; then
    EXIST_PROVIDER=$(sed -n 's/^[[:space:]]*provider:[[:space:]]*\([^[:space:]#]*\).*/\1/p' "$ACP_PATCH" | head -1 | tr -d '"')
    EXIST_MODEL=$(sed -n 's/^[[:space:]]*model:[[:space:]]*\([^[:space:]#]*\).*/\1/p' "$ACP_PATCH" | head -1 | tr -d '"')
  fi
  ACP_PROVIDER="${DSH_ACP_PROVIDER:-$EXIST_PROVIDER}"
  ACP_MODEL="${DSH_ACP_MODEL:-$EXIST_MODEL}"
  if [ -n "$ACP_PROVIDER" ] && [ -n "$ACP_MODEL" ]; then
    cat > "$ACP_PATCH" << ACPEOF
# Route the ACP profile's sessions to the configured gateway
- id: acp
  config:
    provider: $ACP_PROVIDER
    model: $ACP_MODEL
    sessionListPageSize: 100
ACPEOF
    echo "  ✅ ACP profile 模型路由：$ACP_PROVIDER / $ACP_MODEL"
  else
    echo "  ℹ️  未指定 ACP 模型路由，跳过（需要时：DSH_ACP_PROVIDER=<provider> DSH_ACP_MODEL=<model> bash install.sh）"
  fi
fi

echo ""

# --------------------------------------------------
# 6. 注册飞书斜杠命令
# --------------------------------------------------
echo "── [6/7] 注册飞书斜杠命令 ──"

register_cmd() {
  local cmd=$1 desc=$2
  lark-cli application +slash-command-create --command "$cmd" --description "$desc" --description-i18n "zh_cn=$desc" 2>/dev/null | grep -o '"ok": true' > /dev/null && echo "  ✅ /$cmd" || echo "  ⚠️  /$cmd (可能已存在)"
}

register_cmd "help" "查看全部命令说明"
register_cmd "new" "新建会话（可带路径参数）"
register_cmd "sessions" "按工作区浏览会话"
register_cmd "list" "会话平铺列表"
register_cmd "use" "切换会话（序号或id前缀）"
register_cmd "stop" "中断当前正在执行的任务"
register_cmd "status" "查看当前会话状态"
register_cmd "model" "模型设置（卡片）"
register_cmd "effort" "思考深度 low|high|max|default"
register_cmd "watch" "直播正在运行的任务"
register_cmd "history" "查看会话最近对话记录"
register_cmd "export" "导出会话记录为飞书文档"
register_cmd "panel" "发送最新面板卡片"
register_cmd "cancel-takeover" "取消等待中的锁接管"

echo ""

# --------------------------------------------------
# 7. 启动服务
# --------------------------------------------------
echo "── [7/7] 启动服务 ──"

# 停止旧实例
pkill -f "node.*bridge[.]mjs" 2>/dev/null || true
pkill -f "watchdog-loop[.]sh" 2>/dev/null || true
sleep 1

# 启动 bridge
bash "$BRIDGE_HOME/bin/start.sh"
sleep 3

# 启动 watchdog
setsid nohup bash "$BRIDGE_HOME/bin/watchdog-loop.sh" > /dev/null 2>&1 &
sleep 2

# 验证
BRIDGE_PID=$(pgrep -f "node.*bridge[.]mjs" | head -1)
if [ -n "$BRIDGE_PID" ]; then
  echo "  ✅ bridge 运行中 (pid $BRIDGE_PID)"
else
  echo "  ❌ bridge 启动失败，查看日志: $BRIDGE_HOME/config/bridge.log"
  exit 1
fi

WATCHDOG_PID=$(pgrep -f "watchdog-loop[.]sh" | head -1)
if [ -n "$WATCHDOG_PID" ]; then
  echo "  ✅ watchdog 运行中 (pid $WATCHDOG_PID)"
fi

echo ""
echo "╔════════════════════════════════════════════════════╗"
echo "║  ✅ 安装完成！                                     ║"
echo "╠════════════════════════════════════════════════════╣"
echo "║  飞书里直接发消息即可指挥 dsh 会话。              ║"
echo "║  发 /help 查看全部命令。                          ║"
echo "║                                                    ║"
echo "║  管理命令：                                       ║"
echo "║  • 重启: bash $BRIDGE_HOME/bin/start.sh      ║"
echo "║  • 状态: tail -5 $BRIDGE_HOME/config/bridge.log ║"
echo "║  • 卸载: bash $PKG_DIR/uninstall.sh              ║"
echo "╚════════════════════════════════════════════════════╝"
