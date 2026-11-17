'use strict';
/* 데이터 가공 도구
 * - 모든 처리는 브라우저 메모리 안에서만 수행. 네트워크 API 사용 안 함.
 * - 흐름: 파일 → 시트 선택 → 원본 읽기(머리글·병합·소계) → 가공 단계 순차 적용 → 내려받기
 */

const PREVIEW_ROWS = 500;
const RULE_APP = 'data-shaper';
const RULE_VERSION = 1;

// ───────────────────────── 상태 ─────────────────────────
const S = {
  fileName: '',
  wb: null,
  isCsv: false,
  sheet: null,
  sheets: {},     // 시트명 → { grid, merges, read, steps, toggled:Set, detected }
  view: 'result',
  base: null,     // 읽기 설정 적용한 표 + 행 정보
  out: null,      // 최종 결과 표
  stepInfo: [],   // 단계별 { inCols, rows, cols, error, warn }
};

const $ = (id) => document.getElementById(id);
const cur = () => S.sheets[S.sheet];

// ───────────────────────── 값 처리 ─────────────────────────
function isEmpty(v) {
  return v == null || (typeof v === 'string' && v.trim() === '');
}
function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function hasTime(d) { return d.getHours() || d.getMinutes() || d.getSeconds(); }
function fmtDate(d, f = 'YYYY-MM-DD') {
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  switch (f) {
    case 'YYYY.MM.DD': return `${y}.${pad(m)}.${pad(day)}`;
    case 'YYYY/MM/DD': return `${y}/${pad(m)}/${pad(day)}`;
    case 'YYYYMMDD': return `${y}${pad(m)}${pad(day)}`;
    case 'YYYY-MM': return `${y}-${pad(m)}`;
    case 'KR': return `${y}년 ${m}월 ${day}일`;
    default: {
      const s = `${y}-${pad(m)}-${pad(day)}`;
      return hasTime(d) ? `${s} ${pad(d.getHours())}:${pad(d.getMinutes())}` : s;
    }
  }
}
// 셀 값 → 표시·비교용 문자열
function str(v) {
  if (v == null) return '';
  if (v instanceof Date) return fmtDate(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toPrecision(15));
  return String(v);
}
// 숫자로 해석 (쉼표·원·공백·괄호 음수 처리). 실패 시 null
function toNum(v, percent = false) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || v == null || v instanceof Date) return null;
  let s = String(v).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  let pct = false;
  if (percent && s.endsWith('%')) { pct = true; s = s.slice(0, -1); }
  s = s.replace(/[,\s₩]/g, '').replace(/원$/, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  let n = parseFloat(s);
  if (neg) n = -n;
  if (pct) n = n / 100;
  return n;
}
// 날짜로 해석. 실패 시 null
function toDate(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= 19000101 && v <= 21001231) return toDate(String(v));
    return null;
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = s.match(/^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) {
    const m2 = s.match(/^(\d{2})[-./](\d{1,2})[-./](\d{1,2})$/);
    if (m2) m = [s, String(2000 + +m2[1]), m2[2], m2[3]];
  }
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  if (d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
  return d;
}
// 정렬·비교용
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
function cmp(a, b) {
  const ea = isEmpty(a), eb = isEmpty(b);
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  if (a instanceof Date && b instanceof Date) return a - b;
  const na = toNum(a), nb = toNum(b);
  if (na != null && nb != null) return na - nb;
  return collator.compare(str(a), str(b));
}
function serial(d) {
  return (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) - Date.UTC(1899, 11, 30)) / 86400000;
}

// ───────────────────────── 파일 읽기 ─────────────────────────
function decodeText(buf) {
  // UTF-8 우선, 실패하면 CP949(EUC-KR)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); }
  catch (e) { return new TextDecoder('euc-kr').decode(buf); }
}
function parseCsv(text) {
  // 구분자 추정: 첫 몇 줄에서 쉼표·탭·세미콜론 중 가장 많은 것
  const head = text.slice(0, 5000);
  const cand = [',', '\t', ';'];
  const sep = cand.map((c) => [c, head.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map(csvValue));
}
function csvValue(s) {
  if (s == null) return null;
  s = String(s);
  if (s.trim() === '') return null;
  const t = s.trim();
  // 앞자리 0 있는 코드(001234)는 글자 그대로 유지
  if (/^-?(0|[1-9]\d{0,2}(,\d{3})+|[1-9]\d*)(\.\d+)?$/.test(t)) return parseFloat(t.replace(/,/g, ''));
  if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}(\s+\d{1,2}:\d{2}(:\d{2})?)?$/.test(t)) { const d = toDate(t); if (d) return d; }
  return s;
}
function cellValue(c) {
  if (!c || c.v == null || c.t === 'z' || c.t === 'e') return null;
  if (c.t === 'd') return c.v instanceof Date ? c.v : toDate(String(c.v));
  if (c.t === 'n') {
    if (c.z && XLSX.SSF.is_date(c.z)) {
      const p = XLSX.SSF.parse_date_code(c.v);
      if (p) return new Date(p.y, p.m - 1, p.d, p.H, p.M, Math.round(p.S));
    }
    return c.v;
  }
  if (c.t === 'b') return c.v;
  const s = String(c.v);
  return s.trim() === '' ? null : s;
}
function sheetToGrid(ws) {
  const out = { grid: [], merges: [] };
  if (!ws) return out;
  if (ws.csvRows) {
    const w = ws.csvRows.reduce((a, r) => Math.max(a, r.length), 0);
    out.grid = ws.csvRows.map((r) => { const x = r.slice(); while (x.length < w) x.push(null); return x; });
    while (out.grid.length && filled(out.grid[out.grid.length - 1]) === 0) out.grid.pop();
    return out;
  }
  // !ref가 서식 때문에 과하게 넓은 경우가 있어 실제 값 있는 칸 기준으로 범위 계산
  let maxR = -1, maxC = -1, minR = Infinity, minC = Infinity;
  for (const k in ws) {
    if (k[0] === '!') continue;
    const a = XLSX.utils.decode_cell(k);
    if (isEmpty(ws[k].v)) continue;
    if (a.r > maxR) maxR = a.r; if (a.c > maxC) maxC = a.c;
    if (a.r < minR) minR = a.r; if (a.c < minC) minC = a.c;
  }
  if (maxR < 0) return out;
  minR = 0; // 줄 번호를 엑셀과 맞추려고 1행부터
  minC = Math.min(minC, 0);
  for (let r = minR; r <= maxR; r++) {
    const row = new Array(maxC - minC + 1);
    for (let c = minC; c <= maxC; c++) row[c - minC] = cellValue(ws[XLSX.utils.encode_cell({ r, c })]);
    out.grid.push(row);
  }
  out.merges = (ws['!merges'] || [])
    .map((m) => ({ s: { r: m.s.r - minR, c: m.s.c - minC }, e: { r: Math.min(m.e.r, maxR) - minR, c: Math.min(m.e.c, maxC) - minC } }))
    .filter((m) => m.s.r <= m.e.r && m.s.c <= m.e.c);
  return out;
}
async function readWorkbook(file) {
  const buf = await file.arrayBuffer();
  const csv = /\.(csv|txt)$/i.test(file.name);
  let wb;
  // CSV는 직접 파싱 (라이브러리 자동 변환이 앞자리 0·날짜를 바꿔버림)
  if (csv) wb = { SheetNames: ['CSV'], Sheets: { CSV: { csvRows: parseCsv(decodeText(buf)) } } };
  else wb = XLSX.read(buf, { type: 'array', cellNF: true, cellDates: false });
  return { wb, csv };
}

// ───────────────────────── 머리글 감지 ─────────────────────────
function fillAllMerges(grid, merges) {
  const g = grid.map((r) => r.slice());
  for (const m of merges) {
    const v = grid[m.s.r] && grid[m.s.r][m.s.c];
    if (v == null) continue;
    for (let r = m.s.r; r <= m.e.r; r++) for (let c = m.s.c; c <= m.e.c; c++) if (g[r]) g[r][c] = v;
  }
  return g;
}
function filled(row) { let n = 0; for (const v of row) if (!isEmpty(v)) n++; return n; }
function detectHeader(grid, merges) {
  const g = fillAllMerges(grid, merges);
  const N = Math.min(g.length, 60);
  if (!N) return { headerStart: 0, headerRows: 1 };
  const counts = g.slice(0, N).map(filled);
  const max = Math.max(...counts);
  const need = Math.max(2, Math.ceil(max * 0.6));
  const isText = (v) => typeof v === 'string' && toNum(v) == null && !toDate(v);
  const distinct = (row) => new Set(row.filter((v) => !isEmpty(v)).map(str)).size;
  // 숫자·날짜가 들어간 첫 데이터 줄 찾기
  let dataRow = -1;
  for (let r = 0; r < N; r++) {
    if (counts[r] < need) continue;
    if (g[r].some((v) => typeof v === 'number' || v instanceof Date)) { dataRow = r; break; }
  }
  if (dataRow > 0) {
    // 데이터 바로 위에서 위로 올라가며 글자로만 된 줄을 머리글로 (최대 3줄)
    let start = dataRow, r = dataRow - 1;
    while (r >= 0 && dataRow - r <= 3) {
      const row = g[r];
      if (filled(row) < Math.max(2, Math.ceil(counts[dataRow] * 0.5)) || distinct(row) < 2) break;
      if (!row.every((v) => isEmpty(v) || isText(v))) break;
      start = r; r--;
    }
    if (start < dataRow) return { headerStart: start, headerRows: dataRow - start };
  }
  const hs = Math.max(0, counts.findIndex((c) => c >= need));
  const hn = merges.some((m) => m.s.r === hs && m.e.c > m.s.c) ? 2 : 1;
  return { headerStart: hs, headerRows: hn };
}

// ───────────────────────── 원본 → 기본 표 ─────────────────────────
function subtotalReason(row, ncols) {
  for (const v of row) {
    if (typeof v !== 'string') continue;
    const t = v.replace(/[\s:()[\]<>·\-]/g, '').toLowerCase();
    if (/^(합계|소계|총계|누계|중계|계|총합|total|subtotal|grandtotal|sum)$/.test(t) || /(합계|소계|총계|누계)$/.test(t)) return '합계 글자';
  }
  const n = filled(row);
  if (ncols >= 4 && n > 0 && n <= Math.ceil(ncols * 0.25)) return '빈 칸 많음';
  return null;
}
function buildBase(sh) {
  const { grid, merges, read } = sh;
  const hs = Math.min(read.headerStart, Math.max(0, grid.length - 1));
  const hn = read.headerRows;
  const g = grid.map((r) => r.slice());
  for (const m of merges) {
    const v = grid[m.s.r] && grid[m.s.r][m.s.c];
    if (v == null) continue;
    const inHdr = m.s.r >= hs && m.s.r < hs + hn;
    if (!inHdr && !read.fillMerges) continue;
    for (let r = m.s.r; r <= m.e.r; r++) for (let c = m.s.c; c <= m.e.c; c++) if (g[r]) g[r][c] = v;
  }
  const ncol = g.reduce((a, r) => Math.max(a, r.length), 0);
  // 위쪽 머리글 줄의 빈 칸은 왼쪽 값으로 채움 (병합 없이 가운데 맞춤한 경우 대비)
  const hdr = [];
  for (let r = hs; r < hs + hn && r < g.length; r++) {
    const row = g[r].slice();
    if (r < hs + hn - 1) for (let c = 1; c < ncol; c++) if (isEmpty(row[c]) && !isEmpty(row[c - 1])) row[c] = row[c - 1];
    hdr.push(row);
  }
  // 위 줄 채움이 아래 줄 없는 칸까지 번지지 않게: 마지막 줄이 비고 위 줄이 왼쪽에서 번진 값이면 제외
  let names = [];
  for (let c = 0; c < ncol; c++) {
    const parts = [];
    for (let i = 0; i < hdr.length; i++) {
      const s = str(hdr[i][c]).trim().replace(/\s+/g, ' ');
      if (s && parts[parts.length - 1] !== s) parts.push(s);
    }
    names.push(parts.join('_'));
  }
  const dataIdx = [];
  for (let r = hs + hn; r < g.length; r++) if (filled(g[r]) > 0) dataIdx.push(r);
  // 이름도 데이터도 없는 열은 버림
  const keepCols = [];
  for (let c = 0; c < ncol; c++) {
    if (names[c] || dataIdx.some((r) => !isEmpty(g[r][c]))) keepCols.push(c);
  }
  const used = new Map();
  const cols = keepCols.map((c) => {
    let n = names[c] || `열${c + 1}`;
    if (used.has(n)) { let k = used.get(n) + 1; used.set(n, k); n = `${n}_${k}`; } else used.set(n, 1);
    return n;
  });
  const rowInfo = new Map(); // 원본 줄 번호 → { reason, dropped }
  const rows = [];
  for (const r of dataIdx) {
    const row = keepCols.map((c) => (g[r][c] === undefined ? null : g[r][c]));
    const reason = subtotalReason(row, cols.length);
    const toggled = sh.toggled.has(r);
    let dropped = reason ? read.dropSubtotals : false;
    if (toggled) dropped = !dropped;
    rowInfo.set(r, { reason, dropped });
    if (!dropped) rows.push(row);
  }
  return { cols, rows, rowInfo, hs, hn, flagged: [...rowInfo.values()].filter((x) => x.reason).length };
}

// ───────────────────────── 가공 단계 ─────────────────────────
function ci(t, name) {
  const i = t.cols.indexOf(name);
  if (i < 0) throw new Error(`'${name}' 열이 없음`);
  return i;
}
function uniqName(cols, name) {
  if (!cols.includes(name)) return name;
  let k = 2; while (cols.includes(`${name}_${k}`)) k++;
  return `${name}_${k}`;
}

const FILTER_OPS = [
  ['eq', '같음'], ['ne', '같지 않음'], ['has', '포함'], ['nhas', '포함 안 함'], ['start', '시작'], ['end', '끝'],
  ['in', '다음 중 하나 (쉼표 구분)'], ['gt', '>'], ['ge', '≥'], ['lt', '<'], ['le', '≤'], ['empty', '비어 있음'], ['nempty', '비어 있지 않음'],
];
function testCond(v, op, val) {
  const s = str(v).trim(), q = String(val ?? '').trim();
  switch (op) {
    case 'empty': return isEmpty(v);
    case 'nempty': return !isEmpty(v);
    case 'has': return s.includes(q);
    case 'nhas': return !s.includes(q);
    case 'start': return s.startsWith(q);
    case 'end': return s.endsWith(q);
    case 'in': return q.split(',').map((x) => x.trim()).filter(Boolean).some((x) => eqVal(v, x));
    case 'eq': return eqVal(v, q);
    case 'ne': return !eqVal(v, q);
    default: {
      let a, b;
      if (v instanceof Date || (toNum(q) == null && toDate(q))) { const dv = toDate(v), dq = toDate(q); if (!dv || !dq) return false; a = +dv; b = +dq; }
      else { a = toNum(v); b = toNum(q); if (a == null || b == null) return false; }
      return op === 'gt' ? a > b : op === 'ge' ? a >= b : op === 'lt' ? a < b : a <= b;
    }
  }
}
function eqVal(v, q) {
  if (isEmpty(v)) return q === '';
  if (v instanceof Date) { const d = toDate(q); return !!d && fmtDate(d) === fmtDate(v); }
  if (typeof v === 'number') { const n = toNum(q); if (n != null) return n === v; }
  return str(v).trim() === q;
}

// 계산식: 숫자, [열 이름], + - * / ( ), ROUND(x[,n]) ABS(x)
function parseExpr(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '[') { const j = src.indexOf(']', i); if (j < 0) throw new Error('] 가 빠짐'); toks.push({ t: 'col', v: src.slice(i + 1, j).trim() }); i = j + 1; continue; }
    if (/[\d.]/.test(ch)) { const m = src.slice(i).match(/^\d*\.?\d+(e[-+]?\d+)?/i); toks.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
    if (/[A-Za-z]/.test(ch)) { const m = src.slice(i).match(/^[A-Za-z]+/); toks.push({ t: 'fn', v: m[0].toUpperCase() }); i += m[0].length; continue; }
    if ('+-*/(),'.includes(ch)) { toks.push({ t: ch }); i++; continue; }
    throw new Error(`알 수 없는 글자: ${ch}`);
  }
  let p = 0;
  const peek = () => toks[p], eat = (t) => { if (!toks[p] || toks[p].t !== t) throw new Error(`'${t}' 가 필요함`); return toks[p++]; };
  function expr() { let n = term(); while (peek() && (peek().t === '+' || peek().t === '-')) { const o = toks[p++].t; n = { o, a: n, b: term() }; } return n; }
  function term() { let n = unary(); while (peek() && (peek().t === '*' || peek().t === '/')) { const o = toks[p++].t; n = { o, a: n, b: unary() }; } return n; }
  function unary() { if (peek() && peek().t === '-') { p++; return { o: 'neg', a: unary() }; } if (peek() && peek().t === '+') { p++; return unary(); } return atom(); }
  function atom() {
    const t = peek();
    if (!t) throw new Error('식이 덜 끝남');
    if (t.t === 'num') { p++; return { o: 'num', v: t.v }; }
    if (t.t === 'col') { p++; return { o: 'col', v: t.v }; }
    if (t.t === '(') { p++; const n = expr(); eat(')'); return n; }
    if (t.t === 'fn') {
      p++; if (!['ROUND', 'ABS'].includes(t.v)) throw new Error(`없는 함수: ${t.v}`);
      eat('('); const args = [expr()]; while (peek() && peek().t === ',') { p++; args.push(expr()); } eat(')');
      return { o: 'fn', v: t.v, args };
    }
    throw new Error('식 형식이 이상함');
  }
  const tree = expr();
  if (p < toks.length) throw new Error('식 뒤에 남은 글자가 있음');
  return tree;
}
function exprCols(n, out = []) {
  if (!n) return out;
  if (n.o === 'col') out.push(n.v);
  if (n.a) exprCols(n.a, out); if (n.b) exprCols(n.b, out);
  if (n.args) n.args.forEach((x) => exprCols(x, out));
  return out;
}
function evalExpr(n, get) {
  switch (n.o) {
    case 'num': return n.v;
    case 'col': { const v = get(n.v); if (isEmpty(v)) return 0; return toNum(v); }
    case 'neg': { const a = evalExpr(n.a, get); return a == null ? null : -a; }
    case 'fn': {
      const a = evalExpr(n.args[0], get); if (a == null) return null;
      if (n.v === 'ABS') return Math.abs(a);
      const d = n.args[1] ? evalExpr(n.args[1], get) || 0 : 0; const f = Math.pow(10, d);
      return Math.round(a * f) / f;
    }
    default: {
      const a = evalExpr(n.a, get), b = evalExpr(n.b, get);
      if (a == null || b == null) return null;
      if (n.o === '+') return a + b; if (n.o === '-') return a - b; if (n.o === '*') return a * b;
      return b === 0 ? null : a / b;
    }
  }
}

const AGG_FNS = [['sum', '합계'], ['count', '개수'], ['rows', '행 수'], ['avg', '평균'], ['min', '최소'], ['max', '최대'], ['distinct', '고유 개수']];
const DATE_FMTS = [['date', '엑셀 날짜 값'], ['YYYY-MM-DD', '2026-01-05'], ['YYYY.MM.DD', '2026.01.05'], ['YYYY/MM/DD', '2026/01/05'], ['YYYYMMDD', '20260105'], ['YYYY-MM', '2026-01'], ['KR', '2026년 1월 5일']];
const VAL_ACTIONS = [['trim', '앞뒤 공백 정리'], ['number', '숫자로 바꾸기'], ['date', '날짜 형식 맞추기'], ['replace', '값 치환'], ['fill', '빈 칸 채우기']];

// 단계 정의: label, icon, desc, init(cols), apply(t, st) → {cols, rows, warn?}, summary(st)
const STEP_DEFS = {
  columns: {
    label: '열 정리', icon: '☰', desc: '고르기·순서·이름',
    init: (cols) => ({ items: cols.map((c) => ({ src: c, name: c, keep: true })) }),
    apply(t, st) {
      reconcileColumns(st, t.cols);
      const items = st.items.filter((x) => x.keep && t.cols.includes(x.src));
      const idx = items.map((x) => t.cols.indexOf(x.src));
      const names = [];
      items.forEach((x) => names.push(uniqName(names, (x.name || x.src).trim() || x.src)));
      const missing = st.items.filter((x) => x.keep && !t.cols.includes(x.src)).map((x) => x.src);
      return { cols: names, rows: t.rows.map((r) => idx.map((i) => r[i])), warn: missing.length ? `원본에 없는 열: ${missing.join(', ')}` : null };
    },
    summary: (st) => { const k = st.items.filter((x) => x.keep); const rn = k.filter((x) => x.name && x.name !== x.src).length; return `${k.length}개 열${rn ? ` · 이름 ${rn}개 변경` : ''}`; },
  },
  filter: {
    label: '필터', icon: '▽', desc: '조건에 맞는 행만',
    init: (cols) => ({ mode: 'and', conds: [{ col: cols[0] || '', op: 'eq', val: '' }] }),
    apply(t, st) {
      const cs = st.conds.filter((c) => c.col);
      if (!cs.length) return t;
      const ix = cs.map((c) => ci(t, c.col));
      const rows = t.rows.filter((r) => {
        const res = cs.map((c, k) => testCond(r[ix[k]], c.op, c.val));
        return st.mode === 'or' ? res.some(Boolean) : res.every(Boolean);
      });
      return { cols: t.cols, rows };
    },
    summary: (st) => st.conds.filter((c) => c.col).map((c) => `${c.col} ${opLabel(c.op)}${['empty', 'nempty'].includes(c.op) ? '' : ' ' + (c.val || '""')}`).join(st.mode === 'or' ? ' 또는 ' : ' 그리고 '),
  },
  sort: {
    label: '정렬', icon: '⇅', desc: '오름차순·내림차순',
    init: (cols) => ({ keys: [{ col: cols[0] || '', dir: 'asc' }] }),
    apply(t, st) {
      const ks = st.keys.filter((k) => k.col).map((k) => ({ i: ci(t, k.col), d: k.dir === 'desc' ? -1 : 1 }));
      if (!ks.length) return t;
      const rows = t.rows.map((r, i) => [r, i]).sort((A, B) => {
        for (const k of ks) {
          const a = A[0][k.i], b = B[0][k.i];
          const ea = isEmpty(a), eb = isEmpty(b);
          if (ea || eb) { if (ea !== eb) return ea ? 1 : -1; continue; } // 빈 값은 항상 맨 뒤
          const c = cmp(a, b) * k.d; if (c) return c;
        }
        return A[1] - B[1];
      }).map((x) => x[0]);
      return { cols: t.cols, rows };
    },
    summary: (st) => st.keys.filter((k) => k.col).map((k) => `${k.col} ${k.dir === 'desc' ? '↓' : '↑'}`).join(', '),
  },
  dedupe: {
    label: '중복 제거', icon: '⧉', desc: '같은 행 하나만',
    init: () => ({ cols: [], keep: 'first' }),
    apply(t, st) {
      const ix = st.cols.length ? st.cols.map((c) => ci(t, c)) : t.cols.map((_, i) => i);
      const seen = new Set();
      const src = st.keep === 'last' ? t.rows.slice().reverse() : t.rows;
      const out = [];
      for (const r of src) {
        const key = JSON.stringify(ix.map((i) => str(r[i]).trim()));
        if (seen.has(key)) continue; seen.add(key); out.push(r);
      }
      if (st.keep === 'last') out.reverse();
      return { cols: t.cols, rows: out };
    },
    summary: (st) => `${st.cols.length ? st.cols.join(', ') + ' 기준' : '모든 열 기준'} · ${st.keep === 'last' ? '마지막' : '첫'} 행 유지`,
  },
  values: {
    label: '값 바꾸기', icon: '✎', desc: '공백·숫자·날짜·치환',
    init: (cols) => ({ cols: cols[0] ? [cols[0]] : [], action: 'trim', fmt: 'YYYY-MM-DD', find: '', to: '', whole: true, fill: 'above', fillVal: '' }),
    apply(t, st) {
      const ix = st.cols.map((c) => ci(t, c));
      const rows = t.rows.map((r) => r.slice());
      let fails = 0;
      for (const i of ix) {
        let prev = null;
        for (const r of rows) {
          const v = r[i];
          switch (st.action) {
            case 'trim': if (typeof v === 'string') { const s = v.replace(/[\s ]+/g, ' ').trim(); r[i] = s === '' ? null : s; } break;
            case 'number': if (!isEmpty(v) && typeof v !== 'number') { const n = toNum(v, true); if (n == null) fails++; else r[i] = n; } break;
            case 'date': if (!isEmpty(v)) { const d = toDate(v); if (!d) fails++; else r[i] = st.fmt === 'date' ? d : fmtDate(d, st.fmt); } break;
            case 'replace': {
              if (st.find === '' && !st.whole) break;
              const s = str(v);
              if (st.whole) { if (s.trim() === st.find.trim()) r[i] = st.to === '' ? null : st.to; }
              else if (s.includes(st.find)) { const ns = s.split(st.find).join(st.to); r[i] = ns === '' ? null : ns; }
              break;
            }
            case 'fill':
              if (isEmpty(v)) r[i] = st.fill === 'above' ? prev : (st.fillVal === '' ? null : st.fillVal);
              else prev = v;
              if (st.fill === 'above' && !isEmpty(r[i])) prev = r[i];
              break;
          }
        }
      }
      return { cols: t.cols, rows, warn: fails ? `바꾸지 못한 값 ${fails.toLocaleString()}개 (그대로 둠)` : null };
    },
    summary: (st) => {
      const a = VAL_ACTIONS.find((x) => x[0] === st.action)[1];
      const extra = st.action === 'date' ? ` (${DATE_FMTS.find((x) => x[0] === st.fmt)[1]})` : st.action === 'replace' ? ` "${st.find}"→"${st.to}"` : '';
      return `${st.cols.join(', ') || '열 선택 필요'} · ${a}${extra}`;
    },
  },
  merge: {
    label: '열 합치기', icon: '⊕', desc: '여러 열 → 한 열',
    init: () => ({ cols: [], sep: ' ', name: '', drop: true }),
    apply(t, st) {
      if (st.cols.length < 1) return t;
      const ix = st.cols.map((c) => ci(t, c));
      const name = (st.name || st.cols.join('')).trim();
      const at = Math.min(...ix);
      const val = (r) => { const s = ix.map((i) => str(r[i]).trim()).filter(Boolean).join(st.sep); return s === '' ? null : s; };
      let cols = t.cols.slice(), rows = t.rows.map((r) => r.slice());
      if (st.drop) {
        const drop = new Set(ix);
        const newRows = rows.map((r) => { const v = val(r); const out = r.filter((_, i) => !drop.has(i)); out.splice(at - [...drop].filter((i) => i < at).length, 0, v); return out; });
        cols = cols.filter((_, i) => !drop.has(i));
        cols.splice(at - [...drop].filter((i) => i < at).length, 0, uniqName(cols, name));
        return { cols, rows: newRows };
      }
      cols.splice(at, 0, uniqName(cols, name));
      return { cols, rows: rows.map((r) => { const v = val(r); r.splice(at, 0, v); return r; }) };
    },
    summary: (st) => st.cols.length ? `${st.cols.join(' + ')} → ${st.name || st.cols.join('')}` : '열 선택 필요',
  },
  split: {
    label: '열 나누기', icon: '⊘', desc: '한 열 → 여러 열',
    init: (cols) => ({ col: cols[0] || '', sep: '/', names: '', drop: true }),
    apply(t, st) {
      if (!st.col) return t;
      const i = ci(t, st.col);
      if (st.sep === '') throw new Error('구분자를 넣어야 함');
      const parts = t.rows.map((r) => (isEmpty(r[i]) ? [] : str(r[i]).split(st.sep).map((s) => s.trim())));
      const n = Math.min(20, Math.max(1, ...parts.map((p) => p.length)));
      const given = st.names.split(',').map((s) => s.trim()).filter(Boolean);
      const base = st.drop ? t.cols.filter((_, k) => k !== i) : t.cols.slice();
      const newNames = [];
      for (let k = 0; k < n; k++) newNames.push(uniqName([...base, ...newNames], given[k] || `${st.col}_${k + 1}`));
      const at = st.drop ? i : i + 1;
      const cols = base.slice(); cols.splice(at, 0, ...newNames);
      const rows = t.rows.map((r, ri) => {
        const vals = []; for (let k = 0; k < n; k++) { const v = parts[ri][k]; vals.push(v == null || v === '' ? null : csvValue(v)); }
        const out = st.drop ? r.filter((_, k) => k !== i) : r.slice();
        out.splice(at, 0, ...vals); return out;
      });
      return { cols, rows, warn: parts.some((p) => p.length > 20) ? '20개 넘는 조각은 버림' : null };
    },
    summary: (st) => st.col ? `${st.col} 을 "${st.sep}" 기준으로` : '열 선택 필요',
  },
  calc: {
    label: '계산 열', icon: 'ƒ', desc: '[단가]*[수량] 같은 식',
    init: () => ({ name: '계산', expr: '' }),
    apply(t, st) {
      if (!st.expr.trim()) return t;
      const tree = parseExpr(st.expr);
      const used = exprCols(tree);
      const ix = {}; used.forEach((c) => { ix[c] = ci(t, c); });
      let bad = 0;
      const name = uniqName(t.cols, (st.name || '계산').trim());
      const rows = t.rows.map((r) => { const v = evalExpr(tree, (c) => r[ix[c]]); if (v == null) bad++; return [...r, v == null ? null : +v.toPrecision(15)]; });
      return { cols: [...t.cols, name], rows, warn: bad ? `계산 못 한 행 ${bad.toLocaleString()}개 (숫자가 아니거나 0으로 나눔)` : null };
    },
    summary: (st) => st.expr ? `${st.name || '계산'} = ${st.expr}` : '식 입력 필요',
  },
  group: {
    label: '집계', icon: 'Σ', desc: '그룹별 합계·개수·평균',
    init: (cols) => ({ by: [], aggs: [{ col: cols[0] || '', fn: 'sum', name: '' }] }),
    apply(t, st) {
      const bi = st.by.map((c) => ci(t, c));
      const ags = st.aggs.filter((a) => a.col || a.fn === 'rows').map((a) => ({ ...a, i: a.fn === 'rows' ? -1 : ci(t, a.col) }));
      const groups = new Map();
      for (const r of t.rows) {
        const key = JSON.stringify(bi.map((i) => str(r[i])));
        let g = groups.get(key); if (!g) { g = { keyVals: bi.map((i) => r[i]), rows: [] }; groups.set(key, g); }
        g.rows.push(r);
      }
      if (!bi.length && !groups.size) groups.set('[]', { keyVals: [], rows: [] });
      const names = [...st.by];
      ags.forEach((a) => names.push(uniqName(names, (a.name || (a.fn === 'rows' ? '행 수' : `${a.col}_${fnLabel(a.fn)}`)).trim())));
      const rows = [];
      for (const g of groups.values()) {
        const out = g.keyVals.slice();
        for (const a of ags) {
          if (a.fn === 'rows') { out.push(g.rows.length); continue; }
          const vs = g.rows.map((r) => r[a.i]).filter((v) => !isEmpty(v));
          if (a.fn === 'count') { out.push(vs.length); continue; }
          if (a.fn === 'distinct') { out.push(new Set(vs.map(str)).size); continue; }
          if (a.fn === 'min' || a.fn === 'max') {
            if (!vs.length) { out.push(null); continue; }
            let m = vs[0]; for (const v of vs) { const c = cmp(v, m); if (a.fn === 'min' ? c < 0 : c > 0) m = v; } out.push(m); continue;
          }
          const ns = vs.map((v) => toNum(v)).filter((v) => v != null);
          const sum = ns.reduce((x, y) => x + y, 0);
          out.push(a.fn === 'sum' ? +sum.toPrecision(15) : ns.length ? +(sum / ns.length).toPrecision(15) : null);
        }
        rows.push(out);
      }
      return { cols: names, rows };
    },
    summary: (st) => `${st.by.length ? st.by.join(', ') + '별' : '전체'} · ${st.aggs.map((a) => a.fn === 'rows' ? '행 수' : `${a.col || '?'} ${fnLabel(a.fn)}`).join(', ')}`,
  },
  template: {
    label: '템플릿 맞추기', icon: '▤', desc: '템플릿 머리글 순서대로', hidden: true,
    init: () => ({ file: '', targets: [] }),
    apply(t, st) {
      const ix = st.targets.map((x) => (x.src && t.cols.includes(x.src) ? t.cols.indexOf(x.src) : -1));
      const lost = st.targets.filter((x) => x.src && !t.cols.includes(x.src)).map((x) => x.src);
      const empty = st.targets.filter((x, k) => ix[k] < 0).length;
      const names = []; st.targets.forEach((x) => names.push(uniqName(names, x.name)));
      const warn = [lost.length ? `없는 열: ${lost.join(', ')}` : '', empty ? `빈 열로 나가는 항목 ${empty}개` : ''].filter(Boolean).join(' · ');
      return { cols: names, rows: t.rows.map((r) => ix.map((i) => (i < 0 ? null : r[i]))), warn: warn || null };
    },
    summary: (st) => `${st.file || '템플릿'} · ${st.targets.length}개 열 · 연결 ${st.targets.filter((x) => x.src).length}개`,
  },
};
const opLabel = (op) => (FILTER_OPS.find((x) => x[0] === op) || [, op])[1];
const fnLabel = (fn) => (AGG_FNS.find((x) => x[0] === fn) || [, fn])[1];

function reconcileColumns(st, cols) {
  // 앞 단계가 바뀌어 새로 생긴 열은 뒤에 붙임
  const have = new Set(st.items.map((x) => x.src));
  for (const c of cols) if (!have.has(c)) st.items.push({ src: c, name: c, keep: true });
}

function runPipeline() {
  const sh = cur();
  if (!sh) return;
  S.base = buildBase(sh);
  let t = { cols: S.base.cols, rows: S.base.rows };
  S.stepInfo = [];
  for (const st of sh.steps) {
    const info = { inCols: t.cols.slice(), error: null, warn: null };
    if (st.on !== false) {
      try {
        const r = STEP_DEFS[st.type].apply(t, st);
        info.warn = r.warn || null;
        t = { cols: r.cols, rows: r.rows };
      } catch (e) { info.error = e.message || String(e); }
    }
    info.rows = t.rows.length; info.cols = t.cols.length;
    S.stepInfo.push(info);
  }
  S.out = t;
}

// ───────────────────────── 템플릿 연결 ─────────────────────────
const norm = (s) => String(s).toLowerCase().replace(/[\s_\-()[\]{}./·:]/g, '');
function bigrams(s) { const a = []; for (let i = 0; i < s.length - 1; i++) a.push(s.slice(i, i + 2)); return a; }
function similarity(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) return 0.8;
  const A = bigrams(x), B = bigrams(y);
  if (!A.length || !B.length) return 0;
  const pool = B.slice(); let hit = 0;
  for (const g of A) { const k = pool.indexOf(g); if (k >= 0) { hit++; pool.splice(k, 1); } }
  return (2 * hit) / (A.length + B.length);
}
function autoMatch(targets, cols) {
  const pairs = [];
  targets.forEach((t, ti) => cols.forEach((c, cj) => { const s = similarity(t, c); if (s >= 0.5) pairs.push([s, ti, cj]); }));
  pairs.sort((a, b) => b[0] - a[0]);
  const res = targets.map((name) => ({ name, src: null, auto: 'none' }));
  const usedC = new Set();
  for (const [s, ti, cj] of pairs) {
    if (res[ti].src || usedC.has(cj)) continue;
    res[ti].src = cols[cj]; res[ti].auto = s === 1 ? 'exact' : 'similar'; usedC.add(cj);
  }
  return res;
}
async function loadTemplate(file) {
  const { wb, csv } = await readWorkbook(file);
  let names = null;
  for (const sn of wb.SheetNames) {
    const { grid, merges } = sheetToGrid(wb.Sheets[sn]);
    if (!grid.length) continue;
    const d = detectHeader(grid, merges);
    // 머리글만 있는 파일이면 감지가 첫 줄을 고르므로, 머리글 줄 수는 남은 줄 기준으로 다시 판단
    const tmp = { grid, merges, read: { headerStart: d.headerStart, headerRows: d.headerRows, fillMerges: false, dropSubtotals: false }, toggled: new Set() };
    names = buildBase(tmp).cols.filter((n) => !/^열\d+$/.test(n));
    if (names.length) break;
  }
  if (!names || !names.length) throw new Error('템플릿에서 머리글을 찾지 못함');
  const sh = cur();
  // 템플릿 단계는 항상 맨 끝. 기존 템플릿 단계가 있으면 교체
  sh.steps = sh.steps.filter((s) => s.type !== 'template');
  runPipeline();
  const st = { type: 'template', on: true, open: true, file: file.name, targets: autoMatch(names, S.out.cols) };
  sh.steps.push(st);
  const hit = st.targets.filter((x) => x.src).length;
  toast(hit === names.length ? `템플릿 열 ${names.length}개 모두 자동 연결. 추정 표시는 한 번 확인 필요` : `템플릿 열 ${names.length}개 중 ${hit}개 자동 연결. 나머지는 직접 고르면 됨`);
  refresh(true);
}

// ───────────────────────── 화면: 공통 ─────────────────────────
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
let toastTimer;
function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 5000 : 3200);
}
function select(options, value, onchange, extra = {}) {
  const s = h('select', { ...extra, onchange: (e) => onchange(e.target.value) });
  for (const o of options) {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    s.append(h('option', { value: v }, l));
  }
  if (value != null && !options.some((o) => (Array.isArray(o) ? o[0] : o) === value) && value !== '') s.append(h('option', { value }, `${value} (없음)`));
  s.value = value ?? '';
  return s;
}
function colSelect(cols, value, onchange, blank) {
  return select(blank ? [['', blank], ...cols] : cols, value, onchange);
}
function multiCols(cols, list, onchange, placeholder = '＋ 열 추가') {
  const wrap = h('div', { class: 'multi' });
  list.forEach((c, k) => wrap.append(h('span', { class: 'tag' + (cols.includes(c) ? '' : ' missing') }, c,
    h('button', { title: '빼기', onclick: () => { list.splice(k, 1); onchange(); } }, '×'))));
  const rest = cols.filter((c) => !list.includes(c));
  if (rest.length) wrap.append(select([['', placeholder], ...rest], '', (v) => { if (v) { list.push(v); onchange(); } }));
  return wrap;
}

// ───────────────────────── 화면: 단계 ─────────────────────────
let recomputeTimer;
function changed(full) {
  // full: 단계 목록 다시 그림 (선택 변경 등), 아니면 계산·미리보기만 (입력 중 포커스 유지)
  clearTimeout(recomputeTimer);
  if (full) { refresh(true); return; }
  recomputeTimer = setTimeout(() => refresh(false), 160);
}
function refresh(full) {
  runPipeline();
  if (full) renderSteps(); else updateStepMeta();
  renderReadInfo();
  renderView();
}
function textInput(st, key, ph, extra = {}) {
  return h('input', { type: 'text', value: st[key] ?? '', placeholder: ph, spellcheck: 'false', ...extra,
    oninput: (e) => { st[key] = e.target.value; changed(false); }, onchange: () => changed(true) });
}

function stepBody(st, cols, idx) {
  const C = (fn) => () => { fn(); changed(true); };
  switch (st.type) {
    case 'columns': {
      reconcileColumns(st, cols);
      const list = h('div', { class: 'col-list' });
      st.items.forEach((it, k) => {
        const missing = !cols.includes(it.src);
        list.append(h('div', { class: 'col-item' + (missing ? ' missing' : '') + (it.keep ? '' : ' dim') },
          h('input', { type: 'checkbox', checked: it.keep, title: '결과에 넣기', onchange: (e) => { it.keep = e.target.checked; changed(true); } }),
          h('span', { class: 'src', title: it.src }, it.src),
          h('input', { type: 'text', value: it.name, placeholder: it.src, spellcheck: 'false', oninput: (e) => { it.name = e.target.value; changed(false); }, onchange: () => changed(true) }),
          h('button', { class: 'icon-btn', title: '위로', disabled: k === 0, onclick: C(() => { st.items.splice(k - 1, 0, st.items.splice(k, 1)[0]); }) }, '↑'),
          h('button', { class: 'icon-btn', title: '아래로', disabled: k === st.items.length - 1, onclick: C(() => { st.items.splice(k + 1, 0, st.items.splice(k, 1)[0]); }) }, '↓'),
          missing ? h('button', { class: 'icon-btn', title: '목록에서 지우기', onclick: C(() => st.items.splice(k, 1)) }, '×') : null));
      });
      return [
        h('div', { class: 'mini-actions' },
          h('button', { class: 'link', onclick: C(() => st.items.forEach((x) => { x.keep = true; })) }, '모두 선택'),
          h('button', { class: 'link', onclick: C(() => st.items.forEach((x) => { x.keep = false; })) }, '모두 해제'),
          h('button', { class: 'link', onclick: C(() => st.items.forEach((x) => { x.name = x.src; })) }, '이름 원래대로')),
        list,
      ];
    }
    case 'filter': {
      const out = [];
      st.conds.forEach((c, k) => {
        out.push(h('div', { class: 'row' },
          colSelect(cols, c.col, (v) => { c.col = v; changed(true); }),
          select(FILTER_OPS, c.op, (v) => { c.op = v; changed(true); }),
          ['empty', 'nempty'].includes(c.op) ? h('span') : textInput(c, 'val', '값'),
          h('button', { class: 'icon-btn', title: '조건 빼기', onclick: C(() => st.conds.splice(k, 1)) }, '×')));
      });
      out.push(h('div', { class: 'row' },
        h('button', { class: 'btn ghost sm sub-add fixed', onclick: C(() => st.conds.push({ col: cols[0] || '', op: 'eq', val: '' })) }, '＋ 조건'),
        st.conds.length > 1 ? select([['and', '모두 만족'], ['or', '하나라도 만족']], st.mode, (v) => { st.mode = v; changed(true); }) : h('span')));
      out.push(h('div', { class: 'hint' }, '날짜는 2026-01-05 형식, 숫자는 쉼표 없이 입력'));
      return out;
    }
    case 'sort': {
      const out = [];
      st.keys.forEach((k2, k) => out.push(h('div', { class: 'row' },
        colSelect(cols, k2.col, (v) => { k2.col = v; changed(true); }),
        select([['asc', '오름차순 (가→하, 1→9)'], ['desc', '내림차순 (하→가, 9→1)']], k2.dir, (v) => { k2.dir = v; changed(true); }),
        h('button', { class: 'icon-btn', title: '빼기', onclick: C(() => st.keys.splice(k, 1)) }, '×'))));
      out.push(h('button', { class: 'btn ghost sm sub-add', onclick: C(() => st.keys.push({ col: '', dir: 'asc' })) }, '＋ 다음 기준'));
      return out;
    }
    case 'dedupe':
      return [
        h('div', { class: 'lbl' }, '기준 열 (비우면 모든 열이 같을 때만 중복)'),
        multiCols(cols, st.cols, () => changed(true)),
        select([['first', '처음 나온 행 남김'], ['last', '마지막 행 남김']], st.keep, (v) => { st.keep = v; changed(true); }),
      ];
    case 'values': {
      const out = [h('div', { class: 'lbl' }, '대상 열'), multiCols(cols, st.cols, () => changed(true)),
        h('div', { class: 'row' }, select(VAL_ACTIONS, st.action, (v) => { st.action = v; changed(true); }),
          h('button', { class: 'link fixed', onclick: C(() => { st.cols = cols.slice(); }) }, '모든 열'))];
      if (st.action === 'date') out.push(select(DATE_FMTS.map(([v, l]) => [v, v === 'date' ? l : `글자: ${l}`]), st.fmt, (v) => { st.fmt = v; changed(true); }));
      if (st.action === 'replace') {
        out.push(h('div', { class: 'row' }, textInput(st, 'find', '찾을 값'), h('span', { class: 'fixed muted' }, '→'), textInput(st, 'to', '바꿀 값 (비우면 빈 칸)')));
        out.push(h('label', { class: 'tgl' }, h('input', { type: 'checkbox', checked: st.whole, onchange: (e) => { st.whole = e.target.checked; changed(true); } }), h('span', null, '칸 전체가 같을 때만 (끄면 일부 글자도 바꿈)')));
      }
      if (st.action === 'fill') {
        out.push(select([['above', '바로 위 값으로'], ['value', '정한 값으로']], st.fill, (v) => { st.fill = v; changed(true); }));
        if (st.fill === 'value') out.push(textInput(st, 'fillVal', '채울 값'));
      }
      if (st.action === 'number') out.push(h('div', { class: 'hint' }, '쉼표·원·₩·공백 제거, (1,000)은 -1000, 15%는 0.15'));
      return out;
    }
    case 'merge':
      return [
        h('div', { class: 'lbl' }, '합칠 열 (순서대로)'), multiCols(cols, st.cols, () => changed(true)),
        h('div', { class: 'row' }, textInput(st, 'sep', '구분자'), textInput(st, 'name', '새 열 이름')),
        h('label', { class: 'tgl' }, h('input', { type: 'checkbox', checked: st.drop, onchange: (e) => { st.drop = e.target.checked; changed(true); } }), h('span', null, '원래 열은 지우기')),
      ];
    case 'split':
      return [
        h('div', { class: 'row' }, colSelect(cols, st.col, (v) => { st.col = v; changed(true); }), textInput(st, 'sep', '구분자 (예: / , -)')),
        textInput(st, 'names', '새 열 이름, 쉼표로 (비우면 자동)'),
        h('label', { class: 'tgl' }, h('input', { type: 'checkbox', checked: st.drop, onchange: (e) => { st.drop = e.target.checked; changed(true); } }), h('span', null, '원래 열은 지우기')),
      ];
    case 'calc': {
      const exprIn = textInput(st, 'expr', '[단가] * [수량]');
      return [
        textInput(st, 'name', '새 열 이름'),
        exprIn,
        h('div', { class: 'row' }, select([['', '＋ 열 이름 넣기'], ...cols], '', (v) => {
          if (!v) return; st.expr = (st.expr ? st.expr.replace(/\s*$/, ' ') : '') + `[${v}]`; changed(true);
        })),
        h('div', { class: 'hint' }, '+ − * / 괄호, ROUND(값, 자릿수), ABS(값). 빈 칸은 0으로 계산'),
      ];
    }
    case 'group': {
      const out = [h('div', { class: 'lbl' }, '묶을 기준 열 (비우면 전체 하나로)'), multiCols(cols, st.by, () => changed(true)), h('div', { class: 'lbl' }, '계산할 값')];
      st.aggs.forEach((a, k) => out.push(h('div', { class: 'row' },
        a.fn === 'rows' ? h('span', { class: 'muted', title: '행 수는 열을 고를 필요 없음' }, '—') : colSelect(cols, a.col, (v) => { a.col = v; changed(true); }),
        select(AGG_FNS, a.fn, (v) => { a.fn = v; changed(true); }),
        h('input', { type: 'text', value: a.name, placeholder: '결과 열 이름', oninput: (e) => { a.name = e.target.value; changed(false); }, onchange: () => changed(true) }),
        h('button', { class: 'icon-btn', title: '빼기', onclick: C(() => st.aggs.splice(k, 1)) }, '×'))));
      out.push(h('button', { class: 'btn ghost sm sub-add', onclick: C(() => st.aggs.push({ col: cols[0] || '', fn: 'sum', name: '' })) }, '＋ 값 추가'));
      return out;
    }
    case 'template': {
      const out = [h('div', { class: 'hint' }, '왼쪽은 템플릿 머리글, 오른쪽은 연결할 열. 결과는 템플릿 순서대로 나감')];
      st.targets.forEach((x) => out.push(h('div', { class: 'map-item' },
        h('span', { class: 'tgt', title: x.name }, x.name), h('span', { class: 'arr' }, '←'),
        colSelect(cols, x.src || '', (v) => { x.src = v || null; x.auto = v ? 'manual' : 'none'; changed(true); }, '(빈 열)'),
        h('span', { class: 'badge ' + (x.src && !cols.includes(x.src) ? 'none' : x.auto) }, { exact: '일치', similar: '추정', none: '없음', manual: '직접' }[x.auto] || ''))));
      return out;
    }
  }
  return [];
}

function renderSteps() {
  const sh = cur(); const box = $('steps'); box.textContent = '';
  if (!sh) return;
  sh.steps.forEach((st, i) => {
    const def = STEP_DEFS[st.type]; const info = S.stepInfo[i] || {};
    const cols = info.inCols || [];
    const head = h('div', { class: 'step-h', onclick: (e) => { if (e.target.closest('button,input')) return; st.open = !st.open; renderSteps(); } },
      h('span', { class: 'step-no' }, i + 1),
      h('span', { class: 'step-ic' }, def.icon),
      h('span', { class: 'step-t' }, def.label),
      h('span', { class: 'step-sum', 'data-sum': i }, def.summary(st)),
      h('button', { class: 'icon-btn', title: '위로', disabled: i === 0, onclick: () => { sh.steps.splice(i - 1, 0, sh.steps.splice(i, 1)[0]); changed(true); } }, '↑'),
      h('button', { class: 'icon-btn', title: '아래로', disabled: i === sh.steps.length - 1, onclick: () => { sh.steps.splice(i + 1, 0, sh.steps.splice(i, 1)[0]); changed(true); } }, '↓'),
      h('input', { type: 'checkbox', checked: st.on !== false, title: '켜기/끄기', style: 'accent-color:var(--accent)', onchange: (e) => { st.on = e.target.checked; changed(true); } }),
      h('button', { class: 'icon-btn', title: '단계 지우기', onclick: () => { sh.steps.splice(i, 1); changed(true); } }, '×'));
    const card = h('div', { class: 'step' + (st.on === false ? ' off' : '') + (info.error ? ' err' : ''), 'data-i': i }, head);
    if (st.open) {
      const body = h('div', { class: 'step-b' }, ...stepBody(st, cols, i));
      body.append(h('div', { class: 'step-meta', 'data-meta': i }));
      body.append(h('div', { class: 'step-msg', 'data-err': i, hidden: true }));
      body.append(h('div', { class: 'step-warn', 'data-warn': i, hidden: true }));
      card.append(body);
    }
    box.append(card);
  });
  updateStepMeta();
}
function updateStepMeta() {
  const sh = cur(); if (!sh) return;
  sh.steps.forEach((st, i) => {
    const info = S.stepInfo[i] || {};
    const card = document.querySelector(`.step[data-i="${i}"]`);
    if (card) card.classList.toggle('err', !!info.error);
    const sum = document.querySelector(`[data-sum="${i}"]`); if (sum) sum.textContent = STEP_DEFS[st.type].summary(st);
    const meta = document.querySelector(`[data-meta="${i}"]`);
    if (meta) meta.textContent = st.on === false ? '꺼져 있음' : `이 단계 뒤: ${(info.rows ?? 0).toLocaleString()}행 · ${info.cols ?? 0}열`;
    const err = document.querySelector(`[data-err="${i}"]`);
    if (err) { err.hidden = !info.error; err.textContent = info.error ? `건너뜀: ${info.error}` : ''; }
    const warn = document.querySelector(`[data-warn="${i}"]`);
    if (warn) { warn.hidden = !info.warn; warn.textContent = info.warn || ''; }
  });
}
function addStep(type) {
  const sh = cur();
  runPipeline();
  // 템플릿 단계가 있으면 그 앞에 넣음
  const ti = sh.steps.findIndex((s) => s.type === 'template');
  const at = ti >= 0 ? ti : sh.steps.length;
  const inCols = at < S.stepInfo.length ? S.stepInfo[at].inCols : S.out.cols;
  const st = { type, on: true, open: true, ...STEP_DEFS[type].init(inCols) };
  sh.steps.forEach((s) => { s.open = false; });
  sh.steps.splice(at, 0, st);
  $('addMenu').hidden = true;
  refresh(true);
}
function renderAddMenu() {
  const m = $('addMenu'); m.textContent = '';
  for (const [type, d] of Object.entries(STEP_DEFS)) {
    if (d.hidden) continue;
    m.append(h('button', { class: 'add-opt', onclick: () => addStep(type) }, h('b', null, `${d.icon}  ${d.label}`), h('span', null, d.desc)));
  }
}

// ───────────────────────── 화면: 파일·읽기 설정 ─────────────────────────
function renderFile() {
  const fi = $('fileInfo'); fi.textContent = '';
  fi.classList.toggle('muted', !S.wb);
  if (!S.wb) { fi.textContent = '파일을 올리면 여기에 표시'; return; }
  fi.append(h('span', { class: 'fname' }, S.fileName), h('button', { class: 'link re', onclick: () => $('fileIn').click() }, '다른 파일'));
  const sl = $('sheetList'); sl.textContent = '';
  if (S.wb.SheetNames.length > 1 || !S.isCsv) {
    for (const sn of S.wb.SheetNames) {
      const n = S.sheets[sn].grid.length;
      sl.append(h('button', { class: 'chip' + (sn === S.sheet ? ' on' : ''), onclick: () => selectSheet(sn) }, sn, h('span', { class: 'cnt' }, n ? `${n.toLocaleString()}줄` : '빈 시트')));
    }
  }
}
function renderRead() {
  const sh = cur(); if (!sh) return;
  $('hdrStart').value = sh.read.headerStart + 1;
  $('hdrRows').value = String(sh.read.headerRows);
  $('fillMerges').checked = sh.read.fillMerges;
  $('dropSub').checked = sh.read.dropSubtotals;
  $('fillMerges').closest('.tgl').hidden = !sh.merges.length;
}
function renderReadInfo() {
  const sh = cur(); if (!sh || !S.base) return;
  const b = S.base;
  const parts = [`머리글 ${b.hn}줄 → 열 ${b.cols.length}개, 데이터 ${b.rows.length.toLocaleString()}행`];
  if (sh.merges.length) parts.push(`병합 ${sh.merges.length}곳`);
  const info = $('readInfo'); info.textContent = parts.join(' · ');
  if (b.flagged) {
    info.append(h('br'), h('b', null, `소계·합계 의심 ${b.flagged}줄`), ` (원본 탭에서 확인, 줄마다 넣기/빼기 가능)`);
  }
}
function selectSheet(sn) {
  S.sheet = sn;
  renderFile(); renderRead();
  refresh(true);
  updateOutName();
}

// ───────────────────────── 화면: 표 ─────────────────────────
function cellHtml(v) {
  if (v == null) return '<td class="e"></td>';
  if (typeof v === 'number') return `<td class="n">${esc(Number.isInteger(v) ? v.toLocaleString('ko-KR') : v.toLocaleString('ko-KR', { maximumFractionDigits: 10 }))}</td>`;
  const s = str(v);
  return `<td title="${s.length > 40 ? esc(s) : ''}">${esc(s)}</td>`;
}
function colType(rows, i) {
  let n = 0, d = 0, s = 0;
  for (let r = 0; r < rows.length && r < 2000; r++) {
    const v = rows[r][i];
    if (isEmpty(v)) continue;
    if (typeof v === 'number') n++; else if (v instanceof Date) d++; else s++;
  }
  if (!n && !d && !s) return '빈 열';
  if (n && !d && !s) return '숫자';
  if (d && !n && !s) return '날짜';
  if (s && !n && !d) return '글자';
  return '섞임';
}
function renderView() {
  const view = $('view');
  if (!S.wb) return;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
  const legend = $('legend');
  if (S.view === 'raw') {
    legend.hidden = false;
    legend.innerHTML = '<span><i class="l-title"></i>머리글 위 (안 읽음)</span><span><i class="l-hdr"></i>머리글</span><span><i class="l-sub"></i>소계·합계 의심</span><span class="tip">줄 번호를 누르면 그 줄부터 머리글로 지정</span>';
    renderRaw(view);
  } else {
    legend.hidden = true;
    renderResult(view);
  }
}
function renderResult(view) {
  const t = S.out;
  $('shape').innerHTML = `결과 <b>${t.rows.length.toLocaleString()}</b>행 · <b>${t.cols.length}</b>열`;
  if (!t.cols.length) { view.innerHTML = '<div class="empty-res">남은 열이 없음. 가공 단계를 확인해 줘.</div>'; return; }
  const n = Math.min(t.rows.length, PREVIEW_ROWS);
  let html = '<table class="grid"><thead><tr><th class="rn"></th>';
  t.cols.forEach((c, i) => { html += `<th>${esc(c)}<span class="ty">${colType(t.rows, i)}</span></th>`; });
  html += '</tr></thead><tbody>';
  for (let r = 0; r < n; r++) {
    html += `<tr><td class="rn">${r + 1}</td>`;
    for (const v of t.rows[r]) html += cellHtml(v);
    html += '</tr>';
  }
  html += '</tbody></table>';
  if (!t.rows.length) html += '<div class="empty-res">조건에 맞는 행이 없음</div>';
  if (t.rows.length > n) html += `<div class="more">미리보기는 ${n.toLocaleString()}행까지. 내려받으면 ${t.rows.length.toLocaleString()}행 전부 들어감</div>`;
  view.innerHTML = html;
}
function renderRaw(view) {
  const sh = cur(); const b = S.base;
  $('shape').innerHTML = `원본 <b>${sh.grid.length.toLocaleString()}</b>줄`;
  const g = sh.read.fillMerges ? fillAllMerges(sh.grid, sh.merges) : sh.grid;
  const ncol = g.reduce((a, r) => Math.max(a, r.length), 0);
  const n = Math.min(g.length, PREVIEW_ROWS);
  let html = '<table class="grid"><thead><tr><th class="rn"></th>';
  for (let c = 0; c < ncol; c++) html += `<th>${XLSX.utils.encode_col(c)}</th>`;
  html += '</tr></thead><tbody>';
  for (let r = 0; r < n; r++) {
    let cls = '', flag = '';
    if (r < b.hs) cls = 'r-title';
    else if (r < b.hs + b.hn) cls = 'r-hdr';
    else {
      const info = b.rowInfo.get(r);
      if (info && info.reason) {
        cls = 'r-sub' + (info.dropped ? ' dropped' : '');
        flag = `<button class="rflag" data-row="${r}" title="${esc(info.reason)}">${info.dropped ? '빠짐' : '넣음'}</button>`;
      } else if (info && info.dropped) {
        cls = 'r-drop';
        flag = `<button class="rflag" data-row="${r}">빠짐</button>`;
      }
    }
    html += `<tr class="${cls}"><td class="rn click" data-hdr="${r}" title="이 줄부터 머리글">${r + 1}${flag}</td>`;
    const src = r < b.hs ? sh.grid : g; // 머리글 위 제목 줄은 병합 채우기 없이 원래대로
    for (let c = 0; c < ncol; c++) html += cellHtml(src[r][c] === undefined ? null : src[r][c]);
    html += '</tr>';
  }
  html += '</tbody></table>';
  if (g.length > n) html += `<div class="more">원본 미리보기는 ${n.toLocaleString()}줄까지</div>`;
  view.innerHTML = html;
}

// ───────────────────────── 내려받기 ─────────────────────────
function updateOutName() {
  if (!S.wb) return;
  const base = S.fileName.replace(/\.[^.]+$/, '');
  const sheetPart = S.wb.SheetNames.length > 1 ? `_${S.sheet}` : '';
  $('outName').value = `${base}${sheetPart}_가공`;
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function safeName(s) { return s.replace(/[\\/:*?"<>|]/g, '_').trim() || '결과'; }
function exportXlsx(t, name) {
  const ws = {};
  const all = [t.cols, ...t.rows];
  const widths = t.cols.map((c) => Math.min(40, Math.max(6, str(c).length * 2)));
  all.forEach((row, r) => row.forEach((v, c) => {
    if (v == null) return;
    const ref = XLSX.utils.encode_cell({ r, c });
    if (typeof v === 'number') ws[ref] = { t: 'n', v };
    else if (typeof v === 'boolean') ws[ref] = { t: 'b', v };
    else if (v instanceof Date) ws[ref] = { t: 'n', v: serial(v), z: hasTime(v) ? 'yyyy-mm-dd hh:mm' : 'yyyy-mm-dd' };
    else ws[ref] = { t: 's', v: String(v) };
    if (r < 300) widths[c] = Math.min(50, Math.max(widths[c], [...str(v)].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 2 : 1), 0) + 2));
  }));
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, all.length - 1), c: Math.max(0, t.cols.length - 1) } });
  ws['!cols'] = widths.map((w) => ({ wch: w }));
  ws['!autofilter'] = { ref: ws['!ref'] };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, safeName(S.sheet || '결과').replace(/[\[\]]/g, '_').slice(0, 31));
  const data = XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
  download(new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${name}.xlsx`);
}
function exportCsv(t, name) {
  const q = (v) => { const s = str(v); return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [t.cols.map(q).join(','), ...t.rows.map((r) => r.map(q).join(','))];
  // 엑셀에서 한글 안 깨지게 BOM 붙임
  download(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `${name}.csv`);
}
function doDownload() {
  if (!S.out) return;
  runPipeline();
  const name = safeName($('outName').value);
  if ($('outFmt').value === 'csv') exportCsv(S.out, name); else exportXlsx(S.out, name);
  toast(`${S.out.rows.length.toLocaleString()}행 내려받기 완료`);
}

// ───────────────────────── 규칙 저장·불러오기 ─────────────────────────
function saveRule() {
  const sh = cur(); if (!sh) return;
  const rule = {
    app: RULE_APP, version: RULE_VERSION, sheet: S.sheet, savedAt: new Date().toISOString(),
    read: { ...sh.read },
    steps: sh.steps.map(({ open, ...rest }) => rest),
    output: { format: $('outFmt').value },
  };
  const base = safeName(`규칙_${S.fileName.replace(/\.[^.]+$/, '')}_${S.sheet}`);
  download(new Blob([JSON.stringify(rule, null, 2)], { type: 'application/json' }), `${base}.json`);
  toast('규칙 저장 완료. 다음에 불러오기로 같은 가공을 바로 적용');
}
async function loadRule(file) {
  let rule;
  try { rule = JSON.parse(await file.text()); } catch (e) { toast('규칙 파일을 읽지 못함 (JSON 형식 아님)', true); return; }
  if (!rule || rule.app !== RULE_APP || !Array.isArray(rule.steps)) { toast('이 도구에서 저장한 규칙 파일이 아님', true); return; }
  const bad = rule.steps.find((s) => !STEP_DEFS[s.type]);
  if (bad) { toast(`모르는 단계 종류: ${bad.type}`, true); return; }
  let target = S.sheet;
  if (rule.sheet && S.sheets[rule.sheet]) target = rule.sheet;
  const sh = S.sheets[target];
  if (rule.read) Object.assign(sh.read, rule.read);
  sh.steps = rule.steps.map((s) => ({ ...s, open: false }));
  sh.toggled = new Set();
  if (rule.output && rule.output.format) $('outFmt').value = rule.output.format;
  S.sheet = target;
  renderFile(); renderRead(); refresh(true); updateOutName();
  const errs = S.stepInfo.filter((x) => x.error).length;
  const note = rule.sheet && rule.sheet !== target ? ` ('${rule.sheet}' 시트가 없어 지금 시트에 적용)` : '';
  toast(errs ? `규칙 적용. 맞지 않는 단계 ${errs}개는 건너뜀${note}` : `규칙 적용 완료${note}`, !!errs);
}

// ───────────────────────── 파일 열기 ─────────────────────────
async function openFile(file) {
  if (!file) return;
  try {
    const { wb, csv } = await readWorkbook(file);
    S.fileName = file.name; S.wb = wb; S.isCsv = csv; S.sheets = {};
    let first = null;
    for (const sn of wb.SheetNames) {
      const { grid, merges } = sheetToGrid(wb.Sheets[sn]);
      const d = detectHeader(grid, merges);
      S.sheets[sn] = { grid, merges, toggled: new Set(), steps: [], read: { headerStart: d.headerStart, headerRows: d.headerRows, fillMerges: true, dropSubtotals: true } };
      if (!first && grid.length) first = sn;
    }
    S.sheet = first || wb.SheetNames[0];
    S.view = 'result';
    $('drop').hidden = true; $('view').hidden = false;
    $('toolbar').hidden = false;
    $('panelRead').hidden = false;
    $('panelSteps').hidden = false;
    renderFile(); renderRead(); refresh(true); updateOutName();
    toast(`${file.name} 읽음 · 시트 ${wb.SheetNames.length}개`);
  } catch (e) {
    console.error(e);
    toast(`파일을 읽지 못함: ${e.message || e}`, true);
  }
}

// ───────────────────────── 이벤트 연결 ─────────────────────────
function bind() {
  $('btnPick').onclick = () => $('fileIn').click();
  $('fileIn').onchange = (e) => { openFile(e.target.files[0]); e.target.value = ''; };
  $('tplIn').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { await loadTemplate(f); } catch (err) { toast(err.message, true); } };
  $('ruleIn').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadRule(f); };
  $('btnTemplate').onclick = () => $('tplIn').click();
  $('btnSaveRule').onclick = saveRule;
  $('btnLoadRule').onclick = () => $('ruleIn').click();
  $('btnAdd').onclick = () => { const m = $('addMenu'); m.hidden = !m.hidden; };
  $('btnDown').onclick = doDownload;
  document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => { S.view = b.dataset.view; renderView(); }; });

  $('hdrStart').onchange = (e) => {
    const sh = cur(); let v = parseInt(e.target.value, 10);
    if (!Number.isFinite(v) || v < 1) v = 1; if (v > sh.grid.length) v = sh.grid.length;
    sh.read.headerStart = v - 1; sh.toggled = new Set(); renderRead(); refresh(true);
  };
  $('hdrRows').onchange = (e) => { cur().read.headerRows = +e.target.value; cur().toggled = new Set(); refresh(true); };
  $('fillMerges').onchange = (e) => { cur().read.fillMerges = e.target.checked; refresh(true); };
  $('dropSub').onchange = (e) => { cur().read.dropSubtotals = e.target.checked; cur().toggled = new Set(); refresh(true); };

  // 원본 표: 줄 번호 클릭 → 머리글 지정, 넣음/빠짐 버튼 → 그 줄만 반대로
  $('view').addEventListener('click', (e) => {
    const flag = e.target.closest('.rflag');
    if (flag) {
      e.stopPropagation();
      const r = +flag.dataset.row, sh = cur();
      if (sh.toggled.has(r)) sh.toggled.delete(r); else sh.toggled.add(r);
      refresh(false); return;
    }
    const rn = e.target.closest('[data-hdr]');
    if (rn && S.view === 'raw') {
      const sh = cur(); sh.read.headerStart = +rn.dataset.hdr; sh.toggled = new Set();
      renderRead(); refresh(true);
      toast(`${sh.read.headerStart + 1}번째 줄부터 머리글로 지정`);
    }
  });

  // 파일 끌어오기
  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (/\.json$/i.test(f.name)) { if (S.wb) loadRule(f); else toast('규칙은 데이터 파일을 먼저 연 뒤 불러와야 함', true); return; }
    openFile(f);
  });
  renderAddMenu();
}
bind();
