// 새로고침 복원 확인: 같은 탭 새로고침은 복원, 새 탭은 복원 안 함, 닫기 누르면 지움
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HTML = 'file://' + path.join(__dirname, '../data-shaper.html');
const SAMPLE = path.join(__dirname, 'samples');
const file = (p) => ({ name: path.basename(p), mimeType: 'application/octet-stream', buffer: fs.readFileSync(p) });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [], net = [];
  const watch = (p) => { p.on('pageerror', (e) => errors.push(e.message)); p.on('request', (r) => { if (!/^(file|blob|data):/.test(r.url())) net.push(r.url()); }); };
  watch(page);
  await page.goto(HTML);
  await page.setInputFiles('#fileIn', file(`${SAMPLE}/가짜_매출_직원.xlsx`));
  await page.waitForSelector('table.grid');
  await page.selectOption('#sheetSel', '직원');
  await page.evaluate(() => {
    cur().steps.push({ type: 'sort', on: true, open: false, keys: [{ col: '기본급', dir: 'desc' }] });
    cur().fmt.cols['이름'] = { bold: true };
    refresh(true);
  });
  await page.click('.tab[data-view=raw]');
  await page.waitForTimeout(700);
  await page.reload();
  await page.waitForTimeout(1200);
  console.log('새로고침 후', JSON.stringify(await page.evaluate(() => ({ file: S.fileName, sheet: S.sheet, view: S.view, steps: S.wb && cur().steps.map((s) => s.type), fmt: S.wb && cur().fmt.cols, toast: $('toast').textContent }))));

  const tab2 = await ctx.newPage(); watch(tab2);
  await tab2.goto(HTML);
  await tab2.waitForTimeout(800);
  console.log('새 탭', await tab2.evaluate(() => S.fileName || '(빈 화면)'));
  await tab2.close();

  await page.click('button:has-text("닫기")');
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForTimeout(800);
  console.log('닫기 후 새로고침', await page.evaluate(() => S.fileName || '(빈 화면)'));
  console.log('페이지 오류', errors.length ? errors : '없음');
  console.log('외부 네트워크 요청', net.length ? net : '0건');
  await browser.close();
  if (errors.length || net.length) process.exit(1);
})();
