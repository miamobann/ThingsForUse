// node --test spending-analyzer/test  (가짜 데이터만 사용)
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/core.js');

const stmt = (rows) => `<table><tr><td>2026년 10월 이용대금명세서</td></tr><tr><th>이용일</th><th>이용카드</th><th>이용가맹점</th><th>이용금액</th><th>할부/회차</th></tr>
${rows.map(([d, s, a, i]) => `<tr><td>${d}</td><td>본인</td><td>${s}</td   ><td>${a}</td><td>${i || ''}</td></tr>`).join('')}
<tr><td>-</td><td></td><td>일 시 불 소계 3 건</td><td>0</td></tr></table>`;
const rt = (rows) => `<table><tr><td>실시간 이용내역</td></tr><tr><th>승인일</th><th>승인시각</th><th>카드구분</th><th>카드종류</th><th>가맹점명</th><th>승인금액</th><th>이용구분</th><th>할부개월</th><th>승인번호</th><th>취소일</th><th>승인구분</th></tr>
${rows.map(([d, t, s, a, n, c]) => `<tr><td>${d}</td><td>${t}</td><td>본인</td><td>5***</td><td>${s}</td><td>${a}</td><td>일시불</td><td>0</td><td>${n}</td><td>${c || '-'}</td><td>${c ? '취소' : '승인'}</td></tr>`).join('')}</table>`;
const csv = (rows) => '﻿id,날짜,시각,금액,가게명,원래가게명,카테고리,결제수단,할부,송금여부,지출포함여부,취소됨,메모,출처\n' +
  rows.map((r) => r.join(',')).join('\n');

test('현대카드 명세서: 해외, 버스 합산, 소계 줄 건너뛰기', () => {
  const f = C.parseFile('a.xls', stmt([['2026년 09월 01일', '네이버파이낸셜', '4,900'], ['2026년 09월 10일', 'OPENAI,USD:5.50', '7,579'], ['2026년 09월 30일', '09월경기시내버스          0039건', '105,650']]));
  assert.equal(f.kind, '현대카드 명세서');
  assert.equal(f.rows.length, 3);
  assert.equal(f.rows[1].store, 'OPENAI');
  assert.match(f.rows[1].memo, /USD 5.50/);
  assert.equal(f.rows[2].store, '경기시내버스');
});

test('명세서와 실시간 내역이 겹치면 실시간 하나로, 이름이 달라도 같은 날·같은 금액이면 합침', () => {
  const s = C.parseFile('s.xls', stmt([['2026년 10월 30일', '택시-경기 65 바 6509', '11,700'], ['2026년 10월 26일', 'OPENAI,USD:10.00', '14,900']]));
  const r = C.parseFile('r.xls', rt([['2026년 10월 30일', '01:18', '카카오T일반택시_0', '11,700', '111'], ['2026년 10월 25일', '11:39', 'OPENAI', '14,698', '222'], ['2026년 10월 30일', '01:07', '카카오T택시_가승인', '11,900', '333', '2026년 10월 30일']]));
  const { rows, report } = C.combine([s, r]);
  assert.equal(rows.length, 3);
  assert.equal(report.stmtRtMerged, 2);
  const ai = rows.find((x) => x.store === 'OPENAI');
  assert.equal(ai.amount, 14900); // 청구액
  assert.equal(rows.find((x) => /가승인/.test(x.store)).include, false);
});

test('네이버페이 내역과 카드 결제 짝짓기: 네이버, PG 경유, 배송비, 포인트', () => {
  const card = C.parseFile('s.xls', stmt([
    ['2026년 05월 01일', '네이버파이낸셜', '4,900'],
    ['2026년 05월 02일', '(주)이니시스 - 주식회사 팬딩', '50,000'],
    ['2026년 05월 03일', '네이버페이', '8,200'],
    ['2026년 05월 04일', '네이버페이', '7,000'],
  ]));
  const np = C.parseFile('np.csv', csv([
    ['n1', '2026-05-01', '09:30', '4900', 'CHZZK', 'CHZZK', '', '네이버페이', '', 'N', 'Y', 'N', 'A 1개월 정기구독 / 상태:결제완료', '네이버페이내역'],
    ['n2', '2026-05-02', '12:00', '50000', '스텔라이브', '케이지이니시스', '', '네이버페이', '', 'N', 'Y', 'N', '스토어', '네이버페이내역'],
    ['n3', '2026-05-03', '10:00', '5200', '문구점', '문구점', '', '네이버페이', '', 'N', 'Y', 'N', '바인더', '네이버페이내역'],
    ['n4', '2026-05-04', '21:00', '11000', 'CHZZK', 'CHZZK', '', '네이버페이', '', 'N', 'Y', 'N', '치즈 충전하기', '네이버페이내역'],
    ['n5', '2026-05-05', '21:00', '3000', 'OGQ', 'OGQ', '', '네이버페이', '', 'N', 'Y', 'N', '이모티콘', '네이버페이내역'],
  ]));
  assert.equal(np.kind, '네이버페이 내역');
  const { rows, report } = C.combine([card, np]);
  assert.equal(rows.length, 5);
  assert.equal(report.naverViaPG.length, 1, JSON.stringify(report));
  assert.equal(report.naverShipping.length, 1);
  assert.equal(rows.find((x) => x.id === 'n3').amount, 8200);
  assert.equal(report.naverPointMix.length, 1);
  assert.equal(rows.find((x) => x.id === 'n4').amount, 7000);
  assert.equal(rows.find((x) => x.id === 'n5').pay, '네이버페이'); // 카드에 없음
});

test('이미 취소된 결제의 카드 환불은 두 번 빼지 않음', () => {
  const card = C.parseFile('s.xls', stmt([['2026년 06월 26일', '주식회사엑심베이 - 주식회사 한터글로벌', '24,900'], ['2026년 06월 28일', '주식회사엑심베이 - 주식회사 한터글로벌', '-24,900']]));
  const np = C.parseFile('np.csv', csv([['n1', '2026-06-26', '18:24', '24900', '엑심베이(카드)', '엑심베이(카드)', '', '네이버페이', '', 'N', 'Y', 'Y', '결제취소', '네이버페이내역']]));
  const { rows } = C.combine([card, np]);
  const total = C.sum(rows.map((r) => C.spendAmount(r)));
  assert.equal(total, 0);
});

test('분류: 가게별 기억, 결제대행사는 기억 안 함', () => {
  const r = { id: 'x', store: '스타벅스 강남점', cat: '' };
  const state = { memory: { [C.storeKey('스타벅스 강남점')]: { cat: '카페·간식', sub: '카페' } }, overrides: {} };
  assert.deepEqual(C.classify(r, state).sub, '카페');
  const a = { id: 'y', store: '토스페이먼츠', cat: '' };
  state.memory[C.storeKey('토스페이먼츠')] = { cat: '쇼핑', sub: '의류' };
  assert.equal(C.classify(a, state).cat, '');
  assert.equal(C.classify(a, { ...state, overrides: { y: { cat: '쇼핑', sub: '의류' } } }).sub, '의류');
});

test('고정 지출: 매달 같은 금액, 구독은 상품별로', () => {
  const mk = (d, s, a, memo = '') => ({ r: { id: d + s + memo, date: d, time: '', amount: a, store: s, memo }, c: { key: C.storeKey(s), agent: false, cat: '구독', sub: '' }, amt: a });
  const items = [];
  for (const m of ['01', '02', '03', '04']) {
    items.push(mk(`2026-${m}-15`, '메타', 14900));
    items.push(mk(`2026-${m}-08`, 'CHZZK', 4900, 'A 1개월 정기구독'));
    items.push(mk(`2026-${m}-20`, 'CHZZK', 4900, 'B 1개월 정기구독'));
  }
  items.push(mk('2026-02-11', '편의점', 3000), mk('2026-02-12', '편의점', 3000), mk('2026-03-11', '편의점', 3000));
  const rec = C.findRecurring(items, '2026-04-30');
  assert.equal(rec.length, 3);
  assert.ok(rec.every((r) => r.active));
});

test('할부: 첫 회차는 다음 달', () => {
  const i = C.installment({ date: '2026-08-10', amount: 1200000, inst: 6 }, '2026-10');
  assert.deepEqual([i.monthly, i.left, i.leftAmount], [200000, 4, 800000]);
});

test('실시간 내역 시작 하루 전 명세서 결제도 겹치면 합침 (마이시큐리티 10/1 ↔ 10/2)', () => {
  const s = C.parseFile('s.xls', stmt([['2026년 10월 01일', '마이시큐리티', '600']]));
  const r = C.parseFile('r.xls', rt([['2026년 10월 02일', '01:09', '마이시큐리티', '600', '777']]));
  assert.equal(C.combine([s, r]).rows.length, 1);
});

test('가계부 앱용 CSV: 합친 건은 한 줄, 원래가게명은 카드 쪽, 앱 라벨', () => {
  const r1 = { id: 'n1', date: '2026-10-03', time: '12:30:11', amount: 15000, store: '윗치폼', rawStore: '파이어볼트', cardStore: '네이버파이낸셜', pay: '현대카드(네이버페이)', matchedCard: 'c1', source: '네이버페이내역', inst: 0, transfer: false, include: true, canceled: false, memo: '굿즈, "한정"' };
  const r2 = { id: 's1', date: '2026-10-04', time: '', amount: -3000, store: '편의점', rawStore: 'GS25', pay: '현대카드', source: '카드 파일(명세서)', inst: 3, transfer: false, include: true, canceled: false, memo: '' };
  const out = C.toAppCSV([{ r: r1, cat: '여가', include: true }, { r: r2, cat: '식비', include: false }]);
  const rows = C.parseCSV(out.replace(/^﻿/, ''));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].length, 14);
  assert.deepEqual(rows[1], ['n1', '2026-10-03', '12:30', '15000', '윗치폼', '네이버파이낸셜', '여가', '현대카드', '', 'N', 'Y', 'N', '굿즈, "한정"', '네이버페이 알림']);
  assert.deepEqual(rows[2], ['s1', '2026-10-04', '', '-3000', '편의점', 'GS25', '식비', '현대카드', '3', 'N', 'N', 'N', '', '카드 파일']);
  // 다시 읽어도 같은 내용
  const back = C.parseAppCSV(out.replace(/^﻿/, '')).rows;
  assert.equal(back[0].amount, 15000); assert.equal(back[1].include, false);
});

test('분류 자료 시트: 상태 ↔ 줄, 바뀐 줄만, 앱이 쓴 건별 줄 읽기', () => {
  const st = {
    overrides: { a1: { cat: '여가', sub: '굿즈' }, a2: { exclude: true }, a3: {} },
    memory: { 스타벅스: { cat: '카페·간식', sub: '카페' } },
    rules: [{ kw: '달빛', cat: '여가', sub: '게임' }],
    tree: { 식비: ['식사'], 여가: ['게임', '굿즈'] },
    opts: { excludeTransfer: true }, dismissed: { 'x|y': 1 },
  };
  const rows = C.stateToMeta(st);
  assert.equal(rows.filter((r) => r[0] === '건별').length, 2); // 빈 건별은 안 씀
  const back = C.metaToState(rows.concat([['건별', '777', '식비', '', '']])); // 앱이 추가한 줄
  assert.deepEqual(back.overrides.a1, { cat: '여가', sub: '굿즈' });
  assert.deepEqual(back.overrides.a2, { exclude: true });
  assert.deepEqual(back.overrides['777'], { cat: '식비' });
  assert.deepEqual(Object.keys(back.tree), ['식비', '여가']);
  assert.deepEqual(back.rules, st.rules);
  assert.deepEqual(back.opts, st.opts);
  assert.deepEqual(back.dismissed, st.dismissed);
  const next = C.stateToMeta({ ...st, overrides: { a1: { cat: '쇼핑', sub: '' } } });
  const d = C.metaDiff(rows, next);
  assert.deepEqual(d.puts, [['건별', 'a1', '쇼핑', '', '']]);
  assert.deepEqual(d.dels, [['건별', 'a2']]);
});

test('백업의 건별 분류를 새 id로 옮기기 (날짜·시각·금액·가게)', () => {
  const rows = [
    { id: '101', date: '2026-10-01', amount: 5000, store: '윗치폼' },
    { id: '102', date: '2026-10-02', amount: 4900, store: 'CHZZK' },
    { id: '103', date: '2026-10-02', amount: 4900, store: 'CHZZK' },
  ];
  const m = C.remapOverrides(
    { 'naverpay-1': { cat: '여가', sub: '굿즈' }, 'naverpay-2': { cat: '여가' }, '101x': { cat: '식비' } },
    { 'naverpay-1': { date: '2026-10-01', amount: 5000, store: '윗치폼' }, 'naverpay-2': { date: '2026-10-02', amount: 4900, store: 'CHZZK' } },
    rows);
  assert.deepEqual(m.overrides['101'], { cat: '여가', sub: '굿즈' });
  assert.deepEqual(m.overrides['102'], { cat: '여가' }); // 똑같은 두 건 중 첫 건으로
  assert.equal(m.moved, 2);
  assert.equal(m.lost, 1); // 지문 없는 건은 그대로 둔다
});
