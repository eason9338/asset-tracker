// 分析功能：分頁、警示、隱私模式、今日損益貢獻、風險報酬指標、回撤、每月報酬、依標的曝險、壓力測試、
// 選擇權部位風險、交易分析、每月已實現損益、交易成本、台灣海外所得整理。
// 只讀取 index.html 的資料與函式（data、calc、realizedStats…），除了警示設定以外不寫入資料。
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
const TABS = ['overview', 'perf', 'risk', 'trade', 'tax'];
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

// ============ 警示 ============
const ALERT_DEFAULTS = { on: true, lev: 2, single: 200, dd: 15, dte: 3, notify: false };
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
    <label>瀏覽器通知（網頁開著時） <input type="checkbox" data-alert="notify" ${a.notify ? 'checked' : ''}></label>
  </div>
  <div class="x-note">賣出的選擇權變成價內時一定會提醒。警示只在網頁開著時檢查；按橫幅右邊的 ✕ 可以今天先不顯示。</div>`;
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
      <div class="x-tile"><div class="k">Beta（對 Nasdaq 100）</div><div class="v num">${n2(bq.beta)}</div><div class="s">大盤漲跌 1%，你平均漲跌約 ${n2(bq.beta)}%；相關係數 ${n2(bq.corr)}</div></div>
      <div class="x-tile"><div class="k">Beta（對 S&P 500）</div><div class="v num">${n2(bv.beta)}</div><div class="s">相關係數 ${n2(bv.corr)}</div></div>
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
  el('exposureNote').textContent = top ? `最大：${grpName(top.g)} ${pctPlain(top.total / eq)} 淨資產` : '';
  box.innerHTML = expo.all.map(g => {
    const w = Math.abs(g.total) / max * 100, share = g.total / eq;
    return `<div class="hbar-row"><div class="hbar-name">${esc(grpName(g.g))}</div>
      <div class="hbar-track"><i class="${g.total >= 0 ? '' : 'neg'}" style="left:0;width:${w}%"></i><span class="ref" style="left:${eq / max * 100}%" title="淨資產"></span></div>
      <div class="hbar-val num">${usd0(g.total)} <span class="x-sub">${pctPlain(share)} 淨資產</span></div>
      <div class="hbar-items">${g.items.map(i => `<span class="x-chip ${i.counted ? '' : 'off'}">${esc(i.label)} ${usd0(i.val)}</span>`).join('')}</div></div>`;
  }).join('') + `<div class="x-note">曝險＝市值 × 槓桿倍數（買方選擇權用 delta 換算）。直線標記代表你的淨資產 ${usd0(eq)}，超過這條線代表在這個標的上已經用了槓桿。賣方選擇權列出來參考，不計入。</div>`;
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
      <div class="x-tile"><div class="k">槓桿率</div><div class="v num">${sc.leverage == null ? '—' : sc.leverage.toFixed(2) + 'x'}</div><div class="s">現在 ${base.leverage?.toFixed(2)}x</div></div>
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
      <div class="x-tile"><div class="k">總交易成本</div><div class="v num">${usd(all)}</div><div class="s">佔已實現損益 ${realized > 0 ? pctPlain(all / realized, 1) : '—'}</div></div>
      <div class="x-tile"><div class="k">股票規費</div><div class="v num">${usd(tot('stock'))}</div><div class="s">${tot('n')} 筆，平均每筆 ${usd(tot('n') ? tot('stock') / tot('n') : 0)}</div></div>
      <div class="x-tile"><div class="k">選擇權手續費</div><div class="v num">${usd(tot('opt'))}</div><div class="s">${tot('c')} 口，平均每口 ${usd(tot('c') ? tot('opt') / tot('c') : 0)}</div></div>
      <div class="x-tile"><div class="k">融資利息</div><div class="v num">${usd(tot('int'))}</div><div class="s">${tot('int') ? '' : '紀錄中沒有'}</div></div>
    </div>
    <div class="table-wrap" style="margin:0"><table class="x-table"><thead><tr><th class="l">月份</th><th>股票（筆）</th><th>股票規費</th><th>選擇權（口）</th><th>選擇權手續費</th><th>合計</th></tr></thead>
      <tbody>${months.slice().reverse().map(k => { const o = m[k]; return `<tr><td class="l">${k}</td><td class="num">${o.n}</td><td class="num">${usd(o.stock)}</td><td class="num">${o.c}</td><td class="num">${usd(o.opt)}</td><td class="num"><b>${usd(o.stock + o.opt + o.int)}</b></td></tr>`; }).join('')}</tbody></table></div>
    <div class="x-note">成本＝成交金額與實際收付金額的差（券商手續費、SEC／FINRA 規費等），由券商紀錄推算。買賣價差、匯差不在其中。</div>`;
}

// ============ 台灣海外所得整理 ============
function taxRows() {
  const st = realizedStats(), rows = [];
  const fxOn = d => lastOnOrBefore(Object.fromEntries(data.history.map(h => [h.date, h.fx])), d) || fx;
  for (const e of st.stockEvents) rows.push({ date: e.date, kind: '股票', sym: e.sym, usd: e.r });
  for (const e of st.optEvents) rows.push({ date: e.date, kind: '選擇權', sym: e.sym, usd: e.r });
  for (const t of data.transactions) {
    if (t.type !== 'income' || t.currency !== 'USD') continue;
    const c = t.category || '';
    if (c.startsWith('股息')) rows.push({ date: t.date, kind: '股息（實收）', sym: c.replace('股息', '').trim(), usd: t.amount });
    else if (c.startsWith('利息')) rows.push({ date: t.date, kind: '利息', sym: '', usd: t.amount });
    else if (c.startsWith('退稅')) rows.push({ date: t.date, kind: '預扣稅退回', sym: c.replace('退稅', '').trim(), usd: t.amount });
  }
  for (const r of rows) { r.fx = fxOn(r.date); r.twd = r.usd * r.fx; }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}
function renderTax() {
  const box = el('taxBox'); if (!box) return;
  const rows = taxRows();
  if (!rows.length) { box.innerHTML = '<div class="x-empty">還沒有已實現所得</div>'; return; }
  const years = [...new Set(rows.map(r => r.date.slice(0, 4)))].sort().reverse();
  box.innerHTML = years.map(y => {
    const R = rows.filter(r => r.date.startsWith(y)), sum = (k, f = 'twd') => R.filter(r => r.kind === k).reduce((s, r) => s + r[f], 0);
    const gains = sum('股票') + sum('選擇權'), gainsU = sum('股票', 'usd') + sum('選擇權', 'usd');
    const divNet = sum('股息（實收）'), divGross = divNet / 0.7, withheld = divGross - divNet - sum('預扣稅退回');
    const interest = sum('利息');
    // 財產交易所得：同一年度的損失可以抵銷所得，抵完是負的就算 0
    const total = Math.max(gains, 0) + divGross + interest;
    const pctTo = Math.min(total / 1e6, 1);
    return `<div style="margin-bottom:16px"><div style="font-size:15px;font-weight:600;margin-bottom:8px">${y} 年</div>
      <div class="x-grid">
        <div class="x-tile"><div class="k">海外所得合計（估）</div><div class="v num">${fmt(total, 'TWD')}</div><div class="s">${total >= 1e6 ? '<b class="up">已達 100 萬，需計入基本所得額申報</b>' : `距離 100 萬申報門檻還有 ${fmt(1e6 - total, 'TWD')}`}</div>
          <div class="hbar-track" style="margin-top:6px;height:8px"><i class="${total >= 1e6 ? 'pos' : ''}" style="left:0;width:${pctTo * 100}%"></i></div></div>
        <div class="x-tile"><div class="k">財產交易所得（股票＋選擇權）</div><div class="v num ${cls(gains)}">${fmt(gains, 'TWD', { sign: true })}</div><div class="s">${usd(gainsU, { sign: true })}・股票 ${fmt(sum('股票'), 'TWD', { sign: true })}・選擇權 ${fmt(sum('選擇權'), 'TWD', { sign: true })}</div></div>
        <div class="x-tile"><div class="k">股利所得（稅前，估）</div><div class="v num">${fmt(divGross, 'TWD')}</div><div class="s">實收 ${fmt(divNet, 'TWD')}，美國預扣約 ${fmt(withheld, 'TWD')}</div></div>
        <div class="x-tile"><div class="k">利息所得</div><div class="v num">${fmt(interest, 'TWD')}</div><div class="s">現金利息與股票出借</div></div>
      </div></div>`;
  }).join('') + `<div class="x-note">依最低稅負制：海外所得一年合計達 NT$100 萬，要全數計入基本所得額；基本所得額超過免稅額（近年約 NT$750 萬，以財政部當年度公告為準）才需要繳基本稅額。
    已實現損益用平均成本法、換成台幣用當天匯率；股利稅前金額以美國 30% 預扣稅回推（台積電 ADR 等外國公司不完全適用）；被預扣的稅在申報時可能可以扣抵。
    這是整理參考，不是正式報稅文件，申報前請以券商的年度報表為準。帳外獲利（例如加密貨幣交易所的白銀獲利）不在這裡，如果屬於海外所得也要另外計算。</div>`;
}
function exportTaxCsv() {
  const rows = taxRows();
  const lines = [['日期', '類別', '代號', '金額（美元）', '匯率', '金額（台幣）'].join(',')]
    .concat(rows.map(r => [r.date, r.kind, r.sym, r.usd.toFixed(2), r.fx.toFixed(4), Math.round(r.twd)].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `海外所得明細-${today()}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ============ 對外：每次畫面更新時呼叫 ============
window.renderExtras = function renderExtras(c) {
  if (!data) return;
  c = c || calc();
  applyTab(); applyPrivacy();
  const expo = exposureGroups(c);
  renderAlertBar(computeAlerts(c, expo));
  const safe = (name, fn) => { try { fn(); } catch (err) { console.error(name, err); const b = el(name); if (b) b.innerHTML = `<div class="x-empty">這個區塊出錯了：${esc(err.message)}</div>`; } };
  if (curTab === 'overview') safe('contribBox', () => renderContrib(c));
  if (curTab === 'perf') { safe('metricsBox', renderMetrics); safe('heatBox', renderHeat); }
  if (curTab === 'risk') { safe('exposureBox', () => renderExposure(c, expo)); safe('stressBox', () => renderStress(c)); safe('optRiskBox', () => renderOptRisk(c)); safe('alertSettings', renderAlertSettings); }
  if (curTab === 'trade') { safe('analysisBox', renderAnalysis); safe('monthlyBox', renderMonthly); safe('feeBox', renderFees); }
  if (curTab === 'tax') safe('taxBox', renderTax);
};

// ============ 事件 ============
document.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tab) showTab(b.dataset.tab);
  else if (b.id === 'privacyBtn') { store.set('privacy', store.get('privacy', '0') === '1' ? '0' : '1'); applyPrivacy(); }
  else if (b.dataset.x === 'metrics') { metricsRange = b.dataset.v; store.set('metricsRange', metricsRange); renderMetrics(); }
  else if (b.dataset.ana) { anaView = b.dataset.ana; store.set('anaView', anaView); renderAnalysis(); }
  else if (b.dataset.anaall) { anaShowAll = !anaShowAll; renderAnalysis(); }
  else if (b.dataset.stress) { stressMove = +b.dataset.stress; for (const k in stressGroup) delete stressGroup[k]; store.set('stressMove', stressMove); renderStress(calc()); }
  else if (b.dataset.dismiss != null) {
    const key = 'dismiss.' + today(), set = new Set((store.get(key, '') || '').split('|').filter(Boolean));
    set.add(b.dataset.dismiss); store.set(key, [...set].join('|')); window.renderExtras();
  }
  else if (b.id === 'taxCsvBtn') exportTaxCsv();
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'stressRange') { stressMove = +t.value; for (const k in stressGroup) delete stressGroup[k]; store.set('stressMove', stressMove); renderStress(calc()); }
  else if (t.dataset.sgroup) { stressGroup[t.dataset.sgroup] = +t.value; renderStress(calc()); }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'outsideFlowChk') { store.set('outsideAsFlow', t.checked ? '1' : '0'); renderMetrics(); renderHeat(); return; }
  if (!t.dataset.alert) return;
  const a = { ...alertCfg() };
  a[t.dataset.alert] = t.type === 'checkbox' ? t.checked : +t.value;
  if (t.dataset.alert === 'notify' && t.checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  data.settings.alerts = a; save(); window.renderExtras();
});
window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (TABS.includes(t)) showTab(t); });
window.addEventListener('resize', () => { clearTimeout(window._rzx); window._rzx = setTimeout(() => window.renderExtras(), 200); });
})();
