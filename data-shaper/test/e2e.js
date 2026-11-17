// 브라우저 동작 확인 + 네트워크 요청 감시
// 실행: node test/e2e.js  (playwright 필요)
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
// 한글 경로는 setInputFiles가 못 읽어서 버퍼로 넘김
const file = (p) => ({ name: path.basename(p), mimeType: 'application/octet-stream', buffer: fs.readFileSync(p) });

const HTML = 'file://' + path.join(__dirname, '../data-shaper.html');
const SAMPLE = path.join(__dirname, 'samples');
const SHOT = process.env.SHOT_DIR || path.join(__dirname, 'shots');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const net = [];
  page.on('request', (r) => { const u = r.url(); if (!u.startsWith('file:') && !u.startsWith('blob:') && !u.startsWith('data:')) net.push(u); });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(HTML);
  await page.screenshot({ path: `${SHOT}/0-start.png` });
  await page.setInputFiles('#fileIn', file(`${SAMPLE}/가짜_매출_직원.xlsx`));
  await page.waitForSelector('table.grid');
  const st = await page.evaluate(() => ({ sheet: S.sheet, read: cur().read, cols: S.base.cols, rows: S.base.rows.length, flagged: S.base.flagged }));
  console.log('매출 시트', JSON.stringify(st));
  await page.screenshot({ path: `${SHOT}/1-result.png` });
  await page.click('.tab[data-view=raw]');
  await page.screenshot({ path: `${SHOT}/2-raw.png` });
  await page.click('.tab[data-view=result]');

  // 단계: 열 나누기 → 계산 열 → 집계 → 정렬
  await page.evaluate(() => {
    const sh = cur();
    sh.steps.push({ type: 'split', on: true, open: false, col: '지역', sep: '/', names: '시도,구', drop: true });
    sh.steps.push({ type: 'calc', on: true, open: false, name: '상반기 매출', expr: '[1분기_매출] + [2분기_매출]' });
    sh.steps.push({ type: 'filter', on: true, open: false, mode: 'and', conds: [{ col: '시도', op: 'in', val: '서울, 경기' }] });
    sh.steps.push({ type: 'group', on: true, open: true, by: ['부서'], aggs: [{ col: '상반기 매출', fn: 'sum', name: '' }, { col: '', fn: 'rows', name: '인원' }] });
    sh.steps.push({ type: 'sort', on: true, open: false, keys: [{ col: '상반기 매출_합계', dir: 'desc' }] });
    refresh(true);
  });
  const r1 = await page.evaluate(() => ({ out: S.out, info: S.stepInfo.map((x) => ({ e: x.error, w: x.warn, r: x.rows })) }));
  console.log('가공 결과', JSON.stringify(r1));
  await page.screenshot({ path: `${SHOT}/3-steps.png` });

  // 피벗: 행=부서, 열=시도, 값=상반기 매출 합계
  await page.evaluate(() => {
    const sh = cur(); sh.steps.splice(3);
    sh.steps.push({ type: 'pivot', on: true, open: true, rows: ['부서'], col: '시도', val: '상반기 매출', fn: 'sum', totals: true, zero: false });
    sh.steps[2].on = false; refresh(true);
  });
  console.log('피벗', JSON.stringify(await page.evaluate(() => ({ out: S.out, info: S.stepInfo.at(-1) }))));
  await page.screenshot({ path: `${SHOT}/3b-pivot.png` });
  {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnDown')]);
    await dl.saveAs(`${SHOT}/pivot.xlsx`);
  }
  await page.evaluate(() => { cur().steps.pop(); cur().steps[2].on = true; refresh(true); });

  // 부분합: 부서별 상반기 매출 합계 + 총합계, 엑셀 접기 그룹
  await page.evaluate(() => {
    const sh = cur(); sh.steps.splice(3);
    sh.steps.push({ type: 'subtotal', on: true, open: true, by: '부서', vals: [{ col: '상반기 매출', fn: 'sum' }, { col: '', fn: 'rows' }], sort: true, grand: true, label: '소계' });
    sh.steps[2].on = false; refresh(true);
  });
  console.log('부분합', JSON.stringify(await page.evaluate(() => ({ rows: S.out.rows.map((r) => [r.kind || '', r[0], r[1], r[9]]), info: S.stepInfo.at(-1) }))));
  await page.screenshot({ path: `${SHOT}/3c-subtotal.png` });
  {
    await page.selectOption('#outFmt', 'xlsx');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnDown')]);
    await dl.saveAs(`${SHOT}/subtotal.xlsx`);
  }
  await page.evaluate(() => { cur().steps.pop(); cur().steps[2].on = true; refresh(true); });

  // 템플릿: 집계 끄고 템플릿 연결
  await page.evaluate(() => { cur().steps.splice(3); refresh(true); });
  await page.setInputFiles('#tplIn', file(`${SAMPLE}/가짜_템플릿.xlsx`));
  await page.waitForTimeout(300);
  const r2 = await page.evaluate(() => ({ tpl: cur().steps.at(-1).targets, cols: S.out.cols, first: S.out.rows[0] }));
  console.log('템플릿', JSON.stringify(r2));
  await page.screenshot({ path: `${SHOT}/4-template.png` });

  // 내려받기 xlsx·csv
  for (const fmt of ['xlsx', 'csv']) {
    await page.selectOption('#outFmt', fmt);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnDown')]);
    const p = `${SHOT}/out.${fmt}`; await dl.saveAs(p); console.log('내려받음', dl.suggestedFilename());
  }
  // 규칙: 이름 붙여 저장 → 내보내기 → 저장소 비우기 → 가져오기 → 목록에서 적용
  await page.fill('#ruleName', '월간 매출');
  await page.click('#btnSaveRule');
  const [rd] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  await rd.saveAs(`${SHOT}/rules.json`);
  await page.evaluate(() => { localStorage.clear(); renderRules(); cur().steps = []; refresh(true); });
  console.log('비운 뒤 목록', await page.locator('.rule-item').count());
  await page.setInputFiles('#ruleIn', file(`${SHOT}/rules.json`));
  await page.waitForTimeout(200);
  console.log('가져온 뒤 목록', await page.locator('.rule-item').count());
  await page.click('.rule-item .btn:has-text("적용")');
  console.log('규칙 적용 단계 수', await page.evaluate(() => cur().steps.length), '열', await page.evaluate(() => S.out.cols.join('|')));
  await page.screenshot({ path: `${SHOT}/3d-rules.png` });

  // 직원 시트: 날짜·앞자리 0·값 바꾸기·중복 제거
  await page.click('.chip:has-text("직원")');
  await page.evaluate(() => {
    const sh = cur();
    sh.steps.push({ type: 'values', on: true, open: false, cols: ['이름'], action: 'trim', fmt: 'YYYY-MM-DD', find: '', to: '', whole: true, fill: 'above', fillVal: '' });
    sh.steps.push({ type: 'values', on: true, open: false, cols: ['기본급'], action: 'number', fmt: 'YYYY-MM-DD', find: '', to: '', whole: true, fill: 'above', fillVal: '' });
    sh.steps.push({ type: 'dedupe', on: true, open: false, cols: [], keep: 'first' });
    sh.steps.push({ type: 'values', on: true, open: true, cols: ['입사일'], action: 'date', fmt: 'YYYY.MM.DD', find: '', to: '', whole: true, fill: 'above', fillVal: '' });
    refresh(true);
  });
  console.log('직원', JSON.stringify(await page.evaluate(() => ({ read: cur().read, cols: S.out.cols, n: S.out.rows.length, r: S.out.rows.slice(0, 4), info: S.stepInfo.map((x) => x.error || x.warn) }))));
  await page.screenshot({ path: `${SHOT}/5-emp.png` });

  // 열 정리: 손잡이 끌어서 순서 바꾸기 (4번째 열을 맨 위로)
  await page.evaluate(() => { const sh = cur(); sh.steps = []; refresh(true); addStep('columns'); });
  const handles = page.locator('.col-item .drag');
  const b3 = await handles.nth(3).boundingBox(), b0 = await handles.nth(0).boundingBox();
  await page.mouse.move(b3.x + b3.width / 2, b3.y + b3.height / 2);
  await page.mouse.down();
  await page.mouse.move(b0.x + 5, b0.y + 2, { steps: 8 });
  await page.screenshot({ path: `${SHOT}/7-drag.png` });
  await page.mouse.up();
  console.log('끌기 후 열 순서', await page.evaluate(() => S.out.cols.join('|')));

  // CP949 CSV
  await page.setInputFiles('#fileIn', file(`${SAMPLE}/가짜_직원_cp949.csv`));
  await page.waitForTimeout(300);
  console.log('CSV', JSON.stringify(await page.evaluate(() => ({ cols: S.base.cols, r: S.base.rows.slice(0, 2) }))));

  // 다크 모드
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setInputFiles('#fileIn', file(`${SAMPLE}/가짜_매출_직원.xlsx`));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOT}/6-dark.png` });
  console.log('다크 select 색', await page.evaluate(() => { const o = document.querySelector('#outFmt option'); const cs = getComputedStyle(o); return [cs.color, cs.backgroundColor, getComputedStyle(document.documentElement).colorScheme]; }));

  console.log('페이지 오류', errors.length ? errors : '없음');
  console.log('외부 네트워크 요청', net.length ? net : '0건');
  await browser.close();
  if (net.length || errors.length) process.exit(1);
})();
