# 個人資產記錄

讀取券商匯出的交易紀錄（CSV）與持倉檔（xlsx），計算總資產、走勢、與大盤／無風險利率的報酬比較、槓桿率與已實現損益。只用 Python 標準函式庫，報價來自 Yahoo Finance。

## 啟動

- 手動：`python3 server.py`，然後打開 http://localhost:8765
- 開機自動啟動（macOS）：
  ```sh
  cp deploy/com.akira.asset-server.plist ~/Library/LaunchAgents/
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.akira.asset-server.plist
  ```
  plist 裡的 Python 與專案路徑需依電腦調整。之後雙擊 `啟動資產網站.command` 即可打開網頁。

## 資料

`data.json`（持股、交易、走勢）與 `backups/` 只存在本機，已列在 `.gitignore`，不會上傳。
讀取 xlsx 需要 `openpyxl`（`pip3 install openpyxl`）；只用 CSV 則不需要。
