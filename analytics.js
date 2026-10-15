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

// ============ 分頁 ============
const TABS = ['overview', 'perf', 'risk', 'trade'];
let curTab = (location.hash || '').slice(1);
if (!TABS.includes(curTab)) curTab = store.get('tab', 'overview');
if (!TABS.includes(curTab)) curTab = 'overview';
function applyTab() {
  document.querySelectorAll('section[data-panel]').forEach(s => { s.hidden = s.dataset.panel !== curTab; });
  document.querySelectorAll('#tabNav button').forEach(b => b.classList.toggle('on', b.dataset.tab === curTab));
}
function showTab(t) {
  if (!TABS.includes(t)) return;
  curTab = t; store.set('tab', t); applyTab();
  if (data) render();   // 圖表在隱藏時量不到寬度，切過來要重畫
}
applyTab();

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
function computeAlerts(c, expo) {
  const a = alertCfg(), out = [];
  if (!a.on || !c) return out;
  if (c.leverage != null && c.leverage > a.lev) out.push({ lvl: 'danger', tag: '槓桿', msg: `槓桿率 <b>${c.leverage.toFixed(2)}x</b>，超過你設定的上限 ${a.lev}x` });
  for (const g of expo.groups) {
    const share = g.total / c.totalUSD;
    if (share * 100 > a.single) out.push({ lvl: 'warn', tag: '集中', msg: `${esc(grpName(g.g))} 曝險 <b>${pctPlain(share)}</b> 淨資產，超過上限 ${a.single}%` });
  }
  const peak = Math.max(...data.history.map(h => h.usd));
  if (peak > 0 && c.totalUSD < peak) {
    // 回撤以時間加權指數計算，避免出金被當成下跌
    const rets = dailyReturns(data.history); let idx = 1, top = 1;
    for (const r of rets) { idx *= 1 + r.r; top = Math.max(top, idx); }
    const dd = idx / top - 1;
    if (-dd * 100 > a.dd) out.push({ lvl: 'danger', tag: '回撤', msg: `目前距離高點 <b>${pct(dd)}</b>，超過你設定的 ${a.dd}%` });
  }
  // 部位計畫：到停損、到目標、到檢討日
  for (const pos of positionsForPlans(c)) {
    const p = planOf(pos.sym); if (!p) continue;
    const st = planStatus(p, pos), name = esc(pos.label), hide = isCalm();
    if (st.out.includes('stop')) out.push({ lvl: 'danger', tag: '計畫', msg: `${name} 已經到了你設定的停損${hide ? '' : `（<b>${usd(p.stop)}</b>）`}。照計畫執行，不用重新說服自己。` });
    if (st.out.includes('target')) out.push({ lvl: 'calm', tag: '計畫', msg: `${name} 到了你設定的目標${hide ? '' : `（<b>${usd(p.target)}</b>）`}，照計畫考慮獲利了結。` });
    if (st.out.includes('review')) out.push({ lvl: 'calm', tag: '計畫', msg: `${name} 到了你設定的檢討日：你當初的理由還成立嗎？` });
  }
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
  // 瀏覽器通知：同一則一天只通知一次
  if (alertCfg().notify && 'Notification' in window && Notification.permission === 'granted') {
    const nkey = 'notified.' + today(), sent = new Set((store.get(nkey, '') || '').split('|').filter(Boolean));
    for (const a of show) {
      const plain = a.msg.replace(/<[^>]+>/g, '');
      if (sent.has(plain)) continue;
      try { new Notification('資產警示：' + a.tag, { body: plain }); } catch { /* 有些瀏覽器不允許，就算了 */ }
      sent.add(plain);
    }
    store.set(nkey, [...sent].join('|'));
  }
}
function renderAlertSettings() {
  const box = el('alertSettings'); if (!box) return;
  if (box.contains(document.activeElement)) return;   // 正在輸入時不要重畫
  const a = alertCfg();
  box.innerHTML = `<div class="alert-form">
    <label>啟用警示 <input type="checkbox" data-alert="on" ${a.on ? 'checked' : ''}></label>
    <label>槓桿率超過 <span><input type="number" step="0.1" min="0" data-alert="lev" value="${a.lev}"> x</span></label>
    <label>單一標的曝險超過淨資產 <span><input type="number" step="10" min="0" data-alert="single" value="${a.single}"> %</span></label>
    <label>距離高點回撤超過 <span><input type="number" step="1" min="0" data-alert="dd" value="${a.dd}"> %</span></label>
    <label>選擇權距到期少於 <span><input type="number" step="1" min="0" data-alert="dte" value="${a.dte}"> 天</span></label>
    <label>單一選擇權部位超過淨資產 <span><input type="number" step="1" min="0" data-alert="optMax" value="${a.optMax}"> %</span></label>
    <label>冷靜期提醒 <input type="checkbox" data-alert="cool" ${a.cool ? 'checked' : ''}></label>
    <label>單日帳戶跌幅超過 <span><input type="number" step="0.5" min="0" data-alert="coolPct" value="${a.coolPct}"> % 時提醒冷靜</span></label>
    <label>瀏覽器通知（網頁開著時） <input type="checkbox" data-alert="notify" ${a.notify ? 'checked' : ''}></label>
  </div>
  <div class="x-note">冷靜期提醒：單日跌幅超過設定值，或買進的選擇權虧損超過 25% 時，建議當天先不要開新部位。賣出的選擇權變成價內時一定會提醒。警示只在網頁開著時檢查；按橫幅右邊的 ✕ 可以今天先不顯示。</div>`;
}

// ============ 今日損益貢獻 ============
function renderContrib(c) {
  const box = el('contribBox'); if (!box) return;
  const items = [];
  for (const r of c.rows) {
    const q = quotes[r.sym];
    if (q?.price != null && q.prevClose) items.push({ name: r.sym, sub: SESSION_TAG[q.session] || '', v: r.shares * (q.price - q.prevClose), p: q.price / q.prevClose - 1 });
  }
  for (const o of c.optRows) {
    const q = optQuotes[o.sym];
    if (q?.price != null && q.prevClose) items.push({ name: optName(o.sym), sub: o.qty < 0 ? '賣方' : '', v: o.qty * 100 * (q.price - q.prevClose), p: (q.price / q.prevClose - 1) * Math.sign(o.qty) });
  }
  if (!items.length) { box.innerHTML = '<div class="x-empty">還沒有今天的報價</div>'; el('contribNote').textContent = ''; return; }
  items.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const total = items.reduce((s, i) => s + i.v, 0), max = Math.max(...items.map(i => Math.abs(i.v)), 1);
  el('contribNote').innerHTML = `合計 <b class="num ${cls(total)}">${usd(total, { sign: true })}</b>`;
  box.innerHTML = items.map(i => {
    const w = Math.abs(i.v) / max * 50;
    return `<div class="hbar-row"><div class="hbar-name">${esc(i.name)} ${i.sub ? `<span class="sess">${i.sub}</span>` : ''}</div>
      <div class="hbar-track"><span class="ref" style="left:50%"></span><i class="${i.v >= 0 ? 'pos' : 'neg'}" style="${i.v >= 0 ? 'left:50%' : `left:${50 - w}%`};width:${w}%"></i></div>
      <div class="hbar-val num ${cls(i.v)}">${usd(i.v, { sign: true })} <span class="x-sub">${pct(i.p, 2)}</span></div></div>`;
  }).join('');
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

// ============ 依標的彙總曝險 ============
function exposureGroups(c) {
  const groups = {};
  const add = (g, label, val, counted) => {
    const G = groups[g] ??= { g, total: 0, items: [] };
    if (counted) G.total += val;
    G.items.push({ label, val, counted });
  };
  for (const r of c.rows) if (r.value != null) add(grp(r.sym), `${r.sym}${r.lev !== 1 ? ` ×${r.lev}` : ''}`, r.value * r.lev, true);
  for (const o of c.optRows) {
    const oc = occ(o.sym), S = quotes[oc.root]?.price;
    if (o.delta == null || !S) continue;
    add(grp(oc.root), `${optName(o.sym)}（Δ${o.delta.toFixed(2)}${o.qty < 0 ? '，賣方不計入' : ''}）`, o.qty * 100 * o.delta * S * levOf(oc.root), o.qty > 0);
  }
  const list = Object.values(groups).filter(g => g.items.length).sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  return { groups: list.filter(g => Math.abs(g.total) > 0.5), all: list };
}
function renderExposure(c, expo) {
  const box = el('exposureBox'); if (!box) return;
  if (!expo.all.length) { box.innerHTML = '<div class="x-empty">目前沒有持股</div>'; return; }
  const eq = c.totalUSD, max = Math.max(eq, ...expo.all.map(g => Math.abs(g.total)), 1);
  const top = expo.groups[0];
  el('exposureNote').innerHTML = top ? `最大：${esc(grpName(top.g))} <span class="x-money">${pctPlain(top.total / eq)}</span> 淨資產` : '';
  box.innerHTML = expo.all.map(g => {
    const w = Math.abs(g.total) / max * 100, share = g.total / eq;
    return `<div class="hbar-row"><div class="hbar-name">${esc(grpName(g.g))}</div>
      <div class="hbar-track"><i class="${g.total >= 0 ? '' : 'neg'}" style="left:0;width:${w}%"></i><span class="ref" style="left:${eq / max * 100}%" title="淨資產"></span></div>
      <div class="hbar-val num">${usd0(g.total)} <span class="x-sub">${pctPlain(share)} 淨資產</span></div>
      <div class="hbar-items">${g.items.map(i => `<span class="x-chip ${i.counted ? '' : 'off'}">${esc(i.label)} ${usd0(i.val)}</span>`).join('')}</div></div>`;
  }).join('') + `<div class="x-note">曝險＝市值 × 槓桿倍數（買方選擇權用 delta 換算）。直線標記代表你的淨資產 <span class="x-money">${usd0(eq)}</span>，超過這條線代表在這個標的上已經用了槓桿。賣方選擇權列出來參考，不計入。</div>`;
}

// ============ 壓力測試 ============
let stressMove = Number(store.get('stressMove', '-20'));
const stressGroup = {};   // 個別標的的變動（沒設定就跟著整體）
function scenario(c, moveOf) {
  const r = curRate();
  let equity = c.cashUSD, exposure = 0, req = 0;
  const rows = [];
  for (const p of c.rows) {
    if (p.price == null) continue;
    const L = p.lev, m = moveOf(grp(p.sym)), f = Math.max(0, 1 + L * m);
    const value = p.shares * p.price * f;
    equity += value; exposure += value * L;
    req += value * Math.min(1, 0.25 * Math.max(1, Math.abs(L)));   // 一般維持率 25%；槓桿 ETF 依倍數提高
    rows.push({ name: p.sym, now: p.value, after: value });
  }
  for (const o of c.optRows) {
    const oc = occ(o.sym), S0 = quotes[oc.root]?.price, L = levOf(oc.root), m = moveOf(grp(oc.root));
    const T = yearsTo(oc.exp);
    if (!S0 || o.mark == null) { equity += o.value; rows.push({ name: optName(o.sym), now: o.value, after: o.value }); continue; }
    const iv = impliedVol(oc, o.mark, S0, T, r) || 0.5, S1 = S0 * Math.max(0, 1 + L * m);
    const bs = S1 > 0 ? bsModel(S1, oc.strike, T, r, iv, oc.call) : { price: oc.call ? 0 : oc.strike, delta: oc.call ? 0 : -1 };
    const value = o.qty * 100 * bs.price;
    equity += value;
    if (o.qty > 0) exposure += o.qty * 100 * bs.delta * S1 * L;
    // 賣方保證金（粗估）：標的 20% − 價外金額，至少履約價 10%，再加上權利金
    if (o.qty < 0) { const otm = Math.max(0, oc.call ? oc.strike - S1 : S1 - oc.strike); req += Math.abs(o.qty) * 100 * (Math.max(0.2 * S1 - otm, 0.1 * oc.strike) + bs.price); }
    rows.push({ name: optName(o.sym), now: o.value, after: value });
  }
  return { equity, exposure, leverage: equity > 0 ? exposure / equity : null, req, rows };
}
function solveMove(c, ok) {
  // 所有標的同時下跌，找出 ok(情境) 開始不成立的跌幅；跌 99% 都還成立就回傳 null
  let lo = -0.99, hi = 0;
  if (ok(scenario(c, () => lo))) return null;
  if (!ok(scenario(c, () => hi))) return 0;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (ok(scenario(c, () => mid))) hi = mid; else lo = mid; }
  return hi;
}
function renderStress(c) {
  const box = el('stressBox'); if (!box) return;
  if (!c.rows.length && !c.optRows.length) { box.innerHTML = '<div class="x-empty">目前沒有持股</div>'; return; }
  const groups = [...new Set([...c.rows.map(r => grp(r.sym)), ...c.optRows.map(o => grp(occ(o.sym).root))])];
  if (!el('stressCtl') || el('stressCtl').dataset.groups !== groups.join(',')) {
    const presets = [-40, -30, -20, -10, -5, 5, 10, 20];
    box.innerHTML = `<div id="stressCtl" data-groups="${groups.join(',')}">
      <div class="stress-controls"><span>所有標的同時</span><span class="stress-move num" id="stressMoveLbl"></span>
        <input type="range" min="-60" max="60" step="1" id="stressRange" value="${stressMove}">
        <div class="stress-presets">${presets.map(p => `<button data-stress="${p}">${p > 0 ? '+' : ''}${p}%</button>`).join('')}</div></div>
      ${groups.length > 1 ? `<details class="x-details"><summary>分別設定每個標的</summary><div class="stress-groups">${groups.map(g => `<label>${esc(grpName(g))}
        <input type="range" min="-60" max="60" step="1" data-sgroup="${g}" value="${stressGroup[g] ?? stressMove}"><b class="num" data-sglbl="${g}"></b></label>`).join('')}</div></details>` : ''}
    </div><div id="stressOut"></div>`;
  }
  el('stressMoveLbl').textContent = (stressMove > 0 ? '+' : '') + stressMove + '%';
  el('stressRange').value = stressMove;
  document.querySelectorAll('[data-stress]').forEach(b => b.classList.toggle('on', +b.dataset.stress === stressMove));
  document.querySelectorAll('[data-sglbl]').forEach(b => { const v = stressGroup[b.dataset.sglbl] ?? stressMove; b.textContent = (v > 0 ? '+' : '') + v + '%'; });
  document.querySelectorAll('[data-sgroup]').forEach(i => { if (document.activeElement !== i) i.value = stressGroup[i.dataset.sgroup] ?? stressMove; });

  const moveOf = g => (stressGroup[g] ?? stressMove) / 100;
  const base = scenario(c, () => 0), sc = scenario(c, moveOf);
  const dEq = sc.equity - base.equity;
  const half = solveMove(c, s => s.equity > base.equity / 2), zero = solveMove(c, s => s.equity > 0);
  const call = solveMove(c, s => s.equity > s.req);
  const curve = [];
  for (let m = -50; m <= 50; m += 2) curve.push({ x: m, y: scenario(c, () => m / 100).equity, label: (m > 0 ? '+' : '') + m + '%' });
  const sameAll = !Object.keys(stressGroup).length;
  el('stressOut').innerHTML = `<div class="x-grid">
      <div class="x-tile"><div class="k">淨資產</div><div class="v num">${usd0(sc.equity)}</div><div class="s num ${cls(dEq)}">${usd0(dEq, { sign: true })}（${pct(dEq / base.equity)}）</div></div>
      <div class="x-tile"><div class="k">槓桿率</div><div class="v num">${sc.leverage == null ? '—' : sc.leverage.toFixed(2) + 'x'}</div><div class="s">現在 <span class="x-money">${base.leverage?.toFixed(2)}x</span></div></div>
      <div class="x-tile"><div class="k">淨資產腰斬</div><div class="v num down">${half == null ? '不會' : pct(half, 0)}</div><div class="s">所有標的同時跌這麼多時</div></div>
      <div class="x-tile"><div class="k">估計追繳點</div><div class="v num down">${call == null ? '不會' : call === 0 ? '已低於維持率' : pct(call, 0)}</div><div class="s">依一般券商維持率粗估（股票 25%、槓桿 ETF 依倍數提高），實際以券商為準</div></div>
      <div class="x-tile"><div class="k">淨資產歸零</div><div class="v num down">${zero == null ? '不會' : pct(zero, 0)}</div><div class="s">所有標的同時跌這麼多時</div></div>
    </div>
    <div class="chart-box" id="stressCurve" style="height:180px;margin-top:12px"></div>
    <div class="table-wrap" style="margin:8px 0 0"><table class="x-table"><thead><tr><th class="l">部位</th><th>現在</th><th>情境後</th><th>變化</th></tr></thead>
      <tbody>${sc.rows.map(r => `<tr><td class="l">${esc(r.name)}</td><td class="num">${usd0(r.now)}</td><td class="num">${usd0(r.after)}</td><td class="num ${cls(r.after - r.now)}">${usd0(r.after - r.now, { sign: true })}</td></tr>`).join('')}
        <tr><td class="l">現金</td><td class="num">${usd0(c.cashUSD)}</td><td class="num">${usd0(c.cashUSD)}</td><td class="num">—</td></tr></tbody></table></div>
    <div class="x-note">曲線是「所有標的同時漲跌多少 %」對應的淨資產，選擇權用 Black-Scholes 重新計價（隱含波動率維持現在的水準），所以會看到非線性的彎曲。
      槓桿 ETF 用「標的變動 × 倍數」估算，是單日的近似；連續多天的走勢會因為每日重新平衡而有差距。${sameAll ? '' : '目前有個別標的的設定，表格與上方數字以個別設定計算，曲線仍是所有標的同時變動。'}</div>`;
  lineChart(el('stressCurve'), curve.map(p => ({ ...p, x: p.x })), {
    fmtY: v => usd0(v), fmtTip: p => `標的 ${p.label}<br>淨資產 <b>${usd0(p.y)}</b>（${pct(p.y / base.equity - 1)}）`,
    ref: base.equity, area: false, mark: sameAll ? { x: stressMove, y: sc.equity } : null,
  });
}

// ============ 下單前檢查：部位計算機＋檢查清單 ============
const CHECK_ITEMS = [
  '我寫得出這筆的買進理由，不是因為想快點把虧損賺回來',
  '我已經決定好停損點，跌到那裡會照著做',
  '這筆最多虧損在我設定的比例以內',
  '我現在情緒平穩，今天沒有剛虧完錢',
  '買進後的槓桿率還在我設定的上限以內',
];
const ck = { type: store.get('ck.type', 'stock'), sym: '', entry: '', stop: '', prem: '', delta: '',
             risk: Number(store.get('ck.risk', '1')), optPct: Number(store.get('ck.optPct', '3')), checks: new Set() };
function renderCheck(c) {
  const box = el('checkBox'); if (!box) return;
  if (!el('ckForm')) {
    box.innerHTML = `<div id="ckForm">
      <div class="ck-row"><span class="seg" id="ckType"><button data-ck-type="stock">股票／ETF</button><button data-ck-type="option">買選擇權</button></span>
        <label class="ck-field">代號 <input data-ck="sym" placeholder="例如 GGLL" style="text-transform:uppercase"></label></div>
      <div class="ck-row" data-ck-for="stock">
        <label class="ck-field">進場價 <input type="number" step="any" data-ck="entry"></label>
        <label class="ck-field">停損價 <input type="number" step="any" data-ck="stop"></label>
        <label class="ck-field">這筆最多虧淨資產 <input type="number" step="0.5" min="0" data-ck="risk"> %</label></div>
      <div class="ck-row" data-ck-for="option">
        <label class="ck-field">每股權利金 <input type="number" step="any" data-ck="prem"></label>
        <label class="ck-field">Delta（選填） <input type="number" step="0.01" data-ck="delta"></label>
        <label class="ck-field">最多投入淨資產 <input type="number" step="0.5" min="0" data-ck="optPct"> %</label></div>
      <div id="ckOut"></div>
      <div class="ck-list" id="ckList"></div>
      <div id="ckVerdict"></div></div>`;
    box.querySelector('[data-ck="risk"]').value = ck.risk;
    box.querySelector('[data-ck="optPct"]').value = ck.optPct;
  }
  document.querySelectorAll('[data-ck-type]').forEach(b => b.classList.toggle('on', b.dataset.ckType === ck.type));
  document.querySelectorAll('[data-ck-for]').forEach(r => { r.hidden = r.dataset.ckFor !== ck.type; });
  const eq = c.totalUSD, sym = ck.sym.toUpperCase(), lev = sym ? levOf(sym) : 1, n = v => parseFloat(v);
  let out = '<div class="x-note">填入價格後會算出最多能買多少。</div>';
  if (ck.type === 'stock' && n(ck.entry) > 0 && n(ck.stop) > 0) {
    const entry = n(ck.entry), stop = n(ck.stop), per = entry - stop;
    if (per <= 0) out = '<div class="x-note">停損價要低於進場價。</div>';
    else {
      const maxLoss = eq * ck.risk / 100, qty = Math.floor(maxLoss / per), cost = qty * entry;
      const newLev = (c.exposure + cost * lev) / eq;
      out = `<div class="x-grid">
        <div class="x-tile"><div class="k">最多買</div><div class="v num">${qty} 股</div><div class="s">停損時虧 ${usd0(qty * per)}（淨資產 ${pctPlain(qty * per / eq, 1)}）</div></div>
        <div class="x-tile"><div class="k">需要資金</div><div class="v num">${usd0(cost)}</div><div class="s">佔淨資產 ${pctPlain(cost / eq)}${cost > Math.max(c.cashUSD, 0) ? '，會用到融資' : ''}</div></div>
        <div class="x-tile"><div class="k">買進後槓桿率</div><div class="v num ${newLev > alertCfg().lev ? 'up' : ''}">${newLev.toFixed(2)}x</div><div class="s">現在 <span class="x-money">${c.leverage?.toFixed(2)}x</span>${lev !== 1 ? `・${sym} 以 ${lev} 倍計算` : ''}</div></div></div>`;
    }
  } else if (ck.type === 'option' && n(ck.prem) > 0) {
    const prem = n(ck.prem) * 100, budget = eq * ck.optPct / 100, qty = Math.floor(budget / prem), cost = qty * prem;
    const S = sym ? quotes[sym]?.price : null, d = n(ck.delta);
    const addExp = S && d ? qty * 100 * d * S * lev : null;
    out = `<div class="x-grid">
      <div class="x-tile"><div class="k">最多買</div><div class="v num">${qty} 口</div><div class="s">每口 ${usd0(prem)}；預算 ${usd0(budget)}</div></div>
      <div class="x-tile"><div class="k">最多虧損</div><div class="v num">${usd0(cost)}</div><div class="s">全部歸零時，佔淨資產 ${pctPlain(cost / eq, 1)}</div></div>
      <div class="x-tile"><div class="k">買進後槓桿率</div><div class="v num">${addExp == null ? '—' : ((c.exposure + addExp) / eq).toFixed(2) + 'x'}</div><div class="s">${addExp == null ? '填代號和 delta 就會計算' : `增加曝險 ${usd0(addExp)}`}</div></div></div>
      ${qty === 0 ? '<div class="x-note">預算連一口都買不起：這筆對你的資產規模來說太大了。</div>' : ''}`;
  }
  el('ckOut').innerHTML = out;
  // 檢查清單：固定的 5 項＋你自己啟用中的規則
  const items = CHECK_ITEMS.map((t, i) => ['b' + i, t]).concat(activeRules().map(r => ['r' + r.id, '規則：' + ruleText(r)]));
  const key = items.map(x => x[0]).join(',');
  if (el('ckList').dataset.key !== key) {
    el('ckList').dataset.key = key;
    el('ckList').innerHTML = items.map(([id, t]) => `<label><input type="checkbox" data-ck-item="${id}" ${ck.checks.has(id) ? 'checked' : ''}> ${esc(t)}</label>`).join('');
  }
  const done = items.filter(([id]) => ck.checks.has(id)).length;
  el('ckVerdict').innerHTML = done === items.length
    ? '<div class="ck-ok">✓ 都確認了。照你算好的數量和停損下單，然後就交給計畫。</div>'
    : `<div class="x-note">還有 ${items.length - done} 項沒有勾。有任何一項勾不下去，這筆可以先等等，機會永遠都有。</div>`;
}

// ============ 部位計畫：理由、停損、目標、檢討日 ============
let planEdit = null;   // 正在編輯的部位代號
const planOf = sym => (data.plans || []).find(p => p.sym === sym && p.status !== 'closed');
function positionsForPlans(c) {
  return [...c.rows.map(r => ({ sym: r.sym, kind: 'stock', qty: r.shares, label: r.sym })),
          ...c.optRows.map(o => ({ sym: o.sym, kind: 'option', qty: o.qty, label: optName(o.sym) }))];
}
// 看多的部位：停損在下、目標在上；看空的（反向 ETF、買 put、賣 call）相反
function isBullish(pos) {
  if (pos.kind === 'stock') return levOf(pos.sym) >= 0;
  const oc = occ(pos.sym);
  return oc.call ? pos.qty > 0 : pos.qty < 0;
}
function planPrice(plan, pos) {
  if (pos.kind === 'stock') return quotes[pos.sym]?.price ?? null;
  return plan.basis === 'option' ? (optQuotes[pos.sym]?.mark ?? null) : (quotes[occ(pos.sym).root]?.price ?? null);
}
function planStatus(plan, pos) {
  const px = planPrice(plan, pos), bull = isBullish(pos), out = [];
  if (px != null && plan.stop > 0 && (bull ? px <= plan.stop : px >= plan.stop)) out.push('stop');
  if (px != null && plan.target > 0 && (bull ? px >= plan.target : px <= plan.target)) out.push('target');
  if (plan.review && plan.review <= today()) out.push('review');
  return { px, out };
}
function renderPlans(c) {
  const box = el('plansBox'); if (!box) return;
  if (box.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) return;   // 正在輸入時不要重畫
  const pos = positionsForPlans(c);
  const closed = (data.plans || []).filter(p => p.status === 'closed' || !pos.some(x => x.sym === p.sym)).sort((a, b) => b.ts - a.ts);
  const basisName = (p, x) => x.kind === 'stock' ? x.sym : p.basis === 'option' ? '選擇權價格' : `標的 ${occ(x.sym).root}`;
  const rows = pos.map(x => {
    const p = planOf(x.sym), editing = planEdit === x.sym;
    let body;
    if (editing) {
      body = `<div class="plan-form">
        <label class="plan-wide">為什麼買？（理由、看好什麼）<textarea data-pf="thesis" rows="2">${esc(p?.thesis || '')}</textarea></label>
        ${x.kind === 'option' ? `<label>停損、目標依據 <select data-pf="basis"><option value="underlying" ${p?.basis !== 'option' ? 'selected' : ''}>標的股價（${occ(x.sym).root}）</option><option value="option" ${p?.basis === 'option' ? 'selected' : ''}>選擇權價格</option></select></label>` : ''}
        <label>停損價 <input type="number" step="any" data-pf="stop" value="${p?.stop ?? ''}"></label>
        <label>目標價 <input type="number" step="any" data-pf="target" value="${p?.target ?? ''}"></label>
        <label>檢討日 <input type="date" data-pf="review" value="${p?.review ?? ''}"></label>
        <div class="plan-wide plan-actions"><button class="primary" data-plan-save="${esc(x.sym)}">儲存計畫</button><button data-plan-cancel="1">取消</button>
          ${p ? `<button class="ghost danger" data-plan-close="${esc(x.sym)}">結束這個計畫</button>` : ''}</div></div>`;
    } else if (p) {
      const st = planStatus(p, x), dir = isBullish(x) ? 1 : -1;
      const dist = v => st.px && v ? pct((v / st.px - 1)) : '—';
      const flags = st.out.map(f => f === 'stop' ? '<span class="x-badge danger">到停損了</span>' : f === 'target' ? '<span class="x-badge good">到目標了</span>' : '<span class="x-badge">該檢討了</span>').join(' ');
      body = `<div class="plan-view">
        ${p.thesis ? `<div class="plan-thesis">「${esc(p.thesis)}」</div>` : ''}
        <div class="plan-meta">${p.stop ? `停損 ${usd(p.stop)} <span class="x-money">（距離 ${dist(p.stop)}）</span>` : '沒有設停損'}
          ・${p.target ? `目標 ${usd(p.target)} <span class="x-money">（距離 ${dist(p.target)}）</span>` : '沒有設目標'}
          ${p.review ? `・檢討日 ${p.review}` : ''}・依據 ${esc(basisName(p, x))}・${dir > 0 ? '看多' : '看空'}部位</div>
        ${flags ? `<div style="margin-top:4px">${flags}</div>` : ''}
        <div class="plan-actions"><button class="ghost" data-plan-edit="${esc(x.sym)}">編輯</button></div></div>`;
    } else {
      body = `<div class="plan-view"><span class="muted">還沒有計畫。</span><button class="ghost" data-plan-edit="${esc(x.sym)}">＋ 寫計畫</button></div>`;
    }
    return `<div class="plan-row"><div class="plan-name"><b>${esc(x.label)}</b><span class="x-sub">${x.kind === 'stock' ? '股票' : x.qty > 0 ? '買方' : '賣方'}</span></div>${body}</div>`;
  }).join('');
  box.innerHTML = (rows || '<div class="x-empty">目前沒有持股</div>') +
    (closed.length ? `<details class="x-details" style="margin-top:10px"><summary>已結束的計畫（${closed.length}）</summary>${closed.map(p => `<div class="plan-row done">
      <div class="plan-name"><b>${esc(p.label || p.sym)}</b><span class="x-sub">${new Date(p.ts).toISOString().slice(0, 10)} 建立${p.closedAt ? `・${p.closedAt} 結束` : ''}</span></div>
      <div class="plan-view">${p.thesis ? `<div class="plan-thesis">「${esc(p.thesis)}」</div>` : ''}<div class="plan-meta">停損 ${p.stop ? usd(p.stop) : '—'}・目標 ${p.target ? usd(p.target) : '—'}</div>
        <div class="plan-actions"><button class="ghost danger" data-plan-del="${p.id}">刪除</button></div></div></div>`).join('')}</details>` : '') +
    '<div class="x-note">碰到停損、到達目標或到了檢討日，頁面上方會提醒你。停損是事先跟自己的約定：到了就照著做，不用重新說服自己。</div>';
}
function savePlan(sym) {
  const box = el('plansBox'), v = k => box.querySelector(`[data-pf="${k}"]`)?.value ?? '';
  const pos = positionsForPlans(calc()).find(x => x.sym === sym);
  const old = planOf(sym);
  const plan = { id: old?.id || uid(), ts: old?.ts || Date.now(), sym, label: pos?.label || sym, status: 'active',
                 thesis: v('thesis').trim(), basis: v('basis') || 'underlying',
                 stop: parseFloat(v('stop')) || null, target: parseFloat(v('target')) || null, review: v('review') || null };
  data.plans = [...(data.plans || []).filter(p => p !== old), plan];
  planEdit = null; save(); renderPlans(calc()); window.renderExtras(); toast('計畫存好了');
}

// ============ 我的交易規則 ============
const RULE_TYPES = {
  optSize: { p: 5, text: p => `單筆選擇權最多投入淨資產 ${p}%`, unit: '%' },
  lev: { p: 2, text: p => `槓桿率不超過 ${p} 倍`, unit: '倍' },
  lossDay: { p: 2.5, text: p => `單日跌幅超過 ${p}% 的當天和隔天，不開新倉`, unit: '%' },
  noDayTrade: { text: () => '不做當天沖銷（股票、選擇權都是）' },
  minDte: { p: 8, text: p => `選擇權只做 ${p} 天以上到期的合約`, unit: '天' },
  journal: { text: () => '有交易的日子就寫一篇日記' },
  custom: { text: (p, r) => r.text },
};
const ruleText = r => RULE_TYPES[r.type]?.text(r.p, r) || r.text || '';
const activeRules = () => (data.rules || []).filter(r => r.on !== false);
function ruleContext() {
  // 檢查規則要用到的資料：每天報酬、每天收盤淨資產、開倉紀錄
  const hist = data.history, rets = dailyReturns(hist), retOn = Object.fromEntries(rets.map(x => [x.date, x.r]));
  const dates = hist.map(h => h.date), prevOf = {};
  dates.forEach((d, i) => { if (i) prevOf[d] = dates[i - 1]; });
  const eqBefore = d => { let v = null; for (const h of hist) { if (h.date < d) v = h.usd; else break; } return v; };
  const opens = [];
  for (const t of data.transactions) {
    if (t.type === 'buy' && t.note !== '股息再投入') opens.push({ date: t.date, kind: 'stock', sym: t.symbol, label: `買 ${t.symbol}` });
    else if (t.type === 'option' && t.action === 'open') opens.push({ date: t.date, kind: 'option', sym: t.symbol, qty: t.qty, amount: t.amount, label: `${t.qty > 0 ? '買' : '賣'} ${optName(t.symbol)}` });
  }
  return { hist, retOn, prevOf, eqBefore, opens };
}
function checkRule(r, ctx, c) {
  const y = String(new Date().getFullYear()), since = d => d.startsWith(y);
  const res = { now: null, total: 0, bad: [] };   // now：目前是否違反（null 代表不適用）
  if (r.type === 'optSize') {
    const groups = {};
    for (const o of ctx.opens) if (o.kind === 'option' && o.qty > 0 && since(o.date)) { const k = o.date + o.sym; (groups[k] ??= { ...o, cost: 0 }).cost += -o.amount; }
    for (const g of Object.values(groups)) {
      const eq = ctx.eqBefore(g.date); if (!eq) continue;
      res.total++; if (g.cost / eq * 100 > r.p) res.bad.push({ date: g.date, what: `${g.label}：投入淨資產 ${pctPlain(g.cost / eq, 1)}` });
    }
    res.now = c.optRows.some(o => o.qty > 0 && o.value / c.totalUSD * 100 > r.p);
  } else if (r.type === 'lev') {
    for (const h of ctx.hist) if (since(h.date) && h.exp != null && h.usd > 0) { res.total++; if (h.exp / h.usd > r.p) res.bad.push({ date: h.date, what: `收盤槓桿率 ${(h.exp / h.usd).toFixed(2)}x` }); }
    res.now = c.leverage != null && c.leverage > r.p;
  } else if (r.type === 'lossDay') {
    const days = [...new Set(ctx.opens.filter(o => since(o.date)).map(o => o.date))];
    for (const d of days) {
      res.total++;
      const today_ = ctx.retOn[d], prev = ctx.retOn[ctx.prevOf[d]];
      if ((today_ != null && today_ * 100 <= -r.p) || (prev != null && prev * 100 <= -r.p))
        res.bad.push({ date: d, what: `${today_ != null && today_ * 100 <= -r.p ? '當天' : '前一天'}帳戶跌 <span class="x-money">${pct(today_ != null && today_ * 100 <= -r.p ? today_ : prev)}</span>，仍開了新倉（${ctx.opens.filter(o => o.date === d).map(o => o.label).slice(0, 3).join('、')}）` });
    }
    const base = c.totalUSD - c.day; res.now = base > 0 && c.day / base * 100 <= -r.p;
  } else if (r.type === 'noDayTrade') {
    const st = realizedStats();
    const ev = stockHoldingEvents(st).map(e => ({ ...e, k: '股票' })).concat(optionLifeEvents(st).map(e => ({ ...e, k: '選擇權' }))).filter(e => since(e.date));
    for (const e of ev) { res.total++; if (e.hold < 0.5) res.bad.push({ date: e.date, what: `${e.k} ${e.k === '股票' ? e.sym : optName(e.sym)} 當天買賣` }); }
  } else if (r.type === 'minDte') {
    for (const o of ctx.opens) if (o.kind === 'option' && since(o.date)) {
      const dte = days(o.date, occ(o.sym).exp); res.total++;
      if (dte < r.p) res.bad.push({ date: o.date, what: `${o.label}：開倉時只剩 ${dte} 天到期` });
    }
  } else if (r.type === 'journal') {
    const start = new Date(r.ts || Date.now()).toISOString().slice(0, 10), written = new Set((data.journal || []).map(j => j.date));
    for (const d of [...new Set(ctx.opens.map(o => o.date))].filter(d => d >= start)) { res.total++; if (!written.has(d)) res.bad.push({ date: d, what: '有交易但沒寫日記' }); }
  } else return null;   // 自訂規則不自動檢查
  res.bad.sort((a, b) => b.date.localeCompare(a.date));
  return res;
}
function renderRules(c) {
  const box = el('rulesBox'); if (!box) return;
  if (box.contains(document.activeElement) && document.activeElement.matches('input')) return;
  const rules = data.rules || [], ctx = ruleContext();
  const results = rules.map(r => ({ r, res: r.on === false ? null : checkRule(r, ctx, c) }));
  const breaking = results.filter(x => x.res?.now).length;
  el('rulesNote').textContent = rules.length ? (breaking ? `${breaking} 條規則目前違反中` : '目前都有遵守') : '';
  const list = results.map(({ r, res }) => {
    const rate = res && res.total ? 1 - res.bad.length / res.total : null;
    return `<div class="rule-row ${r.on === false ? 'off' : ''}">
      <div class="rule-main"><b>${esc(ruleText(r))}</b>
        <span class="x-sub">${r.on === false ? '已停用' : res == null ? '自訂規則：下單前檢查時會列出來提醒你' :
          `${res.now === true ? '<span class="x-badge danger">目前違反中</span> ' : res.now === false ? '<span class="x-badge good">目前有遵守</span> ' : ''}今年遵守率 <b>${rate == null ? '—' : pctPlain(rate)}</b>（${res.total} 次裡有 ${res.bad.length} 次違反）`}</span>
        ${res && res.bad.length ? `<details class="x-details"><summary>看違反的紀錄</summary>${res.bad.slice(0, 30).map(b => `<div class="rule-bad"><span>${b.date}</span> ${esc(b.what).replace(/&lt;span class=&quot;x-money&quot;&gt;(.*?)&lt;\/span&gt;/g, '<span class="x-money">$1</span>')}</div>`).join('')}${res.bad.length > 30 ? '<div class="x-sub">…只列最近 30 筆</div>' : ''}</details>` : ''}</div>
      <div class="rule-actions"><button class="ghost" data-rule-toggle="${r.id}">${r.on === false ? '啟用' : '停用'}</button><button class="ghost danger" data-rule-del="${r.id}">✕</button></div></div>`;
  }).join('');
  const have = new Set(rules.map(r => r.type));
  const templates = Object.entries(RULE_TYPES).filter(([t]) => t !== 'custom' && !have.has(t));
  box.innerHTML = (list || '<div class="x-empty">還沒有規則。從下面挑幾條，或寫一條你自己的。</div>') + `
    <div class="rule-add">
      ${templates.length ? `<div class="x-sub" style="margin-bottom:6px">從範本加入（數字可以改）：</div>
        ${templates.map(([t, d]) => `<div class="rule-tpl"><span>${d.unit ? d.text('<input type="number" step="any" data-rule-p="' + t + '" value="' + d.p + '">') : d.text()}</span><button data-rule-add="${t}">＋ 加入</button></div>`).join('')}` : ''}
      <div class="rule-tpl"><input id="ruleCustom" placeholder="自訂規則，例如：財報前不買短天期 call"><button data-rule-add="custom">＋ 加入</button></div>
    </div>
    <div class="x-note">遵守率是用你今年的交易紀錄回頭檢查的。「有交易就寫日記」從加入規則那天開始算。你的規則也會出現在下單前檢查的清單裡。</div>`;
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
      duty = `被指派要付 ${usd0(need)}<span class="x-sub">${need > c.cashUSD ? `現金不足 ${usd0(need - Math.max(c.cashUSD, 0))}，會用到融資` : '現金足夠'}</span>`;
    } else if (o.qty < 0 && oc.call) {
      const need = 100 * Math.abs(o.qty), have = data.holdings[oc.root]?.shares || 0;
      duty = `被指派要交 ${need} 股<span class="x-sub">${have >= need ? `已持有 ${have} 股（有掩護）` : `只持有 ${have} 股（無掩護，風險無上限）`}</span>`;
    }
    const warn = o.qty < 0 && state === '價內' ? 'danger' : dte <= 3 ? '' : 'good';
    return `<tr>
      <td class="l"><b>${esc(optName(o.sym))}</b><span class="x-sub">${o.qty > 0 ? '買方' : '賣方'} ${Math.abs(o.qty)} 口・IV ${iv ? pctPlain(iv) : '—'}</span></td>
      <td class="num">${dte <= 0 ? '今天' : dte + ' 天'}</td>
      <td class="num">${S ? usd(S) : '—'}<span class="x-sub">履約 ${usd(oc.strike)}</span></td>
      <td><span class="x-badge ${warn}">${state}</span><span class="x-sub">${money == null ? '' : pct(money)}</span></td>
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
  applyTab(); applyPrivacy(); applyCalm();
  try { renderProgress(c); } catch (err) { console.error('progress', err); }
  const expo = exposureGroups(c);
  renderAlertBar(computeAlerts(c, expo));
  const safe = (name, fn) => { try { fn(); } catch (err) { console.error(name, err); const b = el(name); if (b) b.innerHTML = `<div class="x-empty">這個區塊出錯了：${esc(err.message)}</div>`; } };
  if (curTab === 'overview') { safe('contribBox', () => renderContrib(c)); safe('plansBox', () => renderPlans(c)); safe('eventsBox', () => renderEvents(c)); }
  if (curTab === 'perf') { safe('metricsBox', renderMetrics); safe('heatBox', renderHeat); }
  if (curTab === 'risk') { safe('exposureBox', () => renderExposure(c, expo)); safe('stressBox', () => renderStress(c)); safe('optRiskBox', () => renderOptRisk(c)); safe('checkBox', () => renderCheck(c)); safe('rulesBox', () => renderRules(c)); safe('alertSettings', renderAlertSettings); }
  if (curTab === 'trade') { safe('journalBox', renderJournal); safe('analysisBox', renderAnalysis); safe('monthlyBox', renderMonthly); safe('feeBox', renderFees); }
};

// ============ 事件 ============
document.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tab) showTab(b.dataset.tab);
  else if (b.id === 'privacyBtn') { store.set('privacy', store.get('privacy', '0') === '1' ? '0' : '1'); applyPrivacy(); }
  else if (b.id === 'calmBtn') { store.set('calm', isCalm() ? '0' : '1'); peek(false); applyCalm(); render(); }
  else if (b.id === 'peekBtn') peek(!document.documentElement.classList.contains('peek'));
  else if (b.dataset.ckType) { ck.type = b.dataset.ckType; store.set('ck.type', ck.type); renderCheck(calc()); }
  else if (b.dataset.mood) { jMood = b.dataset.mood; renderJournal(); }
  else if (b.dataset.planEdit) { planEdit = b.dataset.planEdit; renderPlans(calc()); el('plansBox').querySelector('[data-pf="thesis"]')?.focus(); }
  else if (b.dataset.planCancel) { planEdit = null; renderPlans(calc()); }
  else if (b.dataset.planSave) savePlan(b.dataset.planSave);
  else if (b.dataset.planClose) {
    const p = planOf(b.dataset.planClose);
    if (p) { p.status = 'closed'; p.closedAt = today(); }
    planEdit = null; save(); renderPlans(calc()); window.renderExtras();
  }
  else if (b.dataset.planDel) {
    if (!b.dataset.confirm) { b.dataset.confirm = '1'; b.textContent = '確定刪除？'; setTimeout(() => { if (b.isConnected) { delete b.dataset.confirm; b.textContent = '刪除'; } }, 3000); return; }
    data.plans = (data.plans || []).filter(p => p.id !== b.dataset.planDel); save(); renderPlans(calc());
  }
  else if (b.dataset.ruleAdd) {
    const t = b.dataset.ruleAdd, r = { id: uid(), ts: Date.now(), type: t, on: true };
    if (t === 'custom') { r.text = el('ruleCustom').value.trim(); if (!r.text) { el('ruleCustom').focus(); return; } }
    else if (RULE_TYPES[t].unit) r.p = parseFloat(document.querySelector(`[data-rule-p="${t}"]`)?.value) || RULE_TYPES[t].p;
    data.rules = [...(data.rules || []), r]; save(); renderRules(calc()); renderCheck(calc()); toast('規則加好了');
  }
  else if (b.dataset.ruleToggle) {
    const r = (data.rules || []).find(x => x.id === b.dataset.ruleToggle); if (r) r.on = r.on === false;
    save(); renderRules(calc()); renderCheck(calc());
  }
  else if (b.dataset.ruleDel) {
    if (!b.dataset.confirm) { b.dataset.confirm = '1'; b.textContent = '確定刪除？'; setTimeout(() => { if (b.isConnected) { delete b.dataset.confirm; b.textContent = '✕'; } }, 3000); return; }
    data.rules = (data.rules || []).filter(r => r.id !== b.dataset.ruleDel); save(); renderRules(calc()); renderCheck(calc());
  }
  else if (b.id === 'jSave') {
    const text = el('jText').value.trim();
    if (!text) { el('jText').focus(); return; }
    data.journal = [...(data.journal || []), { id: uid(), date: today(), ts: Date.now(), mood: jMood, sym: el('jSym').value.trim().toUpperCase(), text }];
    save(); el('jText').value = ''; el('jSym').value = ''; renderJournal(); toast('記下來了');
  }
  else if (b.dataset.jdel) {
    if (!b.dataset.confirm) { b.dataset.confirm = '1'; b.textContent = '確定刪除？'; setTimeout(() => { if (b.isConnected) { delete b.dataset.confirm; b.textContent = '✕'; } }, 3000); return; }
    data.journal = (data.journal || []).filter(j => j.id !== b.dataset.jdel); save(); renderJournal();
  }
  else if (b.dataset.x === 'metrics') { metricsRange = b.dataset.v; store.set('metricsRange', metricsRange); renderMetrics(); }
  else if (b.dataset.ana) { anaView = b.dataset.ana; store.set('anaView', anaView); renderAnalysis(); }
  else if (b.dataset.anaall) { anaShowAll = !anaShowAll; renderAnalysis(); }
  else if (b.dataset.stress) { stressMove = +b.dataset.stress; for (const k in stressGroup) delete stressGroup[k]; store.set('stressMove', stressMove); renderStress(calc()); }
  else if (b.dataset.dismiss != null) {
    const key = 'dismiss.' + today(), set = new Set((store.get(key, '') || '').split('|').filter(Boolean));
    set.add(b.dataset.dismiss); store.set(key, [...set].join('|')); window.renderExtras();
  }
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'stressRange') { stressMove = +t.value; for (const k in stressGroup) delete stressGroup[k]; store.set('stressMove', stressMove); renderStress(calc()); }
  else if (t.dataset.sgroup) { stressGroup[t.dataset.sgroup] = +t.value; renderStress(calc()); }
  else if (t.dataset.ck) {
    const k = t.dataset.ck; ck[k] = ['risk', 'optPct'].includes(k) ? +t.value : t.value;
    if (k === 'sym') { const q = quotes[t.value.trim().toUpperCase()]; const e = document.querySelector('[data-ck="entry"]'); if (q?.price && !e.value) { e.value = q.price; ck.entry = String(q.price); } }
    if (k === 'risk' || k === 'optPct') store.set('ck.' + k, t.value);
    renderCheck(calc());
  }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'outsideFlowChk') { store.set('outsideAsFlow', t.checked ? '1' : '0'); renderMetrics(); renderHeat(); renderProgress(calc()); return; }
  if (t.dataset.ckItem != null) { if (t.checked) ck.checks.add(t.dataset.ckItem); else ck.checks.delete(t.dataset.ckItem); renderCheck(calc()); return; }
  if (!t.dataset.alert) return;
  const a = { ...alertCfg() };
  a[t.dataset.alert] = t.type === 'checkbox' ? t.checked : +t.value;
  if (t.dataset.alert === 'notify' && t.checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  data.settings.alerts = a; save(); window.renderExtras();
});
window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (TABS.includes(t)) showTab(t); });
window.addEventListener('resize', () => { clearTimeout(window._rzx); window._rzx = setTimeout(() => window.renderExtras(), 200); });
})();
