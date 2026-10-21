// 分析功能：分頁、警示、隱私模式、平靜模式、今年的進度、近期事件、今日損益貢獻、風險報酬指標、回撤、每月報酬、
// 依標的曝險、壓力測試、下單前檢查、選擇權部位風險、交易日記、交易分析、每月已實現損益、交易成本。
// 只讀取 index.html 的資料與函式（data、calc、realizedStats…），只會寫入警示設定、交易日記、部位計畫和交易規則。
// 全部包在函式裡，避免跟 index.html 的全域變數撞名；對外只公開 window.renderExtras。
(() => {
'use strict';

// ============ 共用 ============
const el = id => document.getElementById(id);
const usd = (v, o = {}) => fmt(v, 'USD', o);
const usd0 = (v, o = {}) => fmt(v, 'USD', { digits: 0, ...o });
const pct = (v, d = 1) => v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(d) + '%';
const pctPlain = (v, d = 0) => v == null || !isFinite(v) ? '—' : (v * 100).toFixed(d) + '%';
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const std = a => { if (a.length < 2) return 0; const m = avg(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
const store = { get(k, d) { try { const v = localStorage.getItem('asset.' + k); return v == null ? d : v; } catch { return d; } },
                set(k, v) { try { localStorage.setItem('asset.' + k, v); } catch { /* 私密瀏覽等情況存不了，沒關係 */ } } };
const visible = id => { const e = el(id); return e && e.offsetParent !== null && e.clientWidth > 0; };

// 常見槓桿／反向 ETF 補充（index.html 的表沒有列到的）
Object.assign(LEV_DEFAULT, { NFXL: 2, GGLS: -1, AMDD: -1, NVDD: -1, ZSL: -2, QQQI: 1, SPYI: 1, SPYM: 1, BOXX: 0 });
// 標的歸屬：槓桿 ETF、同公司不同股別都算到同一個標的
const UNDERLYING = {
  GOOG: 'GOOGL', GGLL: 'GOOGL', GGLS: 'GOOGL', TSLL: 'TSLA', TSLQ: 'TSLA', NVDL: 'NVDA', NVDU: 'NVDA', NVDD: 'NVDA',
  METU: 'META', MUU: 'MU', ORCX: 'ORCL', MSFU: 'MSFT', AAPU: 'AAPL', AMZU: 'AMZN', NFXL: 'NFLX', PLTU: 'PLTR',
  CONL: 'COIN', MSTU: 'MSTR', AMDL: 'AMD', AMDD: 'AMD', TSMX: 'TSM', SOXL: 'SOX', SOXS: 'SOX', SOXX: 'SOX', SMH: 'SOX',
  TQQQ: 'NDX', SQQQ: 'NDX', QQQ: 'NDX', QLD: 'NDX', PSQ: 'NDX', QID: 'NDX', QQQI: 'NDX', QQQM: 'NDX',
  SPY: 'SPX', VOO: 'SPX', IVV: 'SPX', SPYM: 'SPX', SPLG: 'SPX', UPRO: 'SPX', SPXL: 'SPX', SSO: 'SPX', SH: 'SPX', SDS: 'SPX',
  SPXU: 'SPX', SPXS: 'SPX', SPYI: 'SPX', IBIT: 'BTC', BITX: 'BTC', FBTC: 'BTC', ZSL: 'SILVER', SLV: 'SILVER', GLD: 'GOLD', IAU: 'GOLD',
  BOXX: 'CASH', BIL: 'CASH', SGOV: 'CASH',
};
const GROUP_NAME = {
  GOOGL: 'Alphabet（Google）', TSLA: 'Tesla', NVDA: 'NVIDIA', META: 'Meta', MU: 'Micron', ORCL: 'Oracle', MSFT: 'Microsoft',
  AAPL: 'Apple', AMZN: 'Amazon', NFLX: 'Netflix', PLTR: 'Palantir', COIN: 'Coinbase', MSTR: 'Strategy', AMD: 'AMD',
  TSM: '台積電 ADR', SOX: '半導體', NDX: 'Nasdaq 100', SPX: 'S&P 500', BTC: '比特幣', SILVER: '白銀', GOLD: '黃金', CASH: '短天期國庫券',
};
const grp = s => UNDERLYING[s] || s;
const grpName = g => GROUP_NAME[g] || g;
window.symGroup = s => ({ g: grp(s), name: grpName(grp(s)) });   // 給 app.js 用：代號屬於哪個標的
window.periodPerf = (from, to) => {
  // 從 from 前一個收盤到 to（含）為止：時間加權報酬、扣掉入金後賺到的錢、同期 QQQ／VOO
  const h = data.history, i0 = h.findIndex(x => x.date >= from) - 1, i1 = h.map(x => x.date <= to).lastIndexOf(true);
  if (i0 < 0 || i1 <= i0) return null;
  const seg = h.slice(i0, i1 + 1), a = seg[0], b = seg.at(-1);
  const flows = externalFlows().filter(f => f.date > a.date && f.date <= b.date).reduce((s, f) => s + f.usd, 0);
  return { twr: dailyReturns(seg, outsideAsFlow()).reduce((p, x) => p * (1 + x.r), 1) - 1, gain: b.usd - a.usd - flows,
           qqq: benchRet('QQQ', a.date, b.date), voo: benchRet('VOO', a.date, b.date) };
};

// 每日時間加權報酬（扣掉當段的入金出金），跟報酬率比較用同一套算法
function dailyReturns(hist, outsideAsFlow = false) {
  const flows = externalFlows(), out = [];
  if (outsideAsFlow) for (const t of data.transactions) if (t.type === 'income' && (t.category || '').startsWith('帳外獲利')) flows.push({ date: t.date, usd: t.currency === 'USD' ? t.amount : t.amount / fx });
  for (let i = 1; i < hist.length; i++) {
    const a = hist[i - 1], b = hist[i];
    if (!(a.usd > 0)) continue;
    const f = flows.filter(x => x.date > a.date && x.date <= b.date).reduce((s, x) => s + x.usd, 0);
    out.push({ date: b.date, prev: a.date, r: (b.usd - f) / a.usd - 1 });
  }
  return out;
}
const benchOk = s => bench && bench[s] && !bench[s].error;
function benchRet(sym, d0, d1) {
  if (!benchOk(sym)) return null;
  const a = lastOnOrBefore(bench[sym], d0), b = lastOnOrBefore(bench[sym], d1);
  return a && b ? b / a - 1 : null;
}
function riskFree(from, to) {
  if (!benchOk('^IRX')) return 0.04;
  const v = Object.entries(bench['^IRX']).filter(([d]) => d >= from && d <= to).map(([, x]) => x);
  return (v.length ? avg(v) : 4) / 100;
}

// 選擇權：由報價反推隱含波動率；Black-Scholes 的 theta、價內機率
function impliedVol(o, mark, S, T, r) {
  if (!(mark > 0) || !(S > 0) || !(T > 0)) return null;
  let lo = 0.01, hi = 5;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (bsModel(S, o.strike, T, r, mid, o.call).price > mark) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
}
const yearsTo = exp => Math.max((new Date(exp + 'T20:00:00Z') - Date.now()) / (365 * 864e5), 1 / (365 * 24));
const npdf = x => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
function bsExtra(S, K, T, r, v, call) {
  const d1 = (Math.log(S / K) + (r + v * v / 2) * T) / (v * Math.sqrt(T)), d2 = d1 - v * Math.sqrt(T);
  const common = -S * npdf(d1) * v / (2 * Math.sqrt(T));
  const theta = call ? common - r * K * Math.exp(-r * T) * normCdf(d2) : common + r * K * Math.exp(-r * T) * normCdf(-d2);
  return { theta: theta / 365, pItm: call ? normCdf(d2) : normCdf(-d2) };
}
const curRate = () => { const v = benchOk('^IRX') ? lastOnOrBefore(bench['^IRX'], today()) : null; return (v ?? 4) / 100; };

// ---------- 小型圖表 ----------
function lineChart(box, pts, { fmtY, fmtTip, color = 'var(--accent)', zero = false, area = true, ref = null, mark = null, dots = [] }) {
  if (!box || box.clientWidth === 0) return;
  if (pts.length < 2) { box.innerHTML = '<div class="empty">資料不足</div>'; return; }
  const W = box.clientWidth, H = box.clientHeight, padL = 56, padR = 12, padT = 10, padB = 22;
  const vals = pts.map(p => p.y).concat(zero ? [0] : []).concat(ref != null ? [ref] : []);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.08; min -= pad; max += pad;
  const x0 = pts[0].x, x1 = pts.at(-1).x;
  const x = v => padL + (v - x0) / (x1 - x0 || 1) * (W - padL - padR);
  const y = v => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + x(p.x).toFixed(1) + ',' + y(p.y).toFixed(1)).join('');
  const base = zero ? y(0) : H - padB;
  const ticks = [0, 0.5, 1].map(f => min + (max - min) * f);
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    ${ticks.map(t => `<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" stroke="var(--border)" stroke-dasharray="2 4"/>
      <text class="axis-text" x="${padL - 8}" y="${y(t) + 4}" text-anchor="end">${fmtY(t)}</text>`).join('')}
    ${zero ? `<line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" stroke="var(--text-3)"/>` : ''}
    ${ref != null ? `<line x1="${padL}" x2="${W - padR}" y1="${y(ref)}" y2="${y(ref)}" stroke="var(--text-3)" stroke-dasharray="4 3"/>` : ''}
    ${area ? `<path d="${line}L${x(x1)},${base}L${x(x0)},${base}Z" fill="${color}" opacity=".14"/>` : ''}
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    ${mark ? `<circle cx="${x(mark.x)}" cy="${y(mark.y)}" r="5" fill="${color}" stroke="var(--surface)" stroke-width="2"/>` : ''}
    ${dots.map(d => `<circle cx="${x(d.x).toFixed(1)}" cy="${y(d.y).toFixed(1)}" r="${d.r || 4.5}" fill="${d.fill}" stroke="${d.stroke || 'var(--surface)'}" stroke-width="1.5"/>`).join('')}
    <text class="axis-text" x="${padL}" y="${H - 4}">${pts[0].label ?? ''}</text>
    <text class="axis-text" x="${W - padR}" y="${H - 4}" text-anchor="end">${pts.at(-1).label ?? ''}</text>
    <line class="xc" y1="${padT}" y2="${H - padB}" stroke="var(--text-3)" visibility="hidden"/>
    <circle class="xd" r="4" fill="${color}" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>
    <rect x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent" class="xh"/>
  </svg><div class="chart-tip" hidden></div>`;
  const hit = box.querySelector('.xh'), cx = box.querySelector('.xc'), cd = box.querySelector('.xd'), tip = box.querySelector('.chart-tip');
  hit.addEventListener('pointermove', e => {
    const mx = e.clientX - box.getBoundingClientRect().left;
    let best = pts[0];
    for (const p of pts) if (Math.abs(x(p.x) - mx) < Math.abs(x(best.x) - mx)) best = p;
    const px = x(best.x);
    cx.setAttribute('x1', px); cx.setAttribute('x2', px); cx.setAttribute('visibility', 'visible');
    cd.setAttribute('cx', px); cd.setAttribute('cy', y(best.y)); cd.setAttribute('visibility', 'visible');
    tip.hidden = false; tip.style.top = padT + 'px'; tip.style.left = px + 'px';
    tip.style.transform = px > W / 2 ? 'translate(calc(-100% - 10px), 0)' : 'translate(10px, 0)';
    tip.innerHTML = fmtTip(best);
  });
  hit.addEventListener('pointerleave', () => { cx.setAttribute('visibility', 'hidden'); cd.setAttribute('visibility', 'hidden'); tip.hidden = true; });
}

// ============ 頁面：每個網址是獨立的頁面，只有自己的區塊 ============
const PAGE = document.body.dataset.page || 'overview';

// ============ 隱私模式 ============
function applyPrivacy() {
  const on = store.get('privacy', '0') === '1';
  document.documentElement.classList.toggle('privacy', on);
  const b = el('privacyBtn'); if (b) b.textContent = on ? '◑ 已隱藏' : '◐ 隱私';
}
applyPrivacy();

// ============ 平靜模式：不顯示今天的漲跌，改看今年的累積成績 ============
function applyCalm() {
  const on = store.get('calm', '1') === '1';
  document.documentElement.classList.toggle('calm', on);
  const b = el('calmBtn');
  if (b) { b.textContent = on ? '◉ 平靜中' : '◎ 平靜'; b.title = on ? '平靜模式開啟中：按一下會顯示今天的漲跌' : '平靜模式：不顯示今天的漲跌，改看今年的累積成績'; }
}
applyCalm();
const isCalm = () => document.documentElement.classList.contains('calm');
// 平靜模式下按「看一下」：暫時顯示數字，3 分鐘後自動收起
let peekTimer = null;
function peek(on) {
  document.documentElement.classList.toggle('peek', on);
  const b = el('peekBtn'); if (b) b.textContent = on ? '🙈 收起來' : '👁 看一下';
  clearTimeout(peekTimer);
  if (on) peekTimer = setTimeout(() => peek(false), 3 * 60e3);
  if (data) render();   // 讓圖表提示框等地方跟著更新
}

// ============ 今年的進度 ============
function ytdStats(c) {
  const hist = inRange(data.history, 'ytd');
  if (hist.length < 2) return null;
  const start = hist[0], endDate = today();
  const flows = externalFlows().filter(f => f.date > start.date && f.date <= endDate).reduce((s, f) => s + f.usd, 0);
  const rets = dailyReturns(hist, outsideAsFlow());
  return { start, flows, gain: c.totalUSD - start.usd - flows, twr: rets.reduce((p, x) => p * (1 + x.r), 1) - 1,
           qqq: benchRet('QQQ', start.date, endDate), voo: benchRet('VOO', start.date, endDate) };
}
function renderProgress(c) {
  const box = el('progressBox'); if (!box) return;
  const y = ytdStats(c);
  if (!y) { box.innerHTML = '<div class="empty">今年的資料還不夠</div>'; el('heroCalm').innerHTML = ''; return; }
  el('heroCalm').innerHTML = `<span class="muted">今年累積</span> <b class="num">${usd0(y.gain, { sign: true })}</b> <span class="muted num">（${pct(y.twr)}）</span>`;
  el('progressNote').textContent = `從 ${y.start.date} 收盤起算`;
  // 一排四格：我賺的錢、我的報酬率、兩個指數今年的報酬
  // 左邊：今年賺到的錢；右邊：我的報酬率和兩個指數的長條，一眼看出差距
  const rows = [['我的報酬率', y.twr, true], ['Nasdaq 100', y.qqq], ['S&amp;P 500', y.voo]];
  const max = Math.max(...rows.map(r => Math.abs(r[1] ?? 0)), 1e-6);
  box.innerHTML = `<div class="ytd">
      <div class="ytd-main"><div class="k">今年賺到的錢</div><div class="v num ${cls(y.gain)}">${usd0(y.gain, { sign: true })}</div></div>
      <div class="ytd-bars">${rows.map(([k, v, me]) => `<div class="ytd-row${me ? ' me' : ''}"><span>${k}</span>
        <span class="hbar-track"><i style="left:0;width:${v == null ? 0 : Math.abs(v) / max * 100}%"></i></span>
        <b class="num ${cls(v)}">${v == null ? '—' : pct(v)}</b></div>`).join('')}</div>
    </div>`;
}

// ============ 近期事件：財報、配息、選擇權到期 ============
const INDEX_GROUPS = new Set(['SOX', 'NDX', 'SPX', 'BTC', 'SILVER', 'GOLD', 'CASH']);
let eventCache = { at: 0, key: '', data: null, loading: false };
const EVENT_MIN = 0.01;   // ETF 拆開後佔淨資產超過這個比例的公司，也追蹤財報
function lookThrough(c) {
  // ETF 拆成成分股後，佔淨資產夠大的公司：代號 → { 佔比, 透過哪幾檔 }
  loadEtfs(etfsFor(heldSyms(c)));
  const out = {};
  for (const g of stockExposure(c).stocks) if (g.total / c.totalUSD >= EVENT_MIN) out[g.key] = { pct: g.total / c.totalUSD, via: Object.keys(g.via) };
  return out;
}
function eventSymbols(c, lt) {
  const set = new Set();
  const addSym = s => { set.add(s); const u = UNDERLYING[s]; if (u && !INDEX_GROUPS.has(u)) set.add(u); };
  for (const r of c.rows) addSym(r.sym);
  for (const o of c.optRows) addSym(occ(o.sym).root);
  for (const k of Object.keys(lt)) set.add(k.replace('.', '-'));   // Yahoo 的代號用「-」（BRK-B）
  return [...set].sort();
}
async function loadEvents(syms) {
  eventCache.loading = true;
  try {
    eventCache.data = await (await fetch('/api/events?symbols=' + encodeURIComponent(syms.join(',')))).json();
    eventCache.at = Date.now(); eventCache.key = syms.join(',');
  } catch { eventCache.data = eventCache.data || {}; }
  eventCache.loading = false;
  renderEvents(calc());
}
function renderEvents(c) {
  const box = el('eventsBox'); if (!box) return;
  const lt = lookThrough(c), syms = eventSymbols(c, lt);
  if (!syms.length) { box.innerHTML = '<div class="empty">目前沒有持股</div>'; return; }
  if ((eventCache.key !== syms.join(',') || Date.now() - eventCache.at > 3600e3) && !eventCache.loading) loadEvents(syms);
  const tz = d => new Date(d).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const ev = [];
  const now = Date.now(), horizon = now + 75 * 864e5;
  for (const [sym, e] of Object.entries(eventCache.data || {})) {
    if (sym.startsWith('_') || !e) continue;
    const affected = c.rows.filter(r => grp(r.sym) === grp(sym)).map(r => r.sym)
      .concat(c.optRows.filter(o => grp(occ(o.sym).root) === grp(sym)).map(o => optName(o.sym)));
    const big = lt[grp(sym.replace('-', '.'))];   // 透過 ETF 持有、佔淨資產夠大
    const viaEtf = big ? big.via.filter(v => !affected.includes(v)) : [];
    const sub = [affected.length ? `會影響：${esc(affected.join('、'))}` : '', big ? `佔淨資產 <span class="money">${pctPlain(big.pct, 1)}</span>${viaEtf.length ? (affected.length ? `（含 ${esc(viaEtf.join('、'))} 裡的部分）` : `，透過 ${esc(viaEtf.join('、'))} 持有`) : ''}` : ''].filter(Boolean).join('・');
    if (e.earnings && e.earnings * 1000 > now - 864e5 && e.earnings * 1000 < horizon)
      ev.push({ t: e.earnings * 1000, kind: '財報', title: `${esc(grpName(grp(sym.replace('-', '.'))))} 公布財報${e.earningsEstimate ? '（預估日期）' : ''}`, when: tz(e.earnings * 1000) + '（台灣時間）', sub });
    if (!affected.length) continue;   // 只透過 ETF 持有的公司：股息是發給 ETF，不用提醒除息
    if (e.exDividend && e.exDividend * 1000 > now - 864e5 && e.exDividend * 1000 < horizon)
      ev.push({ t: e.exDividend * 1000, kind: '除息', title: `${esc(sym)} 除息`, when: tz(e.exDividend * 1000), sub: '除息日前一天收盤持有才領得到' });
  }
  for (const o of c.optRows) {
    const oc = occ(o.sym), t = new Date(oc.exp + 'T20:00:00Z').getTime();
    ev.push({ t, kind: '到期', title: `${esc(optName(o.sym))} 到期`, when: tz(t) + '（美東收盤）', sub: `${o.qty > 0 ? '買方' : '賣方'} ${Math.abs(o.qty)} 口` });
  }
  ev.sort((a, b) => a.t - b.t);
  // 同一家公司的不同股別（GOOG、GOOGL）會查到同一場財報，只留一筆
  const seen = new Set();
  for (let i = ev.length - 1; i >= 0; i--) { const k = ev[i].kind + ev[i].title + new Date(ev[i].t).toDateString(); if (seen.has(k)) ev.splice(i, 1); else seen.add(k); }
  if (!ev.length) { box.innerHTML = `<div class="empty">${eventCache.loading || !eventCache.data ? '讀取中…' : '接下來 75 天沒有已知的事件'}</div>`; return; }
  box.innerHTML = ev.map(e => {
    const d = Math.ceil((e.t - now) / 864e5);
    return `<div class="ev-row"><span class="badge ${e.kind === '財報' ? 'bad' : ''}">${e.kind}</span>
      <div class="ev-main"><b>${e.title}</b><span class="sub">${esc(e.when)}${e.sub ? '・' + e.sub : ''}</span></div>
      <div class="ev-days num">${d <= 0 ? '今天' : `還有 ${d} 天`}</div></div>`;
  }).join('') + `<div class="note">追蹤你直接持有的標的，以及 ETF 拆開後佔淨資產 ${EVENT_MIN * 100}% 以上的公司。財報與配息日期來自 Yahoo；財報當天股價和選擇權的波動通常最大。</div>`;
}

// ============ 警示 ============
const ALERT_DEFAULTS = { on: true, lev: 2, single: 200, dd: 15, dte: 3, optMax: 10, cool: true, coolPct: 2.5, notify: false };
const alertCfg = () => ({ ...ALERT_DEFAULTS, ...(data?.settings?.alerts || {}) });
function computeAlerts(c) {
  const a = alertCfg(), out = [];
  if (!a.on || !c) return out;
  if (c.leverage != null && c.leverage > a.lev) out.push({ lvl: 'danger', tag: '槓桿', msg: `槓桿率 <b>${c.leverage.toFixed(2)}x</b>，超過你設定的上限 ${a.lev}x` });
  const peak = Math.max(...data.history.map(h => h.usd));
  if (peak > 0 && c.totalUSD < peak) {
    // 回撤以時間加權指數計算，避免出金被當成下跌
    const rets = dailyReturns(data.history); let idx = 1, top = 1;
    for (const r of rets) { idx *= 1 + r.r; top = Math.max(top, idx); }
    const dd = idx / top - 1;
    if (-dd * 100 > a.dd) out.push({ lvl: 'danger', tag: '回撤', msg: `目前距離高點 <b>${pct(dd)}</b>，超過你設定的 ${a.dd}%` });
  }
  // 交易計畫：今天可以執行、到停損、到目標
  for (const p of (data.plans || []).filter(p => p.created && ['waiting', 'ready'].includes(planState(p)))) {
    const name = `${esc(planLabel(p))} ${esc(p.sym)}`;
    if (planExec(p) === today()) out.push({ lvl: 'calm', tag: '計畫', msg: `「${name}」的計畫今天起可以執行了：條件還成立就照計畫做，不成立就作廢。` });
    const w = planState(p) === 'ready' ? planWatch(p) : null;
    if (w?.hit) out.push({ lvl: 'calm', tag: '計畫', msg: `${esc(p.sym)} 到價了：現價 <b>${usd(w.px)}</b>，計畫價 <b>${usd(p.price)}</b>。條件還成立就照計畫${actOf(p) === 'sell' ? '賣出' : '買進'}。` });
    if (planNextDate(p) === today() && planState(p) === 'ready') out.push({ lvl: 'calm', tag: '計畫', msg: `今天是「${name}」計畫裡的買進日${p.qty ? `（${p.qty} 股）` : ''}，照計畫買就好。` });
  }
  // 我的守則
  for (const r of c.rows.filter(x => isLevEtf(x.sym))) out.push({ lvl: 'danger', tag: '守則 4', msg: `持有槓桿 ETF ${esc(r.sym)}：照守則不能持有，可以隨時賣出` });
  for (const o of c.optRows.filter(o => isLevEtf(occ(o.sym).root))) out.push({ lvl: 'warn', tag: '守則 4', msg: `${esc(optName(o.sym))} 的標的是槓桿 ETF：照守則可以隨時平倉，不用等` });
  for (const g of capExposure(c).filter(x => x.pct * 100 > RULES.trim))
    out.push({ lvl: 'danger', tag: '守則 3', msg: `${esc(grpName(g.g))} 佔總資產 <b>${pctPlain(g.pct)}</b>，超過 ${RULES.trim}%：照守則減碼回 ${RULES.cap}%${isCalm() ? '' : `（約 <b>${usd0(g.v - c.totalUSD * RULES.cap / 100)}</b>）`}` });
  for (const o of c.optRows.filter(o => o.qty > 0)) out.push({ lvl: 'warn', tag: '守則 1', msg: `持有買方選擇權 ${esc(optName(o.sym))}：守則是不做買方` });
  // 冷靜期：大跌的當天、或選擇權虧很多時，提醒先不要開新部位
  const base = c.totalUSD - c.day, dayPct = base > 0 ? c.day / base : 0;
  if (a.cool && dayPct * 100 <= -a.coolPct)
    out.push({ lvl: 'calm', tag: '冷靜', msg: `今天帳戶波動比較大${isCalm() ? '' : `（<b>${pct(dayPct)}</b>）`}。虧損的當天最容易做出衝動的決定，建議今天先不要開新部位，明天再看。` });
  for (const o of c.optRows) {
    const share = Math.abs(o.value) / c.totalUSD;
    if (share * 100 > a.optMax) out.push({ lvl: 'warn', tag: '部位', msg: `${esc(optName(o.sym))} 佔淨資產 <b>${pctPlain(share)}</b>，超過單筆上限 ${a.optMax}%` });
    const paid = o.avg * 100 * o.qty;
    if (a.cool && o.qty > 0 && o.mark != null && paid > 0 && o.value < paid * 0.75)
      out.push({ lvl: 'calm', tag: '冷靜', msg: `${esc(optName(o.sym))} 目前比買進時少了 ${isCalm() ? '一些' : `<b>${pctPlain(1 - o.value / paid)}</b>`}。照你事先決定的停損計畫走就好，不要為了攤平再加碼。` });
  }
  for (const o of c.optRows) {
    const oc = occ(o.sym), S = quotes[oc.root]?.price, dte = days(today(), oc.exp);
    const itm = S && (oc.call ? S > oc.strike : S < oc.strike);
    if (o.qty < 0 && itm) out.push({ lvl: 'danger', tag: '選擇權', msg: `賣出的 ${esc(optName(o.sym))} 已經<b>價內</b>（標的 ${usd(S)}），到期可能被指派` });
    else if (dte <= a.dte) out.push({ lvl: 'warn', tag: '選擇權', msg: `${esc(optName(o.sym))} 還有 <b>${Math.max(dte, 0)} 天</b>到期` });
  }
  return out;
}
function renderAlertBar(alerts) {
  const bar = el('alertBar'); if (!bar) return;
  const key = 'dismiss.' + today();
  const dismissed = new Set((store.get(key, '') || '').split('|').filter(Boolean));
  const show = alerts.filter(a => !dismissed.has(a.msg));
  bar.hidden = !show.length;
  bar.innerHTML = show.map(a => `<div class="alert-item ${a.lvl}"><span class="badge">${a.tag}</span><span class="msg">${a.msg}</span>
    <button class="ghost" data-dismiss="${esc(a.msg)}" title="今天不再顯示">✕</button></div>`).join('');
}
// ============ 風險報酬指標與回撤 ============
let metricsRange = store.get('metricsRange', '0');
const hasOutside = () => data.transactions.some(t => t.type === 'income' && (t.category || '').startsWith('帳外獲利'));
const outsideAsFlow = () => hasOutside() && store.get('outsideAsFlow', '0') === '1';
const outsideToggle = () => hasOutside() ? `<label class="check" style="margin:0 0 10px"><input type="checkbox" id="outsideFlowChk" ${outsideAsFlow() ? 'checked' : ''}>
  把帳外獲利當入金（只看美股帳戶本身的績效，不讓別處的獲利灌高報酬）</label>` : '';
function seriesStats(rets, from, to, rf) {
  if (rets.length < 2) return null;
  const rs = rets.map(x => x.r);
  let idx = 1, top = 1, mdd = 0, peakD = from, trough = null, ddPeak = from, recov = null, curPeak = from;
  for (const x of rets) {
    idx *= 1 + x.r;
    if (idx >= top) { top = idx; curPeak = x.date; }
    const dd = idx / top - 1;
    if (dd < mdd) { mdd = dd; trough = x.date; ddPeak = curPeak; recov = null; }
  }
  // 最大回撤之後有沒有回到前高
  if (trough) {
    let i2 = 1, top2 = 1, seenTrough = false;
    for (const x of rets) {
      i2 *= 1 + x.r;
      if (x.date === ddPeak) top2 = i2;
      if (x.date === trough) seenTrough = true;
      if (seenTrough && x.date > trough && i2 >= top2 - 1e-12) { recov = x.date; break; }
    }
  }
  const total = idx - 1, yrs = Math.max(days(from, to), 1) / 365;
  const vol = std(rs) * Math.sqrt(252), down = Math.sqrt(avg(rs.map(r => Math.min(r, 0) ** 2))) * Math.sqrt(252);
  const excess = avg(rs) * 252 - rf;
  return { total, ann: yrs >= 0.25 ? (1 + total) ** (1 / yrs) - 1 : null, vol, sharpe: vol ? excess / vol : null, sortino: down ? excess / down : null,
           mdd, ddPeak, trough, recov, curDD: idx / top - 1, best: Math.max(...rs), worst: Math.min(...rs), pos: rs.filter(r => r > 0).length / rs.length,
           calmar: mdd ? ((yrs >= 0.25 ? (1 + total) ** (1 / yrs) - 1 : total) / -mdd) : null };
}
function betaCorr(a, b) {
  const n = Math.min(a.length, b.length); if (n < 10) return { beta: null, corr: null };
  const ma = avg(a), mb = avg(b);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { cov += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
  return { beta: vb ? cov / vb : null, corr: va && vb ? cov / Math.sqrt(va * vb) : null };
}
function renderMetrics() {
  const box = el('metricsBox'); if (!box) return;
  document.querySelectorAll('[data-x="metrics"]').forEach(b => b.classList.toggle('on', b.dataset.v === metricsRange));
  const hist = inRange(data.history, metricsRange);
  const rets = dailyReturns(hist, outsideAsFlow());
  if (rets.length < 5) { box.innerHTML = outsideToggle() + '<div class="empty">資料不足（至少要 5 個交易日）</div>'; el('ddBox').innerHTML = ''; return; }
  const from = hist[0].date, to = hist.at(-1).date, rf = riskFree(from, to);
  const me = seriesStats(rets, from, to, rf);
  // 大盤在同樣的日期區間
  const bmRets = s => rets.map(x => ({ date: x.date, r: benchRet(s, x.prev, x.date) })).filter(x => x.r != null);
  const qqq = benchOk('QQQ') ? seriesStats(bmRets('QQQ'), from, to, rf) : null;
  const voo = benchOk('VOO') ? seriesStats(bmRets('VOO'), from, to, rf) : null;
  const paired = s => { const m = [], b = []; for (const x of rets) { const r = benchRet(s, x.prev, x.date); if (r != null) { m.push(x.r); b.push(r); } } return betaCorr(m, b); };
  const bq = paired('QQQ'), bv = paired('VOO');
  const n2 = v => v == null || !isFinite(v) ? '—' : v.toFixed(2);
  const rows = [
    ['期間報酬', s => pct(s?.total)], ['年化報酬', s => s?.ann == null ? '—' : pct(s.ann)], ['年化波動度', s => s ? pctPlain(s.vol, 1) : '—'],
    ['夏普比率', s => n2(s?.sharpe)], ['索提諾比率', s => n2(s?.sortino)], ['最大回撤', s => s ? pct(s.mdd) : '—'],
    ['卡瑪比率（年化報酬 ÷ 最大回撤）', s => n2(s?.calmar)], ['目前距高點', s => s ? pct(s.curDD) : '—'],
    ['最好的一天', s => s ? pct(s.best, 2) : '—'], ['最差的一天', s => s ? pct(s.worst, 2) : '—'], ['上漲天數比例', s => s ? pctPlain(s.pos) : '—'],
  ];
  box.innerHTML = outsideToggle() + `${UI.tiles([
      { k: `年化報酬`, v: `${me.ann == null ? pct(me.total) : pct(me.ann)}`, s: `${me.ann == null ? '期間太短，顯示期間報酬' : `期間 ${from} ～ ${to}`}`, vcls: `num ${cls(me.ann ?? me.total)}` },
      { k: `夏普比率`, v: `${n2(me.sharpe)}`, s: `每承擔一單位波動，多賺多少（無風險利率 ${pctPlain(rf, 2)}）` },
      { k: `最大回撤`, v: `${pct(me.mdd)}`, s: `${me.trough ? `${me.ddPeak} 高點 → ${me.trough} 低點${me.recov ? `，${me.recov} 回到前高` : '，還沒回到前高'}` : '—'}`, vcls: `num down` },
      { k: `Beta（對 Nasdaq 100）`, v: `${n2(bq.beta)}`, s: `大盤漲跌 1%，你平均漲跌約 <span class="money">${n2(bq.beta)}%</span>；相關係數 <span class="money">${n2(bq.corr)}</span>` },
      { k: `Beta（對 S&P 500）`, v: `${n2(bv.beta)}`, s: `相關係數 <span class="money">${n2(bv.corr)}</span>` }])}
    <div class="table-wrap"><table class="table">
      <thead><tr><th class="l">指標</th><th>我的組合</th><th>Nasdaq 100</th><th>S&P 500</th></tr></thead>
      <tbody>${rows.map(([k, f]) => `<tr><td class="l">${k}</td><td class="num"><b>${f(me)}</b></td><td class="num">${f(qqq)}</td><td class="num">${f(voo)}</td></tr>`).join('')}</tbody>
    </table></div>`;
  // 回撤圖：每天距離前高跌了多少
  let idx = 1, top = 1;
  const dd = [{ x: +new Date(from), y: 0, label: from, d: from }];
  for (const x of rets) { idx *= 1 + x.r; top = Math.max(top, idx); dd.push({ x: +new Date(x.date), y: (idx / top - 1) * 100, label: x.date, d: x.date }); }
  dd.at(-1).label = to;
  lineChart(el('ddBox'), dd, { fmtY: v => v.toFixed(0) + '%', fmtTip: p => `${p.d}<br>距高點 <b>${p.y.toFixed(2)}%</b>`, color: 'var(--down)', zero: true });
  el('metricsNote').textContent = '回撤圖：每天距離之前最高點跌了多少（時間加權，不受入金影響）。夏普、索提諾用日報酬年化；年化數字在期間短於 3 個月時不顯示。';
}

// ============ 每月報酬 ============
function renderHeat() {
  const box = el('heatBox'); if (!box) return;
  const rets = dailyReturns(data.history, outsideAsFlow());
  if (!rets.length) { box.innerHTML = '<div class="empty">資料不足</div>'; return; }
  const me = {}, qq = {};
  for (const x of rets) {
    const m = x.date.slice(0, 7);
    me[m] = (me[m] ?? 1) * (1 + x.r);
    const b = benchRet('QQQ', x.prev, x.date);
    if (b != null) qq[m] = (qq[m] ?? 1) * (1 + b);
  }
  const years = [...new Set(Object.keys(me).map(m => m.slice(0, 4)))].sort().reverse();
  const color = v => {
    if (v == null) return '';
    const a = Math.min(Math.abs(v) / 0.15, 1) * 55 + 6;   // ±15% 以上顏色最深
    return `background:color-mix(in srgb, var(${v >= 0 ? '--up' : '--down'}) ${a.toFixed(0)}%, transparent)`;
  };
  const cell = (map, ym, main) => {
    if (!(ym in map)) return `<td class="na">${main ? '·' : ''}</td>`;
    const v = map[ym] - 1;
    return main ? `<td class="num heat-cell" style="${color(v)}" title="${ym}：${pct(v)}（Nasdaq 100 ${pct((qq[ym] ?? NaN) - 1)}）・點一下看這個月的交易紀錄"><a href="/trades?ym=${ym}">${pct(v, 1)}</a></td>` : `<td class="num">${pct(v, 1)}</td>`;
  };
  const yearTotal = (map, y) => { const ms = Object.keys(map).filter(m => m.startsWith(y)); return ms.length ? ms.reduce((p, m) => p * map[m], 1) - 1 : null; };
  box.innerHTML = `<div class="table-wrap"><table class="heat">
    <thead><tr><th></th>${Array.from({ length: 12 }, (_, i) => `<th>${i + 1}月</th>`).join('')}<th>全年</th></tr></thead>
    <tbody>${years.map(y => {
      const yt = yearTotal(me, y), qt = yearTotal(qq, y);
      return `<tr><td class="lbl"><b>${y}</b></td>${Array.from({ length: 12 }, (_, i) => cell(me, `${y}-${String(i + 1).padStart(2, '0')}`, true)).join('')}
          <td class="num heat-cell" style="${color(yt)}" title="點一下看 ${y} 年的交易紀錄"><a href="/trades?y=${y}"><b>${pct(yt, 1)}</b></a></td></tr>
        <tr class="bm"><td class="lbl">Nasdaq 100</td>${Array.from({ length: 12 }, (_, i) => cell(qq, `${y}-${String(i + 1).padStart(2, '0')}`, false)).join('')}<td class="num">${pct(qt, 1)}</td></tr>`;
    }).join('')}</tbody></table></div>
    <div class="note">${outsideAsFlow() ? '目前把帳外獲利當入金計算（上方開關）。' : ''}每格是那個月的時間加權報酬；顏色越深代表漲跌越大。灰色那一列是同期 Nasdaq 100，方便比較。點任何一格可以看那個月的交易紀錄。</div>`;
}

// ============ 個股曝險總覽：把 ETF 拆成成分股 ============
const PROXY_ETF = { SPX: 'VOO', NDX: 'QQQ', SOX: 'SOXX' };   // 槓桿、反向 ETF 改用同一個指數的 ETF 成分股計算
const etfData = {}, etfAsked = new Set();
let expoAll = false, etfView = store.get('etfView', '');
const titleCase = s => s && s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, ch => ch.toUpperCase()) : s;
function etfsFor(syms) {
  // 這些部位要用到哪些 ETF 的成分股：一倍 ETF 用自己的，另外都備一份同指數的 ETF
  const out = new Set();
  for (const s of syms) { const g = grp(s); if (!PROXY_ETF[g]) continue; if (levOf(s) === 1) out.add(s); out.add(PROXY_ETF[g]); }
  return [...out];
}
const heldSyms = c => [...new Set([...c.rows.map(r => r.sym), ...c.optRows.map(o => occ(o.sym).root)])];
async function loadEtfs(syms) {
  const todo = syms.filter(s => !etfAsked.has(s)); if (!todo.length) return;
  todo.forEach(s => etfAsked.add(s));
  try { Object.assign(etfData, await (await fetch('/api/etf-holdings?symbols=' + todo.join(','))).json()); }
  catch { todo.forEach(s => { etfData[s] = { error: '連不上伺服器' }; }); }
  const c = calc(); renderExposure(c); renderEtfView(c); renderTreemap(c); renderEvents(c);
}
function etfSource(sym) {
  // 回傳要拆的 ETF 代號；undefined 代表還在載入，null 代表沒辦法拆
  const g = grp(sym), proxy = PROXY_ETF[g];
  if (levOf(sym) === 1) { const own = etfData[sym]; if (!own) return undefined; if (own.stocks) return sym; }
  const p = etfData[proxy]; if (!p) return undefined;
  return p.stocks ? proxy : null;
}
function positionExposure(c) {
  // 每個部位的曝險：股票／ETF ＝ 市值 × 槓桿倍數；買方選擇權用 delta 換算；賣方選擇權跟槓桿率一樣不計入
  const out = [];
  for (const r of c.rows) if (r.value != null) {
    const cash = grp(r.sym) === 'CASH';   // 國庫券類列市值參考，不算曝險
    out.push({ sym: r.sym, label: r.sym + (r.lev !== 1 && !cash ? ` ×${r.lev}` : ''), val: cash ? r.value : r.value * r.lev });
  }
  for (const o of c.optRows) {
    const oc = occ(o.sym), S = quotes[oc.root]?.price;
    if (o.qty > 0 && o.delta != null && S) out.push({ sym: oc.root, label: optName(o.sym), val: o.qty * 100 * o.delta * S * levOf(oc.root) });
  }
  return out;
}
function stockExposure(c) {
  const stocks = {}, other = {}, names = {};
  let pending = false;
  const add = (bucket, key, name, val, via) => {
    const G = bucket[key] ??= { key, name, total: 0, via: {} };
    G.total += val; G.via[via] = (G.via[via] || 0) + val;
  };
  for (const p of positionExposure(c)) {
    const g = grp(p.sym);
    if (g === 'CASH') { add(other, 'CASH', '現金類（短天期國庫券，不算曝險）', p.val, p.label); continue; }
    if (['BTC', 'SILVER', 'GOLD'].includes(g)) { add(other, g, grpName(g), p.val, p.label); continue; }
    if (!PROXY_ETF[g]) { add(stocks, g, GROUP_NAME[g] || '', p.val, p.label); continue; }
    const src = etfSource(p.sym);
    if (!src) {
      if (src === undefined) pending = true;
      add(other, g, `${grpName(g)}（${src === undefined ? '成分股載入中' : '抓不到成分股'}）`, p.val, p.label); continue;
    }
    const d = etfData[src], via = src === p.sym ? p.label : `${p.label}（依 ${src} 成分股）`;
    let inTop = 0;
    for (const h of d.top) if (h.sym) {
      const k = grp(h.sym); inTop += h.w;
      names[k] ??= h.name;
      add(stocks, k, GROUP_NAME[k] || titleCase(h.name), p.val * h.w / 100, via);
    }
    if (inTop < 99.9) add(other, 'REST', 'ETF 前 50 名以外的持股', p.val * (100 - inTop) / 100, via);
  }
  const sort = o => Object.values(o).sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  const shorts = c.optRows.filter(o => o.qty < 0).length;
  return { stocks: sort(stocks), other: sort(other), pending, shorts };
}
function renderExposure(c) {
  const box = el('exposureBox'); if (!box) return;
  loadEtfs(etfsFor(heldSyms(c)));
  const { stocks, other, pending, shorts } = stockExposure(c), eq = c.totalUSD;
  if (!stocks.length && !other.length) { box.innerHTML = '<div class="empty">目前沒有持股</div>'; el('exposureNote').textContent = ''; return; }
  const sum = stocks.reduce((s, g) => s + g.total, 0), top5 = stocks.slice(0, 5).reduce((s, g) => s + g.total, 0);
  const max = Math.max(...stocks.concat(other).map(g => Math.abs(g.total)), 1);
  el('exposureNote').innerHTML = stocks[0] ? `最大：${esc(stocks[0].key)} <span class="money">${pctPlain(stocks[0].total / eq)}</span> 淨資產` : '';
  const row = (g, muted) => {
    const share = g.total / eq, w = Math.abs(g.total) / max * 100;
    const via = Object.entries(g.via).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    return `<div class="hbar-row expo-row ${muted ? 'muted-row' : ''}"><div class="hbar-name">${muted ? esc(g.name) : `${esc(g.key)} <span class="sub">${esc(g.name || '')}</span>`}</div>
      <div class="hbar-track"><i class="${g.total >= 0 ? '' : 'neg'}" style="left:0;width:${w}%"></i></div>
      <div class="hbar-val num">${usd0(g.total)} <span class="sub">${pctPlain(share, 1)} 淨資產</span></div>
      <div class="hbar-items">${via.map(([k, v]) => `<span class="pill">${esc(k)} ${usd0(v)}</span>`).join('')}</div></div>`;
  };
  const shown = expoAll ? stocks : stocks.slice(0, 15);
  box.innerHTML = `${UI.tiles([
      { k: `個股曝險合計`, v: `${usd0(sum)}`, s: `淨資產的 <span class="money">${pctPlain(sum / eq)}</span>` },
      { k: `涵蓋公司`, v: `${stocks.length} 家`, s: `ETF 只拆前 50 大持股`, vcls: `` },
      { k: `前 5 大公司合計`, v: `${pctPlain(top5 / eq)}`, s: `佔淨資產` }])}
    ${pending ? '<div class="sub" style="margin-bottom:6px">正在抓 ETF 成分股…</div>' : ''}
    ${shown.map(g => row(g)).join('')}
    ${stocks.length > 15 ? `<button class="ghost" data-expo-all="1" style="margin-top:8px">${expoAll ? '只看前 15 家' : `顯示全部 ${stocks.length} 家`}</button>` : ''}
    ${other.length ? `<div class="sub" style="margin:14px 0 2px">不是個股的部分</div>${other.map(g => row(g, true)).join('')}` : ''}
    <div class="note">曝險＝市值 × 槓桿倍數。ETF 依成分股權重拆開，例如 100 元的 VOO 裡約有 ${(etfData.VOO?.top?.[0]?.w ?? 8).toFixed(1)} 元是 ${esc(etfData.VOO?.top?.[0]?.sym || 'NVDA')}；
      槓桿、反向 ETF 用同一個指數的 ETF 成分股乘上倍數；GOOG／GOOGL 這類同公司不同股別合併計算。買方選擇權用 delta 換算${shorts ? `；賣方選擇權（${shorts} 筆）跟槓桿率一樣不計入` : ''}。
      成分股資料來自 Zacks，每天更新一次。</div>`;
}
function renderEtfView(c) {
  const box = el('etfBox'); if (!box) return;
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  // 選單：你持有的 ETF（槓桿 ETF 換成它依據的 ETF），加上查過的
  const size = {};
  for (const p of positionExposure(c)) size[p.sym] = (size[p.sym] || 0) + Math.abs(p.val);
  const hs = heldSyms(c).filter(s => PROXY_ETF[grp(s)]).sort((a, b) => (size[b] || 0) - (size[a] || 0));   // 部位大的排前面
  const list = [...new Set(hs.map(s => levOf(s) === 1 ? s : PROXY_ETF[grp(s)]))];
  if (!etfView) etfView = list[0] || 'VOO';
  if (!list.includes(etfView)) list.push(etfView);
  loadEtfs([etfView]);
  const d = etfData[etfView];
  // 你持有的部位裡，有多少是透過這檔 ETF
  const mine = positionExposure(c).filter(p => etfSource(p.sym) === etfView).reduce((s, p) => s + p.val, 0);
  const head = `<div class="etf-ctl"><span class="seg">${list.map(s => `<button data-etf="${esc(s)}" class="${s === etfView ? 'on' : ''}">${esc(s)}</button>`).join('')}</span>
    <span class="etf-look"><input id="etfLookup" placeholder="查其他 ETF，例如 QQQ" style="text-transform:uppercase"><button class="ghost" id="etfLookupBtn">查詢</button></span></div>`;
  if (!d) { box.innerHTML = head + '<div class="empty">正在抓成分股…</div>'; return; }
  if (d.error) { box.innerHTML = head + `<div class="empty">抓不到 ${esc(etfView)} 的成分股：${esc(d.error)}</div>`; return; }
  const maxW = Math.max(...d.top.map(h => h.w), 1);
  box.innerHTML = head + `
    ${d.stocks ? '' : `<div class="sub" style="margin:8px 0">${esc(etfView)} 主要持有交換合約或選擇權，不是直接持有股票，所以曝險總覽不會用它來拆。</div>`}
    <div class="sub" style="margin:8px 0">共 ${d.count} 檔持股，前 ${d.top.length} 大合計 ${d.topSum.toFixed(1)}%${mine ? `・你透過 ${esc(etfView)} 的曝險 <span class="money">${usd0(mine)}</span>` : ''}</div>
    <div class="table-wrap"><table class="table etf-table"><thead><tr><th>#</th><th class="l">代號</th><th class="l">公司</th><th>每 100 元裡</th>${mine ? '<th>你的曝險</th>' : ''}</tr></thead>
      <tbody>${d.top.map((h, i) => `<tr><td class="rank">${i + 1}</td><td class="l"><b>${esc(h.sym || '—')}</b></td><td class="l name">${esc(titleCase(h.name))}</td>
        <td class="w" style="--w:${(h.w / maxW * 100).toFixed(1)}%">${h.w.toFixed(2)} 元</td>${mine ? `<td><span class="money">${usd0(mine * h.w / 100)}</span></td>` : ''}</tr>`).join('')}</tbody></table></div>
    <div class="note">資料來自 Zacks（${new Date(d.fetched * 1000).toLocaleDateString('zh-TW')} 抓取${d.stale ? '，今天抓不到，先用上次的資料' : ''}），ETF 的持股每天會小幅變動。</div>`;
}

// ============ 交易計畫：新交易先寫計畫，等滿交易日才下單 ============
// 我的守則（固定的，計畫表單和上方提醒都照這個檢查）：
// 1. 不做選擇權買方（買回自己賣出的可以）
// 2. 新交易先寫計畫，寫完至少等 3 個交易日；計畫裡寫好的條件不用再等；違反守則開的倉可以隨時平倉
// 3. 單一個股最多佔總資產 20%，超過 25% 減碼回 20%；sell put 以履約價 × 100 計算；大盤型 ETF 不受限
// 4. 禁止交易槓桿、反向 ETF（包含 SOXL 這類大盤型）；已經持有的可以賣出、平倉
const RULES = { wait: 3, cap: 20, trim: 25 };
const PLAN_ACTIONS = { buy: '買進', sell: '賣出', dca: '定期買進', sellput: 'Sell put', sellcall: 'Sell call' };
const OPT_LEGS = { open: '開倉', close: '平倉', roll: 'Roll' };
const OLD_ACTION = { reduce: 'sell', cc: 'sellcall', roll: 'sellput' };   // 舊版計畫的動作名稱
const actOf = p => OLD_ACTION[p.action] || p.action;
const legOf = p => p.leg || (p.action === 'roll' ? 'roll' : 'open');
const isOptAct = a => a === 'sellput' || a === 'sellcall';
const isClosing = (a, leg) => a === 'sell' || (isOptAct(a) && leg !== 'open');
const planLabel = p => { const a = actOf(p), l = legOf(p); return (PLAN_ACTIONS[a] || '') + (isOptAct(a) && l !== 'open' ? ' ' + OPT_LEGS[l] : ''); };
const isWeekday = d => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w !== 0 && w !== 6; };
function addTradingDays(d, n) {
  let t = new Date(d + 'T12:00:00Z').getTime(), k = 0;
  while (k < n) { t += 864e5; if (isWeekday(new Date(t).toISOString().slice(0, 10))) k++; }
  return new Date(t).toISOString().slice(0, 10);
}
function tradingDaysBetween(a, b) { let n = 0, t = a; while (t < b) { t = addTradingDays(t, 1); n++; } return n; }
const planExec = p => addTradingDays(p.created, p.wait ?? RULES.wait);
const planState = p => p.status === 'void' ? 'void' : p.status === 'closed' ? 'closed' : today() < planExec(p) ? 'waiting' : 'ready';
const sameGroup = (a, b) => grp(a) === grp(b);
const isSingleStock = s => !INDEX_GROUPS.has(grp(s));                     // 大盤、類股、國庫券、商品 ETF 不算個股
const isLevEtf = s => grp(s) !== 'CASH' && levOf(s) !== 1;               // 槓桿、反向 ETF（GGLL、SOXL、SQQQ…）
const heldGroup = (c, sym) => c.rows.some(r => sameGroup(r.sym, sym)) || c.optRows.some(o => sameGroup(occ(o.sym).root, sym));
function freeClose(f, c) {
  // 守則 2 的例外：當初沒寫計畫就開的倉（違反守則開的），平倉不用等
  return isClosing(f.action, f.leg) && heldGroup(c, f.sym) &&
    !(data.plans || []).some(p => p.id !== planEditId && p.status !== 'void' && sameGroup(p.sym, f.sym) && !isClosing(actOf(p), legOf(p)));
}
function capExposure(c, extra) {
  // 個股持股市值，加上 sell put 的「履約價 × 100」；extra 是計畫中還沒成交的部位
  const g = {};
  const add = (s, v) => { if (isSingleStock(s)) g[grp(s)] = (g[grp(s)] || 0) + v; };
  for (const r of c.rows) if (r.value != null) add(r.sym, r.value);
  for (const o of c.optRows) { const oc = occ(o.sym); if (o.qty < 0 && !oc.call) add(oc.root, oc.strike * 100 * -o.qty); }
  if (extra?.sym && extra.amount) add(extra.sym, extra.amount);
  return Object.entries(g).map(([k, v]) => ({ g: k, v, pct: v / c.totalUSD })).sort((a, b) => b.v - a.v);
}

let planEditId = null;   // 正在編輯的計畫；null 代表寫新的
const PF = ['sym', 'action', 'leg', 'qty', 'price', 'exp', 'when', 'repeat', 'thesis', 'entry'];
const REPEAT = { '': '不重複', week: '每週', month: '每月' };
const WEEKDAY = '日一二三四五六';
const fmtDay = d => `${d.slice(5).replace('-', '/')}（${WEEKDAY[new Date(d + 'T12:00:00Z').getUTCDay()]}）`;
function addMonthsKeepDay(d, n, day) {
  // 每月同一天；那個月沒有這一天（例如 31 號）就用月底
  const [y, m] = d.split('-').map(Number), t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return t.toISOString().slice(0, 10);
}
function planNextDate(p) {
  // 計畫裡的下一次買進日：不重複就是填的那天；重複的話往後找第一個「今天以後、而且等待期已過」的日期
  if (!p.when) return null;
  if (!p.repeat) return p.when;
  const exec = p.created ? planExec(p) : addTradingDays(today(), RULES.wait), from = exec > today() ? exec : today();
  const day = +p.when.slice(8);
  let d = p.when, i = 0;
  while (d < from && i < 1000) { i++; d = p.repeat === 'week' ? new Date(new Date(p.when + 'T12:00:00Z').getTime() + i * 7 * 864e5).toISOString().slice(0, 10) : addMonthsKeepDay(p.when, i, day); }
  return d;
}
function readPlanForm() {
  const f = {}; document.querySelectorAll('#planForm [data-pf]').forEach(i => { f[i.dataset.pf] = i.value; });
  f.sym = (f.sym || '').trim().toUpperCase(); f.action ||= 'buy'; f.leg ||= 'open';
  return f;
}
function fillPlanForm(p) {
  const v = { ...(p || {}), action: p?.action ? actOf(p) : 'buy', leg: p?.action ? legOf(p) : 'open' };
  document.querySelectorAll('#planForm [data-pf]').forEach(i => { i.value = v[i.dataset.pf] ?? ''; });
}
function planAmount(f) {
  const q = parseFloat(f.qty) || 0, isOpt = isOptAct(f.action), px = parseFloat(f.price) || (isOpt ? 0 : quotes[f.sym]?.price || 0);
  if (f.action === 'sellput' && f.leg === 'open') return q * 100 * px;      // 被指派時要付的錢
  return isOpt ? 0 : q * px;
}
function planWarnings(f, c) {
  const w = [], sym = f.sym;
  if (!sym) return w;
  const closing = isClosing(f.action, f.leg);
  if (isLevEtf(sym) && !closing) w.push({ bad: true, t: `守則 4：${esc(sym)} 是槓桿／反向 ETF，不能交易（已經持有的可以賣出、平倉）` });
  if (freeClose(f, c)) w.push({ t: '這個部位當初沒寫計畫就開了，照守則可以隨時平倉，不用等' });
  const amt = planAmount(f);
  if (['buy', 'dca'].includes(f.action) || (f.action === 'sellput' && f.leg === 'open')) if (amt > 0 && isSingleStock(sym) && !isLevEtf(sym)) {
    const after = capExposure(c, { sym, amount: amt }).find(x => x.g === grp(sym));
    if (after && after.pct * 100 > RULES.cap) w.push({ bad: true, t: `守則 3：交易後 ${esc(grpName(grp(sym)))} 會佔總資產 <span class="money">${pctPlain(after.pct)}</span>，超過 ${RULES.cap}%` });
    else if (after) w.push({ t: `交易後 ${esc(grpName(grp(sym)))} 佔總資產 <span class="money">${pctPlain(after.pct)}</span>（上限 ${RULES.cap}%）` });
  }
  if (f.action === 'sellcall' && f.leg === 'open') {
    const have = c.rows.filter(r => sameGroup(r.sym, sym)).reduce((s, r) => s + r.shares, 0), need = 100 * (parseFloat(f.qty) || 0);
    if (need > have) w.push({ bad: true, t: `Sell call 要先持有 ${need} 股 ${esc(sym)}（目前 ${have} 股），不然就是賣裸 call` });
  }
  if (f.when) {
    const exec = planEditId ? planExec(data.plans.find(p => p.id === planEditId) || { created: today() }) : addTradingDays(today(), RULES.wait);
    const next = planNextDate({ when: f.when, repeat: f.repeat, created: planEditId ? data.plans.find(p => p.id === planEditId)?.created : null });
    if (!f.repeat && f.when < today()) w.push({ bad: true, t: `買進日期 ${f.when} 已經過了` });
    else if (!f.repeat && f.when < exec) w.push({ bad: true, t: `買進日期 ${fmtDay(f.when)} 還在等待期內，最早 ${exec} 才能下單` });
    else if (f.repeat && f.when < exec) w.push({ t: `等待期內的那幾次先跳過，第一次買進是 ${fmtDay(next)}` });
    if (!isWeekday(next)) w.push({ t: `${fmtDay(next)} 是週末，美股沒開，請改到交易日或那週的下一個交易日買` });
  }
  return w;
}
function updatePlanCalc() {
  const box = el('planForm'); if (!box) return;
  const c = calc(), f = readPlanForm(), isOpt = isOptAct(f.action);
  box.querySelectorAll('[data-pf-act]').forEach(b => b.classList.toggle('on', b.dataset.pfAct === f.action));
  box.querySelectorAll('[data-pf-leg]').forEach(b => b.classList.toggle('on', b.dataset.pfLeg === f.leg));
  box.querySelector('[data-pf-label="qty"]').textContent = isOpt ? '口數' : '股數';
  box.querySelector('[data-pf-label="price"]').textContent = isOpt ? '履約價' : '價格';
  box.querySelectorAll('[data-pf-opt]').forEach(x => { x.hidden = !isOpt; });
  box.querySelector('[data-pf="repeat"]').disabled = !f.when;   // 有填日期才需要選重複
  box.querySelector('[data-pf="price"]').placeholder = !isOpt && quotes[f.sym]?.price ? `現價 ${quotes[f.sym].price}` : '';
  const amt = planAmount(f);
  el('planCalc').innerHTML = amt ? `金額 <span class="money">${usd0(amt)}</span>${isOpt ? '（被指派時要付）' : ''}・佔總資產 <span class="money">${pctPlain(amt / c.totalUSD, 1)}</span>` : '';
  el('planWarn').innerHTML = planWarnings(f, c).map(x => `<div class="plan-warn ${x.bad ? 'bad' : ''}">${x.bad ? '⚠️' : '・'} ${x.t}</div>`).join('');
  el('planWhen').textContent = planEditId ? `編輯中：最早 ${planExec(data.plans.find(p => p.id === planEditId) || { created: today() })} 可以下單`
    : freeClose(f, c) ? '存檔後就可以執行（違反守則開的倉，平倉不用等）' : `今天寫好，最早 ${addTradingDays(today(), RULES.wait)} 可以下單`;
  if (!planEditId) store.set('planDraft', JSON.stringify(f));
}
function buildPlanComposer(c) {
  const box = el('planComposer'); if (!box || box.dataset.built) return;
  box.dataset.built = '1';
  box.innerHTML = `<div class="pc" id="planForm">
    <div class="pc-top">
      <label class="field pc-sym"><span>標的</span><input data-pf="sym" list="planSyms" placeholder="例如 VOO" autocomplete="off"></label>
      <div class="field"><span>要做什麼</span><div class="chips">${Object.entries(PLAN_ACTIONS).map(([k, t]) => `<button type="button" data-pf-act="${k}">${t}</button>`).join('')}</div></div>
      <div class="field" data-pf-opt hidden><span>開倉或平倉</span><div class="chips">${Object.entries(OPT_LEGS).map(([k, t]) => `<button type="button" data-pf-leg="${k}">${t}</button>`).join('')}</div></div>
      <input type="hidden" data-pf="action" value="buy"><input type="hidden" data-pf="leg" value="open">
    </div>
    <div class="pc-nums">
      <label class="field"><span data-pf-label="qty">股數</span><input type="number" step="any" min="0" data-pf="qty"></label>
      <label class="field"><span data-pf-label="price">價格</span><input type="number" step="any" min="0" data-pf="price"></label>
      <label class="field" data-pf-opt hidden><span>到期日</span><input type="date" data-pf="exp"></label>
      <label class="field"><span>買進日期（選填）</span><input type="date" data-pf="when"></label>
      <label class="field"><span>重複</span><select data-pf="repeat">${Object.entries(REPEAT).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select></label>
      <div class="pc-calc" id="planCalc"></div>
    </div>
    <div class="pc-grid">
      <label class="field wide"><span>為什麼要做（一兩句就好）</span><textarea data-pf="thesis" rows="2"></textarea></label>
      <label class="field wide"><span>價格或條件</span><input data-pf="entry" placeholder="例如：回到 330 以下再買、收盤跌破 315 就賣"></label>
    </div>
    <div id="planWarn"></div>
    <div class="form-foot"><span class="sub" id="planWhen"></span><button class="ghost" data-plan-cancel="1">清空</button><button class="primary" data-plan-save="1">存檔</button></div>
  </div><datalist id="planSyms"></datalist>`;
  let draft = null; try { draft = JSON.parse(store.get('planDraft', 'null')); } catch { /* 草稿壞了就算了 */ }
  fillPlanForm(draft);
}
function savePlan() {
  const f = readPlanForm(), c = calc();
  if (!f.sym) { el('planForm').querySelector('[data-pf="sym"]').focus(); toast('先填標的'); return; }
  if (!f.thesis.trim()) { el('planForm').querySelector('[data-pf="thesis"]').focus(); toast('寫一兩句為什麼要做'); return; }
  const old = (data.plans || []).find(p => p.id === planEditId), amt = planAmount(f);
  const num = k => parseFloat(f[k]) || null;
  const p = { ...(old || { id: uid(), ts: Date.now(), created: today(), wait: freeClose(f, c) ? 0 : RULES.wait, status: 'active' }),
    sym: f.sym, action: f.action, leg: isOptAct(f.action) ? f.leg : null, qty: num('qty'), price: num('price'), exp: isOptAct(f.action) ? f.exp || null : null,
    amount: Math.round(amt) || null, pct: amt ? amt / c.totalUSD : null,
    thesis: f.thesis.trim(), entry: f.entry.trim(), when: f.when || null, repeat: f.when ? f.repeat || null : null };
  data.plans = [...(data.plans || []).filter(x => x !== old), p];
  planEditId = null; store.set('planDraft', 'null'); fillPlanForm(null);
  save(); updatePlanCalc(); window.renderExtras();
  toast(old ? '計畫更新了' : `存好了，最早 ${planExec(p)} 可以下單`);
}
function editPlan(id) {
  const p = (data.plans || []).find(x => x.id === id); if (!p) return;
  planEditId = id; fillPlanForm(p); updatePlanCalc();
  el('planForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function planTrades(p) {
  // 照這份計畫執行的交易：同一個標的、在可以下單那天之後
  const from = planExec(p), to = p.closedAt || '9999';
  return data.transactions.filter(t => t.date >= from && t.date <= to &&
    (((t.type === 'buy' || t.type === 'sell') && sameGroup(t.symbol, p.sym)) || (t.type === 'option' && sameGroup(occ(t.symbol)?.root || '', p.sym))));
}
const planDots = p => {
  // 等待期的圓點：每個交易日一顆，過了就填滿
  const wait = p.wait ?? RULES.wait, left = planState(p) === 'waiting' ? tradingDaysBetween(today(), planExec(p)) : 0;
  return `<span class="pl-dots" title="還要 ${left} 個交易日">${Array.from({ length: wait }, (_, i) => `<i class="${i < wait - left ? 'on' : ''}"></i>`).join('')}</span>`;
};
function planWatch(p) {
  const a = actOf(p), px = quotes[p.sym]?.price;
  if (a === 'dca' || !p.price || px == null) return null;
  if (isOptAct(a)) return { px, opt: true, gap: px / p.price - 1 };
  const hit = a === 'sell' ? px >= p.price : px <= p.price;
  return { px, hit, gap: a === 'sell' ? p.price / px - 1 : px / p.price - 1 };
}
const planWatchText = w => !w ? '' : w.opt ? `現價 <span class="money">${usd(w.px)}</span>・距履約價 <span class="money">${pct(w.gap, 1)}</span>`
  : w.hit ? `<span class="pl-hit">✓ 到價了</span>・現價 <span class="money">${usd(w.px)}</span>`
  : `現價 <span class="money">${usd(w.px)}</span>・還差 <span class="money">${pctPlain(Math.abs(w.gap), 1)}</span>`;
function planCells(p) {
  // 每一列固定三欄：標的／動作、數量／價格、狀態
  const st = planState(p), exec = planExec(p), next = planNextDate(p), a = actOf(p);
  const left = st === 'waiting' ? tradingDaysBetween(today(), exec) : 0;
  const unit = isOptAct(a) ? '口' : '股';
  const watch = ['waiting', 'ready'].includes(st) ? planWatch(p) : null;
  // 中間：觸發條件（等待中的計畫改顯示現價，等的時候也看得到離目標多遠）
  const trigger = p.price && !isOptAct(a) && a !== 'dca' ? `${a === 'sell' ? '漲到' : '跌到'} <span class="money">$${p.price}</span> ${a === 'sell' ? '以上就賣' : '以下就買'}` : '';
  const sub = p.repeat ? (st === 'ready' ? `${REPEAT[p.repeat]}${PLAN_ACTIONS[a] === '定期買進' ? '買進' : ''}` : `${REPEAT[p.repeat]}・下次 ${fmtDay(next)}`) : st === 'waiting' && watch ? planWatchText(watch)
    : trigger || (p.exp ? `${p.exp.slice(5).replace('-', '/')} 到期` : next ? `買進日 ${fmtDay(next)}` : '');
  // 右邊：每份計畫都有等待期圓點（填滿＝等待期過了），旁邊是藍色的狀態；到價了才用實心標籤
  const readyStatus = watch ? (watch.opt ? [`${planDots(p)}<span class="pl-left">距履約 ${pct(watch.gap, 1)}</span>`, `現價 <span class="money">${usd(watch.px)}</span>`]
      : watch.hit ? [`${planDots(p)}<span class="badge solid">✓ 到價了</span>`, `現價 <span class="money">${usd(watch.px)}</span>`]
      : [`${planDots(p)}<span class="pl-left">還差 ${pctPlain(Math.abs(watch.gap), 1)}</span>`, `現價 <span class="money">${usd(watch.px)}</span>`])
    : a === 'dca' ? [`${planDots(p)}${next === today() ? '<span class="badge solid">今天買</span>' : `<span class="pl-left">下次 ${next ? next.slice(5).replace('-', '/') : '—'}</span>`}`, '']
    : [`${planDots(p)}<span class="pl-left">可以下單</span>`, ''];
  const status = {
    ready: readyStatus,
    waiting: [`${planDots(p)}<span class="pl-left">${left} 天後</span>`, `${fmtDay(exec)} 起`],
    closed: ['<span class="badge muted">已完成</span>', (p.closedAt || p.created).slice(5).replace('-', '/')],
    void: ['<span class="badge muted">已作廢</span>', (p.closedAt || p.created).slice(5).replace('-', '/')],
  }[st];
  return `<div class="pl-c1"><b>${esc(p.sym)}</b><span class="pl-sub">${esc(planLabel(p))}</span></div>
    <div class="pl-c2">${p.qty ? `${p.qty} ${unit}${p.price ? ` @ <span class="money">${p.price}</span>` : ''}` : '<span class="muted">—</span>'}<span class="pl-sub">${sub || '&nbsp;'}</span></div>
    <div class="pl-c3"><div class="pl-st">${status[0]}</div><span class="pl-sub">${status[1] || '&nbsp;'}</span></div>`;
}
function planSteps(p) {
  // 等待期的進度軸：寫好那天 → 每一個要等的交易日 → 可以下單
  const wait = p.wait ?? RULES.wait, t = today();
  const steps = [{ d: p.created, k: '寫好' }, ...Array.from({ length: wait }, (_, i) => ({ d: addTradingDays(p.created, i + 1), k: i === wait - 1 ? '可以下單' : `第 ${i + 1} 天` }))];
  return `<div class="pl-steps">${steps.map(s => `<div class="pl-step ${s.d <= t ? 'done' : ''} ${s.d === t ? 'now' : ''}"><i></i><b>${s.k}</b><span>${s.d.slice(5).replace('-', '/')}</span></div>`).join('')}</div>`;
}
function planItem(p) {
  // 點開：等待進度、為什麼、條件、金額，按鈕在右下
  const st = planState(p), active = ['waiting', 'ready'].includes(st);
  const done = planTrades(p).length;
  const extra = [['addCond', '加碼'], ['exitCond', '出場'], ['rollCond', 'Roll']].filter(([k]) => p[k]);   // 舊版計畫才有
  const facts = [
    p.amount ? ['金額', `<span class="money">${usd0(p.amount)}</span>`] : null,
    p.pct ? ['佔總資產', `<span class="money">${pctPlain(p.pct, 1)}</span>`] : null,
    p.repeat ? ['重複', REPEAT[p.repeat]] : null,
    done ? ['照計畫成交', `${done} 筆`] : null,
    !active ? ['寫於', p.created] : null,
  ].filter(Boolean);
  return `<details class="pl-item ${st}">
    <summary>${planCells(p)}</summary>
    <div class="pl-body">
      ${active && (p.wait ?? RULES.wait) ? planSteps(p) : ''}
      ${p.thesis ? `<blockquote class="pl-why"><span>為什麼</span>${esc(p.thesis).replace(/\n/g, '<br>')}</blockquote>` : ''}
      ${p.entry ? `<div class="pl-cond"><span class="badge accent">條件</span><div>${esc(p.entry)}</div></div>` : ''}
      ${extra.map(([k, t]) => `<div class="pl-cond"><span class="badge">${t}</span><div>${esc(p[k])}</div></div>`).join('')}
      ${facts.length ? `<div class="pl-facts">${facts.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>` : ''}
      <div class="pl-acts">${active
        ? `<button class="ghost" data-plan-edit="${p.id}">編輯</button><button class="ghost" data-plan-close="${p.id}">✓ 完成</button><button class="ghost danger" data-plan-void="${p.id}">作廢</button>`
        : `<button class="ghost danger" data-plan-del="${p.id}">刪除</button>`}</div>
    </div></details>`;
}
function renderPlans(c) {
  buildPlanComposer(c);
  const dl = el('planSyms'); if (dl) dl.innerHTML = heldSyms(c).map(s => `<option value="${esc(s)}">`).join('');
  if (el('planForm') && !el('planForm').contains(document.activeElement)) updatePlanCalc();
  const box = el('planList'); if (!box) return;
  const plans = (data.plans || []).filter(p => p.created);
  const when = p => planState(p) === 'ready' ? '0' + (planNextDate(p) || '') : '1' + planExec(p);   // 可以執行的排最前面，其他照日期
  const active = plans.filter(p => ['waiting', 'ready'].includes(planState(p))).sort((a, b) => when(a).localeCompare(when(b)));
  const old = plans.filter(p => !active.includes(p)).sort((a, b) => b.ts - a.ts);
  const ready = active.filter(p => planState(p) === 'ready').length;
  box.innerHTML = (active.length ? `<div class="pl-list">${active.map(planItem).join('')}</div>` : '<div class="empty sm">還沒有進行中的計畫</div>')
    + (old.length ? `<details class="more pl-old"><summary>已完成、作廢的計畫（${old.length}）</summary><div class="pl-list">${old.map(planItem).join('')}</div></details>` : '')
    + `<details class="more pl-old"><summary>我的守則</summary><ol class="pl-rules">
        <li>不做選擇權買方（買回自己賣出的可以）</li>
        <li>新交易先寫計畫，寫完等 ${RULES.wait} 個交易日才下單；計畫裡寫好的條件不用再等；違反守則開的倉可以隨時平倉</li>
        <li>單一個股最多 ${RULES.cap}%，超過 ${RULES.trim}% 減碼回 ${RULES.cap}%；sell put 以履約價 × 100 計算；大盤型 ETF 不受限</li>
        <li>禁止交易槓桿、反向 ETF（包含 SOXL 這類大盤型），已經持有的可以賣出、平倉</li></ol></details>`;
  el('plansNote').textContent = active.length ? (ready ? `${ready} 份可以執行・` : '') + `${active.length - ready} 份等待中` : '';
}

function renderPlanSummary() {
  const box = el('planSummary'); if (!box) return;
  const when = p => planState(p) === 'ready' ? '0' + (planNextDate(p) || '') : '1' + planExec(p);
  const plans = (data.plans || []).filter(p => p.created && ['waiting', 'ready'].includes(planState(p))).sort((a, b) => when(a).localeCompare(when(b)));
  box.innerHTML = plans.length ? `<div class="pl-list">${plans.map(p => `<a class="pl-item pl-link" href="/plans">${planCells(p)}</a>`).join('')}</div>`
    : '<div class="empty sm">目前沒有進行中的計畫</div>';
}

// ============ 選擇權部位風險 ============
function renderOptRisk(c) {
  const box = el('optRiskBox'); if (!box) return;
  if (!c.optRows.length) { box.innerHTML = '<div class="empty">目前沒有未平倉的選擇權</div>'; return; }
  const r = curRate();
  let thetaSum = 0;
  const rows = c.optRows.map(o => {
    const oc = occ(o.sym), S = quotes[oc.root]?.price, dte = days(today(), oc.exp), T = yearsTo(oc.exp);
    const iv = S && o.mark ? impliedVol(oc, o.mark, S, T, r) : null;
    const ex = iv ? bsExtra(S, oc.strike, T, r, iv, oc.call) : null;
    const theta = ex ? ex.theta * 100 * o.qty : null;
    if (theta != null) thetaSum += theta;
    const money = S ? (oc.call ? S / oc.strike - 1 : oc.strike / S - 1) : null;   // 正的代表價內多少
    const state = money == null ? '—' : Math.abs(money) < 0.01 ? '價平' : money > 0 ? '價內' : '價外';
    const prem = Math.abs(o.avg);
    const be = oc.call ? oc.strike + prem : oc.strike - prem;
    let duty = '—';
    if (o.qty < 0 && !oc.call) {
      const need = oc.strike * 100 * Math.abs(o.qty);
      duty = `被指派要付 <span class="money">${usd0(need)}</span><span class="sub">${need > c.cashUSD ? `現金不足 <span class="money">${usd0(need - Math.max(c.cashUSD, 0))}</span>，會用到融資` : '現金足夠'}</span>`;
    } else if (o.qty < 0 && oc.call) {
      const need = 100 * Math.abs(o.qty), have = data.holdings[oc.root]?.shares || 0;
      duty = `被指派要交 ${need} 股<span class="sub">${have >= need ? `已持有 ${have} 股（有掩護）` : `只持有 ${have} 股（無掩護，風險無上限）`}</span>`;
    }
    const warn = o.qty < 0 && state === '價內' ? 'bad' : dte <= 3 ? '' : 'good';
    return `<tr>
      <td class="l"><b>${esc(optName(o.sym))}</b><span class="sub">${o.qty > 0 ? '買方' : '賣方'} ${Math.abs(o.qty)} 口・IV ${iv ? pctPlain(iv) : '—'}</span></td>
      <td class="num">${dte <= 0 ? '今天' : dte + ' 天'}</td>
      <td class="num">${S ? usd(S) : '—'}<span class="sub">履約 ${usd(oc.strike)}</span></td>
      <td><span class="badge ${warn}">${state}</span><span class="sub">${money == null ? '' : `<span class="money">${pct(money)}</span>`}</span></td>
      <td class="num">${usd(be)}</td>
      <td class="num">${ex ? pctPlain(ex.pItm) : '—'}</td>
      <td class="num ${cls(theta)}">${theta == null ? '—' : usd(theta, { sign: true })}</td>
      <td class="num">${o.delta == null ? '—' : o.delta.toFixed(2)}</td>
      <td class="l" style="white-space:normal">${duty}</td></tr>`;
  }).join('');
  box.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr>
      <th class="l">合約</th><th>到期</th><th>標的價</th><th class="l">價內外</th><th>損益兩平</th><th>到期價內機率</th><th>每天時間價值</th><th>Delta</th><th class="l">被指派時</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="note">每天時間價值（theta）合計 <b class="num ${cls(thetaSum)}">${usd(thetaSum, { sign: true })}</b>：正的代表時間經過對你有利（賣方），負的代表每天在流失（買方）。
      價內機率、theta 用 Black-Scholes 估算，隱含波動率由 Yahoo 報價反推（延遲約 20 分鐘）。損益兩平以開倉權利金計算。</div>`;
}

// ============ 交易日記 ============
const MOODS = [['calm', '😌', '平靜'], ['sure', '🙂', '有把握'], ['meh', '😐', '普通'], ['anx', '😣', '焦慮'], ['rash', '😤', '衝動']];
let jMood = 'calm';
function renderJournal() {
  const box = el('journalBox'); if (!box) return;
  if (!el('jForm')) {
    box.innerHTML = `<div id="jForm">
      <div class="toolbar"><span class="seg" id="jMoods">${MOODS.map(([k, e, t]) => `<button data-mood="${k}">${e} ${t}</button>`).join('')}</span>
        <input id="jSym" class="search upper" placeholder="代號（選填）"></div>
      <textarea id="jText" rows="3" placeholder="現在在想什麼？為什麼買、為什麼賣、心情怎麼樣……寫下來就好。"></textarea>
      <div class="form-foot"><button class="primary" id="jSave">記下來</button></div></div>
      <div id="jList"></div>`;
  }
  document.querySelectorAll('[data-mood]').forEach(b => b.classList.toggle('on', b.dataset.mood === jMood));
  const list = [...(data.journal || [])].sort((a, b) => b.ts - a.ts);
  const moodOf = k => MOODS.find(m => m[0] === k) || MOODS[2];
  const counts = MOODS.map(([k, e, t]) => [e, t, list.filter(x => x.mood === k).length]).filter(x => x[2]);
  el('jList').innerHTML = list.length
    ? `<div class="note">${counts.map(([e, t, n]) => `${e} ${t} ${n} 次`).join('・')}</div>` + list.slice(0, 50).map(j => `<div class="j-item">
        <div class="j-head"><span>${moodOf(j.mood)[1]} <b>${j.date}</b>${j.sym ? ` <span class="pill">${esc(j.sym)}</span>` : ''}</span>
          <button class="ghost" data-jdel="${j.id}" title="刪除這篇">✕</button></div>
        <div class="j-text">${esc(j.text).replace(/\n/g, '<br>')}</div></div>`).join('')
    : '<div class="empty">還沒有日記。下單前後花 30 秒寫一句，之後回頭看會很有收穫。</div>';
}

// ============ 交易分析 ============
let anaView = store.get('anaView', 'symbol');
let anaShowAll = false;
function stockHoldingEvents(st) { return stockLots(st).events; }
function stockLots(st) {
  // 先進先出配對買進日期，算每筆賣出持有幾天（損益沿用平均成本法的數字）；lots 是還沒賣掉的批次
  const trades = data.transactions.filter(t => t.type === 'buy' || t.type === 'sell')
    .sort((a, b) => a.date.localeCompare(b.date) || (a.type === 'sell') - (b.type === 'sell') || a.ts - b.ts);
  const init = {};
  for (const [s, h] of Object.entries(data.holdings)) init[s] = h.shares;
  for (const t of trades) init[t.symbol] = round((init[t.symbol] || 0) - (t.type === 'buy' ? t.shares : -t.shares));
  const baseD = data.settings.base?.date || trades[0]?.date;
  const lots = {};
  for (const [s, q] of Object.entries(init)) if (q > 1e-9) lots[s] = [{ date: baseD, q }];
  const out = [];
  for (const t of trades) {
    const L = lots[t.symbol] ??= [];
    if (t.split) { const held = L.reduce((a, l) => a + l.q, 0); if (held > 1e-9) L.forEach(l => { l.q *= (held + t.shares) / held; }); continue; }   // 分割：原本那幾批股數放大，不是新買
    if (t.type === 'buy') { L.push({ date: t.date, q: t.shares }); continue; }
    let need = t.shares, wd = 0, got = 0;
    while (need > 1e-9 && L.length) {
      const lot = L[0], take = Math.min(lot.q, need);
      wd += take * days(lot.date, t.date); got += take; lot.q -= take; need -= take;
      if (lot.q <= 1e-9) L.shift();
    }
    const r = st.perSell[t.id];
    if (r != null) out.push({ sym: t.symbol, date: t.date, r, hold: got ? wd / got : 0 });
  }
  return { events: out, lots };
}
// 持有中的部位與未實現損益：股票用持倉的平均成本，選擇權用開倉時付出（或收到）的權利金
function openPositions(c, st) {
  const lots = stockLots(st).lots;
  const age = sym => {   // 還沒賣掉的那幾批，平均買了多久
    const L = (lots[sym] || []).filter(l => l.q > 1e-9), q = L.reduce((a, l) => a + l.q, 0);
    return q ? L.reduce((a, l) => a + l.q * days(l.date, today()), 0) / q : null;
  };
  const stocks = c.rows.filter(r => r.value != null).map(r => ({ sym: r.sym, g: grp(r.sym), shares: r.shares, avg: r.avg, price: r.price,
    value: r.value, cost: r.cost, unreal: r.value - r.cost, pct: r.cost > 0 ? r.value / r.cost - 1 : null, days: age(r.sym) }));
  const opts = c.optRows.map(o => { const cost = o.avg * 100 * o.qty;
    return { sym: o.sym, g: grp(occ(o.sym).root), qty: o.qty, avg: o.avg, price: o.mark, value: o.value, cost, unreal: o.value - cost,
             pct: Math.abs(cost) > 0 ? (o.value - cost) / Math.abs(cost) : null }; });
  return { stocks, opts, total: [...stocks, ...opts].reduce((a, x) => a + x.unreal, 0) };
}
function optionLifeEvents(st) {
  // 每筆平倉（或到期）對應的開倉日期：算開倉時距離到期幾天、持有幾天
  const out = [], bySym = {};
  for (const t of data.transactions) if (t.type === 'option') (bySym[t.symbol] ??= []).push(t);
  for (const [sym, list] of Object.entries(bySym)) {
    list.sort((a, b) => a.date.localeCompare(b.date) || (a.action === 'close') - (b.action === 'close') || a.ts - b.ts);
    const oc = occ(sym), lots = [];
    const take = (n, date, r, side) => {
      let need = n, wOpen = 0, got = 0;
      while (need > 1e-9 && lots.length) { const l = lots[0], k = Math.min(l.q, need); wOpen += k * +new Date(l.date); got += k; l.q -= k; need -= k; if (l.q <= 1e-9) lots.shift(); }
      if (!got) return;
      const openD = new Date(wOpen / got).toISOString().slice(0, 10);
      out.push({ sym, root: oc?.root || sym, date, r, side, dte: oc ? days(openD, oc.exp) : null, hold: days(openD, date) });
    };
    for (const t of list) {
      if (t.id in st.perOpt) {
        if (st.perOpt[t.id] != null) take(Math.abs(t.qty), t.date, st.perOpt[t.id], t.qty < 0 ? 'long' : 'short');
      } else lots.push({ date: t.date, q: Math.abs(t.qty) });
    }
    const exp = st.expiries.find(e => e.symbol === sym);
    if (exp) take(Math.abs(exp.qty), exp.date, exp.realized, exp.qty < 0 ? 'long' : 'short');
  }
  return out;
}
function bucketTable(title, buckets, events, keyFn) {
  const rows = buckets.map(([label, test]) => [label, winStats(events.filter(e => test(keyFn(e))))]).filter(([, w]) => w.n);
  return `<div><div style="font-size:13px;font-weight:600;margin-bottom:4px">${title}</div>${winTable(rows)}</div>`;
}
function streaks(events) {
  const ev = [...events].sort((a, b) => a.date.localeCompare(b.date));
  let bestW = 0, bestL = 0, cur = 0, curType = null;
  for (const e of ev) {
    const t = e.r > 0.005 ? 'w' : e.r < -0.005 ? 'l' : null;
    if (!t) continue;
    cur = t === curType ? cur + 1 : 1; curType = t;
    if (t === 'w') bestW = Math.max(bestW, cur); else bestL = Math.max(bestL, cur);
  }
  return { bestW, bestL, cur, curType };
}
function renderAnalysis() {
  const box = el('analysisBox'); if (!box) return;
  document.querySelectorAll('[data-ana]').forEach(b => b.classList.toggle('on', b.dataset.ana === anaView));
  const st = realizedStats();
  if (anaView === 'symbol') {
    const map = {};
    const add = (g, kind, e) => { const m = map[g] ??= { stock: [], opt: [] }; m[kind].push(e); };
    for (const e of st.stockEvents) add(grp(e.sym), 'stock', e);
    for (const e of st.optEvents) add(grp(occ(e.sym)?.root || e.sym), 'opt', e);
    // 還抱著的部位：未實現損益也算進去（只持有、沒賣過的標的也會列出來）
    const op = openPositions(calc(), st), un = {};
    for (const x of [...op.stocks, ...op.opts]) { un[x.g] = (un[x.g] || 0) + x.unreal; map[x.g] ??= { stock: [], opt: [] }; }
    const rows = Object.entries(map).map(([g, m]) => {
      const s = winStats(m.stock), o = winStats(m.opt), u = un[g];
      return { g, s, o, u, total: s.total + o.total + (u || 0) };
    }).sort((a, b) => b.total - a.total);
    // 預設只列影響最大的 12 檔（依損益絕對值挑，再照損益排序）
    const keep = anaShowAll ? rows : rows.filter(r => [...rows].sort((a, b) => Math.abs(b.total) - Math.abs(a.total)).slice(0, 12).includes(r));
    const cellW = w => w.n ? `${w.n} 筆<span class="sub">勝率 ${pctPlain(w.rate)}</span>` : '<span class="muted">—</span>';
    box.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th class="l">標的</th><th>股票</th><th>股票損益</th><th>選擇權</th><th>選擇權損益</th><th>未實現</th><th>合計</th></tr></thead>
      <tbody>${keep.map(r => `<tr><td class="l"><a class="sym-link" href="/symbol?s=${encodeURIComponent(r.g)}"><b>${esc(grpName(r.g))}</b></a></td><td class="num">${cellW(r.s)}</td><td class="num ${cls(r.s.total)}">${r.s.n ? usd0(r.s.total, { sign: true }) : '—'}</td>
        <td class="num">${cellW(r.o)}</td><td class="num ${cls(r.o.total)}">${r.o.n ? usd0(r.o.total, { sign: true }) : '—'}</td><td class="num ${cls(r.u)}">${r.u == null ? '<span class="muted">—</span>' : usd0(r.u, { sign: true })}</td><td class="num ${cls(r.total)}"><b>${usd0(r.total, { sign: true })}</b></td></tr>`).join('')}</tbody></table></div>
      ${rows.length > 12 ? `<div class="more-row"><button class="ghost" data-anaall="1">${anaShowAll ? '只顯示影響最大的 12 檔' : `顯示全部 ${rows.length} 檔`}</button></div>` : ''}
      <div class="note">槓桿 ETF 與選擇權都併到標的本身計算（例如 GGLL、GOOGL 選擇權都算 Alphabet）。合計＝已實現＋還抱著的未實現。依合計排序；預設只列影響最大的 12 檔。</div>`;
  } else if (anaView === 'open') {
    // 持有中：還沒賣掉的部位和未實現損益
    const op = openPositions(calc(), st), realized = st.stock + st.option + st.div + st.refund;
    const signed = v => `<span class="num ${cls(v)}">${usd0(v, { sign: true })}</span>`;
    const pctOf = v => v == null ? '—' : `<span class="num ${cls(v)}">${pct(v)}</span>`;
    const link = (g, t) => `<a class="sym-link" href="/symbol?s=${encodeURIComponent(g)}"><b>${esc(t)}</b></a>`;
    box.innerHTML = UI.tiles([
      { k: '未實現損益', v: usd0(op.total, { sign: true }), vcls: `num ${cls(op.total)}`, s: '還抱著的部位' },
      { k: '已實現損益', v: usd0(realized, { sign: true }), vcls: `num ${cls(realized)}`, s: '股票＋選擇權＋股息' },
      { k: '合計', v: usd0(op.total + realized, { sign: true }), vcls: `num ${cls(op.total + realized)}` },
      { k: '持有中', v: `${op.stocks.length} 檔`, vcls: '', s: op.opts.length ? `另有 ${op.opts.length} 個選擇權部位` : '' }])
    + UI.table('<th class="l">標的</th><th>數量</th><th>平均成本</th><th>現價</th><th>市值</th><th>未實現</th><th>報酬率</th><th>持有</th>',
      [...op.stocks].sort((a, b) => b.unreal - a.unreal).map(r => `<tr><td class="l">${link(r.g, r.sym)}</td><td class="num">${fmtShares(r.shares)} 股</td>
        <td class="num">${usd(r.avg)}</td><td class="num">${usd(r.price)}</td><td class="num">${usd0(r.value)}</td><td>${signed(r.unreal)}</td><td>${pctOf(r.pct)}</td>
        <td class="num">${r.days == null ? '—' : `${Math.round(r.days)} 天`}</td></tr>`).join('')
      + op.opts.map(o => `<tr><td class="l">${link(o.g, optName(o.sym))}</td><td class="num">${o.qty} 口</td><td class="num">${usd(Math.abs(o.avg))}</td>
        <td class="num">${o.price == null ? '—' : usd(o.price)}</td><td class="num">${usd0(o.value)}</td><td>${signed(o.unreal)}</td><td>${pctOf(o.pct)}</td><td class="num">—</td></tr>`).join(''))
    + UI.note('未實現＝目前市值 − 成本：股票用券商的平均成本，選擇權用開倉時的權利金（賣方的市值是負的）。持有天數是還沒賣掉的那幾批平均買了多久（先進先出）。');
  } else if (anaView === 'hold') {
    const ev = stockHoldingEvents(st);
    box.innerHTML = `<div class="ana-cols">${bucketTable('股票：依持有天數（先進先出）', [
      ['當天沖銷', d => d < 0.5], ['1–3 天', d => d >= 0.5 && d < 3.5], ['4–10 天', d => d >= 3.5 && d < 10.5],
      ['11–30 天', d => d >= 10.5 && d < 30.5], ['31–90 天', d => d >= 30.5 && d < 90.5], ['90 天以上', d => d >= 90.5]], ev, e => e.hold)}
      ${bucketTable('選擇權：依持有天數', [['當天', d => d < 0.5], ['1–3 天', d => d >= 0.5 && d < 3.5], ['4–10 天', d => d >= 3.5 && d < 10.5], ['11 天以上', d => d >= 10.5]], optionLifeEvents(st), e => e.hold)}</div>
      <div class="note">持有天數用先進先出配對買進日期（同一筆賣出對到多批買進時取加權平均）；每筆的損益仍用平均成本法，跟上方已實現損益一致。紀錄開始前就持有的股票，從紀錄開始那天起算。</div>`;
  } else if (anaView === 'dte') {
    const ev = optionLifeEvents(st);
    const B = [['0–2 天', d => d <= 2], ['3–7 天', d => d >= 3 && d <= 7], ['8–30 天', d => d >= 8 && d <= 30], ['31–90 天', d => d >= 31 && d <= 90], ['90 天以上', d => d > 90]];
    box.innerHTML = `<div class="ana-cols">${bucketTable('買方：開倉時距離到期天數', B, ev.filter(e => e.side === 'long'), e => e.dte)}
      ${bucketTable('賣方：開倉時距離到期天數', B, ev.filter(e => e.side === 'short'), e => e.dte)}</div>
      <div class="note">看你擅長哪種天期：例如短天期賣方（0–7 天）是不是真的穩定賺時間價值。同一合約分批開倉時，開倉日取加權平均。</div>`;
  } else {
    const ev = [...st.stockEvents.map(e => ({ ...e, k: 'stock' })), ...st.optEvents.map(e => ({ ...e, k: 'opt' }))];
    const edges = [-Infinity, -500, -200, -100, -50, 0, 50, 100, 200, 500, Infinity];
    const label = i => edges[i] === -Infinity ? `< −$${-edges[i + 1]}` : edges[i + 1] === Infinity ? `> $${edges[i]}` : `${edges[i] < 0 ? '−$' + -edges[i] : '$' + edges[i]} ～ ${edges[i + 1] <= 0 ? (edges[i + 1] ? '−$' + -edges[i + 1] : '$0') : '$' + edges[i + 1]}`;
    const bins = edges.slice(0, -1).map((_, i) => ({ label: label(i), s: 0, o: 0, neg: edges[i + 1] <= 0 }));
    for (const e of ev) { const i = edges.findIndex((x, j) => e.r >= x && e.r < edges[j + 1]); if (i >= 0) bins[i][e.k === 'stock' ? 's' : 'o']++; }
    const max = Math.max(...bins.map(b => b.s + b.o), 1);
    const all = winStats(ev), sk = streaks(ev);
    box.innerHTML = `${UI.tiles([
        { k: `每筆平均損益（期望值）`, v: `${usd(all.n ? all.total / all.n : 0, { sign: true })}`, s: `${all.n} 筆（股票＋選擇權）`, vcls: `num ${cls(all.total)}` },
        { k: `最長連勝`, v: `${sk.bestW} 筆` },
        { k: `最長連敗`, v: `${sk.bestL} 筆` },
        { k: `目前`, v: `${sk.curType ? `${sk.cur} 連${sk.curType === 'w' ? '勝' : '敗'}` : '—'}` },
        { k: `最大單筆`, v: `${all.best ? usd0(all.best.r, { sign: true }) : '—'}`, s: `${all.best ? esc(all.best.sym) + ' ' + all.best.date : ''}`, vcls: `num up` },
        { k: `最大單筆虧損`, v: `${all.worst ? usd0(all.worst.r, { sign: true }) : '—'}`, s: `${all.worst ? esc(all.worst.sym) + ' ' + all.worst.date : ''}`, vcls: `num down` }])}
      ${bins.map(b => `<div class="hbar-row"><div class="hbar-name" style="font-weight:400">${b.label}</div>
        <div class="hbar-track"><i class="${b.neg ? 'neg' : 'pos'}" style="left:0;width:${(b.s + b.o) / max * 100}%"></i></div>
        <div class="hbar-val num">${b.s + b.o} 筆<span class="sub">股票 ${b.s}・選擇權 ${b.o}</span></div></div>`).join('')}
      <div class="note">每一筆已實現交易落在哪個損益區間。左邊（虧損）的長條如果比右邊（獲利）的長很多，代表常常小賺大賠。</div>`;
  }
}

// ============ 每月已實現損益 ============
let monthlyRange = '12';   // 最近幾個月；'0' 代表全部
function renderMonthly() {
  const box = el('monthlyBox'); if (!box || box.clientWidth === 0) return;
  const st = realizedStats(), m = {};
  const add = (d, k, v) => { const o = m[d.slice(0, 7)] ??= { s: 0, o: 0, d: 0 }; o[k] += v; };
  for (const e of st.stockEvents) add(e.date, 's', e.r);
  for (const e of st.optEvents) add(e.date, 'o', e.r);
  for (const t of data.transactions) if (t.type === 'income' && t.currency === 'USD' && /^(股息|退稅)/.test(t.category || '')) add(t.date, 'd', t.amount);
  document.querySelectorAll('#monthlySeg [data-mrange]').forEach(b => b.classList.toggle('on', b.dataset.mrange === monthlyRange));
  // 區間：從今天往回推 N 個月（含這個月），中間沒有交易的月份也要佔一格，時間軸才不會被壓縮
  const now = today().slice(0, 7), first = Object.keys(m).sort()[0];
  if (!first) { box.innerHTML = '<div class="empty">還沒有已實現損益</div>'; return; }
  const addM = (k, n) => { const [y, mo] = k.split('-').map(Number), t = y * 12 + mo - 1 + n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}`; };
  const cut = +monthlyRange ? addM(now, 1 - +monthlyRange) : first, from = cut > first ? cut : first;
  const months = [];
  for (let k = from; k <= now; k = addM(k, 1)) { months.push(k); m[k] ??= { s: 0, o: 0, d: 0 }; }
  const K = [['s', '股票', 'var(--s1)'], ['o', '選擇權', 'var(--s2)'], ['d', '股息', 'var(--s3)']];
  const W = box.clientWidth, H = box.clientHeight, padL = 52, padR = 8, padT = 10, padB = 22;
  let top = 0, bot = 0;
  for (const k of months) { const o = m[k]; top = Math.max(top, K.reduce((s, [c]) => s + Math.max(o[c], 0), 0)); bot = Math.min(bot, K.reduce((s, [c]) => s + Math.min(o[c], 0), 0)); }
  const span = (top - bot) || 1; top += span * 0.06; bot -= span * 0.06;
  const y = v => padT + (top - v) / (top - bot) * (H - padT - padB);
  const bw = (W - padL - padR) / months.length, barW = Math.max(4, Math.min(36, bw * 0.6));
  const every = bw < 30 ? Math.ceil(30 / bw) : 1;   // 月份太多時隔幾個才標一次
  let bars = '';
  months.forEach((k, i) => {
    const cx = padL + bw * i + bw / 2, o = m[k];
    let up = 0, dn = 0;
    for (const [c, , col] of K) {
      const v = o[c]; if (!v) continue;
      const y0 = v >= 0 ? y(up + v) : y(dn), h = Math.abs(y(v >= 0 ? up : dn + v) - y(v >= 0 ? up + v : dn));
      bars += `<rect x="${cx - barW / 2}" y="${y0}" width="${barW}" height="${Math.max(h - 1, 0.5)}" fill="${col}" rx="2"/>`;
      if (v >= 0) up += v; else dn += v;
    }
    // 一月和第一格標年份，其他只標月份
    if (i % every === 0) bars += `<text class="axis-text" x="${cx}" y="${H - 6}" text-anchor="middle">${i === 0 || k.endsWith('-01') ? `${k.slice(2, 4)}/${+k.slice(5)}` : +k.slice(5) + '月'}</text>`;
  });
  const ticks = [bot, 0, top].filter((v, i, a) => a.indexOf(v) === i);
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    ${ticks.map(t => `<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" stroke="${t === 0 ? 'var(--text-3)' : 'var(--border)'}" ${t === 0 ? '' : 'stroke-dasharray="2 4"'}/>
      <text class="axis-text" x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${usd0(t)}</text>`).join('')}
    ${bars}
    ${months.map((k, i) => `<rect x="${padL + bw * i}" y="0" width="${bw}" height="${H}" fill="transparent" data-mi="${i}"/>`).join('')}
  </svg><div class="chart-tip" hidden></div>`;
  const tip = box.querySelector('.chart-tip');
  box.querySelectorAll('[data-mi]').forEach(r => {
    r.addEventListener('pointerenter', () => {
      const k = months[+r.dataset.mi], o = m[k], tot = o.s + o.o + o.d, px = padL + bw * +r.dataset.mi + bw / 2;
      tip.hidden = false; tip.style.top = padT + 'px'; tip.style.left = px + 'px';
      tip.style.transform = px > W / 2 ? 'translate(calc(-100% - 10px), 0)' : 'translate(10px, 0)';
      tip.innerHTML = `<div style="margin-bottom:4px">${k}</div>${K.map(([c, n]) => `<div class="row"><span>${n}</span><b>${usd(o[c], { sign: true })}</b></div>`).join('')}<div class="row"><span>合計</span><b>${usd(tot, { sign: true })}</b></div>`;
    });
    r.addEventListener('pointerleave', () => { tip.hidden = true; });
    r.addEventListener('click', () => { location.href = `/trades?ym=${months[+r.dataset.mi]}`; });
    r.style.cursor = 'pointer';
  });
  const sum = c => months.reduce((s, k) => s + m[k][c], 0);
  el('monthlyLegend').innerHTML = K.map(([c, n, col]) => `<span class="legend-item"><span class="swatch" style="border-color:${col};border-top-width:8px;width:10px"></span>${n} <b class="num">${usd0(sum(c), { sign: true })}</b></span>`).join('');
}

// ============ 交易成本 ============
function feesByMonth() {
  // 每月的交易成本：股票規費、選擇權手續費、融資利息
  const m = {};
  const add = (d, k, v, n = 0) => { const o = m[d.slice(0, 7)] ??= { stock: 0, opt: 0, n: 0, c: 0, int: 0 }; o[k] += v; if (k === 'stock') o.n += n; if (k === 'opt') o.c += n; };
  for (const t of data.transactions) {
    if ((t.type === 'buy' || t.type === 'sell') && t.price) {
      const fee = t.type === 'buy' ? t.total - t.shares * t.price : t.shares * t.price - t.total;
      add(t.date, 'stock', Math.max(fee, 0), 1);
    } else if (t.type === 'option' && t.key && t.amount) {
      const p = parseFloat(t.key.split('|')[4]);   // 成交價只存在匯入時的辨識碼裡
      if (!(p > 0)) continue;
      const fee = t.qty > 0 ? -t.amount - p * 100 * t.qty : p * 100 * -t.qty - t.amount;
      add(t.date, 'opt', Math.max(fee, 0), Math.abs(t.qty));
    } else if (t.type === 'expense' && /利息支出/.test(t.category || '')) add(t.date, 'int', t.amount);
  }
  return m;
}
function renderFees() {
  const box = el('feeBox'); if (!box) return;
  const m = feesByMonth(), months = Object.keys(m).sort();
  if (!months.length) { box.innerHTML = '<div class="empty">沒有交易</div>'; return; }
  const tot = k => months.reduce((s, x) => s + m[x][k], 0);
  const st = realizedStats(), realized = st.stock + st.option;
  const all = tot('stock') + tot('opt') + tot('int');
  const feeTable = list => `<div class="table-wrap"><table class="table"><thead><tr><th class="l">月份</th><th>股票（筆）</th><th>股票規費</th><th>選擇權（口）</th><th>選擇權手續費</th><th>融資利息</th><th>合計</th></tr></thead>
      <tbody>${list.map(k => { const o = m[k]; return `<tr><td class="l">${k}</td><td class="num">${o.n}</td><td class="num">${usd(o.stock)}</td><td class="num">${o.c}</td><td class="num">${usd(o.opt)}</td><td class="num">${o.int ? usd(o.int) : '—'}</td><td class="num"><b>${usd(o.stock + o.opt + o.int)}</b></td></tr>`; }).join('')}</tbody></table></div>`;
  box.innerHTML = `${UI.tiles([
      { k: `總交易成本`, v: `${usd(all)}`, s: `佔已實現損益 <span class="money">${realized > 0 ? pctPlain(all / realized, 1) : '—'}</span>` },
      { k: `股票規費`, v: `${usd(tot('stock'))}`, s: `${tot('n')} 筆，平均每筆 <span class="money">${usd(tot('n') ? tot('stock') / tot('n') : 0)}</span>` },
      { k: `選擇權手續費`, v: `${usd(tot('opt'))}`, s: `${tot('c')} 口，平均每口 <span class="money">${usd(tot('c') ? tot('opt') / tot('c') : 0)}</span>` },
      { k: `融資利息`, v: `${usd(tot('int'))}`, s: `${months.filter(k => m[k].int).length ? `${months.filter(k => m[k].int).length} 個月有被收` : '紀錄中沒有'}` }])}
    ${feeTable(months.slice().reverse().slice(0, 12))}
    ${months.length > 12 ? `<details class="more" style="margin-top:8px"><summary>更早的月份（${months.length - 12}）</summary>${feeTable(months.slice().reverse().slice(12))}</details>` : ''}
    <div class="note">成本＝成交金額與實際收付金額的差（券商手續費、SEC／FINRA 規費等），由券商紀錄推算；融資利息是券商每月收的「融資利息費用」。買賣價差、匯差不在其中。</div>`;
}

// ============ 持有天數與損益：每一筆已實現交易一個點 ============
let scView = 'all';
function renderHoldScatter() {
  const box = el('holdScatterBox'); if (!box || box.clientWidth === 0) return;
  document.querySelectorAll('[data-sc]').forEach(b => b.classList.toggle('on', b.dataset.sc === scView));
  const st = realizedStats();
  const ev = [...(scView === 'option' ? [] : stockHoldingEvents(st).map(e => ({ ...e, kind: 's', name: e.sym }))),
              ...(scView === 'stock' ? [] : optionLifeEvents(st).map(e => ({ ...e, kind: 'o', name: optName(e.sym) })))].filter(e => e.hold != null);
  if (ev.length < 3) { box.innerHTML = UI.empty('已實現的交易還不夠'); el('holdScatterSum').innerHTML = ''; return; }
  const W = box.clientWidth, H = box.clientHeight, padL = 56, padR = 12, padT = 10, padB = 24;
  // 橫軸：持有天數，用平方根刻度（短天期才不會全擠在左邊）；縱軸：損益，極端的幾筆壓在邊緣
  const maxD = Math.max(...ev.map(e => e.hold), 7), sx = d => Math.sqrt(Math.max(d, 0));
  const x = d => padL + sx(d) / sx(maxD) * (W - padL - padR);
  const abs = ev.map(e => Math.abs(e.r)).sort((a, b) => a - b), lim = Math.max(abs[Math.floor(abs.length * 0.97)] * 1.15, 1);
  const y = v => padT + (1 - (Math.max(-lim, Math.min(lim, v)) + lim) / (2 * lim)) * (H - padT - padB);
  const dTicks = [0, 1, 7, 30, 90, 180, 365, 730].filter(d => d <= maxD);
  const pts = ev.map(e => ({ ...e, px: x(e.hold), py: y(e.r), clip: Math.abs(e.r) > lim }));
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="持有天數與損益">
    ${[-lim, -lim / 2, 0, lim / 2, lim].map(t => `<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" stroke="${t ? 'var(--border)' : 'var(--text-3)'}" ${t ? 'stroke-dasharray="2 4"' : ''}/>
      <text class="axis-text" x="${padL - 8}" y="${y(t) + 4}" text-anchor="end">${usd0(t, { sign: !!t })}</text>`).join('')}
    ${dTicks.map(d => `<line x1="${x(d)}" x2="${x(d)}" y1="${padT}" y2="${H - padB}" stroke="var(--border)" stroke-dasharray="2 4"/>
      <text class="axis-text" x="${x(d)}" y="${H - 6}" text-anchor="middle">${d ? d + ' 天' : '當天'}</text>`).join('')}
    ${pts.map(p => `<circle cx="${p.px.toFixed(1)}" cy="${p.py.toFixed(1)}" r="${p.clip ? 4.5 : 3.5}" fill="${p.clip ? 'var(--surface)' : p.kind === 's' ? 'var(--s1)' : 'var(--s2)'}"
      stroke="${p.kind === 's' ? 'var(--s1)' : 'var(--s2)'}" stroke-width="${p.clip ? 1.5 : 0}" opacity="${p.clip ? 1 : .55}"/>`).join('')}
    <circle class="xd" r="6" fill="none" stroke="var(--text)" stroke-width="1.5" visibility="hidden"/>
    <rect x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent" class="xh"/>
  </svg><div class="chart-tip" hidden></div>`;
  const hit = box.querySelector('.xh'), ring = box.querySelector('.xd'), tip = box.querySelector('.chart-tip');
  hit.addEventListener('pointermove', e => {
    const r = box.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = 18 * 18;
    for (const p of pts) { const d = (p.px - mx) ** 2 + (p.py - my) ** 2; if (d < bd) { bd = d; best = p; } }
    if (!best) { ring.setAttribute('visibility', 'hidden'); tip.hidden = true; return; }
    ring.setAttribute('cx', best.px); ring.setAttribute('cy', best.py); ring.setAttribute('visibility', 'visible');
    tip.hidden = false; tip.style.left = best.px + 'px'; tip.style.top = best.py + 'px';
    tip.style.transform = best.px > W / 2 ? 'translate(calc(-100% - 12px), -50%)' : 'translate(12px, -50%)';
    tip.innerHTML = `<b>${esc(best.name)}</b><br>${best.date}・持有 ${best.hold < 1 ? '不到 1' : Math.round(best.hold)} 天<br>損益 <b>${usd(best.r, { sign: true })}</b>`;
  });
  hit.addEventListener('pointerleave', () => { ring.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  // 下面直接回答：抱久是不是比較好
  const bucket = (t, f) => { const w = winStats(ev.filter(e => f(e.hold))); return w.n ? { k: t, v: usd(w.total / w.n, { sign: true }), vcls: `num ${cls(w.total)}`, s: `平均每筆・${w.n} 筆・勝率 ${pctPlain(w.rate)}` } : null; };
  el('holdScatterSum').innerHTML = UI.tiles([bucket('持有 7 天以內', d => d < 7.5), bucket('持有 8–30 天', d => d >= 7.5 && d < 30.5), bucket('持有 30 天以上', d => d >= 30.5)])
    + UI.note('每個點是一筆已實現的交易（藍色股票、橘色選擇權）；空心的點損益太大，壓在上下邊緣。持有天數用先進先出配對。');
}

// ============ 持倉配置方塊圖：ETF 拆成成分股後，每家公司佔多少 ============
let tmView = 'stock', tmLayout = 'sector';   // 只看股票／含現金；依產業分區／依大小排
// 產業類別：用 Yahoo 的產業分成幾大類，方塊依類別上色
const SECTORS = [['semi', '半導體'], ['tech', '科技與網路'], ['consumer', '消費'], ['fin', '金融'], ['health', '醫療'], ['ind', '工業與能源'], ['other', '其他']];
const sectorData = {}, sectorAsked = new Set();
function sectorOf(sym) {
  const d = sectorData[sym]; if (!d) return null;
  if (/semiconductor/i.test(d.industry)) return 'semi';
  return { Technology: 'tech', 'Communication Services': 'tech', 'Consumer Cyclical': 'consumer', 'Consumer Defensive': 'consumer',
           'Financial Services': 'fin', Healthcare: 'health', Industrials: 'ind', Energy: 'ind', 'Basic Materials': 'ind',
           Utilities: 'ind', 'Real Estate': 'ind' }[d.sector] || 'other';
}
async function loadSectors(syms) {
  const todo = syms.filter(s => !sectorAsked.has(s)); if (!todo.length) return;
  todo.forEach(s => sectorAsked.add(s));
  try { Object.assign(sectorData, await (await fetch('/api/sectors?symbols=' + encodeURIComponent(todo.join(',')))).json()); } catch { /* 抓不到就先用預設色 */ }
  renderTreemap(calc());
}
function squarify(items, rect) {
  // 經典 squarified treemap：一列一列放，讓每塊盡量接近正方形
  const total = items.reduce((a, n) => a + n.v, 0), k = rect.w * rect.h / total, out = [];
  const nodes = items.map(n => ({ ...n, a: n.v * k }));
  const worst = (row, side) => { const s = row.reduce((a, n) => a + n.a, 0), mx = Math.max(...row.map(n => n.a)), mn = Math.min(...row.map(n => n.a));
    return Math.max(side * side * mx / (s * s), (s * s) / (side * side * mn)); };
  const place = (row, r) => {
    const s = row.reduce((a, n) => a + n.a, 0);
    if (r.w >= r.h) { const cw = s / r.h; let cy = r.y; for (const n of row) { const nh = n.a / cw; out.push({ ...n, x: r.x, y: cy, w: cw, h: nh }); cy += nh; } return { x: r.x + cw, y: r.y, w: r.w - cw, h: r.h }; }
    const rh = s / r.w; let cx = r.x; for (const n of row) { const nw = n.a / rh; out.push({ ...n, x: cx, y: r.y, w: nw, h: rh }); cx += nw; } return { x: r.x, y: r.y + rh, w: r.w, h: r.h - rh };
  };
  let row = [], r = { ...rect }, i = 0;
  while (i < nodes.length) {
    const side = Math.min(r.w, r.h);
    if (!row.length || worst([...row, nodes[i]], side) <= worst(row, side)) row.push(nodes[i++]);
    else { r = place(row, r); row = []; }
  }
  if (row.length) place(row, r);
  return out;
}
function renderTreemap(c) {
  const box = el('treemapBox'); if (!box || box.clientWidth === 0) return;
  document.querySelectorAll('[data-tmv]').forEach(b => b.classList.toggle('on', b.dataset.tmv === tmView));
  const { stocks, other, pending } = stockExposure(c), eq = c.totalUSD;
  // 方塊：每家公司一塊；零碎的（比較小的公司、ETF 前 50 名以外）合成「其他公司」；含現金時 BOXX 和現金合成「現金與短債」
  let items = stocks.filter(g => g.total > 0).map(g => ({ key: g.key, name: g.name, v: g.total, link: true }));
  items.sort((a, b) => b.v - a.v);
  const all = tmView === 'all';
  let restV = all ? other.filter(g => g.key === 'REST').reduce((a, g) => a + g.total, 0) : 0;
  const sum0 = items.reduce((a, n) => a + n.v, 0) + restV;
  const keep = items.filter((n, i) => i < 40 && n.v / sum0 > 0.004);
  restV += items.filter(n => !keep.includes(n)).reduce((a, n) => a + n.v, 0);
  if (restV > 0) keep.push({ key: '其他公司', v: restV, gray: true });
  if (all) {
    for (const g of other.filter(g => g.total > 0 && !['REST', 'CASH'].includes(g.key))) keep.push({ key: grpName(g.key), v: g.total, gray: true });   // 黃金、比特幣這類
    const cash = other.filter(g => g.key === 'CASH').reduce((a, g) => a + g.total, 0) + Math.max(c.cashUSD, 0);
    if (cash > 1) keep.push({ key: '現金與短債', v: cash, gray: true });
  }
  keep.sort((a, b) => b.v - a.v);
  if (!keep.length) { box.innerHTML = UI.empty(pending ? '正在抓 ETF 成分股…' : '目前沒有持股'); return; }
  const base = keep.reduce((a, n) => a + n.v, 0);
  loadSectors(keep.filter(n => n.link).map(n => n.key));
  // 先依產業分區（每區上面寫產業名稱），區裡面才是各家公司；公司方塊全部同一個顏色，只用分區表示產業
  const groups = {};
  for (const n of keep) {
    if (!n.link) continue;
    const cat = sectorOf(n.key) || 'other';
    (groups[cat] ??= { key: SECTORS.find(([k]) => k === cat)[1], cat, v: 0, kids: [] }).kids.push({ ...n, catName: SECTORS.find(([k]) => k === cat)[1] });
    groups[cat].v += n.v;
  }
  document.querySelectorAll('[data-tml]').forEach(b => b.classList.toggle('on', b.dataset.tml === tmLayout));
  // 依大小：不分區，全部照部位大小排；依產業：先分區
  const top = tmLayout === 'size' ? keep.map(n => ({ ...n, catName: n.link ? SECTORS.find(([k]) => k === (sectorOf(n.key) || 'other'))[1] : '' }))
    : [...Object.values(groups), ...keep.filter(n => !n.link)].sort((a, b) => b.v - a.v);
  const W = box.clientWidth, H = box.clientHeight, HEAD = 20, flat = [];
  const vMax = Math.max(...keep.filter(n => n.link).map(n => n.v), 1);
  let html = '';
  for (const g of squarify(top, { x: 0, y: 0, w: W, h: H })) {
    if (!g.kids) { flat.push(g); html += tile(g, flat.length - 1, g.x, g.y, g.w, g.h); continue; }
    const head = g.w > 70 && g.h > 50;   // 區塊夠大才放標題
    html += `<div class="tm-group" style="left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px">${head ? `<div class="tm-head">${g.key} <span class="money">${pctPlain(g.v / base, 1)}</span></div>` : ''}</div>`;
    const inner = { x: g.x + 2, y: g.y + (head ? HEAD : 2), w: g.w - 4, h: g.h - (head ? HEAD + 2 : 4) };
    for (const t of squarify(g.kids.sort((a, b) => b.v - a.v), inner)) { flat.push(t); html += tile(t, flat.length - 1, t.x, t.y, t.w, t.h); }
  }
  function tile(t, i, x, y, w, h) {
    const big = w > 64 && h > 38, mid = w > 38 && h > 22, tag = t.link ? 'a' : 'div';
    // 部位越大顏色越深（同一個藍色）
    const mix = Math.round(14 + 66 * Math.sqrt(t.v / vMax));
    const style = t.link ? `background:color-mix(in srgb, var(--accent) ${mix}%, var(--surface));color:${mix > 55 ? '#fff' : 'var(--text)'}` : '';
    return `<${tag} class="tm-tile${t.link ? '' : ' gray'}${t.link && mix > 55 ? ' dark' : ''}" data-ti="${i}" ${t.link ? `href="/symbol?s=${encodeURIComponent(t.key)}"` : ''}
      style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;${style}">
      ${mid ? `<b style="font-size:${big ? Math.min(20, 11 + Math.sqrt(w * h) / 18) : 11}px">${esc(t.key)}</b>` : ''}${big ? `<span>${pctPlain(t.v / base, 1)}</span>` : ''}</${tag}>`;
  }
  box.innerHTML = html + '<div class="chart-tip" hidden></div>';
  const tip = box.querySelector('.chart-tip');
  box.querySelectorAll('.tm-tile').forEach(n => {
    n.addEventListener('pointermove', e => {
      const t = flat[+n.dataset.ti], r = box.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      tip.hidden = false; tip.style.left = px + 'px'; tip.style.top = py + 'px';
      tip.style.transform = `translate(${px > W / 2 ? 'calc(-100% - 14px)' : '14px'}, ${py > H / 2 ? 'calc(-100% - 8px)' : '8px'})`;
      tip.innerHTML = `<b>${esc(t.key)}</b>${t.name ? ` ${esc(t.name)}` : ''}<br>${t.catName ? t.catName + '・' : ''}${usd0(t.v)}・${pctPlain(t.v / base, 1)}`;
    });
    n.addEventListener('pointerleave', () => { tip.hidden = true; });
  });
  el('treemapNote').innerHTML = all ? `佔淨資產 <span class="money">${usd0(base)}</span>` : `股票部位 <span class="money">${usd0(base)}</span>・淨資產的 <span class="money">${pctPlain(base / eq)}</span>`;
}

// ============ 年度總結：每年一列 ============
function renderYearly(c) {
  const box = el('yearBox'); if (!box) return;
  const hist = data.history;
  const years = [...new Set(hist.filter(h => !h.base).map(h => h.date.slice(0, 4)))].sort().reverse();
  if (!years.length) { box.innerHTML = '<div class="empty">資料還不夠</div>'; return; }
  const st = realizedStats(), fees = feesByMonth(), flowsAll = externalFlows(), thisYear = today().slice(0, 4);
  const rows = years.map(y => {
    const iStart = Math.max(0, hist.findIndex(h => h.date >= `${y}-01-01`) - 1);   // 從前一年最後一個收盤起算
    const iEnd = hist.map(h => h.date.slice(0, 4)).lastIndexOf(y);
    const start = hist[iStart], isNow = y === thisYear;
    const endDate = isNow ? today() : hist[iEnd].date, end = isNow ? c.totalUSD : hist[iEnd].usd;
    const flows = flowsAll.filter(f => f.date > start.date && f.date <= endDate).reduce((s, f) => s + f.usd, 0);
    const twr = dailyReturns(hist.slice(iStart, iEnd + 1), outsideAsFlow()).reduce((p, x) => p * (1 + x.r), 1) - 1;
    const yv = yearView(st, y);
    const fee = Object.entries(fees).filter(([k]) => k.startsWith(y)).reduce((s, [, o]) => s + o.stock + o.opt + o.int, 0);
    return { y, isNow, from: start.date >= `${y}-01-01` ? start.date : null, start: start.usd, flows, end, gain: end - start.usd - flows, twr, spx: benchRet('VOO', start.date, endDate),
             stock: yv.stock, option: yv.option, div: yv.div + yv.refund, fee };
  });
  const money = v => `<span class="num">${usd0(v)}</span>`, signed = v => `<span class="num ${cls(v)}">${usd0(v, { sign: true })}</span>`;
  box.innerHTML = `<div class="table-wrap"><table class="table table"><thead><tr>
      <th class="l">年份</th><th>年初資產</th><th>淨入金</th><th>年底資產</th><th>賺到的錢</th><th>報酬率</th><th>S&amp;P 500</th>
      <th class="sep">股票已實現</th><th>選擇權已實現</th><th>股息</th><th>交易成本</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td class="l"><b>${r.y}</b>${r.isNow ? '<span class="sub">至今</span>' : r.from ? `<span class="sub">${+r.from.slice(5, 7)}/${+r.from.slice(8)} 開始</span>` : ''}</td>
      <td>${money(r.start)}</td><td>${money(r.flows)}</td><td>${money(r.end)}</td><td><b>${signed(r.gain)}</b></td>
      <td><b class="num ${cls(r.twr)}">${pct(r.twr)}</b></td><td><span class="num">${r.spx == null ? '—' : pct(r.spx)}</span></td>
      <td class="sep">${signed(r.stock)}</td><td>${signed(r.option)}</td><td>${signed(r.div)}</td><td>${money(r.fee)}</td></tr>`).join('')}</tbody></table></div>
    <div class="note">賺到的錢＝年底 − 年初 − 淨入金（入金減出金）；報酬率是時間加權${outsideAsFlow() ? '，帳外獲利當入金' : ''}。今年的年底資產是目前的總資產。</div>`;
}

// ============ 標的查詢：某個標的的所有紀錄、勝率與買賣點 ============
let symQ = (new URLSearchParams(location.search).get('s') || '').trim().toUpperCase(), symMember = '', symF = 'all', symLimit = 50;
const symPx = {};   // 歷史收盤價快取
const symOf = t => t.type === 'buy' || t.type === 'sell' ? t.symbol
  : t.type === 'option' || t.type === 'expire' ? occ(t.symbol)?.root
  : t.type === 'income' && /^股息 /.test(t.category || '') ? t.category.slice(3).trim() : null;
function symIndex() {
  // 每個標的（同公司不同股別、槓桿 ETF、選擇權都併在一起）有哪些代號、幾筆紀錄
  const idx = {};
  for (const t of data.transactions) {
    const s = symOf(t); if (!s) continue;
    const o = idx[grp(s)] ??= { g: grp(s), members: {}, n: 0 };
    o.members[s] = (o.members[s] || 0) + 1; o.n++;
  }
  return idx;
}
function symGo(q) {
  symQ = (q || '').trim().toUpperCase(); symMember = ''; symF = 'all'; symLimit = 50;
  history.replaceState(null, '', symQ ? `/symbol?s=${encodeURIComponent(grp(symQ))}` : '/symbol');
  renderSymbolPage(calc());
}
async function loadSymPx(sym, from) {
  if (symPx[sym]) return;
  symPx[sym] = 'loading';
  try { symPx[sym] = (await (await fetch(`/api/history?symbols=${encodeURIComponent(sym)}&from=${from}`)).json())[sym] || { error: 1 }; }
  catch { symPx[sym] = { error: 1 }; }
  if (el('symChart')) renderSymbolPage(calc());
}
function renderSymbolPage(c) {
  const box = el('symSummary'); if (!box) return;
  const idx = symIndex(), ranked = Object.values(idx).sort((a, b) => b.n - a.n);
  el('symOptions').innerHTML = ranked.flatMap(o => Object.keys(o.members)).map(s => `<option value="${esc(s)}">`).join('');
  const g = symQ ? grp(symQ) : ranked[0]?.g, info = idx[g];
  // 大盤、類股這類分組用中文名稱，個股用代號
  el('symChips').innerHTML = ranked.slice(0, 12).map(o => `<button class="${o.g === g ? 'on' : ''}" data-sym-go="${esc(o.g)}">${esc(INDEX_GROUPS.has(o.g) ? grpName(o.g) : o.g)}<span>${o.n}</span></button>`).join('');
  if (!info) {
    box.innerHTML = `<div class="empty">找不到 ${esc(symQ)} 的紀錄</div>`;
    ['symChart', 'symList', 'symMembers', 'symLegend'].forEach(id => { el(id).innerHTML = ''; });
    el('symName').textContent = '總覽'; return;
  }
  if (document.activeElement !== el('symInput')) el('symInput').value = symQ || '';
  const members = Object.entries(info.members).sort((a, b) => b[1] - a[1]);
  if (symMember && !info.members[symMember]) symMember = '';
  const inSel = s => !!s && (symMember ? s === symMember : grp(s) === g);
  el('symName').textContent = grpName(g) + (symMember ? `・${symMember}` : '');
  el('symMembers').innerHTML = members.length > 1 ? `<span class="seg">${[['', '全部'], ...members.map(([s]) => [s, s])].map(([s, t]) => `<button data-sym-member="${esc(s)}" class="${s === symMember ? 'on' : ''}">${esc(t)}</button>`).join('')}</span>` : '';

  // ---- 總覽 ----
  const st = realizedStats();
  const se = st.stockEvents.filter(e => inSel(e.sym)), oe = st.optEvents.filter(e => inSel(occ(e.sym)?.root));
  const sw = winStats(se), ow = winStats(oe), shortW = winStats(oe.filter(e => e.side === 'short')), longW = winStats(oe.filter(e => e.side === 'long'));
  const recs = [...data.transactions, ...st.expiries].filter(t => inSel(symOf(t))).sort((a, b) => b.date.localeCompare(a.date) || (b.ts || 0) - (a.ts || 0));
  const div = recs.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const holdEv = stockHoldingEvents(st).filter(e => inSel(e.sym)), avgHold = holdEv.length ? holdEv.reduce((s, e) => s + e.hold, 0) / holdEv.length : null;
  const heldRows = c.rows.filter(r => inSel(r.sym)), heldOpts = c.optRows.filter(o => inSel(occ(o.sym).root));
  const all = [...se.map(e => ({ ...e, what: `賣出 ${e.sym}` })), ...oe.map(e => ({ ...e, what: optName(e.sym) + (e.expired ? ' 到期' : '') }))];
  const best = all.reduce((a, e) => !a || e.r > a.r ? e : a, null), worst = all.reduce((a, e) => !a || e.r < a.r ? e : a, null);
  const total = sw.total + ow.total + div;
  const rate = w => w.rate == null ? '—' : pctPlain(w.rate);
  const kv = UI.kv;
  const signed = v => `<span class="num ${cls(v)}">${usd0(v, { sign: true })}</span>`;
  box.innerHTML = `
    <div class="tile hero"><div class="k">已實現損益合計</div><div class="v num ${cls(total)}">${usd0(total, { sign: true })}</div>
      <div class="s">股票 ${signed(sw.total)}・選擇權 ${signed(ow.total)}${div ? `・股息 ${signed(div)}` : ''}</div></div>
    <div class="kv-group"><div class="kv-title">股票</div>
      ${sw.n ? kv('賣出', `${sw.n} 筆・勝率 <b>${rate(sw)}</b>`) + kv('平均賺／賠', `${signed(sw.avgW)} ／ ${signed(sw.avgL)}`) + kv('獲利因子', sw.pf == null ? '—' : sw.pf.toFixed(2)) + kv('平均持有', avgHold == null ? '—' : `${avgHold < 1 ? '不到 1' : Math.round(avgHold)} 天`)
        : '<div class="sub">沒有賣出過</div>'}</div>
    <div class="kv-group"><div class="kv-title">選擇權</div>
      ${ow.n ? kv('平倉或到期', `${ow.n} 口・勝率 <b>${rate(ow)}</b>`) + (shortW.n ? kv('賣方', `${shortW.n} 口・勝率 ${rate(shortW)}・${signed(shortW.total)}`) : '') + (longW.n ? kv('買方', `${longW.n} 口・勝率 ${rate(longW)}・${signed(longW.total)}`) : '') + kv('獲利因子', ow.pf == null ? '—' : ow.pf.toFixed(2))
        : '<div class="sub">沒有做過選擇權</div>'}</div>
    ${best && best !== worst ? `<div class="kv-group"><div class="kv-title">最賺／最賠的一筆</div>
      ${kv(`${best.date.slice(2).replace(/-/g, '/')} ${esc(best.what)}`, signed(best.r))}${kv(`${worst.date.slice(2).replace(/-/g, '/')} ${esc(worst.what)}`, signed(worst.r))}</div>` : ''}
    <div class="kv-group"><div class="kv-title">目前持有</div>
      ${heldRows.length || heldOpts.length ? heldRows.map(r => kv(esc(r.sym), `${fmtShares(r.shares)} 股・<span class="num">${usd0(r.value)}</span>`)).join('') + heldOpts.map(o => kv(esc(optName(o.sym)), `${o.qty} 口・<span class="num">${usd0(o.value)}</span>`)).join('')
        : '<div class="sub">目前沒有持有</div>'}</div>
    <div class="kv-group">${kv('期間', `${recs.at(-1).date} ～ ${recs[0].date}`)}${kv('紀錄', `${recs.length} 筆`)}</div>`;

  // ---- 價格走勢與買賣點：畫交易最多的那個代號 ----
  const chartSym = symMember || (info.members[g] ? g : members[0][0]);
  const first = recs.at(-1).date, from = new Date(new Date(first).getTime() - 14 * 864e5).toISOString().slice(0, 10);
  const ser = symPx[chartSym];
  const legendSym = members.length > 1 && !symMember ? `<span class="sub" style="display:inline">圖上只標 ${esc(chartSym)} 的操作</span>` : '';
  el('symLegend').innerHTML = `<span class="legend-item"><span class="dot" style="background:var(--s1)"></span>買進</span><span class="legend-item"><span class="dot" style="background:var(--s2)"></span>賣出</span><span class="legend-item"><span class="dot hollow"></span>選擇權</span>${legendSym}`;
  if (!ser) { loadSymPx(chartSym, from); el('symChart').innerHTML = '<div class="empty">載入股價中…</div>'; }
  else if (ser === 'loading') { /* 等它載完 */ }
  else if (ser.error) el('symChart').innerHTML = `<div class="empty">抓不到 ${esc(chartSym)} 的歷史股價</div>`;
  else {
    const ds = Object.keys(ser).filter(d => d >= from).sort();
    const byDay = {};
    for (const t of recs) if (symOf(t) === chartSym && t.type !== 'income') (byDay[t.date] ??= []).push(t);
    const pts = ds.map(d => ({ x: new Date(d).getTime(), y: ser[d], d, label: d, trades: byDay[d] || [] }));
    const at = d => pts.find(p => p.d >= d);
    const dots = [];
    for (const [d, ts] of Object.entries(byDay)) {
      const p = at(d); if (!p) continue;
      const stock = ts.filter(t => t.type === 'buy' || t.type === 'sell');
      if (stock.length) dots.push({ x: p.x, y: p.y, fill: stock.some(t => t.type === 'sell') && !stock.some(t => t.type === 'buy') ? 'var(--s2)' : stock.some(t => t.type === 'buy') && !stock.some(t => t.type === 'sell') ? 'var(--s1)' : 'var(--s4)' });
      else dots.push({ x: p.x, y: p.y, fill: 'var(--surface)', stroke: 'var(--text-2)', r: 3.5 });
    }
    const line = t => t.type === 'buy' ? `買 ${fmtShares(t.shares)} 股 @ ${usd(t.price)}` : t.type === 'sell' ? `賣 ${fmtShares(t.shares)} 股 @ ${usd(t.price)}`
      : t.type === 'expire' ? `${esc(optName(t.symbol))} 到期` : `${t.qty > 0 ? '買' : '賣'} ${esc(optName(t.symbol))}`;
    lineChart(el('symChart'), pts, { fmtY: v => '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2)), area: false, dots,
      fmtTip: p => `${p.d}<br>收盤 <b>${usd(p.y)}</b>${p.trades.length ? '<br>' + p.trades.slice(0, 6).map(line).join('<br>') + (p.trades.length > 6 ? `<br>…還有 ${p.trades.length - 6} 筆` : '') : ''}` });
  }

  // ---- 全部紀錄 ----
  document.querySelectorAll('[data-sym-f]').forEach(b => b.classList.toggle('on', b.dataset.symF === symF));
  const shown = recs.filter(t => symF === 'all' || (symF === 'stock' ? t.type === 'buy' || t.type === 'sell' : symF === 'option' ? t.type === 'option' || t.type === 'expire' : t.type === 'income'));
  const row = t => {
    let type = '', what = '', amt = 0, r = null;
    if (t.type === 'buy' || t.type === 'sell') {
      type = t.split ? '分割' : t.type === 'buy' ? '買進' : '賣出';
      what = t.split ? `${esc(t.symbol)} 分割，多 ${fmtShares(t.shares)} 股` : `${esc(t.symbol)} ${fmtShares(t.shares)} 股 @ <span class="num">${usd(t.price)}</span>`;
      amt = t.type === 'buy' ? -t.total : t.total; r = t.type === 'sell' ? st.perSell[t.id] : null;
    } else if (t.type === 'option') {
      type = t.action === 'close' ? '平倉' : t.action === 'open' ? '開倉' : '選擇權';
      what = `${t.qty > 0 ? 'BUY' : 'SELL'} ${esc(optName(t.symbol, t.desc))}`; amt = t.amount; r = st.perOpt[t.id];
    } else if (t.type === 'expire') { type = '到期'; what = `${esc(optName(t.symbol, t.desc))}`; r = t.realized; }
    else { type = '股息'; what = esc(t.category); amt = t.amount; }
    return `<tr><td class="l">${t.date}</td><td class="l"><span class="badge">${type}</span></td><td class="l">${what}</td>
      <td><span class="num">${t.type === 'expire' ? '—' : usd(amt, { sign: true })}</span></td><td>${r == null ? '' : `<span class="num ${cls(r)}">${usd(r, { sign: true })}</span>`}</td></tr>`;
  };
  el('symList').innerHTML = shown.length ? `<div class="table-wrap"><table class="table table"><thead><tr><th class="l">日期</th><th class="l">類型</th><th class="l">內容</th><th>金額</th><th>已實現</th></tr></thead>
      <tbody>${shown.slice(0, symLimit).map(row).join('')}</tbody></table></div>
      ${shown.length > symLimit ? `<div class="more-row"><button class="ghost" data-sym-more="1">顯示更多（還有 ${shown.length - symLimit} 筆）</button></div>` : ''}`
    : '<div class="empty">沒有這類紀錄</div>';
}

// ============ 對外：每次畫面更新時呼叫 ============
window.renderExtras = function renderExtras(c) {
  if (!data) return;
  c = c || calc();
  applyPrivacy(); applyCalm();
  try { renderAlertBar(computeAlerts(c)); } catch (err) { console.error('alerts', err); }
  // 每一頁只有自己的區塊；不在這一頁的直接略過
  const parts = [
    ['progressBox', () => renderProgress(c)], ['planSummary', renderPlanSummary], ['eventsBox', () => renderEvents(c)],
    ['planList', () => renderPlans(c)], ['metricsBox', renderMetrics], ['heatBox', renderHeat],
    ['exposureBox', () => renderExposure(c)], ['etfBox', () => renderEtfView(c)], ['optRiskBox', () => renderOptRisk(c)],
    ['journalBox', renderJournal], ['analysisBox', renderAnalysis], ['monthlyBox', renderMonthly], ['feeBox', renderFees],
    ['yearBox', () => renderYearly(c)], ['symSummary', () => renderSymbolPage(c)],
    ['holdScatterBox', renderHoldScatter], ['treemapBox', () => renderTreemap(c)],
  ];
  for (const [name, fn] of parts) {
    const b = el(name); if (!b) continue;
    try { fn(); } catch (err) { console.error(name, err); b.innerHTML = `<div class="empty">這個區塊出錯了：${esc(err.message)}</div>`; }
  }
};

// ============ 事件 ============
const confirmClick = (b, label) => {
  // 第一次按只是確認，3 秒內再按一次才執行
  if (b.dataset.confirm) return true;
  b.dataset.confirm = '1'; b.textContent = '確定？';
  setTimeout(() => { if (b.isConnected) { delete b.dataset.confirm; b.textContent = label; } }, 3000);
  return false;
};
const setPlan = (id, status) => {
  const p = (data.plans || []).find(x => x.id === id); if (!p) return;
  p.status = status; p.closedAt = today();
  if (planEditId === id) { planEditId = null; fillPlanForm(null); }
  save(); window.renderExtras();
};
function lookupEtf() {
  const v = el('etfLookup').value.trim().toUpperCase();
  if (!/^[A-Z.\-]{1,10}$/.test(v)) return;
  etfView = v; store.set('etfView', v); el('etfLookup').blur(); renderEtfView(calc());
}
document.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'privacyBtn') { store.set('privacy', store.get('privacy', '0') === '1' ? '0' : '1'); applyPrivacy(); }
  else if (b.id === 'calmBtn') { store.set('calm', isCalm() ? '0' : '1'); peek(false); applyCalm(); render(); }
  else if (b.id === 'peekBtn') peek(!document.documentElement.classList.contains('peek'));
  else if (b.dataset.mood) { jMood = b.dataset.mood; renderJournal(); }
  else if (b.dataset.pfAct) {
    const f = el('planForm'); f.querySelector('[data-pf="action"]').value = b.dataset.pfAct;
    if (b.dataset.pfAct === 'dca' && !f.querySelector('[data-pf="repeat"]').value) f.querySelector('[data-pf="repeat"]').value = 'month';
    updatePlanCalc();
  }
  else if (b.dataset.pfLeg) { el('planForm').querySelector('[data-pf="leg"]').value = b.dataset.pfLeg; updatePlanCalc(); }
  else if (b.dataset.planSave) savePlan();
  else if (b.dataset.planCancel) { planEditId = null; fillPlanForm(null); store.set('planDraft', 'null'); updatePlanCalc(); }
  else if (b.dataset.planEdit) editPlan(b.dataset.planEdit);
  else if (b.dataset.planClose) setPlan(b.dataset.planClose, 'closed');
  else if (b.dataset.planVoid) { if (confirmClick(b, '作廢')) setPlan(b.dataset.planVoid, 'void'); }
  else if (b.dataset.planDel) { if (confirmClick(b, '刪除')) { data.plans = (data.plans || []).filter(p => p.id !== b.dataset.planDel); save(); renderPlans(calc()); } }
  else if (b.dataset.expoAll) { expoAll = !expoAll; renderExposure(calc()); }
  else if (b.dataset.etf) { etfView = b.dataset.etf; store.set('etfView', etfView); renderEtfView(calc()); }
  else if (b.id === 'etfLookupBtn') lookupEtf();
  else if (b.id === 'jSave') {
    const text = el('jText').value.trim();
    if (!text) { el('jText').focus(); return; }
    data.journal = [...(data.journal || []), { id: uid(), date: today(), ts: Date.now(), mood: jMood, sym: el('jSym').value.trim().toUpperCase(), text }];
    save(); el('jText').value = ''; el('jSym').value = ''; renderJournal(); toast('記下來了');
  }
  else if (b.dataset.jdel) { if (confirmClick(b, '✕')) { data.journal = (data.journal || []).filter(j => j.id !== b.dataset.jdel); save(); renderJournal(); } }
  else if (b.dataset.x === 'metrics') { metricsRange = b.dataset.v; store.set('metricsRange', metricsRange); renderMetrics(); }
  else if (b.dataset.symGo) symGo(b.dataset.symGo);
  else if (b.id === 'symGoBtn') symGo(el('symInput').value);
  else if (b.dataset.symMember != null) { symMember = b.dataset.symMember; symLimit = 50; renderSymbolPage(calc()); }
  else if (b.dataset.symF) { symF = b.dataset.symF; symLimit = 50; renderSymbolPage(calc()); }
  else if (b.dataset.symMore) { symLimit += 100; renderSymbolPage(calc()); }
  else if (b.dataset.sc) { scView = b.dataset.sc; renderHoldScatter(); }
  else if (b.dataset.tmv) { tmView = b.dataset.tmv; renderTreemap(calc()); }
  else if (b.dataset.tml) { tmLayout = b.dataset.tml; renderTreemap(calc()); }
  else if (b.dataset.mrange) { monthlyRange = b.dataset.mrange; renderMonthly(); }
  else if (b.dataset.ana) { anaView = b.dataset.ana; store.set('anaView', anaView); renderAnalysis(); }
  else if (b.dataset.anaall) { anaShowAll = !anaShowAll; renderAnalysis(); }
  else if (b.dataset.dismiss != null) {
    const key = 'dismiss.' + today(), set = new Set((store.get(key, '') || '').split('|').filter(Boolean));
    set.add(b.dataset.dismiss); store.set(key, [...set].join('|')); window.renderExtras();
  }
});
document.addEventListener('input', e => { if (e.target.closest('#planForm')) updatePlanCalc(); });
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'etfLookup') lookupEtf(); if (e.key === 'Enter' && e.target.id === 'symInput') symGo(e.target.value); });
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'symInput' && t.value && symIndex()[grp(t.value.trim().toUpperCase())]) { symGo(t.value); return; }   // 從清單選了一個代號
  if (t.id === 'outsideFlowChk') { store.set('outsideAsFlow', t.checked ? '1' : '0'); window.renderExtras(); }
});
window.addEventListener('resize', () => { clearTimeout(window._rzx); window._rzx = setTimeout(() => window.renderExtras(), 200); });
})();
