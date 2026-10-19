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

每個分頁有自己的網址：`/overview`、`/performance`、`/risk`、`/trades`（可以直接加書籤）。

- **總覽**：今年的進度、總資產、持股、交易計畫（寫完等 3 個交易日才下單，並依交易守則檢查部位上限）、近期事件（財報、配息、選擇權到期）、總資產走勢（標出入金點）
- **績效**：與大盤／無風險利率的報酬比較、風險報酬指標（夏普、索提諾、最大回撤、Beta）、回撤圖、每月報酬熱力圖
- **風險**：個股曝險總覽（ETF 依前 50 大成分股拆到各公司，成分股資料來自 Zacks、每天更新）、ETF 成分股（每 100 元裡各公司佔多少）、選擇權部位風險、槓桿率走勢
- **交易**：已實現損益與勝率、交易日記、依標的／持有時間／選擇權到期天數分析、損益分布、每月已實現損益、交易成本
- **平靜模式**（預設開啟）：首頁的金額和今天的漲跌先收起來，按「👁 看一下」暫時顯示

分析功能在 `analytics.js`、`analytics.css`。報價：股票優先用富途 OpenD（需要 `pip3 install futu-api` 並開著 OpenD，含夜盤），連不上時改用 Yahoo。

## 資料

`data.json`（持股、交易、走勢）與 `backups/` 只存在本機，已列在 `.gitignore`，不會上傳。
讀取 xlsx 需要 `openpyxl`（`pip3 install openpyxl`）；只用 CSV 則不需要。
