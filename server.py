#!/usr/bin/env python3
"""個人資產記錄工具 — 本機伺服器（只用 Python 標準函式庫）

啟動：python3 server.py   然後打開 http://localhost:8765
資料存在同資料夾的 data.json（每次存檔前會備份到 backups/）。
"""
import http.cookiejar
import json
import os
import shutil
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", 8765))
BASE = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(BASE, "data.json")
BACKUP_DIR = os.path.join(BASE, "backups")
UA = "Mozilla/5.0"

STATIC_FILES = {
    "analytics.js": "application/javascript; charset=utf-8",
    "analytics.css": "text/css; charset=utf-8",
    "manifest.webmanifest": "application/manifest+json",
    "icon-180.png": "image/png",
    "icon-512.png": "image/png",
}

DEFAULT_DATA = {
    "cash": {"USD": 0, "TWD": 0},
    "holdings": {},
    "transactions": [],
    "history": [],
    "settings": {"displayCurrency": "TWD"},
}


CACHE_SECONDS = 15
_cache = {}  # symbol -> (timestamp, quote)
_cache_lock = threading.Lock()


def _get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.load(r)


def _from_meta(meta, symbol):
    return {
        "price": meta.get("regularMarketPrice"),
        "prevClose": meta.get("previousClose") or meta.get("chartPreviousClose"),
        "name": meta.get("longName") or meta.get("shortName") or symbol,
        "currency": meta.get("currency"),
        "time": meta.get("regularMarketTime"),
    }


def _fetch_batch(symbols):
    """一次查多檔（Yahoo spark），避免逐檔查詢被限流。"""
    url = (
        "https://query1.finance.yahoo.com/v7/finance/spark?range=1d&interval=1d&symbols="
        + urllib.parse.quote(",".join(symbols), safe=",")
    )
    out = {}
    for item in _get_json(url).get("spark", {}).get("result", []) or []:
        resp = item.get("response") or []
        if resp and resp[0].get("meta", {}).get("regularMarketPrice") is not None:
            out[item["symbol"].upper()] = _from_meta(resp[0]["meta"], item["symbol"])
    return out


def _fetch_one(symbol):
    for host in ("query2", "query1"):
        try:
            url = f"https://{host}.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?range=1d&interval=1d"
            return _from_meta(_get_json(url)["chart"]["result"][0]["meta"], symbol)
        except Exception as e:  # noqa: BLE001
            err = str(e)
    return {"error": err}


# ---------- 富途 OpenD：美股盤前、盤中、盤後、夜盤即時報價（OpenD 沒開時自動改用 Yahoo） ----------
FUTU_HOST, FUTU_PORT = "127.0.0.1", int(os.environ.get("FUTU_PORT", 11111))
_futu = {"ctx": None, "retry_at": 0}
_futu_lock = threading.Lock()
_futu_bad = set()   # 富途查不到的代號
FUTU_TIMEOUT = 5    # OpenD 超過幾秒沒回應就改用 Yahoo
_futu_pool = None


def _futu_call(fn, *args):
    """在背景執行緒呼叫富途，超過 FUTU_TIMEOUT 秒沒回應就丟出 TimeoutError"""
    global _futu_pool
    from concurrent.futures import ThreadPoolExecutor
    if _futu_pool is None:
        _futu_pool = ThreadPoolExecutor(max_workers=1)
    return _futu_pool.submit(fn, *args).result(timeout=FUTU_TIMEOUT)


def _futu_ctx():
    """取得（必要時建立）富途行情連線；OpenD 沒開就回傳 None，60 秒內不再重試"""
    if _futu["ctx"] is not None:
        return _futu["ctx"]
    if time.time() < _futu["retry_at"]:
        return None
    _futu["retry_at"] = time.time() + 60
    import socket
    try:
        socket.create_connection((FUTU_HOST, FUTU_PORT), timeout=1).close()
        import futu as ft
        ft.set_futu_debug_model(False)
        try:
            ft.logger.console_level = 50  # 只印嚴重錯誤，避免洗版伺服器記錄
        except Exception:  # noqa: BLE001
            pass
        # 建立連線也可能卡住（OpenD 開著但沒回應），一樣套用逾時
        _futu["ctx"] = _futu_call(lambda: ft.OpenQuoteContext(host=FUTU_HOST, port=FUTU_PORT))
    except Exception:  # noqa: BLE001
        global _futu_pool
        _futu["ctx"] = None
        _futu_pool = None
    return _futu["ctx"]


def _us_session(now=None):
    """依美東時間判斷交易時段（不含假日判斷）"""
    from zoneinfo import ZoneInfo
    et = (now or datetime.now(ZoneInfo("America/New_York")))
    m, wd = et.hour * 60 + et.minute, et.weekday()  # 週一 = 0
    if wd < 5 and 240 <= m < 570:
        return "pre"
    if wd < 5 and 570 <= m < 960:
        return "regular"
    if wd < 5 and 960 <= m < 1200:
        return "post"
    # 夜盤：週日到週四晚上 20:00，到隔天 04:00
    if (m >= 1200 and wd in (6, 0, 1, 2, 3)) or (m < 240 and wd < 5):
        return "overnight"
    return "closed"


def _num(x):
    """富途有時回傳 'N/A' 或 NaN：轉成數字，不行就回傳 None"""
    try:
        v = float(x)
        return v if v == v and v > 0 else None
    except (TypeError, ValueError):
        return None


def fetch_futu_quotes(symbols):
    """回傳 {代號: 報價}；只處理一般美股代號，查不到的留給 Yahoo"""
    us = [s for s in symbols if s.replace(".", "").replace("-", "").isalnum() and "=" not in s and not s.startswith("^")]
    if not us:
        return {}
    us = [s for s in us if s not in _futu_bad]
    with _futu_lock:
        ctx = _futu_ctx()
        if ctx is None or not us:
            return {}
        codes = ["US." + s.replace("-", ".") for s in us]
        records = []
        try:
            ret, df = _futu_call(ctx.get_market_snapshot, codes)
            if ret == 0:
                records = df.to_dict("records")
            else:
                # 一次查多檔時只要有一檔查不到（代號不認得、沒權限）整批都會失敗，改成逐檔查
                for s, c in zip(us, codes):
                    r1, d1 = _futu_call(ctx.get_market_snapshot, [c])
                    if r1 == 0:
                        records += d1.to_dict("records")
                    elif "未知" in str(d1) or "權限" in str(d1) or "unknown" in str(d1).lower():
                        _futu_bad.add(s)   # 之後直接交給 Yahoo
        except Exception:  # noqa: BLE001
            # 連線斷了或卡住：關掉，60 秒後再試著重連；這次改用 Yahoo
            global _futu_pool
            try:
                ctx.close()
            except Exception:  # noqa: BLE001
                pass
            _futu["ctx"] = None
            _futu["retry_at"] = time.time() + 60
            _futu_pool = None   # 卡住的執行緒丟掉，下次開新的
            return {}
    session = _us_session()
    out = {}
    for r in records:
        sym = r["code"].split(".", 1)[1]
        last, prev = _num(r.get("last_price")), _num(r.get("prev_close_price"))
        pick = {"pre": "pre_price", "post": "after_price", "overnight": "overnight_price"}.get(session)
        ext = _num(r.get(pick)) if pick else None
        if ext:
            # 盤前、夜盤跟上一個正規盤收盤比；盤後跟前一天收盤比（含當天正規盤的漲跌）
            price, ref = ext, (prev if session == "post" else last)
            sess = session
        else:
            price, ref, sess = last, prev, "regular" if session == "regular" else "closed"
        if not price:
            continue
        out[sym.replace(".", "-") if sym.replace(".", "-") in symbols else sym] = {
            "price": price, "prevClose": ref, "regularPrice": last, "session": sess,
            "name": r.get("name") or sym, "currency": "USD", "source": "futu",
            "time": int(datetime.strptime(str(r["update_time"])[:19], "%Y-%m-%d %H:%M:%S").replace(
                tzinfo=__import__("zoneinfo").ZoneInfo("America/New_York")).timestamp()) if r.get("update_time") else None,
        }
    return out


def fetch_quotes(symbols):
    now = time.time()
    result, todo = {}, []
    with _cache_lock:
        for s in symbols:
            hit = _cache.get(s)
            if hit and now - hit[0] < CACHE_SECONDS:
                result[s] = hit[1]
            else:
                todo.append(s)
    # 先用富途（含夜盤）；再用 Yahoo v7（盤前盤後）；最後用 spark 批次查正規盤價格
    try:
        result.update(fetch_futu_quotes(todo))
    except Exception:  # noqa: BLE001
        pass
    todo_yahoo = [s for s in todo if s not in result]
    for i in range(0, len(todo_yahoo), 50):
        try:
            for q in _v7_quote(todo_yahoo[i:i + 50]):
                if q.get("regularMarketPrice") is not None:
                    result[q["symbol"].upper()] = _stock_from_v7(q)
        except Exception:  # noqa: BLE001
            pass
    rest = [s for s in todo if s not in result]
    for i in range(0, len(rest), 20):
        chunk = rest[i:i + 20]
        try:
            result.update(_fetch_batch(chunk))
        except Exception:  # noqa: BLE001
            pass
    # 批次查不到的再逐檔補查（例如代號打錯時會回傳錯誤）
    for s in todo:
        if s not in result:
            result[s] = _fetch_one(s)
    with _cache_lock:
        for s in todo:
            if "error" not in result[s]:
                _cache[s] = (now, result[s])
    return result


# ---------- 選擇權報價（含買賣價）：需要 Yahoo 的 cookie + crumb ----------
_yjar = http.cookiejar.CookieJar()
_yopener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_yjar))
_crumb = {"value": None}
_opt_cache = {}  # symbol -> (timestamp, quote)
_opt_lock = threading.Lock()


def _yget(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with _yopener.open(req, timeout=10) as r:
        return r.read().decode()


def _refresh_crumb():
    try:
        _yget("https://fc.yahoo.com")
    except Exception:  # noqa: BLE001  這個網址回 404 也會發 cookie
        pass
    _crumb["value"] = _yget("https://query1.finance.yahoo.com/v1/test/getcrumb").strip()


_crumb_lock = threading.Lock()


def _v7_quote(symbols):
    """Yahoo v7 quote（需要 crumb）：含盤前盤後價格、交易時段、選擇權買賣價。失敗時丟出例外"""
    for attempt in range(2):
        try:
            with _crumb_lock:
                if not _crumb["value"]:
                    _refresh_crumb()
                crumb = _crumb["value"]
            url = ("https://query1.finance.yahoo.com/v7/finance/quote?symbols="
                   + urllib.parse.quote(",".join(symbols), safe=",") + "&crumb=" + urllib.parse.quote(crumb))
            return json.loads(_yget(url))["quoteResponse"]["result"]
        except urllib.error.HTTPError as e:
            if e.code in (401, 403) and attempt == 0:
                _crumb["value"] = None  # 驗證碼過期，重拿一次
                continue
            raise


def _stock_from_v7(q):
    """依交易時段挑最新價格；prevClose 是「今日漲跌」的比較基準"""
    state = q.get("marketState") or ""
    reg, prev = q.get("regularMarketPrice"), q.get("regularMarketPreviousClose")
    pre, post = q.get("preMarketPrice"), q.get("postMarketPrice")
    if state == "PRE" and pre:
        # 盤前：跟昨天收盤比
        price, ref, session, t = pre, reg, "pre", q.get("preMarketTime")
    elif state != "REGULAR" and post:
        # 盤後，以及盤後結束到隔天盤前之間（夜盤時段 Yahoo 沒有資料，停在盤後最後價格）
        price, ref, session, t = post, prev, "post", q.get("postMarketTime")
    else:
        price, ref, session, t = reg, prev, "regular" if state == "REGULAR" else "closed", q.get("regularMarketTime")
    return {"price": price, "prevClose": ref, "regularPrice": reg, "session": session,
            "name": q.get("longName") or q.get("shortName") or q["symbol"],
            "currency": q.get("currency"), "time": t}


def fetch_option_quotes(symbols):
    """回傳 {代號: {price, bid, ask, mark, prevClose, time, delay}}；Yahoo 標示選擇權延遲約 20 分鐘"""
    now = time.time()
    with _opt_lock:
        out = {s: _opt_cache[s][1] for s in symbols if s in _opt_cache and now - _opt_cache[s][0] < 30}
        todo = [s for s in symbols if s not in out]
        if not todo:
            return out
        try:
            res = _v7_quote(todo)
        except Exception as e:  # noqa: BLE001
            return {**out, **{s: {"error": str(e)} for s in todo}}
        for q in res:
            bid, ask, last = q.get("bid"), q.get("ask"), q.get("regularMarketPrice")
            # 交易量小的合約最後成交可能很久以前，有買賣價就用中間價
            mark = round((bid + ask) / 2, 4) if bid and ask and ask >= bid else last
            v = {"price": last, "bid": bid, "ask": ask, "mark": mark,
                 "prevClose": q.get("regularMarketPreviousClose"), "time": q.get("regularMarketTime"),
                 "delay": q.get("exchangeDataDelayedBy"), "underlying": q.get("underlyingSymbol")}
            out[q["symbol"]] = v
            _opt_cache[q["symbol"]] = (now, v)
        for s in todo:
            out.setdefault(s, {"error": "查不到（可能已到期）"})
        return out


_event_cache = {}  # symbol -> (timestamp, events)


def fetch_events(symbols):
    """財報日、配息日（Yahoo v7）；一小時更新一次"""
    now = time.time()
    out = {s: _event_cache[s][1] for s in symbols if s in _event_cache and now - _event_cache[s][0] < 3600}
    todo = [s for s in symbols if s not in out]
    if todo:
        try:
            for q in _v7_quote(todo):
                v = {"earnings": q.get("earningsTimestamp") or q.get("earningsTimestampStart"),
                     "earningsEstimate": q.get("isEarningsDateEstimate"),
                     "exDividend": q.get("exDividendDate"), "dividend": q.get("dividendDate"),
                     "name": q.get("shortName") or q["symbol"]}
                out[q["symbol"].upper()] = v
                _event_cache[q["symbol"].upper()] = (now, v)
        except Exception as e:  # noqa: BLE001
            return {**out, "_error": str(e)}
    return out


_hist_cache = {}  # (symbol, from) -> (timestamp, {date: close})


def fetch_history(symbol, start):
    key = (symbol, start)
    hit = _hist_cache.get(key)
    if hit and time.time() - hit[0] < 600:
        return hit[1]
    p1 = int(datetime.strptime(start, "%Y-%m-%d").timestamp()) - 7 * 86400
    p2 = int(time.time()) + 86400
    yahoo = symbol.replace(".", "-")  # BRK.B -> BRK-B
    err = None
    for host in ("query1", "query2"):
        try:
            url = (f"https://{host}.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(yahoo)}"
                   f"?period1={p1}&period2={p2}&interval=1d")
            j = _get_json(url)["chart"]["result"][0]
            break
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(0.5)
    else:
        return {"error": str(err)}
    try:
        tz = j["meta"].get("gmtoffset", 0)
        closes = j["indicators"]["quote"][0]["close"]
        out = {
            datetime.utcfromtimestamp(t + tz).strftime("%Y-%m-%d"): c
            for t, c in zip(j.get("timestamp", []), closes) if c is not None
        }
        _hist_cache[key] = (time.time(), out)
        return out
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


def parse_xlsx(raw):
    import io
    try:
        import openpyxl
    except ImportError:
        raise RuntimeError("需要 openpyxl 才能讀取 xlsx：請執行 pip3 install openpyxl，或改上傳 CSV")
    wb = openpyxl.load_workbook(io.BytesIO(raw), data_only=True, read_only=True)
    sheets = {}
    for ws in wb.worksheets:
        rows = []
        for r in ws.iter_rows(values_only=True):
            if any(c is not None for c in r):
                rows.append(["" if c is None else (c.strftime("%Y/%m/%d") if hasattr(c, "strftime") else c) for c in r])
        sheets[ws.title] = rows
    return sheets


def load_data():
    if not os.path.exists(DATA_FILE):
        return json.loads(json.dumps(DEFAULT_DATA))
    with open(DATA_FILE, encoding="utf-8") as f:
        return json.load(f)


def save_data(data):
    if os.path.exists(DATA_FILE):
        os.makedirs(BACKUP_DIR, exist_ok=True)
        # 每天保留一份備份
        stamp = datetime.now().strftime("%Y-%m-%d")
        shutil.copy2(DATA_FILE, os.path.join(BACKUP_DIR, f"data-{stamp}.json"))
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, DATA_FILE)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path in ("/", "/index.html"):
            with open(os.path.join(BASE, "index.html"), "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")
        # 網頁用到的其他檔案（只開放清單內的，不會把 data.json 之類的檔案送出去）
        static = STATIC_FILES.get(u.path.lstrip("/"))
        if static and os.path.exists(os.path.join(BASE, u.path.lstrip("/"))):
            with open(os.path.join(BASE, u.path.lstrip("/")), "rb") as f:
                return self._send(200, f.read(), static)
        if u.path == "/api/data":
            return self._send(200, load_data())
        if u.path == "/api/quotes":
            q = urllib.parse.parse_qs(u.query).get("symbols", [""])[0]
            symbols = [s.strip().upper() for s in q.split(",") if s.strip()][:60]
            return self._send(200, fetch_quotes(symbols))
        if u.path == "/api/options":
            q = urllib.parse.parse_qs(u.query).get("symbols", [""])[0]
            symbols = [s.strip().upper() for s in q.split(",") if s.strip()][:50]
            return self._send(200, fetch_option_quotes(symbols) if symbols else {})
        if u.path == "/api/events":
            q = urllib.parse.parse_qs(u.query).get("symbols", [""])[0]
            symbols = [s.strip().upper() for s in q.split(",") if s.strip()][:40]
            return self._send(200, fetch_events(symbols) if symbols else {})
        if u.path == "/api/history":
            qs = urllib.parse.parse_qs(u.query)
            symbols = [x.strip().upper() for x in qs.get("symbols", [""])[0].split(",") if x.strip()][:120]
            start = qs.get("from", [datetime.now().strftime("%Y-%m-%d")])[0]
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=4) as ex:
                res = dict(zip(symbols, ex.map(lambda sym: fetch_history(sym, start), symbols)))
            return self._send(200, res)
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path == "/api/parse-xlsx":
            raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            try:
                return self._send(200, {"sheets": parse_xlsx(raw)})
            except Exception as e:  # noqa: BLE001
                return self._send(400, {"error": str(e)})
        if urllib.parse.urlparse(self.path).path != "/api/data":
            return self._send(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length", 0))
        try:
            data = json.loads(self.rfile.read(length))
            # 版本檢查：避免舊分頁蓋掉較新的資料
            current = load_data().get("rev", 0)
            if data.get("rev", 0) != current:
                return self._send(409, {"error": "conflict", "rev": current})
            data["rev"] = current + 1
            save_data(data)
            self._send(200, {"ok": True, "rev": data["rev"]})
        except Exception as e:  # noqa: BLE001
            self._send(400, {"error": str(e)})


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://localhost:{PORT}"
    print(f"資產記錄工具已啟動：{url}   （Ctrl+C 結束）")
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已關閉")
