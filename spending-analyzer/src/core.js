/* 지출 분석 핵심 로직: 파일 읽기, 합치기, 분류, 분석. 브라우저와 Node(테스트) 양쪽에서 돌아간다. */
(function (root) {
  'use strict';

  // ---------- 기본 분류 (가계부 앱 기본 카테고리와 같은 이름) ----------
  const DEFAULT_TREE = {
    '식비': ['식사', '배달', '편의점', '장보기', '술'],
    '카페·간식': ['카페', '간식·디저트'],
    '교통': ['대중교통', '택시', '주차·주유', '기차·고속버스'],
    '쇼핑': ['의류', '잡화·액세서리', '생활용품', '전자기기', '도서·문구'],
    '구독': ['AI·업무', '영상·음악', '웹소설·웹툰', '멤버십', '앱·클라우드'],
    '여가': ['운동', '굿즈', '게임', '후원·팬활동', '공연·전시', '놀이·모임', '여행'],
    '생활': ['통신', '미용', '건강용품', '택배·우편', '수수료', '반려동물'],
    '의료': ['병원', '약국'],
    '송금': ['친구', '가족', '기타 송금'],
    '기타': ['선물·경조사', '기타'],
  };
  // 지출이 아닌 돈의 이동 (가계부 앱과 같은 값)
  const NOT_SPENDING_CATS = ['카드대금', '현금인출', '입금'];

  // ---------- 가게 이름 (가계부 앱 Merchants.kt 와 같은 규칙) ----------
  const PAYMENT_AGENTS = [
    '네이버파이낸셜', '네이버페이', '토스페이먼츠', '나이스정보통신', '나이스인프라', 'kcp',
    '이니시스', '다날', '세틀뱅크', '헥토파이낸셜', '한국정보통신', '섹타나인', '갤럭시아',
    '엑심베이', '한국신용카드결제', '구글페이먼트', '코페이', '주식회사카카오',
    '카카오페이', 'alipay', '한국결제네트웍스', 'kg모빌리언스', '페이레터', 'paypal',
  ];
  function displayName(raw) {
    const name = String(raw || '').trim();
    const i = name.lastIndexOf(' - ');
    return i >= 0 && i + 3 < name.length ? name.slice(i + 3).trim() : name;
  }
  function storeKey(raw) {
    let s = displayName(raw).toLowerCase();
    s = s.replace(/^\d{1,2}월/, '');
    s = s.replace(/\s*\d+건$/, '');
    s = s.replace(/,usd:[\d.]+$/, '');
    s = s.replace(/\(주\)|㈜|\( 주 \)|주식회사|유한회사|유한회$|\(유\)|_\d+$/g, '');
    s = s.replace(/[\s_.,·*()\[\]-]/g, '');
    return s;
  }
  function isAgentOnly(raw) {
    const k = storeKey(raw);
    if (!k) return true;
    return PAYMENT_AGENTS.some((a) => k.includes(a));
  }
  // 같은 결제대행사(PG)를 거쳤는지: 카드엔 "이니시스 - 팬딩", 네이버페이엔 "케이지이니시스"처럼 찍힌다
  const PG_ALIASES = [['이니시스'], ['나이스'], ['한국정보통신', 'kicc'], ['kcp'], ['토스페이먼츠'], ['엑심베이'], ['다날'], ['헥토', '세틀뱅크'], ['한국결제네트웍스'], ['kg모빌리언스']];
  function pgOf(raw) {
    const s = String(raw || '').toLowerCase().replace(/\s/g, '');
    const hit = PG_ALIASES.findIndex((al) => al.some((a) => s.includes(a)));
    return hit;
  }
  function samePG(a, b) { const x = pgOf(a); return x >= 0 && x === pgOf(b); }
  // 네이버페이 메모 "스토어 - 판매자이름의 상품명 / 상태:..." 에서 실제 판매자 이름 꺼내기
  function productName(memo) { return String(memo || '').split(' / ')[0].trim(); }
  function sellerFromMemo(memo) {
    const p = productName(memo);
    let m = /^스토어 - (.+?)의 /.exec(p); if (m) return m[1].trim();
    m = /^멤버십 - (\S+)/.exec(p); if (m) return m[1].trim();
    return '';
  }
  function similarStore(a, b) {
    const ka = storeKey(a), kb = storeKey(b);
    if (!ka || !kb) return false;
    return ka === kb || ka.includes(kb) || kb.includes(ka);
  }

  // ---------- 날짜 ----------
  const pad = (n) => String(n).padStart(2, '0');
  function dayNum(date) { // 'YYYY-MM-DD' -> 일 수
    const [y, m, d] = date.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  }
  function minutes(r) {
    if (!r.time) return null;
    const [h, m] = r.time.split(':').map(Number);
    return dayNum(r.date) * 1440 + h * 60 + m;
  }
  function addMonths(ym, n) {
    let [y, m] = ym.split('-').map(Number);
    m += n; y += Math.floor((m - 1) / 12); m = ((m - 1) % 12 + 12) % 12 + 1;
    return `${y}-${pad(m)}`;
  }
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  function weekday(date) { return (dayNum(date) + 4) % 7; } // 1970-01-01 = 목(4)

  // ---------- CSV ----------
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    const rows = []; let row = []; let f = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(f); f = ''; if (row.some((x) => x !== '')) rows.push(row); row = [];
      } else f += c;
    }
    row.push(f); if (row.some((x) => x !== '')) rows.push(row);
    return rows;
  }
  const CSV_COLS = ['id', '날짜', '시각', '금액', '가게명', '원래가게명', '카테고리', '결제수단', '할부', '송금여부', '지출포함여부', '취소됨', '메모', '출처'];
  function toInt(s) {
    const n = parseInt(String(s || '').replace(/[,\s원]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }
  function parseAppCSV(text) { return parseAppRows(parseCSV(text)); }
  /** 첫 줄이 열 이름인 2차원 배열 (CSV 또는 구글 시트 '내역') */
  function parseAppRows(rows) {
    rows = rows.map((r) => r.map((v) => String(v == null ? '' : v)));
    if (!rows.length) throw new Error('빈 파일이에요');
    const head = rows[0].map((h) => h.trim());
    const idx = {};
    CSV_COLS.forEach((c) => { idx[c] = head.indexOf(c); });
    if (idx['날짜'] < 0 || idx['금액'] < 0) throw new Error('가계부 CSV 형식이 아니에요 (날짜·금액 열이 없음)');
    const get = (r, c) => (idx[c] >= 0 ? (r[idx[c]] || '').trim() : '');
    const out = [];
    const problems = [];
    rows.slice(1).forEach((r, n) => {
      const amount = toInt(get(r, '금액'));
      const date = get(r, '날짜');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { problems.push(`${n + 2}번째 줄: 날짜를 읽지 못함`); return; }
      if (amount === null) problems.push(`${n + 2}번째 줄 (${date} ${get(r, '가게명')}): 금액이 비어 있어 0원으로 둠`);
      // 가게 칸에 결제대행사 이름만 있으면 메모의 판매자 이름을 가게로 쓴다
      let store = get(r, '가게명') || get(r, '원래가게명');
      const seller = isAgentOnly(store) ? sellerFromMemo(get(r, '메모')) : '';
      if (seller) store = seller;
      out.push({
        id: get(r, 'id') || `csv-${date}-${n}`,
        date, time: get(r, '시각'),
        amount: amount || 0,
        store,
        rawStore: get(r, '원래가게명') || get(r, '가게명'),
        cat: get(r, '카테고리'),
        pay: get(r, '결제수단'),
        inst: toInt(get(r, '할부')) || 0,
        transfer: get(r, '송금여부') === 'Y',
        include: get(r, '지출포함여부') !== 'N',
        canceled: get(r, '취소됨') === 'Y',
        memo: get(r, '메모'),
        source: get(r, '출처') || 'CSV',
      });
    });
    return { rows: out, problems };
  }

  // ---------- 현대카드 .xls (실제는 HTML 표) ----------
  function htmlText(s) {
    return String(s).replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
      .replace(/\s+/g, ' ').trim();
  }
  function htmlRows(html) {
    const rows = [];
    const trs = String(html).match(/<tr[\s\S]*?<\/tr\s*>/gi) || [];
    for (const tr of trs) {
      const cells = [];
      const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]\s*>/gi; let m;
      while ((m = re.exec(tr))) cells.push(htmlText(m[1]));
      rows.push(cells);
    }
    return rows;
  }
  const KDATE = /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/;
  function kdate(s) { const m = KDATE.exec(s || ''); return m ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : null; }

  function detectHyundai(html) {
    const t = htmlText(String(html).slice(0, 4000));
    if (/이용대금명세서/.test(t)) return 'statement';
    if (/실시간 이용내역/.test(t) || /승인번호/.test(t)) return 'realtime';
    return null;
  }

  function parseHyundaiStatement(html) {
    const t = htmlText(String(html).slice(0, 3000));
    const mm = /(\d{4})년\s*(\d{2})월\s*이용대금명세서(\(예정\))?/.exec(t);
    const label = mm ? `${mm[1]}-${mm[2]}${mm[3] ? ' 예정' : ''}` : '';
    const out = []; const seen = {};
    let overseas = false;
    for (const c of htmlRows(html)) {
      if (c.length >= 3 && /해\s*외/.test(c[2]) && /소계/.test(c[2])) continue;
      const date = kdate(c[0]);
      if (!date || c.length < 4) continue;
      let raw = c[2];
      const amount = toInt(c[3]);
      if (amount === null) continue;
      let memo = '';
      const usd = /^(.*?),\s*([A-Z]{3}):([\d.]+)$/.exec(raw);
      if (usd) { raw = usd[1].trim(); memo = `해외 ${usd[2]} ${usd[3]}`; overseas = true; }
      const bus = /^(\d{1,2})월(.+?)\s+0*(\d+)건$/.exec(raw);
      if (bus) { raw = bus[2].trim(); memo = `${bus[1]}월 ${+bus[3]}건 합산`; }
      let inst = 0;
      const im = /(\d+)\s*\/\s*(\d+)/.exec(c[4] || '');
      if (im) { inst = +im[1]; memo = (memo ? memo + ' / ' : '') + `할부 ${im[2]}회차`; }
      const base = `hd-${date}-${storeKey(raw)}-${amount}`;
      seen[base] = (seen[base] || 0) + 1;
      out.push({
        id: `${base}-${seen[base]}`, date, time: '', amount,
        store: displayName(raw), rawStore: raw, cat: '', pay: '현대카드', inst,
        transfer: false, include: !/가승인/.test(raw), canceled: false,
        memo, source: '카드 파일(명세서)',
      });
    }
    return { rows: out, label, problems: [] };
  }

  function parseHyundaiRealtime(html) {
    const out = [];
    for (const c of htmlRows(html)) {
      if (c.length < 11) continue;
      const date = kdate(c[0]);
      if (!date) continue;
      const amount = toInt(c[5]);
      if (amount === null) continue;
      const raw = c[4];
      const canceled = (c[9] && c[9] !== '-') || /취소/.test(c[10]);
      out.push({
        id: `hdrt-${c[8]}-${date}`, date, time: c[1], amount,
        store: displayName(raw), rawStore: raw, cat: '', pay: '현대카드',
        inst: toInt(c[7]) || 0, transfer: false,
        include: !/가승인/.test(raw), canceled,
        memo: /가승인/.test(raw) ? '가승인 (실제 결제가 따로 있음)' : '',
        source: '카드 파일(실시간)', approval: c[8],
      });
    }
    const dates = out.map((r) => r.date).sort();
    return { rows: out, label: dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]}` : '', problems: [] };
  }

  /** 파일 하나를 읽어 {kind, label, rows, problems} 로. key 가 같은 파일은 다시 올리면 교체된다. */
  function parseFile(name, text) {
    const head = String(text).slice(0, 4000);
    if (/<t[dr][\s>]/i.test(head) || /<table/i.test(head) || /<html/i.test(head)) {
      const kind = detectHyundai(text);
      if (kind === 'statement') {
        const p = parseHyundaiStatement(text);
        return { kind: '현대카드 명세서', key: `stmt:${p.label}`, name, ...p };
      }
      if (kind === 'realtime') {
        const p = parseHyundaiRealtime(text);
        return { kind: '현대카드 실시간 내역', key: `rt:${p.label}`, name, ...p };
      }
      throw new Error('현대카드 명세서·이용내역 형식이 아니에요');
    }
    const p = parseAppCSV(text);
    const srcs = [...new Set(p.rows.map((r) => r.source))];
    const isNaver = srcs.length === 1 && /네이버페이내역/.test(srcs[0]);
    return {
      kind: isNaver ? '네이버페이 내역' : '가계부 CSV',
      key: isNaver ? 'naverpay' : 'app',
      name, label: rangeLabel(p.rows), ...p,
    };
  }
  function rangeLabel(rows) {
    const d = rows.map((r) => r.date).sort();
    return d.length ? `${d[0]} ~ ${d[d.length - 1]}` : '';
  }

  // ---------- 여러 파일 합치기 ----------
  const isCardFile = (r) => /^카드 파일/.test(r.source);
  const isNaverpay = (r) => r.pay === '네이버페이' || /네이버페이/.test(r.source);
  const isNaverCard = (r) => r.pay === '현대카드' && /네이버/.test(r.rawStore);

  /**
   * files: [{key, rows}] → {rows, report}
   * 1) 같은 id 는 한 건 (명세서끼리 겹치는 할부 등)
   * 2) 명세서 ↔ 실시간 내역 겹치는 결제는 실시간 쪽 하나로 (시각이 있어서)
   * 3) 카드의 '네이버파이낸셜' 결제 ↔ 네이버페이 내역을 짝지어 한 건 (가게명은 네이버페이 쪽)
   */
  function combine(files) {
    const report = { sameId: 0, stmtVsRt: [], naverMatched: 0, naverPointMix: [], naverViaPG: [], naverShipping: [], naverZeroFilled: [], naverCardUnmatched: [], naverpayOnly: 0 };
    const byId = new Map();
    for (const f of files) for (const r of f.rows) {
      if (byId.has(r.id)) { report.sameId++; continue; }
      byId.set(r.id, { ...r });
    }
    let rows = [...byId.values()];

    // 2) 명세서 vs 실시간
    const rt = rows.filter((r) => r.source === '카드 파일(실시간)');
    if (rt.length) {
      const rtFrom = rt.map((r) => r.date).sort()[0];
      const used = new Set();
      const drop = new Set();
      for (const s of rows.filter((r) => r.source === '카드 파일(명세서)' && dayNum(r.date) >= dayNum(rtFrom) - 1)) {
        const cand = rt.filter((r) => !used.has(r.id) && Math.abs(dayNum(r.date) - dayNum(s.date)) <= 1 && r.amount === s.amount &&
          (similarStore(r.rawStore, s.rawStore) || (isAgentOnly(r.rawStore) && isAgentOnly(s.rawStore))));
        let hit = cand[0];
        if (!hit) { // 이름이 다르게 찍혀도(택시 등) 같은 카드·같은 날·같은 금액이 하나뿐이면 같은 결제
          const loose = rt.filter((r) => !used.has(r.id) && Math.abs(dayNum(r.date) - dayNum(s.date)) <= 1 && r.amount === s.amount);
          if (loose.length === 1) hit = loose[0];
        }
        if (!hit) { // 해외결제: 승인액과 청구액이 다름
          hit = rt.find((r) => !used.has(r.id) && similarStore(r.rawStore, s.rawStore) && Math.abs(dayNum(r.date) - dayNum(s.date)) <= 3 &&
            Math.abs(r.amount - s.amount) <= Math.max(r.amount, s.amount) * 0.1);
          if (hit) report.stmtVsRt.push({ store: s.store, date: s.date, approved: hit.amount, billed: s.amount });
          if (hit) { hit.memo = [hit.memo, `승인 ${hit.amount.toLocaleString()}원 → 청구 ${s.amount.toLocaleString()}원`].filter(Boolean).join(' / '); hit.amount = s.amount; }
        }
        if (hit) { used.add(hit.id); drop.add(s.id); }
      }
      rows = rows.filter((r) => !drop.has(r.id));
      report.stmtRtMerged = drop.size;
    }

    // 3) 카드 네이버 결제 ↔ 네이버페이 내역
    const np = rows.filter((r) => isNaverpay(r) && !isCardFile(r));
    const cards = rows.filter((r) => isCardFile(r) && isNaverCard(r));
    if (np.length && rows.some(isCardFile)) {
      const npFrom = np.map((r) => r.date).sort()[0];
      const npTo = np.map((r) => r.date).sort().slice(-1)[0];
      const used = new Set(); const drop = new Set();
      // 1차: 카드에 '네이버'로 찍힌 결제. 2차: 네이버페이로 냈지만 카드엔 PG·가게 이름으로 찍힌 결제
      const pass = (cardList, strict) => {
        const sorted = cardList.filter((c) => !drop.has(c.id)).sort((a, b) => (b.time ? 1 : 0) - (a.time ? 1 : 0));
        for (const c of sorted) {
          let best = null; let bestD = Infinity;
          for (const n of np) {
            if (used.has(n.id) || n.amount !== c.amount) continue;
            let d;
            if (c.time && n.time) { d = Math.abs(minutes(c) - minutes(n)); if (d > 10) continue; }
            else {
              d = Math.abs(dayNum(c.date) - dayNum(n.date)) * 1440; if (d > 1440) continue;
              if (strict && !(samePG(c.rawStore, n.rawStore) || similarStore(c.store, n.store) || similarStore(c.rawStore, n.rawStore))) continue;
            }
            if (d < bestD) { bestD = d; best = n; }
          }
          if (!best && c.time && !strict) { // 포인트+카드 나눠 낸 결제: 네이버페이 금액이 더 크고 몇 분 안
            for (const n of np) {
              if (used.has(n.id) || !n.time || n.amount <= c.amount) continue;
              const d = Math.abs(minutes(c) - minutes(n));
              if (d <= 3 && d < bestD) { bestD = d; best = n; }
            }
            if (best) report.naverPointMix.push({ date: best.date, store: best.store, total: best.amount, card: c.amount });
          }
          if (best) {
            used.add(best.id); drop.add(c.id);
            best.pay = '현대카드(네이버페이)';
            best.matchedCard = c.id;
            best.cardStore = c.rawStore;
            if (strict) report.naverViaPG.push({ date: best.date, store: best.store, card: c.rawStore, amount: c.amount });
            if (best.amount !== c.amount) { best.memo = [best.memo, `카드 ${c.amount.toLocaleString()}원 + 포인트 ${(best.amount - c.amount).toLocaleString()}원`].filter(Boolean).join(' / '); best.amount = c.amount; }
          }
        }
      };
      pass(cards, false);
      pass(rows.filter((r) => isCardFile(r) && !isNaverCard(r) && r.amount > 0 && r.date >= npFrom && r.date <= npTo), true);
      // 3차: 네이버페이 내역 금액엔 배송비가 빠져 있고, 한 주문이 상품별로 나뉘어 있다.
      // 카드 금액 = 같은 날 같은 가게 상품 합계 + 배송비(5천원 이하) 이면 한 주문으로 본다.
      for (const c of cards) {
        if (drop.has(c.id)) continue;
        const cand = np.filter((n) => !used.has(n.id) && !n.canceled && n.date === c.date);
        let hit = null;
        for (const [, g] of group(cand, (n) => `${n.date}|${storeKey(n.store)}`)) {
          const total = sum(g.map((n) => n.amount));
          const diff = c.amount - total;
          if (diff >= 0 && diff <= 5000 && (!hit || Math.abs(diff) < Math.abs(hit.diff))) hit = { g, diff, total };
        }
        if (!hit) continue;
        drop.add(c.id);
        hit.g.forEach((n) => { used.add(n.id); n.pay = '현대카드(네이버페이)'; n.matchedCard = c.id; n.cardStore = c.rawStore; });
        if (hit.diff > 0) {
          const first = hit.g[0];
          first.amount += hit.diff;
          first.memo = [first.memo, `배송비 등 ${hit.diff.toLocaleString()}원 포함 (카드 ${c.amount.toLocaleString()}원)`].filter(Boolean).join(' / ');
        }
        report.naverShipping.push({ date: c.date, store: hit.g[0].store, items: hit.g.length, goods: hit.total, card: c.amount });
      }
      // 4차: 시각 없는 명세서 건. 같은 날 네이버페이 쪽이 금액 0원(금액 누락)이거나 카드보다 크면(포인트 일부 사용) 짝.
      for (const c of cards) {
        if (drop.has(c.id)) continue;
        const cand = np.filter((n) => !used.has(n.id) && !n.canceled && n.date === c.date && (n.amount === 0 || n.amount > c.amount));
        if (cand.length !== 1) continue;
        const n = cand[0];
        drop.add(c.id); used.add(n.id);
        n.pay = '현대카드(네이버페이)'; n.matchedCard = c.id; n.cardStore = c.rawStore;
        if (n.amount === 0) { n.memo = [n.memo, `금액이 비어 있어 카드 금액 ${c.amount.toLocaleString()}원 사용`].filter(Boolean).join(' / '); n.amount = c.amount; report.naverZeroFilled.push({ date: n.date, store: n.store, card: c.amount }); }
        else { report.naverPointMix.push({ date: n.date, store: n.store, total: n.amount, card: c.amount }); n.memo = [n.memo, `카드 ${c.amount.toLocaleString()}원 + 포인트 ${(n.amount - c.amount).toLocaleString()}원`].filter(Boolean).join(' / '); n.amount = c.amount; }
      }
      for (const c of cards) if (!drop.has(c.id) && c.date >= npFrom && c.date <= npTo) report.naverCardUnmatched.push(c);
      rows = rows.filter((r) => !drop.has(r.id));
      report.naverMatched = drop.size;
      report.naverpayOnly = np.filter((n) => !used.has(n.id)).length;
    }
    // 4) 카드 환불(음수)인데 원래 결제가 이미 '취소됨'으로 처리돼 있으면 두 번 빼지 않게 환불 줄은 지출에서 제외
    report.refundOfCanceled = [];
    for (const r of rows) {
      if (r.amount >= 0 || !r.include) continue;
      const orig = rows.find((x) => x.canceled && x.amount === -r.amount && dayNum(r.date) - dayNum(x.date) >= 0 && dayNum(r.date) - dayNum(x.date) <= 31 &&
        (similarStore(x.rawStore, r.rawStore) || samePG(x.rawStore, r.rawStore) || (x.cardStore && similarStore(x.cardStore, r.rawStore)) || pgOf(x.store) >= 0 && pgOf(x.store) === pgOf(r.rawStore)));
      if (orig) {
        r.include = false;
        r.memo = [r.memo, '원래 결제가 이미 취소로 처리돼 있어 환불 줄은 지출에서 뺌'].filter(Boolean).join(' / ');
        report.refundOfCanceled.push({ date: r.date, store: r.store, amount: r.amount });
      }
    }
    rows.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    return { rows, report };
  }

  // ---------- 분류 ----------
  /**
   * state: {memory: {storeKey: {cat, sub}}, overrides: {id: {cat, sub}}}
   * 결제대행사 이름만 있는 가게는 기억하지 않고 건별(overrides)로만.
   */
  function classify(r, state) {
    const ov = state.overrides[r.id];
    const agent = isAgentOnly(r.store);
    const k = storeKey(r.store);
    let mem = agent ? null : state.memory[k];
    if (!mem && agent) { const sk = storeKey(sellerFromMemo(r.memo)); if (sk) mem = state.memory[sk] || null; }
    // 단어 규칙: 가게·메모(상품명)에 그 단어가 들어 있으면 (기억·건별 분류가 없을 때만)
    const rule = !mem && !(ov && ov.cat) ? matchRule(r, state.rules) : null;
    const src = mem || rule;
    let cat = (ov && ov.cat) || r.cat || (src && src.cat) || '';
    let sub = '';
    if (ov && ov.sub && (!ov.cat || ov.cat === cat)) sub = ov.sub;
    else if (src && src.sub && src.cat === cat) sub = src.sub;
    return { cat, sub, agent, key: k, byRule: !!(rule && !(ov && ov.cat)) };
  }

  function matchRule(r, rules) {
    if (!rules || !rules.length) return null;
    const text = `${r.store} ${productName(r.memo)}`.toLowerCase().replace(/\s/g, '');
    return rules.find((x) => x.kw && text.includes(String(x.kw).toLowerCase().replace(/\s/g, ''))) || null;
  }

  /** 합계에 넣을 금액. 취소·지출 아님·지출 제외는 0. 송금 제외 옵션. */
  function spendAmount(r, opts) {
    if (r.canceled || !r.include) return 0;
    if (NOT_SPENDING_CATS.includes(r.cat)) return 0;
    if (opts && opts.excludeTransfer && (r.transfer || r.cat === '송금')) return 0;
    return r.amount;
  }

  // ---------- 할부 ----------
  /** 첫 회차 = 결제 다음 달 (가계부 앱과 같음) */
  function installment(r, todayYM) {
    if (!r.inst || r.inst < 2) return null;
    const monthly = Math.round(r.amount / r.inst);
    const first = addMonths(r.date.slice(0, 7), 1);
    let paid = 0;
    for (let i = 0; i < r.inst; i++) if (addMonths(first, i) <= todayYM) paid++;
    const left = r.inst - paid;
    return { months: r.inst, monthly, left, leftAmount: r.amount - monthly * paid };
  }

  // ---------- 분석 ----------
  function group(items, keyFn) {
    const m = new Map();
    for (const it of items) { const k = keyFn(it); if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
    return m;
  }
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const median = (a) => { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };

  /**
   * 고정 지출: 같은 가게(대행사면 가게+금액)에서 서로 다른 3개월 이상,
   * 금액이 중앙값 ±15% 이내, 간격이 대체로 한 달(25~35일)인 결제.
   */
  function findRecurring(items, todayDate) {
    // 정기구독은 같은 가게(CHZZK 등)에서 상품별로 따로 나가니 상품명까지 묶는다
    const product = (x) => { const p = String(x.r.memo || '').split(' / ')[0]; return /정기구독|정기결제|월간 이용권|멤버십/.test(p) ? p : ''; };
    const keyFn = (x) => (product(x) ? `${x.c.key}|${product(x)}` : x.c.agent ? `${x.c.key}|${x.r.amount}` : x.c.key);
    const res = [];
    for (const [, list] of group(items.filter((x) => x.amt > 0), keyFn)) {
      if (list.length < 3) continue;
      const med = median(list.map((x) => x.amt));
      const close = list.filter((x) => Math.abs(x.amt - med) <= med * 0.15);
      // 한 달에 한 건씩만 (같은 달 여러 번이면 습관이지 고정은 아님)
      const byMonth = group(close, (x) => x.r.date.slice(0, 7));
      if (byMonth.size < 3) continue;
      if ([...byMonth.values()].filter((v) => v.length > 1).length > byMonth.size / 3) continue;
      const firsts = [...byMonth.values()].map((v) => v[0]).sort((a, b) => a.r.date.localeCompare(b.r.date));
      const gaps = [];
      for (let i = 1; i < firsts.length; i++) gaps.push(dayNum(firsts[i].r.date) - dayNum(firsts[i - 1].r.date));
      const monthly = gaps.filter((g) => g >= 25 && g <= 35).length;
      if (monthly < Math.max(2, gaps.length * 0.6)) continue;
      const last = firsts[firsts.length - 1];
      const nextDay = dayNum(last.r.date) + 30;
      const active = todayDate ? dayNum(todayDate) - dayNum(last.r.date) <= 40 : true;
      res.push({
        store: product(last) ? `${last.r.store} · ${product(last)}` : last.r.store, cat: last.c.cat, sub: last.c.sub, agent: last.c.agent,
        amount: Math.round(med), count: firsts.length,
        from: firsts[0].r.date, last: last.r.date, active,
        nextDay, day: +last.r.date.slice(8, 10),
        ids: close.map((x) => x.r.id),
      });
    }
    return res.sort((a, b) => (b.active - a.active) || b.amount - a.amount);
  }

  /** 중복 의심: 같은 금액, 다른 id, 시각 10분 이내(또는 시각 없는 경우 같은 날 + 비슷한 가게) */
  function findDuplicates(rows) {
    const res = [];
    const live = rows.filter((r) => !r.canceled && r.include && r.amount > 0);
    const byAmt = group(live, (r) => r.amount);
    for (const [, list] of byAmt) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (dayNum(b.date) - dayNum(a.date) > 1) break;
        let why = null;
        if (a.time && b.time) {
          const d = Math.abs(minutes(a) - minutes(b));
          if (d <= 10 && a.source !== b.source) why = d === 0 ? '같은 시각' : `${d}분 차이`;
        } else if (a.date === b.date && a.source !== b.source) why = similarStore(a.rawStore, b.rawStore) ? '같은 날, 비슷한 가게' : '같은 날 같은 금액';
        if (why) res.push({ a, b, why, key: [a.id, b.id].sort().join('|') });
      }
    }
    return res;
  }

  function analyze(rows, state, opts) {
    const items = rows.map((r) => {
      const c = classify(r, state);
      const rr = { ...r, cat: c.cat };
      return { r, c, amt: spendAmount(rr, opts) };
    });
    return items;
  }

  // ---------- 구글 시트 '분류 자료' (종류, 키, 대분류, 소분류, 값) ----------
  // 건별 = 앱 id별 분류 (앱도 대분류를 읽고 씀), 가게 = 가게별 기억, 규칙 = 단어 규칙,
  // 분류목록 = 대분류별 세부 목록, 설정 = 계산 옵션, 숨김 = 점검에서 '중복 아님'으로 넘긴 것
  const META_HEADER = ['종류', '키', '대분류', '소분류', '값'];
  function stateToMeta(st) {
    const out = [];
    for (const [id, ov] of Object.entries(st.overrides || {})) {
      const extra = {};
      if (ov.exclude) extra.exclude = true;
      if (ov.include) extra.include = true;
      if (!ov.cat && !ov.sub && !Object.keys(extra).length) continue;
      out.push(['건별', id, ov.cat || '', ov.sub || '', Object.keys(extra).length ? JSON.stringify(extra) : '']);
    }
    for (const [k, m] of Object.entries(st.memory || {})) out.push(['가게', k, m.cat || '', m.sub || '', '']);
    for (const r of st.rules || []) out.push(['규칙', r.kw, r.cat || '', r.sub || '', '']);
    Object.entries(st.tree || {}).forEach(([cat, subs], i) => out.push(['분류목록', cat, '', '', JSON.stringify({ i, subs })]));
    out.push(['설정', 'opts', '', '', JSON.stringify(st.opts || {})]);
    for (const k of Object.keys(st.dismissed || {})) out.push(['숨김', k, '', '', '1']);
    return out;
  }
  function metaToState(rows) {
    const st = { overrides: {}, memory: {}, rules: [], tree: null, opts: null, dismissed: {} };
    const tree = [];
    const json = (v) => { try { return v ? JSON.parse(v) : {}; } catch (e) { return {}; } };
    for (const r of rows || []) {
      const [kind, key, cat, sub, val] = r.map((v) => String(v == null ? '' : v));
      if (!key) continue;
      if (kind === '건별') {
        const ov = { ...json(val) };
        if (cat) ov.cat = cat;
        if (sub) ov.sub = sub;
        if (Object.keys(ov).length) st.overrides[key] = ov;
      } else if (kind === '가게') st.memory[key] = { cat, sub };
      else if (kind === '규칙') st.rules.push({ kw: key, cat, sub });
      else if (kind === '분류목록') { const j = json(val); tree.push([j.i == null ? 999 : j.i, key, Array.isArray(j.subs) ? j.subs : []]); }
      else if (kind === '설정' && key === 'opts') st.opts = json(val);
      else if (kind === '숨김') st.dismissed[key] = 1;
    }
    if (tree.length) st.tree = Object.fromEntries(tree.sort((a, b) => a[0] - b[0]).map((t) => [t[1], t[2]]));
    return st;
  }
  /** 이전에 저장한 줄과 비교해 바뀐 줄(puts)과 없어진 키(dels)만 */
  function metaDiff(prev, next) {
    const k = (r) => `${r[0]}\t${r[1]}`;
    const before = new Map(prev.map((r) => [k(r), JSON.stringify(r)]));
    const after = new Set(next.map(k));
    return {
      puts: next.filter((r) => before.get(k(r)) !== JSON.stringify(r)),
      dels: prev.filter((r) => !after.has(k(r))).map((r) => [r[0], r[1]]),
    };
  }
  /** 백업의 건별 분류 id가 지금 내역에 없으면 날짜·금액·가게로 찾아 옮긴다 (가계부 앱으로 옮겨 id가 바뀐 경우) */
  function remapOverrides(overrides, fingerprints, rows) {
    const ids = new Set(rows.map((r) => r.id));
    // 시각까지 맞는 건 먼저, 없으면 날짜·금액·가게. 똑같은 건이 여러 개면 순서대로 하나씩 (구별할 수 없는 건이라 결과는 같다)
    const keys = (f) => [`${f.date}|${f.time || ''}|${f.amount}|${storeKey(f.store)}`, `${f.date}|${f.amount}|${storeKey(f.store)}`];
    const idx = [new Map(), new Map()];
    for (const r of rows) keys(r).forEach((k, i) => { if (!idx[i].has(k)) idx[i].set(k, []); idx[i].get(k).push(r.id); });
    const out = {}; let moved = 0, lost = 0;
    for (const id of Object.keys(overrides || {})) if (ids.has(id)) out[id] = overrides[id];
    for (const [id, ov] of Object.entries(overrides || {})) {
      if (ids.has(id)) continue;
      const f = fingerprints && fingerprints[id];
      let to = null;
      if (f) for (const [i, k] of keys(f).entries()) { to = (idx[i].get(k) || []).find((x) => !(x in out)); if (to) break; }
      if (to) { out[to] = ov; moved++; } else { out[id] = ov; lost++; }
    }
    return { overrides: out, moved, lost };
  }

  // ---------- 가계부 앱용 CSV 내보내기 ----------
  /** 앱 CSV와 같은 14열. 출처·결제수단은 앱 라벨로, 원래가게명은 카드 쪽 이름 (앱이 나중에 카드 파일과 중복 거를 때 씀) */
  function appSource(r) {
    if (r.matchedCard || /네이버페이/.test(r.source) || r.pay === '네이버페이') return '네이버페이 알림';
    if (/^카드 파일/.test(r.source)) return '카드 파일';
    return r.source || '직접 입력';
  }
  function appPay(r) {
    if (r.pay === '현대카드(네이버페이)') return '현대카드';
    return r.pay || (/^카드 파일/.test(r.source) ? '현대카드' : '');
  }
  /** items: [{r, cat, include}] → CSV 문자열 (BOM, CRLF) */
  function toAppCSV(items) {
    const cell = (v) => { const t = String(v == null ? '' : v); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const lines = [CSV_COLS.join(',')];
    for (const { r, cat, include } of items) {
      lines.push([
        r.id, r.date, (r.time || '').slice(0, 5), r.amount, r.store, r.cardStore || r.rawStore || r.store,
        cat || '', appPay(r), r.inst > 1 ? r.inst : '',
        r.transfer || cat === '송금' ? 'Y' : 'N', include ? 'Y' : 'N', r.canceled ? 'Y' : 'N',
        r.memo || '', appSource(r),
      ].map(cell).join(','));
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  const api = {
    DEFAULT_TREE, NOT_SPENDING_CATS, WEEKDAYS,
    displayName, storeKey, isAgentOnly, similarStore, productName, sellerFromMemo, matchRule,
    CSV_COLS, parseCSV, parseAppCSV, parseAppRows, rangeLabel, parseFile, parseHyundaiStatement, parseHyundaiRealtime, htmlRows,
    combine, classify, spendAmount, installment, analyze, findRecurring, findDuplicates,
    dayNum, weekday, addMonths, group, sum, median, toAppCSV,
    META_HEADER, stateToMeta, metaToState, metaDiff, remapOverrides,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Core = api;
})(typeof window !== 'undefined' ? window : globalThis);
