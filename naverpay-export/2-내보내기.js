// 네이버페이 결제내역 내보내기 (2단계)
// - 결제내역 페이지(pay.naver.com/pc/history)가 쓰는 데이터를 1쪽부터 끝까지 읽어서 CSV로 저장해요.
// - 로그인은 지금 브라우저에 된 것을 그대로 쓰고, 데이터는 Min의 PC에만 저장돼요.
// 사용법: 크롬에서 https://pay.naver.com/pc/history 열기 → F12 → Console에 전체 붙여넣고 Enter.
(async () => {
  const FROM = '2025-01-01';   // 이 날짜부터 받아요 (바꿔도 돼요)
  const SAVE_RAW = true;       // 원본 데이터(JSON)도 같이 저장할지

  const log = (msg, color = '#2a7') => console.log(`%c[네이버페이] ${msg}`, `color:${color};font-weight:bold`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fromMs = new Date(FROM + 'T00:00:00+09:00').getTime();

  if (!location.hostname.endsWith('pay.naver.com') || !window.__NEXT_DATA__) {
    log('pay.naver.com/pc/history 페이지에서 실행해 주세요.', 'red');
    return;
  }
  const buildId = window.__NEXT_DATA__.buildId;

  // 페이지 데이터 안에서 결제 목록(items 배열이 있는 pages)을 찾음
  const findList = (json) => {
    const queries = json?.pageProps?.dehydratedState?.queries || [];
    for (const q of queries) {
      const pages = q?.state?.data?.pages;
      if (Array.isArray(pages) && pages.some((p) => Array.isArray(p?.items))) return pages;
    }
    return null;
  };

  const all = new Map();
  let totalPage = Infinity;
  let olderStreak = 0;
  for (let page = 1; page <= totalPage; page++) {
    let json;
    for (let tryNo = 0; tryNo < 3; tryNo++) {
      try {
        const res = await fetch(`/_next/data/${buildId}/pc/history.json?page=${page}`, { credentials: 'include' });
        if (!res.ok) throw new Error(res.status);
        json = await res.json();
        break;
      } catch (e) {
        if (tryNo === 2) { log(`${page}쪽을 못 받았어요 (${e.message}). 여기까지 저장할게요.`, 'red'); }
        await sleep(1500);
      }
    }
    if (!json) break;
    const pages = findList(json);
    if (!pages) { log(`${page}쪽에서 결제 목록을 못 찾았어요. 여기까지 저장할게요.`, 'red'); break; }

    let newOnPage = 0, inRange = 0;
    for (const p of pages) {
      if (p.totalPage) totalPage = p.totalPage;
      for (const it of p.items || []) {
        if (it.date >= fromMs) inRange++;
        if (!all.has(it._id)) { all.set(it._id, it); newOnPage++; }
      }
    }
    log(`${page}/${totalPage === Infinity ? '?' : totalPage}쪽 · 누적 ${all.size}건`);
    // 최신순이라 FROM보다 오래된 쪽이 두 번 연속 나오면 멈춤
    olderStreak = inRange === 0 ? olderStreak + 1 : 0;
    if (olderStreak >= 2) break;
    if (newOnPage === 0 && page > 1) break; // 같은 내용만 반복되면 끝
    await sleep(400); // 서버에 무리 주지 않게 천천히
  }

  // ---- CSV 만들기 (가계부 앱·분석 프로그램과 같은 열) ----
  const pad = (n) => String(n).padStart(2, '0');
  const kst = (ms) => {
    const d = new Date(ms + 9 * 3600 * 1000);
    return {
      date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
      time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    };
  };
  const num = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    const s = String(v).replace(/[^0-9-]/g, '');
    return s ? Number(s) : null;
  };
  const txt = (v) => (v == null ? '' : typeof v === 'object' ? (v.text ?? v.name ?? JSON.stringify(v)) : String(v));
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = ['id', '날짜', '시각', '금액', '가게명', '원래가게명', '카테고리', '결제수단', '할부', '송금여부', '지출포함여부', '취소됨', '메모', '출처'];
  const rows = [];
  const byType = {};
  const items = [...all.values()].filter((it) => it.date >= fromMs).sort((a, b) => a.date - b.date);
  for (const it of items) {
    const prod = Array.isArray(it.product) ? it.product[0] || {} : it.product || {};
    const { date, time } = kst(it.date);
    const statusText = txt(it.status?.text) || txt(it.status?.name);
    const statusAll = `${it.status?.name || ''} ${statusText}`;
    const canceled = /취소|환불|CANCEL|REFUND/i.test(statusAll) && !/부분/.test(statusAll);
    const price = num(prod.price);
    const rest = num(prod.restAmount);
    const memo = [
      txt(prod.name),
      statusText && `상태:${statusText}`,
      it.serviceType && `종류:${it.serviceType}`,
      rest != null && price != null && rest !== price ? `남은금액:${rest}` : '',
      prod.isGift === true ? '선물' : '',
    ].filter(Boolean).join(' / ');
    byType[it.serviceType] = (byType[it.serviceType] || 0) + 1;
    rows.push([
      `naverpay-${it._id}`, date, time, price ?? '', it.merchantName || '', it.merchantName || '',
      '', '네이버페이', '', 'N', 'Y', canceled ? 'Y' : 'N', memo, '네이버페이내역',
    ]);
  }

  const today = kst(Date.now()).date;
  const download = (name, text, type) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
  };
  const csv = '﻿' + [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  download(`네이버페이_결제내역_${FROM}_${today}.csv`, csv, 'text/csv;charset=utf-8');
  if (SAVE_RAW) download(`네이버페이_원본_${today}.json`, JSON.stringify(items, null, 1), 'application/json');

  log(`완료: ${FROM}부터 ${rows.length}건 저장했어요.`);
  console.table(byType);
  if (rows.length) log(`가장 오래된 건: ${rows[0][1]} · 가장 최근 건: ${rows[rows.length - 1][1]}`);
})();
