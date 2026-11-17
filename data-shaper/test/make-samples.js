// 테스트용 가짜 데이터 생성 (실제 사내 데이터 아님)
// 실행: node test/make-samples.js  → test/samples/ 에 생성
const fs = require('fs');
const path = require('path');
const XLSX = require(path.join(__dirname, '../vendor/xlsx.full.min.js'));

const out = path.join(__dirname, 'samples');
fs.mkdirSync(out, { recursive: true });

// 시트1: 제목 줄 + 2줄 머리글(가로 병합) + 부서 세로 병합 + 소계·합계
const sales = [
  ['2026년 상반기 지역별 매출 현황', null, null, null, null, null, null, null],
  ['작성일: 2026-07-03', null, null, null, null, null, null, '단위: 원'],
  ['부서', '담당자', '지역', '1분기', null, '2분기', null, '비고'],
  [null, null, null, '매출', '건수', '매출', '건수', null],
];
const people = [
  ['영업1팀', '김가람', '서울/강남'], ['영업1팀', '이나래', '서울/마포'], ['영업1팀', '박다온', '경기/성남'],
  ['영업2팀', '최라희', '부산/해운대'], ['영업2팀', '정마루', '대구/수성'],
  ['영업3팀', '한바다', '광주/서구'], ['영업3팀', '오새벽', '대전/유성'], ['영업3팀', '윤아라', '서울/강남'],
];
let r0 = sales.length;
const merges = [
  { s: { r: 0, c: 0 }, e: { r: 0, c: 7 } },
  { s: { r: 2, c: 0 }, e: { r: 3, c: 0 } }, { s: { r: 2, c: 1 }, e: { r: 3, c: 1 } }, { s: { r: 2, c: 2 }, e: { r: 3, c: 2 } },
  { s: { r: 2, c: 3 }, e: { r: 2, c: 4 } }, { s: { r: 2, c: 5 }, e: { r: 2, c: 6 } }, { s: { r: 2, c: 7 }, e: { r: 3, c: 7 } },
];
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
let team = null, teamStart = 0, sub = [0, 0, 0, 0], tot = [0, 0, 0, 0];
function closeTeam() {
  if (team == null) return;
  const end = sales.length - 1;
  if (end > teamStart) merges.push({ s: { r: teamStart, c: 0 }, e: { r: end, c: 0 } });
  sales.push([`${team} 소계`, null, null, ...sub, null]);
  sub = [0, 0, 0, 0];
}
for (const [t, name, reg] of people) {
  if (t !== team) { closeTeam(); team = t; teamStart = sales.length; }
  const v = [Math.round(rnd() * 5e7), Math.round(rnd() * 40) + 1, Math.round(rnd() * 5e7), Math.round(rnd() * 40) + 1];
  v.forEach((x, i) => { sub[i] += x; tot[i] += x; });
  const first = sales.length === teamStart;
  sales.push([first ? t : null, name, reg, ...v, rnd() < 0.3 ? '신규' : null]);
}
closeTeam();
sales.push(['합계', null, null, ...tot, null]);
const ws1 = XLSX.utils.aoa_to_sheet(sales);
ws1['!merges'] = merges;
for (let r = 4; r < sales.length; r++) for (const c of [3, 5]) { const ref = XLSX.utils.encode_cell({ r, c }); if (ws1[ref]) ws1[ref].z = '#,##0'; }

// 시트2: 다른 종류 데이터. 앞자리 0 사번(글자), 날짜, 중복 행, 공백 섞인 값
const emp = [['사번', '이름', '입사일', '부서', '연락처', '기본급']];
const names = ['김가람', '이나래', '박다온', '최라희', '정마루', '한바다', '오새벽', '윤아라', '강하늘', '서보람'];
names.forEach((n, i) => {
  emp.push([String(i + 1).padStart(6, '0'), i === 3 ? '  최라희 ' : n, new Date(2018 + (i % 7), i % 12, 1 + i * 2), ['영업1팀', '영업2팀', '영업3팀', '인사팀'][i % 4], `010-${1000 + i * 37}-${2000 + i * 91}`, `${(3000000 + i * 125000).toLocaleString()}원`]);
});
emp.push(emp[2].slice());
const ws2 = XLSX.utils.aoa_to_sheet(emp, { cellDates: true });
for (let r = 1; r < emp.length; r++) { const ref = XLSX.utils.encode_cell({ r, c: 2 }); ws2[ref].z = 'yyyy-mm-dd'; }

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws1, '매출');
XLSX.utils.book_append_sheet(wb, ws2, '직원');
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), '메모');
fs.writeFileSync(path.join(out, '가짜_매출_직원.xlsx'), XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));

// 템플릿: 원하는 머리글만
const tpl = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(tpl, XLSX.utils.aoa_to_sheet([['부서명', '담당', '시/도', '상반기 매출', '비고']]), '양식');
fs.writeFileSync(path.join(out, '가짜_템플릿.xlsx'), XLSX.write(tpl, { bookType: 'xlsx', type: 'buffer' }));

// CP949 CSV (엑셀에서 저장한 한글 CSV 흉내). 인코딩은 python으로 변환
const csv = emp.map((r) => r.map((v) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : `"${String(v).replace(/"/g, '""')}"`)).join(',')).join('\r\n');
fs.writeFileSync(path.join(out, '가짜_직원_utf8.csv'), csv, 'utf8');
console.log('samples ->', out);
