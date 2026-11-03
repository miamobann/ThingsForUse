/**
 * 결제 메일(Google Play 영수증, 윗치폼 결제완료) → 시트 '메일' (AI 없이 규칙으로 읽기).
 * Code.gs·Sync.gs 와 같은 앱스 스크립트 프로젝트에 넣는다. 시트 '내역'·'분류 자료'는 읽기만 한다.
 *
 * 카드엔 "구글페이먼트코리아", "파이어볼트"만 찍히는 결제에 앱·폼 이름과 상품명을 붙이려는 보완용이다.
 *  1. 5분마다 최근 2일 Gmail 중 Google Play 영수증, 윗치폼 결제완료·환불 메일만 찾는다. 새 메일이 없으면 바로 끝난다.
 *  2. 본문에서 결제 날짜·시각(한국 시각), 금액, 상품명, 앱·폼 이름, 결제 방법을 규칙으로 뽑는다.
 *     윗치폼 '주문 내역 안내' 메일은 결제완료 메일과 겹쳐서 건너뛴다.
 *  3. 분류는 '분류 자료'의 가게 기억 → 단어 규칙 순으로 찾고, 없으면 구글 정기 결제는 '구독', 윗치폼은 '여가·굿즈'로 추정.
 *  4. '메일' 시트에 한 줄씩 쌓고 '내역'에서 금액이 같은 앱 기록을 찾아 id를 적는다 (mailMatch_ 참고).
 *  5. 처음 짝지어지는 순간 한 번만, 그 기록의 분류를 메일 분류로 '분류 자료' 건별 줄에 쓴다 → 앱이 다음 동기화 때 받아 감.
 *     그 뒤에 앱·분석기에서 직접 고친 분류는 다시 덮지 않는다. 분류가 비었거나 추정인 메일은 쓰지 않는다.
 *  6. 단, 짝지어진 기록의 대분류가 '보류'면 실행할 때마다 메일 분류로 바꾼다(추정 분류도 씀). 나중에 보류로 바꾼 건도 포함.
 * 읽은 메일은 숨김 시트 '메일 기록'에 남겨 다시 읽지 않는다.
 *
 * 처음 한 번: 편집기에서 mailSetup 실행 (Gmail 권한 허용). 멈추려면 mailStop.
 * 지난 메일 가져오기: mailBackfill365 (1년). 90일만이면 mailBackfill90.
 * 못 읽은 메일이 있으면 mailShowLast 를 실행해 로그의 본문을 보내 주면 규칙을 고칠 수 있다.
 */

var MAIL_SHEET = '메일';
var MAIL_LOG_SHEET = '메일 기록';
var MAIL_HEADER = ['메일id', '받은 시각', '보낸 사람', '제목', '구분', '날짜', '시각', '금액', '판매처', '상품명',
  '결제수단', '대분류', '소분류', '확인 필요', '내역 id'];
var MAIL_LOG_HEADER = ['메일id', '받은 시각', '판정', '보낸 사람', '제목'];
var MAIL_QUERY = '(from:googleplay-noreply@google.com OR from:payments-noreply@google.com OR subject:"Google Play" OR from:no-reply@witchform.com)';
var MAIL_WITCH_DEFAULT = { cat: '여가', sub: '굿즈' };   // 윗치폼 분류가 없을 때
var MAIL_MATCH_MINUTES = 15;   // '내역'과 짝지을 때 허용하는 시각 차이
var MAIL_TZ = 'Asia/Seoul';

/** 처음 한 번 실행: 시트를 만들고 5분마다 확인하는 트리거를 건다 */
function mailSetup() {
  mailSheets_(SpreadsheetApp.getActiveSpreadsheet());
  mailStop();
  ScriptApp.newTrigger('mailCheck').timeBased().everyMinutes(5).create();
  Logger.log('설정 끝: 5분마다 구글 결제 메일을 확인해요.');
}

/** 자동 확인 멈추기 */
function mailStop() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'mailCheck') ScriptApp.deleteTrigger(t);
  });
}

/** 트리거가 부른다: 최근 2일 */
function mailCheck() { mailRun_(2); }

/** 지난 메일 가져오기 (편집기에서 직접 실행) */
function mailBackfill90() { mailBackfill_(90); }
function mailBackfill365() { mailBackfill_(365); }
function mailBackfill_(days) {
  var n = mailRun_(days);
  Logger.log('새로 읽은 메일 ' + n + '통');
}

/** 가장 최근 구글 결제 메일의 본문을 로그에 보여 준다 (규칙을 고칠 때) */
function mailShowLast() {
  var t = GmailApp.search(MAIL_QUERY, 0, 1)[0];
  if (!t) { Logger.log('구글 결제 메일을 찾지 못했어요'); return; }
  var msgs = t.getMessages();
  var info = mailInfo_(msgs[msgs.length - 1]);
  Logger.log('제목: ' + info.subject + '\n보낸 사람: ' + info.from + '\n\n' + info.body);
  Logger.log(JSON.stringify(mailParse_(info)));
}

/** @return 새로 읽은 메일 수 */
function mailRun_(days) {
  // 5분 트리거가 겹쳐 돌지 않게 (앱 동기화가 쓰는 스크립트 잠금과는 따로)
  var runLock = LockService.getDocumentLock();
  if (!runLock.tryLock(1000)) return 0;
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = mailSheets_(ss);
    var done = mailDoneIds_(sh.log);
    var since = new Date(Date.now() - days * 864e5);

    var todo = [];
    for (var start = 0; start < 1000; start += 100) {
      var threads = GmailApp.search('newer_than:' + days + 'd ' + MAIL_QUERY, start, 100);
      threads.forEach(function (t) {
        t.getMessages().forEach(function (m) { if (!done[m.getId()] && m.getDate() >= since) todo.push(m); });
      });
      if (threads.length < 100) break;
    }
    if (!todo.length) { mailMatchLocked_(ss, sh.mail); return 0; }
    todo.sort(function (a, b) { return a.getDate() - b.getDate(); });

    var hints = mailHints_(ss);
    var rows = [], logs = [];
    todo.forEach(function (m) {
      var info = mailInfo_(m);
      var r = mailParse_(info);
      logs.push([info.id, info.received, r.kind, info.from, info.subject]);
      if (r.kind !== '결제' && r.kind !== '취소') return;
      var c = mailClassify_(r, hints);
      rows.push([info.id, info.received, info.from, info.subject, r.kind,
        r.date, r.time, r.amount, r.merchant, r.items, r.method, c.cat, c.sub,
        [r.unsure, c.note].filter(String).join(' / '), '']);
    });

    var lock = LockService.getScriptLock();   // 쓰는 동안만 앱 동기화와 같은 잠금
    lock.waitLock(30000);
    try {
      if (rows.length) mailAppend_(sh.mail, rows);
      sh.log.getRange(sh.log.getLastRow() + 1, 1, logs.length, MAIL_LOG_HEADER.length).setNumberFormat('@').setValues(logs);
      mailMatch_(ss, sh.mail);
    } finally {
      lock.releaseLock();
    }
    return logs.length;
  } finally {
    runLock.releaseLock();
  }
}

/** 새 메일이 없어도 앱이 나중에 올린 내역과 짝지을 수 있게 */
function mailMatchLocked_(ss, mail) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try { mailMatch_(ss, mail); } finally { lock.releaseLock(); }
}

function mailSheets_(ss) {
  var mail = syncSheet_(ss, MAIL_SHEET, MAIL_HEADER);
  var log = ss.getSheetByName(MAIL_LOG_SHEET);
  if (!log) {
    log = syncSheet_(ss, MAIL_LOG_SHEET, MAIL_LOG_HEADER);
    log.hideSheet();
  }
  return { mail: mail, log: log };
}

function mailDoneIds_(log) {
  var out = {};
  var last = log.getLastRow();
  if (last > 1) log.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) { out[String(r[0])] = true; });
  return out;
}

function mailInfo_(m) {
  var body = String(m.getPlainBody() || '')
    .replace(/<https?:\/\/[^>]*>|https?:\/\/\S+/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return {
    id: m.getId(),
    date: m.getDate(),
    received: Utilities.formatDate(m.getDate(), MAIL_TZ, 'yyyy-MM-dd HH:mm'),
    from: String(m.getFrom() || ''),
    subject: String(m.getSubject() || ''),
    body: body,
  };
}

function mailParse_(info) {
  return /witchform\.com/i.test(info.from) ? mailParseWitch_(info) : mailParseGoogle_(info);
}

/**
 * 윗치폼 결제완료 메일 읽기. 줄 단위로 "결제일자 / 2026-08-10 01:35:53", "최종 결제금액 / 41,000원",
 * "결제방법 / 간편결제", "주문상품 / 상품명 / 수량 / 1개 ..." 가 온다. 맨 위 '결제 완료되었습니다.' 다음 줄이 폼 이름.
 */
function mailParseWitch_(info) {
  var s = info.subject, lines = info.body.split('\n');
  var out = { kind: '결제', date: '', time: '', amount: '', merchant: '', items: '', method: '윗치폼', unsure: '', witch: true };
  if (/환불|취소/.test(s)) out.kind = '취소';
  else if (!/결제\s*완료/.test(s)) { out.kind = '아님'; return out; }   // 주문 내역 안내·입금 안내 등
  var after = function (label) {
    for (var i = 0; i < lines.length - 1; i++) if (lines[i] === label) return lines[i + 1];
    return '';
  };
  for (var i = 0; i < lines.length; i++) {
    if (/결제 ?완료되었습니다/.test(lines[i])) {
      for (var j = i + 1; j < lines.length && j < i + 4; j++) if (lines[j] && lines[j] !== '폼보기') { out.merchant = lines[j]; break; }
      break;
    }
  }
  if (!out.merchant) {
    var m = /^\[(.+)\]에 대하여/.exec(s);
    out.merchant = m ? m[1] : '윗치폼';
  }
  var when = /(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/.exec(after('결제일자') || after('주문일자'));
  if (when) { out.date = when[1]; out.time = when[2]; }
  else {
    out.date = info.received.slice(0, 10); out.time = info.received.slice(11, 16);
    out.unsure = '결제일자를 못 찾아 메일 받은 시각을 씀';
  }
  var amt = /([\d,]+)\s*원/.exec(after('최종 결제금액') || '');
  if (amt) out.amount = Number(amt[1].replace(/,/g, ''));
  else out.unsure = [out.unsure, '금액을 못 찾음'].filter(String).join(' / ');
  var pm = after('결제방법');
  if (pm) out.method = '윗치폼 · ' + pm;
  var items = [], k = lines.indexOf('주문상품');
  for (var n = k + 1; k >= 0 && n < lines.length; n++) {
    var L = lines[n];
    if (/^본 메일은/.test(L)) break;
    if (L === '수량') continue;
    var q = /^(\d+)개$/.exec(L);
    if (q) { if (+q[1] > 1 && items.length) items[items.length - 1] += ' ×' + q[1]; continue; }
    if (L) items.push(L);
  }
  out.items = items.join(', ');
  return out;
}

/**
 * Google Play 영수증 읽기. 예)
 *   주문 날짜: 2026. 10. 28. 오후 10시 54분 44초 GMT+1
 *   상품 가격 / 유콘 멤버십 (YouTube) 매월 ₩990 / 합계: 매월 ₩990 / 결제 방법: 현대-9717
 */
function mailParseGoogle_(info) {
  var b = info.body, s = info.subject;
  var out = { kind: '결제', date: '', time: '', amount: '', merchant: '', items: '', method: '', unsure: '' };
  var won = function (t) { var m = /₩\s*([\d,]+)/.exec(t || ''); return m ? Number(m[1].replace(/,/g, '')) : null; };

  if (/환불|refund/i.test(s + '\n' + b.slice(0, 300))) out.kind = '취소';
  else if (!/주문 번호|주문번호|Order number|영수증|receipt/i.test(s + '\n' + b)) out.kind = '아님';
  else if (!/₩/.test(b)) out.kind = '아님';   // 금액 없는 안내 (예정·해지·무료 체험)
  if (out.kind === '아님') return out;

  // 날짜·시각 → 한국 시각
  var d = /(?:주문 날짜|주문일|환불 날짜)\s*:?\s*(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*(오전|오후)?\s*(\d{1,2})(?:시|:)\s*(\d{1,2})분?(?:\s*(\d{1,2})초)?\s*(?:GMT|UTC)?\s*([+-]\d{1,2})?(?::?(\d{2}))?/.exec(b);
  var at = info.date;
  if (d) {
    var h = +d[5];
    if (d[4] === '오후' && h < 12) h += 12;
    if (d[4] === '오전' && h === 12) h = 0;
    var off = d[8] != null ? (+d[8]) * 60 + (d[8][0] === '-' ? -1 : 1) * (+(d[9] || 0)) : 9 * 60;
    at = new Date(Date.UTC(+d[1], +d[2] - 1, +d[3], h, +d[6], +(d[7] || 0)) - off * 60000);
  } else {
    out.unsure = '주문 날짜를 못 찾아 메일 받은 시각을 씀';
  }
  out.date = Utilities.formatDate(at, MAIL_TZ, 'yyyy-MM-dd');
  out.time = Utilities.formatDate(at, MAIL_TZ, 'HH:mm');

  // 합계 (없으면 본문의 마지막 ₩ 금액)
  var total = /(?:합계|총액|Total)\s*:?\s*(?:매월|매년|매주|매일)?[^\n₩]{0,10}₩\s*[\d,]+/.exec(b);
  out.amount = total ? won(total[0]) : null;
  if (out.amount == null) {
    var all = b.match(/₩\s*[\d,]+/g) || [];
    out.amount = all.length ? won(all[all.length - 1]) : '';
    out.unsure = [out.unsure, '합계를 못 찾음'].filter(String).join(' / ');
  }

  // 상품명: "상품" 머리글 다음 줄부터 금액이 나오기 전까지 첫 줄
  var lines = b.split('\n');
  var hi = -1;
  for (var i = 0; i < lines.length; i++) if (/^상품(\s+가격)?$|^상품\s+가격|^Item(\s+Price)?$/.test(lines[i])) { hi = i; break; }
  var item = '';
  for (var j = hi + 1; hi >= 0 && j < lines.length && j < hi + 6; j++) {
    var L = lines[j].replace(/(매월|매년|매주)?\s*₩\s*[\d,]+.*$/, '').trim();
    if (L && !/^가격$|^Price$/.test(L)) { item = L; break; }
    if (/₩/.test(lines[j])) break;
  }
  if (!item) out.unsure = [out.unsure, '상품명을 못 찾음'].filter(String).join(' / ');
  item = item.replace(/\s*\(개발자:[^)]*\)\s*$/, '');
  out.items = item;
  var app = /\(([^()]+)\)\s*$/.exec(item);
  out.merchant = app ? app[1].trim() : (item || 'Google Play');
  if (/정기 결제|구독/.test(b)) out.subscription = true;

  var pm = /결제 (?:방법|수단)\s*:?\s*\n?\s*([^\n]+)/.exec(b);
  out.method = 'Google Play' + (pm ? ' · ' + pm[1].trim() : '');
  return out;
}

/** 분석기 storeKey 와 같은 규칙 (가게 기억 키) */
function mailStoreKey_(raw) {
  var s = String(raw || '').toLowerCase();
  s = s.replace(/\(주\)|㈜|주식회사|유한회사|\(유\)/g, '');
  return s.replace(/[\s_.,·*()\[\]-]/g, '');
}

/** '분류 자료'의 가게 기억·단어 규칙 */
function mailHints_(ss) {
  var meta = ss.getSheetByName(SYNC_META_SHEET);
  var rows = meta && meta.getLastRow() > 1 ? meta.getRange(2, 1, meta.getLastRow() - 1, 4).getValues() : [];
  var stores = {}, rules = [];
  rows.forEach(function (r) {
    var kind = String(r[0]), k = String(r[1]), cat = String(r[2]), sub = String(r[3]);
    if (!k || !cat) return;
    if (kind === '가게') stores[k] = { cat: cat, sub: sub };
    else if (kind === '규칙') rules.push({ kw: k.toLowerCase().replace(/\s/g, ''), cat: cat, sub: sub });
  });
  return { stores: stores, rules: rules };
}

function mailClassify_(r, hints) {
  var keys = [mailStoreKey_(r.merchant), mailStoreKey_(r.items)];
  for (var i = 0; i < keys.length; i++) {
    var m = keys[i] && hints.stores[keys[i]];
    if (m) return { cat: m.cat, sub: m.sub, note: '' };
  }
  var text = (r.merchant + ' ' + r.items).toLowerCase().replace(/\s/g, '');
  for (var j = 0; j < hints.rules.length; j++) {
    var x = hints.rules[j];
    if (x.kw && text.indexOf(x.kw) >= 0) return { cat: x.cat, sub: x.sub, note: '' };
  }
  if (r.witch) {
    var w = hints.stores[mailStoreKey_('파이어볼트')] || MAIL_WITCH_DEFAULT;
    return { cat: w.cat, sub: w.sub, note: '' };
  }
  if (r.subscription) return { cat: '구독', sub: '', note: '분류 추정(정기 결제)' };
  return { cat: '', sub: '', note: '분류 없음' };
}

/** 줄 추가. 같은 구분·금액·판매처·날짜가 이미 있으면 '확인 필요'에 중복 의심을 적는다 */
function mailAppend_(sh, rows) {
  var n = MAIL_HEADER.length;
  var last = sh.getLastRow();
  var old = last > 1 ? sh.getRange(2, 1, last - 1, n).getValues() : [];
  var seen = {};
  var fp = function (r) { return [r[4], mailStr_(r[5]), mailStr_(r[6]), Number(r[7]), String(r[9]).replace(/\s/g, '')].join('|'); };
  old.forEach(function (r) { seen[fp(r)] = true; });
  rows.forEach(function (r) {
    var f = fp(r);
    if (r[7] !== '' && seen[f]) r[13] = (r[13] ? r[13] + ' / ' : '') + '같은 결제 메일이 이미 있음';
    seen[f] = true;
  });
  var range = sh.getRange(last + 1, 1, rows.length, n);
  range.setNumberFormat('@');
  sh.getRange(last + 1, 8, rows.length, 1).setNumberFormat('#,##0');
  range.setValues(rows);
}

/**
 * '내역 id'가 빈 결제 줄을 '내역'과 짝짓는다. 금액이 같고:
 *  - 시각 차이 MAIL_MATCH_MINUTES분 이내
 *  - 구글 정기 결제는 카드가 영수증보다 하루 먼저 찍혀서, 같은 시각 하루 전(±MAIL_MATCH_MINUTES분)도 짝
 *  - '내역'에 시각이 없는 줄(카드 명세서)은 같은 날(구글은 하루 전도)
 * 중 가장 가까운 것. 이미 다른 메일과 짝지은 id는 쓰지 않는다. 앱이 나중에 동기화해도 다음 실행 때 다시 찾는다.
 * 새로 짝지은 줄은 mailApplyCategories_ 로 그 기록의 분류를 한 번 덮어쓴다.
 */
function mailMatch_(ss, sh) {
  var n = MAIL_HEADER.length;
  var last = sh.getLastRow();
  if (last < 2) return;
  var mail = sh.getRange(2, 1, last - 1, n).getValues();
  var txSh = ss.getSheetByName(SYNC_TX_SHEET);
  if (!txSh || txSh.getLastRow() < 2) return;
  var txCat = {};
  var tx = txSh.getRange(2, 1, txSh.getLastRow() - 1, 7).getValues().map(function (r) {
    var date = mailStr_(r[1]), time = mailStr_(r[2]);
    txCat[String(r[0])] = String(r[6]);
    return { id: String(r[0]), at: mailMinutes_(date, time), day: mailMinutes_(date, '00:00'), amount: Number(r[3]) };
  }).filter(function (t) { return t.id && t.day != null; });
  var used = {};
  mail.forEach(function (r) { if (r[14]) used[String(r[14])] = true; });
  var DAY = 1440, W = MAIL_MATCH_MINUTES;
  var assign = [];
  mail.forEach(function (r, i) {
    if (r[14] || r[4] !== '결제' || r[7] === '' || /같은 결제 메일/.test(String(r[13]))) return;
    var at = mailMinutes_(mailStr_(r[5]), mailStr_(r[6]));
    if (at == null) return;
    var day = at - at % DAY;
    var prev = /google/i.test(String(r[2]));
    var best = null;
    tx.forEach(function (t) {
      if (used[t.id] || t.amount !== Number(r[7])) return;
      var d = null;
      if (t.at != null) {
        if (Math.abs(t.at - at) <= W) d = Math.abs(t.at - at);
        else if (prev && Math.abs(t.at - (at - DAY)) <= W) d = Math.abs(t.at - (at - DAY)) + 0.5;
      } else if (t.day === day) d = 1000;
      else if (prev && t.day === day - DAY) d = 1001;
      if (d != null && (!best || d < best.d)) best = { id: t.id, d: d };
    });
    if (best) {
      used[best.id] = true;
      r[14] = best.id;
      sh.getRange(i + 2, 15).setNumberFormat('@').setValue(best.id);
      if (r[11] && !/추정|분류 없음/.test(String(r[13]))) assign.push({ id: best.id, cat: String(r[11]), sub: String(r[12] || '') });
    }
  });

  // 대분류가 '보류'인 짝지어진 기록은 메일 분류로 (분류 자료 건별 대분류가 있으면 그걸, 없으면 앱 카테고리를 본다)
  var metaCat = mailMetaCategories_(ss);
  var queued = {};
  assign.forEach(function (a) { queued[a.id] = true; });
  mail.forEach(function (r) {
    var id = String(r[14] || '');
    if (!id || queued[id] || r[4] !== '결제' || !r[11]) return;
    var cur = metaCat[id] ? metaCat[id] : txCat[id];
    if (cur === '보류') { assign.push({ id: id, cat: String(r[11]), sub: String(r[12] || '') }); queued[id] = true; }
  });
  if (assign.length) mailApplyCategories_(ss, assign);
}

/** '분류 자료' 건별 줄의 대분류 { 앱 id: 대분류 } (빈 칸은 뺌) */
function mailMetaCategories_(ss) {
  var sh = ss.getSheetByName(SYNC_META_SHEET);
  var out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (r) {
    if (String(r[0]) === '건별' && String(r[2]) !== '') out[String(r[1])] = String(r[2]);
  });
  return out;
}

/**
 * '분류 자료'의 건별 줄(종류='건별', 키=앱 id)에 대분류·소분류를 쓴다. 값(지출 포함·제외 표시)은 그대로 둔다.
 * 앱은 다음 동기화 때 건별 대분류를 받아 가고, 분석 화면은 '다시 읽기' 때 보인다.
 */
function mailApplyCategories_(ss, assign) {
  var sh = syncSheet_(ss, SYNC_META_SHEET, SYNC_META_HEADER);
  var last = sh.getLastRow();
  var data = last > 1 ? sh.getRange(2, 1, last - 1, 2).getValues() : [];
  var rowOf = {};
  data.forEach(function (r, i) { if (String(r[0]) === '건별') rowOf[String(r[1])] = i + 2; });
  var add = [];
  assign.forEach(function (a) {
    if (rowOf[a.id]) sh.getRange(rowOf[a.id], 3, 1, 2).setNumberFormat('@').setValues([[a.cat, a.sub]]);
    else add.push(['건별', a.id, a.cat, a.sub, '']);
  });
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, 5).setNumberFormat('@').setValues(add);
}

function mailStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, MAIL_TZ, 'yyyy-MM-dd');
  return v == null ? '' : String(v);
}

/** 'yyyy-MM-dd' + 'HH:mm' → 분 단위 숫자 (시각이 없으면 null) */
function mailMinutes_(date, time) {
  var d = /^(\d{4})-(\d{2})-(\d{2})/.exec(date), t = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!d || !t) return null;
  return Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]) / 60000;
}
