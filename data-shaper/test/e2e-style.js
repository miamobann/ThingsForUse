// 서식 유지 확인: 원본 서식 → 가공 → 엑셀, 템플릿 서식, 부분합 접기
// 실행: python3 test/make-styled-sample.py && node test/e2e-style.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HTML = 'file://' + path.join(__dirname, '../data-shaper.html');
const SAMPLE = path.join(__dirname, 'samples');
const SHOT = process.env.SHOT_DIR || path.join(__dirname, 'shots');
const file = (p) => ({ name: path.basename(p), mimeType: 'application/octet-stream', buffer: fs.readFileSync(p) });

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } })).newPage();
  const net = [], errors = [];
  page.on('request', (r) => { const u = r.url(); if (!/^(file|blob|data):/.test(u)) net.push(u); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(HTML);
  await page.setInputFiles('#fileIn', file(`${SAMPLE}/가짜_서식있는_거래.xlsx`));
  await page.waitForSelector('table.grid');
  console.log('읽기', JSON.stringify(await page.evaluate(() => ({ read: cur().read, cols: S.base.cols, styles: S.hasStyles }))));
  const save = async (n) => { const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnDown')]); await dl.saveAs(`${SHOT}/${n}`); };

  // 1) 열 순서 바꾸고 계산 열 추가
  await page.evaluate(() => {
    const sh = cur();
    sh.steps.push({ type: 'calc', on: true, open: false, name: '부가세', expr: 'ROUND([금액] * 0.1)' });
    sh.steps.push({ type: 'columns', on: true, open: false, items: ['거래처', '거래일', '품목', '금액', '부가세', '비고', '수량', '단가'].map((c) => ({ src: c, name: c === '거래처' ? '업체명' : c, keep: !['수량', '단가'].includes(c) })) });
    refresh(true);
  });
  await save('style-1.xlsx');
  // 2) 부분합
  await page.evaluate(() => { cur().steps.push({ type: 'subtotal', on: true, open: false, by: '업체명', vals: [{ col: '금액', fn: 'sum' }], sort: true, grand: true, label: '소계' }); refresh(true); });
  await save('style-2.xlsx');
  // 3) 템플릿 서식
  await page.evaluate(() => { cur().steps.pop(); refresh(true); });
  await page.setInputFiles('#tplIn', file(`${SAMPLE}/가짜_서식_템플릿.xlsx`));
  await page.waitForTimeout(400);
  console.log('템플릿', JSON.stringify(await page.evaluate(() => cur().steps.at(-1).targets.map((x) => `${x.name}←${x.src}`))));
  await save('style-3.xlsx');
  // 4) 집계: 합계 열은 숫자 형식만 이어받음
  await page.evaluate(() => { const sh = cur(); sh.steps.pop(); sh.steps.push({ type: 'group', on: true, open: false, by: ['업체명'], aggs: [{ col: '금액', fn: 'sum', name: '' }, { col: '', fn: 'rows', name: '건수' }] }); refresh(true); });
  await save('style-4.xlsx');
  console.log('페이지 오류', errors.length ? errors : '없음');
  console.log('외부 네트워크 요청', net.length ? net : '0건');
  await browser.close();
  if (net.length || errors.length) process.exit(1);
})();
