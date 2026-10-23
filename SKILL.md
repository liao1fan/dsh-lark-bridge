# dsh-lark-bridge：飞书桥接服务

## 用途

让用户通过飞书私聊指挥本机 dsh 会话：发消息即任务、看直播、切会话、传图传文件、导出记录。

## 安装（新环境一键部署）

```bash
# 将 dsh-lark-bridge 包放在任意位置，然后：
bash dsh-lark-bridge/install.sh
```

安装脚本自动完成：环境检测 → 部署文件 → 发现用户/聊天 ID → 生成配置 → 挂载 web 插件 → 注册飞书斜杠命令 → 启动 bridge + watchdog。

## 管理命令

| 操作 | 命令 |
|---|---|
| 重启 bridge | `bash ~/.dsh/dsh-lark-bridge/bin/start.sh` |
| 查看日志 | `tail -20 ~/.dsh/dsh-lark-bridge/config/bridge.log` |
| 停止全部 | `pkill -f "node.*bridge.mjs"; pkill -f "watchdog-loop"` |
| 卸载 | `bash dsh-lark-bridge/uninstall.sh` |

## 用户在飞书里的操作

- **直接发文字** = 给当前 dsh 会话发任务，流式卡片实时回复
- **发图片/文件** → bot 暂存 → 下一条文字自动带上
- **/help** — 全部命令
- **/panel** — 发送控制台 + 会话浏览卡片
- **/new [路径]** — 新建会话
- **/use <序号>** — 切换会话
- **/model** — 切换模型（vision-model 支持图片）
- **/watch** — 直播正在运行的任务
- **/export** — 导出会话记录到飞书文档

## 前置条件

1. dsh 已安装（`npm i -g @deepseek-ai/dsh`）
2. lark-cli 已安装并完成认证（`lark-cli auth login --domain all`）
3. Node.js >= 20

## 架构

```
飞书用户 ⇄ (lark-cli WebSocket 事件 + 轮询) ⇄ bridge 守护进程 ⇄ (ACP stdio) dsh --profile acp
                                                        ⇄ (HTTP 回环) dsh web 内嵌插件（中继模式）
```

- 会话持久化在 `~/.dsh/sessions/`，与 dsh Web GUI 共用
- 单写者锁：同一会话同一时间只允许一个前端写入
- Web 中继：被 Web 持有的会话可通过 dsh web 进程代写（用户无需等锁）
- 跨终端监控：飞书可实时看到 Web 侧正在跑的任务（日志 tail）
- 看门狗：bridge 崩溃 30 秒内自动拉起

## 故障排查

| 症状 | 排查 |
|---|---|
| 发消息没反应 | `tail bridge.log` 看是否收到事件；检查 lark-cli 认证 |
| 卡片按钮没反应 | 确认飞书开发者后台已启用事件回调（长连接模式） |
| 图片报"不支持" | 模型是 text-model（纯文本），用户需发 /model vision-model 切换 |
| Web 中继不可用 | 重启 dsh web 加载新版插件；检查 token 文件存在 |
| bridge 反复重启 | 查看日志中的 ERR_MODULE_NOT_FOUND，确认 dsh 安装完整 |
