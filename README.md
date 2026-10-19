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

## 頁面

每個網址是獨立的頁面（左邊導覽列切換），共用外框在 `shell.html`，各頁內容在 `pages/`，由 `server.py` 組合：

- **總覽** `/overview`：今年的進度、持倉／現金／匯率／槓桿率、持股、總資產走勢、進行中的交易計畫、近期事件
- **績效** `/performance`：與大盤／無風險利率的報酬比較、風險報酬指標與回撤、每月報酬熱力圖
- **曝險** `/exposure`：個股曝險總覽（ETF 依前 50 大成分股拆到各公司，資料來自 Zacks、每天更新）、ETF 成分股（每 100 元裡各公司佔多少）
- **槓桿與選擇權** `/risk`：槓桿率走勢、選擇權部位風險
- **交易計畫** `/plans`：寫計畫（寫完等 3 個交易日才下單，依交易守則檢查部位上限）、計畫清單
- **交易紀錄** `/trades`：已實現損益與勝率、每一筆紀錄
- **交易分析** `/analysis`：依標的／持有時間／選擇權到期天數、損益分布、每月已實現損益、交易成本
- **交易日記** `/journal`、**設定與備份** `/settings`
- **平靜模式**（預設開啟）：首頁的金額和今天的漲跌先收起來，按「👁 看一下」暫時顯示

主程式在 `app.js`、`app.css`，分析功能在 `analytics.js`、`analytics.css`。報價：股票優先用富途 OpenD（需要 `pip3 install futu-api` 並開著 OpenD，含夜盤），連不上時改用 Yahoo。

## 資料

`data.json`（持股、交易、走勢）與 `backups/` 只存在本機，已列在 `.gitignore`，不會上傳。
讀取 xlsx 需要 `openpyxl`（`pip3 install openpyxl`）；只用 CSV 則不需要。
