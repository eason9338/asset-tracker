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
function lineChart(box, pts, { fmtY, fmtTip, color = 'var(--accent)', zero = false, area = true, ref = null, mark = null }) {
  if (!box || box.clientWidth === 0) return;
  if (pts.length < 2) { box.innerHTML = '<div class="x-empty">資料不足</div>'; return; }
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
  const st = realizedStats(), y = String(new Date().getFullYear());
  const realized = st.stockEvents.concat(st.optEvents).filter(e => e.date.startsWith(y)).reduce((s, e) => s + e.r, 0)
    + data.transactions.filter(t => t.type === 'income' && t.date.startsWith(y) && /^(股息|退稅|利息)/.test(t.category || '')).reduce((s, t) => s + t.amount, 0);
  return { start, flows, gain: c.totalUSD - start.usd - flows, twr: rets.reduce((p, x) => p * (1 + x.r), 1) - 1,
           qqq: benchRet('QQQ', start.date, endDate), voo: benchRet('VOO', start.date, endDate), realized };
}
function renderProgress(c) {
  const box = el('progressBox'); if (!box) return;
  const y = ytdStats(c);
  if (!y) { box.innerHTML = '<div class="x-empty">今年的資料還不夠</div>'; el('heroCalm').innerHTML = ''; return; }
  const twd = v => fx ? `≈ ${fmt(v * fx, 'TWD', { sign: true })}` : '';
  el('heroCalm').innerHTML = `<span class="muted">今年累積</span> <b class="num">${usd0(y.gain, { sign: true })}</b> <span class="muted num">（${pct(y.twr)}）</span>`;
  el('progressNote').textContent = `從 ${y.start.date} 收盤起算`;
  const beat = (b, n) => b == null ? '' : `<div class="x-tile"><div class="k">對 ${n}</div><div class="v num">${pct(y.twr - b)}</div><div class="s">${n} 同期 <span class="x-money">${pct(b)}</span></div></div>`;
  box.innerHTML = `<div class="x-grid">
      <div class="x-tile"><div class="k">今年賺到的錢</div><div class="v num">${usd0(y.gain, { sign: true })}</div><div class="s"><span class="num">${twd(y.gain)}</span>・已扣除入金 <span class="num">${usd0(y.flows)}</span></div></div>
      <div class="x-tile"><div class="k">帳戶報酬率</div><div class="v num">${pct(y.twr)}</div><div class="s">時間加權${outsideAsFlow() ? '，帳外獲利當入金' : ''}</div></div>
      ${beat(y.qqq, 'Nasdaq 100')}${beat(y.voo, 'S&P 500')}
      <div class="x-tile"><div class="k">今年已實現</div><div class="v num">${usd0(y.realized, { sign: true })}</div><div class="s">股票＋選擇權＋股息利息，已經落袋的部分</div></div>
    </div>
    <div class="x-note">${isCalm() ? '平靜模式開啟中：所有分頁的金額、漲跌和圖表都先收起來。單日的起伏看久了只會累，用整年的成績看自己就好。按「👁 看一下」可以暫時顯示，「◉ 平靜中」可以關掉。' : '想少看一點餘額和每天的漲跌，可以打開右上角的「◎ 平靜」。'}</div>`;
}

// ============ 近期事件：財報、配息、選擇權到期 ============
const INDEX_GROUPS = new Set(['SOX', 'NDX', 'SPX', 'BTC', 'SILVER', 'GOLD', 'CASH']);
let eventCache = { at: 0, key: '', data: null, loading: false };
function eventSymbols(c) {
  const set = new Set();
  const addSym = s => { set.add(s); const u = UNDERLYING[s]; if (u && !INDEX_GROUPS.has(u)) set.add(u); };
  for (const r of c.rows) addSym(r.sym);
  for (const o of c.optRows) addSym(occ(o.sym).root);
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
  const syms = eventSymbols(c);
  if (!syms.length) { box.innerHTML = '<div class="x-empty">目前沒有持股</div>'; return; }
  if ((eventCache.key !== syms.join(',') || Date.now() - eventCache.at > 3600e3) && !eventCache.loading) loadEvents(syms);
  const tz = d => new Date(d).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const ev = [];
  const now = Date.now(), horizon = now + 75 * 864e5;
  for (const [sym, e] of Object.entries(eventCache.data || {})) {
    if (sym.startsWith('_') || !e) continue;
    const affected = c.rows.filter(r => grp(r.sym) === grp(sym)).map(r => r.sym)
      .concat(c.optRows.filter(o => grp(occ(o.sym).root) === grp(sym)).map(o => optName(o.sym)));
    if (e.earnings && e.earnings * 1000 > now - 864e5 && e.earnings * 1000 < horizon)
      ev.push({ t: e.earnings * 1000, kind: '財報', title: `${grpName(grp(sym))} 公布財報${e.earningsEstimate ? '（預估日期）' : ''}`, when: tz(e.earnings * 1000) + '（台灣時間）', sub: affected.length ? `會影響：${affected.join('、')}` : '' });
    if (e.exDividend && e.exDividend * 1000 > now - 864e5 && e.exDividend * 1000 < horizon)
      ev.push({ t: e.exDividend * 1000, kind: '除息', title: `${sym} 除息`, when: tz(e.exDividend * 1000), sub: '除息日前一天收盤持有才領得到' });
  }
  for (const o of c.optRows) {
    const oc = occ(o.sym), t = new Date(oc.exp + 'T20:00:00Z').getTime();
    ev.push({ t, kind: '到期', title: `${optName(o.sym)} 到期`, when: tz(t) + '（美東收盤）', sub: `${o.qty > 0 ? '買方' : '賣方'} ${Math.abs(o.qty)} 口` });
  }
  ev.sort((a, b) => a.t - b.t);
  // 同一家公司的不同股別（GOOG、GOOGL）會查到同一場財報，只留一筆
  const seen = new Set();
  for (let i = ev.length - 1; i >= 0; i--) { const k = ev[i].kind + ev[i].title + new Date(ev[i].t).toDateString(); if (seen.has(k)) ev.splice(i, 1); else seen.add(k); }
  if (!ev.length) { box.innerHTML = `<div class="x-empty">${eventCache.loading || !eventCache.data ? '讀取中…' : '接下來 75 天沒有已知的事件'}</div>`; return; }
  box.innerHTML = ev.map(e => {
    const d = Math.ceil((e.t - now) / 864e5);
    return `<div class="ev-row"><span class="x-badge ${e.kind === '財報' ? 'danger' : ''}">${e.kind}</span>
      <div class="ev-main"><b>${esc(e.title)}</b><span class="x-sub">${esc(e.when)}${e.sub ? '・' + esc(e.sub) : ''}</span></div>
      <div class="ev-days num">${d <= 0 ? '今天' : `還有 ${d} 天`}</div></div>`;
  }).join('') + '<div class="x-note">財報與配息日期來自 Yahoo；財報當天股價和選擇權的波動通常最大。</div>';
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
  bar.innerHTML = show.map(a => `<div class="alert-item ${a.lvl}"><span class="tag">${a.tag}</span><span class="msg">${a.msg}</span>
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
  if (rets.length < 5) { box.innerHTML = outsideToggle() + '<div class="x-empty">資料不足（至少要 5 個交易日）</div>'; el('ddBox').innerHTML = ''; return; }
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
  box.innerHTML = outsideToggle() + `<div class="x-grid" style="margin-bottom:12px">
      <div class="x-tile"><div class="k">年化報酬</div><div class="v num ${cls(me.ann ?? me.total)}">${me.ann == null ? pct(me.total) : pct(me.ann)}</div><div class="s">${me.ann == null ? '期間太短，顯示期間報酬' : `期間 ${from} ～ ${to}`}</div></div>
      <div class="x-tile"><div class="k">夏普比率</div><div class="v num">${n2(me.sharpe)}</div><div class="s">每承擔一單位波動，多賺多少（無風險利率 ${pctPlain(rf, 2)}）</div></div>
      <div class="x-tile"><div class="k">最大回撤</div><div class="v num down">${pct(me.mdd)}</div><div class="s">${me.trough ? `${me.ddPeak} 高點 → ${me.trough} 低點${me.recov ? `，${me.recov} 回到前高` : '，還沒回到前高'}` : '—'}</div></div>
      <div class="x-tile"><div class="k">Beta（對 Nasdaq 100）</div><div class="v num">${n2(bq.beta)}</div><div class="s">大盤漲跌 1%，你平均漲跌約 <span class="x-money">${n2(bq.beta)}%</span>；相關係數 <span class="x-money">${n2(bq.corr)}</span></div></div>
      <div class="x-tile"><div class="k">Beta（對 S&P 500）</div><div class="v num">${n2(bv.beta)}</div><div class="s">相關係數 <span class="x-money">${n2(bv.corr)}</span></div></div>
    </div>
    <div class="table-wrap" style="margin:0"><table class="x-table">
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
  if (!rets.length) { box.innerHTML = '<div class="x-empty">資料不足</div>'; return; }
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
    return main ? `<td class="num" style="${color(v)}" title="${ym}：${pct(v)}（Nasdaq 100 ${pct((qq[ym] ?? NaN) - 1)}）">${pct(v, 1)}</td>` : `<td class="num">${pct(v, 1)}</td>`;
  };
  const yearTotal = (map, y) => { const ms = Object.keys(map).filter(m => m.startsWith(y)); return ms.length ? ms.reduce((p, m) => p * map[m], 1) - 1 : null; };
  box.innerHTML = `<div class="table-wrap" style="margin:0"><table class="heat">
    <thead><tr><th></th>${Array.from({ length: 12 }, (_, i) => `<th>${i + 1}月</th>`).join('')}<th>全年</th></tr></thead>
    <tbody>${years.map(y => {
      const yt = yearTotal(me, y), qt = yearTotal(qq, y);
      return `<tr><td class="lbl"><b>${y}</b></td>${Array.from({ length: 12 }, (_, i) => cell(me, `${y}-${String(i + 1).padStart(2, '0')}`, true)).join('')}
          <td class="num" style="${color(yt)}"><b>${pct(yt, 1)}</b></td></tr>
        <tr class="bm"><td class="lbl">Nasdaq 100</td>${Array.from({ length: 12 }, (_, i) => cell(qq, `${y}-${String(i + 1).padStart(2, '0')}`, false)).join('')}<td class="num">${pct(qt, 1)}</td></tr>`;
    }).join('')}</tbody></table></div>
    <div class="x-note">${outsideAsFlow() ? '目前把帳外獲利當入金計算（上方開關）。' : ''}每格是那個月的時間加權報酬；顏色越深代表漲跌越大。灰色那一列是同期 Nasdaq 100，方便比較。第一個月只從紀錄開始那天算起。</div>`;
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
  const c = calc(); renderExposure(c); renderEtfView(c);
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
  if (!stocks.length && !other.length) { box.innerHTML = '<div class="x-empty">目前沒有持股</div>'; el('exposureNote').textContent = ''; return; }
  const sum = stocks.reduce((s, g) => s + g.total, 0), top5 = stocks.slice(0, 5).reduce((s, g) => s + g.total, 0);
  const max = Math.max(...stocks.concat(other).map(g => Math.abs(g.total)), 1);
  el('exposureNote').innerHTML = stocks[0] ? `最大：${esc(stocks[0].key)} <span class="x-money">${pctPlain(stocks[0].total / eq)}</span> 淨資產` : '';
  const row = (g, muted) => {
    const share = g.total / eq, w = Math.abs(g.total) / max * 100;
    const via = Object.entries(g.via).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    return `<div class="hbar-row expo-row ${muted ? 'muted-row' : ''}"><div class="hbar-name">${muted ? esc(g.name) : `${esc(g.key)} <span class="x-sub">${esc(g.name || '')}</span>`}</div>
      <div class="hbar-track"><i class="${g.total >= 0 ? '' : 'neg'}" style="left:0;width:${w}%"></i></div>
      <div class="hbar-val num">${usd0(g.total)} <span class="x-sub">${pctPlain(share, 1)} 淨資產</span></div>
      <div class="hbar-items">${via.map(([k, v]) => `<span class="x-chip">${esc(k)} ${usd0(v)}</span>`).join('')}</div></div>`;
  };
  const shown = expoAll ? stocks : stocks.slice(0, 15);
  box.innerHTML = `<div class="x-grid" style="margin-bottom:12px">
      <div class="x-tile"><div class="k">個股曝險合計</div><div class="v num">${usd0(sum)}</div><div class="s">淨資產的 <span class="x-money">${pctPlain(sum / eq)}</span></div></div>
      <div class="x-tile"><div class="k">涵蓋公司</div><div class="v">${stocks.length} 家</div><div class="s">ETF 只拆前 50 大持股</div></div>
      <div class="x-tile"><div class="k">前 5 大公司合計</div><div class="v num">${pctPlain(top5 / eq)}</div><div class="s">佔淨資產</div></div>
    </div>
    ${pending ? '<div class="x-sub" style="margin-bottom:6px">正在抓 ETF 成分股…</div>' : ''}
    ${shown.map(g => row(g)).join('')}
    ${stocks.length > 15 ? `<button class="ghost" data-expo-all="1" style="margin-top:8px">${expoAll ? '只看前 15 家' : `顯示全部 ${stocks.length} 家`}</button>` : ''}
    ${other.length ? `<div class="x-sub" style="margin:14px 0 2px">不是個股的部分</div>${other.map(g => row(g, true)).join('')}` : ''}
    <div class="x-note">曝險＝市值 × 槓桿倍數。ETF 依成分股權重拆開，例如 100 元的 VOO 裡約有 ${(etfData.VOO?.top?.[0]?.w ?? 8).toFixed(1)} 元是 ${esc(etfData.VOO?.top?.[0]?.sym || 'NVDA')}；
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
  if (!d) { box.innerHTML = head + '<div class="x-empty">正在抓成分股…</div>'; return; }
  if (d.error) { box.innerHTML = head + `<div class="x-empty">抓不到 ${esc(etfView)} 的成分股：${esc(d.error)}</div>`; return; }
  const maxW = Math.max(...d.top.map(h => h.w), 1);
  box.innerHTML = head + `
    ${d.stocks ? '' : `<div class="x-sub" style="margin:8px 0">${esc(etfView)} 主要持有交換合約或選擇權，不是直接持有股票，所以曝險總覽不會用它來拆。</div>`}
    <div class="x-sub" style="margin:8px 0">共 ${d.count} 檔持股，前 ${d.top.length} 大合計 ${d.topSum.toFixed(1)}%${mine ? `・你透過 ${esc(etfView)} 的曝險 <span class="x-money">${usd0(mine)}</span>` : ''}</div>
    <div class="table-wrap" style="margin:0"><table class="x-table etf-table"><thead><tr><th>#</th><th class="l">代號</th><th class="l">公司</th><th>每 100 元裡</th>${mine ? '<th>你的曝險</th>' : ''}</tr></thead>
      <tbody>${d.top.map((h, i) => `<tr><td class="rank">${i + 1}</td><td class="l"><b>${esc(h.sym || '—')}</b></td><td class="l name">${esc(titleCase(h.name))}</td>
        <td class="w" style="--w:${(h.w / maxW * 100).toFixed(1)}%">${h.w.toFixed(2)} 元</td>${mine ? `<td><span class="x-money">${usd0(mine * h.w / 100)}</span></td>` : ''}</tr>`).join('')}</tbody></table></div>
    <div class="x-note">資料來自 Zacks（${new Date(d.fetched * 1000).toLocaleDateString('zh-TW')} 抓取${d.stale ? '，今天抓不到，先用上次的資料' : ''}），ETF 的持股每天會小幅變動。</div>`;
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
const fmtDay = d => `${d.slice(5).replace('-', '/')}（週${WEEKDAY[new Date(d + 'T12:00:00Z').getUTCDay()]}）`;
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
    if (after && after.pct * 100 > RULES.cap) w.push({ bad: true, t: `守則 3：交易後 ${esc(grpName(grp(sym)))} 會佔總資產 <span class="x-money">${pctPlain(after.pct)}</span>，超過 ${RULES.cap}%` });
    else if (after) w.push({ t: `交易後 ${esc(grpName(grp(sym)))} 佔總資產 <span class="x-money">${pctPlain(after.pct)}</span>（上限 ${RULES.cap}%）` });
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
  el('planCalc').innerHTML = amt ? `金額 <span class="x-money">${usd0(amt)}</span>${isOpt ? '（被指派時要付）' : ''}・佔總資產 <span class="x-money">${pctPlain(amt / c.totalUSD, 1)}</span>` : '';
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
      <label class="pc-field pc-sym"><span>標的</span><input data-pf="sym" list="planSyms" placeholder="例如 VOO" autocomplete="off"></label>
      <div class="pc-field"><span>要做什麼</span><div class="pc-acts">${Object.entries(PLAN_ACTIONS).map(([k, t]) => `<button type="button" data-pf-act="${k}">${t}</button>`).join('')}</div></div>
      <div class="pc-field" data-pf-opt hidden><span>開倉或平倉</span><div class="pc-acts">${Object.entries(OPT_LEGS).map(([k, t]) => `<button type="button" data-pf-leg="${k}">${t}</button>`).join('')}</div></div>
      <input type="hidden" data-pf="action" value="buy"><input type="hidden" data-pf="leg" value="open">
    </div>
    <div class="pc-nums">
      <label class="pc-field"><span data-pf-label="qty">股數</span><input type="number" step="any" min="0" data-pf="qty"></label>
      <label class="pc-field"><span data-pf-label="price">價格</span><input type="number" step="any" min="0" data-pf="price"></label>
      <label class="pc-field" data-pf-opt hidden><span>到期日</span><input type="date" data-pf="exp"></label>
      <label class="pc-field"><span>買進日期（選填）</span><input type="date" data-pf="when"></label>
      <label class="pc-field"><span>重複</span><select data-pf="repeat">${Object.entries(REPEAT).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select></label>
      <div class="pc-calc" id="planCalc"></div>
    </div>
    <div class="pc-grid">
      <label class="pc-field wide"><span>為什麼要做（一兩句就好）</span><textarea data-pf="thesis" rows="2"></textarea></label>
      <label class="pc-field wide"><span>價格或條件</span><input data-pf="entry" placeholder="例如：回到 330 以下再買、收盤跌破 315 就賣"></label>
    </div>
    <div id="planWarn"></div>
    <div class="pc-foot"><span class="x-sub" id="planWhen"></span><button class="ghost" data-plan-cancel="1">清空</button><button class="primary" data-plan-save="1">存檔</button></div>
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
function planItem(p) {
  const st = planState(p), exec = planExec(p), wait = p.wait ?? RULES.wait;
  const left = st === 'waiting' ? tradingDaysBetween(today(), exec) : 0;
  const dots = st === 'waiting' ? `<span class="pl-dots" title="還要 ${left} 個交易日">${Array.from({ length: wait }, (_, i) => `<i class="${i < wait - left ? 'on' : ''}"></i>`).join('')}</span>` : '';
  const badge = { waiting: `<span class="pl-badge wait">還要 ${left} 天</span>`, ready: '<span class="pl-badge go">可以執行</span>',
                  closed: '<span class="pl-badge">已完成</span>', void: '<span class="pl-badge">已作廢</span>' }[st];
  const unit = isOptAct(actOf(p)) ? '口' : '股';
  const line = (k, t) => p[k] ? `<div class="pl-line"><span>${t}</span><div>${esc(p[k])}</div></div>` : '';
  const done = planTrades(p).length, next = planNextDate(p);
  const when = next ? `<div class="pl-when ${next === today() ? 'today' : ''}">📅 ${next === today() ? '今天要買' : next < today() ? '買進日已過' : '下次買進'} ${fmtDay(next)}${p.repeat ? `・${REPEAT[p.repeat]}` : ''}</div>` : '';
  return `<details class="pl-item ${st}">
    <summary>${badge}<span class="pl-title"><b>${esc(planLabel(p))} ${esc(p.sym)}</b>
      ${p.qty ? `<span class="pl-qty">${p.qty} ${unit}${p.price ? ` @ <span class="x-money">${p.price}</span>` : ''}${p.exp ? `・${p.exp.slice(5).replace('-', '/')} 到期` : ''}</span>` : ''}</span>
      ${['waiting', 'ready'].includes(st) ? when : ''}</span>
      ${dots}<span class="pl-date">${st === 'waiting' ? `${exec.slice(5).replace('-', '/')} 起` : p.created.slice(5).replace('-', '/') + ' 寫'}</span></summary>
    <div class="pl-body">
      ${p.thesis ? `<div class="pl-thesis">${esc(p.thesis)}</div>` : ''}
      ${line('entry', '條件')}${line('addCond', '加碼')}${line('exitCond', '出場')}${line('rollCond', 'Roll')}
      <div class="x-sub" style="margin-top:6px">${p.created} 寫・最早 ${exec} 可以下單${p.amount ? `・金額 <span class="x-money">${usd0(p.amount)}</span>（佔總資產 <span class="x-money">${pctPlain(p.pct, 1)}</span>）` : ''}${done ? `・照計畫成交了 ${done} 筆` : ''}</div>
      ${st === 'ready' ? '<div class="pl-tip">條件還成立就照計畫做；不成立就作廢，不要改計畫硬做。</div>' : ''}
      <div class="plan-actions">${['waiting', 'ready'].includes(st)
        ? `<button class="ghost" data-plan-edit="${p.id}">編輯</button><button class="ghost" data-plan-close="${p.id}">完成</button><button class="ghost" data-plan-void="${p.id}">作廢</button>`
        : `<button class="ghost danger" data-plan-del="${p.id}">刪除</button>`}</div>
    </div></details>`;
}
function renderPlans(c) {
  buildPlanComposer(c);
  const dl = el('planSyms'); if (dl) dl.innerHTML = heldSyms(c).map(s => `<option value="${esc(s)}">`).join('');
  if (el('planForm') && !el('planForm').contains(document.activeElement)) updatePlanCalc();
  const box = el('planList'); if (!box) return;
  const plans = (data.plans || []).filter(p => p.created).sort((a, b) => b.ts - a.ts);
  const ready = plans.filter(p => planState(p) === 'ready'), waiting = plans.filter(p => planState(p) === 'waiting');
  const old = plans.filter(p => ['closed', 'void'].includes(planState(p)));
  const group = (t, arr) => arr.length ? `<div class="pl-group"><div class="pl-group-h">${t}（${arr.length}）</div>${arr.map(planItem).join('')}</div>` : '';
  box.innerHTML = (ready.length || waiting.length ? group('可以執行', ready) + group('等待中', waiting) : '<div class="x-empty" style="padding:16px 0">還沒有進行中的計畫</div>')
    + (old.length ? `<details class="x-details pl-old"><summary>已完成、作廢的計畫（${old.length}）</summary>${old.map(planItem).join('')}</details>` : '')
    + `<div class="x-note">守則：① 不做選擇權買方 ② 新交易先寫計畫，寫完等 ${RULES.wait} 個交易日才下單；計畫裡寫好的條件不用再等；違反守則開的倉可以隨時平倉 ③ 單一個股最多 ${RULES.cap}%，超過 ${RULES.trim}% 減碼回 ${RULES.cap}%（sell put 以履約價 × 100 計算，大盤型 ETF 不受限）④ 禁止交易槓桿、反向 ETF（包含 SOXL 這類大盤型），已經持有的可以賣出、平倉。</div>`;
  el('plansNote').textContent = ready.length ? `${ready.length} 份可以執行` : waiting.length ? `${waiting.length} 份等待中` : '';
}

function renderPlanSummary() {
  const box = el('planSummary'); if (!box) return;
  const plans = (data.plans || []).filter(p => p.created && ['waiting', 'ready'].includes(planState(p)))
    .sort((a, b) => (planNextDate(a) || planExec(a)).localeCompare(planNextDate(b) || planExec(b)));
  box.innerHTML = plans.length ? plans.map(p => {
    const st = planState(p), left = st === 'waiting' ? tradingDaysBetween(today(), planExec(p)) : 0, next = planNextDate(p);
    return `<a class="ps-row" href="/plans"><span class="pl-badge ${st === 'ready' ? 'go' : 'wait'}">${st === 'ready' ? '可以執行' : `還要 ${left} 天`}</span>
      <span class="ps-name">${esc(planLabel(p))} <b>${esc(p.sym)}</b></span><span class="pl-date">${next ? `${next === today() ? '今天買' : '買進 ' + fmtDay(next)}${p.repeat ? `・${REPEAT[p.repeat]}` : ''}` : planExec(p).slice(5).replace('-', '/') + ' 起'}</span></a>`;
  }).join('') : '<div class="x-empty" style="padding:14px 0">目前沒有進行中的計畫</div>';
}

// ============ 選擇權部位風險 ============
function renderOptRisk(c) {
  const box = el('optRiskBox'); if (!box) return;
  if (!c.optRows.length) { box.innerHTML = '<div class="x-empty">目前沒有未平倉的選擇權</div>'; return; }
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
      duty = `被指派要付 <span class="x-money">${usd0(need)}</span><span class="x-sub">${need > c.cashUSD ? `現金不足 <span class="x-money">${usd0(need - Math.max(c.cashUSD, 0))}</span>，會用到融資` : '現金足夠'}</span>`;
    } else if (o.qty < 0 && oc.call) {
      const need = 100 * Math.abs(o.qty), have = data.holdings[oc.root]?.shares || 0;
      duty = `被指派要交 ${need} 股<span class="x-sub">${have >= need ? `已持有 ${have} 股（有掩護）` : `只持有 ${have} 股（無掩護，風險無上限）`}</span>`;
    }
    const warn = o.qty < 0 && state === '價內' ? 'danger' : dte <= 3 ? '' : 'good';
    return `<tr>
      <td class="l"><b>${esc(optName(o.sym))}</b><span class="x-sub">${o.qty > 0 ? '買方' : '賣方'} ${Math.abs(o.qty)} 口・IV ${iv ? pctPlain(iv) : '—'}</span></td>
      <td class="num">${dte <= 0 ? '今天' : dte + ' 天'}</td>
      <td class="num">${S ? usd(S) : '—'}<span class="x-sub">履約 ${usd(oc.strike)}</span></td>
      <td><span class="x-badge ${warn}">${state}</span><span class="x-sub">${money == null ? '' : `<span class="x-money">${pct(money)}</span>`}</span></td>
      <td class="num">${usd(be)}</td>
      <td class="num">${ex ? pctPlain(ex.pItm) : '—'}</td>
      <td class="num ${cls(theta)}">${theta == null ? '—' : usd(theta, { sign: true })}</td>
      <td class="num">${o.delta == null ? '—' : o.delta.toFixed(2)}</td>
      <td class="l" style="white-space:normal">${duty}</td></tr>`;
  }).join('');
  box.innerHTML = `<div class="table-wrap" style="margin:0"><table class="x-table"><thead><tr>
      <th class="l">合約</th><th>到期</th><th>標的價</th><th class="l">價內外</th><th>損益兩平</th><th>到期價內機率</th><th>每天時間價值</th><th>Delta</th><th class="l">被指派時</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="x-note">每天時間價值（theta）合計 <b class="num ${cls(thetaSum)}">${usd(thetaSum, { sign: true })}</b>：正的代表時間經過對你有利（賣方），負的代表每天在流失（買方）。
      價內機率、theta 用 Black-Scholes 估算，隱含波動率由 Yahoo 報價反推（延遲約 20 分鐘）。損益兩平以開倉權利金計算。</div>`;
}

// ============ 交易日記 ============
const MOODS = [['calm', '😌', '平靜'], ['sure', '🙂', '有把握'], ['meh', '😐', '普通'], ['anx', '😣', '焦慮'], ['rash', '😤', '衝動']];
let jMood = 'calm';
function renderJournal() {
  const box = el('journalBox'); if (!box) return;
  if (!el('jForm')) {
    box.innerHTML = `<div id="jForm">
      <div class="ck-row"><span class="seg" id="jMoods">${MOODS.map(([k, e, t]) => `<button data-mood="${k}">${e} ${t}</button>`).join('')}</span>
        <label class="ck-field">代號（選填） <input id="jSym" style="text-transform:uppercase;width:90px"></label></div>
      <textarea id="jText" rows="3" placeholder="現在在想什麼？為什麼買、為什麼賣、心情怎麼樣……寫下來就好。"></textarea>
      <div style="text-align:right;margin-top:6px"><button class="primary" id="jSave">記下來</button></div></div>
      <div id="jList"></div>`;
  }
  document.querySelectorAll('[data-mood]').forEach(b => b.classList.toggle('on', b.dataset.mood === jMood));
  const list = [...(data.journal || [])].sort((a, b) => b.ts - a.ts);
  const moodOf = k => MOODS.find(m => m[0] === k) || MOODS[2];
  const counts = MOODS.map(([k, e, t]) => [e, t, list.filter(x => x.mood === k).length]).filter(x => x[2]);
  el('jList').innerHTML = list.length
    ? `<div class="x-note" style="margin:10px 0 6px">${counts.map(([e, t, n]) => `${e} ${t} ${n} 次`).join('・')}</div>` + list.slice(0, 50).map(j => `<div class="j-item">
        <div class="j-head"><span>${moodOf(j.mood)[1]} <b>${j.date}</b>${j.sym ? ` <span class="x-chip">${esc(j.sym)}</span>` : ''}</span>
          <button class="ghost" data-jdel="${j.id}" title="刪除這篇">✕</button></div>
        <div class="j-text">${esc(j.text).replace(/\n/g, '<br>')}</div></div>`).join('')
    : '<div class="x-empty">還沒有日記。下單前後花 30 秒寫一句，之後回頭看會很有收穫。</div>';
}

// ============ 交易分析 ============
let anaView = store.get('anaView', 'symbol');
let anaShowAll = false;
function stockHoldingEvents(st) {
  // 先進先出配對買進日期，算每筆賣出持有幾天（損益沿用平均成本法的數字）
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
  return out;
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
    const rows = Object.entries(map).map(([g, m]) => {
      const s = winStats(m.stock), o = winStats(m.opt);
      return { g, s, o, total: s.total + o.total };
    }).sort((a, b) => b.total - a.total);
    // 預設只列影響最大的 12 檔（依損益絕對值挑，再照損益排序）
    const keep = anaShowAll ? rows : rows.filter(r => [...rows].sort((a, b) => Math.abs(b.total) - Math.abs(a.total)).slice(0, 12).includes(r));
    const cellW = w => w.n ? `${w.n} 筆<span class="x-sub">勝率 ${pctPlain(w.rate)}</span>` : '<span class="muted">—</span>';
    box.innerHTML = `<div class="table-wrap" style="margin:0"><table class="x-table"><thead><tr><th class="l">標的</th><th>股票</th><th>股票損益</th><th>選擇權</th><th>選擇權損益</th><th>合計</th></tr></thead>
      <tbody>${keep.map(r => `<tr><td class="l"><b>${esc(grpName(r.g))}</b></td><td class="num">${cellW(r.s)}</td><td class="num ${cls(r.s.total)}">${r.s.n ? usd0(r.s.total, { sign: true }) : '—'}</td>
        <td class="num">${cellW(r.o)}</td><td class="num ${cls(r.o.total)}">${r.o.n ? usd0(r.o.total, { sign: true }) : '—'}</td><td class="num ${cls(r.total)}"><b>${usd0(r.total, { sign: true })}</b></td></tr>`).join('')}</tbody></table></div>
      ${rows.length > 12 ? `<div style="text-align:center;margin-top:6px"><button class="ghost" data-anaall="1">${anaShowAll ? '只顯示影響最大的 12 檔' : `顯示全部 ${rows.length} 檔`}</button></div>` : ''}
      <div class="x-note">槓桿 ETF 與選擇權都併到標的本身計算（例如 GGLL、GOOGL 選擇權都算 Alphabet）。依合計損益排序；預設只列損益影響最大的 12 檔。</div>`;
  } else if (anaView === 'hold') {
    const ev = stockHoldingEvents(st);
    box.innerHTML = `<div class="ana-cols">${bucketTable('股票：依持有天數（先進先出）', [
      ['當天沖銷', d => d < 0.5], ['1–3 天', d => d >= 0.5 && d < 3.5], ['4–10 天', d => d >= 3.5 && d < 10.5],
      ['11–30 天', d => d >= 10.5 && d < 30.5], ['31–90 天', d => d >= 30.5 && d < 90.5], ['90 天以上', d => d >= 90.5]], ev, e => e.hold)}
      ${bucketTable('選擇權：依持有天數', [['當天', d => d < 0.5], ['1–3 天', d => d >= 0.5 && d < 3.5], ['4–10 天', d => d >= 3.5 && d < 10.5], ['11 天以上', d => d >= 10.5]], optionLifeEvents(st), e => e.hold)}</div>
      <div class="x-note">持有天數用先進先出配對買進日期（同一筆賣出對到多批買進時取加權平均）；每筆的損益仍用平均成本法，跟上方已實現損益一致。紀錄開始前就持有的股票，從紀錄開始那天起算。</div>`;
  } else if (anaView === 'dte') {
    const ev = optionLifeEvents(st);
    const B = [['0–2 天', d => d <= 2], ['3–7 天', d => d >= 3 && d <= 7], ['8–30 天', d => d >= 8 && d <= 30], ['31–90 天', d => d >= 31 && d <= 90], ['90 天以上', d => d > 90]];
    box.innerHTML = `<div class="ana-cols">${bucketTable('買方：開倉時距離到期天數', B, ev.filter(e => e.side === 'long'), e => e.dte)}
      ${bucketTable('賣方：開倉時距離到期天數', B, ev.filter(e => e.side === 'short'), e => e.dte)}</div>
      <div class="x-note">看你擅長哪種天期：例如短天期賣方（0–7 天）是不是真的穩定賺時間價值。同一合約分批開倉時，開倉日取加權平均。</div>`;
  } else {
    const ev = [...st.stockEvents.map(e => ({ ...e, k: 'stock' })), ...st.optEvents.map(e => ({ ...e, k: 'opt' }))];
    const edges = [-Infinity, -500, -200, -100, -50, 0, 50, 100, 200, 500, Infinity];
    const label = i => edges[i] === -Infinity ? `< −$${-edges[i + 1]}` : edges[i + 1] === Infinity ? `> $${edges[i]}` : `${edges[i] < 0 ? '−$' + -edges[i] : '$' + edges[i]} ～ ${edges[i + 1] <= 0 ? (edges[i + 1] ? '−$' + -edges[i + 1] : '$0') : '$' + edges[i + 1]}`;
    const bins = edges.slice(0, -1).map((_, i) => ({ label: label(i), s: 0, o: 0, neg: edges[i + 1] <= 0 }));
    for (const e of ev) { const i = edges.findIndex((x, j) => e.r >= x && e.r < edges[j + 1]); if (i >= 0) bins[i][e.k === 'stock' ? 's' : 'o']++; }
    const max = Math.max(...bins.map(b => b.s + b.o), 1);
    const all = winStats(ev), sk = streaks(ev);
    box.innerHTML = `<div class="x-grid" style="margin-bottom:12px">
        <div class="x-tile"><div class="k">每筆平均損益（期望值）</div><div class="v num ${cls(all.total)}">${usd(all.n ? all.total / all.n : 0, { sign: true })}</div><div class="s">${all.n} 筆（股票＋選擇權）</div></div>
        <div class="x-tile"><div class="k">最長連勝</div><div class="v num">${sk.bestW} 筆</div></div>
        <div class="x-tile"><div class="k">最長連敗</div><div class="v num">${sk.bestL} 筆</div></div>
        <div class="x-tile"><div class="k">目前</div><div class="v num">${sk.curType ? `${sk.cur} 連${sk.curType === 'w' ? '勝' : '敗'}` : '—'}</div></div>
        <div class="x-tile"><div class="k">最大單筆</div><div class="v num up">${all.best ? usd0(all.best.r, { sign: true }) : '—'}</div><div class="s">${all.best ? esc(all.best.sym) + ' ' + all.best.date : ''}</div></div>
        <div class="x-tile"><div class="k">最大單筆虧損</div><div class="v num down">${all.worst ? usd0(all.worst.r, { sign: true }) : '—'}</div><div class="s">${all.worst ? esc(all.worst.sym) + ' ' + all.worst.date : ''}</div></div>
      </div>
      ${bins.map(b => `<div class="hbar-row"><div class="hbar-name" style="font-weight:400">${b.label}</div>
        <div class="hbar-track"><i class="${b.neg ? 'neg' : 'pos'}" style="left:0;width:${(b.s + b.o) / max * 100}%"></i></div>
        <div class="hbar-val num">${b.s + b.o} 筆<span class="x-sub">股票 ${b.s}・選擇權 ${b.o}</span></div></div>`).join('')}
      <div class="x-note">每一筆已實現交易落在哪個損益區間。左邊（虧損）的長條如果比右邊（獲利）的長很多，代表常常小賺大賠。</div>`;
  }
}

// ============ 每月已實現損益 ============
function renderMonthly() {
  const box = el('monthlyBox'); if (!box || box.clientWidth === 0) return;
  const st = realizedStats(), m = {};
  const add = (d, k, v) => { const o = m[d.slice(0, 7)] ??= { s: 0, o: 0, d: 0 }; o[k] += v; };
  for (const e of st.stockEvents) add(e.date, 's', e.r);
  for (const e of st.optEvents) add(e.date, 'o', e.r);
  for (const t of data.transactions) if (t.type === 'income' && t.currency === 'USD' && /^(股息|退稅)/.test(t.category || '')) add(t.date, 'd', t.amount);
  const months = Object.keys(m).sort();
  if (!months.length) { box.innerHTML = '<div class="x-empty">還沒有已實現損益</div>'; return; }
  const K = [['s', '股票', 'var(--s1)'], ['o', '選擇權', 'var(--s2)'], ['d', '股息', 'var(--s3)']];
  const W = box.clientWidth, H = box.clientHeight, padL = 52, padR = 8, padT = 10, padB = 22;
  let top = 0, bot = 0;
  for (const k of months) { const o = m[k]; top = Math.max(top, K.reduce((s, [c]) => s + Math.max(o[c], 0), 0)); bot = Math.min(bot, K.reduce((s, [c]) => s + Math.min(o[c], 0), 0)); }
  const span = (top - bot) || 1; top += span * 0.06; bot -= span * 0.06;
  const y = v => padT + (top - v) / (top - bot) * (H - padT - padB);
  const bw = (W - padL - padR) / months.length, barW = Math.max(4, Math.min(36, bw * 0.6));
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
    bars += `<text class="axis-text" x="${cx}" y="${H - 6}" text-anchor="middle">${+k.slice(5)}月</text>`;
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
  });
  const sum = c => months.reduce((s, k) => s + m[k][c], 0);
  el('monthlyLegend').innerHTML = K.map(([c, n, col]) => `<span class="legend-item"><span class="swatch" style="border-color:${col};border-top-width:8px;width:10px"></span>${n} <b class="num">${usd0(sum(c), { sign: true })}</b></span>`).join('');
}

// ============ 交易成本 ============
function renderFees() {
  const box = el('feeBox'); if (!box) return;
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
  const months = Object.keys(m).sort();
  if (!months.length) { box.innerHTML = '<div class="x-empty">沒有交易</div>'; return; }
  const tot = k => months.reduce((s, x) => s + m[x][k], 0);
  const st = realizedStats(), realized = st.stock + st.option;
  const all = tot('stock') + tot('opt') + tot('int');
  box.innerHTML = `<div class="x-grid" style="margin-bottom:12px">
      <div class="x-tile"><div class="k">總交易成本</div><div class="v num">${usd(all)}</div><div class="s">佔已實現損益 <span class="x-money">${realized > 0 ? pctPlain(all / realized, 1) : '—'}</span></div></div>
      <div class="x-tile"><div class="k">股票規費</div><div class="v num">${usd(tot('stock'))}</div><div class="s">${tot('n')} 筆，平均每筆 <span class="x-money">${usd(tot('n') ? tot('stock') / tot('n') : 0)}</span></div></div>
      <div class="x-tile"><div class="k">選擇權手續費</div><div class="v num">${usd(tot('opt'))}</div><div class="s">${tot('c')} 口，平均每口 <span class="x-money">${usd(tot('c') ? tot('opt') / tot('c') : 0)}</span></div></div>
      <div class="x-tile"><div class="k">融資利息</div><div class="v num">${usd(tot('int'))}</div><div class="s">${tot('int') ? '' : '紀錄中沒有'}</div></div>
    </div>
    <div class="table-wrap" style="margin:0"><table class="x-table"><thead><tr><th class="l">月份</th><th>股票（筆）</th><th>股票規費</th><th>選擇權（口）</th><th>選擇權手續費</th><th>合計</th></tr></thead>
      <tbody>${months.slice().reverse().map(k => { const o = m[k]; return `<tr><td class="l">${k}</td><td class="num">${o.n}</td><td class="num">${usd(o.stock)}</td><td class="num">${o.c}</td><td class="num">${usd(o.opt)}</td><td class="num"><b>${usd(o.stock + o.opt + o.int)}</b></td></tr>`; }).join('')}</tbody></table></div>
    <div class="x-note">成本＝成交金額與實際收付金額的差（券商手續費、SEC／FINRA 規費等），由券商紀錄推算。買賣價差、匯差不在其中。</div>`;
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
  ];
  for (const [name, fn] of parts) {
    const b = el(name); if (!b) continue;
    try { fn(); } catch (err) { console.error(name, err); b.innerHTML = `<div class="x-empty">這個區塊出錯了：${esc(err.message)}</div>`; }
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
  else if (b.dataset.ana) { anaView = b.dataset.ana; store.set('anaView', anaView); renderAnalysis(); }
  else if (b.dataset.anaall) { anaShowAll = !anaShowAll; renderAnalysis(); }
  else if (b.dataset.dismiss != null) {
    const key = 'dismiss.' + today(), set = new Set((store.get(key, '') || '').split('|').filter(Boolean));
    set.add(b.dataset.dismiss); store.set(key, [...set].join('|')); window.renderExtras();
  }
});
document.addEventListener('input', e => { if (e.target.closest('#planForm')) updatePlanCalc(); });
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'etfLookup') lookupEtf(); });
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'outsideFlowChk') { store.set('outsideAsFlow', t.checked ? '1' : '0'); window.renderExtras(); }
});
window.addEventListener('resize', () => { clearTimeout(window._rzx); window._rzx = setTimeout(() => window.renderExtras(), 200); });
})();
