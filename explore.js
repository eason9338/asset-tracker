// 特殊功能：交易人格報告、平行宇宙、資產時光機、財報
// 只讀資料不寫入；共用函式來自 analytics.js 的 window.AX 與 app.js 的全域函式
(() => {
'use strict';
const { el, usd, usd0, pct, pctPlain, avg, days, store, dailyReturns, grp, stockLots, optionLifeEvents, squarify, outsideAsFlow } = window.AX;
const addDays = (d, n) => new Date(new Date(d + 'T12:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
const WEEK = '日一二三四五六';
const weekday = d => new Date(d + 'T12:00:00Z').getUTCDay();
const money = v => `<span class="money">${v}</span>`;

// ================= 交易人格報告 =================
let pYear = 'all';
function personaEvents() {
  // 每一筆已實現的交易：類別、損益、持有天數、開倉日（賣出日往回推持有天數）
  const st = realizedStats(), ev = [];
  for (const e of stockLots(st).events) {
    const lev = levOf(e.sym) !== 1 && grp(e.sym) !== 'CASH';
    ev.push({ kind: lev ? 'lev' : 'stock', sym: e.sym, date: e.date, r: e.r, hold: e.hold || 0 });
  }
  for (const e of optionLifeEvents(st)) ev.push({ kind: e.side === 'long' ? 'optLong' : 'optShort', sym: e.sym, date: e.date, r: e.r, hold: e.hold || 0 });
  for (const e of ev) e.open = addDays(e.date, -Math.round(e.hold));
  return ev;
}
function marketBefore() {
  // 開倉前 5 個交易日 Nasdaq 100 的漲跌
  const s = bench?.QQQ; if (!s || s.error) return () => null;
  const ds = Object.keys(s).sort();
  return d => {
    let lo = 0, hi = ds.length - 1, i = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (ds[m] < d) { i = m; lo = m + 1; } else hi = m - 1; }
    return i >= 5 ? s[ds[i]] / s[ds[i - 5]] - 1 : null;
  };
}
// 一組交易的成績：筆數、勝率、平均每筆
const score = list => {
  const w = winStats(list), top = list.reduce((m, e) => Math.max(m, e.r), 0);
  // trim：扣掉最賺的那一筆後的平均，用來排名「最好／最差」，避免一筆極端的交易左右結論
  return { n: w.n, rate: w.rate, avg: w.n ? w.total / w.n : 0, total: w.total, trim: w.n > 1 ? (w.total - top) / (w.n - 1) : 0 };
};
function compareRows(rows, fmtV = v => usd(v, { sign: true }), valueOf = s => s.avg) {
  // 幾組並排比較：長條長度＝數值大小（以 0 為中心，左負右正）
  const vals = rows.filter(r => r.s.n).map(r => valueOf(r.s)), max = Math.max(...vals.map(Math.abs), 1e-9);
  return `<div class="cmp">${rows.map(r => {
    const v = valueOf(r.s), w = r.s.n ? Math.abs(v) / max * 50 : 0;
    return `<div class="cmp-row ${r.s.n ? '' : 'none'}"><span class="cmp-k">${r.k}</span>
      <span class="cmp-bar"><i class="${v >= 0 ? 'pos' : 'neg'}" style="${v >= 0 ? 'left:50%' : `right:50%`};width:${w}%"></i></span>
      <span class="cmp-v"><b class="num ${cls(v)}">${r.s.n ? fmtV(v) : '—'}</b><span class="sub">${r.s.n ? `${r.s.n} 筆・勝率 ${pctPlain(r.s.rate)}` : '沒有紀錄'}</span></span></div>`;
  }).join('')}</div>`;
}
const card = (q, body, verdict) => `<div class="card trait"><div class="trait-q">${q}</div>${body}${verdict ? `<div class="trait-v">${verdict}</div>` : ''}</div>`;
const best = rows => rows.filter(r => r.s.n >= 5).sort((a, b) => b.s.trim - a.s.trim)[0];
const worst = rows => rows.filter(r => r.s.n >= 5).sort((a, b) => a.s.trim - b.s.trim)[0];

function renderPersona() {
  const box = el('personaBox'); if (!box) return;
  const allEv = personaEvents(), years = [...new Set(allEv.map(e => e.date.slice(0, 4)))].sort().reverse();
  if (pYear !== 'all' && !years.includes(pYear)) pYear = 'all';
  el('personaYears').innerHTML = UI.seg('py', [['all', '全部'], ...years.map(y => [y, y])], pYear);
  const ev = allEv.filter(e => pYear === 'all' || e.date.startsWith(pYear));
  if (ev.length < 10) { box.innerHTML = UI.empty('已實現的交易還不夠多，累積多一點再來看'); el('personaHero').innerHTML = ''; return; }
  const all = score(ev);

  // 1. 持有時間
  const holdRows = [['當天', 0, 0.5], ['1–7 天', 0.5, 7.5], ['8–30 天', 7.5, 30.5], ['31–90 天', 30.5, 90.5], ['90 天以上', 90.5, 1e9]]
    .map(([k, a, b]) => ({ k, s: score(ev.filter(e => e.hold >= a && e.hold < b)) }));
  const shortShare = ev.filter(e => e.hold < 7.5).length / ev.length;
  const hb = best(holdRows), hw = worst(holdRows);
  // 2. 賺的單、賠的單各抱多久
  const wins = ev.filter(e => e.r > 0.005), losses = ev.filter(e => e.r <= 0.005);
  const hW = avg(wins.map(e => e.hold)), hL = avg(losses.map(e => e.hold));
  // 3. 進場時機
  const mkt = marketBefore();
  for (const e of ev) e.mkt = mkt(e.open);
  const timingRows = [{ k: '大盤剛跌完<span class="sub">前 5 天跌超過 3%</span>', s: score(ev.filter(e => e.mkt != null && e.mkt <= -0.03)) },
                      { k: '平常', s: score(ev.filter(e => e.mkt != null && e.mkt > -0.03 && e.mkt < 0.03)) },
                      { k: '大盤剛漲完<span class="sub">前 5 天漲超過 3%</span>', s: score(ev.filter(e => e.mkt != null && e.mkt >= 0.03)) }];
  // 4. 帳戶大跌隔天
  const rOn = {}, hist = data.history, rets = dailyReturns(hist, outsideAsFlow());
  for (const x of rets) rOn[x.date] = x.r;
  const prevDay = d => { let p = null; for (const h of hist) { if (h.date >= d) break; p = h.date; } return p; };
  for (const e of ev) e.after = rOn[prevDay(e.open)] ?? null;
  const revRows = [{ k: '帳戶大跌的隔天<span class="sub">前一天跌超過 2%</span>', s: score(ev.filter(e => e.after != null && e.after <= -0.02)) },
                   { k: '其他日子', s: score(ev.filter(e => e.after == null || e.after > -0.02)) }];
  // 5. 交易忙碌度：每週下了幾筆單 vs 那週的帳戶報酬
  const wk = d => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
  const trades = {}, wret = {};
  for (const t of data.transactions) if (['buy', 'sell', 'option'].includes(t.type) && (pYear === 'all' || t.date.startsWith(pYear)) && !t.split) trades[wk(t.date)] = (trades[wk(t.date)] || 0) + 1;
  for (const x of rets) if (pYear === 'all' || x.date.startsWith(pYear)) wret[wk(x.date)] = (wret[wk(x.date)] ?? 1) * (1 + x.r);
  const weeks = Object.keys(wret).map(w => ({ n: trades[w] || 0, r: wret[w] - 1 }));
  const busy = [['0–3 筆', 0, 3], ['4–10 筆', 4, 10], ['11 筆以上', 11, 1e9]].map(([k, a, b]) => {
    const ws = weeks.filter(w => w.n >= a && w.n <= b);
    return { k, s: { n: ws.length, avg: avg(ws.map(w => w.r)), rate: ws.length ? ws.filter(w => w.r > 0).length / ws.length : null } };
  });
  // 6. 擅長的類別
  const kindRows = [['股票與 ETF', 'stock'], ['槓桿 ETF', 'lev'], ['選擇權賣方', 'optShort'], ['選擇權買方', 'optLong']].map(([k, kind]) => ({ k, s: score(ev.filter(e => e.kind === kind)) }));
  // 7. 星期幾進場
  const dayRows = [1, 2, 3, 4, 5].map(d => ({ k: `週${WEEK[d]}`, s: score(ev.filter(e => weekday(e.open) === d)) }));
  // 8. 心情（日記）
  const moods = (data.journal || []).filter(j => pYear === 'all' || j.date.startsWith(pYear));

  // ---- 人格標籤 ----
  const tags = [];
  tags.push(shortShare > 0.5 ? ['短線型', `${pctPlain(shortShare)} 的交易一週內就出場`] : ['耐心型', `${pctPlain(1 - shortShare)} 的交易抱超過一週`]);
  if (hL > hW * 1.25) tags.push(['賠錢的單抱比較久', `賠的平均抱 ${Math.round(hL)} 天，賺的只抱 ${Math.round(hW)} 天`]);
  else if (hW > hL * 1.25) tags.push(['讓獲利奔跑', `賺的平均抱 ${Math.round(hW)} 天，賠的 ${Math.round(hL)} 天就停損`]);
  const [dip, , chase] = timingRows;
  if (dip.s.n >= 5 && chase.s.n >= 5) tags.push(dip.s.avg > chase.s.avg ? ['逢低比追高好', '大盤剛跌完進場的單，平均比追高的好'] : ['追高也賺', '大盤剛漲完才進場，成績反而不差']);
  if (revRows[0].s.n >= 5) tags.push(revRows[0].s.avg < revRows[1].s.avg ? ['虧完別急著扳回', '帳戶大跌隔天下的單，平均比較差'] : ['跌了也穩得住', '大跌隔天下的單沒有比較差']);
  const kb = best(kindRows); if (kb) tags.push([`最擅長：${kb.k}`, `平均每筆 ${usd(kb.s.avg, { sign: true })}・勝率 ${pctPlain(kb.s.rate)}`]);
  el('personaHero').innerHTML = `<div class="persona-hero">
      <div class="persona-title">你的交易說明書<span class="sub">${pYear === 'all' ? '開戶到現在' : pYear + ' 年'}・${all.n} 筆已實現交易・勝率 ${pctPlain(all.rate)}・平均每筆 ${money(usd(all.avg, { sign: true }))}</span></div>
      <div class="persona-tags">${tags.map(([t, s]) => `<div class="persona-tag"><b>${t}</b><span>${s}</span></div>`).join('')}</div>
    </div>`;

  const v = (cond, a, b) => cond ? a : b;
  box.innerHTML = [
    card('抱比較久的單，比較賺嗎？', compareRows(holdRows),
      hb && hw && hb !== hw ? `<b>${hb.k}</b>的交易平均最好（每筆 ${money(usd(hb.s.avg, { sign: true }))}），<b>${hw.k}</b>最差。你有 ${pctPlain(shortShare)} 的交易在一週內出場。` : ''),
    card('賺錢的單和賠錢的單，你各抱多久？', `<div class="hold-duel">
        <div><span>賺錢的單</span><b>${Math.round(hW)} 天</b><span class="sub">${wins.length} 筆的平均</span></div>
        <div><span>賠錢的單</span><b>${Math.round(hL)} 天</b><span class="sub">${losses.length} 筆的平均</span></div></div>`,
      v(hL > hW * 1.25, '賠錢的單抱得比賺錢的久：常見的「賺一點就跑、賠了捨不得停損」。下次可以先把出場條件寫進計畫。',
        v(hW > hL * 1.25, '賺錢的單抱得比較久，賠的很快就處理掉，這是很好的習慣。', '賺的和賠的抱的時間差不多。'))),
    card('大盤剛跌完、剛漲完，進場的結果差多少？', compareRows(timingRows),
      dip.s.n && chase.s.n ? v(dip.s.avg > chase.s.avg, '等大盤跌完再進場，平均比追高好。', '追高進場的單平均反而比較好，你可能比較適合順勢。') : ''),
    card('帳戶大跌的隔天，你下的單結果如何？', compareRows(revRows),
      revRows[0].s.n ? v(revRows[0].s.avg < revRows[1].s.avg, '大跌隔天下的單平均比較差。心情不好的隔天，先休息一天也許更好。', '大跌隔天下的單沒有比較差，你在壓力下還算穩得住。') : '這段期間沒有在大跌隔天下單。'),
    card('交易很忙的那幾週，帳戶表現如何？', compareRows(busy, x => pct(x, 2), s => s.avg).replace(/筆・勝率/g, '週・上漲週'),
      (() => { const ok = busy.filter(b => b.s.n >= 3); if (ok.length < 2) return ''; const b = [...ok].sort((x, y) => y.s.avg - x.s.avg)[0]; return `每週下 <b>${b.k}</b> 單的那幾週，帳戶平均報酬最好。`; })()),
    card('你最擅長哪一種？', compareRows(kindRows),
      kb ? `<b>${kb.k}</b>最穩定。${(() => { const w = worst(kindRows); return w && w !== kb ? `<b>${w.k}</b>最差。` : ''; })()}<span class="sub">排名時扣掉每一類最賺的那一筆，避免一筆特別大的交易影響結論。</span>` : ''),
    card('星期幾進場比較好？', compareRows(dayRows), (() => { const b = best(dayRows), w = worst(dayRows); return b && w && b !== w ? `<b>${b.k}</b>進場的單平均最好，<b>${w.k}</b>最差。（純屬好玩，參考就好）` : ''; })()),
    card('心情和交易', moods.length >= 5 ? (() => {
      const byMood = {}; for (const j of moods) (byMood[j.mood] ??= []).push(j.date);
      const MOOD = { calm: '😌 平靜', sure: '🙂 有把握', meh: '😐 普通', anx: '😣 焦慮', rash: '😤 衝動' };
      return compareRows(Object.entries(byMood).map(([m, ds]) => ({ k: MOOD[m] || m, s: score(ev.filter(e => ds.some(d => Math.abs(days(d, e.open)) <= 1))) })));
    })() : UI.empty(`日記還只有 ${moods.length} 篇。寫到 5 篇以上，這裡會比對你寫日記時的心情和那幾天交易的結果。`, true), ''),
  ].join('');
}

// ================= 平行宇宙 =================
let uRange = '0';
const U_COLORS = { real: 'var(--accent)', voo: 'var(--s2)', qqq: 'var(--s3)', noshort: 'var(--c-health)', nolong: 'var(--s4)', nolev: 'var(--c-semi)' };
function universes() {
  const h = data.history.filter(x => x.usd > 0); if (h.length < 2 || !bench) return null;
  const h0 = h[0], flows = externalFlows().filter(f => f.date > h0.date).sort((a, b) => a.date.localeCompare(b.date));
  const px = (sym, d) => bench[sym] && !bench[sym].error ? lastOnOrBefore(bench[sym], d) : null;
  // 全買指數：開始那天的資產全部買進，之後每筆入金當天買（出金就賣）
  const buyHold = sym => { if (px(sym, h0.date) == null) return null; let sh = h0.usd / px(sym, h0.date), i = 0;
    return h.map(x => { while (i < flows.length && flows[i].date <= x.date) { sh += flows[i].usd / px(sym, flows[i].date); i++; } return sh * px(sym, x.date); }); };
  // 拿掉某一類交易的已實現損益（那些錢當作一直放著沒動）
  const st = realizedStats();
  const without = pick => { const evs = [...st.stockEvents.map(e => ({ ...e, opt: false })), ...st.optEvents.map(e => ({ ...e, opt: true }))].filter(pick).sort((a, b) => a.date.localeCompare(b.date));
    let cum = 0, i = 0; return h.map(x => { while (i < evs.length && evs[i].date <= x.date) cum += evs[i++].r; return x.usd - cum; }); };
  const isLev = s => levOf(s) !== 1 && grp(s) !== 'CASH';
  return { dates: h.map(x => x.date), list: [
    { id: 'real', name: '真實的你', v: h.map(x => x.usd), story: '現在這條路' },
    { id: 'voo', name: '全買 S&P 500', v: buyHold('VOO'), story: '每一筆入金都直接買 VOO，從來不交易' },
    { id: 'qqq', name: '全買 Nasdaq 100', v: buyHold('QQQ'), story: '每一筆入金都直接買 QQQ，從來不交易' },
    { id: 'nolong', name: '沒做選擇權買方', v: without(e => e.opt && e.side === 'long'), story: '其他照舊，只是從來沒買過 call、put' },
    { id: 'noshort', name: '沒做選擇權賣方', v: without(e => e.opt && e.side === 'short'), story: '其他照舊，只是從來沒賣過 call、put' },
    { id: 'nolev', name: '沒碰槓桿 ETF', v: without(e => isLev(e.opt ? occ(e.sym)?.root : e.sym)), story: '其他照舊，只是沒買過槓桿 ETF 和它們的選擇權' },
  ].filter(u => u.v) };
}
function renderUniverse() {
  const box = el('universeChart'); if (!box || box.clientWidth === 0) return;
  document.querySelectorAll('[data-ur]').forEach(b => b.classList.toggle('on', b.dataset.ur === uRange));
  const U = universes();
  if (!U) { box.innerHTML = UI.empty('正在載入指數的歷史價格…'); return; }
  const real = U.list[0], lastReal = real.v.at(-1);
  // 下方的卡片：每個宇宙現在會有多少錢、跟真實的你差多少
  el('universeCards').innerHTML = U.list.map(u => {
    const last = u.v.at(-1), diff = last - lastReal;
    return `<div class="uni-card ${u.id === 'real' ? 'real' : ''}"><div class="uni-name"><span class="dot" style="background:${U_COLORS[u.id]}"></span>${u.name}</div>
      <div class="uni-v num">${usd0(last)}</div>
      <div class="uni-diff">${u.id === 'real' ? '現在的總資產' : `比現在的你${diff >= 0 ? '多' : '少'} <b class="num ${diff >= 0 ? 'down' : 'up'}">${usd0(Math.abs(diff))}</b>`}</div>
      <div class="sub">${u.story}</div></div>`;
  }).join('');
  // 走勢：只畫選的區間
  const cut = uRange === '0' ? 0 : Math.max(0, U.dates.findIndex(d => d >= addDays(today(), -+uRange)));
  const ds = U.dates.slice(cut), series = U.list.map(u => ({ ...u, v: u.v.slice(cut) }));
  const W = box.clientWidth, H = box.clientHeight, padL = 64, padR = 12, padT = 10, padB = 24;
  const all = series.flatMap(s => s.v);
  let min = Math.min(...all), max = Math.max(...all); const pad = (max - min) * 0.06; min -= pad; max += pad;
  const t0 = +new Date(ds[0]), t1 = +new Date(ds.at(-1));
  const x = d => padL + (+new Date(d) - t0) / (t1 - t0 || 1) * (W - padL - padR), y = v => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  const line = s => s.v.map((v, i) => (i ? 'L' : 'M') + x(ds[i]).toFixed(1) + ',' + y(v).toFixed(1)).join('');
  const k = v => '$' + (Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : v.toFixed(0));
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    ${[0, 0.5, 1].map(f => min + (max - min) * f).map(t => `<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" stroke="var(--border)" stroke-dasharray="2 4"/><text class="axis-text" x="${padL - 8}" y="${y(t) + 4}" text-anchor="end">${k(t)}</text>`).join('')}
    <text class="axis-text" x="${padL}" y="${H - 4}">${ds[0]}</text><text class="axis-text" x="${W - padR}" y="${H - 4}" text-anchor="end">${ds.at(-1)}</text>
    ${[...series].reverse().map(s => `<path d="${line(s)}" fill="none" stroke="${U_COLORS[s.id]}" stroke-width="${s.id === 'real' ? 2.6 : 1.5}" ${['noshort', 'nolong', 'nolev'].includes(s.id) ? 'stroke-dasharray="5 4"' : ''} stroke-linejoin="round"/>`).join('')}
    <line class="xc" y1="${padT}" y2="${H - padB}" stroke="var(--text-3)" visibility="hidden"/>
    <rect x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent" class="xh"/>
  </svg><div class="chart-tip" hidden></div>`;
  const hit = box.querySelector('.xh'), cx = box.querySelector('.xc'), tip = box.querySelector('.chart-tip');
  hit.addEventListener('pointermove', e => {
    const mx = e.clientX - box.getBoundingClientRect().left;
    let i = 0; for (let j = 0; j < ds.length; j++) if (Math.abs(x(ds[j]) - mx) < Math.abs(x(ds[i]) - mx)) i = j;
    const px = x(ds[i]); cx.setAttribute('x1', px); cx.setAttribute('x2', px); cx.setAttribute('visibility', 'visible');
    tip.hidden = false; tip.style.left = px + 'px'; tip.style.top = padT + 'px';
    tip.style.transform = px > W / 2 ? 'translate(calc(-100% - 10px), 0)' : 'translate(10px, 0)';
    tip.innerHTML = `<div style="margin-bottom:3px">${ds[i]}</div>` + [...series].sort((a, b) => b.v[i] - a.v[i]).map(s => `<div class="row"><span><span class="dot" style="background:${U_COLORS[s.id]}"></span> ${s.name}</span><b>${usd0(s.v[i])}</b></div>`).join('');
  });
  hit.addEventListener('pointerleave', () => { cx.setAttribute('visibility', 'hidden'); tip.hidden = true; });
}

// ================= 財報 =================
// 把帳戶當成一家投資公司，照一般財報的科目編綜合損益表：
// 賣掉的部位是「處分投資損益」、選擇權是「衍生工具損益」，還沒賣的部位照市價衡量，期間內的漲跌列「金融資產評價損益」（持有供交易的金融資產的做法）
// 本期淨利＝期末淨資產 − 期初淨資產 − 期間的入金出金，跟「賺到的錢」對得起來；評價損益用這個總數倒算，所以每一期一定平衡
const COMPANY = 'Akira 投資';
let rKind = 'q', rPeriod = null;
function rPeriods(kind) {
  const out = [];
  for (const x of data.history) {
    if (!(x.usd > 0)) continue;
    const y = x.date.slice(0, 4), k = kind === 'y' ? y : `${y}Q${Math.ceil(+x.date.slice(5, 7) / 3)}`;
    if (out.at(-1) !== k) out.push(k);
  }
  return out;
}
function rRange(k) {
  if (k.length === 4) return [`${k}-01-01`, `${k}-12-31`];
  const y = k.slice(0, 4), q = +k.slice(5), m = String(q * 3).padStart(2, '0');
  return [`${y}-${String(q * 3 - 2).padStart(2, '0')}-01`, `${y}-${m}-${q === 1 || q === 4 ? 31 : 30}`];
}
const rPrev = k => k.length === 4 ? String(+k - 1) : `${+k.slice(0, 4) - 1}Q${k.slice(5)}`;   // 去年同期
const rName = k => k.length === 4 ? `${k} 年度` : `${k.slice(0, 4)} 年第${'一二三四'[+k.slice(5) - 1]}季`;
function tradeFee(t) {
  // 每筆成交的手續費和規費（成交金額跟成交價 × 股數的差）
  if ((t.type === 'buy' || t.type === 'sell') && t.price) return Math.max(t.type === 'buy' ? t.total - t.shares * t.price : t.shares * t.price - t.total, 0);
  if (t.type === 'option' && t.key && t.amount) {
    const p = parseFloat(t.key.split('|')[4]);
    if (p > 0) return Math.max(t.qty > 0 ? -t.amount - p * 100 * t.qty : p * 100 * -t.qty - t.amount, 0);
  }
  return 0;
}
function rStatement(k, st) {
  const [a, b] = rRange(k), hist = data.history.filter(x => x.usd > 0), inP = d => d >= a && d <= b;
  const end = hist.filter(x => x.date <= b).at(-1);
  if (!end || end.date < a) return null;
  const start = hist.filter(x => x.date < a).at(-1) || hist[0];
  const flows = externalFlows().filter(f => f.date > start.date && f.date <= end.date).reduce((s, f) => s + f.usd, 0);
  const s = { k, a, b, start, end, ni: end.usd - start.usd - flows, stocks: {}, opt: { short: 0, long: 0 }, fees: 0, div: 0, intInc: 0, intExp: 0, refund: 0, outside: 0 };
  for (const t of data.transactions) {
    if (!inP(t.date)) continue;
    const fee = tradeFee(t); s.fees += fee;
    // 處分損益用扣手續費前的金額，手續費另外列在營業費用
    if (t.type === 'sell' && st.perSell[t.id] != null) s.stocks[t.symbol] = (s.stocks[t.symbol] || 0) + st.perSell[t.id] + fee;
    else if (t.type === 'option' && st.perOpt[t.id] != null) s.opt[t.qty > 0 ? 'short' : 'long'] += st.perOpt[t.id] + fee;
    else if ((t.type === 'income' || t.type === 'expense') && t.currency === 'USD') {
      const v = (t.type === 'income' ? 1 : -1) * t.amount, c = t.category || '';
      if (c.startsWith('股息')) s.div += v;
      else if (c.startsWith('退稅')) s.refund += v;
      else if (c.startsWith('利息支出')) s.intExp -= v;
      else if (c.startsWith('利息')) s.intInc += v;
      else if (c.startsWith('帳外獲利')) s.outside += v;
    }
  }
  for (const e of st.expiries) if (inP(e.date)) s.opt[e.qty < 0 ? 'long' : 'short'] += e.realized;   // 到期失效
  const realized = Object.values(s.stocks).reduce((x, v) => x + v, 0) + s.opt.short + s.opt.long;
  s.val = s.ni - (realized - s.fees + s.div + s.intInc - s.intExp + s.refund + s.outside);
  // 各科目
  const pos = x => Math.max(x, 0), neg = x => Math.max(-x, 0), sv = Object.values(s.stocks);
  const L = s.L = { dispG: sv.reduce((x, v) => x + pos(v), 0), derivG: pos(s.opt.short) + pos(s.opt.long), div: s.div, intInc: s.intInc, valG: pos(s.val),
    dispL: sv.reduce((x, v) => x + neg(v), 0), derivL: neg(s.opt.short) + neg(s.opt.long), valL: neg(s.val),
    fees: s.fees, outside: s.outside, intExp: s.intExp, refund: s.refund };
  L.rev = L.dispG + L.derivG + L.div + L.intInc + L.valG;
  L.cost = L.dispL + L.derivL + L.valL;
  L.gp = L.rev - L.cost; L.op = L.gp - L.fees; L.pre = L.op + L.outside - L.intExp; L.ni = L.pre + L.refund;
  L.roe = s.ni / ((start.usd + end.usd) / 2);
  return s;
}
const rNum = v => Math.abs(v) < 0.5 ? '—' : v < 0 ? `(${Math.round(-v).toLocaleString('en-US')})` : Math.round(v).toLocaleString('en-US');
const rYoY = (cur, prev) => prev == null || Math.abs(prev) < 1 ? null : (cur - prev) / Math.abs(prev);
// 年增率的寫法跟財報一樣：正負號相反寫「轉盈／轉虧」，去年太小（變動 10 倍以上）不寫百分比
const rYoYFmt = (cur, prev) => {
  const y = rYoY(cur, prev); if (y == null) return null;
  if (prev < 0 && cur > 0) return '轉盈'; if (prev > 0 && cur < 0) return '轉虧';
  if (Math.abs(y) >= 10) return y > 0 ? '10 倍以上' : '−90% 以上';
  return `${y >= 0 ? '+' : ''}${Math.round(y * 100)}%`;
};
const rYoYText = (cur, prev) => { const y = rYoYFmt(cur, prev); return y == null ? '' : `年增 ${y}`; };

function rSankey(box, s, p) {
  // 從左到右：收入來源 → 營業收入 → 毛利／成本 → 營業利益／費用 → 淨利（附圖那種公司財報流向圖）
  const L = s.L, B = 'var(--accent)', G = 'var(--up)', R = 'var(--down)', P = p?.L;
  const nodes = [], links = [], N = (id, col, v, color, name, sub = '') => { if (v > 0.5) nodes.push({ id, col, v, color, name, sub }); };
  const link = (a, b, v) => { if (v > 0.5 && nodes.some(n => n.id === a) && nodes.some(n => n.id === b)) links.push({ a, b, v }); };
  // 收入來源：賺錢的股票前 4 檔、其他合併；選擇權分賣方和買方
  const winners = Object.entries(s.stocks).filter(([, v]) => v > 0.5).sort((x, y) => y[1] - x[1]);
  const top = winners.slice(0, 4), rest = winners.slice(4).reduce((x, [, v]) => x + v, 0);
  for (const [sym, v] of top) N('s:' + sym, 0, v, B, sym);
  N('s:rest', 0, rest, B, `其他 ${winners.length - 4} 檔`);
  N('o:short', 0, Math.max(s.opt.short, 0), B, '選擇權賣方'); N('o:long', 0, Math.max(s.opt.long, 0), B, '選擇權買方');
  N('dispG', 1, L.dispG, B, '處分投資利益', rYoYText(L.dispG, P?.dispG)); N('derivG', 1, L.derivG, B, '衍生工具利益', rYoYText(L.derivG, P?.derivG));
  N('div', 1, L.div, B, '股利收入'); N('intInc', 1, L.intInc, B, '利息收入'); N('valG', 1, L.valG, B, '評價利益', '還沒賣的部位');
  for (const [sym] of top) link('s:' + sym, 'dispG', s.stocks[sym]);
  link('s:rest', 'dispG', rest); link('o:short', 'derivG', s.opt.short); link('o:long', 'derivG', s.opt.long);
  const pct = v => L.rev > 0 ? Math.round(v / L.rev * 100) + '%' : '';
  N('rev', 2, L.rev, B, '營業收入', rYoYText(L.rev, P?.rev));
  for (const id of ['dispG', 'derivG', 'div', 'intInc', 'valG']) link(id, 'rev', L[id]);
  const leaves = c => { N('dispL', c, L.dispL, R, '處分投資損失'); N('derivL', c, L.derivL, R, '衍生工具損失'); N('valL', c, L.valL, R, '評價損失', '還沒賣的部位'); for (const id of ['dispL', 'derivL', 'valL']) link('cost', id, L[id]); };
  const profit = L.gp > 0 && L.op >= L.intExp && L.ni > 0 && L.outside >= 0 && L.refund >= 0;
  if (profit) {
    N('gp', 3, L.gp, G, '營業毛利', `毛利率 ${pct(L.gp)}${P ? '・' + rYoYText(L.gp, P.gp) : ''}`); N('cost', 3, L.cost, R, '營業成本');
    link('rev', 'gp', L.gp); link('rev', 'cost', L.cost);
    N('op', 4, L.op, G, '營業利益', `營業利益率 ${pct(L.op)}`);
    N('outside', 4, L.outside, G, '其他收入'); N('refund', 4, L.refund, G, '所得稅利益');
    N('fees', 4, L.fees, R, '營業費用', '手續費、規費');
    link('gp', 'op', L.op); link('gp', 'fees', L.fees);
    leaves(4);
    N('ni', 5, L.ni, G, '本期淨利', `淨利率 ${pct(L.ni)}${P ? '・' + rYoYText(L.ni, P.ni) : ''}`); N('intExp', 5, L.intExp, R, '利息費用', '融資');
    link('op', 'ni', L.op - L.intExp); link('op', 'intExp', L.intExp); link('outside', 'ni', L.outside); link('refund', 'ni', L.refund);
  } else {
    // 虧損（或毛利不夠付費用）：缺的部分由淨資產吸收，畫成一條紅色的「本期淨損」流進去
    N('outside', 2, Math.max(L.outside, 0), G, '其他收入'); N('refund', 2, Math.max(L.refund, 0), G, '所得稅利益');
    N('loss', 2, Math.max(-L.ni, 0), R, '本期淨損', `由淨資產吸收${P ? '・去年同期 ' + (P.ni >= 0 ? '淨利 ' : '淨損 ') + usd0(Math.abs(P.ni)) : ''}`);
    N('cost', 3, L.cost, R, '營業成本'); N('fees', 3, L.fees, R, '營業費用', '手續費、規費'); N('intExp', 3, L.intExp, R, '利息費用', '融資');
    N('otherL', 3, Math.max(-L.outside, 0) + Math.max(-L.refund, 0), R, '其他損失'); N('ni', 3, Math.max(L.ni, 0), G, '本期淨利');
    leaves(4);
    // 來源依序填進各個去處
    const src = ['rev', 'outside', 'refund', 'loss'].map(id => [id, nodes.find(n => n.id === id)?.v || 0]);
    for (const id of ['cost', 'fees', 'intExp', 'otherL', 'ni']) {
      let need = nodes.find(n => n.id === id)?.v || 0;
      for (const x of src) { const take = Math.min(need, x[1]); if (take > 0.5) link(x[0], id, take); x[1] -= take; need -= take; if (need <= 0.5) break; }
    }
  }
  // 版面：每欄由上往下排，置中；節點高度跟金額成正比
  const W = box.clientWidth, H = box.clientHeight, padT = 44, padB = 16, gap = 46, nw = 14, lm = 150, rm = 190;
  const cols = Math.max(...nodes.map(n => n.col)) + 1, byCol = Array.from({ length: cols }, (_, c) => nodes.filter(n => n.col === c));
  const k = Math.min(...byCol.filter(c => c.length).map(c => (H - padT - padB - gap * (c.length - 1)) / c.reduce((x, n) => x + n.v, 0)));
  const xOf = c => lm + c * (W - lm - rm - nw) / Math.max(cols - 1, 1);
  for (const c of byCol) {
    const tot = c.reduce((x, n) => x + Math.max(n.v * k, 2), 0) + gap * (c.length - 1);
    let y = padT + (H - padT - padB - tot) / 2;
    for (const n of c) { n.x = xOf(n.col); n.y = y; n.h = Math.max(n.v * k, 2); y += n.h + gap; n.outY = n.y; n.inY = n.y; }
  }
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  for (const l of links) { l.s = byId[l.a]; l.t = byId[l.b]; l.w = l.v * k; }
  for (const n of nodes) {
    for (const l of links.filter(l => l.s === n).sort((x, y) => x.t.y - y.t.y)) { l.y0 = n.outY; n.outY += l.w; }
    for (const l of links.filter(l => l.t === n).sort((x, y) => x.s.y - y.s.y)) { l.y1 = n.inY; n.inY += l.w; }
  }
  const band = l => { const x0 = l.s.x + nw, x1 = l.t.x, xm = (x0 + x1) / 2;
    return `M${x0},${l.y0}C${xm},${l.y0} ${xm},${l.y1} ${x1},${l.y1}L${x1},${l.y1 + l.w}C${xm},${l.y1 + l.w} ${xm},${l.y0 + l.w} ${x0},${l.y0 + l.w}Z`; };
  const hasOut = new Set(links.map(l => l.a));
  const label = n => {
    const name = `<tspan font-weight="700" fill="${n.color}">${esc(n.name)}</tspan>`, amt = `<tspan class="sk-amt">${usd0(n.v)}</tspan>`;
    if (n.col === 0) return `<text x="${n.x - 8}" y="${n.y + n.h / 2 - 2}" text-anchor="end">${name}<tspan x="${n.x - 8}" dy="15" class="sk-amt">${usd0(n.v)}</tspan></text>`;
    if (!hasOut.has(n.id)) return `<text x="${n.x + nw + 8}" y="${n.y + n.h / 2 - (n.sub ? 8 : 2)}">${name}<tspan x="${n.x + nw + 8}" dy="15">${amt}</tspan>${n.sub ? `<tspan x="${n.x + nw + 8}" dy="14" class="sk-sub">${esc(n.sub)}</tspan>` : ''}</text>`;
    const cx = n.x + nw / 2;
    return `<text x="${cx}" y="${n.y - (n.sub ? 22 : 8)}" text-anchor="middle">${name} ${amt}${n.sub ? `<tspan x="${cx}" dy="14" class="sk-sub">${esc(n.sub)}</tspan>` : ''}</text>`;
  };
  box.innerHTML = nodes.length ? `<svg viewBox="0 0 ${W} ${H}" class="sankey">
    ${links.map(l => `<path d="${band(l)}" fill="${l.t.color}" opacity=".28"><title>${esc(l.s.name)} → ${esc(l.t.name)}：${usd0(l.v)}</title></path>`).join('')}
    ${nodes.map(n => `<rect x="${n.x}" y="${n.y}" width="${nw}" height="${n.h}" fill="${n.color}" rx="2"/>`).join('')}
    ${nodes.map(label).join('')}
  </svg>` : UI.empty('這段期間沒有損益');
}

function renderReport() {
  const box = el('rSankey'); if (!box) return;
  const ps = rPeriods(rKind);
  if (!ps.length) { box.innerHTML = UI.empty('資料還不夠'); return; }
  if (!ps.includes(rPeriod)) rPeriod = ps.at(-1);
  el('rKind').innerHTML = UI.seg('rk', [['q', '季報'], ['y', '年報']], rKind);
  el('rPeriods').innerHTML = [...ps].reverse().map(k => `<button data-rp="${k}" class="${k === rPeriod ? 'on' : ''}">${k.length === 4 ? k : k.replace('Q', ' Q')}</button>`).join('');
  const st = realizedStats(), s = rStatement(rPeriod, st), p = rStatement(rPrev(rPeriod), st), L = s.L, P = p?.L;
  const md = d => `${+d.slice(5, 7)}/${+d.slice(8)}`, partial = s.end.date < s.b;
  el('rHead').innerHTML = `<div class="fs-co">${COMPANY}</div><div class="fs-title">${rName(rPeriod)}綜合損益表</div>
    <div class="fs-sub">${s.a.replaceAll('-', '/')} – ${(partial ? s.end.date : s.b).replaceAll('-', '/')}${partial ? `（本期還沒結束，截至 ${md(s.end.date)}）` : ''}・單位：美元</div>`;
  rSankey(box, s, p);
  // 綜合損益表（正式格式：費用、損失用括號）
  const ROWS = [['營業收入', null, 'h'], ['處分投資利益（股票）', 'dispG'], ['衍生工具利益（選擇權）', 'derivG'], ['股利收入', 'div'], ['利息收入', 'intInc'], ['金融資產評價利益', 'valG'], ['營業收入合計', 'rev', 't'],
    ['營業成本', null, 'h'], ['處分投資損失（股票）', 'dispL', '', -1], ['衍生工具損失（選擇權）', 'derivL', '', -1], ['金融資產評價損失', 'valL', '', -1], ['營業成本合計', 'cost', 't', -1],
    ['營業毛利', 'gp', 'T'], ['營業費用', null, 'h'], ['手續費及交易規費', 'fees', '', -1], ['營業利益', 'op', 'T'],
    ['營業外收入及支出', null, 'h'], ['其他收入（帳外獲利）', 'outside'], ['利息費用（融資）', 'intExp', '', -1], ['稅前淨利', 'pre', 'T'],
    ['所得稅利益（股利預扣稅退還）', 'refund'], ['本期淨利（淨損）', 'ni', 'N']];
  const cell = (Lx, key, sign) => { const v = (Lx?.[key] ?? 0) * (sign || 1); return `<td class="num">${Lx ? rNum(v) : '—'}</td><td class="num muted">${Lx && Lx.rev > 0 && Math.abs(v) >= 0.5 ? Math.round(v / Lx.rev * 100) + '%' : ''}</td>`; };
  const rows = ROWS.filter(([, key, kind]) => !key || kind || Math.abs(L[key]) >= 0.5 || (P && Math.abs(P[key]) >= 0.5)).map(([name, key, kind = '', sign]) => {
    if (!key) return `<tr class="fs-h"><td colspan="6">${name}</td></tr>`;
    const y = rYoYFmt(L[key], P?.[key]);
    return `<tr class="fs-${kind || 'i'}"><td class="l">${name}</td>${cell(L, key, sign)}${cell(P, key, sign)}<td class="num ${y == null ? 'muted' : ''}">${y ?? '—'}</td></tr>`;
  }).join('');
  el('rTable').innerHTML = `<div class="table-wrap"><table class="table fs-table"><thead><tr><th class="l">會計項目</th><th>${rName(rPeriod)}</th><th>%</th><th>${rName(rPrev(rPeriod))}</th><th>%</th><th>年增率</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const pctOf = v => L.rev > 0 ? pctPlain(v / L.rev, 1) : '—';
  el('rRatios').innerHTML = UI.tiles([
    { k: '營業收入', v: usd0(L.rev), s: rYoYText(L.rev, P?.rev) || '去年同期沒有資料' },
    { k: '本期淨利', v: usd0(L.ni, { sign: true }), vcls: `num ${cls(L.ni)}`, s: rYoYText(L.ni, P?.ni) || '去年同期沒有資料' },
    { k: '毛利率', v: pctOf(L.gp), s: P && P.rev > 0 ? `去年同期 ${pctPlain(P.gp / P.rev, 1)}` : '' },
    { k: '營業利益率', v: pctOf(L.op), s: P && P.rev > 0 ? `去年同期 ${pctPlain(P.op / P.rev, 1)}` : '' },
    { k: '淨利率', v: pctOf(L.ni), s: P && P.rev > 0 ? `去年同期 ${pctPlain(P.ni / P.rev, 1)}` : '' },
    { k: '股東權益報酬率', v: pct(L.roe), vcls: `num ${cls(L.roe)}`, s: '淨利 ÷ 平均淨資產' }], 'cols-2');
}

// ================= 資產時光機 =================
const TM = { i: null, playing: null, prices: null, loading: false, built: false, speed: 1 };
function tmModel() {
  // 每一天收盤後的持股（從現在的持股沿著交易往回推）、還開著的選擇權
  if (TM.model && TM.model.n === data.transactions.length && TM.model.h === data.history.length) return TM.model;
  const hist = data.history.filter(x => x.usd > 0), dates = hist.map(x => x.date);
  const trades = data.transactions.filter(t => t.type === 'buy' || t.type === 'sell').sort((a, b) => b.date.localeCompare(a.date));
  const pos = {}; for (const [s, hh] of Object.entries(data.holdings)) pos[s] = hh.shares;
  const snaps = new Array(dates.length); let k = 0;
  for (let i = dates.length - 1; i >= 0; i--) {
    while (k < trades.length && trades[k].date > dates[i]) { const t = trades[k++]; pos[t.symbol] = round((pos[t.symbol] || 0) - (t.type === 'buy' ? t.shares : -t.shares)); }
    snaps[i] = Object.fromEntries(Object.entries(pos).filter(([, q]) => q > 1e-6));
  }
  const opts = data.transactions.filter(t => t.type === 'option').sort((a, b) => a.date.localeCompare(b.date));
  const optAt = d => { const q = {}; for (const t of opts) { if (t.date > d) break; q[t.symbol] = round((q[t.symbol] || 0) + (t.qty || 0)); }
    return Object.entries(q).filter(([s, n]) => n && (occ(s)?.exp || '') >= d); };
  const splits = data.transactions.filter(t => t.split);
  const princ = principalSeries('USD');
  TM.model = { n: data.transactions.length, h: data.history.length, hist, dates, snaps, optAt, splits, princ };
  return TM.model;
}
async function tmLoadPrices(M) {
  if (TM.prices || TM.loading) return;
  TM.loading = true;
  // 持股，加上選擇權的標的（算 delta 要用標的股價和波動率）
  const roots = data.transactions.filter(t => t.type === 'option').map(t => occ(t.symbol)?.root).filter(Boolean);
  const syms = [...new Set([...M.snaps.flatMap(s => Object.keys(s)), ...roots])];
  try { TM.prices = await (await fetch(`/api/history?symbols=${encodeURIComponent(syms.join(','))}&from=${M.dates[0]}`)).json(); } catch { TM.prices = {}; }
  TM.loading = false; tmUpdate();
}
function tmPrice(M, sym, i) {
  // 那天的收盤價；Yahoo 的歷史價已按分割調整過，分割前的日子乘回倍數
  const s = TM.prices?.[sym], d = M.dates[i];
  let p = s && !s.error ? lastOnOrBefore(s, d) : null;
  if (p == null) { const t = data.transactions.filter(x => x.symbol === sym && x.price && x.date <= d).at(-1); return t?.price ?? null; }
  for (const t of M.splits) if (t.symbol === sym && d < t.date) {
    const j = M.dates.findIndex(x => x >= t.date) - 1, before = j >= 0 ? M.snaps[j][sym] : null;
    if (before) p *= (before + t.shares) / before;
  }
  return p;
}
function tmVol(sym, d) {
  // 標的過去 30 個交易日的實際波動率（年化）
  const s = TM.prices?.[sym]; if (!s || s.error) return null;
  const ds = Object.keys(s).filter(x => x <= d).sort().slice(-31); if (ds.length < 10) return null;
  const r = ds.slice(1).map((x, i) => Math.log(s[x] / s[ds[i]])), m = avg(r);
  return Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1) * 252);
}
function tmOptExposure(M, sym, q, i) {
  // 選擇權曝險＝口數 × 100 × delta × 標的股價 × 標的槓桿倍數（delta 用 Black-Scholes，波動率用標的過去 30 天）
  const o = occ(sym), d = M.dates[i], S = o && tmPrice(M, o.root, i);
  if (!S) return null;
  const T = Math.max(days(d, o.exp) / 365, 1 / 365), vol = tmVol(o.root, d) || 0.5;
  return q * 100 * bsModel(S, o.strike, T, 0.04, vol, o.call).delta * S * levOf(o.root);
}
function tmItems(M, i) {
  // 那天的方塊：股票（槓桿 ETF 乘倍數）、選擇權（delta 換算）；短債 ETF（BIL、BOXX、SGOV…）當現金，不算曝險
  // total＝方塊面積加總（看空的也佔面積）；net＝看多減看空，拿來算槓桿率
  const rows = Object.entries(M.snaps[i]).map(([s, q]) => {
    const px = tmPrice(M, s, i), v = px != null ? q * px : null, cash = grp(s) === 'CASH', lev = cash ? 0 : levOf(s);
    return { s, q, v, exp: v == null ? null : v * lev, bear: lev < 0, lev, cash };
  }).filter(r => r.v == null || r.v > 0.5).sort((a, b) => (b.v ?? 0) - (a.v ?? 0));
  const opts = M.optAt(M.dates[i]).map(([s, q]) => ({ s, q, exp: tmOptExposure(M, s, q, i) }));
  const all = [...rows, ...opts].map(r => r.exp || 0);
  return { rows, opts, total: all.reduce((a, x) => a + Math.abs(x), 0), net: all.reduce((a, x) => a + x, 0), short: all.reduce((a, x) => a + Math.min(x, 0), 0) };
}
function tmRef(M) {
  // 整張方塊圖代表的尺度：開戶以來最大的那天（曝險或淨資產取大的）；股價載入後算一次
  if (TM.ref && TM.refN === M.dates.length) return TM.ref;
  let ref = 0;
  for (let i = 0; i < M.dates.length; i++) ref = Math.max(ref, tmItems(M, i).total, M.hist[i].usd);
  TM.ref = ref * 1.02; TM.refN = M.dates.length;
  return TM.ref;
}
function tmBuild(M) {
  // 只建一次：滑桿、快速跳轉、走勢圖（拖滑桿時只移動游標，不重畫）
  const n = M.dates.length;
  const jumps = [['開戶那天', 0], ...[...new Set(M.dates.map(d => d.slice(0, 4)))].slice(1).map(y => [`${y} 年初`, M.dates.findIndex(d => d.startsWith(y))]),
    ['最高點', M.hist.reduce((b, x, i) => x.usd > M.hist[b].usd ? i : b, 0)], ['今天', n - 1]];
  el('tmControls').innerHTML = `<div class="tm-row">
      <div class="tm-date"><b id="tmDate"></b><span class="sub" id="tmDay"></span></div>
      <div class="tm-track"><input type="range" class="tm-slider" id="tmSlider" min="0" max="${n - 1}" value="${TM.i}">
        <div class="tm-years">${[...new Set(M.dates.map(d => d.slice(0, 4)))].map(y => { const i = M.dates.findIndex(d => d.startsWith(y)); return `<span style="left:${i / (n - 1) * 100}%">${y}</span>`; }).join('')}</div></div>
      <div class="tm-btns"><button class="ghost" data-tm="-1" title="前一天（←）">◀</button><button class="primary tm-play" data-tm="play" id="tmPlay">▶ 播放</button>
        <button class="ghost" data-tm="1" title="後一天（→）">▶</button>${UI.seg('tmspeed', [['1', '1×'], ['4', '4×']], TM.speed)}</div>
    </div>
    <div class="chips tm-jumps">${jumps.map(([t, i]) => `<button data-tmj="${i}">${t}</button>`).join('')}<span class="sub">鍵盤 ← → 一天一天走，空白鍵播放</span></div>`;
  // 走勢圖
  const box = el('tmChart'), W = box.clientWidth, H = box.clientHeight, padL = 56, padR = 10, padT = 10, padB = 20;
  const vals = M.hist.map(x => x.usd), pv = M.dates.map(d => M.princ[d] ?? 0);
  const min = 0, max = Math.max(...vals, ...pv) * 1.06;
  const x = i => padL + i / (n - 1) * (W - padL - padR), y = v => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  TM.x = x; TM.y = y;
  const line = arr => arr.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1)).join('');
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    ${[0, 0.5, 1].map(f => max * f).map(t => `<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" stroke="var(--border)" stroke-dasharray="2 4"/><text class="axis-text" x="${padL - 8}" y="${y(t) + 4}" text-anchor="end">$${(t / 1e3).toFixed(0)}K</text>`).join('')}
    <path d="${line(pv)}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z" fill="var(--text-3)" opacity=".12"/>
    <path d="${line(pv)}" fill="none" stroke="var(--text-3)" stroke-width="1.2" stroke-dasharray="4 4"/>
    <path d="${line(vals)}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
    <rect id="tmShade" x="${padL}" y="${padT}" height="${H - padT - padB}" fill="var(--surface)" opacity=".55"/>
    <line id="tmCur" y1="${padT}" y2="${H - padB}" stroke="var(--accent)" stroke-width="1.5"/>
    <circle id="tmDot" r="5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>
    <rect x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent" id="tmHit" style="cursor:pointer"/>
  </svg>`;
  const pick = e => { const mx = e.clientX - box.getBoundingClientRect().left; tmGo(Math.round((mx - padL) / (W - padL - padR) * (n - 1))); };
  box.querySelector('#tmHit').addEventListener('pointerdown', e => { pick(e); const mv = ev => pick(ev); box.addEventListener('pointermove', mv); window.addEventListener('pointerup', () => box.removeEventListener('pointermove', mv), { once: true }); });
  el('tmSlider').addEventListener('input', e => tmGo(+e.target.value));
  TM.built = true;
}
function tmGo(i) {
  const M = tmModel(); TM.i = Math.max(0, Math.min(M.dates.length - 1, i)); store.set('tm', M.dates[TM.i]); tmUpdate();
}
function tmPlay(on) {
  clearInterval(TM.playing); TM.playing = null;
  const b = el('tmPlay');
  if (on) {
    const M = tmModel(); if (TM.i >= M.dates.length - 1) TM.i = 0;
    TM.playing = setInterval(() => { const M2 = tmModel(); if (TM.i >= M2.dates.length - 1) return tmPlay(false); tmGo(TM.i + TM.speed); }, 250);   // 1× 每 0.25 秒走一個交易日
  }
  if (b) b.textContent = on ? '⏸ 暫停' : '▶ 播放';
}
function tmUpdate() {
  if (!el('tmControls')) return;
  const M = tmModel(), n = M.dates.length; if (n < 2) { el('tmControls').innerHTML = UI.empty('資料還不夠'); return; }
  if (TM.i == null) { const saved = store.get('tm', ''); const j = M.dates.indexOf(saved); TM.i = j >= 0 ? j : n - 1; }
  if (!TM.built || !el('tmSlider')) { TM.built = false; tmBuild(M); }
  tmLoadPrices(M);
  const i = TM.i, d = M.dates[i], h = M.hist[i], p = M.princ[d] ?? h.usd, gain = h.usd - p;
  el('tmSlider').value = i;
  el('tmDate').textContent = `${+d.slice(0, 4)} 年 ${+d.slice(5, 7)} 月 ${+d.slice(8)} 日（${WEEK[weekday(d)]}）`;
  el('tmDay').textContent = `開戶第 ${days(M.dates[0], d) + 1} 天`;
  // 走勢圖游標
  const cx = TM.x(i), cy = TM.y(h.usd);
  for (const id of ['tmCur']) { const l = el(id); l.setAttribute('x1', cx); l.setAttribute('x2', cx); }
  el('tmDot').setAttribute('cx', cx); el('tmDot').setAttribute('cy', cy);
  const sh = el('tmShade'); sh.setAttribute('x', cx); sh.setAttribute('width', Math.max(0, TM.x(n - 1) - cx));
  // 那天的數字（股價載入後槓桿率用這頁算的淨曝險，跟方塊圖一致）
  const { rows, opts, total: expTotal, net, short: expShort } = tmItems(M, i);
  const lev = TM.prices && h.usd > 0 ? net / h.usd : h.exp != null ? h.exp / h.usd : null;
  el('tmStats').innerHTML = UI.tiles([
    { k: '總資產', v: usd0(h.usd) },
    { k: '投入的本金', v: usd0(p) },
    { k: '賺到的錢', v: usd0(gain, { sign: true }), vcls: `num ${cls(gain)}`, s: p > 0 ? `本金的 ${money(pct(gain / p))}` : '' },
    { k: '槓桿率', v: lev != null ? lev.toFixed(2) + 'x' : '—' }], 'cols-2');
  // 那天的持股：方塊圖＋清單
  // 方塊大小＝曝險：股票用市值、槓桿 ETF 乘倍數、選擇權用 delta 換算；短債 ETF 當現金不畫
  const stk = rows.filter(r => !r.cash), bills = rows.filter(r => r.cash);
  const tot = stk.reduce((a, r) => a + (r.exp || 0), 0), billV = bills.reduce((a, r) => a + (r.v || 0), 0), optExp = opts.reduce((a, o) => a + (o.exp || 0), 0);
  const oc = s => occ(s), short = s => { const o = oc(s); return `${o.root} ${o.exp.slice(5).replace('-', '/')} ${o.strike}${o.call ? 'C' : 'P'}`; };
  const tbox = el('tmTreemap');
  const items = [...rows.filter(r => r.exp).map(r => ({ key: r.s, v: Math.abs(r.exp), bear: r.bear, sub: r.lev !== 1 && Math.abs(r.lev) !== 1 ? `${r.lev}× 槓桿` : r.bear ? '看空' : '' })),
                 ...opts.filter(o => o.exp).map(o => ({ key: short(o.s), v: Math.abs(o.exp), opt: true, sub: `${o.q > 0 ? '買方' : '賣方'}${o.exp < 0 ? '・看空' : ''}` }))].sort((a, b) => b.v - a.v);
  if (!items.length) tbox.innerHTML = UI.empty('這天沒有持股');
  else {
    const vMax = Math.max(...items.map(r => r.v)), W = tbox.clientWidth, H = tbox.clientHeight;
    // 絕對大小：虛線框是那天的淨資產，大小跟開戶以來最大的那天比（幅度壓小，邊長取 0.12 次方）
    // 方塊群跟虛線框的面積比＝真實的曝險／淨資產；槓桿大到放不下時，虛線框跟著縮小
    const ref = TM.prices ? tmRef(M) : null, L = h.usd > 0 ? expTotal / h.usd : 1;
    const kE = ref ? Math.min(Math.min(1, h.usd / ref) ** 0.12, 1 / Math.sqrt(Math.max(L, 1))) : 1, kX = ref ? kE * Math.sqrt(L) : 1;
    const area = { x: 0, y: H - H * kX, w: W * kX, h: H * kX };
    tbox.innerHTML = (ref ? `<div class="tm-equity" style="left:0;top:${H - H * kE}px;width:${W * kE}px;height:${H * kE}px"><div class="tm-eq-label">淨資產 ${money(usd0(h.usd))}</div></div>` : '')
      + squarify(items, area).map(t => {
      const mix = Math.round(14 + 66 * Math.sqrt(t.v / vMax)), big = t.w > 64 && t.h > 38, mid = t.w > 38 && t.h > 22;
      const c1 = `color-mix(in srgb, var(--accent) ${mix}%, var(--surface))`, c2 = `color-mix(in srgb, var(--accent) ${Math.max(mix - 14, 6)}%, var(--surface))`;
      const bg = t.opt ? `repeating-linear-gradient(135deg, ${c1} 0 7px, ${c2} 7px 14px)` : c1;   // 選擇權用斜線紋路
      return `<div class="tm-tile" style="left:${t.x}px;top:${t.y}px;width:${t.w}px;height:${t.h}px;background:${bg};color:${mix > 55 ? '#fff' : 'var(--text)'}">
        ${mid ? `<b style="font-size:${big ? Math.min(18, 11 + Math.sqrt(t.w * t.h) / 18) : 11}px">${esc(t.key)}</b>` : ''}${big ? `<span style="color:inherit;opacity:.85">${t.sub ? t.sub + '・' : ''}${pctPlain(t.v / h.usd, 1)}</span>` : ''}</div>`;
    }).join('') + (TM.prices ? `<div class="tm-scale">${expShort ? `淨曝險 ${money(usd0(net))}（看多 ${money(usd0(net - expShort))}、看空 ${money(usd0(-expShort))}）` : `曝險 ${money(usd0(net))}`}・是淨資產的 ${money((lev ?? 0).toFixed(2) + ' 倍')}</div>` : '<div class="tm-loading">股價載入中，先用成交價估算</div>');
  }
  // 清單的數字就是曝險：股票＋選擇權加起來＝淨曝險；短債另外列，不加進去
  el('tmHoldNote').innerHTML = rows.length || opts.length ? `股票曝險 ${money(usd0(tot))}${opts.length ? `・選擇權曝險 ${money(usd0(optExp, { sign: true }))}` : ''}${bills.length ? `・短債（當現金）${money(usd0(billV))}` : ''}` : '';
  el('tmHoldings').innerHTML = (stk.length ? `<div class="tm-hold">${stk.map(r => `<div class="kv"><span><b>${esc(r.s)}</b> <span class="muted">${fmtShares(r.q)} 股${r.lev !== 1 ? `・${r.lev}×，市值 ${usd0(r.v ?? 0)}` : ''}</span></span><span class="num">${r.exp == null ? '—' : usd0(r.exp, { sign: r.exp < 0 })}</span></div>`).join('')}</div>` : '')
    + (opts.length ? `<div class="kv-title" style="margin-top:10px">選擇權（曝險用 delta 換算）</div>${opts.map(o => `<div class="kv"><span>${esc(optName(o.s))} <span class="muted">${o.q > 0 ? '買' : '賣'} ${Math.abs(o.q)} 口</span></span><span class="num">${o.exp == null ? '—' : usd0(o.exp, { sign: true })}</span></div>`).join('')}` : '')
    + (bills.length ? `<div class="kv-title" style="margin-top:10px">短債 ETF（當現金，不算曝險）</div>${bills.map(r => `<div class="kv"><span><b>${esc(r.s)}</b> <span class="muted">${fmtShares(r.q)} 股</span></span><span class="num muted">${r.v == null ? '—' : usd0(r.v)}</span></div>`).join('')}` : '');
  // 那天發生的事
  const evs = [];
  for (const t of data.transactions) {
    if (t.date !== d) continue;
    if (t.type === 'buy' || t.type === 'sell') evs.push([t.split ? '分割' : t.type === 'buy' ? '買進' : '賣出', `${esc(t.symbol)} ${fmtShares(t.shares)} 股${t.price ? ` @ ${money(usd(t.price))}` : ''}`]);
    else if (t.type === 'option') evs.push([t.action === 'close' ? '平倉' : '開倉', `${t.qty > 0 ? '買' : '賣'} ${esc(optName(t.symbol, t.desc))}`]);
    else if (t.type === 'income' && /^(入金|帳外獲利)/.test(t.category || '')) evs.push([t.category === '入金' ? '入金' : '帳外獲利', money(usd(t.amount))]);
    else if (t.type === 'expense' && /^出金/.test(t.category || '')) evs.push(['出金', money(usd(t.amount))]);
  }
  for (const j of data.journal || []) if (j.date === d) evs.push(['日記', esc(j.text.length > 80 ? j.text.slice(0, 80) + '…' : j.text)]);
  for (const pl of data.plans || []) if (pl.created === d) evs.push(['寫計畫', `${esc(pl.sym)}：${esc(pl.thesis || '')}`]);
  const last = evs.length ? null : [...data.transactions].filter(t => ['buy', 'sell', 'option'].includes(t.type) && t.date < d).map(t => t.date).sort().at(-1);
  el('tmEvents').innerHTML = evs.length ? evs.map(([k, v]) => `<div class="tm-ev"><span class="badge">${k}</span><span>${v}</span></div>`).join('')
    : UI.empty(`這天沒有交易${last ? `<br><span class="sub">上一次交易是 ${last}（${days(last, d)} 天前）</span>` : ''}`, true);
}

// ================= 掛到畫面更新與事件 =================
window.EXTRA_PARTS = [['personaBox', renderPersona], ['universeChart', renderUniverse], ['tmControls', tmUpdate], ['rSankey', renderReport]];
document.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.py) { pYear = b.dataset.py; renderPersona(); }
  else if (b.dataset.ur) { uRange = b.dataset.ur; renderUniverse(); }
  else if (b.dataset.rk) { rKind = b.dataset.rk; rPeriod = null; renderReport(); }
  else if (b.dataset.rp) { rPeriod = b.dataset.rp; renderReport(); }
  else if (b.dataset.tm === 'play') tmPlay(!TM.playing);
  else if (b.dataset.tm) { tmPlay(false); tmGo(TM.i + +b.dataset.tm); }
  else if (b.dataset.tmj != null) { tmPlay(false); tmGo(+b.dataset.tmj); }
  else if (b.dataset.tmspeed) { TM.speed = +b.dataset.tmspeed; document.querySelectorAll('[data-tmspeed]').forEach(x => x.classList.toggle('on', x === b)); }
});
document.addEventListener('keydown', e => {
  if (!el('tmControls') || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && document.activeElement.id !== 'tmSlider') return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); tmPlay(false); tmGo(TM.i + (e.key === 'ArrowLeft' ? -1 : 1)); }
  else if (e.key === ' ') { e.preventDefault(); tmPlay(!TM.playing); }
});
// 視窗大小改變：時光機的走勢圖要重畫
window.addEventListener('resize', () => { TM.built = false; });
})();
