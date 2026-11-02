// 네이버페이 결제내역 구조 확인 스크립트 (1단계)
// - 결제내역 페이지가 불러오는 데이터의 "모양"만 뽑아요.
// - 글자는 ㄱ/a, 숫자는 9로 가려서 실제 가게명·금액·날짜는 나가지 않아요.
// - 쿠키·헤더·로그인 정보는 읽지 않아요.
// 사용법: 크롬에서 네이버페이 결제내역 페이지 → F12 → Console 탭에 전체 붙여넣고 Enter.
(async () => {
  const MAX_CLICKS = 15;          // "더보기"를 몇 번까지 누를지
  const captured = [];            // { method, url, body, json }

  // 1) 글자·숫자 가리기
  const mask = (s) =>
    String(s)
      .replace(/[가-힣]/g, 'ㄱ')
      .replace(/[A-Za-z]/g, 'a')
      .replace(/[0-9]/g, '9')
      .slice(0, 40);

  const maskUrl = (u) => {
    try {
      const url = new URL(u, location.href);
      const q = [...url.searchParams].map(([k, v]) => `${k}=${mask(v)}`).join('&');
      return url.origin + url.pathname.replace(/\d{4,}/g, (m) => '9'.repeat(m.length)) + (q ? '?' + q : '');
    } catch { return mask(u); }
  };

  // 2) JSON 모양 요약: 키 경로 → 가린 예시값
  const shape = (v, depth = 0) => {
    if (depth > 8) return '…';
    if (Array.isArray(v)) {
      if (!v.length) return [];
      // 배열은 최대 3개 원소의 키를 합쳐서 보여줌
      const merged = {};
      for (const item of v.slice(0, 3)) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          for (const [k, x] of Object.entries(item)) if (!(k in merged)) merged[k] = shape(x, depth + 1);
        } else return [shape(item, depth + 1), `(${v.length}개)`];
      }
      return [merged, `(${v.length}개)`];
    }
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = shape(x, depth + 1);
      return o;
    }
    if (typeof v === 'string') return mask(v);
    if (typeof v === 'number') return 'num:' + mask(v);
    return v; // true/false/null
  };

  // 3) 앞으로 오는 요청 가로채기 (fetch + XHR)
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input.url;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('json')) {
        const json = await res.clone().json();
        captured.push({ method: (init && init.method) || 'GET', url, body: init && init.body, json });
      }
    } catch {}
    return res;
  };
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__np = { method: m, url: u }; return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener('load', () => {
      try {
        const json = JSON.parse(this.responseText);
        captured.push({ ...this.__np, body, json });
      } catch {}
    });
    return origSend.apply(this, arguments);
  };

  // 4) 이미 불러온 요청 주소 목록 (같은 사이트의 데이터 요청만 다시 받아봄)
  const already = performance.getEntriesByType('resource')
    .filter((e) => ['fetch', 'xmlhttprequest'].includes(e.initiatorType))
    .map((e) => e.name);
  for (const u of [...new Set(already)]) {
    try {
      if (new URL(u).hostname.endsWith('naver.com')) await window.fetch(u, { credentials: 'include' });
    } catch {}
  }

  // 5) "더보기" 누르고 스크롤해서 다음 페이지 요청이 나오게 함
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < MAX_CLICKS; i++) {
    const btn = [...document.querySelectorAll('button, a')].find(
      (b) => /더보기|더 보기/.test(b.textContent) && b.offsetParent !== null
    );
    window.scrollTo(0, document.body.scrollHeight);
    if (btn) btn.click();
    await sleep(1200);
    if (!btn && i > 2) break;
  }

  // 6) 결과 정리
  const report = {
    page: maskUrl(location.href),
    title: document.title,
    previousRequests: [...new Set(already.map(maskUrl))],
    responses: captured.map((c) => ({
      method: c.method,
      url: maskUrl(c.url),
      requestBody: c.body && typeof c.body === 'string' ? shape(safeParse(c.body)) : undefined,
      shape: shape(c.json),
    })),
  };
  function safeParse(s) { try { return JSON.parse(s); } catch { return mask(s); } }

  const text = JSON.stringify(report, null, 1);
  window.fetch = origFetch;
  XMLHttpRequest.prototype.open = origOpen;
  XMLHttpRequest.prototype.send = origSend;

  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '네이버페이_구조.txt';
  a.click();
  console.log(`%c완료: 응답 ${captured.length}개. '네이버페이_구조.txt'가 다운로드됐어요. 이 파일을 Claude에게 보내주세요.`, 'color:green;font-weight:bold');
})();
