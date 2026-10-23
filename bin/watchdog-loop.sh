#!/bin/bash
# 桥接看门狗守护循环：每 30 秒检查，进程不在就自动拉起
BRIDGE_HOME="$HOME/.dsh/dsh-lark-bridge"
while true; do
  if ! pgrep -f "node.*bridge[.]mjs" > /dev/null; then
    echo "$(date -Is) watchdog: bridge down, restarting" >> "$BRIDGE_HOME/config/watchdog.log"
    bash "$BRIDGE_HOME/bin/start.sh" >> "$BRIDGE_HOME/config/watchdog.log" 2>&1
  fi
  sleep 30
done
