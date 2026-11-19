// 결과 표 선택·복사, JSON 내려받기 확인
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HTML = 'file://' + path.join(__dirname, '../data-shaper.html');
const SAMPLE = path.join(__dirname, 'samples');
const SHOTS = path.join(__dirname, 'shots');
const file = (p) => ({ name: path.basename(p), mimeType: 'application/octet-stream', buffer: fs.readFileSync(p) });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await ctx.newPage();
  const errors = [], net = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (!/^(file|blob|data):/.test(r.url())) net.push(r.url()); });
  await page.goto(HTML);
  await page.setInputFiles('#fileIn', file(`${SAMPLE}/가짜_매출_직원.xlsx`));
  await page.waitForSelector('table.grid');
  await page.selectOption('#sheetSel', '직원');
  await page.waitForTimeout(200);
  const clip = () => page.evaluate(() => navigator.clipboard.readText());

  // 셀 드래그: 1~3행, 이름~부서
  const cell = (r, c) => `table.grid tbody tr:nth-child(${r}) td:nth-child(${c + 1})`;
  await page.hover(cell(1, 2)); await page.mouse.down();
  await page.hover(cell(2, 3)); await page.hover(cell(3, 4)); await page.mouse.up();
  console.log('선택', await page.textContent('.sel-cnt'), '칸', await page.$$eval('td.sel', (x) => x.length));
  await page.screenshot({ path: `${SHOTS}/7-select.png` });

  for (const label of ['엑셀용', 'JS 객체 배열', 'JSON', 'JS 2차원 배열']) {
    await page.click(`#selBar button:has-text("${label}")`);
    await page.waitForTimeout(100);
    console.log(`--- ${label}\n${await clip()}`);
  }

  // 머리글 클릭 → 열 전체, 목록 복사
  await page.click('th.fh[data-col="4"]');
  await page.keyboard.press('Escape');
  console.log('열 선택', await page.textContent('.sel-cnt'));
  await page.click('#selBar button:has-text("목록 (쉼표)")');
  await page.waitForTimeout(100);
  console.log('--- 목록 (쉼표)\n' + (await clip()));

  // Ctrl+A → Ctrl+C
  await page.click(cell(1, 1));
  await page.keyboard.press('Control+a');
  console.log('전체', await page.textContent('.sel-cnt'));
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(100);
  console.log('Ctrl+C 첫 두 줄', JSON.stringify((await clip()).split('\r\n').slice(0, 2)));

  // JSON 내려받기
  await page.selectOption('#outFmt', 'json');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnDown')]);
  const data = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  console.log('JSON 파일', data.length, '행', JSON.stringify(data[0]));

  console.log(errors.length ? `페이지 오류: ${errors.join(' | ')}` : '페이지 오류 없음');
  console.log(net.length ? `외부 요청: ${net.join(', ')}` : '외부 네트워크 요청 0건');
  await browser.close();
})();
