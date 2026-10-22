// 共用元件：每一頁都用同一套寫法產生畫面，樣式在 app.css 的「元件」那一段
const UI = {
  empty: (text, small = false) => `<div class="empty${small ? ' sm' : ''}">${text}</div>`,
  note: text => `<div class="note">${text}</div>`,
  // 數字卡片：{ k: 標題, v: 數字, s: 補充（選填）, vcls: 數字的樣式（預設 num） }
  tile: ({ k, v, s = '', cls = '', vcls = 'num' }) =>
    `<div class="tile ${cls}"><div class="k">${k}</div><div class="v ${vcls}">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`,
  tiles: (items, cls = '') => `<div class="tiles ${cls}">${items.filter(Boolean).map(UI.tile).join('')}</div>`,
  // 左右對齊的一列：左邊標題、右邊數值
  kv: (k, v) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`,
  kvGroup: (title, body) => `<div class="kv-group">${title ? `<div class="kv-title">${title}</div>` : ''}${body}</div>`,
  badge: (text, variant = '') => `<span class="badge ${variant}">${text}</span>`,
  // 分段按鈕：items = [[值, 文字], ...]，按鈕帶 data-<attr>
  seg: (attr, items, active) => `<span class="seg">${items.map(([v, t]) =>
    `<button data-${attr}="${v}" class="${String(v) === String(active) ? 'on' : ''}">${t}</button>`).join('')}</span>`,
  table: (head, rows, cls = '') => `<div class="table-wrap"><table class="table ${cls}"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`,
  more: (summary, body) => `<details class="more"><summary>${summary}</summary>${body}</details>`,
  // 月份清單的文字：連續三個月以上寫成「10–12 月」，其他寫成「3、10 月」
  monthsLabel: ms => {
    const n = [...ms].map(Number).sort((a, b) => a - b);
    return (n.length > 2 && n.every((v, i) => !i || v === n[i - 1] + 1) ? `${n[0]}–${n.at(-1)}` : n.join('、')) + ' 月';
  },
};

// 期間選擇器：一個按鈕顯示目前的期間，點開選年份（清單，年份再多也不會變長）和月份（可複選、季度快選）
// value = { y: 'all' 或 '2025', months: Set('01'…'12') }；years() 回傳有資料的年份（新的在前）；hasMonth(y, m) 那個月有沒有資料
UI.periodPicker = function (host, { years, hasMonth, value, onChange }) {
  let open = false;
  const label = () => value.y === 'all' ? '全部期間' : `${value.y} 年${value.months.size ? ' ' + UI.monthsLabel(value.months) : ''}`;
  const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
  const QUARTERS = [['Q1', ['01', '02', '03']], ['Q2', ['04', '05', '06']], ['Q3', ['07', '08', '09']], ['Q4', ['10', '11', '12']]];
  const same = (a, b) => a.length === b.size && a.every(m => b.has(m));
  const draw = () => {
    const y = value.y, ys = years();
    host.innerHTML = `<button type="button" class="picker-btn ${open ? 'open' : ''}" data-pp="toggle"><span>${label()}</span><i>▾</i></button>
      ${open ? `<div class="popover pp">
        <div class="pp-years">${[['all', '全部期間'], ...ys.map(v => [v, v + ' 年'])].map(([v, t]) =>
          `<button type="button" data-pp-y="${v}" class="${v === y ? 'on' : ''}">${t}</button>`).join('')}</div>
        <div class="pp-main">${y === 'all' ? '<div class="pp-hint">選一個年份，再選月份</div>' : `
          <div class="pp-quick"><button type="button" data-pp-q="all" class="chip ${value.months.size ? '' : 'on'}">整年</button>${QUARTERS.map(([q, ms]) =>
            `<button type="button" data-pp-q="${q}" class="chip ${same(ms, value.months) ? 'on' : ''}" ${ms.some(m => hasMonth(y, m)) ? '' : 'disabled'}>${q}</button>`).join('')}</div>
          <div class="pp-months">${MONTHS.map(m => `<button type="button" data-pp-m="${m}" class="${value.months.has(m) ? 'on' : ''}" ${hasMonth(y, m) ? '' : 'disabled'}>${+m} 月</button>`).join('')}</div>
          <div class="pp-hint">月份可以複選</div>`}
        </div></div>` : ''}`;
  };
  const set = v => { value = v; draw(); onChange(value); };
  host.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !host.contains(b)) return;
    if (b.dataset.pp === 'toggle') { open = !open; draw(); return; }
    if (b.dataset.ppY) set({ y: b.dataset.ppY, months: new Set() });
    else if (b.dataset.ppQ) set({ ...value, months: new Set(b.dataset.ppQ === 'all' ? [] : QUARTERS.find(([q]) => q === b.dataset.ppQ)[1].filter(m => hasMonth(value.y, m))) });
    else if (b.dataset.ppM) { const ms = new Set(value.months); ms.has(b.dataset.ppM) ? ms.delete(b.dataset.ppM) : ms.add(b.dataset.ppM); set({ ...value, months: ms }); }
  });
  // 點外面或按 Esc 收起來
  // （用事件當下的路徑判斷：點了面板裡的按鈕後畫面會重畫，按鈕已經不在頁面上）
  document.addEventListener('click', e => { if (open && !e.composedPath().includes(host)) { open = false; draw(); } });
  document.addEventListener('keydown', e => { if (open && e.key === 'Escape') { open = false; draw(); } });
  draw();
  return { update(v) { value = v; draw(); } };
};
