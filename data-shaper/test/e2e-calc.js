// 계산 열 수식 확인: 예시 버튼, 덮어쓰기, 미리보기, 실패 줄 표시
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HTML = 'file://' + path.join(__dirname, '../data-shaper.html');
const SAMPLE = path.join(__dirname, 'samples');
const SHOTS = path.join(__dirname, 'shots');
const file = (p) => ({ name: path.basename(p), mimeType: 'application/octet-stream', buffer: fs.readFileSync(p) });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [], net = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (!/^(file|blob|data):/.test(r.url())) net.push(r.url()); });
  await page.goto(HTML);
  await page.setInputFiles('#fileIn', file(`${SAMPLE}/가짜_매출_직원.xlsx`));
  await page.waitForSelector('table.grid');
  await page.selectOption('#sheetSel', '직원');
  await page.click('#btnAdd');
  await page.click('#addMenu >> text=계산 열');
  await page.click('.ex-row button:has-text("끝 4자리")');
  await page.waitForTimeout(300);
  const state = () => page.evaluate(() => {
    const st = cur().steps.at(-1);
    return { expr: st.expr, name: st.name, target: st.target, cols: S.out.cols, first: S.out.rows[0], pv: document.querySelector('.calc-pv').innerText.split('\n'), warn: document.querySelector('.step-warn:not([hidden])')?.textContent || '' };
  });
  console.log('끝 4자리', JSON.stringify(await state()));
  await page.screenshot({ path: `${SHOTS}/8-calc.png` });

  await page.click('.ex-row button:has-text("하이픈 빼기")');
  await page.waitForTimeout(300);
  console.log('하이픈 빼기', JSON.stringify(await state()));

  // 직접 입력 + 실패 줄
  await page.selectOption('.step-b select >> nth=0', '');
  await page.fill('[data-calcexpr]', 'VALUE([이름])');
  await page.waitForTimeout(400);
  console.log('실패', JSON.stringify(await state()));

  // 식 오류
  await page.fill('[data-calcexpr]', 'RIGHT([연락처]');
  await page.waitForTimeout(400);
  console.log('식 오류', await page.evaluate(() => document.querySelector('.step-msg:not([hidden])')?.textContent));

  // 예전 규칙 호환
  await page.evaluate(() => { const st = cur().steps.at(-1); st.expr = '[기본급] * 2'; st.name = '두배'; delete st.target; refresh(true); });
  console.log('예전 식', JSON.stringify(await page.evaluate(() => [S.out.cols.at(-1), S.out.rows[0].at(-1)])));

  console.log(errors.length ? `페이지 오류: ${errors.join(' | ')}` : '페이지 오류 없음');
  console.log(net.length ? `외부 요청: ${net.join(', ')}` : '외부 네트워크 요청 0건');
  await browser.close();
})();
