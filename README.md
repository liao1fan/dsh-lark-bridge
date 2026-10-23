# dsh-lark-bridge

deepseek harness 连接飞书，可以通过飞书聊天的方式连接到 PC 端的 deepseek harness 会话。

在飞书里发一条消息，就等于在你的电脑上给 dsh 会话下任务；任务执行过程以流式卡片实时回放，跑完之后可以继续追问、切换会话、换模型、导出记录。

```
飞书用户 ⇄ (lark-cli WebSocket 事件 + 轮询兜底) ⇄ bridge 守护进程 ⇄ (ACP stdio) dsh --profile acp
                                                        ⇄ (HTTP 回环 + token) dsh web 内嵌插件（中继）
```

## 特性

- **发消息即任务**：直接聊天，不需要命令；流式卡片打字机式实时回显
- **多工作区 / 多会话**：卡片选择工作目录建会话；按工作区浏览历史会话并一键切换
- **双端互通**：桥接读写 `~/.dsh/sessions/`，与 dsh Web GUI 共用同一份会话记录
- **跨终端监控**：Web 侧正在跑的任务，飞书里可以 `/watch` 直播，也能看到它的工具调用和进度
- **Web 中继**：被 dsh Web 独占写锁的会话，飞书不必等锁——桥接通过 Web 进程内置插件代写
- **图文文件**：上传图片/文件后发文字，自动作为附件随任务提交
- **卡片控制台**：`/panel` 发出控制台 + 会话浏览卡片（不置顶，随聊天流滚动）
- **模型与思考深度**：`/model` 卡片切换模型，`/effort` 调思考深度
- **导出**：`/export` 把整段会话记录写成飞书云文档
- **自愈**：watchdog 每 30 秒检查，bridge 崩溃自动拉起

## 快速开始

```bash
# 1. 前置：dsh、lark-cli、Node >= 20 已就绪
npm i -g @deepseek-ai/dsh
# lark-cli 安装并完成一次认证：lark-cli auth login --domain all

# 2. 把本包放到任意目录，一键安装
git clone https://github.com/liao1fan/dsh-lark-bridge.git
bash dsh-lark-bridge/install.sh
```

安装脚本 7 步全自动：

1. 环境检测（node / dsh / lark-cli / 认证状态）
2. 部署文件到 `~/.dsh/dsh-lark-bridge/`
3. 生成 web 控制 token
4. 自动发现你的 `open_id` 与私聊 `chat_id`
5. 生成 `config/bridge.config.json`
6. 挂载 dsh web 插件（`~/.dsh/profiles/web`）+ 写入 ACP profile patch
7. 注册飞书斜杠命令，启动 bridge 与 watchdog

装完在飞书里给自己的 bot 发一条 `/help` 即可。

## 飞书里的命令

| 命令 | 说明 |
|---|---|
| `/help` | 全部命令说明 |
| `/new [路径]` | 新建会话；不带路径时弹出工作区选择卡片 |
| `/sessions` | 按工作区浏览会话：选目录 → 看该目录下会话 → 点切换 |
| `/list` | 会话平铺列表 |
| `/use <序号\|id前缀>` | 切换会话 |
| `/stop` | 中断当前正在执行的任务 |
| `/status` | 当前会话 / 工作区 / 忙碌状态 |
| `/model` | 模型设置卡片 |
| `/effort <low\|high\|max\|default>` | 思考深度 |
| `/watch` | 直播正在运行的任务 |
| `/history [序号\|id前缀] [轮数]` | 查看会话最近对话 |
| `/export [序号\|id前缀]` | 导出会话记录为飞书文档 |
| `/panel` | 重新发送控制台 / 会话卡片 |
| `/cancel-takeover` | 取消等待中的锁接管 |
| `/ws` | 工作区管理 |

也可以完全不用命令：直接发消息就是给当前会话下任务。

## 配置

首次安装会生成 `~/.dsh/dsh-lark-bridge/config/bridge.config.json`（含个人 ID，已列入 `.gitignore`）。参考 `config/bridge.config.example.json`。

| 字段 | 说明 |
|---|---|
| `allowUsers` | 允许使用的飞书 `open_id` 白名单，其他用户消息一律忽略 |
| `defaultCwd` | 新建会话的默认工作目录 |
| `testChats` | 测试群 `chat_id`，用于隔离自测 |
| `poll.chats` | 事件流之外的轮询兜底群/私聊（bot 在群里默认只收 @ 消息） |
| `stream.intervalMs` | 流式卡片刷新间隔 |
| `dashboard.intervalMs` | 面板刷新间隔 |
| `idleReleaseMs` | 空闲多久释放会话写锁 |
| `stalledTurnMs` | 判定任务卡死的阈值 |
| `webControl.url` | dsh web 的内置中继端点（默认自动探测 3090–3099） |

运行时会自动发现 dsh 安装路径与 `~/.dsh` 数据目录，也可以用环境变量覆盖：`DSH_ROOT`（`@deepseek-ai/dsh` 包路径）、`DSH_HOME`（dsh 数据目录）。

安装脚本不会写死任何模型网关：ACP profile 里已有的 `provider`/`model` 会原样保留；需要指定时用 `DSH_ACP_PROVIDER`、`DSH_ACP_MODEL` 环境变量，两者都没有则跳过这一步。

## 工作原理

- **ACP 连接**：`dsh --profile acp` 走 JSON-RPC over stdio；桥接使用 `session/new|list|resume|prompt|cancel|set_config_option`
- **会话读写**：直接读取 `~/.dsh/sessions/<container>/<id>/session.v3.jsonl.zstd`（只读打开，不抢写锁）
- **单写者锁**：同一会话同一时间只允许一个前端写入；锁由 dsh 进程持有，桥接通过探测 `session.lock` 判断归属
- **Web 中继**：桥接挂载的 web 插件暴露 `/bridge-control`（仅回环 + token 鉴权），由持有锁的 web 进程代为 `prompt`
- **流式卡片**：Card 2.0 streaming 模式 + cardkit 文本元素增量更新；超过 10 分钟自动重开流式，避免 `300309`

## 管理

```bash
bash ~/.dsh/dsh-lark-bridge/bin/start.sh                  # 重启 bridge
tail -20 ~/.dsh/dsh-lark-bridge/config/bridge.log         # 看日志
pkill -f "node.*bridge[.]mjs"; pkill -f "watchdog-loop"   # 全部停止
bash dsh-lark-bridge/uninstall.sh                         # 卸载
```

## 故障排查

| 症状 | 排查 |
|---|---|
| 发消息没反应 | `tail bridge.log` 是否收到事件；`lark-cli auth status` 是否过期 |
| 提示会话被占用 | Web 正在持有该会话，桥接会尝试中继，或锁释放后自动切换 |
| 卡片报 11310 | 飞书卡片元素超限，用 `/sessions` 分页浏览 |
| 卡片报 300309 | 流式超时，bridge 会自动重开 |
| 图片发不出去 | 当前模型不支持图片输入，`/model` 切到支持视觉的模型 |
| 应用不可用 232034 | 飞书应用权限/事件订阅改动后需要重新发布版本 |

## 卸载

```bash
bash dsh-lark-bridge/uninstall.sh
```

移除 bridge 文件、web 插件挂载、飞书斜杠命令与 watchdog（不改动你的 dsh 会话数据）。

## License

Apache License 2.0，见 [LICENSE](LICENSE)。
