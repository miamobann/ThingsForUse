/* 지출 분석 화면 */
(function () {
  'use strict';
  const C = window.Core;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
  const man = (n) => (Math.abs(n) >= 10000 ? `${(n / 10000).toFixed(Math.abs(n) >= 1000000 ? 0 : 1).replace(/\.0$/, '')}만` : `${Math.round(n).toLocaleString()}`);
  const UNCAT = '미분류';
  const NOSUB = '(세부 없음)';

  // ---------- 저장 ----------
  // 구글 앱스 스크립트 웹 앱으로 열면(GAS) 내역은 시트 '내역'에서 읽고, 분류는 시트 '분류 자료'에 저장한다.
  // 파일로 열면 지금처럼 이 브라우저(localStorage)에 저장한다.
  const GAS = typeof google !== 'undefined' && google.script && google.script.run ? google.script.run : null;
  const KEY = 'spending-analyzer.v1';
  const KEY_API = 'spending-analyzer.apikey';
  function load() {
    if (GAS) return null;
    try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s) return s; } catch (e) { /* 비어 있음 */ }
    return null;
  }
  const S = Object.assign({
    files: [], memory: {}, overrides: {}, tree: JSON.parse(JSON.stringify(C.DEFAULT_TREE)),
    dismissed: {}, opts: { excludeTransfer: false }, rules: [],
  }, load() || {});
  if (!Array.isArray(S.rules)) S.rules = [];
  // GAS 상태: 시트에서 읽은 시각, 마지막으로 저장한 '분류 자료' 줄, 비밀번호·AI 키가 있는지
  const G = { loaded: false, loading: false, at: null, meta: [], hasSync: false, hasAi: false, txCount: 0, saving: null, again: false };
  function gasCall(fn, ...args) {
    return new Promise((ok, no) => GAS.withSuccessHandler(ok).withFailureHandler((e) => no(new Error((e && e.message) || String(e))))[fn](...args));
  }
  function save() {
    if (GAS) { if (G.loaded) { clearTimeout(G.saveT); G.saveT = setTimeout(saveSheet, 500); } return; }
    try { localStorage.setItem(KEY, JSON.stringify(S)); }
    catch (e) { toast('브라우저 저장 공간이 부족해요. 설정에서 백업 파일을 내보내 두세요.'); }
  }
  // 바뀐 줄만 시트에 보낸다. 보내는 중에 또 바뀌면 끝나고 한 번 더.
  async function saveSheet() {
    if (G.saving) { G.again = true; return; }
    const next = C.stateToMeta(S);
    const { puts, dels } = C.metaDiff(G.meta, next);
    if (!puts.length && !dels.length) return;
    G.saving = true;
    try { await gasCall('saPutMeta', puts, dels); G.meta = next; }
    catch (e) { toast(`시트에 저장하지 못했어요: ${e.message}`); }
    G.saving = null;
    if (G.again) { G.again = false; saveSheet(); }
  }
  async function loadSheet() {
    G.loading = true; render();
    try {
      const d = await gasCall('saLoad');
      const st = C.metaToState(d.meta);
      const rows = C.parseAppRows([d.header || C.CSV_COLS.concat(C.EXTRA_COLS)].concat(d.tx));
      Object.assign(S, { memory: st.memory, overrides: st.overrides, rules: st.rules, dismissed: st.dismissed,
        tree: st.tree || S.tree, opts: st.opts || S.opts });
      S.files = S.files.filter((f) => f.key !== 'app');
      if (rows.rows.length) S.files.push({ key: 'app', kind: '구글 시트 내역', name: "시트 '내역'", label: C.rangeLabel(rows.rows), rows: rows.rows, problems: rows.problems, addedAt: Date.now() });
      G.meta = C.stateToMeta(S); G.hasSync = d.hasSync; G.hasAi = d.hasAi; G.txCount = d.tx.length; G.at = new Date(); G.loaded = true;
      // 처음 여는 시트면 기본 분류 목록·설정을 써 둔다
      if (!d.meta.length) { G.meta = []; save(); }
    } catch (e) { toast(`시트를 읽지 못했어요: ${e.message}`); }
    G.loading = false; recompute(); render();
  }
  function apiKey(v) {
    if (GAS) return G.hasAi ? 'set' : '';
    try { if (v === undefined) return localStorage.getItem(KEY_API) || ''; if (v) localStorage.setItem(KEY_API, v); else localStorage.removeItem(KEY_API); } catch (e) { /* */ }
    return v;
  }
  async function callAI(prompt) {
    if (GAS) return gasCall('saAi', prompt);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey(), 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error((j.error && j.error.message) || res.status);
    return j.content.map((c) => c.text || '').join('');
  }

  // ---------- 계산 ----------
  let D = null; // {rows, report, items, months}
  function recompute() {
    const combined = C.combine(S.files);
    const state = { memory: S.memory, overrides: S.overrides, rules: S.rules };
    const items = combined.rows.map((r) => {
      const c = C.classify(r, state);
      const ov = S.overrides[r.id] || {};
      const rr = { ...r, cat: c.cat };
      let amt = C.spendAmount(rr, S.opts);
      if (ov.exclude) amt = 0;
      if (ov.include && !r.canceled && r.amount > 0 && !r.offsetTo) amt = C.netAmount(r);
      return { r, c, amt, cat: c.cat || UNCAT, sub: c.sub || NOSUB, ym: r.date.slice(0, 7) };
    });
    const months = [...new Set(items.map((x) => x.ym))].sort();
    D = { ...combined, items, months };
  }
  function cats() {
    const set = new Set(Object.keys(S.tree));
    D && D.items.forEach((x) => x.c.cat && set.add(x.c.cat));
    return [...set];
  }
  // 대분류 색: 트리 순서대로 고정 (순위가 아니라 이름에 붙는다)
  function catColor(cat) {
    if (cat === UNCAT) return 'var(--s-other)';
    const i = cats().indexOf(cat);
    return i >= 0 && i < 8 ? `var(--s${i + 1})` : 'var(--s-other)';
  }

  // ---------- 기간 ----------
  const today = new Date();
  const thisYM = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const todayStr = `${thisYM}-${String(today.getDate()).padStart(2, '0')}`;
  const UI = { tab: 'dash', period: '12', from: '', to: '', drill: null, trendCat: '', applyTo: 'one',
    table: { store: '', storeName: '', cat: '', sub: '', pay: '', src: '', q: '', uncat: false, showOff: true, sort: 'date', dir: -1, limit: 300 } };
  function range() {
    const p = UI.period;
    if (p === 'custom') return [UI.from || D.months[0], UI.to || D.months[D.months.length - 1]];
    if (p === 'all') return [D.months[0], D.months[D.months.length - 1]];
    if (p === 'last') return [C.addMonths(thisYM, -1), C.addMonths(thisYM, -1)];
    const n = +p; return [C.addMonths(thisYM, -(n - 1)), thisYM];
  }
  function inRange(x) { const [a, b] = range(); return x.ym >= a && x.ym <= b; }
  function monthsIn() {
    const [a, b] = range(); const out = []; let m = a;
    while (m <= b && out.length < 240) { out.push(m); m = C.addMonths(m, 1); }
    return out;
  }
  function periodControl() {
    const opts = [['1', '이번 달'], ['last', '지난달'], ['3', '3개월'], ['6', '6개월'], ['12', '12개월'], ['all', '전체'], ['custom', '직접']];
    let h = `<div class="seg" id="period">${opts.map(([v, l]) => `<button data-v="${v}" class="${UI.period === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    if (UI.period === 'custom') {
      const [a, b] = range();
      h += ` <input type="month" id="from" value="${a}"> ~ <input type="month" id="to" value="${b}">`;
    }
    return h;
  }
  function bindPeriod(root) {
    root.querySelectorAll('#period button').forEach((b) => b.onclick = () => { UI.period = b.dataset.v; UI.drill = null; render(); });
    const f = $('#from', root), t = $('#to', root);
    if (f) f.onchange = () => { UI.from = f.value; render(); };
    if (t) t.onchange = () => { UI.to = t.value; render(); };
  }

  // ---------- 공통 UI ----------
  const tip = document.createElement('div'); tip.className = 'tip'; document.body.appendChild(tip);
  // 누르면 화면을 다시 그려서 마우스 아래 요소가 사라진다(mouseleave가 안 옴) → 클릭·스크롤·다시 그릴 때 숨김
  const hideTip = () => { tip.style.display = 'none'; };
  document.addEventListener('click', hideTip, true);
  document.addEventListener('scroll', hideTip, true);
  document.addEventListener('mousemove', (e) => { if (tip.style.display === 'block' && !e.target.closest('[data-tip]')) hideTip(); });
  function bindTips(root) {
    root.querySelectorAll('[data-tip]').forEach((el) => {
      el.addEventListener('mousemove', (e) => {
        tip.innerHTML = el.dataset.tip; tip.style.display = 'block';
        const w = tip.offsetWidth; const x = e.clientX + 14 + w > innerWidth ? e.clientX - w - 14 : e.clientX + 14;
        tip.style.left = `${x}px`; tip.style.top = `${e.clientY + 14}px`;
      });
      el.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    });
  }
  let toastT = null;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.style.display = 'block';
    clearTimeout(toastT); toastT = setTimeout(() => { t.style.display = 'none'; }, 3500);
  }
  function rowTable(list, opts = {}) {
    if (!list.length) return '<p class="muted">내역이 없어요.</p>';
    const lim = opts.limit || 200;
    const body = list.slice(0, lim).map((x) => `<tr class="${x.amt === 0 && !opts.raw ? 'off' : ''}">
      <td>${x.r.date}</td><td class="muted">${x.r.time || ''}</td>
      <td>${esc(x.r.store)}${x.r.rawStore && x.r.rawStore !== x.r.store ? `<div class="muted" style="font-size:12px">${esc(x.r.rawStore)}</div>` : ''}</td>
      <td class="num">${won(x.r.amount)}</td><td>${esc(x.cat)}${x.c.sub ? ` · ${esc(x.c.sub)}` : ''}</td>
      <td class="muted">${esc(x.r.pay)}</td><td class="memo">${esc(x.r.memo)}</td></tr>`).join('');
    return `<div class="tablewrap"><table><thead><tr><th>날짜</th><th>시각</th><th>가게</th><th class="num">금액</th><th>분류</th><th>결제</th><th>메모</th></tr></thead><tbody>${body}</tbody></table></div>${list.length > lim ? `<p class="muted">외 ${list.length - lim}건</p>` : ''}`;
  }

  // ---------- SVG 막대 (월별 누적) ----------
  function stackedColumns(months, series, valueOf, colorOf, labelOf) {
    const W = 760, H = 240, L = 46, B = 26, T = 10;
    const totals = months.map((m) => C.sum(series.map((s) => Math.max(0, valueOf(s, m)))));
    const max = Math.max(1, ...totals);
    const step = niceStep(max / 4); const top = Math.ceil(max / step) * step;
    const y = (v) => T + (H - T - B) * (1 - v / top);
    const bw = Math.min(42, ((W - L) / months.length) * 0.62);
    let g = '';
    for (let v = 0; v <= top + 1; v += step) g += `<line class="grid" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${man(v)}</text>`;
    months.forEach((m, i) => {
      const cx = L + ((W - L) / months.length) * (i + 0.5);
      let acc = 0;
      const segs = series.map((s) => ({ s, v: Math.max(0, valueOf(s, m)) })).filter((o) => o.v > 0);
      segs.forEach((o, j) => {
        const y0 = y(acc), y1 = y(acc + o.v); acc += o.v;
        const h = Math.max(0, y0 - y1 - (j < segs.length - 1 ? 2 : 0));
        const isTop = j === segs.length - 1;
        const tipH = `<b>${m}</b><br>${esc(labelOf(o.s))}: <b>${won(o.v)}</b><br><span class="muted">월 합계 ${won(totals[i])}</span>`;
        g += isTop
          ? `<path d="${roundTop(cx - bw / 2, y1, bw, h)}" fill="${colorOf(o.s)}" data-tip="${esc(tipH)}" data-m="${m}"/>`
          : `<rect x="${cx - bw / 2}" y="${y1 + (j < segs.length - 1 ? 0 : 0)}" width="${bw}" height="${h}" fill="${colorOf(o.s)}" data-tip="${esc(tipH)}" data-m="${m}"/>`;
      });
      const lbl = months.length > 14 ? (i % 2 ? '' : m.slice(2).replace('-', '.')) : m.slice(2).replace('-', '.');
      g += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${lbl}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="월별 지출">${g}</svg>`;
  }
  function roundTop(x, y, w, h) {
    const r = Math.min(4, h, w / 2);
    return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
  }
  function niceStep(v) { const p = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1)))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
  function hbars(rows, color) { // [{label, value, sub, tip}]
    const max = Math.max(1, ...rows.map((r) => r.value));
    return rows.map((r) => `<div class="catrow" data-tip="${esc(r.tip || '')}" ${r.attr || ''}>
      <div class="name">${esc(r.label)}</div><div class="track"><div class="fill" style="width:${(r.value / max) * 100}%;background:${r.color || color}"></div></div>
      <div class="val">${r.valText || won(r.value)}</div><div class="pct">${r.sub || ''}</div></div>`).join('');
  }

  // ---------- 수입·저축·남은 돈 ----------
  const FLOW = { income: ['수입', 'var(--s3)'], saving: ['저축', 'var(--s1)'], spend: ['지출', 'var(--s2)'] };
  function groupedColumns(months, keys, val, note) {
    const W = 760, H = 250, L = 46, B = 26, T = 22;
    const max = Math.max(1, ...months.flatMap((m) => keys.map((k) => val(k, m) || 0)));
    const step = niceStep(max / 4); const top = Math.ceil(max / step) * step;
    const y = (v) => T + (H - T - B) * (1 - v / top);
    const slot = (W - L) / months.length;
    const bw = Math.min(16, (slot * 0.7) / keys.length);
    let g = '';
    for (let v = 0; v <= top + 1; v += step) g += `<line class="grid" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${man(v)}</text>`;
    months.forEach((m, i) => {
      const cx = L + slot * (i + 0.5);
      const ks = keys.filter((k) => val(k, m) != null);
      ks.forEach((k, j) => {
        const v = Math.max(0, val(k, m)); const x = cx - (ks.length * bw) / 2 + j * bw;
        const tipH = `<b>${m}</b><br>${FLOW[k][0]}: <b>${won(v)}</b>${note(m) ? `<br>${note(m).tip}` : ''}`;
        if (v > 0) g += `<path d="${roundTop(x + 1, y(v), bw - 2, y(0) - y(v))}" fill="${FLOW[k][1]}" data-tip="${esc(tipH)}"/>`;
      });
      const n = note(m);
      if (n) g += `<text x="${cx}" y="${T - 8}" text-anchor="middle" style="fill:${n.v < 0 ? 'var(--bad)' : 'var(--good)'};font-weight:600">${n.v < 0 ? '−' : '+'}${man(Math.abs(n.v))}</text>`;
      const lbl = months.length > 14 ? (i % 2 ? '' : m.slice(2).replace('-', '.')) : m.slice(2).replace('-', '.');
      g += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${lbl}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="월별 수입·저축·지출">${g}</svg>`;
  }
  function flowCards(months, recurring) {
    const flow = C.monthFlow(D.rows);
    if (!flow.start) {
      return `<div class="card"><h2>수입 · 저축 · 남은 돈</h2><p class="muted" style="margin:0">아직 수입 기록이 없어요. 가계부 앱에서 입금을 '수입'으로, 적금을 '저축'으로 고르면 여기 달마다 쓸 수 있는 돈과 남은 돈이 나와요.</p></div>`;
    }
    const spendOf = (m) => C.sum(D.items.filter((x) => x.ym === m).map((x) => x.amt));
    const fixedIds = new Set(recurring.flatMap((f) => f.ids));
    const fixedOf = (m) => C.sum(D.items.filter((x) => x.ym === m && x.amt > 0 && fixedIds.has(x.r.id)).map((x) => x.amt));
    const rec = (m) => {
      const f = flow.byMonth[m] || { income: 0, saving: 0 };
      const has = m >= flow.start;
      const spend = spendOf(m);
      const avail = f.income - f.saving;
      return { m, has, income: f.income, saving: f.saving, spend, avail, left: avail - spend, fixed: fixedOf(m), rate: f.income ? f.saving / f.income : 0, now: m === thisYM };
    };
    const all = months.map(rec);
    const withIncome = all.filter((o) => o.has);
    // 1) 월별 막대
    const chart = groupedColumns(months, ['income', 'saving', 'spend'], (k, m) => {
      const o = all.find((x) => x.m === m);
      if (k !== 'spend' && !o.has) return null;
      return o[k];
    }, (m) => { const o = all.find((x) => x.m === m); return o.has ? { v: o.left, tip: `남은 돈 <b>${won(o.left)}</b>${o.now ? ' (진행 중)' : ''}` } : null; });
    const legend = ['income', 'saving', 'spend'].map((k) => `<span><i class="dot" style="background:${FLOW[k][1]}"></i>${FLOW[k][0]}</span>`).join('') + '<span>막대 위 숫자 = 남은 돈 (수입 − 저축 − 지출)</span>';
    // 2) 성적표
    const rows = withIncome.slice().reverse().map((o) => `<tr>
      <td>${o.m}${o.now ? ' <span class="pill">진행 중</span>' : ''}</td><td class="num">${won(o.income)}</td><td class="num">${won(o.saving)}</td>
      <td class="num">${won(o.avail)}</td><td class="num">${won(o.spend)}</td>
      <td class="num ${o.left < 0 ? 'change-up' : 'change-down'}" style="font-weight:600">${o.left < 0 ? `▲ ${won(-o.left)} 넘김` : `${won(o.left)} 남김`}</td>
      <td class="num">${o.income ? `${Math.round(o.rate * 100)}%` : '-'}</td></tr>`).join('');
    const done = withIncome.filter((o) => !o.now);
    const over = done.filter((o) => o.left < 0).length;
    // 3) 쓸 수 있는 돈의 구성
    const recent = withIncome.slice(-6).reverse();
    const comp = recent.map((o) => {
      const fixed = Math.min(o.fixed, o.spend); const free = o.spend - fixed;
      const base = Math.max(o.avail, 1);
      const w = (v) => `${Math.min(100, (Math.max(0, v) / base) * 100)}%`;
      const freeIn = Math.max(0, Math.min(free, o.avail - fixed));
      const tip = `<b>${o.m}</b><br>쓸 수 있는 돈 ${won(o.avail)}<br>고정 지출 ${won(fixed)} · 자유 지출 ${won(free)}<br>${o.left < 0 ? `넘김 ${won(-o.left)}` : `남음 ${won(o.left)}`}`;
      return `<div class="catrow" data-tip="${esc(tip)}"><div class="name">${o.m}${o.now ? ' · 진행 중' : ''}</div>
        <div class="track" style="display:flex;background:var(--surface-2);border-radius:4px;overflow:hidden;${o.left < 0 ? 'box-shadow:inset 0 0 0 2px var(--bad)' : ''}">
          <div style="height:10px;width:${w(fixed)};background:var(--s7)"></div>
          <div style="height:10px;width:${w(o.left < 0 ? o.avail - fixed : freeIn)};background:${o.left < 0 ? 'var(--bad)' : 'var(--s2)'}"></div>
        </div><div class="val">${o.left < 0 ? `<span class="change-up">${man(-o.left)} 넘김</span>` : `${man(o.left)} 남음`}</div><div class="pct">${o.avail > 0 ? `${Math.round((fixed / o.avail) * 100)}%` : ''}</div></div>`;
    }).join('');
    const last = done.slice(-1)[0] || withIncome.slice(-1)[0];
    const sentence = last && last.avail > 0
      ? `${last.m}엔 쓸 수 있는 돈 ${won(last.avail)} 중 고정 지출이 ${won(last.fixed)}(${Math.round((last.fixed / last.avail) * 100)}%)를 먼저 차지해서, 자유롭게 쓸 수 있는 돈은 ${won(last.avail - last.fixed)}였어요.`
      : '';
    return `
      <div class="card"><h2>수입 · 저축 · 지출</h2><p class="sub">수입은 귀속월(기준일 이후 받은 돈은 다음 달) 기준이에요. 수입 기록은 ${flow.start}부터 있어서, 그 전 달은 지출만 보여요.</p>
        ${chart}<div class="legend">${legend}</div></div>
      <div class="grid2" style="margin-bottom:16px">
        <div class="card"><h2>달별 성적표</h2><p class="sub">쓸 수 있는 돈 = 수입 − 저축. ${done.length ? `끝난 ${done.length}달 중 ${over ? `<b class="change-up">${over}달 넘김</b>` : '넘긴 달 없음'}.` : ''}</p>
          ${withIncome.length ? `<div class="tablewrap"><table><thead><tr><th>달</th><th class="num">수입</th><th class="num">저축</th><th class="num">쓸 수 있는 돈</th><th class="num">지출</th><th class="num">결과</th><th class="num">저축률</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">이 기간엔 수입 기록이 없어요.</p>'}</div>
        <div class="card"><h2>쓸 수 있는 돈의 구성</h2><p class="sub">막대 전체 = 그달 쓸 수 있는 돈, 회색 = 남은 돈. 오른쪽 %는 고정 지출이 차지한 몫이에요.</p>
          <div class="legend" style="margin:0 0 8px"><span><i class="dot" style="background:var(--s7)"></i>고정 지출</span><span><i class="dot" style="background:var(--s2)"></i>자유 지출</span><span><i class="dot" style="background:var(--bad)"></i>다 쓰고 넘친 달</span></div>
          ${comp || '<p class="muted">이 기간엔 수입 기록이 없어요.</p>'}${sentence ? `<p class="note" style="margin-top:10px">${sentence}</p>` : ''}</div>
      </div>`;
  }

  // ---------- 대시보드 ----------
  function viewDash() {
    const items = D.items.filter(inRange);
    const spend = items.filter((x) => x.amt !== 0); // 환불(음수)도 합계에 반영
    const total = C.sum(spend.map((x) => x.amt));
    const months = monthsIn();
    const mCount = Math.max(1, months.filter((m) => m <= thisYM).length);
    const recurring = C.findRecurring(D.items.map((x) => ({ r: x.r, c: { ...x.c, cat: x.cat }, amt: x.amt })), todayStr);
    const activeFixed = recurring.filter((r) => r.active);
    const uncat = spend.filter((x) => x.cat === UNCAT && x.amt > 0);
    const nosub = spend.filter((x) => x.cat !== UNCAT && !x.c.decided && x.amt > 0);

    // 세부 분류
    const byCat = [...C.group(spend, (x) => x.cat)].map(([cat, l]) => ({ cat, l, v: C.sum(l.map((x) => x.amt)) })).sort((a, b) => b.v - a.v);
    let catHtml = '';
    for (const { cat, l, v } of byCat) {
      const open = UI.openCat === cat;
      catHtml += `<div class="catrow" data-cat="${esc(cat)}" data-tip="${esc(`<b>${cat}</b> ${won(v)} · ${l.length}건<br>눌러서 세부 분류 펼치기`)}">
        <div class="name"><span class="dot" style="background:${catColor(cat)}"></span>${open ? '▾' : '▸'} ${esc(cat)}</div>
        <div class="track"><div class="fill" style="width:${(v / (byCat[0].v || 1)) * 100}%;background:${catColor(cat)}"></div></div>
        <div class="val">${won(v)}</div><div class="pct">${total ? Math.round((v / total) * 100) : 0}%</div></div>`;
      if (open) {
        const subs = [...C.group(l, (x) => x.sub)].map(([sub, sl]) => ({ sub, sl, v: C.sum(sl.map((x) => x.amt)) })).sort((a, b) => b.v - a.v);
        for (const s of subs) {
          catHtml += `<div class="catrow subrow" data-drill="${esc(`sub|${cat}|${s.sub}`)}" data-tip="${esc(`<b>${cat} · ${s.sub}</b><br>${won(s.v)} · ${s.sl.length}건 · 월평균 ${won(s.v / mCount)}<br>눌러서 내역 보기`)}">
            <div class="name">${esc(s.sub)}</div>
            <div class="track"><div class="fill" style="width:${(s.v / (subs[0].v || 1)) * 100}%;background:${catColor(cat)};opacity:.65"></div></div>
            <div class="val">${won(s.v)}</div><div class="pct">${s.sl.length}건</div></div>`;
        }
      }
    }

    // 추세
    const trendCats = byCat.map((o) => o.cat);
    let series, valueOf, colorOf, labelOf, legend;
    const sel = UI.trendCat;
    if (sel && trendCats.includes(sel)) {
      const l = spend.filter((x) => x.cat === sel);
      const subs = [...C.group(l, (x) => x.sub)].map(([s, sl]) => ({ s, v: C.sum(sl.map((x) => x.amt)) })).sort((a, b) => b.v - a.v).map((o) => o.s);
      const top = subs.slice(0, 7); const rest = subs.slice(7);
      series = rest.length ? [...top, '그 외'] : top;
      const subColor = (s) => (s === '그 외' ? 'var(--s-other)' : `var(--s${(series.indexOf(s) % 8) + 1})`);
      valueOf = (s, m) => C.sum(l.filter((x) => x.ym === m && (s === '그 외' ? rest.includes(x.sub) : x.sub === s)).map((x) => x.amt));
      colorOf = subColor; labelOf = (s) => `${sel} · ${s}`;
      legend = series.map((s) => `<span><i class="dot" style="background:${subColor(s)}"></i>${esc(s)}</span>`).join('');
    } else {
      series = trendCats;
      valueOf = (s, m) => C.sum(spend.filter((x) => x.ym === m && x.cat === s).map((x) => x.amt));
      colorOf = catColor; labelOf = (s) => s;
      legend = series.map((s) => `<span><i class="dot" style="background:${catColor(s)}"></i>${esc(s)}</span>`).join('');
    }
    const chart = stackedColumns(months, series, valueOf, colorOf, labelOf);

    // 변화: 마지막 달 vs 그 전 3개월 평균 (세부 분류 단위)
    // 이번 달은 아직 안 끝났으니 비교는 마지막으로 끝난 달 기준
    const lastM = months.filter((m) => m < thisYM).slice(-1)[0];
    const prev = [1, 2, 3].map((i) => C.addMonths(lastM, -i));
    const allSpend = D.items.filter((x) => x.amt !== 0);
    const changes = [];
    for (const [k, l] of C.group(allSpend.filter((x) => x.ym === lastM || prev.includes(x.ym)), (x) => `${x.cat}|${x.sub}`)) {
      const now = C.sum(l.filter((x) => x.ym === lastM).map((x) => x.amt));
      const avg = C.sum(l.filter((x) => prev.includes(x.ym)).map((x) => x.amt)) / 3;
      if (Math.abs(now - avg) >= 10000) changes.push({ k, now, avg, d: now - avg });
    }
    changes.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));

    // 습관: 요일
    const wd = [0, 1, 2, 3, 4, 5, 6].map((d) => { const l = spend.filter((x) => C.weekday(x.r.date) === d); return { d, n: l.length, v: C.sum(l.map((x) => x.amt)) }; });
    const order = [1, 2, 3, 4, 5, 6, 0];
    const wdHtml = hbars(order.map((d) => ({ label: `${C.WEEKDAYS[d]}요일`, value: wd[d].v, sub: `${wd[d].n}건`, attr: `data-drill="wd|${d}"`, tip: `<b>${C.WEEKDAYS[d]}요일</b> ${won(wd[d].v)} · ${wd[d].n}건<br>건당 평균 ${won(wd[d].n ? wd[d].v / wd[d].n : 0)}` })), 'var(--s1)');
    // 자주 가는 곳
    const byStore = [...C.group(spend.filter((x) => !x.c.agent && x.amt > 0), (x) => x.c.key)].map(([k, l]) => ({ k, l, n: l.length, v: C.sum(l.map((x) => x.amt)) }));
    const freq = byStore.slice().sort((a, b) => b.n - a.n || b.v - a.v).slice(0, 10);
    const freqHtml = hbars(freq.map((s) => ({ label: s.l[s.l.length - 1].r.store, value: s.n, valText: `${s.n}회`, sub: man(s.v), color: catColor(s.l[0].cat), attr: `data-drill="store|${esc(s.k)}"`, tip: `<b>${esc(s.l[0].r.store)}</b><br>${s.n}회 · ${won(s.v)}<br>${esc(s.l[0].cat)} · ${esc(s.l[0].sub)}` })));
    // 소액 반복 (1만원 이하)
    const small = [...C.group(spend.filter((x) => x.amt > 0 && x.amt <= 10000), (x) => `${x.cat} · ${x.sub}`)].map(([k, l]) => ({ k, n: l.length, v: C.sum(l.map((x) => x.amt)) })).filter((o) => o.n >= 4).sort((a, b) => b.v - a.v).slice(0, 8);
    const smallHtml = small.length ? hbars(small.map((s) => ({ label: s.k, value: s.v, sub: `${s.n}건`, attr: `data-drill="small|${esc(s.k)}"`, tip: `<b>${esc(s.k)}</b><br>1만원 이하 ${s.n}건, 합계 ${won(s.v)}` })), 'var(--s2)') : '<p class="muted">1만원 이하로 4번 넘게 반복된 곳이 없어요.</p>';
    // 큰 지출
    const big = spend.filter((x) => x.amt > 0).slice().sort((a, b) => b.amt - a.amt).slice(0, 8);

    // 고정 지출
    const fixedRows = recurring.map((f) => `<tr class="${f.active ? '' : 'off'}" data-drill="fixed|${esc(f.ids.join(','))}" style="cursor:pointer">
      <td>${esc(f.store)}${f.agent ? ' <span class="pill">대행사</span>' : ''}</td><td>${esc(f.cat || UNCAT)}${f.sub ? ` · ${esc(f.sub)}` : ''}</td>
      <td class="num">${won(f.amount)}</td><td class="num">매달 ${f.day}일쯤</td><td class="num">${f.count}개월</td>
      <td>${f.from.slice(0, 7)} ~ ${f.last.slice(0, 7)}</td><td>${f.active ? '진행 중' : '<span class="muted">끝난 듯</span>'}</td></tr>`).join('');

    const drill = UI.drill ? drillHtml(UI.drill) : '';
    return `
      <div class="filters">${periodControl()}<span class="muted">${range()[0]} ~ ${range()[1]}</span></div>
      ${flowCards(months, recurring)}
      <div class="tiles">
        <div class="tile"><div class="k">총지출</div><div class="v">${won(total)}</div><div class="d">${spend.length}건</div></div>
        <div class="tile"><div class="k">월평균</div><div class="v">${won(total / mCount)}</div><div class="d">${mCount}개월 기준</div></div>
        <div class="tile"><div class="k">고정 지출 (매달)</div><div class="v">${won(C.sum(activeFixed.map((f) => f.amount)))}</div><div class="d">진행 중 ${activeFixed.length}곳</div></div>
        <div class="tile"><div class="k">분류 안 된 지출</div><div class="v ${uncat.length ? 'warn' : ''}">${won(C.sum(uncat.map((x) => x.amt)))}</div><div class="d">${uncat.length}건 · 세부 없음 ${nosub.length}건</div></div>
      </div>
      ${drill}
      <div class="card"><h2>세부 분류별 지출</h2><p class="sub">대분류를 누르면 세부 분류가 펼쳐지고, 세부 분류를 누르면 내역이 나와요.</p>${catHtml || '<p class="muted">이 기간에 지출이 없어요.</p>'}</div>
      <div class="card"><h2>추세</h2><p class="sub">월별 지출. 막대에 마우스를 올리면 금액이 보여요.
        <select id="trendCat"><option value="">전체 (대분류별)</option>${trendCats.map((c) => `<option ${c === sel ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></p>
        ${chart}<div class="legend">${legend}</div>
        ${lastM && changes.length ? `<h3 style="font-size:13.5px;margin:16px 0 6px">${lastM}, 직전 3개월 평균과 비교</h3><table><thead><tr><th>세부 분류</th><th class="num">${lastM}</th><th class="num">3개월 평균</th><th class="num">차이</th></tr></thead><tbody>${changes.slice(0, 8).map((c) => `<tr><td>${esc(c.k.replace('|', ' · '))}</td><td class="num">${won(c.now)}</td><td class="num">${won(c.avg)}</td><td class="num ${c.d > 0 ? 'change-up' : 'change-down'}">${c.d > 0 ? '▲' : '▼'} ${won(Math.abs(c.d))}</td></tr>`).join('')}</tbody></table>` : ''}
      </div>
      <div class="grid2">
        <div class="card"><h2>요일별 습관</h2><p class="sub">어느 요일에 많이 쓰는지</p>${wdHtml}</div>
        <div class="card"><h2>자주 가는 곳</h2><p class="sub">횟수 순 (결제대행사 이름만 있는 건 제외)</p>${freqHtml}</div>
        <div class="card"><h2>소액 반복</h2><p class="sub">1만원 이하 결제가 4번 넘게 쌓인 세부 분류</p>${smallHtml}</div>
        <div class="card"><h2>큰 지출</h2><p class="sub">이 기간 금액이 큰 순서</p>${rowTable(big)}</div>
      </div>
      <div class="card" style="margin-top:16px"><h2>고정 지출</h2><p class="sub">같은 곳에 비슷한 금액이 3개월 넘게 한 달 간격으로 나간 결제 (전체 기간 기준). 줄을 누르면 내역이 나와요.</p>
        ${recurring.length ? `<div class="tablewrap"><table><thead><tr><th>가게</th><th>분류</th><th class="num">한 번에</th><th class="num">결제일</th><th class="num">횟수</th><th>기간</th><th>상태</th></tr></thead><tbody>${fixedRows}</tbody></table></div>` : '<p class="muted">찾은 고정 지출이 없어요.</p>'}
      </div>`;
  }
  function drillHtml(d) {
    const [kind, a, b] = d.split('|');
    let list = [], title = '';
    const items = D.items.filter((x) => x.amt !== 0);
    if (kind === 'sub') { list = items.filter(inRange).filter((x) => x.cat === a && x.sub === b); title = `${a} · ${b}`; }
    if (kind === 'wd') { list = items.filter(inRange).filter((x) => C.weekday(x.r.date) === +a); title = `${C.WEEKDAYS[+a]}요일`; }
    if (kind === 'store') { list = items.filter(inRange).filter((x) => x.c.key === a); title = list[0] ? list[0].r.store : a; }
    if (kind === 'small') { list = items.filter(inRange).filter((x) => x.amt <= 10000 && `${x.cat} · ${x.sub}` === a); title = `${a} (1만원 이하)`; }
    if (kind === 'fixed') { const ids = new Set(a.split(',')); list = D.items.filter((x) => ids.has(x.r.id)); title = `고정 지출: ${list[0] ? list[0].r.store : ''}`; }
    list.sort((x, y) => (y.r.date + (y.r.time || '')).localeCompare(x.r.date + (x.r.time || '')));
    return `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h2>${esc(title)} · ${list.length}건 · ${won(C.sum(list.map((x) => x.amt)))}</h2><button class="btn small" id="closeDrill">닫기</button></div>${rowTable(list, { limit: 300 })}</div>`;
  }
  function bindDash(root) {
    bindPeriod(root);
    root.querySelectorAll('[data-cat]').forEach((el) => el.onclick = () => { UI.openCat = UI.openCat === el.dataset.cat ? null : el.dataset.cat; render(); });
    root.querySelectorAll('[data-drill]').forEach((el) => el.onclick = () => { UI.drill = el.dataset.drill; render(); scrollTo({ top: 0, behavior: 'smooth' }); });
    const cd = $('#closeDrill', root); if (cd) cd.onclick = () => { UI.drill = null; render(); };
    const tc = $('#trendCat', root); if (tc) tc.onchange = () => { UI.trendCat = tc.value; render(); };
  }

  // ---------- 내역 표 ----------
  function subOptions(cat, cur) {
    const subs = S.tree[cat] || [];
    return `<option value="">${cat ? '-' : ''}</option>${subs.map((s) => `<option ${s === cur ? 'selected' : ''}>${esc(s)}</option>`).join('')}${cur && !subs.includes(cur) ? `<option selected>${esc(cur)}</option>` : ''}`;
  }
  function catOptions(cur) {
    return `<option value="">미분류</option>${cats().map((c) => `<option ${c === cur ? 'selected' : ''}>${esc(c)}</option>`).join('')}`;
  }
  function viewTable() {
    const t = UI.table;
    let list = t.store ? D.items.filter((x) => x.c.key === t.store) : D.items.filter(inRange);
    if (t.cat) list = list.filter((x) => x.cat === t.cat);
    if (t.sub) list = list.filter((x) => x.sub === t.sub);
    if (t.pay) list = list.filter((x) => x.r.pay === t.pay);
    if (t.src) list = list.filter((x) => x.r.source === t.src);
    if (t.uncat) list = list.filter((x) => x.cat === UNCAT || !x.c.decided);
    if (!t.showOff) list = list.filter((x) => x.amt > 0);
    if (t.q) { const q = t.q.toLowerCase(); list = list.filter((x) => `${x.r.store} ${x.r.rawStore} ${x.r.memo}`.toLowerCase().includes(q)); }
    const key = { date: (x) => x.r.date + (x.r.time || ''), amount: (x) => x.r.amount, store: (x) => x.r.store, cat: (x) => `${x.cat}${x.sub}` }[t.sort];
    list.sort((a, b) => { const A = key(a), B = key(b); return (A > B ? 1 : A < B ? -1 : 0) * t.dir; });
    const pays = [...new Set(D.items.map((x) => x.r.pay))].sort();
    const srcs = [...new Set(D.items.map((x) => x.r.source))].sort();
    const total = C.sum(list.map((x) => x.amt));
    const today = C.addMonths(thisYM, 0);
    const rows = list.slice(0, t.limit).map((x) => {
      const ins = C.installment(x.r, today);
      return `<tr class="${x.amt === 0 ? 'off' : ''}" data-id="${esc(x.r.id)}">
        <td>${x.r.date}</td><td class="muted">${x.r.time || ''}</td>
        <td><a href="#" class="estore" data-key="${esc(x.c.key)}" data-name="${esc(x.r.store)}" title="이 가게 내역 전부 보기">${esc(x.r.store)}</a>${x.c.agent ? ' <span class="pill" title="결제대행사 이름이라 가게별로 기억하지 않아요">대행사</span>' : ''}${x.r.rawStore && x.r.rawStore !== x.r.store ? `<div class="muted" style="font-size:12px">${esc(x.r.rawStore)}</div>` : ''}</td>
        <td class="num">${won(x.r.amount)}${ins ? `<div class="muted" style="font-size:12px">${ins.months}개월 · 월 ${won(ins.monthly)} · 남은 ${won(ins.leftAmount)} (${ins.left}회)</div>` : ''}</td>
        <td><select class="ecat">${catOptions(x.c.cat)}</select></td>
        <td><select class="esub">${subOptions(x.c.cat, x.c.sub)}</select></td>
        <td class="muted">${esc(x.r.pay)}</td><td class="memo">${esc(x.r.memo)}</td><td class="muted" style="font-size:12px">${esc(x.r.source)}</td>
        <td><button class="btn small etoggle" title="지출 합계에 넣기/빼기">${x.amt > 0 ? '빼기' : (x.r.canceled ? '취소됨' : '넣기')}</button></td></tr>`;
    }).join('');
    const sortTh = (k, l, cls = '') => `<th class="sortable ${cls}" data-sort="${k}">${l}${t.sort === k ? (t.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
    return `
      <div class="filters">${periodControl()}</div>
      <div class="filters">
        <select id="fcat"><option value="">대분류 전체</option>${cats().concat(UNCAT).map((c) => `<option ${c === t.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <select id="fsub"><option value="">세부 전체</option>${(S.tree[t.cat] || []).concat(NOSUB).map((s) => `<option ${s === t.sub ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
        <select id="fpay"><option value="">결제수단 전체</option>${pays.map((p) => `<option ${p === t.pay ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
        <select id="fsrc"><option value="">출처 전체</option>${srcs.map((p) => `<option ${p === t.src ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
        <input type="search" id="fq" placeholder="가게·메모 검색" value="${esc(t.q)}">
        <label><input type="checkbox" id="funcat" ${t.uncat ? 'checked' : ''}> 분류 덜 된 것만</label>
        <label><input type="checkbox" id="foff" ${t.showOff ? 'checked' : ''}> 지출 아닌 것도 보기</label>
      </div>
      ${t.store ? `<div class="filters"><span class="chip">가게: <b>${esc(t.storeName)}</b> · 전체 기간<button id="storeOff" title="가게 보기 끄기">×</button></span></div>` : ''}
      <div class="filters"><span>${list.length}건${list.some((x) => x.amt === 0) ? ` (지출로 센 건 ${list.filter((x) => x.amt !== 0).length}건, 취소·제외 ${list.filter((x) => x.amt === 0).length}건)` : ''} · 지출 합계 <b>${won(total)}</b></span>
        <span class="muted" style="margin-left:auto">분류를 고치면</span>
        <div class="seg" id="applyTo">${[['one', '이 건만'], ['memo', '같은 메모 전부'], ['store', '같은 가게 전부']].map(([v, l]) => `<button data-v="${v}" class="${UI.applyTo === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="card tablewrap" style="padding:6px 8px"><table><thead><tr>${sortTh('date', '날짜')}<th>시각</th>${sortTh('store', '가게')}${sortTh('amount', '금액', 'num')}${sortTh('cat', '대분류')}<th>세부</th><th>결제</th><th>메모</th><th>출처</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      ${list.length > t.limit ? `<p style="text-align:center"><button class="btn" id="more">${list.length - t.limit}건 더 보기</button></p>` : ''}</div>`;
  }
  function setClass(id, cat, sub, forceOne) {
    const x = D.items.find((i) => i.r.id === id); if (!x) return;
    if (UI.applyTo === 'memo' && !forceOne) {
      // 같은 메모(상품명)는 단어 규칙으로: 앞으로 들어오는 내역에도, 가계부 앱에도 적용
      const kw = C.productName(x.r.memo).trim().toLowerCase();
      if (!kw) { toast('이 건은 메모가 없어서 이 건만 바꿨어요'); S.overrides[id] = { ...(S.overrides[id] || {}), cat, sub }; save(); recompute(); render(); return; }
      S.rules = S.rules.filter((r) => r.kw !== kw); S.rules.push({ kw, cat, sub });
      let n = 0;
      D.items.forEach((i) => {
        if (!C.matchRule(i.r, [{ kw }])) return;
        n++;
        const ov = S.overrides[i.r.id];
        if (ov) { delete ov.cat; delete ov.sub; }
        if (i.r.cat && i.r.cat !== cat) S.overrides[i.r.id] = { ...(ov || {}), cat };
      });
      toast(`메모에 '${kw.length > 30 ? kw.slice(0, 30) + '…' : kw}' 들어간 ${n}건에 적용했어요 (단어 규칙으로 저장)`);
    } else if (UI.applyTo === 'one' || x.c.agent || forceOne) {
      S.overrides[id] = { ...(S.overrides[id] || {}), cat, sub };
      if (x.c.agent && UI.applyTo !== 'one') toast('결제대행사 이름이라 이 건만 바꿨어요');
    } else {
      S.memory[x.c.key] = { cat, sub };
      // 가게 전체에 적용할 땐 그 가게의 건별 분류는 지운다
      let n = 0;
      D.items.forEach((i) => {
        if (i.c.key !== x.c.key || i.c.agent) return;
        n++;
        const ov = S.overrides[i.r.id];
        if (ov) { delete ov.cat; delete ov.sub; }
        // 가계부 앱이 정한 대분류가 다르면 건별로 바꿔 둔다 (시트를 거쳐 앱에도 반영)
        if (i.r.cat && i.r.cat !== cat) S.overrides[i.r.id] = { ...(ov || {}), cat };
      });
      if (n > 1) toast(`${x.r.store} ${n}건에 적용했어요`);
    }
    save(); recompute(); render();
  }
  function bindTable(root) {
    bindPeriod(root);
    const t = UI.table;
    const on = (id, ev, fn) => { const el = $(id, root); if (el) el[ev] = fn; };
    on('#fcat', 'onchange', (e) => { t.cat = e.target.value; t.sub = ''; render(); });
    on('#fsub', 'onchange', (e) => { t.sub = e.target.value; render(); });
    on('#fpay', 'onchange', (e) => { t.pay = e.target.value; render(); });
    on('#fsrc', 'onchange', (e) => { t.src = e.target.value; render(); });
    on('#fq', 'oninput', (e) => { t.q = e.target.value; clearTimeout(UI.qT); UI.qT = setTimeout(() => { render(); const q = $('#fq'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 250); });
    on('#funcat', 'onchange', (e) => { t.uncat = e.target.checked; render(); });
    on('#foff', 'onchange', (e) => { t.showOff = e.target.checked; render(); });
    on('#more', 'onclick', () => { t.limit += 500; render(); });
    root.querySelectorAll('#applyTo button').forEach((b) => b.onclick = () => { UI.applyTo = b.dataset.v; render(); });
    root.querySelectorAll('.estore').forEach((a) => a.onclick = (e) => { e.preventDefault(); t.store = a.dataset.key; t.storeName = a.dataset.name; t.limit = 300; render(); scrollTo(0, 0); });
    on('#storeOff', 'onclick', () => { t.store = ''; t.storeName = ''; render(); });
    root.querySelectorAll('th[data-sort]').forEach((th) => th.onclick = () => { if (t.sort === th.dataset.sort) t.dir *= -1; else { t.sort = th.dataset.sort; t.dir = th.dataset.sort === 'store' || th.dataset.sort === 'cat' ? 1 : -1; } render(); });
    root.querySelectorAll('tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id;
      $('.ecat', tr).onchange = (e) => setClass(id, e.target.value, '');
      $('.esub', tr).onchange = (e) => setClass(id, $('.ecat', tr).value, e.target.value);
      $('.etoggle', tr).onclick = () => {
        const x = D.items.find((i) => i.r.id === id);
        const ov = S.overrides[id] = { ...(S.overrides[id] || {}) };
        if (x.amt > 0) { ov.exclude = true; delete ov.include; } else { delete ov.exclude; ov.include = true; }
        save(); recompute(); render();
      };
    });
  }

  // ---------- 분류하기 ----------
  const SUGGEST = [
    ['교통', '대중교통', ['버스', '지하철', '티머니', '코레일', 'srt']], ['교통', '택시', ['택시', '카카오t']], ['교통', '주차·주유', ['주차', '주유', '도시공사', '하이패스', '파킹']],
    ['카페·간식', '카페', ['커피', '카페', '투썸', '이디야', '스타벅스', '메가mgc', '컴포즈', '빽다방', '메머드', '매머드']], ['카페·간식', '간식·디저트', ['배스킨', '베이커리', '파리바게뜨', '뚜레쥬르']],
    ['식비', '편의점', ['gs25', '씨유', 'cu', '세븐일레븐', '이마트24']], ['식비', '배달', ['배달의민족', '요기요', '쿠팡이츠', '우아한형제들']],
    ['식비', '장보기', ['마트', '하나로', '트레이더스', '푸드마켓', '롯데슈퍼']],
    ['식비', '식사', ['맥도날드', '맘스터치', '롯데리아', '버거', '치킨', '통닭', '족발', '국밥', '김밥', '피자', '갈비', '식당', '돈까스', '카츠', '삼겹', '감자탕', '차이', '반점', '덴키']],
    ['구독', 'AI·업무', ['openai', 'chatgpt', 'anthropic', 'claude', '뤼튼', 'higgsfield']], ['구독', '멤버십', ['멤버십', '와우', '네이버플러스']], ['구독', '영상·음악', ['netflix', '넷플릭스', 'youtube', '유튜브', '멜론', '스포티파이']],
    ['쇼핑', '생활용품', ['쿠팡', '다이소', '오늘의집']], ['쇼핑', '도서·문구', ['알라딘', '예스이십사', '교보']], ['쇼핑', '의류', ['무신사', '유니클로', '자라']],
    ['의료', '병원', ['의원', '병원', '치과', '한의원']], ['의료', '약국', ['약국']], ['생활', '미용', ['헤어', '미용']], ['생활', '택배·우편', ['대한통운', '우체국']],
    ['여가', '게임', ['게임', 'games', 'steam', '스팀', '닌텐도', '플레이스테이션', 'nexon', '넥슨']], ['여가', '놀이·모임', ['보드게임', '노래', '영화', 'cgv', '메가박스']], ['여가', '운동', ['클라이밍', '헬스', '필라테스', '요가', '스포츠']],
    ['여가', '후원·팬활동', ['chzzk', '치지직', '치즈충전', '팬딩', 'fanplus', '아프리카tv', 'soop']], ['여가', '굿즈', ['굿스마일', '포켓몬', '굿즈']],
    ['구독', '웹소설·웹툰', ['노벨피아', '리디', '카카오페이지', '네이버웹툰', '문피아']],
    /*MINE*/
    // 개인판에만: Min이 알려준 가게. 범용판(build.py)에서는 빠진다.
    // 파이어볼트 = 윗치폼 운영사(굿즈), 비바리퍼블리카(토스) 결제 = 취미(여가), 지에스넷비전 = 술값, 메타크래프트 = 노벨피아 정기구독
    ['여가', '게임', ['alipay', '달빛', '명조', 'kuro']],
    ['여가', '굿즈', ['파이어볼트', '윗치폼', '스텔라이브']], ['여가', '', ['비바리퍼블리']],
    ['식비', '술', ['지에스넷비전']], ['구독', '웹소설·웹툰', ['메타크래프트']],
    /*END MINE*/
  ];
  function suggestFor(store, memo) {
    const k = C.storeKey(store) + (memo ? C.productName(memo).toLowerCase().replace(/\s/g, '') : '');
    const hit = SUGGEST.find(([, , words]) => words.some((w) => k.includes(w)));
    return hit ? { cat: hit[0], sub: hit[1] } : null;
  }
  function pending() {
    // 가게별로 기억할 수 있는 것 (대분류 또는 세부가 빈 것)
    const groups = new Map();
    const agentRows = [];
    for (const x of D.items) {
      if (x.r.amount <= 0 || C.NOT_SPENDING_CATS.includes(x.r.cat) || x.r.canceled || !x.r.include) continue;
      if (x.c.cat && x.c.decided) continue;
      if (x.c.agent) { agentRows.push(x); continue; }
      if (!groups.has(x.c.key)) groups.set(x.c.key, { key: x.c.key, store: x.r.store, list: [], cat: x.c.cat });
      groups.get(x.c.key).list.push(x);
    }
    const g = [...groups.values()].map((o) => ({ ...o, n: o.list.length, v: C.sum(o.list.map((x) => x.r.amount)) })).sort((a, b) => b.v - a.v);
    return { groups: g, agentRows: agentRows.sort((a, b) => b.r.amount - a.r.amount) };
  }
  function viewClassify() {
    const { groups, agentRows } = pending();
    UI.ai = UI.ai || null;
    const rowsHtml = groups.slice(0, UI.classLimit || 80).map((g) => {
      const fixedCat = g.list.some((x) => x.r.cat); // 가계부 앱이 대분류를 정한 가게
      const ai = UI.ai && UI.ai[g.key];
      const sug = ai || (g.cat ? { cat: g.cat, sub: (suggestFor(g.store) || {}).cat === g.cat ? suggestFor(g.store).sub : '' } : suggestFor(g.store)) || { cat: '', sub: '' };
      const cat = g.cat || sug.cat;
      return `<tr data-key="${esc(g.key)}"><td>${esc(g.store)}${ai ? ' <span class="pill">AI 제안</span>' : ((!g.cat && sug.cat) || (sug.sub && sug.cat === cat) ? ' <span class="pill">추천</span>' : '')}<div class="muted" style="font-size:12px">${esc(g.list[0].r.memo).slice(0, 60)}</div></td>
        <td class="num">${g.n}건</td><td class="num">${won(g.v)}</td>
        <td><select class="ccat" ${fixedCat ? 'disabled title="가계부 앱에서 정한 대분류예요"' : ''}>${catOptions(cat)}</select></td>
        <td><select class="csub">${subOptions(cat, sug.cat === cat ? sug.sub : '')}</select></td>
        <td><button class="btn small primary csave">저장</button></td></tr>`;
    }).join('');
    const agentHtml = agentRows.slice(0, UI.agentLimit || 60).map((x) => {
      const s0 = suggestFor(x.r.store, x.r.memo);
      const sug = (s0 && (!x.c.cat || s0.cat === x.c.cat) ? s0 : null) || { cat: x.c.cat, sub: x.c.sub };
      const cat = x.c.cat || sug.cat;
      const sugShown = s0 && sug === s0 && (!x.c.cat || (s0.sub && !x.c.sub));
      const prod = C.productName(x.r.memo);
      const kw = C.sellerFromMemo(x.r.memo) || prod.replace(/[\[\](){}*].*$/, '').split(/\s+/).slice(0, 2).join(' ').trim() || x.r.store.replace(/\s*(유한회사?|주식회사|\(주\)|㈜)\s*/g, '').trim();
      return `<tr data-id="${esc(x.r.id)}"><td>${x.r.date}</td><td>${esc(x.r.store)}${sugShown ? ' <span class="pill">추천</span>' : ''}<div class="muted" style="font-size:12px">${esc(prod).slice(0, 70)}</div></td><td class="num">${won(x.r.amount)}</td>
      <td><select class="ccat" ${x.r.cat ? 'disabled' : ''}>${catOptions(cat)}</select></td><td><select class="csub">${subOptions(cat, sug.cat === cat ? sug.sub : x.c.sub)}</select></td>
      <td style="white-space:nowrap"><button class="btn small primary csave1">이 건만</button>
        <input type="text" class="ckw" value="${esc(kw)}" size="9" title="이 단어가 가게 이름이나 상품명에 들어간 결제를 모두 같은 분류로"><button class="btn small crule">들어간 것 모두</button></td></tr>`;
    }).join('');
    const hasKey = !!apiKey();
    return `
      <div class="card"><h2>가게별 분류 ${groups.length ? `· 남은 가게 ${groups.length}곳` : ''}</h2>
        <p class="sub">한 번 저장하면 같은 가게는 앞으로 자동으로 분류돼요. 금액이 큰 가게부터 보여요. "추천"은 가게 이름으로 미리 골라둔 값이라 저장해야 반영돼요.</p>
        <div class="filters"><button class="btn" id="saveAllSug" title="세부까지 채워진 줄을 한 번에 저장해요 (추천·AI 제안·직접 고른 것 모두)">채워진 것 모두 저장</button>
          <button class="btn primary" id="aiBtn" ${hasKey ? '' : 'disabled title="설정에서 API 키를 넣어야 해요"'}>AI 자동 분류 (가게 이름만 보내요)</button>
          ${hasKey ? '' : '<span class="muted">AI를 쓰려면 설정 탭에서 Anthropic API 키를 넣어주세요.</span>'}<span id="aiStatus" class="muted"></span></div>
        ${groups.length ? `<div class="tablewrap"><table><thead><tr><th>가게</th><th class="num">건수</th><th class="num">합계</th><th>대분류</th><th>세부</th><th></th></tr></thead><tbody>${rowsHtml}</tbody></table></div>${groups.length > (UI.classLimit || 80) ? '<p style="text-align:center"><button class="btn" id="moreClass">더 보기</button></p>' : ''}` : '<p>분류할 가게가 없어요. 👍</p>'}
      </div>
      <div class="card"><h2>결제대행사 이름만 있는 결제 · ${agentRows.length}건</h2>
        <p class="sub">"토스페이먼츠", "케이지이니시스"처럼 실제 가게를 알 수 없는 건은 가게로 기억하지 않아요. 상품명을 보고 <b>이 건만</b> 저장하거나, 옆 칸의 단어(예: 판매자 이름, 상품명 앞부분)가 <b>들어간 것 모두</b>를 한 번에 분류하세요. 단어 규칙은 앞으로 올리는 내역에도 적용돼요.</p>
        ${agentRows.length ? `<div class="tablewrap"><table><thead><tr><th>날짜</th><th>가게 · 상품명</th><th class="num">금액</th><th>대분류</th><th>세부</th><th>저장</th></tr></thead><tbody>${agentHtml}</tbody></table></div>${agentRows.length > (UI.agentLimit || 60) ? '<p style="text-align:center"><button class="btn" id="moreAgent">더 보기</button></p>' : ''}` : '<p class="muted">없어요.</p>'}
      </div>
      <div class="card"><h2>세부 분류 목록</h2><p class="sub">대분류마다 세부 분류를 더하거나 뺄 수 있어요. 대분류 이름은 가계부 앱과 맞춰 두는 게 좋아요.</p>
        ${Object.entries(S.tree).map(([cat, subs]) => `<div class="treecat" data-cat="${esc(cat)}"><b><span class="dot" style="background:${catColor(cat)}"></span> ${esc(cat)}</b> <button class="btn small tdelcat">대분류 삭제</button>
          <div class="subs">${subs.map((s) => `<span class="chip">${esc(s)}<button class="tdel" data-sub="${esc(s)}" title="삭제">×</button></span>`).join('')}
          <input type="text" class="tadd" placeholder="+ 세부 추가" size="10"></div></div>`).join('')}
        <div class="filters" style="margin-top:12px"><input type="text" id="newCat" placeholder="새 대분류 이름"><button class="btn" id="addCat">대분류 추가</button></div>
      </div>
      <div class="card"><h2>단어 규칙 · ${S.rules.length}개</h2><p class="sub">가게 이름이나 상품명에 이 단어가 들어 있으면 이 분류로 넣어요. 가게별 기억보다 먼저 적용돼서, 같은 가게라도 상품명으로 나눌 수 있어요. 한 건만 고친 분류는 이보다 먼저예요. 가계부 앱과 같은 목록을 써요.</p>
        ${S.rules.length ? `<table><tbody>${S.rules.map((r, i) => `<tr><td><b>${esc(r.kw)}</b></td><td>${esc(r.cat)}${r.sub ? ` · ${esc(r.sub)}` : ''}</td><td class="num">${D.items.filter((x) => x.c.byRule && C.matchRule(x.r, [r])).length}건</td><td><button class="btn small rdel" data-i="${i}">삭제</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">아직 없어요.</p>'}
      </div>`;
  }
  function bindClassify(root) {
    root.querySelectorAll('tr[data-key]').forEach((tr) => {
      const cs = $('.ccat', tr);
      cs.onchange = () => { $('.csub', tr).innerHTML = subOptions(cs.value, ''); };
      $('.csave', tr).onclick = () => {
        const key = tr.dataset.key; const cat = cs.value; const sub = $('.csub', tr).value;
        if (!cat) return toast('대분류를 골라주세요');
        S.memory[key] = { cat, sub }; if (UI.ai) delete UI.ai[key]; save(); recompute(); render();
      };
    });
    root.querySelectorAll('tr[data-id]').forEach((tr) => {
      const cs = $('.ccat', tr);
      cs.onchange = () => { $('.csub', tr).innerHTML = subOptions(cs.value, ''); };
      $('.crule', tr).onclick = () => {
        const kw = $('.ckw', tr).value.trim().toLowerCase(); const cat = cs.value; const sub = $('.csub', tr).value;
        if (!kw) return toast('단어를 적어주세요');
        if (!cat) return toast('대분류를 골라주세요');
        S.rules = S.rules.filter((r) => r.kw !== kw); S.rules.push({ kw, cat, sub });
        save(); recompute();
        const n = D.items.filter((x) => x.c.byRule && C.matchRule(x.r, [{ kw }])).length;
        render(); toast(`'${kw}' 들어간 결제 ${n}건을 ${cat}${sub ? ' · ' + sub : ''}로 분류했어요`);
      };
      $('.csave1', tr).onclick = () => {
        const id = tr.dataset.id; S.overrides[id] = { ...(S.overrides[id] || {}), cat: cs.value, sub: $('.csub', tr).value };
        save(); recompute(); render();
      };
    });
    const sa = $('#saveAllSug', root);
    if (sa) sa.onclick = () => {
      let n = 0;
      // 세부까지 골라졌거나, 대분류를 새로 고른 줄 (앱이 정한 대분류만 있고 세부가 빈 줄은 그대로 둔다)
      const filled = (tr) => { const c = $('.ccat', tr); return c.value && ($('.csub', tr).value || !c.disabled); };
      root.querySelectorAll('tr[data-key]').forEach((tr) => {
        if (!filled(tr)) return;
        S.memory[tr.dataset.key] = { cat: $('.ccat', tr).value, sub: $('.csub', tr).value }; n++;
      });
      root.querySelectorAll('tr[data-id]').forEach((tr) => {
        if (!filled(tr)) return;
        S.overrides[tr.dataset.id] = { ...(S.overrides[tr.dataset.id] || {}), cat: $('.ccat', tr).value, sub: $('.csub', tr).value }; n++;
      });
      UI.ai = null; save(); recompute(); render(); toast(`${n}건 저장했어요`);
    };
    const ma = $('#moreAgent', root); if (ma) ma.onclick = () => { UI.agentLimit = (UI.agentLimit || 60) + 200; render(); };
    root.querySelectorAll('.rdel').forEach((b) => b.onclick = () => { S.rules.splice(+b.dataset.i, 1); save(); recompute(); render(); });
    const mc = $('#moreClass', root); if (mc) mc.onclick = () => { UI.classLimit = (UI.classLimit || 80) + 200; render(); };
    const ab = $('#aiBtn', root); if (ab) ab.onclick = runAI;
    root.querySelectorAll('.treecat').forEach((el) => {
      const cat = el.dataset.cat;
      el.querySelectorAll('.tdel').forEach((b) => b.onclick = () => { S.tree[cat] = S.tree[cat].filter((s) => s !== b.dataset.sub); save(); render(); });
      $('.tadd', el).onkeydown = (e) => { if (e.key === 'Enter' && e.target.value.trim()) { S.tree[cat].push(e.target.value.trim()); save(); render(); } };
      $('.tdelcat', el).onclick = () => { if (confirm(`'${cat}' 대분류를 목록에서 뺄까요? 이미 분류한 내역은 그대로 남아요.`)) { delete S.tree[cat]; save(); render(); } };
    });
    const ac = $('#addCat', root); if (ac) ac.onclick = () => { const v = $('#newCat').value.trim(); if (v && !S.tree[v]) { S.tree[v] = []; save(); render(); } };
  }

  async function runAI() {
    const { groups } = pending();
    const todo = groups.filter((g) => !(UI.ai && UI.ai[g.key])).slice(0, 150);
    if (!todo.length) return toast('AI에 물어볼 가게가 없어요');
    const st = $('#aiStatus'); st.textContent = ` ${todo.length}곳 물어보는 중...`;
    const tree = Object.entries(S.tree).map(([c, s]) => `${c}: ${s.join(', ')}`).join('\n');
    const list = todo.map((g, i) => `${i + 1}. ${g.store}${g.cat ? ` (대분류는 ${g.cat}로 정해짐)` : ''}`).join('\n');
    const prompt = `한국 카드 결제 내역의 가게 이름을 보고 지출 분류를 골라줘.\n\n분류 목록 (대분류: 세부들):\n${tree}\n\n가게 이름:\n${list}\n\n규칙: 반드시 위 목록 안에서만 고르고, 대분류가 정해진 가게는 그 대분류 안에서 세부만 골라. 이름만으로 확신이 없으면 cat을 빈 문자열로 둬. 결제대행사 이름(토스페이먼츠, 이니시스 등)만 있으면 빈 문자열.\nJSON 배열로만 답해: [{"n":번호,"cat":"대분류","sub":"세부"}]`;
    try {
      const text = await callAI(prompt);
      const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
      UI.ai = UI.ai || {};
      let n = 0;
      for (const a of arr) {
        const g = todo[a.n - 1]; if (!g || !a.cat || !S.tree[a.cat]) continue;
        if (g.cat && a.cat !== g.cat) continue;
        UI.ai[g.key] = { cat: a.cat, sub: S.tree[a.cat].includes(a.sub) ? a.sub : '' }; n++;
      }
      render(); toast(`AI가 ${n}곳을 제안했어요. 확인하고 저장하세요.`);
    } catch (e) {
      st.textContent = ` 실패: ${e.message}`;
    }
  }

  // ---------- 점검 ----------
  function viewCheck() {
    const rp = D.report;
    const dups = C.findDuplicates(D.rows).filter((d) => !S.dismissed[d.key]);
    const byId = new Map(D.items.map((x) => [x.r.id, x]));
    const cardRows = D.rows.filter((r) => /^카드 파일/.test(r.source));
    const cardFrom = cardRows.map((r) => r.date).sort()[0];
    const npOnly = cardFrom ? D.items.filter((x) => x.r.pay === '네이버페이' && x.r.date >= cardFrom && !x.r.canceled && x.r.amount > 0) : [];
    const MOVES = ['수입', '저축', '돌려받은 돈', '내 계좌 이동'];
    const moves = D.items.filter((x) => MOVES.includes(x.r.cat) || (x.r.kind === '입금' && !x.r.cat));
    const off = D.items.filter((x) => x.amt === 0 && x.r.amount > 0 && !moves.includes(x));
    const neg = D.items.filter((x) => x.r.amount < 0 && !moves.includes(x));
    const problems = S.files.flatMap((f) => (f.problems || []).map((p) => `${f.name}: ${p}`));
    const li = (arr, f) => arr.length ? `<ul>${arr.map(f).join('')}</ul>` : '<p class="muted">없어요.</p>';
    return `
      <div class="card"><h2>파일을 합치면서 한 일</h2><p class="sub">같은 결제가 여러 파일에 있을 때 한 건으로 합친 내역이에요.</p>
        <ul>
          <li>명세서와 실시간 이용내역이 겹친 결제 <b>${rp.stmtRtMerged || 0}건</b> → 시각이 있는 실시간 쪽으로 합침</li>
          <li>카드의 '네이버파이낸셜·네이버페이' 결제와 네이버페이 내역 <b>${(rp.naverMatched || 0) - (rp.naverViaPG || []).length - (rp.naverShipping || []).length - (rp.naverZeroFilled || []).length - (rp.naverPointMix || []).length}건</b> → 네이버페이 쪽 가게 이름으로 한 건</li>
          <li>네이버페이로 냈지만 카드엔 결제대행사·가게 이름으로 찍힌 결제 <b>${(rp.naverViaPG || []).length}건</b> (예: 카드엔 '이니시스 - 판매자', 네이버페이엔 판매자 이름)</li>
          <li>네이버페이 상품 금액에 배송비가 빠져 있던 주문 <b>${(rp.naverShipping || []).length}건</b> → 카드 금액(배송비 포함)으로</li>
          <li>포인트를 섞어 낸 결제 <b>${(rp.naverPointMix || []).length}건</b> → 카드로 나간 금액만 지출로</li>
          <li>네이버페이 금액이 비어 있던 건 <b>${(rp.naverZeroFilled || []).length}건</b> → 카드 금액으로 채움</li>
          <li>해외결제 승인액과 청구액이 달랐던 건 <b>${(rp.stmtVsRt || []).length}건</b> → 청구액 사용</li>
        </ul></div>
      <div class="card"><h2>중복 의심 · ${dups.length}건</h2><p class="sub">출처가 다른데 금액이 같고 시각이 가까운 결제예요. 같은 결제면 한쪽을 빼세요.</p>
        ${dups.length ? `<table><tbody>${dups.map((d) => `<tr data-dup="${esc(d.key)}"><td>${esc(d.why)}</td><td>${d.a.date} ${d.a.time}<br>${d.b.date} ${d.b.time}</td><td>${esc(d.a.store)} <span class="muted">(${esc(d.a.source)})</span><br>${esc(d.b.store)} <span class="muted">(${esc(d.b.source)})</span></td><td class="num">${won(d.a.amount)}</td>
          <td><button class="btn small dupa" data-id="${esc(d.a.id)}">위 건 빼기</button> <button class="btn small dupb" data-id="${esc(d.b.id)}">아래 건 빼기</button> <button class="btn small dupno">중복 아님</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">없어요.</p>'}</div>
      <div class="card"><h2>카드에 '네이버' 결제가 있는데 네이버페이 내역엔 없는 것 · ${(rp.naverCardUnmatched || []).length}건</h2>${li(rp.naverCardUnmatched || [], (r) => `<li>${r.date} ${esc(r.rawStore)} ${won(r.amount)}</li>`)}</div>
      <div class="card"><h2>네이버페이 내역에만 있는 결제 · ${npOnly.length}건 · ${won(C.sum(npOnly.map((x) => x.r.amount)))}</h2>
        <p class="sub">카드 내역이 있는 기간(${cardFrom || '-'} 이후)인데 현대카드에서 짝을 못 찾은 결제예요. 네이버페이 포인트·머니나 계좌로 냈을 가능성이 높아요. 농협 계좌에서 네이버페이로 바로 나간 돈이라면 나중에 농협 내역을 합칠 때 두 번 세지 않게 조심해야 해요.</p>
        ${rowTable(npOnly.sort((a, b) => b.r.amount - a.r.amount), { limit: 100 })}</div>
      <div class="card"><h2>지출에서 뺀 것 · ${off.length}건</h2><p class="sub">취소, 가승인, 카드대금·현금인출, 직접 뺀 것${moves.length ? `. 수입·저축·돌려받은 돈·내 계좌 이동 ${moves.length}건은 대시보드 맨 위 칸에서 따로 봐요` : ''}</p>${rowTable(off, { limit: 100, raw: true })}</div>
      ${(() => { const un = moves.filter((x) => x.r.kind === '입금' && !x.r.cat && !x.r.offsetTo); return un.length ? `<div class="card"><h2>아직 안 고른 입금 · ${un.length}건</h2><p class="sub">수입·돌려받은 돈·내 계좌 이동 중에서 가계부 앱에서 골라 주세요. 고르기 전에는 수입에도 지출에도 안 들어가요.</p>${rowTable(un, { limit: 50, raw: true })}</div>` : ''; })()}
      <div class="card"><h2>환불·음수 금액 · ${neg.length}건</h2><p class="sub">결제에 연결 안 된 환불은 음수로 지출에서 빠져요. 가계부 앱에서 결제와 연결(상계)하면 그 결제 금액에서 빠지는 걸로 바뀌어요.</p>${rowTable(neg, { limit: 100, raw: true })}</div>
      ${problems.length ? `<div class="card"><h2>파일 읽기 문제</h2>${li(problems, (p) => `<li>${esc(p)}</li>`)}</div>` : ''}`;
  }
  function bindCheck(root) {
    root.querySelectorAll('tr[data-dup]').forEach((tr) => {
      const ex = (id) => { S.overrides[id] = { ...(S.overrides[id] || {}), exclude: true }; S.dismissed[tr.dataset.dup] = 1; save(); recompute(); render(); };
      $('.dupa', tr).onclick = (e) => ex(e.target.dataset.id);
      $('.dupb', tr).onclick = (e) => ex(e.target.dataset.id);
      $('.dupno', tr).onclick = () => { S.dismissed[tr.dataset.dup] = 1; save(); render(); };
    });
  }

  // ---------- 파일·설정 ----------
  function viewFiles() {
    const files = S.files.slice().sort((a, b) => a.key.localeCompare(b.key));
    return `
      ${GAS ? `<div class="card"><h2>구글 시트</h2><p class="sub">가계부 앱이 보낸 내역(시트 '내역')을 읽고, 분류는 시트 '분류 자료'에 바로 저장해요. 여기서 고친 대분류는 다음 동기화 때 앱에도 들어가요.</p>
        <p>'내역' ${G.txCount.toLocaleString()}건${G.at ? ` · ${G.at.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}에 읽음` : ''} <button class="btn small" id="sheetReload">다시 읽기</button></p></div>` : ''}
      <div class="card"><h2>${GAS ? '비교용 파일 올리기' : '파일 올리기'}</h2><p class="sub">${GAS ? '현대카드 명세서·실시간 이용내역(.xls), 네이버페이 내역 CSV를 올리면 시트 내역과 합쳐서 비교해요. 이 파일들은 시트에 저장하지 않아서 창을 닫으면 사라져요.' : '가계부 앱이 구글 드라이브에 저장한 <b>가계부_내역_전체.csv</b>를 끌어다 놓으세요. 현대카드 명세서·실시간 이용내역(.xls), 네이버페이 내역 CSV도 읽어요. 같은 종류·같은 기간 파일을 다시 올리면 새 파일로 바뀌어요.'}</p>
        <div class="drop" id="drop2">여기에 파일을 끌어다 놓거나 <button class="btn" id="pick2">파일 고르기</button></div></div>
      <div class="card"><h2>불러온 파일 · ${files.length}개</h2>
        ${files.length ? `<table><thead><tr><th>종류</th><th>기간</th><th class="num">건수</th><th>파일 이름</th><th></th></tr></thead><tbody>${files.map((f) => `<tr><td>${esc(f.kind)}</td><td>${esc(f.label)}</td><td class="num">${f.rows.length}</td><td class="muted">${esc(f.name)}</td><td><button class="btn small fdel" data-key="${esc(f.key)}">빼기</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">아직 없어요.</p>'}</div>
      <div class="card"><h2>계산 방법</h2>
        <label><input type="checkbox" id="optTransfer" ${S.opts.excludeTransfer ? 'checked' : ''}> 송금은 지출에서 빼기</label>
        <p class="muted" style="margin:6px 0 0">할부는 결제한 달에 전체 금액으로 세고, 내역 표에 월 금액·남은 금액을 같이 보여줘요.</p></div>
      <div class="card"><h2>가계부 앱으로 보내기</h2><p class="sub">합쳐서 정리한 내역을 가계부 앱이 읽는 CSV(14열)로 저장해요. 카테고리 칸에는 대분류만 들어가고, 카드+네이버페이로 합친 건은 한 줄로 나가요. 앱의 CSV 가져오기로 넣으면 돼요.</p>
        <button class="btn" id="appOut" ${D && D.items.length ? '' : 'disabled'}>가계부 앱용 CSV 저장</button></div>
      <div class="card"><h2>백업</h2><p class="sub">분류 기억, 건별 분류, 세부 분류 목록을 파일로 저장해 다른 PC로 옮기거나 되살릴 수 있어요. 불러온 내역은 포함하지 않아요 (CSV를 다시 올리면 돼요). API 키도 넣지 않아요.</p>
        <button class="btn" id="bkOut">백업 파일 저장</button> <button class="btn" id="bkIn">백업 파일 불러오기</button></div>
      ${GAS ? `<div class="card"><h2>가계부 앱 연결 비밀번호 ${G.hasSync ? '<span class="pill">정해짐</span>' : '<span class="pill warn">아직 없음</span>'}</h2><p class="sub">가계부 앱이 이 시트에 내역을 보낼 때 쓰는 비밀번호예요. 8자 이상으로 정하고, 앱 설정에도 똑같이 넣어 주세요. 다시 정하면 앱 쪽도 바꿔야 해요.</p>
        <input type="password" id="synckey" size="30" placeholder="8자 이상"> <button class="btn" id="syncSave">${G.hasSync ? '바꾸기' : '정하기'}</button></div>` : ''}
      <div class="card"><h2>AI 자동 분류 ${GAS && G.hasAi ? '<span class="pill">키 저장됨</span>' : ''}</h2><p class="sub">Anthropic API 키를 넣으면 '분류하기'에서 AI 자동 분류 버튼을 쓸 수 있어요. ${GAS ? '키는 이 시트의 앱스 스크립트 설정에 저장되고 화면에는 다시 보이지 않아요.' : '키는 이 PC의 브라우저에만 저장돼요.'} AI에는 분류 안 된 가게 이름과 분류 목록만 보내요 (금액·날짜는 안 보내요).</p>
        <input type="password" id="apikey" size="44" placeholder="sk-ant-..." value="${GAS ? '' : esc(apiKey())}"> <button class="btn" id="keySave">저장</button> <button class="btn" id="keyDel">지우기</button></div>
      ${GAS ? '' : `<div class="card"><h2>모두 지우기</h2><p class="sub">이 브라우저에 저장된 내역·분류를 모두 지워요. 먼저 백업 파일을 저장해 두세요.</p><button class="btn" id="wipe">모두 지우기</button></div>`}`;
  }
  function bindFiles(root) {
    setupDrop($('#drop2', root), $('#pick2', root));
    root.querySelectorAll('.fdel').forEach((b) => b.onclick = () => { S.files = S.files.filter((f) => f.key !== b.dataset.key); save(); recompute(); render(); });
    $('#optTransfer', root).onchange = (e) => { S.opts.excludeTransfer = e.target.checked; save(); recompute(); render(); };
    $('#appOut', root).onclick = () => {
      const items = D.items.map((x) => {
        const ov = S.overrides[x.r.id] || {};
        return { r: x.r, cat: x.c.cat, include: ov.exclude ? false : ov.include ? true : x.r.include };
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([C.toAppCSV(items)], { type: 'text/csv' }));
      a.download = `가계부_가져오기_${todayStr}.csv`; a.click();
    };
    $('#bkOut', root).onclick = () => {
      const fp = {};
      D.rows.forEach((r) => { if (S.overrides[r.id]) fp[r.id] = { date: r.date, time: r.time || '', amount: r.amount, store: r.store }; });
      const data = { app: 'spending-analyzer', version: 1, savedAt: new Date().toISOString(), memory: S.memory, overrides: S.overrides, fingerprints: fp, tree: S.tree, dismissed: S.dismissed, opts: S.opts, rules: S.rules };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
      a.download = `지출분석_백업_${todayStr}.json`; a.click();
    };
    $('#bkIn', root).onclick = () => pickFiles('.json', async (fs) => {
      try {
        const d = JSON.parse(await fs[0].text());
        if (d.app !== 'spending-analyzer') throw new Error('지출 분석 백업 파일이 아니에요');
        const m = C.remapOverrides(d.overrides || {}, d.fingerprints, D ? D.rows : []);
        Object.assign(S, { memory: d.memory || {}, overrides: m.overrides, tree: d.tree || S.tree, dismissed: d.dismissed || {}, opts: d.opts || S.opts, rules: d.rules || [] });
        save(); recompute(); render();
        toast(`백업을 불러왔어요${m.moved ? ` · 건별 분류 ${m.moved}건을 지금 내역에 맞춰 옮김` : ''}${m.lost ? ` · ${m.lost}건은 맞는 내역을 못 찾음` : ''}`);
      } catch (e) { toast(`불러오지 못했어요: ${e.message}`); }
    });
    $('#keySave', root).onclick = async () => {
      const v = $('#apikey').value.trim();
      if (!GAS) { apiKey(v); return toast('키를 저장했어요'); }
      if (!v) return toast('키를 넣어 주세요');
      try { await gasCall('saSetAiKey', v); G.hasAi = true; render(); toast('키를 저장했어요'); } catch (e) { toast(e.message); }
    };
    $('#keyDel', root).onclick = async () => {
      if (!GAS) { apiKey(''); return render(); }
      try { await gasCall('saSetAiKey', ''); G.hasAi = false; render(); } catch (e) { toast(e.message); }
    };
    const ss = $('#syncSave', root);
    if (ss) ss.onclick = async () => {
      try { await gasCall('saSetSyncKey', $('#synckey').value); G.hasSync = true; render(); toast('비밀번호를 정했어요. 가계부 앱 설정에도 같은 값을 넣어 주세요.'); } catch (e) { toast(e.message); }
    };
    const wp = $('#wipe', root);
    if (wp) wp.onclick = () => { if (confirm('정말 모두 지울까요?')) { try { localStorage.removeItem(KEY); } catch (e) { /* */ } location.reload(); } };
    const rl = $('#sheetReload', root); if (rl) rl.onclick = loadSheet;
  }

  // ---------- 파일 읽기 ----------
  async function readText(file) {
    const buf = await file.arrayBuffer();
    let t = new TextDecoder('utf-8').decode(buf);
    if (t.includes('�')) { try { t = new TextDecoder('euc-kr').decode(buf); } catch (e) { /* utf-8 그대로 */ } }
    return t;
  }
  async function addFiles(list) {
    const msgs = [];
    for (const f of list) {
      try {
        const p = C.parseFile(f.name, await readText(f));
        if (GAS && p.key === 'app') { msgs.push(`${f.name}: 가계부 내역은 구글 시트에서 읽어요`); continue; }
        S.files = S.files.filter((x) => x.key !== p.key);
        S.files.push({ key: p.key, kind: p.kind, name: f.name, label: p.label, rows: p.rows, problems: p.problems, addedAt: Date.now() });
        msgs.push(`${p.kind} ${p.rows.length}건`);
      } catch (e) { msgs.push(`${f.name}: ${e.message}`); }
    }
    save(); recompute(); render(); toast(msgs.join(' · '));
  }
  function pickFiles(accept, cb) {
    const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.accept = accept;
    i.onchange = () => cb([...i.files]); i.click();
  }
  function setupDrop(el, btn) {
    if (!el) return;
    el.ondragover = (e) => { e.preventDefault(); el.classList.add('over'); };
    el.ondragleave = () => el.classList.remove('over');
    el.ondrop = (e) => { e.preventDefault(); el.classList.remove('over'); addFiles([...e.dataTransfer.files]); };
    if (btn) btn.onclick = () => pickFiles('.csv,.xls,.html,.htm', addFiles);
  }
  // 어느 화면에서든 파일을 끌어다 놓으면 읽기
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { if (!e.target.closest('.drop')) { e.preventDefault(); if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); } });

  // ---------- 렌더 ----------
  const TABS = [['dash', '대시보드'], ['table', '내역'], ['classify', '분류하기'], ['check', '점검'], ['files', '파일·설정']];
  function render() {
    hideTip();
    const nav = $('nav');
    const pend = D && D.items.length ? pending() : { groups: [], agentRows: [] };
    const dupN = D && D.items.length ? C.findDuplicates(D.rows).filter((d) => !S.dismissed[d.key]).length : 0;
    nav.innerHTML = TABS.map(([k, l]) => {
      const n = k === 'classify' ? pend.groups.length + pend.agentRows.length : k === 'check' ? dupN : 0;
      return `<button data-tab="${k}" class="${UI.tab === k ? 'on' : ''}">${l}${n ? `<span class="badge">${n > 999 ? '999+' : n}</span>` : ''}</button>`;
    }).join('');
    nav.querySelectorAll('button').forEach((b) => b.onclick = () => { UI.tab = b.dataset.tab; UI.drill = null; render(); });
    const main = $('main');
    if (GAS && !G.loaded) {
      main.innerHTML = `<div class="card empty"><h2>${G.loading ? '구글 시트를 읽는 중이에요…' : '구글 시트를 읽지 못했어요'}</h2>${G.loading ? '' : '<p><button class="btn primary" id="retry">다시 읽기</button></p>'}</div>`;
      const rt = $('#retry'); if (rt) rt.onclick = loadSheet;
      return;
    }
    if (GAS && !D.items.length && UI.tab !== 'files') {
      main.innerHTML = `<div class="card empty"><h2>시트 '내역'이 아직 비어 있어요</h2>
        <p>가계부 앱 설정에서 이 웹 앱 주소와 연결 비밀번호를 넣고 동기화하면 여기에 내역이 보여요.<br>비밀번호는 <b>파일·설정</b> 탭에서 정해요.</p>
        <p><button class="btn" id="goFiles">파일·설정으로</button> <button class="btn" id="retry">다시 읽기</button></p></div>`;
      $('#goFiles').onclick = () => { UI.tab = 'files'; render(); };
      $('#retry').onclick = loadSheet;
      return;
    }
    if (!D.items.length && UI.tab !== 'files') {
      main.innerHTML = `<div class="card empty"><h2>지출 내역 파일을 올려주세요</h2>
        <p>가계부 앱이 구글 드라이브에 저장한 <b>가계부_내역_전체.csv</b>를 이 창에 끌어다 놓으면 돼요.<br>현대카드 명세서·실시간 이용내역(.xls)과 네이버페이 내역 CSV도 읽어요.</p>
        <div class="drop" id="drop1" style="max-width:520px;margin:20px auto 0">여기에 끌어다 놓기 · <button class="btn primary" id="pick1">파일 고르기</button></div>
        <p class="muted" style="margin-top:16px">내역은 이 PC 브라우저에만 저장되고 밖으로 나가지 않아요.</p></div>`;
      setupDrop($('#drop1'), $('#pick1'));
      return;
    }
    const views = { dash: [viewDash, bindDash], table: [viewTable, bindTable], classify: [viewClassify, bindClassify], check: [viewCheck, bindCheck], files: [viewFiles, bindFiles] };
    const [v, b] = views[UI.tab];
    main.innerHTML = v();
    b(main); bindTips(main);
  }

  recompute();
  if (GAS) loadSheet(); else render();
  window.__SA = { S, UI, G, get D() { return D; }, addFiles, render, loadSheet };
})();
