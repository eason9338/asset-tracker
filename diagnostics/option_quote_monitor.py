#!/usr/bin/env python3
"""盤中選擇權報價延遲監測（一次性測試用）

等到指定時間（預設台灣 21:35，美股開盤 5 分鐘後）開始，每 60 秒向 Yahoo 查一次報價，持續 60 分鐘。
用成交非常頻繁的價平合約（SPY、GOOG）量延遲：「現在時間 − 最後成交時間」≈ 報價延遲。
結果寫到同資料夾的 option_quote_monitor.log，結束時附上摘要。

用法：python3 option_quote_monitor.py [開始時間 HH:MM] [次數] [間隔秒數] [要一起觀察的選擇權代號，逗號分隔]
"""
import datetime as dt
import http.cookiejar
import json
import os
import statistics
import sys
import time
import urllib.request

UA = "Mozilla/5.0"
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "option_quote_monitor.log")
STOCKS = ["SPY", "GOOG", "GGLL"]

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def log(msg):
    line = f"{dt.datetime.now():%Y-%m-%d %H:%M:%S}  {msg}"
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with opener.open(req, timeout=15) as r:
        return r.read().decode()


def new_crumb():
    try:
        get("https://fc.yahoo.com")
    except Exception:
        pass  # 這個網址回 404 也會發 cookie
    return get("https://query1.finance.yahoo.com/v1/test/getcrumb").strip()


def atm_contract(underlying, crumb):
    """最近到期、最接近現價的 call"""
    j = json.loads(get(f"https://query2.finance.yahoo.com/v7/finance/options/{underlying}?crumb={crumb}"))
    r = j["optionChain"]["result"][0]
    px = r["quote"]["regularMarketPrice"]
    calls = r["options"][0]["calls"]
    return min(calls, key=lambda c: abs(c["strike"] - px))["contractSymbol"]


def wait_until(hhmm):
    target = dt.datetime.combine(dt.date.today(), dt.time(*map(int, hhmm.split(":"))))
    if target < dt.datetime.now():
        return
    log(f"等待到 {target:%H:%M} 開始（電腦需保持開機、不要闔上螢幕）")
    while dt.datetime.now() < target:   # 用牆上時間判斷，電腦睡眠醒來後也能接續
        time.sleep(30)


def main():
    start = sys.argv[1] if len(sys.argv) > 1 else "21:35"
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 60
    gap = float(sys.argv[3]) if len(sys.argv) > 3 else 60
    held = [s for s in (sys.argv[4] if len(sys.argv) > 4 else "").split(",") if s]
    wait_until(start)

    crumb = new_crumb()
    liquid = [atm_contract(u, crumb) for u in ("SPY", "GOOG")]
    symbols = liquid + held + STOCKS
    log(f"開始監測：{', '.join(symbols)}（{n} 次，每 {gap:.0f} 秒）")

    ages = {s: [] for s in symbols}
    prices = {s: [] for s in symbols}
    errors = 0
    for i in range(n):
        try:
            url = "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" + ",".join(symbols) + "&crumb=" + crumb
            try:
                res = json.loads(get(url))["quoteResponse"]["result"]
            except urllib.error.HTTPError as e:
                if e.code != 401:
                    raise
                crumb = new_crumb()  # 驗證碼過期就重拿
                res = json.loads(get(url.rsplit("crumb=", 1)[0] + "crumb=" + crumb))["quoteResponse"]["result"]
            now = time.time()
            parts = []
            for q in res:
                s, t = q["symbol"], q.get("regularMarketTime")
                age = (now - t) / 60 if t else None
                if age is not None:
                    ages[s].append(age)
                prices[s].append(q.get("regularMarketPrice"))
                parts.append(f"{s} {q.get('regularMarketPrice')} ({q.get('bid')}/{q.get('ask')}) "
                             f"成交於{dt.datetime.fromtimestamp(t):%H:%M:%S} 延遲{age:.1f}分 標示{q.get('exchangeDataDelayedBy')}分")
            log(f"[{i + 1}/{n}] " + " | ".join(parts))
        except Exception as e:
            errors += 1
            log(f"[{i + 1}/{n}] 錯誤：{e}")
        if i < n - 1:
            time.sleep(gap)

    log("========== 摘要 ==========")
    for s in symbols:
        a = ages[s]
        if not a:
            log(f"{s}: 沒有資料")
            continue
        changes = sum(1 for x, y in zip(prices[s], prices[s][1:]) if x != y)
        log(f"{s}: 成功 {len(a)}/{n} 次，「現在 − 最後成交」中位數 {statistics.median(a):.1f} 分鐘"
            f"（最小 {min(a):.1f}、最大 {max(a):.1f}），價格變動 {changes} 次")
    log(f"錯誤次數：{errors}")


if __name__ == "__main__":
    main()
