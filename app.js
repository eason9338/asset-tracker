// ============ State ============
let data = null;
let quotes = {};           // symbol -> {price, prevClose, name}
let fx = null;             // USD -> TWD
let fxPrev = null;
let bench = null;
let optQuotes = {};        // 選擇權報價（Yahoo 延遲約 20 分鐘）          // 歷史收盤價 {VOO:{date:close}, QQQ:..., ^IRX:...}

// 常見槓桿／反向 ETF 的倍數（可在「改」裡面覆寫）
const LEV_DEFAULT = {
  GGLL: 2, TSLL: 2, METU: 2, MUU: 2, ORCX: 2, NVDL: 2, NVDU: 2, AAPU: 2, AMZU: 2, MSFU: 2, CONL: 2, AVL: 2,
  SSO: 2, QLD: 2, USD: 2, ROM: 2, PLTU: 2, MSTU: 2, TSMX: 2, AMDL: 2,
  TQQQ: 3, UPRO: 3, SPXL: 3, SOXL: 3, TECL: 3, FNGU: 3, TNA: 3, LABU: 3, UDOW: 3,
  SH: -1, PSQ: -1, TSLQ: -1, SDS: -2, QID: -2, SQQQ: -3, SPXU: -3, SPXS: -3, SOXS: -3, TZA: -3,
};
const levOf = s => data.settings.leverage?.[s] ?? LEV_DEFAULT[s] ?? 1;
const OPT_RE = /^[A-Z.]+\d{6}[CP]\d{8}$/;
let lastUpdate = null;
let chartRange = '365';    // 總資產走勢的區間：天數、'ytd' 或 '0'（全部）；預設一年
let cmpRange = '365';       // 報酬率比較的區間；預設一年
let levRange = '365';      // 槓桿率走勢的區間；預設一年
function rangeCutoff(r) {
  if (r === 'ytd') return new Date().getFullYear() + '-01-01';
  if (!+r) return '';
  const d = new Date(Date.now() - +r * 864e5 - new Date().getTimezoneOffset() * 6e4);
  return d.toISOString().slice(0, 10);
}
// 區間從「開始日前的最後一個收盤」起算，例如「今年」從去年最後一個交易日的收盤開始
const inRange = (hist, r) => {
  const c = rangeCutoff(r);
  if (!c) return hist;
  const i = hist.findIndex(h => h.date >= c);
  return i < 0 ? [] : hist.slice(Math.max(0, i - 1));
};
let txFilter = 'all';
let txLimit = 30;
let txYear = 'all';        // 交易紀錄頁：只看某一年（同時套用到已實現損益與勝率表）
let txMonths = new Set();  // 再細分到那一年的某幾個月（'01'～'12'，空的代表整年）
let txSearch = '';         // 交易紀錄頁：代號搜尋
let txPicker = null;       // 交易紀錄頁的期間選擇器
{ // 網址可以直接帶期間，例如 /trades?ym=2025-10 或 /trades?y=2025&m=10,11,12
  const q = new URLSearchParams(location.search), ym = q.get('ym');
  if (ym && /^\d{4}-\d{2}$/.test(ym)) { txYear = ym.slice(0, 4); txMonths = new Set([ym.slice(5)]); }
  else if (/^\d{4}$/.test(q.get('y') || '')) { txYear = q.get('y'); txMonths = new Set((q.get('m') || '').split(',').filter(m => /^\d{1,2}$/.test(m)).map(m => m.padStart(2, '0'))); }
}
const syncTxUrl = () => history.replaceState(null, '', location.pathname + (txYear === 'all' ? '' : `?y=${txYear}${txMonths.size ? '&m=' + [...txMonths].sort().map(Number).join(',') : ''}`));

// 每一頁只放自己的區塊：找不到的元素回傳一個不在畫面上的空 div，寫進去不會出錯，圖表也會因為量不到寬度而略過
const $ = s => document.querySelector(s) || document.createElement('div');
const has = s => !!document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

function fmt(n, cur = 'USD', opts = {}) {
  if (n == null || isNaN(n)) return '—';
  const digits = opts.digits ?? (cur === 'TWD' ? 0 : 2);
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const sign = opts.sign ? (n > 0 ? '+' : n < 0 ? '−' : '') : (n < 0 ? '−' : '');
  const sym = cur === 'TWD' ? 'NT$' : cur === 'USD' ? '$' : '';
  return sign + sym + s;
}
const fmtPct = n => n == null || !isFinite(n) ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n * 100).toFixed(2) + '%';
const cls = n => n > 0 ? 'up' : n < 0 ? 'down' : 'muted';
const fmtShares = n => (+n).toLocaleString('en-US', { maximumFractionDigits: 6 });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

// ============ Persistence ============
async function load() {
  const r = await fetch('/api/data');
  data = await r.json();
  data.cash ??= { USD: 0, TWD: 0 };
  data.holdings ??= {};
  data.transactions ??= [];
  data.history ??= [];
  data.settings ??= { displayCurrency: 'TWD' };
  if (data.settings.lastFx) ({ rate: fx, prev: fxPrev } = data.settings.lastFx);
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      if (r.status === 409) { toast('資料已在別處更新，重新載入中…'); setTimeout(() => location.reload(), 1200); return; }
      if (!r.ok) throw new Error();
      data.rev = (await r.json()).rev;
    } catch { toast('⚠️ 儲存失敗，請確認伺服器仍在執行'); }
  }, 150);
}

// ============ Quotes ============
async function refreshQuotes() {
  const optSyms = realizedStats().openPos.map(o => o.symbol);
  const roots = optSyms.map(s => occ(s)?.root).filter(Boolean);   // 標的股價：算 delta 用
  const syms = [...new Set([...Object.keys(data.holdings), ...roots])];
  const btn = $('#refreshBtn');
  btn.innerHTML = '<span class="spin">↻</span> 更新中';
  try {
    const r = await fetch('/api/quotes?symbols=' + encodeURIComponent([...syms, 'TWD=X'].join(',')));
    const q = await r.json();
    let failed = [];
    for (const [s, v] of Object.entries(q)) {
      if (v.error || v.price == null) { if (s !== 'TWD=X') failed.push(s); continue; }
      if (s === 'TWD=X') { fx = v.price; fxPrev = v.prevClose; data.settings.lastFx = { rate: fx, prev: fxPrev }; }
      else quotes[s] = v;
    }
    if (optSyms.length) {
      const oq = await (await fetch('/api/options?symbols=' + encodeURIComponent(optSyms.join(',')))).json();
      for (const [s, v] of Object.entries(oq)) {
        if (v.error || v.mark == null) failed.push(optName(s));
        else optQuotes[s] = v;
      }
    }
    lastUpdate = new Date();
    if (failed.length) toast('查不到報價：' + failed.join(', '));
    recordHistory();
  } catch {
    toast('⚠️ 無法取得股價（網路或伺服器問題）');
  }
  btn.innerHTML = '↻ 更新';
  render();
}

// 交易時段標示（夜盤 Yahoo 沒有資料，會停在盤後最後價格）
const SESSION_TAG = { pre: '盤前', post: '盤後', overnight: '夜盤' };
const SESSION_TEXT = { pre: '盤前交易中', regular: '盤中', post: '盤後交易中', overnight: '夜盤交易中', closed: '休市' };
function marketSession() {
  const q = Object.keys(data.holdings).map(k => quotes[k]).find(x => x?.session);
  const s = q?.session, src = q?.source === 'futu' ? '・富途報價' : '・Yahoo 報價';
  if (s !== 'post' || q?.source === 'futu') return SESSION_TEXT[s] ? SESSION_TEXT[s] + src : '';
  // 盤後時段結束（美東 20:00）之後，到隔天盤前之前，Yahoo 停在盤後最後價格
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const m = et.getHours() * 60 + et.getMinutes();
  return m >= 16 * 60 && m < 20 * 60 ? SESSION_TEXT.post : '夜盤時段（無資料，顯示盤後最後價格）';
}

// ============ Calculations ============
function calc() {
  let stock = 0, cost = 0, day = 0, exposure = 0, missing = [];
  const rows = Object.entries(data.holdings).map(([sym, h]) => {
    const q = quotes[sym];
    const price = q?.price;
    const value = price != null ? h.shares * price : null;
    const avg = h.shares ? h.cost / h.shares : 0;
    const dayChg = q?.prevClose ? h.shares * (price - q.prevClose) : null;
    const lev = levOf(sym);
    if (value != null) { stock += value; cost += h.cost; day += dayChg || 0; exposure += value * lev; } else missing.push(sym);
    return { sym, ...h, avg, price, value, lev, session: q?.session, regularPrice: q?.regularPrice,
             dayPct: q?.prevClose ? price / q.prevClose - 1 : null, name: q?.name };
  });
  rows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  // 未平倉選擇權：用買賣價中間價計價（沒有報價時用成本）；曝險 = 口數 × 100 × delta × 標的價 × 標的槓桿
  // 賣方部位（sell call / sell put）不計入曝險：通常是短天期賺時間價值，不是要承擔方向
  let optValue = 0;
  const optRows = realizedStats().openPos.map(o => {
    const q = optQuotes[o.symbol], oc = occ(o.symbol), S = quotes[oc?.root]?.price;
    const mark = q?.mark ?? null;
    const value = mark != null ? o.qty * mark * 100 : o.cost;
    const delta = mark != null ? optDelta(o.symbol, mark, S) : null;
    if (q?.price != null && q.prevClose) day += o.qty * 100 * (q.price - q.prevClose);
    if (delta != null && o.qty > 0) exposure += o.qty * 100 * delta * S * levOf(oc.root);
    optValue += value;
    return { sym: o.symbol, qty: o.qty, avg: o.cost / o.qty / 100, mark, bid: q?.bid, ask: q?.ask, value, delta,
             dayPct: q?.price != null && q.prevClose ? q.price / q.prevClose - 1 : null, time: q?.time };
  }).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const cashUSD = data.cash.USD || 0;
  const totalUSD = stock + optValue + cashUSD;
  return { rows, optRows, optValue, stock, cost, day, exposure, missing, cashUSD, totalUSD, totalTWD: fx ? totalUSD * fx : null,
           leverage: totalUSD > 0 ? exposure / totalUSD : null };
}
// 把美元金額轉成顯示幣別
const conv = (usd, cur) => cur === 'TWD' ? (fx ? usd * fx : null) : usd;

function recordHistory() {
  const c = calc();
  if (c.missing.length || !fx) return;
  const d = today();
  const entry = { date: d, usd: round(c.totalUSD, 2), twd: round(c.totalTWD, 0), fx: round(fx, 4), exp: round(c.exposure, 2) };
  const last = data.history[data.history.length - 1];
  if (last && last.date === d) {
    if (last.usd === entry.usd && last.twd === entry.twd) return;
    data.history[data.history.length - 1] = entry;
  } else data.history.push(entry);
  save();
}

// ============ Render ============
function render() {
  const cur = data.settings.displayCurrency;
  const c = calc();
  document.documentElement.classList.toggle('us-colors', !!data.settings.usColors);
  $('#usColors').checked = !!data.settings.usColors;
  $$('#curSeg button').forEach(b => b.classList.toggle('on', b.dataset.cur === cur));
  $$('#rangeSeg button').forEach(b => b.classList.toggle('on', b.dataset.range === chartRange));
  $$('#cmpRangeSeg button').forEach(b => b.classList.toggle('on', b.dataset.crange === cmpRange));
  $$('#levRangeSeg button').forEach(b => b.classList.toggle('on', b.dataset.lrange === levRange));
  $$('#txFilter button').forEach(b => b.classList.toggle('on', b.dataset.f === txFilter));

  // hero
  $('#heroTotal').textContent = cur === 'TWD' ? fmt(c.totalTWD, 'TWD') : fmt(c.totalUSD, 'USD');
  const dayBase = c.stock + c.optValue - c.day;
  $('#heroDay').innerHTML = `<span class="muted">今日</span> <span class="${cls(c.day)}">${fmt(conv(c.day, cur), cur, { sign: true })} (${fmtPct(dayBase ? c.day / dayBase : null)})</span>`;
  $('#fxInfo').textContent = fx ? `USD/TWD ${fx.toFixed(3)}` : '';
  const sess = marketSession();
  $('#sessionInfo').textContent = sess ? '美股' + sess : '';
  $('#updatedAt').textContent = lastUpdate ? '更新於 ' + lastUpdate.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '尚未更新';

  // stats
  $('#stStock').textContent = fmt(c.stock + c.optValue, 'USD');
  $('#stStockSub').innerHTML = `<span class="muted">${c.optRows.length ? `股票 ${fmt(c.stock, 'USD', { digits: 0 })}・選擇權 ${fmt(c.optValue, 'USD', { digits: 0 })}` : fx ? `≈ ${fmt(c.stock * fx, 'TWD')}` : ''}</span>`;
  $('#stUSD').textContent = fmt(c.cashUSD, 'USD');
  $('#stUSDSub').textContent = fx ? '≈ ' + fmt(c.cashUSD * fx, 'TWD') : '';
  $('#stFx').textContent = fx ? fx.toFixed(3) : '—';
  $('#stLev').textContent = c.leverage != null ? c.leverage.toFixed(2) + 'x' : '—';
  $('#stLevSub').textContent = c.leverage != null ? `曝險 ${fmt(c.exposure, 'USD', { digits: 0 })} ／ 淨資產 ${fmt(c.totalUSD, 'USD', { digits: 0 })}` : '';
  $('#stFxSub').innerHTML = fx && fxPrev ? `<span class="${cls(fx - fxPrev)}">${fx - fxPrev >= 0 ? '+' : '−'}${Math.abs(fx - fxPrev).toFixed(3)}</span> <span class="muted">較前日・自動更新</span>` : '<span class="muted">自動更新</span>';

  // holdings
  const hb = $('#holdingsBody');
  if (!c.rows.length) {
    hb.innerHTML = `<tr><td colspan="7" class="empty">還沒有持股，上傳券商的持倉檔或交易紀錄開始</td></tr>`;
  } else {
    const totalAssetUSD = c.totalUSD || c.stock || 1;
    hb.innerHTML = c.rows.map(r => {
      const share = r.value != null ? r.value / totalAssetUSD : 0;
      return `<tr>
        <td><a class="sym sym-link" href="/symbol?s=${encodeURIComponent(window.symGroup?.(r.sym).g || r.sym)}">${esc(r.sym)}</a>${r.lev !== 1 ? `<span class="badge xs accent">${r.lev}x</span>` : ''}<span class="sym-name">${esc(r.name || '')}</span></td>
        <td class="num">${fmtShares(r.shares)}</td>
        <td class="num">${fmt(r.avg)}</td>
        <td class="num">${r.price != null ? fmt(r.price) + (SESSION_TAG[r.session] ? ` <span class="badge xs">${SESSION_TAG[r.session]}</span><span class="sym-name">收盤 ${fmt(r.regularPrice)}</span>` : '') : '<span class="muted">—</span>'}</td>
        <td class="num ${cls(r.dayPct)}">${fmtPct(r.dayPct)}</td>
        <td class="num">${fmt(r.value)}</td>
        <td class="num"><div class="alloc"><span>${(share * 100).toFixed(1)}%</span><div class="alloc-bar"><i style="width:${Math.min(100, share * 100)}%"></i></div></div></td>
      </tr>`;
    }).join('') + c.optRows.map(o => {
      const share = o.value / totalAssetUSD;
      return `<tr>
        <td><span class="sym">${esc(optName(o.sym))}</span><span class="sym-name">選擇權${o.delta != null ? `・Δ ${o.delta.toFixed(2)}` : ''}</span></td>
        <td class="num">${o.qty > 0 ? '' : '−'}${fmtShares(Math.abs(o.qty))} 口</td>
        <td class="num">${fmt(o.avg)}</td>
        <td class="num">${o.mark != null ? fmt(o.mark) + (o.bid > 0 && o.ask > 0 ? `<span class="sym-name">買 ${fmt(o.bid)}／賣 ${fmt(o.ask)}</span>` : '<span class="sym-name" title="選擇權只在正規盤交易">收盤價</span>') : '<span class="muted">—</span>'}</td>
        <td class="num ${cls(o.dayPct * Math.sign(o.qty))}" title="合約價格漲跌；顏色依對你的損益（賣方部位價格上漲是虧損）">${fmtPct(o.dayPct)}</td>
        <td class="num">${fmt(o.value)}</td>
        <td class="num"><div class="alloc"><span>${(share * 100).toFixed(1)}%</span><div class="alloc-bar"><i style="width:${Math.min(100, Math.abs(share) * 100)}%"></i></div></div></td>
      </tr>`;
    }).join('');
  }
  const lastOptTime = Math.max(0, ...c.optRows.map(o => o.time || 0));
  $('#optNote').textContent = c.optRows.length
    ? `選擇權以買賣價的中間價計價，報價來自 Yahoo，延遲約 20 分鐘` + (lastOptTime ? `（最後成交 ${new Date(lastOptTime * 1000).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）` : '') + '；賣方部位市值為負。'
    : '';

  renderChart();
  renderCompare();
  renderLev();
  renderTx();
  $('#undoImportBtn').hidden = !data.imports?.length;
  const lastTx = data.transactions.filter(t => t.imported).map(t => t.date).sort().at(-1);
  $('#syncInfo').textContent = [data.settings.syncDate && `持倉檔同步至 ${data.settings.syncDate}`, lastTx && `交易紀錄至 ${lastTx}`].filter(Boolean).join('・');
  if (typeof renderExtras === 'function') renderExtras(c);   // analytics.js 的分析功能
}

// ============ 已實現損益 ============
function realizedStats() {
  const todayStr = today();
  // 股票：平均成本法。紀錄開始前就持有的股數，用開始前一天的收盤價當成本
  // 同一天內先買後賣（券商檔案沒有當天的成交先後，這樣才不會出現「賣出沒持股」）
  const trades = data.transactions.filter(t => t.type === 'buy' || t.type === 'sell')
    .sort((a, b) => a.date.localeCompare(b.date) || (a.type === 'sell') - (b.type === 'sell') || a.ts - b.ts);
  const init = {};
  for (const [sym, h] of Object.entries(data.holdings)) init[sym] = h.shares;
  for (const t of trades) init[t.symbol] = round((init[t.symbol] || 0) - (t.type === 'buy' ? t.shares : -t.shares));
  const base = data.settings.base?.prices || {};
  const book = {}, estimated = [];
  for (const [sym, q] of Object.entries(init)) {
    if (q <= 1e-9) continue;
    const p = base[sym] ?? trades.find(t => t.symbol === sym)?.price ?? 0;
    if (base[sym] == null) estimated.push(sym);
    book[sym] = { q, cost: q * p };
  }
  const perSell = {}, bySym = {}, stockEvents = [];
  let stock = 0, sells = 0;
  for (const t of trades) {
    const b = book[t.symbol] ??= { q: 0, cost: 0 };
    if (t.type === 'buy') { b.q = round(b.q + t.shares); b.cost += t.total; continue; }
    const q = Math.min(t.shares, b.q), avg = b.q > 0 ? b.cost / b.q : 0;
    // 賣超過已知持股的部分（資料不完整）以成交價當成本，不計損益
    const r = t.total - avg * q - (t.shares - q) * (t.total / t.shares);
    b.cost -= avg * q; b.q = round(b.q - q);
    if (b.q <= 1e-9) { b.q = 0; b.cost = 0; }
    perSell[t.id] = r; stock += r; sells++;
    stockEvents.push({ sym: t.symbol, date: t.date, r });
    bySym[t.symbol] = (bySym[t.symbol] || 0) + r;
  }
  // 選擇權：同一合約用平均成本，每筆平倉的損益 = 平倉金額 − 對應的開倉成本；到期失效的另外補一列
  const opts = {};
  for (const t of data.transactions) if (t.type === 'option') (opts[t.symbol] ??= []).push(t);
  const perOpt = {}, expiries = [], openPos = [], optEvents = [];
  let option = 0, closes = 0, expired = 0, open = 0, partial = 0;
  for (const [sym, list] of Object.entries(opts)) {
    list.sort((a, b) => a.date.localeCompare(b.date) || (a.action === 'close') - (b.action === 'close') || a.ts - b.ts);
    let p = 0, carry = 0;   // 部位（口，買方為正）與帳面成本（付出為正、收到為負）
    for (const t of list) {
      const q = t.qty || 0;
      const reduces = p !== 0 && Math.sign(p) !== Math.sign(q);
      if (t.action === 'close' && !reduces) { perOpt[t.id] = null; partial++; continue; }   // 開倉在紀錄開始前
      if (!reduces) { p = round(p + q); carry += -t.amount; continue; }
      const used = Math.min(Math.abs(q), Math.abs(p));
      const costOut = carry * used / Math.abs(p), closeAmt = t.amount * used / Math.abs(q);
      const r = closeAmt - costOut;
      perOpt[t.id] = r; option += r; closes++;
      optEvents.push({ sym, date: t.date, r, side: p > 0 ? 'long' : 'short', call: occ(sym)?.call });
      carry -= costOut; p = round(p + Math.sign(q) * used);
      if (used < Math.abs(q)) { p = round(p + Math.sign(q) * (Math.abs(q) - used)); carry += -(t.amount - closeAmt); }   // 超出的部分視為反向開倉
      if (!p) carry = 0;
    }
    if (!p) continue;
    const exp = optExpiry(sym);
    if (exp && exp < todayStr) {
      const r = -carry;   // 到期失效：買方損失全部權利金、賣方賺到全部權利金
      option += r; expired++;
      optEvents.push({ sym, date: exp, r, side: p > 0 ? 'long' : 'short', call: occ(sym)?.call, expired: true });
      expiries.push({ type: 'expire', id: 'exp-' + sym, date: exp, ts: 0, symbol: sym, qty: -p, desc: list.at(-1).desc, realized: r });
    } else { open++; openPos.push({ symbol: sym, qty: p, cost: carry }); }
  }
  // 股息（稅後實收）、預扣稅退回、利息
  let div = 0, divN = 0, refund = 0, interest = 0, outside = 0;
  for (const t of data.transactions) {
    if ((t.type !== 'income' && t.type !== 'expense') || t.currency !== 'USD') continue;
    const v = (t.type === 'income' ? 1 : -1) * t.amount, c = t.category || '';
    if (c.startsWith('股息')) { div += v; divN++; }
    else if (c.startsWith('退稅')) refund += v;
    else if (c.startsWith('利息')) interest += v;
    else if (c.startsWith('帳外獲利')) outside += v;
  }
  return { stock, sells, perSell, bySym, stockEvents, estimated, option, perOpt, optEvents, expiries, openPos, closes, expired, open, partial, div, divN, refund, interest, outside };
}
// 選了期間時，上方列出那段期間的帳戶報酬與大盤（每個月分開算再連乘，月份不連續也正確）
function renderTxPeriod() {
  const box = $('#txPeriod');
  if (txYear === 'all' || !window.periodPerf) { box.innerHTML = ''; return; }
  const ms = txMonths.size ? [...txMonths].sort() : Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
  const parts = ms.map(m => window.periodPerf(`${txYear}-${m}-01`, `${txYear}-${m}-31`)).filter(Boolean);
  if (!parts.length) { box.innerHTML = ''; return; }
  const chain = k => parts.some(p => p[k] == null) ? null : parts.reduce((a, p) => a * (1 + p[k]), 1) - 1;
  const me = chain('twr'), q = chain('qqq'), v = chain('voo'), gain = parts.reduce((a, p) => a + p.gain, 0);
  const p = x => x == null ? '—' : fmtPct(x);
  box.innerHTML = `<div class="statbar"><span class="statbar-title">${txYear} 年${txMonths.size ? ' ' + UI.monthsLabel(txMonths) : ''}</span>
    <span>我的報酬率 <b class="num ${cls(me)}">${p(me)}</b></span><span>Nasdaq 100 <b class="num">${p(q)}</b></span><span>S&amp;P 500 <b class="num">${p(v)}</b></span>
    <span>賺到的錢 <b class="num ${cls(gain)}">${fmt(gain, 'USD', { sign: true, digits: 0 })}</b></span></div>`;
}
// 只看某一年：已實現事件、股息等都只留那一年的
function yearView(st, y, months) {
  if (y === 'all') return st;
  const inY = d => d.startsWith(y) && (!months?.size || months.has(d.slice(5, 7)));
  const stockEvents = st.stockEvents.filter(e => inY(e.date)), optEvents = st.optEvents.filter(e => inY(e.date)), bySym = {};
  for (const e of stockEvents) bySym[e.sym] = (bySym[e.sym] || 0) + e.r;
  let div = 0, divN = 0, refund = 0, interest = 0, outside = 0;
  for (const t of data.transactions) {
    if ((t.type !== 'income' && t.type !== 'expense') || t.currency !== 'USD' || !inY(t.date)) continue;
    const v = (t.type === 'income' ? 1 : -1) * t.amount, c = t.category || '';
    if (c.startsWith('股息')) { div += v; divN++; } else if (c.startsWith('退稅')) refund += v;
    else if (c.startsWith('利息')) interest += v; else if (c.startsWith('帳外獲利')) outside += v;
  }
  const sum = a => a.reduce((s, e) => s + e.r, 0);
  return { ...st, year: months?.size ? `${y} 年 ${UI.monthsLabel(months)}` : y, stockEvents, optEvents, bySym, stock: sum(stockEvents), sells: stockEvents.length, option: sum(optEvents),
           closes: optEvents.filter(e => !e.expired).length, expired: optEvents.filter(e => e.expired).length, open: 0, partial: 0,
           div, divN, refund, interest, outside };
}
// 勝率：每一筆已實現損益算一次（股票＝每筆賣出，選擇權＝每筆平倉或到期）；正負 1 分錢以內算打平
function winStats(events) {
  const wins = events.filter(e => e.r > 0.005), losses = events.filter(e => e.r < -0.005);
  const sumW = wins.reduce((a, e) => a + e.r, 0), sumL = losses.reduce((a, e) => a + e.r, 0);
  return {
    n: events.length, w: wins.length, l: losses.length, t: events.length - wins.length - losses.length,
    rate: wins.length + losses.length ? wins.length / (wins.length + losses.length) : null,
    avgW: wins.length ? sumW / wins.length : 0, avgL: losses.length ? sumL / losses.length : 0,
    pf: sumL ? sumW / -sumL : null, total: sumW + sumL,
    best: events.reduce((a, e) => (!a || e.r > a.r ? e : a), null), worst: events.reduce((a, e) => (!a || e.r < a.r ? e : a), null),
  };
}
function winTable(rows) {
  const pct = v => v == null ? '—' : (v * 100).toFixed(0) + '%';
  return `<div class="table-wrap"><table class="table"><thead><tr>
    <th>類別</th><th>筆數</th><th>勝率</th><th>勝／敗</th><th>平均賺</th><th>平均賠</th><th>獲利因子</th><th>合計</th></tr></thead><tbody>
    ${rows.filter(([, w]) => w.n).map(([k, w]) => `<tr><td>${k}</td><td class="num">${w.n}</td><td class="num"><b>${pct(w.rate)}</b></td>
      <td class="num">${w.w}／${w.l}${w.t ? `<span class="muted">（平 ${w.t}）</span>` : ''}</td>
      <td class="num up">${fmt(w.avgW, 'USD', { sign: true })}</td><td class="num down">${fmt(w.avgL, 'USD', { sign: true })}</td>
      <td class="num">${w.pf == null ? '—' : w.pf.toFixed(2)}</td><td class="num ${cls(w.total)}">${fmt(w.total, 'USD', { sign: true })}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function renderPnl(st) {
  const ranked = Object.entries(st.bySym).sort((a, b) => b[1] - a[1]);
  const best = ranked[0], worst = ranked.at(-1);
  const baseDate = data.settings.base?.date;
  const firstDate = data.transactions.filter(t => t.imported).map(t => t.date).sort()[0];
  const sign = v => fmt(v, 'USD', { sign: true });
  const dividends = st.div + st.refund;
  const panels = {
    all: { k: '總已實現損益', v: st.stock + st.option + dividends + st.outside,
      s: [st.year ? `${st.year}${/月$/.test(st.year) ? '' : ' 年'}・股票 + 選擇權 + 股息${st.outside ? ' + 帳外獲利' : ''}` : firstDate ? `期間 ${firstDate} 起・股票 + 選擇權 + 股息${st.outside ? ' + 帳外獲利' : ''}` : ''],
      parts: [['trade', '股票', st.stock], ['option', '選擇權', st.option], ['cash', '股息', dividends],
              ...(st.outside ? [['cash', '帳外獲利', st.outside]] : [])] },
    trade: { k: '股票已實現損益', v: st.stock,
      s: [`${st.sells} 筆賣出・平均成本法`,
          best && worst && best !== worst ? `最多 ${esc(best[0])} ${fmt(best[1], 'USD', { sign: true, digits: 0 })}・最少 ${esc(worst[0])} ${fmt(worst[1], 'USD', { sign: true, digits: 0 })}` : '',
          baseDate ? `紀錄開始前的持股以 ${baseDate} 收盤價計成本` : ''] },
    option: { k: '選擇權已實現損益', v: st.option,
      s: [`${st.closes} 筆平倉` + (st.expired ? `・${st.expired} 個合約到期失效` : ''),
          '每筆平倉損益 = 平倉金額 − 該合約的開倉成本',
          st.open ? `${st.open} 個合約未平倉，不計入` : '',
          st.partial ? `${st.partial} 筆平倉的開倉在紀錄開始前，缺成本不計入` : ''] },
    cash: { k: '股息收入（稅後）', v: dividends,
      s: [`${st.divN} 筆股息`, st.refund ? `含預扣稅退回 ${fmt(st.refund)}` : '', st.interest ? `另有利息 ${fmt(st.interest)}（未計入）` : '',
          st.outside ? `另有帳外獲利 ${fmt(st.outside)}（計入總已實現損益）` : ''] },
  };
  // 勝率表：股票、選擇權（分買方、賣方）
  const sw = winStats(st.stockEvents), ow = winStats(st.optEvents);
  const longW = winStats(st.optEvents.filter(e => e.side === 'long')), shortW = winStats(st.optEvents.filter(e => e.side === 'short'));
  panels.trade.table = winTable([['股票（每筆賣出）', sw]]);
  panels.option.table = winTable([['全部', ow], ['買方（buy call／put）', longW], ['賣方（sell call／put）', shortW]]);
  panels.all.table = winTable([['股票', sw], ['選擇權', ow]]);
  const pn = panels[txFilter] || panels.all;
  $('#pnlGrid').innerHTML = `<div class="pnl-panel">
    <div class="pnl-main"><div class="k">${pn.k}</div><div class="v num ${cls(pn.v)}">${sign(pn.v)}</div>
      ${fx ? `<div class="s num">≈ ${fmt(pn.v * fx, 'TWD', { sign: true })}</div>` : ''}</div>
    ${pn.parts ? `<div class="pnl-parts">${pn.parts.map(([f, k, v]) => `<button class="pnl-part" data-f="${f}"><span class="k">${k}</span><span class="num ${cls(v)}">${sign(v)}</span></button>`).join('')}</div>` : ''}
    <div class="s pnl-notes">${pn.s.filter(Boolean).join('<br>')}</div>
    ${pn.table ? `<div style="flex-basis:100%;min-width:0;max-width:100%">${pn.table}<div class="s" style="margin-top:4px">勝率＝賺錢筆數 ÷（賺＋賠筆數）；獲利因子＝總賺 ÷ 總賠，大於 1 代表整體賺錢</div></div>` : ''}
  </div>`;
}

function occ(sym) {
  const m = String(sym).match(/^([A-Z.]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  return m && { root: m[1], exp: `20${m[2]}-${m[3]}-${m[4]}`, call: m[5] === 'C', strike: +m[6] / 1000 };
}
const normCdf = x => {   // 標準常態累積分布（Abramowitz–Stegun 近似）
  const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
};
function bsModel(S, K, T, r, v, call) {
  const d1 = (Math.log(S / K) + (r + v * v / 2) * T) / (v * Math.sqrt(T)), d2 = d1 - v * Math.sqrt(T);
  const price = call ? S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2) : K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
  return { price, delta: call ? normCdf(d1) : normCdf(d1) - 1 };
}
// 用報價反推隱含波動率，再算 delta（每股選擇權價格對標的價格的敏感度）
function optDelta(sym, mark, S) {
  const o = occ(sym);
  if (!o || !(mark > 0) || !(S > 0)) return null;
  const T = Math.max((new Date(o.exp + 'T20:00:00Z') - Date.now()) / (365 * 864e5), 1 / (365 * 24));
  const irx = bench?.['^IRX'] && !bench['^IRX'].error ? lastOnOrBefore(bench['^IRX'], today()) : null;
  const r = (irx ?? 4) / 100;
  let lo = 0.01, hi = 5;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (bsModel(S, o.strike, T, r, mid, o.call).price > mark) hi = mid; else lo = mid; }
  return bsModel(S, o.strike, T, r, (lo + hi) / 2, o.call).delta;
}

// 選擇權代號（OCC 格式，如 GGLL261016P00085000）→「PUT GGLL 10/16/26 @85」
function optName(sym, fallback = '') {
  const m = String(sym).match(/^([A-Z.]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return fallback || sym;
  return `${m[5] === 'C' ? 'CALL' : 'PUT'} ${m[1]} ${m[3]}/${m[4]}/${m[2]} @${+m[6] / 1000}`;
}

const TX_LABEL = { buy: '買進', sell: '賣出', income: '收入', expense: '支出', fx: '換匯', adjust: '調整持股', cashAdjust: '調整現金', option: '選擇權', expire: '到期' };
function renderTx() {
  if (!has('#txBody')) return;   // 只有交易紀錄頁才有
  const st = realizedStats();
  // 期間選擇器：有紀錄的年份、月份才能選
  const ym = new Set(data.transactions.map(t => t.date.slice(0, 7)));
  const years = [...new Set([...ym].map(k => k.slice(0, 4)))].sort().reverse();
  if (txYear !== 'all' && !years.includes(txYear)) { txYear = 'all'; txMonths = new Set(); }
  const value = { y: txYear, months: txMonths };
  if (txPicker) txPicker.update(value);
  else txPicker = UI.periodPicker($('#txPicker'), { years: () => years, hasMonth: (y, m) => ym.has(`${y}-${m}`), value,
    onChange: v => { txYear = v.y; txMonths = v.months; txLimit = 30; syncTxUrl(); renderTx(); } });
  renderPnl(yearView(st, txYear, txMonths));
  renderTxPeriod();
  let list = [...data.transactions, ...st.expiries].sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts);
  if (txYear !== 'all') list = list.filter(t => t.date.startsWith(txYear) && (!txMonths.size || txMonths.has(t.date.slice(5, 7))));
  if (txSearch) {
    // 代號搜尋：股票、選擇權（含標的）、股息都比對
    const hit = t => [t.symbol, t.symbol && occ(t.symbol)?.root, t.category].some(v => v && String(v).toUpperCase().includes(txSearch));
    list = list.filter(hit);
  }
  const sg = txSearch && (window.symGroup?.(txSearch) || { g: txSearch, name: txSearch });
  $('#txSymLink').innerHTML = txSearch && list.length ? `<a class="card-link" href="/symbol?s=${encodeURIComponent(sg.g)}">看 ${esc(sg.name)} 的完整分析 →</a>` : '';
  $('#txCount').textContent = txSearch || txYear !== 'all' ? `${list.length} 筆` : '';
  if (txFilter === 'trade') list = list.filter(t => ['buy', 'sell', 'adjust'].includes(t.type));
  if (txFilter === 'option') list = list.filter(t => t.type === 'option' || t.type === 'expire');
  if (txFilter === 'cash') list = list.filter(t => ['income', 'expense'].includes(t.type));
  const shown = list.slice(0, txLimit);
  $('#moreTx').hidden = list.length <= txLimit;
  $('#txBody').innerHTML = shown.length ? shown.map(t => {
    let content = '', amount = '';
    switch (t.type) {
      case 'buy': content = t.split ? `<b>${esc(t.symbol)}</b> 股票分割，多 ${fmtShares(t.shares)} 股` : `<b>${esc(t.symbol)}</b> ${fmtShares(t.shares)} 股 @ <span class="money">${fmt(t.price)}</span>`; amount = t.fromCash ? `<span class="muted">${fmt(-t.total, 'USD')}</span>` : `<span class="muted">${fmt(t.total)}</span>`; break;
      case 'sell': { const r = st.perSell[t.id]; content = `<b>${esc(t.symbol)}</b> ${fmtShares(t.shares)} 股 @ <span class="money">${fmt(t.price)}</span>`; amount = fmt(t.total, 'USD', { sign: true }) + (r != null ? `<br><span class="rz ${cls(r)}">已實現 ${fmt(r, 'USD', { sign: true })}</span>` : ''); break; }
      case 'income': content = (t.category === '帳外獲利' ? '帳外獲利 <span class="card-note">（計入獲利，不算入金）</span>' : esc(t.category || '收入'))
          + (/^(入金|帳外獲利)/.test(t.category || '')
          ? ` <button class="ghost" style="font-size:11px;padding:1px 6px;color:var(--text-3)" data-reclass="${t.id}" title="${t.category === '帳外獲利' ? '改回入金：這筆是自己存進來的錢' : '如果這筆其實是在別處投資賺到、轉進來的錢，按這裡把它算成獲利'}">${t.category === '帳外獲利' ? '↺ 改回入金' : '↺ 改成帳外獲利'}</button>` : ''); amount = `<span class="up">${fmt(t.amount, t.currency, { sign: true })}</span>`; break;
      case 'expense': content = esc(t.category || '支出'); amount = `<span class="down">${fmt(-t.amount, t.currency, { sign: true })}</span>`; break;
      case 'fx': content = `${fmt(t.fromAmount, t.from)} → ${fmt(t.toAmount, t.to)}`; amount = `<span class="muted">匯率 ${(t.from === 'TWD' ? t.fromAmount / t.toAmount : t.toAmount / t.fromAmount).toFixed(3)}</span>`; break;
      case 'adjust': content = `<b>${esc(t.symbol)}</b> ${fmtShares(t.before.shares)} → ${fmtShares(t.after.shares)} 股，成本 <span class="money">${fmt(t.before.cost)} → ${fmt(t.after.cost)}</span>`; break;
      case 'option': {
        const r = st.perOpt[t.id];
        content = esc([t.action ? t.action.toUpperCase() : '', t.qty > 0 ? 'BUY' : t.qty < 0 ? 'SELL' : '', optName(t.symbol, t.desc)].filter(Boolean).join(' '));
        amount = fmt(t.amount, 'USD', { sign: true }) + (t.id in st.perOpt
          ? (r == null ? '<br><span class="rz muted">缺開倉成本</span>' : `<br><span class="rz ${cls(r)}">已實現 ${fmt(r, 'USD', { sign: true })}</span>`)
          : '');
        break;
      }
      case 'expire':
        content = esc(`EXPIRE ${optName(t.symbol, t.desc)}`) + ` <span class="muted">${fmtShares(Math.abs(t.qty))} 口</span>`;
        amount = `<span class="muted">$0.00</span><br><span class="rz ${cls(t.realized)}">已實現 ${fmt(t.realized, 'USD', { sign: true })}</span>`;
        break;
      case 'cashAdjust': content = `${t.currency} 現金 <span class="money">${fmt(t.before, t.currency)} → ${fmt(t.after, t.currency)}</span>`; break;
    }
    return `<tr>
      <td class="num">${t.date}</td>
      <td class="l"><span class="badge">${TX_LABEL[t.type] || t.type}</span></td>
      <td class="l">${content}</td>
      <td class="num">${amount}</td>
      <td class="muted" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${esc(t.note || '')}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="5" class="empty">尚無紀錄</td></tr>`;
}

// 平靜模式（analytics.js）開著、而且沒有按「看一下」時，不要在提示框裡露出金額
const hideAmounts = () => document.documentElement.classList.contains('calm') && !document.documentElement.classList.contains('peek');

// ============ Chart ============
function renderChart() {
  const box = $('#chartBox');
  if (!box.clientWidth) return;   // 在別的分頁時不畫
  const cur = data.settings.displayCurrency;
  $('#chartCurLabel').textContent = '(' + cur + ')';
  const pts = inRange(data.history, chartRange).map(h => ({ date: h.date, v: cur === 'TWD' ? h.twd : h.usd }));
  if (pts.length < 2) {
    box.innerHTML = `<div class="empty" style="padding-top:80px">資料累積兩天以上就會出現走勢圖（目前 ${pts.length} 筆）</div>`;
    return;
  }
  const W = box.clientWidth, H = box.clientHeight, padL = 64, padR = 12, padT = 10, padB = 24;
  const vals = pts.map(p => p.v);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) { min *= 0.98; max *= 1.02; }
  const pad = (max - min) * 0.1; min -= pad; max += pad;
  const t0 = +new Date(pts[0].date), t1 = +new Date(pts[pts.length - 1].date);
  const x = d => padL + (+new Date(d) - t0) / (t1 - t0) * (W - padL - padR);
  const y = v => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + x(p.date).toFixed(1) + ',' + y(p.v).toFixed(1)).join('');
  const area = line + `L${x(pts[pts.length - 1].date).toFixed(1)},${H - padB}L${padL},${H - padB}Z`;
  const ticks = [0, 0.5, 1].map(f => min + (max - min) * f);
  const compact = v => cur === 'TWD'
    ? (v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : (v / 1e3).toFixed(0) + 'K')
    : (v >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : '$' + (v / 1e3).toFixed(1) + 'K');
  // 入金、出金、帳外獲利：標在線上（落在非交易日的，標在下一個有資料的日子）
  const events = {};
  for (const t of data.transactions) {
    if ((t.type !== 'income' && t.type !== 'expense') || !/^(入金|出金|帳外獲利)/.test(t.category || '')) continue;
    if (t.date < pts[0].date || t.date > pts.at(-1).date) continue;
    const at = pts.find(p => p.date >= t.date)?.date;
    if (at) (events[at] ??= []).push(`${t.category} ${fmt(t.type === 'income' ? t.amount : -t.amount, t.currency, { sign: true })}`);
  }
  const marks = pts.filter(p => events[p.date]);
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="總資產走勢">
    <defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
    </linearGradient></defs>
    ${ticks.map(t => `<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" stroke="var(--border)" stroke-dasharray="2 4"/>
      <text class="axis-text" x="${padL - 8}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`).join('')}
    <text class="axis-text" x="${padL}" y="${H - 4}">${pts[0].date}</text>
    <text class="axis-text" x="${W - padR}" y="${H - 4}" text-anchor="end">${pts[pts.length - 1].date}</text>
    <path d="${area}" fill="url(#g)"/>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${marks.map(p => `<circle cx="${x(p.date)}" cy="${y(p.v)}" r="4" fill="var(--surface)" stroke="var(--text-2)" stroke-width="1.5"><title>${p.date} ${hideAmounts() ? '有入金或帳外獲利' : events[p.date].join('、')}</title></circle>`).join('')}
    <line id="cx" y1="${padT}" y2="${H - padB}" stroke="var(--text-3)" stroke-width="1" visibility="hidden"/>
    <circle id="cd" r="4.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>
    <rect x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent" id="hit"/>
  </svg><div class="chart-tip" id="tip" hidden></div>`;
  const hit = box.querySelector('#hit'), cx = box.querySelector('#cx'), cd = box.querySelector('#cd'), tip = box.querySelector('#tip');
  const move = e => {
    const mx = e.clientX - box.getBoundingClientRect().left;
    let best = pts[0];
    for (const p of pts) if (Math.abs(x(p.date) - mx) < Math.abs(x(best.date) - mx)) best = p;
    const px = x(best.date), py = y(best.v);
    cx.setAttribute('x1', px); cx.setAttribute('x2', px); cx.setAttribute('visibility', 'visible');
    cd.setAttribute('cx', px); cd.setAttribute('cy', py); cd.setAttribute('visibility', 'visible');
    tip.hidden = false; tip.style.left = Math.min(Math.max(px, 70), W - 70) + 'px'; tip.style.top = py + 'px';
    tip.innerHTML = `${best.date}　<b>${fmt(best.v, cur)}</b>` + (events[best.date] ? `<div style="margin-top:3px">◦ ${events[best.date].join('<br>◦ ')}</div>` : '');
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerleave', () => { cx.setAttribute('visibility', 'hidden'); cd.setAttribute('visibility', 'hidden'); tip.hidden = true; });
}

// ============ 槓桿率走勢 ============
function renderLev() {
  const box = $('#levBox'), stats = $('#levStats');
  if (!box.clientWidth) return;   // 在別的分頁時不畫
  const pts = inRange(data.history, levRange).filter(h => h.exp != null && h.usd > 0)
    .map(h => ({ date: h.date, v: h.exp / h.usd, exp: h.exp, usd: h.usd }));
  if (pts.length < 2) {
    stats.innerHTML = '';
    box.innerHTML = `<div class="empty" style="padding-top:80px">資料累積兩天以上就會出現槓桿率走勢</div>`;
    return;
  }
  const cur = pts.at(-1), peak = pts.reduce((a, b) => (b.v > a.v ? b : a)), low = pts.reduce((a, b) => (b.v < a.v ? b : a));
  const avg = pts.reduce((a, p) => a + p.v, 0) / pts.length;
  stats.innerHTML = [['目前', cur.v], ['期間平均', avg], [`最高（${peak.date}）`, peak.v], [`最低（${low.date}）`, low.v]]
    .map(([k, v]) => `<span class="legend-item">${k} <b class="num">${v.toFixed(2)}x</b></span>`).join('');

  const W = box.clientWidth, H = box.clientHeight, padL = 52, padR = 12, padT = 10, padB = 24;
  let min = Math.min(1, ...pts.map(p => p.v)), max = Math.max(1, ...pts.map(p => p.v));
  const pad = (max - min) * 0.08 || 0.1; min = Math.max(0, min - pad); max += pad;
  const raw = (max - min) / 4, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(v => v >= raw);
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) ticks.push(t);
  const t0 = +new Date(pts[0].date), t1 = +new Date(cur.date);
  const x = d => padL + (+new Date(d) - t0) / (t1 - t0) * (W - padL - padR);
  const y = v => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + x(p.date).toFixed(1) + ',' + y(p.v).toFixed(1)).join('');
  const area = line + `L${x(cur.date).toFixed(1)},${H - padB}L${padL},${H - padB}Z`;
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="槓桿率走勢">
    <defs><linearGradient id="lg" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="var(--accent)" stop-opacity=".18"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
    </linearGradient></defs>
    ${ticks.map(t => `<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" stroke="var(--border)" stroke-dasharray="2 4"/>
      <text class="axis-text" x="${padL - 8}" y="${y(t) + 4}" text-anchor="end">${+t.toFixed(2)}x</text>`).join('')}
    <line x1="${padL}" x2="${W - padR}" y1="${y(1)}" y2="${y(1)}" stroke="var(--text-3)" stroke-width="1"/>
    <text class="axis-text" x="${padL + 6}" y="${y(1) - 5}">1x 無槓桿</text>
    <text class="axis-text" x="${padL}" y="${H - 4}">${pts[0].date}</text>
    <text class="axis-text" x="${W - padR}" y="${H - 4}" text-anchor="end">${cur.date}</text>
    <path d="${area}" fill="url(#lg)"/>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <line id="lcx" y1="${padT}" y2="${H - padB}" stroke="var(--text-3)" stroke-width="1" visibility="hidden"/>
    <circle id="lcd" r="4.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>
    <rect x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent" id="lhit"/>
  </svg><div class="chart-tip" id="ltip" hidden></div>`;
  const hit = box.querySelector('#lhit'), cx = box.querySelector('#lcx'), cd = box.querySelector('#lcd'), tip = box.querySelector('#ltip');
  hit.addEventListener('pointermove', e => {
    const mx = e.clientX - box.getBoundingClientRect().left;
    let best = pts[0];
    for (const p of pts) if (Math.abs(x(p.date) - mx) < Math.abs(x(best.date) - mx)) best = p;
    const px = x(best.date), py = y(best.v);
    cx.setAttribute('x1', px); cx.setAttribute('x2', px); cx.setAttribute('visibility', 'visible');
    cd.setAttribute('cx', px); cd.setAttribute('cy', py); cd.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.style.top = padT + 'px'; tip.style.left = px + 'px';
    tip.style.transform = px > W / 2 ? 'translate(calc(-100% - 10px), 0)' : 'translate(10px, 0)';
    tip.innerHTML = `<div style="margin-bottom:4px">${best.date}</div>
      <div class="row"><span>槓桿率</span><b>${best.v.toFixed(2)}x</b></div>
      <div class="row"><span>曝險</span><b>${fmt(best.exp, 'USD', { digits: 0 })}</b></div>
      <div class="row"><span>淨資產</span><b>${fmt(best.usd, 'USD', { digits: 0 })}</b></div>`;
  });
  hit.addEventListener('pointerleave', () => { cx.setAttribute('visibility', 'hidden'); cd.setAttribute('visibility', 'hidden'); tip.hidden = true; });
}

// ============ 報酬率比較 ============
const BENCH = [
  { key: 'me', name: '我的組合', short: '我的組合', color: 'var(--s1)' },
  { key: 'VOO', name: 'S&P 500 (VOO)', short: 'S&P 500', color: 'var(--s2)' },
  { key: 'QQQ', name: 'Nasdaq 100 (QQQ)', short: 'Nasdaq 100', color: 'var(--s3)' },
  { key: '^IRX', name: '短期美債（13 週國庫券）', short: '短期美債', color: 'var(--s4)', dash: true },
];
async function loadBench() {
  if (!data.history.length) return;
  try {
    const r = await fetch(`/api/history?symbols=VOO,QQQ,${encodeURIComponent('^IRX')}&from=${data.history[0].date}`);
    bench = await r.json();
  } catch { bench = null; }
  renderCompare();
  if (has('#txPeriod')) renderTxPeriod();   // 期間績效要用到指數的歷史價
  if (typeof renderExtras === 'function') renderExtras();
}
function lastOnOrBefore(series, d) {
  let bd = '', v = null;
  for (const k in series) if (k <= d && k > bd) { bd = k; v = series[k]; }
  return v;
}
function externalFlows() {
  const fxOn = d => (data.history.find(h => h.date >= d) || {}).fx || fx;
  const out = [];
  for (const t of data.transactions) {
    if (t.initial) continue;
    let amt;
    if (t.type === 'income' || t.type === 'expense') {
      if (/股息|利息|退稅|帳外獲利/.test(t.category || '')) continue;
      amt = t.type === 'income' ? t.amount : -t.amount;
    } else continue;
    out.push({ date: t.date, usd: t.currency === 'USD' ? amt : amt / fxOn(t.date) });
  }
  return out;
}
function compareSeries() {
  const hist = inRange(data.history, cmpRange);
  if (hist.length < 2) return null;
  const flows = externalFlows();
  // 時間加權報酬：每一段把當期的外部資金進出扣掉再連乘
  let idx = 1;
  const me = [{ date: hist[0].date, v: 0 }];
  for (let i = 1; i < hist.length; i++) {
    const a = hist[i - 1], b = hist[i];
    const f = flows.filter(x => x.date > a.date && x.date <= b.date).reduce((s, x) => s + x.usd, 0);
    if (a.usd > 0) idx *= (b.usd - f) / a.usd;
    me.push({ date: b.date, v: idx - 1 });
  }
  const series = [{ ...BENCH[0], pts: me }];
  if (!bench) return series;
  for (const b of BENCH.slice(1, 3)) {
    const s = bench[b.key];
    if (!s || s.error) continue;
    const p0 = lastOnOrBefore(s, hist[0].date);
    if (!p0) continue;
    series.push({ ...b, pts: hist.map(h => ({ date: h.date, v: lastOnOrBefore(s, h.date) / p0 - 1 })) });
  }
  const irx = bench['^IRX'];
  if (irx && !irx.error) {
    // ^IRX 是年化殖利率（%），按持有天數複利累積
    let g = 1;
    const pts = [{ date: hist[0].date, v: 0 }];
    for (let i = 1; i < hist.length; i++) {
      const y = lastOnOrBefore(irx, hist[i - 1].date) ?? lastOnOrBefore(irx, hist[i].date) ?? 0;
      const days = (new Date(hist[i].date) - new Date(hist[i - 1].date)) / 864e5;
      g *= (1 + y / 100) ** (days / 365);
      pts.push({ date: hist[i].date, v: g - 1 });
    }
    series.push({ ...BENCH[3], pts });
  }
  return series;
}
function renderCompare() {
  const box = $('#cmpBox'), leg = $('#cmpLegend'), note = $('#cmpNote');
  if (!box.clientWidth) return;   // 在別的分頁時不畫
  const series = compareSeries();
  if (!series) {
    leg.innerHTML = ''; note.textContent = '';
    box.innerHTML = `<div class="empty" style="padding-top:80px">資料累積兩天以上就會出現比較圖</div>`;
    return;
  }
  const last = s => s.pts[s.pts.length - 1].v;
  leg.innerHTML = series.map(s => `<span class="legend-item"><span class="swatch ${s.dash ? 'dash' : ''}" style="border-color:${s.color}"></span>${esc(s.name)} <b class="num">${fmtPct(last(s))}</b></span>`).join('');
  const me = last(series[0]), spx = series.find(s => s.key === 'VOO'), rf = series.find(s => s.key === '^IRX');
  note.innerHTML = [
    spx && `相對 S&P 500：<b class="${cls(me - last(spx))}">${fmtPct(me - last(spx))}</b>`,
    rf && `相對無風險利率：<b class="${cls(me - last(rf))}">${fmtPct(me - last(rf))}</b>`,
    !bench && '大盤資料載入中…',
  ].filter(Boolean).join('　·　') + '<br>入金、出金與生活支出不算進報酬；期間 ' + series[0].pts[0].date + ' ～ ' + series[0].pts.at(-1).date;

  const W = box.clientWidth, H = box.clientHeight, padL = 52, padR = 84, padT = 10, padB = 24;
  const dates = series[0].pts.map(p => p.date);
  const all = series.flatMap(s => s.pts.map(p => p.v));
  let min = Math.min(0, ...all), max = Math.max(0, ...all);
  const pad = (max - min) * 0.08 || 0.01; min -= pad; max += pad;
  const t0 = +new Date(dates[0]), t1 = +new Date(dates.at(-1));
  const x = d => padL + (+new Date(d) - t0) / (t1 - t0) * (W - padL - padR);
  const y = v => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  // 整齊的刻度間距：1 / 2 / 2.5 / 5 × 10^n
  const raw = (max - min) / 4, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(v => v >= raw);
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-12; t += step) if (Math.abs(t) > step / 2) ticks.push(t);
  const pctLabel = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(step * 100 >= 1 ? 0 : 1) + '%';
  // 線尾標籤：依高度排序後推開，避免重疊
  const ends = series.map(s => ({ s, y: y(last(s)) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 14);
  const overflow = ends.length ? ends.at(-1).y - (H - padB) : 0;
  if (overflow > 0) ends.forEach(e => e.y -= overflow);
  const xEnd = x(dates.at(-1));
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="報酬率比較">
    ${ticks.map(t => `<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" stroke="var(--border)" stroke-dasharray="2 4"/>
      <text class="axis-text" x="${padL - 8}" y="${y(t) + 4}" text-anchor="end">${pctLabel(t)}</text>`).join('')}
    <line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" stroke="var(--text-3)" stroke-width="1"/>
    <text class="axis-text" x="${padL - 8}" y="${y(0) + 4}" text-anchor="end">0%</text>
    <text class="axis-text" x="${padL}" y="${H - 4}">${dates[0]}</text>
    <text class="axis-text" x="${xEnd}" y="${H - 4}" text-anchor="end">${dates.at(-1)}</text>
    ${series.slice().reverse().map(s => `<path d="${s.pts.map((p, i) => (i ? 'L' : 'M') + x(p.date).toFixed(1) + ',' + y(p.v).toFixed(1)).join('')}"
      fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" ${s.dash ? 'stroke-dasharray="5 4"' : ''}/>`).join('')}
    ${ends.map(e => `<circle cx="${xEnd}" cy="${y(last(e.s))}" r="3" fill="${e.s.color}"/>
      <text class="end-label" x="${xEnd + 8}" y="${e.y + 4}">${e.s.short}</text>`).join('')}
    <line id="ccx" y1="${padT}" y2="${H - padB}" stroke="var(--text-3)" stroke-width="1" visibility="hidden"/>
    <g id="cdots"></g>
    <rect x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent" id="chit"/>
  </svg><div class="chart-tip" id="ctip" hidden></div>`;
  const hit = box.querySelector('#chit'), cx = box.querySelector('#ccx'), dots = box.querySelector('#cdots'), tip = box.querySelector('#ctip');
  hit.addEventListener('pointermove', e => {
    const mx = e.clientX - box.getBoundingClientRect().left;
    let bi = 0;
    dates.forEach((d, i) => { if (Math.abs(x(d) - mx) < Math.abs(x(dates[bi]) - mx)) bi = i; });
    const px = x(dates[bi]);
    cx.setAttribute('x1', px); cx.setAttribute('x2', px); cx.setAttribute('visibility', 'visible');
    dots.innerHTML = series.map(s => `<circle cx="${px}" cy="${y(s.pts[bi].v)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`).join('');
    tip.hidden = false;
    tip.style.top = padT + 'px';
    tip.style.left = px + 'px';
    tip.style.transform = px > W / 2 ? 'translate(calc(-100% - 10px), 0)' : 'translate(10px, 0)';
    tip.innerHTML = `<div style="margin-bottom:4px">${dates[bi]}</div>` +
      series.map(s => `<div class="row"><span>${s.short}</span><b>${fmtPct(s.pts[bi].v)}</b></div>`).join('');
  });
  hit.addEventListener('pointerleave', () => { cx.setAttribute('visibility', 'hidden'); dots.innerHTML = ''; tip.hidden = true; });
}

// ============ 券商檔案匯入 ============
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  const endRow = () => { row.push(cell); cell = ''; if (row.some(c => c.trim() !== '')) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; endRow(); }
    else cell += c;
  }
  endRow();
  return rows;
}
async function readTables(file) {
  if (/\.xlsx$/i.test(file.name)) {
    const r = await fetch('/api/parse-xlsx', { method: 'POST', body: await file.arrayBuffer() });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '無法讀取 xlsx');
    return Object.values(j.sheets).map(rows => ({ rows }));
  }
  const buf = await file.arrayBuffer();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('big5').decode(buf); }
  return [{ rows: parseCSV(text) }];
}
const pnum = v => { if (typeof v === 'number') return v; const n = parseFloat(String(v ?? '').replace(/[,$\s]/g, '')); return isNaN(n) ? 0 : n; };
// 依表頭判斷是「交易紀錄」還是「持倉」
function classify(table) {
  const hi = table.rows.findIndex(r => r.some(c => String(c).trim() === '代號'));
  if (hi < 0) return null;
  const head = table.rows[hi].map(c => String(c).trim()), col = n => head.indexOf(n);
  const body = table.rows.slice(hi + 1);
  if (col('交易類別') >= 0) {
    return { kind: 'trades', rows: body.map(r => {
      const [y, m, d] = String(r[col('日期')] ?? '').trim().split(/[\/\-]/);
      if (!d) return null;
      return { date: `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`, kind: String(r[col('交易類別')]).trim(),
               qty: pnum(r[col('數量')]), desc: String(r[col('說明')] ?? '').trim(), sym: String(r[col('代號')] ?? '').trim().toUpperCase(),
               price: pnum(r[col('價格')]), amt: pnum(r[col('金額')]) };
    }).filter(Boolean) };
  }
  if (col('數量') >= 0 && col('成本') >= 0) {
    return { kind: 'positions', rows: body.map(r => ({ sym: String(r[col('代號')] ?? '').trim().toUpperCase(), qty: pnum(r[col('數量')]), cost: pnum(r[col('成本')]) }))
      .filter(r => r.sym && r.qty && !OPT_RE.test(r.sym)) };
  }
  return null;
}
const shortDesc = d => d.replace(/\s+(UNSOLICITED|S\/D:|EXEC TIME).*$/, '').replace(/^\*+/, '');

function buildImport(trades, positions) {
  const sync = data.settings.syncDate || '';
  const plan = { txs: [], adjusts: [], dup: 0, manual: [], replaced: [], skipped: [], ignored: 0, live: 0, logOnly: 0, opt: 0, deposits: 0, cash: 0, sync };
  // 同一天可能有完全相同的兩筆交易，用出現次數區分
  const seen = {};
  trades.forEach((r, i) => { const b = [r.date, r.kind, r.sym, r.qty, r.price, r.amt].join('|'); seen[b] = (seen[b] || 0) + 1; r.key = b + '#' + seen[b]; r.i = i; });
  // 券商會改寫最近幾天的紀錄（改交易類別、改日期、把多筆成交合併成一筆），所以在檔案涵蓋的日期內以新檔案為準：
  // 舊紀錄在新檔案找不到一模一樣的，就換成新檔案的版本。最早那天不算，因為匯出有筆數上限，那天可能只匯出一部分
  if (trades.length) {
    const dates = trades.map(r => r.date).sort(), minD = dates[0], maxD = dates.at(-1);
    const newKeys = new Set(trades.map(r => r.key));
    plan.replaced = data.transactions.filter(t => t.imported && t.key && t.date > minD && t.date <= maxD && !newKeys.has(t.key));
    plan.window = [minD, maxD];
  }
  const existing = new Set(data.transactions.filter(t => !plan.replaced.includes(t)).map(t => t.key).filter(Boolean));
  const fresh = trades.filter(r => { if (existing.has(r.key)) { plan.dup++; return false; } return true; });

  // 先找出手動記過的同一筆交易（同代號、同方向、同股數、日期差 3 天內）：改用券商的精確數字取代
  // 帳戶類別之間的移轉（現金帳戶 ↔ 融資帳戶，例如 TFR TO TYPE 1、TFR CASH TO MARGIN）每檔一進一出、金額 0，不是買賣
  const isXfer = r => r.kind === '其他' && /\bTFR\b/i.test(r.desc) && !r.amt;
  const isStock = r => (/^(買進|賣出)/.test(r.kind) || r.kind === '其他') && r.sym && r.qty && !OPT_RE.test(r.sym) && !isXfer(r);
  const manual = data.transactions.filter(t => !t.key && !t.imported && (t.type === 'buy' || t.type === 'sell'));
  const matchOf = new Map();
  for (const r of fresh.filter(isStock)) {
    const type = r.qty > 0 ? 'buy' : 'sell', shares = Math.abs(r.qty);
    const cands = manual.filter(t => ![...matchOf.values()].includes(t) && t.type === type && t.symbol === r.sym &&
      Math.abs(t.shares - shares) < 1e-6 && Math.abs(new Date(t.date) - new Date(r.date)) <= 3 * 864e5);
    cands.sort((a, b) => Math.abs(new Date(a.date) - new Date(r.date)) - Math.abs(new Date(b.date) - new Date(r.date)));
    if (cands[0]) { matchOf.set(r.key, cands[0]); plan.manual.push(cands[0]); }
  }
  // 模擬持股：先把被取代的紀錄（手動輸入的、券商改寫過的）還原
  const sim = JSON.parse(JSON.stringify(data.holdings));
  for (const m of [...plan.manual, ...plan.replaced]) {
    const e = m.effects?.holding;
    if (!e) continue;
    const h = sim[e.symbol] ??= { shares: 0, cost: 0 };
    h.shares = round(h.shares - e.shares); h.cost = round(h.cost - e.cost, 4);
    if (h.shares <= 1e-9) delete sim[e.symbol];
  }

  const ordered = [...fresh].sort((a, b) => a.date.localeCompare(b.date) || (b.qty > 0) - (a.qty > 0) || a.i - b.i);
  for (const r of ordered) {
    // 持倉同步日之後的交易才更新持股與現金；之前的只記錄（持股已包含），但被取代的手動紀錄一定要重新套用
    if (isXfer(r)) { plan.ignored++; continue; }
    const live = r.date > sync || matchOf.has(r.key);
    const isOpt = OPT_RE.test(r.sym);
    const base = { date: r.date, imported: true, key: r.key, note: '券商匯入' };
    let tx, eff = {};
    if (isStock(r)) {
      const type = r.qty > 0 ? 'buy' : 'sell', shares = Math.abs(r.qty);
      if (type === 'buy') {
        const total = round(-r.amt, 4);
        const split = /STK SPLIT/i.test(r.desc) && !total;   // 分割多出來的股數，成本 0
        tx = { type, symbol: r.sym, shares, price: r.price || round(total / shares, 4), fee: r.price ? round(total - shares * r.price, 4) : 0, total, fromCash: true, ...base,
               note: split ? '股票分割' : r.kind === '其他' ? '股息再投入' : base.note, ...(split ? { split: true } : {}) };
        if (live) {
          eff = { holding: { symbol: r.sym, shares, cost: total }, cash: { USD: r.amt } };
          const h = sim[r.sym] ??= { shares: 0, cost: 0 }; h.shares = round(h.shares + shares); h.cost = round(h.cost + total, 4);
        }
      } else {
        const total = round(r.amt, 4);
        tx = { type, symbol: r.sym, shares, price: r.price, fee: round(shares * r.price - total, 4), total, toCash: true, ...base };
        if (live) {
          const h = sim[r.sym], held = h?.shares || 0, q = Math.min(shares, held);
          const costOut = q <= 0 ? 0 : q >= held - 1e-9 ? h.cost : round(h.cost / held * q, 4);
          if (q < shares - 1e-9) plan.skipped.push(`${r.date} ${r.sym} 賣出 ${fmtShares(shares)} 股，但只持有 ${fmtShares(held)} 股`);
          else tx.realized = round(total - costOut, 4);
          eff = { cash: { USD: r.amt } };
          if (q > 0) {
            eff.holding = { symbol: r.sym, shares: -q, cost: -costOut };
            h.shares = round(h.shares - q); h.cost = round(h.cost - costOut, 4);
            if (h.shares <= 1e-9) delete sim[r.sym];
          }
        }
      }
    } else if (isOpt && (r.amt || /EXPIR/.test(r.desc))) {
      // 選擇權不追蹤部位，但權利金進出要算進現金（也用於重建歷史）
      tx = { type: 'option', symbol: r.sym, qty: r.qty, desc: shortDesc(r.desc), amount: r.amt, ...base,
             action: /CLOSING|EXPIR/.test(r.desc) || /平倉/.test(r.kind) ? 'close' : /OPEN/.test(r.desc) || /開倉/.test(r.kind) ? 'open' : null };
      if (live && r.amt) eff = { cash: { USD: r.amt } };
      plan.opt++;
    } else if (/存款|入金|匯入/.test(r.kind) && r.amt) {
      tx = { type: r.amt > 0 ? 'income' : 'expense', amount: Math.abs(r.amt), currency: 'USD', category: r.amt > 0 ? '入金' : '出金', ...base };
      if (live) eff = { cash: { USD: r.amt } };
      plan.deposits++;
    } else if (/提款|出金|匯出/.test(r.kind) && r.amt) {
      tx = { type: 'expense', amount: Math.abs(r.amt), currency: 'USD', category: '出金', ...base };
      if (live) eff = { cash: { USD: -Math.abs(r.amt) } };
      plan.deposits++;
    } else if (r.kind === '股息' && r.amt) {
      tx = { type: 'income', amount: r.amt, currency: 'USD', category: `股息 ${r.sym}`.trim(), ...base, note: '券商匯入（已扣稅）' };
      if (live) eff = { cash: { USD: r.amt } };
    } else if (/利息/.test(r.kind) && r.amt) {
      tx = { type: r.amt > 0 ? 'income' : 'expense', amount: Math.abs(r.amt), currency: 'USD', category: r.amt > 0 ? '利息' : '利息支出', ...base };
      if (live) eff = { cash: { USD: r.amt } };
    } else if (r.kind === '其他' && r.sym && r.amt) {
      // 例如預扣稅退回
      tx = { type: r.amt > 0 ? 'income' : 'expense', amount: Math.abs(r.amt), currency: 'USD', category: `退稅 ${r.sym}`, ...base, note: shortDesc(r.desc).slice(0, 40) };
      if (live) eff = { cash: { USD: r.amt } };
    } else {
      if (r.kind === '其他' && !r.sym) { plan.ignored++; continue; }   // 帳戶間轉帳，進出互相抵銷
      if (r.amt || r.qty) plan.skipped.push(`${r.date} ${r.kind}：${shortDesc(r.desc).slice(0, 40)}`);
      continue;
    }
    tx.effects = eff;
    plan.txs.push(tx);
    live ? plan.live++ : plan.logOnly++;
    plan.cash += eff.cash?.USD || 0;
  }
  for (const m of [...plan.manual, ...plan.replaced]) for (const [c, v] of Object.entries(m.effects?.cash || {})) if (c === 'USD') plan.cash -= v;
  // 持倉檔 = 最新狀態：把（套用交易後的）持股校正成檔案上的股數與成本
  if (positions) {
    const target = {};
    for (const p of positions) { const t = target[p.sym] ??= { shares: 0, cost: 0 }; t.shares = round(t.shares + p.qty); t.cost = round(t.cost + p.cost, 4); }
    for (const sym of new Set([...Object.keys(sim), ...Object.keys(target)])) {
      const before = sim[sym] ? { shares: sim[sym].shares, cost: sim[sym].cost } : { shares: 0, cost: 0 };
      const after = target[sym] || { shares: 0, cost: 0 };
      if (Math.abs(before.shares - after.shares) < 1e-6 && Math.abs(before.cost - after.cost) < 0.01) continue;
      plan.adjusts.push({ type: 'adjust', date: today(), symbol: sym, before, after, note: '券商持倉校正',
        effects: { holding: { symbol: sym, shares: round(after.shares - before.shares), cost: round(after.cost - before.cost, 4) } } });
    }
    const lastTrade = trades.map(t => t.date).sort().at(-1);
    const yesterday = new Date(Date.now() - 864e5 - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
    plan.newSync = [sync, lastTrade || yesterday].sort().at(-1);
  }
  plan.hasPositions = !!positions;
  return plan;
}
function applyImport(plan) {
  const importId = uid(), ts = Date.now();
  // 被取代的紀錄（手動輸入的、券商改寫過的）：先還原它的影響再移除（復原時會放回來）
  const removed = [];
  for (const m of [...plan.manual, ...plan.replaced]) {
    applyEffects(m.effects || {}, -1);
    data.transactions = data.transactions.filter(t => t !== m);
    removed.push(m);
  }
  [...plan.txs, ...plan.adjusts].forEach((t, i) => {
    t.id = uid(); t.ts = ts + i; t.importId = importId;
    applyEffects(t.effects);
    data.transactions.push(t);
  });
  data.imports = [...(data.imports || []), { id: importId, date: today(), prevSync: data.settings.syncDate ?? null, removed }];
  if (plan.newSync) data.settings.syncDate = plan.newSync;
  save(); render();
  toast(`已匯入 ${plan.txs.length} 筆紀錄` + (plan.adjusts.length ? `、校正 ${plan.adjusts.length} 檔持股` : '') + '，重新計算走勢中…');
  rebuildHistory();
}
function undoImport() {
  const imp = data.imports?.pop();
  if (!imp) return;
  data.transactions.filter(t => t.importId === imp.id).sort((a, b) => b.ts - a.ts).forEach(t => applyEffects(t.effects, -1));
  data.transactions = data.transactions.filter(t => t.importId !== imp.id);
  for (const m of imp.removed || []) { applyEffects(m.effects || {}, 1); data.transactions.push(m); }
  data.settings.syncDate = imp.prevSync ?? undefined;
  save(); render();
  toast('已復原上次券商匯入，重新計算走勢中…');
  rebuildHistory();
}
async function handleBrokerFiles(files) {
  if (!files.length) return;
  try {
    const tables = (await Promise.all(files.map(readTables))).flat();
    const trades = [];
    let positions = null;
    for (const t of tables) {
      const c = classify(t);
      if (!c) continue;
      if (c.kind === 'trades') trades.push(...c.rows);
      else if (c.rows.length) (positions ??= []).push(...c.rows);
    }
    if (!trades.length && !positions) { toast('看不出檔案格式：需要券商的交易紀錄 CSV 或持倉檔'); return; }
    openForm('brokerImport', buildImport(trades, positions));
  } catch (err) { toast('⚠️ ' + err.message); }
}

// ============ 用交易紀錄重建歷史走勢 ============
// 從「現在的持股與現金」沿著交易紀錄往回推，得到每個交易日收盤後的部位，再乘上當天收盤價與匯率。
// 手動「調整持股／調整現金」視為修正（當作一直都是那樣），不算成當天發生的事件。
function txEvents() {
  const ev = [];
  for (const t of data.transactions) {
    const e = { date: t.date, cash: {} };
    switch (t.type) {
      case 'buy': e.sym = t.symbol; e.qty = t.shares; if (t.fromCash !== false) e.cash.USD = -t.total; break;
      case 'sell': e.sym = t.symbol; e.qty = -t.shares; if (t.toCash !== false) e.cash.USD = t.total; break;
      case 'income': if (t.initial) continue; e.cash[t.currency] = t.amount; break;
      case 'expense': e.cash[t.currency] = -t.amount; break;
      case 'fx': e.cash[t.from] = -t.fromAmount; e.cash[t.to] = t.toAmount; break;
      case 'option': e.opt = t.symbol; e.qty = t.qty ?? 0; e.cash.USD = t.amount; e.close = t.action === 'close'; break;
      default: continue;   // adjust / cashAdjust
    }
    ev.push(e);
  }
  return ev;
}
const optExpiry = s => { const m = s.match(/(\d{2})(\d{2})(\d{2})[CP]\d{8}$/); return m ? `20${m[1]}-${m[2]}-${m[3]}` : null; };

let rebuilding = false;
async function rebuildHistory() {
  if (rebuilding) return;
  rebuilding = true;
  const btn = $('#rebuildBtn');
  if (btn) btn.innerHTML = '<span class="spin">↻</span> 計算中';
  try {
    const ev = txEvents();
    const todayStr = today();
    const past = ev.filter(e => e.date < todayStr);
    if (!past.length) return;
    const start = past.map(e => e.date).sort()[0];
    const stockSyms = [...new Set([...ev.filter(e => e.sym).map(e => e.sym), ...Object.keys(data.holdings)])];

    const optRoots = [...new Set(ev.filter(e => e.opt).map(e => occ(e.opt)?.root).filter(Boolean))];   // 算選擇權 delta 用
    const fetchSyms = [...new Set(['SPY', 'TWD=X', '^IRX', ...stockSyms, ...optRoots])];
    const r = await fetch(`/api/history?symbols=${encodeURIComponent(fetchSyms.join(','))}&from=${start}`);
    const px = await r.json();
    const days = Object.keys(px.SPY && !px.SPY.error ? px.SPY : {}).filter(d => d >= start && d < todayStr).sort();
    if (!days.length) throw new Error('抓不到歷史股價');

    // 1) 往回推：每天收盤後的股數與現金
    const pos = {}; for (const [s, h] of Object.entries(data.holdings)) pos[s] = h.shares;
    const cash = { USD: data.cash.USD || 0 };
    const desc = [...ev].sort((a, b) => b.date.localeCompare(a.date));
    let k = 0;
    const snap = {};
    for (const d of [...days].reverse()) {
      while (k < desc.length && desc[k].date > d) {
        const e = desc[k++];
        if (e.sym) pos[e.sym] = round((pos[e.sym] || 0) - e.qty);
        for (const [c, v] of Object.entries(e.cash)) cash[c] = round((cash[c] || 0) - v, 4);
      }
      snap[d] = { pos: { ...pos }, cash: { ...cash } };
    }
    const init = { ...pos }, cash0 = { ...cash };   // 紀錄開始前的持股與現金
    while (k < desc.length) {
      const e = desc[k++];
      if (e.sym) init[e.sym] = round((init[e.sym] || 0) - e.qty);
      for (const [c, v] of Object.entries(e.cash)) cash0[c] = round((cash0[c] || 0) - v, 4);
    }

    // 2) 選擇權：以成本計價（持有期間不跳動），到期或平倉時才實現損益
    const optEv = {};
    for (const e of ev.filter(e => e.opt)) (optEv[e.opt] ??= []).push(e);
    const optState = {};
    for (const [s, list] of Object.entries(optEv)) {
      list.sort((a, b) => a.date.localeCompare(b.date) || a.close - b.close);   // 同一天先開倉再平倉
      const net = list.reduce((a, e) => a + e.qty, 0), exp = optExpiry(s);
      // 已到期的部位現在一定是 0，期初就有的部位 = −淨交易量；以之後平倉的金額當期初帳面價值
      let q0 = exp && exp < todayStr ? -net : 0, carry0 = 0, rem = q0;
      for (const e of list) {
        if (!rem || Math.sign(e.qty) === Math.sign(rem)) break;
        const used = Math.min(Math.abs(e.qty), Math.abs(rem));
        carry0 += e.cash.USD * used / Math.abs(e.qty || 1);
        rem += Math.sign(e.qty) * used;
      }
      optState[s] = { sym: s, list, i: 0, pos: q0, carry: q0 ? carry0 : 0, exp };
    }
    // 歷史上沒有每天的選擇權報價可反推隱含波動率，改用標的過去 30 個交易日的實際波動率估算 delta
    const volCache = {};
    const histVol = (root, d) => {
      const key = root + d;
      if (key in volCache) return volCache[key];
      const ser = px[root];
      if (!ser || ser.error) return (volCache[key] = null);
      const ds = Object.keys(ser).filter(x => x <= d).sort().slice(-31);
      if (ds.length < 10) return (volCache[key] = null);
      const rets = ds.slice(1).map((x, i) => Math.log(ser[x] / ser[ds[i]]));
      const m = rets.reduce((a, b) => a + b, 0) / rets.length;
      const vr = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
      return (volCache[key] = Math.sqrt(vr * 252));
    };
    const optExposure = (sym, qty, d) => {
      if (qty <= 0) return 0;   // 賣方部位不計入曝險
      const o = occ(sym);
      if (!o) return 0;
      const S = priceOf(o.root, d), vol = histVol(o.root, d);
      // 標的價跟履約價差太多（多半是分割造成價格基準不同）就不估，避免算出離譜的數字
      if (!(S > 0) || !vol || S / o.strike > 3 || S / o.strike < 1 / 3) return 0;
      const T = Math.max((new Date(o.exp) - new Date(d)) / (365 * 864e5), 1 / 365);
      const rate = (px['^IRX'] && !px['^IRX'].error ? lastOnOrBefore(px['^IRX'], d) : null) ?? 4;
      return qty * 100 * bsModel(S, o.strike, T, rate / 100, vol, o.call).delta * S * levOf(o.root);
    };
    let optExpToday = 0;
    const optValue = d => {
      let v = 0;
      optExpToday = 0;
      for (const o of Object.values(optState)) {
        while (o.i < o.list.length && o.list[o.i].date <= d) {
          const e = o.list[o.i++];
          if (!o.pos || Math.sign(o.pos) === Math.sign(e.qty)) o.carry += -e.cash.USD;
          else o.carry -= o.carry * Math.min(1, Math.abs(e.qty) / Math.abs(o.pos));
          o.pos = round(o.pos + e.qty);
          if (!o.pos) o.carry = 0;
        }
        if (o.exp && d > o.exp) { o.pos = 0; o.carry = 0; }
        if (o.pos) { v += o.carry; optExpToday += optExposure(o.sym, o.pos, d); }
      }
      return v;
    };

    // 3) 價格：Yahoo 收盤價；查不到的（下市、改名）用自己的成交價代替
    const tradePx = {};
    for (const t of data.transactions) if ((t.type === 'buy' || t.type === 'sell') && t.price) (tradePx[t.symbol] ??= {})[t.date] = t.price;
    // 分割：Yahoo 的歷史價已按分割調整過。券商紀錄裡有分割那一列的，分割前的日子乘回倍數（分割後股數 ÷ 分割前股數）
    const splitAt = {};
    for (const t of data.transactions.filter(t => t.split)) {
      const prev = days.filter(d => d < t.date).at(-1), before = prev ? snap[prev].pos[t.symbol] : null;
      if (before > 1e-9) (splitAt[t.symbol] ??= []).push({ date: t.date, m: (before + t.shares) / before });
    }
    const splitScale = (s, d) => (splitAt[s] || []).reduce((m, x) => d < x.date ? m * x.m : m, 1);
    // 其他分割校正（券商紀錄裡沒有分割那一列的）：用自己的成交價比對 Yahoo 收盤價算出倍數
    const scale = {};
    for (const [s, tp] of Object.entries(tradePx)) {
      if (!px[s] || px[s].error || splitAt[s]) continue;
      const ratios = Object.entries(tp).map(([d, p]) => { const c = px[s][d]; return c ? p / c : null; }).filter(Boolean).sort((a, b) => a - b);
      if (!ratios.length) continue;
      const med = ratios[Math.floor(ratios.length / 2)];
      if (Math.abs(Math.log(med)) > 0.25) scale[s] = med;
    }
    const priceOf = (s, d) => {
      const c = px[s] && !px[s].error ? lastOnOrBefore(px[s], d) : null;
      if (c != null) return c * (scale[s] || splitScale(s, d));
      const tp = tradePx[s];
      if (!tp) return quotes[s]?.price ?? 0;
      return lastOnOrBefore(tp, d) ?? tp[Object.keys(tp).sort()[0]];
    };
    // 紀錄開始前最後一個交易日（例如 12/31）：期初持股以這天收盤價當成本，也是走勢的起點
    const prevDay = Object.keys(px.SPY).filter(d => d < start).sort().at(-1);
    const baseDate = prevDay || new Date(new Date(start).getTime() - 864e5).toISOString().slice(0, 10);
    data.settings.base = { date: baseDate, prices: Object.fromEntries(
      Object.entries(init).filter(([, q]) => q > 1e-9).map(([sym]) => [sym, round(priceOf(sym, baseDate), 4)])) };
    const fxSeries = px['TWD=X'] && !px['TWD=X'].error ? px['TWD=X'] : {};

    const out = [];
    // 起點：紀錄開始前最後一個交易日的收盤（例如 12/31），「今年」報酬率才會從 1/1 算起
    if (prevDay) {
      const rate0 = lastOnOrBefore(fxSeries, prevDay) || fx;
      let stock0 = 0, exp0 = 0;
      for (const [sym, q] of Object.entries(init)) {
        if (Math.abs(q) < 1e-9) continue;
        const v = q * priceOf(sym, prevDay);
        stock0 += v; exp0 += v * levOf(sym);
      }
      const opt0 = Object.values(optState).reduce((a, o) => a + (o.pos ? o.carry : 0), 0);
      const usd0 = stock0 + opt0 + (cash0.USD || 0);
      // 紀錄從開戶開始（之前沒有任何持股與現金）就不放起點，走勢才不會從 0 跳上去
      if (stock0 > 1 || Math.abs(opt0) > 1 || (cash0.USD || 0) > 50) out.push({ date: prevDay, usd: round(usd0, 2), twd: Math.round(usd0 * rate0), fx: round(rate0, 4), exp: round(exp0, 2), backfilled: true, base: true });
    }
    for (const d of days) {
      const s = snap[d], rate = lastOnOrBefore(fxSeries, d) || fx;
      let stock = 0, exp = 0;
      for (const [sym, q] of Object.entries(s.pos)) {
        if (Math.abs(q) < 1e-9) continue;
        const v = q * priceOf(sym, d);
        stock += v; exp += v * levOf(sym);
      }
      const usd = stock + optValue(d) + s.cash.USD;
      exp += optExpToday;
      out.push({ date: d, usd: round(usd, 2), twd: Math.round(usd * rate), fx: round(rate, 4), exp: round(exp, 2), backfilled: true });
    }
    data.history = [...out, ...data.history.filter(h => h.date >= todayStr)];
    const missing = stockSyms.filter(s => !px[s] || px[s].error);
    data.settings.levVersion = 3;   // 歷史曝險：只含買方選擇權的 delta
    save(); render(); loadBench();
    console.info('split-adjusted', scale, 'missing', missing);
    toast(`已重新計算 ${out.length} 天的走勢` + (missing.length ? `（${missing.join('、')} 查不到歷史價，以成交價估算）` : ''));
  } catch (err) {
    toast('⚠️ 重新計算失敗：' + err.message);
  } finally {
    rebuilding = false;
    if (btn) btn.innerHTML = '↻ 重新計算';
  }
}

// ============ Transactions (apply / revert) ============
// 每筆紀錄都存下它對現金/持股造成的「變化量」，復原匯入時反向套用即可。
function applyEffects(eff, dir = 1) {
  for (const [c, d] of Object.entries(eff.cash || {})) data.cash[c] = round((data.cash[c] || 0) + dir * d, 4);
  if (eff.holding) {
    const { symbol, shares, cost } = eff.holding;
    const h = data.holdings[symbol] || { shares: 0, cost: 0 };
    h.shares = round(h.shares + dir * shares);
    h.cost = round(h.cost + dir * cost, 4);
    if (h.shares <= 1e-9) delete data.holdings[symbol]; else data.holdings[symbol] = h;
  }
}
// ============ Modal forms ============
const modal = $('#modal'), form = $('#modalForm');
const FORMS = {
  brokerImport: (plan) => {
    const nothing = !plan.txs.length && !plan.adjusts.length && !plan.manual.length && !plan.replaced.length;
    const li = [];
    if (plan.txs.length) li.push(`新增 <b>${plan.txs.length}</b> 筆紀錄：${plan.live} 筆會更新持股與現金` +
      (plan.logOnly ? `，${plan.logOnly} 筆只記錄（在 ${plan.sync} 持倉同步之前，持股已包含）` : ''));
    if (plan.deposits) li.push(`其中存款／出金 ${plan.deposits} 筆`);
    if (plan.opt) li.push(`其中選擇權 ${plan.opt} 筆：未平倉的合約會以 Yahoo 報價計入市值`);
    if (plan.cash) li.push(`美元現金 ${fmt(plan.cash, 'USD', { sign: true })}（${fmt(data.cash.USD)} → ${fmt(data.cash.USD + plan.cash)}）`);
    if (plan.dup) li.push(`已匯入過的 ${plan.dup} 筆：略過`);
    if (plan.replaced.length) li.push(`券商改寫過的舊紀錄 ${plan.replaced.length} 筆（改了日期、類別，或把多筆成交合併），以新檔案為準<br><span class="muted">${
      plan.replaced.slice(0, 6).map(t => `${t.date} ${t.type === 'option' ? optName(t.symbol) : t.symbol} ${TX_LABEL[t.type]} ${t.type === 'option' ? fmtShares(Math.abs(t.qty)) + ' 口' : fmtShares(t.shares) + ' 股'}`).join('<br>')}${plan.replaced.length > 6 ? '<br>…' : ''}</span>`);
    if (plan.manual.length) li.push(`你手動記錄過的 ${plan.manual.length} 筆：視為同一筆，改用券商的精確數字<br><span class="muted">${plan.manual.map(m => `${m.date} ${m.symbol} ${TX_LABEL[m.type]} ${fmtShares(m.shares)} 股`).join('<br>')}</span>`);
    if (plan.skipped.length) li.push(`無法處理 ${plan.skipped.length} 筆：<br><span class="muted">${plan.skipped.slice(0, 5).map(esc).join('<br>')}${plan.skipped.length > 5 ? '<br>…' : ''}</span>`);
    const adj = plan.adjusts.length
      ? `<div style="font-size:13px;margin-bottom:6px">依持倉檔校正持股：</div>
         <div class="table-wrap"><table class="imp-table"><thead><tr><th>代號</th><th>股數</th><th>成本</th></tr></thead><tbody>
         ${plan.adjusts.map(a => `<tr><td>${esc(a.symbol)}</td><td class="num">${fmtShares(a.before.shares)} → ${fmtShares(a.after.shares)}</td><td class="num">${fmt(a.before.cost)} → ${fmt(a.after.cost)}</td></tr>`).join('')}
         </tbody></table></div>`
      : plan.hasPositions ? '<div class="muted" style="font-size:13px;margin-bottom:12px">持倉檔與目前持股一致，不需校正。</div>' : '';
    return {
      title: '匯入券商檔案',
      html: (nothing ? '<div class="empty" style="padding:12px 0">沒有新的資料要匯入</div>' : `<ul class="imp-list">${li.map(x => `<li>${x}</li>`).join('')}</ul>`) + adj,
      noSubmit: nothing,
      submit() { applyImport(plan); },
    };
  },
};

let current = null;
function updatePreview() { const p = form.querySelector('.preview'); if (p && current.preview) p.innerHTML = current.preview() || ''; }
function openForm(kind, arg) {
  current = FORMS[kind](arg);
  form.innerHTML = `<h3>${current.title}</h3>${current.html}
    ${current.preview ? '<div class="preview"></div>' : ''}<div class="err" id="f_err" hidden></div>
    <div class="modal-actions"><button type="button" id="f_cancel">取消</button>${current.noSubmit ? '' : '<button class="primary" type="submit">確認</button>'}</div>`;
  form.querySelector('#f_cancel').onclick = () => modal.close();
  form.oninput = updatePreview;
  current.onOpen?.();
  updatePreview();
  modal.showModal();
}
form.addEventListener('submit', e => {
  e.preventDefault();
  const err = current.submit();
  if (err) { const el = form.querySelector('#f_err'); el.textContent = err; el.hidden = false; return; }
  modal.close();
});

// ============ Events ============
document.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.cur) { data.settings.displayCurrency = b.dataset.cur; save(); render(); }
  else if (b.dataset.range) { chartRange = b.dataset.range; renderChart(); $$('#rangeSeg button').forEach(x => x.classList.toggle('on', x === b)); }
  else if (b.dataset.lrange) { levRange = b.dataset.lrange; renderLev(); $$('#levRangeSeg button').forEach(x => x.classList.toggle('on', x === b)); }
  else if (b.dataset.crange) { cmpRange = b.dataset.crange; renderCompare(); $$('#cmpRangeSeg button').forEach(x => x.classList.toggle('on', x === b)); }
  else if (b.dataset.f) { txFilter = b.dataset.f; txLimit = 30; render(); }
  else if (b.dataset.reclass) {
    // 只改分類（影響報酬率怎麼算），不動金額；重新上傳券商檔案也會保留
    const t = data.transactions.find(x => x.id === b.dataset.reclass);
    if (!t) return;
    t.category = t.category === '帳外獲利' ? '入金' : '帳外獲利';
    save(); render();
    toast(t.category === '帳外獲利' ? `${t.date} 這筆已改為帳外獲利，報酬率已重新計算` : `${t.date} 這筆已改回入金`);
  }
});
$('#refreshBtn').onclick = refreshQuotes;
$('#rebuildBtn').onclick = rebuildHistory;
$('#moreTx').onclick = () => { txLimit += 50; renderTx(); };
$('#usColors').onchange = e => { data.settings.usColors = e.target.checked; save(); render(); };
$('#exportBtn').onclick = () => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `assets-${today()}.json`; a.click();
};
$('#brokerBtn').onclick = () => $('#brokerFile').click();
$('#brokerFile').onchange = e => { const f = [...e.target.files]; e.target.value = ''; handleBrokerFiles(f); };
// 也可以直接把檔案拖進網頁
document.addEventListener('input', e => { if (e.target.id === 'txSearch') { txSearch = e.target.value.trim().toUpperCase(); txLimit = 30; renderTx(); } });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  const f = [...(e.dataTransfer?.files || [])].filter(f => /\.(csv|xlsx)$/i.test(f.name));
  if (f.length) handleBrokerFiles(f);
});
$('#undoImportBtn').onclick = e => {
  const b = e.currentTarget, reset = () => { delete b.dataset.confirm; b.textContent = '復原上次券商匯入'; };
  if (b.dataset.confirm) { reset(); undoImport(); return; }
  b.dataset.confirm = '1'; b.textContent = '確定復原？再按一次';
  setTimeout(() => { if (b.dataset.confirm) reset(); }, 3000);
};
window.addEventListener('resize', () => { clearTimeout(window._rz); window._rz = setTimeout(() => { renderChart(); renderCompare(); renderLev(); }, 150); });
// 每 60 秒自動更新；分頁回到前景時也更新
setInterval(() => { if (!document.hidden) refreshQuotes(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && (!lastUpdate || Date.now() - lastUpdate > 30000)) refreshQuotes(); });

(async () => {
  await load(); render(); await refreshQuotes(); loadBench();
  // 槓桿率算法更新過（目前：只計入買方選擇權），舊的歷史資料自動重算一次
  if (data.settings.levVersion !== 3 && data.transactions.some(t => t.imported)) rebuildHistory();
})();
setInterval(loadBench, 10 * 60000);
