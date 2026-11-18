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
  fmtView: true,  // 미리보기에 엑셀 서식 표시
  colStyles: null,
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
function fmtDate(d, f = 'auto') {
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  switch (f) {
    case 'YYYY-MM-DD': return `${y}-${pad(m)}-${pad(day)}`;
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
  return { cols, rows, rowInfo, hs, hn, src: keepCols, flagged: [...rowInfo.values()].filter((x) => x.reason).length };
}

// ───────────────────────── 가공 단계 ─────────────────────────
// 부분합이 붙인 행 종류(kind)를 새 배열에도 옮김
function keepKind(src, dst) { if (src.kind) dst.kind = src.kind; return dst; }
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

function aggregate(rows, i, fn) {
  if (fn === 'rows') return rows.length;
  const vs = rows.map((r) => r[i]).filter((v) => !isEmpty(v));
  if (fn === 'count') return vs.length;
  if (fn === 'distinct') return new Set(vs.map(str)).size;
  if (fn === 'min' || fn === 'max') {
    if (!vs.length) return null;
    let m = vs[0]; for (const v of vs) { const c = cmp(v, m); if (fn === 'min' ? c < 0 : c > 0) m = v; } return m;
  }
  const ns = vs.map((v) => toNum(v)).filter((v) => v != null);
  const sum = ns.reduce((x, y) => x + y, 0);
  if (fn === 'sum') return +sum.toPrecision(15);
  return ns.length ? +(sum / ns.length).toPrecision(15) : null;
}
const PIVOT_MAX_COLS = 200;

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
      return { cols: names, meta: idx.map((i) => t.meta[i]), rows: t.rows.map((r) => keepKind(r, idx.map((i) => r[i]))), warn: missing.length ? `원본에 없는 열: ${missing.join(', ')}` : null };
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
      const rows = t.rows.map((r) => keepKind(r, r.slice()));
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
      const rows = t.rows.map((r) => { const v = evalExpr(tree, (c) => r[ix[c]]); if (v == null) bad++; return keepKind(r, [...r, v == null ? null : +v.toPrecision(15)]); });
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
        for (const a of ags) out.push(aggregate(g.rows, a.i, a.fn));
        rows.push(out);
      }
      const keepFmt = (fn) => ['sum', 'avg', 'min', 'max'].includes(fn);
      const meta = [...bi.map((i) => t.meta[i]), ...ags.map((a) => (a.i >= 0 && keepFmt(a.fn) ? { c: t.meta[a.i].c, tpl: null, valueOnly: true } : { c: null, tpl: null }))];
      return { cols: names, rows, meta };
    },
    summary: (st) => `${st.by.length ? st.by.join(', ') + '별' : '전체'} · ${st.aggs.map((a) => a.fn === 'rows' ? '행 수' : `${a.col || '?'} ${fnLabel(a.fn)}`).join(', ')}`,
  },
  subtotal: {
    label: '부분합', icon: '≡', desc: '그룹마다 소계 줄 끼우기',
    init: (cols) => ({ by: cols[0] || '', vals: [{ col: cols.find((c, i) => i > 0) || '', fn: 'sum' }], sort: true, grand: true, label: '소계' }),
    apply(t, st) {
      if (!st.by) throw new Error('기준 열을 골라야 함');
      const bi = ci(t, st.by);
      const vs = st.vals.filter((v) => v.col || v.fn === 'rows').map((v) => ({ ...v, i: v.fn === 'rows' ? -1 : ci(t, v.col) }));
      if (!vs.length) throw new Error('계산할 값을 하나 이상 골라야 함');
      // 이미 붙은 소계 줄은 다시 계산하지 않음
      let data = t.rows.filter((r) => !r.kind);
      if (st.sort) data = data.map((r, k) => [r, k]).sort((A, B) => cmp(A[0][bi], B[0][bi]) || A[1] - B[1]).map((x) => x[0]);
      const ncol = t.cols.length;
      const makeRow = (rows, label, kind) => {
        const out = new Array(ncol).fill(null);
        out[bi] = label;
        for (const v of vs) {
          // 행 수는 기준 열 오른쪽 첫 칸에 (기준 열과 겹치지 않게)
          const at = v.i >= 0 ? v.i : (bi + 1 < ncol ? bi + 1 : bi);
          out[at] = aggregate(rows, v.i, v.fn);
        }
        out.kind = kind;
        return out;
      };
      const out = [];
      let grp = [], key = null;
      const flush = () => { if (grp.length) out.push(makeRow(grp, `${str(grp[0][bi]) || '(빈 값)'} ${st.label || '소계'}`.trim(), 'sub')); };
      for (const r of data) {
        const k = str(r[bi]);
        if (key !== null && k !== key) { flush(); grp = []; }
        key = k; grp.push(r); out.push(r);
      }
      flush();
      if (st.grand && data.length) out.push(makeRow(data, '총합계', 'grand'));
      const groups = out.filter((r) => r.kind === 'sub').length;
      return { cols: t.cols, rows: out, warn: !st.sort && groups > new Set(data.map((r) => str(r[bi]))).size ? '같은 그룹이 떨어져 있어 소계가 여러 번 나옴 (정렬 켜기 추천)' : null };
    },
    summary: (st) => `${st.by || '?'} 기준 · ${st.vals.map((v) => v.fn === 'rows' ? '행 수' : `${v.col || '?'} ${fnLabel(v.fn)}`).join(', ')}`,
  },
  pivot: {
    label: '피벗', icon: '⊞', desc: '행×열 교차표',
    init: (cols) => ({ rows: cols[0] ? [cols[0]] : [], col: cols[1] || '', val: cols[2] || '', fn: 'sum', totals: true, zero: false }),
    apply(t, st) {
      if (!st.col) throw new Error('열 기준을 골라야 함');
      const ri = st.rows.map((c) => ci(t, c));
      const cix = ci(t, st.col);
      const vi = st.fn === 'rows' ? -1 : ci(t, st.val);
      // 열 기준 값 목록 (정렬)
      const keyOf = (v) => (isEmpty(v) ? '' : str(v));
      const colVals = new Map();
      for (const r of t.rows) { const k = keyOf(r[cix]); if (!colVals.has(k)) colVals.set(k, r[cix]); }
      let keys = [...colVals.keys()].sort((a, b) => cmp(colVals.get(a), colVals.get(b)));
      let warn = null;
      if (keys.length > PIVOT_MAX_COLS) { warn = `열 기준 값이 ${keys.length}개라 앞 ${PIVOT_MAX_COLS}개만 사용`; keys = keys.slice(0, PIVOT_MAX_COLS); }
      const groups = new Map();
      for (const r of t.rows) {
        const gk = JSON.stringify(ri.map((i) => str(r[i])));
        let g = groups.get(gk); if (!g) { g = { keyVals: ri.map((i) => r[i]), all: [], by: new Map() }; groups.set(gk, g); }
        g.all.push(r);
        const ck = keyOf(r[cix]); if (!g.by.has(ck)) g.by.set(ck, []); g.by.get(ck).push(r);
      }
      const empty = st.zero && ['sum', 'count', 'rows', 'distinct'].includes(st.fn) ? 0 : null;
      const names = [...st.rows];
      keys.forEach((k) => names.push(uniqName(names, k === '' ? '(빈 값)' : k)));
      if (st.totals) names.push(uniqName(names, '합계'));
      const rows = [];
      for (const g of groups.values()) {
        const out = g.keyVals.slice();
        for (const k of keys) { const rs = g.by.get(k); out.push(rs ? aggregate(rs, vi, st.fn) : empty); }
        if (st.totals) out.push(aggregate(g.all, vi, st.fn));
        rows.push(out);
      }
      // 행 기준이 없으면 결과가 한 줄뿐이라 합계 줄은 생략
      if (st.totals && rows.length && st.rows.length) {
        const tot = st.rows.map((_, k) => (k === 0 ? '합계' : null));
        for (const k of keys) tot.push(aggregate(t.rows.filter((r) => keyOf(r[cix]) === k), vi, st.fn));
        tot.push(aggregate(t.rows, vi, st.fn));
        rows.push(tot);
      }
      const vm = vi >= 0 && ['sum', 'avg', 'min', 'max'].includes(st.fn) ? { c: t.meta[vi].c, tpl: null, valueOnly: true } : { c: null, tpl: null };
      const meta = [...ri.map((i) => t.meta[i]), ...keys.map(() => vm), ...(st.totals ? [vm] : [])];
      return { cols: names, rows, warn, meta };
    },
    summary: (st) => `행 ${st.rows.join(', ') || '없음'} · 열 ${st.col || '?'} · ${st.fn === 'rows' ? '행 수' : `${st.val || '?'} ${fnLabel(st.fn)}`}`,
  },
  template: {
    label: '템플릿 맞추기', icon: '▤', desc: '템플릿 머리글 순서대로', hidden: true,
    init: () => ({ file: '', targets: [] }),
    apply(t, st) {
      const ix = st.targets.map((x) => (x.src && t.cols.includes(x.src) ? t.cols.indexOf(x.src) : -1));
      const meta = st.targets.map((x, k) => ({ c: ix[k] >= 0 ? t.meta[ix[k]].c : null, tpl: (st.styles && st.styles[k]) || null }));
      const lost = st.targets.filter((x) => x.src && !t.cols.includes(x.src)).map((x) => x.src);
      const empty = st.targets.filter((x, k) => ix[k] < 0).length;
      const names = []; st.targets.forEach((x) => names.push(uniqName(names, x.name)));
      const warn = [lost.length ? `없는 열: ${lost.join(', ')}` : '', empty ? `빈 열로 나가는 항목 ${empty}개` : ''].filter(Boolean).join(' · ');
      return { cols: names, meta, rows: t.rows.map((r) => keepKind(r, ix.map((i) => (i < 0 ? null : r[i])))), warn: warn || null };
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

// 열 메타: { c: 원본 열 번호 또는 null, tpl: 템플릿 서식 또는 null }
// 단계가 meta를 안 돌려주면 같은 이름 열의 메타를 이어받음
function carryMeta(t, r) {
  if (r.meta) return r.meta;
  if (r.cols === t.cols) return t.meta;
  return r.cols.map((n) => { const i = t.cols.indexOf(n); return i >= 0 ? t.meta[i] : { c: null, tpl: null }; });
}
function runPipeline() {
  const sh = cur();
  if (!sh) return;
  S.base = buildBase(sh);
  let t = { cols: S.base.cols, rows: S.base.rows, meta: S.base.src.map((c) => ({ c, tpl: null })) };
  S.stepInfo = [];
  for (const st of sh.steps) {
    const info = { inCols: t.cols.slice(), error: null, warn: null };
    if (st.on !== false) {
      try {
        const r = STEP_DEFS[st.type].apply(t, st);
        info.warn = r.warn || null;
        t = { cols: r.cols, rows: r.rows, meta: carryMeta(t, r) };
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
// ───────────────────────── 셀 서식 ─────────────────────────
// 값은 SheetJS로, 서식(글꼴·채우기·테두리·맞춤·숫자 형식·열 너비)은 ExcelJS로 읽음. .xls는 숫자 형식만
async function loadStyles(file) {
  if (!/\.(xlsx|xlsm)$/i.test(file.name) || typeof ExcelJS === 'undefined') return null;
  try {
    const x = new ExcelJS.Workbook();
    await x.xlsx.load(await file.arrayBuffer());
    return x;
  } catch (e) { console.warn('서식 읽기 실패', e); return null; }
}
function cleanStyle(st) {
  if (!st) return null;
  const out = {};
  for (const k of ['font', 'fill', 'border', 'alignment', 'numFmt']) {
    const v = st[k];
    if (v == null) continue;
    if (typeof v === 'object' && !Object.keys(v).length) continue;
    if (k === 'fill' && v.type === 'pattern' && (!v.pattern || v.pattern === 'none')) continue;
    if (k === 'numFmt' && v === 'General') continue;
    out[k] = JSON.parse(JSON.stringify(v));
  }
  return Object.keys(out).length ? out : null;
}
function cellStyle(xws, sws, r, c) {
  if (r < 0 || c == null) return null;
  if (xws) {
    const cell = xws.findCell(r + 1, c + 1);
    if (cell) return cleanStyle(cell.style);
    const row = xws.findRow(r + 1);
    if (row && row.style) return cleanStyle(row.style);
    return null;
  }
  const sc = sws && sws[XLSX.utils.encode_cell({ r, c })];
  return sc && sc.z && sc.z !== 'General' ? { numFmt: sc.z } : null;
}
function colWidth(xws, c) {
  if (!xws || c == null) return null;
  const col = xws.getColumn(c + 1);
  return col && col.width ? col.width : null;
}
// 원본 열 c의 머리글·데이터 서식 (데이터는 소계로 표시된 줄을 빼고 값이 있는 첫 칸)
function sourceColStyle(c) {
  const sh = cur(), b = S.base;
  if (c == null || !sh) return { head: null, data: null, width: null };
  sh._styleCache = sh._styleCache || {};
  const key = `${b.hs}:${b.hn}:${c}`;
  if (sh._styleCache[key]) return sh._styleCache[key];
  const sws = S.wb.Sheets[S.sheet];
  const head = cellStyle(sh.xws, sws, b.hs + b.hn - 1, c);
  let data = null;
  for (const [r, info] of b.rowInfo) {
    if (info.reason) continue;
    if (isEmpty(sh.grid[r][c])) continue;
    data = cellStyle(sh.xws, sws, r, c); break;
  }
  return (sh._styleCache[key] = { head, data, width: colWidth(sh.xws, c) });
}

async function loadTemplate(file) {
  const { wb, csv } = await readWorkbook(file);
  const xwb = csv ? null : await loadStyles(file);
  let names = null, styles = null;
  for (const sn of wb.SheetNames) {
    const { grid, merges } = sheetToGrid(wb.Sheets[sn]);
    if (!grid.length) continue;
    const d = detectHeader(grid, merges);
    const tmp = { grid, merges, read: { headerStart: d.headerStart, headerRows: d.headerRows, fillMerges: false, dropSubtotals: false }, toggled: new Set() };
    const b = buildBase(tmp);
    const keep = b.cols.map((n, k) => [n, b.src[k]]).filter(([n]) => !/^열\d+$/.test(n));
    names = keep.map((x) => x[0]);
    if (!names.length) continue;
    // 템플릿 서식: 머리글 마지막 줄 칸, 그 바로 아래 칸(데이터 서식), 열 너비
    const xws = xwb && xwb.getWorksheet(sn);
    const hr = b.hs + b.hn - 1;
    styles = keep.map(([, c]) => ({
      head: cellStyle(xws, wb.Sheets[sn], hr, c),
      data: cellStyle(xws, wb.Sheets[sn], hr + 1, c),
      width: colWidth(xws, c),
    }));
    break;
  }
  if (!names || !names.length) throw new Error('템플릿에서 머리글을 찾지 못함');
  const sh = cur();
  // 템플릿 단계는 항상 맨 끝. 기존 템플릿 단계가 있으면 교체
  sh.steps = sh.steps.filter((s) => s.type !== 'template');
  runPipeline();
  const st = { type: 'template', on: true, open: true, file: file.name, targets: autoMatch(names, S.out.cols), styles };
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
  saveSession();
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
      const list = h('div', { class: 'col-list', 'data-keep-scroll': '', onscroll: (e) => { st._scroll = e.target.scrollTop; } });
      st.items.forEach((it, k) => {
        const missing = !cols.includes(it.src);
        list.append(h('div', { class: 'col-item' + (missing ? ' missing' : '') + (it.keep ? '' : ' dim') },
          h('span', { class: 'drag', title: '끌어서 순서 바꾸기', onpointerdown: (e) => startColDrag(e, list, st.items) }, '⠿'),
          h('input', { type: 'checkbox', checked: it.keep, title: '결과에 넣기', onchange: (e) => { it.keep = e.target.checked; changed(true); } }),
          h('span', { class: 'src', title: it.src }, it.src),
          h('input', { type: 'text', value: it.name, placeholder: it.src, spellcheck: 'false', oninput: (e) => { it.name = e.target.value; changed(false); }, onchange: () => changed(true) }),
          missing ? h('button', { class: 'icon-btn', title: '목록에서 지우기', onclick: C(() => st.items.splice(k, 1)) }, '×') : null));
      });
      return [
        h('div', { class: 'mini-actions' },
          h('button', { class: 'link', onclick: C(() => st.items.forEach((x) => { x.keep = true; })) }, '모두 선택'),
          h('button', { class: 'link', onclick: C(() => st.items.forEach((x) => { x.keep = false; })) }, '모두 해제'),
          h('button', { class: 'link', onclick: C(() => st.items.forEach((x) => { x.name = x.src; })) }, '이름 원래대로'),
          h('button', { class: 'link', onclick: C(() => { st.items.sort((a, b) => (b.keep - a.keep)); }) }, '선택한 열 위로')),
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
    case 'subtotal': {
      const out = [
        h('div', { class: 'lbl' }, '기준 열 (값이 바뀔 때마다 소계 줄)'),
        colSelect(cols, st.by, (v) => { st.by = v; changed(true); }, '열 선택'),
        h('div', { class: 'lbl' }, '소계 낼 값'),
      ];
      st.vals.forEach((v, k) => out.push(h('div', { class: 'row' },
        v.fn === 'rows' ? h('span', { class: 'muted' }, '—') : colSelect(cols, v.col, (x) => { v.col = x; changed(true); }, '열 선택'),
        select(AGG_FNS, v.fn, (x) => { v.fn = x; changed(true); }),
        h('button', { class: 'icon-btn', title: '빼기', onclick: C(() => st.vals.splice(k, 1)) }, '×'))));
      out.push(h('button', { class: 'btn ghost sm sub-add', onclick: C(() => st.vals.push({ col: '', fn: 'sum' })) }, '＋ 값 추가'));
      out.push(h('div', { class: 'row' }, h('span', { class: 'fixed muted' }, '줄 이름'), textInput(st, 'label', '소계')));
      out.push(h('label', { class: 'tgl' }, h('input', { type: 'checkbox', checked: st.sort, onchange: (e) => { st.sort = e.target.checked; changed(true); } }), h('span', null, '기준 열로 먼저 정렬')));
      out.push(h('label', { class: 'tgl' }, h('input', { type: 'checkbox', checked: st.grand, onchange: (e) => { st.grand = e.target.checked; changed(true); } }), h('span', null, '맨 아래 총합계')));
      return out;
    }
    case 'pivot': {
      const fnOpts = AGG_FNS;
      const out = [
        pivotGuide(st, idx),
        h('div', { class: 'lbl' }, '① 행 기준: 표 왼쪽에 세로로 나열할 열'), multiCols(cols, st.rows, () => changed(true)),
        h('div', { class: 'lbl' }, '② 열 기준: 값마다 새 열이 생기는 열'), colSelect(cols, st.col, (v) => { st.col = v; changed(true); }, '열 선택'),
        h('div', { class: 'lbl' }, '③ 값: 칸에 들어갈 계산'),
        h('div', { class: 'row' },
          st.fn === 'rows' ? h('span', { class: 'muted', title: '행 수는 열을 고를 필요 없음' }, '—') : colSelect(cols, st.val, (v) => { st.val = v; changed(true); }, '열 선택'),
          select(fnOpts, st.fn, (v) => { st.fn = v; changed(true); })),
        h('label', { class: 'tgl' }, h('input', { type: 'checkbox', checked: st.totals, onchange: (e) => { st.totals = e.target.checked; changed(true); } }), h('span', null, '합계 행·열 넣기')),
        h('label', { class: 'tgl' }, h('input', { type: 'checkbox', checked: st.zero, onchange: (e) => { st.zero = e.target.checked; changed(true); } }), h('span', null, '해당 없는 칸은 0으로 (끄면 빈 칸)')),
      ];
      return out;
    }
    case 'template': {
      const out = [];
      st.targets.forEach((x) => out.push(h('div', { class: 'map-item' },
        h('span', { class: 'tgt', title: x.name }, x.name), h('span', { class: 'arr' }, '←'),
        colSelect(cols, x.src || '', (v) => { x.src = v || null; x.auto = v ? 'manual' : 'none'; changed(true); }, '(빈 열)'),
        h('span', { class: 'badge ' + (x.src && !cols.includes(x.src) ? 'none' : x.auto) }, { exact: '일치', similar: '추정', none: '없음', manual: '직접' }[x.auto] || ''))));
      return out;
    }
  }
  return [];
}

// 피벗 설정을 실제 열 이름·값으로 보여주는 작은 예시 표
function pivotGuide(st, idx) {
  const info = S.stepInfo[idx] || {};
  const inT = pipelineInput(idx);
  const rowName = st.rows.length ? st.rows.join(' · ') : '(행 기준 없음)';
  const valName = st.fn === 'rows' ? '행 수' : `${st.val || '값'} ${fnLabel(st.fn)}`;
  let colSamples = ['값1', '값2'], rowSamples = ['항목1', '항목2'];
  if (inT) {
    const ci2 = inT.cols.indexOf(st.col);
    if (ci2 >= 0) { const u = [...new Set(inT.rows.map((r) => str(r[ci2])).filter(Boolean))].sort(collator.compare); if (u.length) colSamples = u.slice(0, 2).concat(u.length > 2 ? ['…'] : []); }
    const ri2 = st.rows.length ? inT.cols.indexOf(st.rows[0]) : -1;
    if (ri2 >= 0) { const u = [...new Set(inT.rows.map((r) => str(r[ri2])).filter(Boolean))]; if (u.length) rowSamples = u.slice(0, 2).concat(u.length > 2 ? ['…'] : []); }
  }
  const tbl = h('table', { class: 'pv-demo' });
  const head = h('tr', null, h('th', { class: 'pv-r' }, rowName), ...colSamples.map((c) => h('th', { class: 'pv-c' }, c)), st.totals ? h('th', { class: 'pv-t' }, '합계') : null);
  tbl.append(head);
  rowSamples.forEach((r) => tbl.append(h('tr', null, h('td', { class: 'pv-r' }, r), ...colSamples.map((c) => h('td', { class: 'pv-v' }, c === '…' ? '' : '■')), st.totals ? h('td', { class: 'pv-t' }, 'Σ') : null)));
  if (st.totals) tbl.append(h('tr', null, h('td', { class: 'pv-t' }, '합계'), ...colSamples.map(() => h('td', { class: 'pv-t' }, 'Σ')), h('td', { class: 'pv-t' }, 'Σ')));
  return h('div', { class: 'pv-guide' },
    h('div', { class: 'pv-legend' },
      h('span', null, h('i', { class: 'pv-r' }), '① 행 기준'), h('span', null, h('i', { class: 'pv-c' }), `② 열 기준: ${st.col || '?'}`), h('span', null, h('i', { class: 'pv-v' }), `③ 값: ${valName}`)),
    tbl);
}
function pipelineInput(idx) {
  // idx번째 단계에 들어가는 표 (예시 값 뽑기용)
  const sh = cur(); if (!sh || !S.base) return null;
  let t = { cols: S.base.cols, rows: S.base.rows, meta: S.base.src.map((c) => ({ c, tpl: null })) };
  for (let i = 0; i < idx; i++) {
    const st = sh.steps[i]; if (st.on === false) continue;
    try { const r = STEP_DEFS[st.type].apply(t, st); t = { cols: r.cols, rows: r.rows, meta: carryMeta(t, r) }; } catch (e) { /* 오류 단계는 건너뜀 */ }
  }
  return t;
}
function guideRows() {
  const sh = cur();
  const piv = sh.steps.filter((s) => s.type === 'pivot' && s.on !== false);
  if (!piv.length) return null;
  const p = piv[piv.length - 1];
  const valName = p.fn === 'rows' ? '행 수' : `${p.val} ${fnLabel(p.fn)}`;
  const rows = [
    ['가이드', ''],
    ['', ''],
    ['원본 파일', S.fileName],
    ['원본 시트', S.sheet],
    ['만든 시각', (() => { const d = new Date(); return `${fmtDate(d, 'YYYY-MM-DD')} ${pad(d.getHours())}:${pad(d.getMinutes())}`; })()],
    ['결과 크기', `${S.out.rows.length}행 × ${S.out.cols.length}열`],
    ['', ''],
    ['피벗 읽는 법', ''],
    ['행 기준', p.rows.length ? p.rows.join(', ') : '(없음: 전체 한 줄)'],
    ['열 기준', `${p.col} (값마다 열 하나)`],
    ['칸 값', valName],
    ['한 칸의 뜻', `행(${p.rows.join('·') || '전체'}) × 열(${p.col})에 해당하는 원본 행들의 ${valName}`],
    ['합계 행·열', p.totals ? '있음 (맨 아래 줄, 맨 오른쪽 열)' : '없음'],
    ['빈 칸', p.zero ? '해당 행 없으면 0' : '해당 행 없으면 빈 칸'],
    ['', ''],
    ['가공 순서', ''],
    ['원본 읽기', `머리글 ${sh.read.headerStart + 1}번째 줄부터 ${sh.read.headerRows}줄${sh.read.dropSubtotals ? ', 소계·합계 줄 제외' : ''}${sh.read.fillMerges ? ', 병합 셀 채움' : ''}`],
  ];
  sh.steps.forEach((st) => { if (st.on !== false) rows.push([STEP_DEFS[st.type].label, STEP_DEFS[st.type].summary(st)]); });
  return rows;
}

// 열 정리: 손잡이를 끌어서 순서 바꾸기 (마우스·터치 공통 pointer 이벤트)
function startColDrag(e, listEl, items) {
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  const rows = [...listEl.querySelectorAll('.col-item')];
  const from = rows.indexOf(e.currentTarget.closest('.col-item'));
  if (from < 0) return;
  rows[from].classList.add('dragging');
  document.body.classList.add('drag-active');
  let to = from, lastY = e.clientY, timer = null;
  const mark = () => {
    rows.forEach((x, i) => {
      x.classList.toggle('drop-before', i === to && to !== from && to !== from + 1);
      x.classList.toggle('drop-after', to === rows.length && i === rows.length - 1 && from !== rows.length - 1);
    });
  };
  const locate = () => {
    to = rows.length;
    for (let i = 0; i < rows.length; i++) { const b = rows[i].getBoundingClientRect(); if (lastY < b.top + b.height / 2) { to = i; break; } }
    mark();
  };
  // 목록 끝에 가까우면 자동 스크롤
  const scroll = () => {
    const r = listEl.getBoundingClientRect();
    if (lastY < r.top + 28) listEl.scrollTop -= 10; else if (lastY > r.bottom - 28) listEl.scrollTop += 10; else return;
    locate();
  };
  timer = setInterval(scroll, 30);
  const move = (ev) => { lastY = ev.clientY; locate(); };
  const up = () => {
    clearInterval(timer);
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
    rows.forEach((x) => x.classList.remove('drop-before', 'drop-after', 'dragging'));
    document.body.classList.remove('drag-active');
    const dest = to > from ? to - 1 : to;
    if (dest !== from) { items.splice(dest, 0, items.splice(from, 1)[0]); changed(true); }
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
}

function renderSteps() {
  const sh = cur(); const box = $('steps');
  // 다시 그려도 스크롤 위치 유지 (사이드 패널 + 열 목록)
  const side = $('side'); const sideTop = side.scrollTop;
  box.style.minHeight = box.offsetHeight + 'px';
  box.textContent = '';
  if (!sh) { box.style.minHeight = ''; return; }
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
  box.querySelectorAll('[data-keep-scroll]').forEach((el) => {
    const st = sh.steps[+el.closest('.step').dataset.i];
    if (st && st._scroll) el.scrollTop = st._scroll;
  });
  box.style.minHeight = '';
  side.scrollTop = sideTop;
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
  fi.append(h('span', { class: 'fname' }, S.fileName), h('button', { class: 'link re', onclick: () => $('fileIn').click() }, '다른 파일'),
    h('button', { class: 'link re', title: '파일을 닫고 브라우저에 저장된 작업도 지움', onclick: closeFile }, '닫기'));
  const sl = $('sheetList'); sl.textContent = '';
  if (S.isCsv) return;
  // 시트가 많아도 한 줄로: 드롭다운 + 이전/다음
  const names = S.wb.SheetNames;
  const label = (sn) => { const n = S.sheets[sn].grid.length; return `${sn}  ·  ${n ? `${n.toLocaleString()}줄` : '빈 시트'}`; };
  const i = names.indexOf(S.sheet);
  sl.append(h('div', { class: 'sheet-pick' },
    h('span', { class: 'sheet-l' }, '시트'),
    select(names.map((sn) => [sn, label(sn)]), S.sheet, (v) => selectSheet(v), { id: 'sheetSel' }),
    h('span', { class: 'sheet-n muted' }, `${i + 1}/${names.length}`),
    h('button', { class: 'icon-btn', title: '이전 시트', disabled: i <= 0, onclick: () => selectSheet(names[i - 1]) }, '‹'),
    h('button', { class: 'icon-btn', title: '다음 시트', disabled: i >= names.length - 1, onclick: () => selectSheet(names[i + 1]) }, '›')));
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
  closeFmtPop();
  $('ruleName').value = '';
  renderFile(); renderRead();
  refresh(true);
  updateOutName(); renderRules();
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
    if (rows[r].kind) continue; // 소계 줄은 형식 판단에서 제외
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
  paintSel();
}
function renderResult(view) {
  const t = S.out;
  $('shape').innerHTML = `결과 <b>${t.rows.length.toLocaleString()}</b>행 · <b>${t.cols.length}</b>열`;
  if (!t.cols.length) { view.innerHTML = '<div class="empty-res">남은 열이 없음. 가공 단계를 확인해 줘.</div>'; return; }
  const n = Math.min(t.rows.length, PREVIEW_ROWS);
  const xl = S.fmtView;
  const cs = S.colStyles = computeColStyles(t);
  const wcss = cs.map((x) => (x.width ? `width:${widthPx(x.width)}px;min-width:${widthPx(x.width)}px;max-width:${widthPx(x.width)}px;` : ''));
  const hcss = cs.map((x, j) => wcss[j] + styleCss(x.head));
  const dcss = cs.map((x, j) => wcss[j] + styleCss(x.data));
  const nf = cs.map((x) => (x.data && x.data.numFmt) || null);
  let html = `<table class="grid res${xl ? ' xl' : ''}"><thead><tr><th class="rn"></th>`;
  t.cols.forEach((c, i) => { html += `<th class="fh" data-col="${i}" title="눌러서 서식 편집"${xl ? ` style="${esc(hcss[i])}"` : ''}>${esc(c)}<span class="ty">${colType(t.rows, i)}</span></th>`; });
  html += '</tr></thead><tbody>';
  for (let r = 0; r < n; r++) {
    const kind = t.rows[r].kind;
    html += `<tr${kind ? ` class="k-${kind}"` : ''}><td class="rn">${r + 1}</td>`;
    if (!xl) { for (const v of t.rows[r]) html += cellHtml(v); }
    else t.rows[r].forEach((v, j) => {
      const s2 = fmtVal(v, nf[j]);
      const cls = v == null ? 'e' : (typeof v === 'number' || v instanceof Date) ? 'n' : '';
      html += `<td class="${cls}" style="${esc(dcss[j])}"${s2.length > 40 ? ` title="${esc(s2)}"` : ''}>${esc(s2)}</td>`;
    });
    html += '</tr>';
  }
  html += '</tbody></table>';
  if (!t.rows.length) html += '<div class="empty-res">조건에 맞는 행이 없음</div>';
  if (t.rows.length > n) html += `<div class="more">미리보기는 ${n.toLocaleString()}행까지. 내려받으면 ${t.rows.length.toLocaleString()}행 전부 들어감</div>`;
  view.innerHTML = html;
  // 열 너비가 바뀌면 편집 창 위치도 다시
  const pop = $('fmtPop');
  if (pop) { const th = view.querySelector(`th.fh[data-col="${pop.dataset.col}"]`); if (th) placeFmtPop(pop, th); else closeFmtPop(); }
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

// ───────────────────────── 결과 표 선택·복사 ─────────────────────────
// 클립보드로만 복사. 외부 전송 없음.
// S.sel: { a:[r,c], b:[r,c], mode:'cell'|'col'|'row'|'all' }
const COPY_FMTS = [
  ['tsv', '엑셀용'],
  ['jsobj', 'JS 객체 배열'],
  ['json', 'JSON'],
  ['jsarr', 'JS 2차원 배열'],
  ['lines', '목록 (줄바꿈)'],
  ['comma', '목록 (쉼표)'],
];
let selDrag = null;

function selRange() {
  const s = S.sel, t = S.out;
  if (!s || !t || !t.cols.length) return null;
  const nr = t.rows.length, nc = t.cols.length;
  let r1 = Math.min(s.a[0], s.b[0]), r2 = Math.max(s.a[0], s.b[0]);
  let c1 = Math.min(s.a[1], s.b[1]), c2 = Math.max(s.a[1], s.b[1]);
  if (s.mode === 'col' || s.mode === 'all') { r1 = 0; r2 = nr - 1; }
  if (s.mode === 'row' || s.mode === 'all') { c1 = 0; c2 = nc - 1; }
  r2 = Math.min(r2, nr - 1); c2 = Math.min(c2, nc - 1);
  if (r1 > r2 || c1 > c2) return null;
  return { r1, r2, c1, c2, rows: r2 - r1 + 1, cols: c2 - c1 + 1 };
}
function setSel(sel) { S.sel = sel; paintSel(); }
function clearSel() { if (!S.sel) return; S.sel = null; paintSel(); }

function paintSel() {
  const view = $('view');
  view.querySelectorAll('.sel').forEach((el) => el.classList.remove('sel'));
  view.querySelectorAll('.sel-h').forEach((el) => el.classList.remove('sel-h'));
  const g = S.view === 'result' && selRange();
  renderSelBar(g);
  if (!g) return;
  const tbody = view.querySelector('table.grid tbody'); if (!tbody) return;
  view.querySelectorAll('thead th.fh').forEach((th) => { const j = +th.dataset.col; if (j >= g.c1 && j <= g.c2) th.classList.add('sel-h'); });
  const trs = tbody.rows;
  const end = Math.min(g.r2, trs.length - 1);
  for (let r = g.r1; r <= end; r++) {
    const cells = trs[r].cells;
    cells[0].classList.add('sel-h');
    for (let c = g.c1; c <= g.c2; c++) if (cells[c + 1]) cells[c + 1].classList.add('sel');
  }
}

function renderSelBar(g) {
  let bar = $('selBar');
  if (!g) { if (bar) bar.hidden = true; return; }
  if (!bar) {
    bar = h('div', { id: 'selBar', class: 'sel-bar' });
    $('view').after(bar);
  }
  bar.hidden = false; bar.textContent = '';
  const one = g.cols === 1;
  bar.append(
    h('span', { class: 'sel-cnt' }, `${g.rows.toLocaleString()}행 × ${g.cols}열`),
    h('label', { class: 'tgl sel-hdr', title: '엑셀용 복사에 머리글 줄 넣기' },
      h('input', { type: 'checkbox', checked: S.copyHead !== false, onchange: (e) => { S.copyHead = e.target.checked; } }), h('span', null, '머리글 포함')),
    h('span', { class: 'sel-sep' }),
    ...COPY_FMTS.filter(([k]) => one || (k !== 'lines' && k !== 'comma'))
      .map(([k, label]) => h('button', { class: 'btn sm' + (k === 'tsv' ? ' primary' : ''), onclick: () => copySel(k) }, label)),
    h('button', { class: 'icon-btn', title: '선택 해제 (Esc)', onclick: clearSel }, '×'));
}

// 값 → 복사용
function jsVal(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return fmtDate(v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return v;
}
function jsLit(v) {
  const x = jsVal(v);
  return x == null ? 'null' : typeof x === 'number' || typeof x === 'boolean' ? String(x) : JSON.stringify(x);
}
const JS_IDENT = /^[A-Za-z_$가-힣][\w$가-힣]*$/;
function jsKey(k) { return JS_IDENT.test(k) ? k : JSON.stringify(k); }
function tsvCell(v) {
  const s = str(v);
  return /[\t\r\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function uniqKeys(cols) {
  const seen = new Map();
  return cols.map((c) => { const k = c || '열'; const n = (seen.get(k) || 0) + 1; seen.set(k, n); return n > 1 ? `${k}_${n}` : k; });
}

function selText(kind, g) {
  const t = S.out;
  const cols = uniqKeys(t.cols.slice(g.c1, g.c2 + 1));
  const rows = t.rows.slice(g.r1, g.r2 + 1).map((r) => r.slice(g.c1, g.c2 + 1));
  switch (kind) {
    case 'tsv': {
      const lines = rows.map((r) => r.map(tsvCell).join('\t'));
      if (S.copyHead !== false) lines.unshift(cols.map(tsvCell).join('\t'));
      return lines.join('\r\n');
    }
    case 'json':
      return JSON.stringify(rows.map((r) => Object.fromEntries(cols.map((k, j) => [k, jsVal(r[j])]))), null, 2);
    case 'jsobj':
      return `[\n${rows.map((r) => `  { ${cols.map((k, j) => `${jsKey(k)}: ${jsLit(r[j])}`).join(', ')} },`).join('\n')}\n]`;
    case 'jsarr':
      return `[\n${rows.map((r) => `  [${r.map(jsLit).join(', ')}],`).join('\n')}\n]`;
    case 'lines':
      return rows.map((r) => str(r[0])).join('\n');
    case 'comma':
      return rows.map((r) => str(r[0])).filter((s) => s !== '').join(', ');
    default: return '';
  }
}

async function writeClip(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* 아래 방식으로 */ }
  const ta = h('textarea', { style: 'position:fixed;left:-9999px;top:0', readonly: '' }, text);
  document.body.append(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok;
}
async function copySel(kind) {
  const g = selRange(); if (!g) return;
  const text = selText(kind, g);
  const ok = await writeClip(text);
  const label = (COPY_FMTS.find(([k]) => k === kind) || [, ''])[1];
  toast(ok ? `${g.rows.toLocaleString()}행 × ${g.cols}열 복사 (${label})` : '복사 실패. 브라우저 권한 확인', !ok);
}

function cellPos(el) {
  const td = el.closest('td'); if (!td) return null;
  const tr = td.parentElement; if (!tr.parentElement || tr.parentElement.tagName !== 'TBODY') return null;
  return { r: tr.sectionRowIndex, c: td.cellIndex - 1, rn: td.classList.contains('rn') };
}
function initSelection() {
  const view = $('view');
  view.addEventListener('mousedown', (e) => {
    if (S.view !== 'result' || e.button !== 0) return;
    const th = e.target.closest('th.fh');
    if (th) {
      const c = +th.dataset.col;
      if (e.shiftKey && S.sel && S.sel.mode === 'col') setSel({ ...S.sel, b: [0, c] });
      else setSel({ a: [0, c], b: [0, c], mode: 'col' });
      selDrag = 'col'; e.preventDefault(); return;
    }
    if (e.target.closest('thead .rn')) { setSel({ a: [0, 0], b: [0, 0], mode: 'all' }); e.preventDefault(); return; }
    const p = cellPos(e.target); if (!p) return;
    if (p.rn) {
      if (e.shiftKey && S.sel && S.sel.mode === 'row') setSel({ ...S.sel, b: [p.r, 0] });
      else setSel({ a: [p.r, 0], b: [p.r, 0], mode: 'row' });
      selDrag = 'row';
    } else {
      if (e.shiftKey && S.sel && S.sel.mode === 'cell') setSel({ ...S.sel, b: [p.r, p.c] });
      else setSel({ a: [p.r, p.c], b: [p.r, p.c], mode: 'cell' });
      selDrag = 'cell';
    }
    e.preventDefault();
  });
  view.addEventListener('mouseover', (e) => {
    if (!selDrag || !S.sel) return;
    if (selDrag === 'col') {
      const th = e.target.closest('th.fh'); if (th) setSel({ ...S.sel, b: [0, +th.dataset.col] });
      return;
    }
    const p = cellPos(e.target); if (!p) return;
    if (selDrag === 'row') setSel({ ...S.sel, b: [p.r, 0] });
    else if (!p.rn) setSel({ ...S.sel, b: [p.r, p.c] });
  });
  window.addEventListener('mouseup', () => { selDrag = null; });
  // Ctrl+C: 엑셀용, Ctrl+A: 전체, Esc: 해제
  document.addEventListener('copy', (e) => {
    if (S.view !== 'result' || !S.sel) return;
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    if (String(window.getSelection() || '')) return;
    const g = selRange(); if (!g) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', selText('tsv', g));
    toast(`${g.rows.toLocaleString()}행 × ${g.cols}열 복사 (엑셀용)`);
  });
  document.addEventListener('keydown', (e) => {
    if (S.view !== 'result' || !S.out) return;
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !$('view').hidden) {
      e.preventDefault(); setSel({ a: [0, 0], b: [0, 0], mode: 'all' });
    } else if (e.key === 'Escape' && !$('fmtPop')) clearSel(); // 서식 창 열려 있으면 창만 닫음
  });
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
const DEFAULT_HEAD = {
  font: { bold: true },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F3F6' } },
  border: { bottom: { style: 'thin', color: { argb: 'FFB8BEC8' } } },
};
const isDateFmt = (f) => !!f && XLSX.SSF.is_date(f);
// ExcelJS는 Date를 UTC로 저장하므로 현지 시각 그대로 보이게 변환
const toUtcDate = (d) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()));
function textWidth(v) { return [...str(v)].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 2 : 1), 0); }

// ───────────────────────── 열 서식 계산·편집 ─────────────────────────
// 우선순위: 사용자 편집 > 템플릿 > 원본 열 > 기본. 미리보기와 엑셀 내보내기가 같은 결과를 씀
const THEME_COLORS = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47'];
function tintHex(hex, tint) {
  if (!tint) return hex;
  const ch = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).map((v) => Math.round(tint < 0 ? v * (1 + tint) : v + (255 - v) * tint));
  return ch.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}
function colorCss(c) {
  if (!c) return null;
  if (c.argb && /^[0-9a-f]{8}$/i.test(c.argb)) return '#' + c.argb.slice(2);
  if (c.theme != null && THEME_COLORS[c.theme]) return '#' + tintHex(THEME_COLORS[c.theme], c.tint);
  return null;
}
const cssToArgb = (css) => 'FF' + css.replace('#', '').toUpperCase();
function fmtState() {
  const sh = cur();
  if (!sh.fmt) sh.fmt = { cols: {}, head: {} };
  return sh.fmt;
}
function applyOv(style, ov) {
  if (!ov || !Object.keys(ov).length) return style;
  const s = style ? JSON.parse(JSON.stringify(style)) : {};
  if (ov.numFmt !== undefined) { if (ov.numFmt === 'General') delete s.numFmt; else s.numFmt = ov.numFmt; }
  if (ov.bold !== undefined) s.font = { ...(s.font || {}), bold: ov.bold };
  if (ov.color !== undefined) { s.font = { ...(s.font || {}) }; if (ov.color === 'none') delete s.font.color; else s.font.color = { argb: cssToArgb(ov.color) }; }
  if (ov.fill !== undefined) { if (ov.fill === 'none') delete s.fill; else s.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cssToArgb(ov.fill) } }; }
  if (ov.align !== undefined) { s.alignment = { ...(s.alignment || {}) }; if (ov.align === '') delete s.alignment.horizontal; else s.alignment.horizontal = ov.align; }
  return Object.keys(s).length ? s : null;
}
function computeColStyles(t) {
  const fs = fmtState();
  const cols = t.cols.map((name, j) => {
    const m = t.meta[j] || { c: null, tpl: null };
    const src = sourceColStyle(m.c);
    const tpl = m.tpl || {};
    let data = tpl.data || src.data || null;
    // 집계 열은 원본 숫자 형식만 이어받음 (글꼴·색은 기본)
    if (m.valueOnly && data) data = data.numFmt ? { numFmt: data.numFmt } : null;
    // 새로 만든 숫자 열(계산·집계)은 천 단위 쉼표
    if (m.c == null && !(data && data.numFmt)) {
      const vs = t.rows.filter((r) => !isEmpty(r[j])).map((r) => r[j]);
      if (vs.length && vs.every((v) => typeof v === 'number')) data = { ...(data || {}), numFmt: vs.every(Number.isInteger) ? '#,##0' : '#,##0.00' };
    }
    const ov = fs.cols[name] || {};
    return { head: tpl.head || (m.valueOnly ? null : src.head), data: applyOv(data, ov), width: ov.width || tpl.width || src.width || null };
  });
  const anyHead = cols.find((x) => x.head);
  const fallbackHead = anyHead ? anyHead.head : DEFAULT_HEAD;
  cols.forEach((x) => { x.head = applyOv(x.head || fallbackHead, fs.head); });
  return cols;
}
function styleCss(st) {
  if (!st) return '';
  const p = [];
  const f = st.font || {};
  if (f.bold) p.push('font-weight:700'); else if (f.bold === false) p.push('font-weight:400');
  if (f.italic) p.push('font-style:italic');
  if (f.underline) p.push('text-decoration:underline');
  const fc = colorCss(f.color); if (fc) p.push(`color:${fc}`);
  if (st.fill && st.fill.type === 'pattern' && st.fill.pattern && st.fill.pattern !== 'none') { const bc = colorCss(st.fill.fgColor); if (bc) p.push(`background:${bc}`); }
  const a = st.alignment && st.alignment.horizontal;
  if (['left', 'center', 'right'].includes(a)) p.push(`text-align:${a}`);
  return p.join(';');
}
// 엑셀 숫자 형식대로 표시 (실패하면 기본 표시)
function fmtVal(v, numFmt) {
  if (v == null) return '';
  try {
    if (numFmt && numFmt !== 'General') {
      if (typeof v === 'number') return XLSX.SSF.format(numFmt, v);
      if (v instanceof Date && isDateFmt(numFmt)) return XLSX.SSF.format(numFmt, serial(v));
    }
  } catch (e) { /* 형식 해석 실패 */ }
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('ko-KR') : v.toLocaleString('ko-KR', { maximumFractionDigits: 10 });
  return str(v);
}
const widthPx = (w) => Math.round(w * 7.5 + 12);

const NUMFMT_PRESETS = [
  ['', '원본 그대로'], ['General', '일반 (형식 없음)'], ['#,##0', '1,234'], ['#,##0.00', '1,234.56'], ['#,##0"원"', '1,234원'],
  ['0%', '12%'], ['0.0%', '12.3%'], ['yyyy-mm-dd', '2026-01-05'], ['yyyy"년" m"월" d"일"', '2026년 1월 5일'], ['yyyy-mm-dd hh:mm', '2026-01-05 13:30'],
  ['@', '글자 그대로'], ['__custom', '직접 입력…'],
];
const ALIGNS = [['', '원본'], ['left', '왼쪽'], ['center', '가운데'], ['right', '오른쪽']];

function closeFmtPop() { const p = $('fmtPop'); if (p) p.remove(); }
function openFmtPop(j, anchor) {
  closeFmtPop();
  // 표가 다시 그려져 기준 머리글이 바뀌었으면 새로 찾음
  if (!anchor || !anchor.isConnected) anchor = document.querySelector(`th.fh[data-col="${j}"]`);
  if (!anchor || !S.out || j >= S.out.cols.length) return;
  const name = S.out.cols[j];
  const fs = fmtState();
  const ov = fs.cols[name] || (fs.cols[name] = {});
  const eff = (S.colStyles && S.colStyles[j]) || {};
  const effData = eff.data || {};
  const effHead = eff.head || {};
  const upd = () => { if (!Object.keys(ov).length) delete fs.cols[name]; changed(false); };
  const colorRow = (label, cur, key, target) => {
    const inp = h('input', { type: 'color', value: cur || '#000000', oninput: (e) => { target[key] = e.target.value; upd(); } });
    return h('div', { class: 'fp-row' }, h('span', { class: 'fp-l' }, label), inp,
      h('button', { class: 'btn ghost sm', title: '색 없음', onclick: () => { target[key] = 'none'; upd(); } }, '없음'),
      h('button', { class: 'btn ghost sm', title: '원본 색으로', onclick: () => { delete target[key]; upd(); } }, '원본'));
  };
  const presetVal = ov.numFmt === undefined ? '' : (NUMFMT_PRESETS.some(([v]) => v === ov.numFmt) ? ov.numFmt : '__custom');
  const custom = h('input', { type: 'text', value: presetVal === '__custom' ? ov.numFmt : '', placeholder: '예: #,##0"건"', spellcheck: 'false',
    hidden: presetVal !== '__custom', oninput: (e) => { if (e.target.value.trim()) ov.numFmt = e.target.value; else delete ov.numFmt; upd(); } });
  const numSel = select(NUMFMT_PRESETS, presetVal, (v) => {
    custom.hidden = v !== '__custom';
    if (v === '') delete ov.numFmt; else if (v !== '__custom') ov.numFmt = v; else custom.focus();
    upd();
  });
  const seg = (opts, val, onpick) => h('div', { class: 'seg' }, ...opts.map(([v, l]) => h('button', { class: 'seg-b' + (v === val ? ' on' : ''), onclick: (e) => {
    e.currentTarget.parentNode.querySelectorAll('.seg-b').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); onpick(v);
  } }, l)));
  const boldVal = ov.bold === undefined ? '' : ov.bold ? '1' : '0';
  const pop = h('div', { id: 'fmtPop', class: 'fmt-pop' },
    h('div', { class: 'fp-h' }, h('b', null, name), h('span', { class: 'muted' }, ' 열 서식'),
      h('button', { class: 'icon-btn', style: 'margin-left:auto', title: '닫기', onclick: closeFmtPop }, '×')),
    h('div', { class: 'fp-row' }, h('span', { class: 'fp-l' }, '숫자 형식'), numSel),
    custom,
    h('div', { class: 'fp-row' }, h('span', { class: 'fp-l' }, '굵게'), seg([['', '원본'], ['1', '굵게'], ['0', '보통']], boldVal, (v) => { if (v === '') delete ov.bold; else ov.bold = v === '1'; upd(); })),
    colorRow('글자색', colorCss((effData.font || {}).color), 'color', ov),
    colorRow('배경색', colorCss((effData.fill || {}).fgColor) || '#ffffff', 'fill', ov),
    h('div', { class: 'fp-row' }, h('span', { class: 'fp-l' }, '맞춤'), seg(ALIGNS, ov.align === undefined ? '' : ov.align, (v) => { if (v === '') delete ov.align; else ov.align = v; upd(); })),
    h('div', { class: 'fp-row' }, h('span', { class: 'fp-l' }, '열 너비'),
      h('input', { type: 'number', min: '2', max: '100', step: '1', value: ov.width || '', placeholder: eff.width ? String(Math.round(eff.width)) : '자동',
        oninput: (e) => { const w = parseFloat(e.target.value); if (w > 0) ov.width = Math.min(100, w); else delete ov.width; upd(); } }),
      h('span', { class: 'muted fp-u' }, '글자 수')),
    h('button', { class: 'link', onclick: () => { Object.keys(ov).forEach((k) => delete ov[k]); upd(); setTimeout(() => openFmtPop(j), 220); } }, '이 열 원래대로'),
    h('div', { class: 'fp-sep' }),
    h('div', { class: 'fp-h2' }, '머리글 줄 전체'),
    colorRow('배경색', colorCss((effHead.fill || {}).fgColor) || '#ffffff', 'fill', fs.head),
    colorRow('글자색', colorCss((effHead.font || {}).color), 'color', fs.head),
    h('div', { class: 'fp-row' }, h('span', { class: 'fp-l' }, '굵게'), seg([['', '원본'], ['1', '굵게'], ['0', '보통']], fs.head.bold === undefined ? '' : fs.head.bold ? '1' : '0', (v) => { if (v === '') delete fs.head.bold; else fs.head.bold = v === '1'; changed(false); })),
    h('button', { class: 'link', onclick: () => { fs.head = {}; changed(false); setTimeout(() => openFmtPop(j), 220); } }, '머리글 원래대로'));
  pop.dataset.col = j;
  document.body.append(pop);
  placeFmtPop(pop, anchor);
}
function placeFmtPop(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, hgt = pop.offsetHeight;
  // 편집 중인 열을 가리지 않게 열 오른쪽, 자리 없으면 왼쪽
  let left = r.right + 8;
  if (left + w > window.innerWidth - 8) left = r.left - w - 8;
  if (left < 8) left = Math.max(8, window.innerWidth - w - 8);
  pop.style.left = left + 'px';
  pop.style.top = Math.max(8, Math.min(window.innerHeight - hgt - 8, r.top)) + 'px';
}

async function exportXlsx(t, name) {
  const outline = t.rows.some((r) => r.kind);
  const wb = new ExcelJS.Workbook();
  const sheetName = safeName(S.sheet || '결과').replace(/[\[\]]/g, '_').slice(0, 31);
  const ws = wb.addWorksheet(sheetName === '가이드' ? '결과' : sheetName, {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: outline ? { outlineLevelRow: 1, outlineProperties: { summaryBelow: true } } : {},
  });
  const colSt = computeColStyles(t);
  const widths = t.cols.map((c, j) => colSt[j].width || Math.min(40, Math.max(6, textWidth(c) + 2)));

  const hdr = ws.addRow(t.cols);
  hdr.eachCell((cell, k) => { if (colSt[k - 1].head) cell.style = colSt[k - 1].head; });

  const boldOf = colSt.map((x) => ({ ...(x.data || {}), font: { ...((x.data && x.data.font) || {}), bold: true } }));
  t.rows.forEach((r, ri) => {
    const row = ws.addRow(r.map((v) => (v instanceof Date ? toUtcDate(v) : v)));
    if (outline && !r.kind) row.outlineLevel = 1;
    for (let j = 0; j < r.length; j++) {
      const v = r[j];
      const base = r.kind ? boldOf[j] : colSt[j].data;
      const cell = row.getCell(j + 1);
      if (base) cell.style = base;
      // 날짜인데 날짜 형식이 없으면 기본 날짜 형식, 숫자 아닌 값에는 숫자 형식 안 씀
      if (v instanceof Date && !isDateFmt(base && base.numFmt)) cell.numFmt = hasTime(v) ? 'yyyy-mm-dd hh:mm' : 'yyyy-mm-dd';
      else if (base && base.numFmt && typeof v !== 'number' && !(v instanceof Date)) cell.numFmt = 'General';
      if (ri < 300 && !colSt[j].width) widths[j] = Math.min(50, Math.max(widths[j], textWidth(v) + 2));
    }
  });
  widths.forEach((w, j) => { ws.getColumn(j + 1).width = w; });
  if (!outline && t.cols.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: t.cols.length } };

  const g = guideRows();
  if (g) {
    const gs = wb.addWorksheet('가이드');
    g.forEach((row) => gs.addRow(row));
    gs.getColumn(1).width = 14; gs.getColumn(2).width = 70;
    gs.getCell('A1').font = { bold: true, size: 13 };
    ['A8', 'A16'].forEach((a) => { gs.getCell(a).font = { bold: true }; });
  }
  const buf = await wb.xlsx.writeBuffer();
  download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${name}.xlsx`);
}
function exportJson(t, name) {
  const keys = uniqKeys(t.cols);
  const data = t.rows.map((r) => Object.fromEntries(keys.map((k, j) => [k, jsVal(r[j])])));
  download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }), `${name}.json`);
}
function exportCsv(t, name) {
  const q = (v) => { const s = str(v); return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [t.cols.map(q).join(','), ...t.rows.map((r) => r.map(q).join(','))];
  // 엑셀에서 한글 안 깨지게 BOM 붙임
  download(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `${name}.csv`);
}
async function doDownload() {
  if (!S.out) return;
  runPipeline();
  const name = safeName($('outName').value);
  const fmt = $('outFmt').value;
  try {
    if (fmt === 'csv') exportCsv(S.out, name);
    else if (fmt === 'json') exportJson(S.out, name);
    else await exportXlsx(S.out, name);
  } catch (e) { console.error(e); toast(`내려받기 실패: ${e.message || e}`, true); return; }
  const hasGuide = !!guideRows();
  const kind = fmt === 'csv' ? 'CSV' : 'JSON';
  toast(`${S.out.rows.length.toLocaleString()}행 내려받기 완료${hasGuide ? (fmt !== 'xlsx' ? ` (${kind}에는 가이드 시트가 빠짐. 엑셀로 받으면 포함)` : ' · 가이드 시트 포함') : ''}`);
}

// ───────────────────────── 규칙 목록: 브라우저 저장소 + JSON 내보내기·가져오기 ─────────────────────────
// 저장 위치: 이 PC 크롬의 localStorage. 서버 전송 없음.
const LIB_KEY = 'data-shaper:library';

function readLib() {
  try {
    const v = JSON.parse(localStorage.getItem(LIB_KEY) || 'null');
    if (v && Array.isArray(v.rules)) return v.rules;
  } catch (e) { /* 저장소 막힘 */ }
  return [];
}
function writeLib(rules) {
  try { localStorage.setItem(LIB_KEY, JSON.stringify({ rules })); return true; }
  catch (e) { return false; }
}
function validRule(r) {
  return r && Array.isArray(r.steps) && r.steps.every((s) => s && STEP_DEFS[s.type]);
}
function currentRule(name) {
  const sh = cur();
  return {
    name,
    sheet: S.sheet,
    file: S.fileName,
    savedAt: new Date().toISOString(),
    read: { ...sh.read },
    steps: sh.steps.map(({ open, _scroll, ...rest }) => rest),
    output: { format: $('outFmt').value },
    fmt: JSON.parse(JSON.stringify(sh.fmt || { cols: {}, head: {} })),
  };
}
function applyRule(rule) {
  const sh = cur();
  if (rule.read) Object.assign(sh.read, rule.read);
  sh.steps = rule.steps.map((s) => ({ ...s, open: false }));
  sh.toggled = new Set();
  sh.fmt = rule.fmt && rule.fmt.cols ? JSON.parse(JSON.stringify(rule.fmt)) : { cols: {}, head: {} };
  if (rule.output && rule.output.format) $('outFmt').value = rule.output.format;
  $('ruleName').value = rule.name;
  renderRead(); refresh(true); renderRules();
  const errs = S.stepInfo.filter((x) => x.error).length;
  toast(errs ? `'${rule.name}' 적용. 이 시트와 맞지 않는 단계 ${errs}개는 건너뜀` : `'${rule.name}' 적용`, !!errs);
}
function saveRule() {
  if (!S.wb) return;
  const name = $('ruleName').value.trim();
  if (!name) { toast('규칙 이름을 넣어야 함', true); $('ruleName').focus(); return; }
  if (!cur().steps.length) { toast('저장할 가공 단계가 없음', true); return; }
  const lib = readLib();
  const i = lib.findIndex((r) => r.name === name);
  const rule = currentRule(name);
  if (i >= 0) lib[i] = rule; else lib.push(rule);
  if (!writeLib(lib)) { toast('브라우저 저장소에 저장 못 함 (저장소가 막혀 있음). 내보내기로 따로 보관 필요', true); return; }
  renderRules();
  toast(i >= 0 ? `'${name}' 덮어씀` : `'${name}' 저장`);
}
function deleteRule(name) {
  writeLib(readLib().filter((r) => r.name !== name));
  renderRules();
  toast(`'${name}' 삭제`);
}
function fmtSaved(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : `${fmtDate(d, 'YYYY-MM-DD')} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function renderRules() {
  const box = $('ruleList'); box.textContent = '';
  const lib = readLib();
  if (!lib.length) { box.append(h('div', { class: 'rule-empty' }, '저장된 규칙 없음')); return; }
  // 지금 시트 이름과 같은 시트에서 만든 규칙을 위로
  const sorted = lib.slice().sort((a, b) => ((b.sheet === S.sheet) - (a.sheet === S.sheet)) || collator.compare(a.name, b.name));
  for (const r of sorted) {
    let armed = false;
    const del = h('button', { class: 'icon-btn', title: '삭제', onclick: () => {
      if (armed) { deleteRule(r.name); return; }
      armed = true; del.textContent = '삭제?'; del.classList.add('armed');
      setTimeout(() => { armed = false; del.textContent = '×'; del.classList.remove('armed'); }, 2500);
    } }, '×');
    box.append(h('div', { class: 'rule-item' + (r.name === $('ruleName').value.trim() ? ' on' : '') },
      h('div', { class: 'rule-main' },
        h('div', { class: 'rule-name' }, r.name, r.sheet === S.sheet ? h('span', { class: 'rule-tag' }, '이 시트') : null),
        h('div', { class: 'rule-meta' }, `${r.sheet || ''} · 단계 ${r.steps.length}개 · ${fmtSaved(r.savedAt)}`)),
      h('button', { class: 'btn sm', onclick: () => applyRule(r) }, '적용'),
      del));
  }
}
function exportRules() {
  const lib = readLib();
  if (!lib.length) { toast('저장된 규칙이 없음', true); return; }
  const data = { app: RULE_APP, version: 3, exportedAt: new Date().toISOString(), rules: lib };
  download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `data-shaper_규칙목록_${fmtDate(new Date(), 'YYYYMMDD')}.json`);
  toast(`규칙 ${lib.length}개 내보내기 완료`);
}
async function importRules(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { toast('규칙 파일을 읽지 못함 (JSON 형식 아님)', true); return; }
  if (!data || data.app !== RULE_APP) { toast('이 도구에서 내보낸 규칙 파일이 아님', true); return; }
  // version 3: 목록, 그 이전: 규칙 하나 또는 키별 묶음
  let incoming = [];
  if (Array.isArray(data.rules)) incoming = data.rules;
  else if (data.rules && typeof data.rules === 'object') incoming = Object.entries(data.rules).map(([k, r]) => ({ ...r, name: r.name || k.replace(/^(sheet|file):/, '') }));
  else if (validRule(data)) incoming = [{ ...data, name: data.name || data.sheet || file.name.replace(/\.json$/i, '') }];
  incoming = incoming.filter((r) => validRule(r) && r.name);
  if (!incoming.length) { toast('가져올 수 있는 규칙이 없음', true); return; }
  const lib = readLib();
  let replaced = 0;
  for (const r of incoming) {
    const i = lib.findIndex((x) => x.name === r.name);
    if (i >= 0) { lib[i] = r; replaced++; } else lib.push(r);
  }
  const ok = writeLib(lib);
  renderRules();
  const msg = `규칙 ${incoming.length}개 가져옴${replaced ? ` (같은 이름 ${replaced}개 덮어씀)` : ''}. 목록에서 골라 적용`;
  toast(ok ? msg : '브라우저 저장소가 막혀 가져오지 못함', !ok);
}
function resetRule() {
  const sh = cur(); if (!sh) return;
  sh.steps = []; sh.toggled = new Set(); sh.fmt = { cols: {}, head: {} };
  closeFmtPop();
  const d = detectHeader(sh.grid, sh.merges);
  sh.read = { headerStart: d.headerStart, headerRows: d.headerRows, fillMerges: true, dropSubtotals: true };
  $('ruleName').value = '';
  renderRead(); refresh(true); renderRules();
  toast('이 시트 단계 초기화 (저장된 규칙은 그대로)');
}
// 이전 버전(시트별 자동 저장)에 남은 규칙을 목록으로 옮김
function migrateOldStore() {
  try {
    const old = JSON.parse(localStorage.getItem('data-shaper:rules') || 'null');
    if (!old || typeof old !== 'object') return;
    const lib = readLib();
    for (const [k, r] of Object.entries(old)) {
      const name = k.replace(/^(sheet|file):/, '');
      if (validRule(r) && r.steps.length && !lib.some((x) => x.name === name)) lib.push({ ...r, name });
    }
    if (writeLib(lib)) localStorage.removeItem('data-shaper:rules');
  } catch (e) { /* 무시 */ }
}

// ───────────────────────── 새로고침 복원 (같은 탭 한정) ─────────────────────────
// 파일 내용과 작업 상태를 이 PC 브라우저의 IndexedDB에 저장. 서버 전송 없음.
// 탭마다 sessionStorage 토큰을 두고, 토큰이 같을 때(새로고침)만 복원.
// 열려 있는 탭은 30초마다 표시를 갱신하고, 2분 넘게 갱신 없는 저장분(닫힌 탭)은 지움.
const SESS_DB = 'data-shaper-session';
const ALIVE_MS = 30000, STALE_MS = 120000;
let sessToken = null, sessSaveTimer = null;

function idb() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(SESS_DB, 1);
    rq.onupgradeneeded = () => { rq.result.createObjectStore('files'); rq.result.createObjectStore('states'); };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function idbDo(store, mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => { db.close(); res(r && r.result); };
    tx.onerror = () => { db.close(); rej(tx.error); };
  });
}
const idbGet = (store, key) => idbDo(store, 'readonly', (s) => s.get(key));
const idbPut = (store, key, val) => idbDo(store, 'readwrite', (s) => s.put(val, key));
const idbDel = (store, key) => idbDo(store, 'readwrite', (s) => s.delete(key));
const idbAll = (store) => idbDo(store, 'readonly', (s) => s.getAllKeys());

function sessionState() {
  const sheets = {};
  for (const [sn, sh] of Object.entries(S.sheets)) {
    sheets[sn] = { read: sh.read, steps: sh.steps.map(({ _scroll, ...rest }) => rest), toggled: [...sh.toggled], fmt: sh.fmt || { cols: {}, head: {} } };
  }
  return {
    alive: Date.now(), fileName: S.fileName, sheet: S.sheet, view: S.view, fmtView: S.fmtView, sheets,
    outFmt: $('outFmt').value, outName: $('outName').value, ruleName: $('ruleName').value,
  };
}
function saveSession() {
  if (!sessToken || !S.wb) return;
  clearTimeout(sessSaveTimer);
  sessSaveTimer = setTimeout(() => { idbPut('states', sessToken, sessionState()).catch(() => {}); }, 400);
}
async function saveSessionFile(name, buf) {
  if (!sessToken) return;
  try { await idbPut('files', sessToken, { name, buf }); } catch (e) { /* 저장소 막힘: 복원만 안 됨 */ }
}
async function clearSession() {
  if (!sessToken) return;
  try { await idbDel('files', sessToken); await idbDel('states', sessToken); } catch (e) { /* 무시 */ }
}
// 닫힌 탭이 남긴 저장분 정리
async function sweepSessions() {
  try {
    const keys = await idbAll('states');
    for (const k of keys) {
      if (k === sessToken) continue;
      const st = await idbGet('states', k);
      if (!st || Date.now() - (st.alive || 0) > STALE_MS) { await idbDel('states', k); await idbDel('files', k); }
    }
    // 상태 없이 파일만 남은 것도 정리
    for (const k of await idbAll('files')) {
      if (k !== sessToken && !(await idbGet('states', k))) await idbDel('files', k);
    }
  } catch (e) { /* 무시 */ }
}
async function initSession() {
  try {
    sessToken = sessionStorage.getItem('data-shaper-tab');
    if (!sessToken) { sessToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`; sessionStorage.setItem('data-shaper-tab', sessToken); }
  } catch (e) { sessToken = null; return; }
  await sweepSessions();
  setInterval(() => { if (S.wb) idbPut('states', sessToken, sessionState()).catch(() => {}); }, ALIVE_MS);
  let f, st;
  try { f = await idbGet('files', sessToken); st = await idbGet('states', sessToken); } catch (e) { return; }
  if (!f || !st) return;
  await openFile(new File([f.buf], f.name), { restore: true });
  if (!S.wb) return;
  for (const [sn, x] of Object.entries(st.sheets || {})) {
    const sh = S.sheets[sn]; if (!sh) continue;
    if (x.read) Object.assign(sh.read, x.read);
    sh.steps = (x.steps || []).filter((s) => STEP_DEFS[s.type]);
    sh.toggled = new Set(x.toggled || []);
    sh.fmt = x.fmt && x.fmt.cols ? x.fmt : { cols: {}, head: {} };
  }
  if (st.sheet && S.sheets[st.sheet]) S.sheet = st.sheet;
  S.view = st.view || 'result';
  S.fmtView = st.fmtView !== false; $('fmtView').checked = S.fmtView;
  if (st.outFmt) $('outFmt').value = st.outFmt;
  $('ruleName').value = st.ruleName || '';
  renderFile(); renderRead(); refresh(true); renderRules();
  if (st.outName) $('outName').value = st.outName;
  toast('새로고침 전 화면 복원');
}
function closeFile() {
  clearSession();
  closeFmtPop();
  S.wb = null; S.sheets = {}; S.sheet = null; S.out = null; S.base = null; S.fileName = '';
  ['toolbar', 'panelRead', 'panelSteps', 'panelRules', 'legend'].forEach((id) => { $(id).hidden = true; });
  $('view').hidden = true; $('view').textContent = ''; $('drop').hidden = false;
  $('sheetList').textContent = ''; $('steps').textContent = ''; $('ruleName').value = '';
  renderFile();
  toast('파일 닫음 · 브라우저에 저장된 작업도 지움');
}

// ───────────────────────── 파일 열기 ─────────────────────────
async function openFile(file, opt = {}) {
  if (!file) return;
  try {
    const { wb, csv } = await readWorkbook(file);
    if (!opt.restore) await saveSessionFile(file.name, await file.arrayBuffer());
    const xwb = csv ? null : await loadStyles(file);
    S.fileName = file.name; S.wb = wb; S.isCsv = csv; S.sheets = {}; S.hasStyles = !!xwb;
    let first = null;
    for (const sn of wb.SheetNames) {
      const { grid, merges } = sheetToGrid(wb.Sheets[sn]);
      const d = detectHeader(grid, merges);
      S.sheets[sn] = { grid, merges, xws: xwb ? xwb.getWorksheet(sn) : null, toggled: new Set(), steps: [], fmt: { cols: {}, head: {} }, read: { headerStart: d.headerStart, headerRows: d.headerRows, fillMerges: true, dropSubtotals: true } };
      if (!first && grid.length) first = sn;
    }
    S.sheet = first || wb.SheetNames[0];
    S.view = 'result';
    $('drop').hidden = true; $('view').hidden = false;
    $('toolbar').hidden = false;
    $('panelRead').hidden = false;
    $('panelSteps').hidden = false;
    $('panelRules').hidden = false;
    renderFile(); renderRead(); refresh(true); updateOutName(); renderRules();
    if (opt.restore) return;
    const n = readLib().filter((r) => r.sheet === S.sheet).length;
    toast(`${file.name} 읽음 · 시트 ${wb.SheetNames.length}개${n ? ` · 이 시트용 저장 규칙 ${n}개 있음` : ''}`);
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
  $('ruleIn').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importRules(f); };
  $('btnTemplate').onclick = () => $('tplIn').click();
  $('btnSaveRule').onclick = saveRule;
  $('ruleName').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveRule(); });
  $('btnExport').onclick = exportRules;
  $('btnImport').onclick = () => $('ruleIn').click();
  $('btnResetRule').onclick = resetRule;
  $('btnAdd').onclick = () => { const m = $('addMenu'); m.hidden = !m.hidden; };
  $('btnDown').onclick = doDownload;
  initSelection();
  document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => { S.view = b.dataset.view; closeFmtPop(); renderView(); saveSession(); }; });
  $('fmtView').onchange = (e) => { S.fmtView = e.target.checked; renderView(); saveSession(); };
  ['outFmt', 'outName', 'ruleName'].forEach((id) => $(id).addEventListener('input', saveSession));
  $('outFmt').addEventListener('change', saveSession);
  // 편집 창 바깥 누르면 닫기 (머리글 클릭은 위에서 처리)
  document.addEventListener('mousedown', (e) => { const p = $('fmtPop'); if (p && !p.contains(e.target) && !e.target.closest('th.fh')) closeFmtPop(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFmtPop(); });

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
    const fh = e.target.closest('th.fh');
    if (fh && S.view === 'result') { if (!e.shiftKey) openFmtPop(+fh.dataset.col, fh); return; }
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
    if (/\.json$/i.test(f.name)) { importRules(f); return; }
    openFile(f);
  });
  renderAddMenu();
  migrateOldStore();
}
bind();
initSession();
