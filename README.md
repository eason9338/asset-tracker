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

## 功能分頁

- **總覽**：總資產、持股、今日損益貢獻、總資產走勢（標出入金點）
- **績效**：與大盤／無風險利率的報酬比較、風險報酬指標（夏普、索提諾、最大回撤、Beta）、回撤圖、每月報酬熱力圖
- **風險**：依標的彙總曝險、壓力測試（含選擇權重新計價與追繳點估算）、選擇權部位風險、槓桿率走勢、警示設定
- **交易**：已實現損益與勝率、依標的／持有時間／選擇權到期天數分析、損益分布、每月已實現損益、交易成本
- **稅務**：台灣海外所得整理（最低稅負制門檻）、匯出明細 CSV

分析功能在 `analytics.js`、`analytics.css`。報價：股票優先用富途 OpenD（需要 `pip3 install futu-api` 並開著 OpenD，含夜盤），連不上時改用 Yahoo。

## 資料

`data.json`（持股、交易、走勢）與 `backups/` 只存在本機，已列在 `.gitignore`，不會上傳。
讀取 xlsx 需要 `openpyxl`（`pip3 install openpyxl`）；只用 CSV 則不需要。
