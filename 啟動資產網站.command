#!/bin/bash
# 伺服器由 launchd 在登入時自動啟動（~/Library/LaunchAgents/com.akira.asset-server.plist）
# 這個檔案只負責打開網頁；伺服器沒在跑時順便叫醒它
if ! curl -s -o /dev/null --max-time 2 http://localhost:8765/; then
  launchctl kickstart -k "gui/$(id -u)/com.akira.asset-server" 2>/dev/null \
    || launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.akira.asset-server.plist"
  sleep 2
fi
open http://localhost:8765
