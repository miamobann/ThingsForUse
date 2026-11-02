/**
 * 지출 분석 화면 (앱스 스크립트 웹 앱).
 * 가계부 앱의 Sync.gs 와 같은 프로젝트에 넣는다. 시트 이름·열은 Sync.gs 의 SYNC_* 값을 같이 쓴다.
 *  - doGet: 분석 화면(Index.html)을 띄운다. 웹 앱은 "나로 실행"이라 시트는 내 권한으로 읽고 쓴다.
 *  - 화면이 부르는 함수는 모두 sa 로 시작한다 (Sync.gs 의 doPost·setSyncKey_·hasSyncKey_·sync*_ 와 겹치지 않게).
 *
 * 액세스가 "모든 사용자"여도 이 화면을 연 사람이 시트를 읽을 수 있으니, 웹 앱 주소는 남에게 알려 주지 않는다.
 * 화면 함수는 소유자 본인만 쓰도록 막아 둔다 (아래 saOwner_).
 */

function doGet() {
  try { saOwner_(); } catch (e) {
    return HtmlService.createHtmlOutput('<p style="font:16px sans-serif;padding:24px">' + e.message + '</p>').setTitle('지출 분석');
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('지출 분석')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 화면을 연 사람이 스크립트 소유자인지. "모든 사용자" 배포에서 남이 열면 빈 이메일이 온다. */
function saOwner_() {
  var me = Session.getEffectiveUser().getEmail();
  var who = Session.getActiveUser().getEmail();
  if (!who || who !== me) throw new Error('이 화면은 시트 주인만 쓸 수 있어요. 구글에 시트 주인 계정으로 로그인해서 열어 주세요');
}

/** 처음 열 때: 시트 '내역'(글자 그대로)과 '분류 자료' 전체 */
function saLoad() {
  saOwner_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tx = syncSheet_(ss, SYNC_TX_SHEET, SYNC_TX_HEADER);
  var meta = syncSheet_(ss, SYNC_META_SHEET, SYNC_META_HEADER);
  var n = SYNC_TX_HEADER.length;
  var txRows = tx.getLastRow() > 1 ? tx.getRange(2, 1, tx.getLastRow() - 1, n).getValues() : [];
  var props = PropertiesService.getScriptProperties();
  return {
    header: SYNC_TX_HEADER,
    tx: txRows.map(function (r) { return r.map(saStr_); }).filter(function (r) { return r[0] !== '' || r[1] !== ''; }),
    meta: saReadMeta_(meta),
    hasSync: !!props.getProperty('SYNC_KEY'),
    hasAi: !!props.getProperty('ANTHROPIC_KEY'),
  };
}

/** 날짜 칸이 날짜로 바뀌어 있어도 yyyy-MM-dd 글자로 */
function saStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v == null ? '' : String(v);
}

function saReadMeta_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 5).getValues().map(function (r) { return r.map(saStr_); })
    .filter(function (r) { return r[0] !== '' && r[1] !== ''; });
}

/**
 * '분류 자료'에 바뀐 줄만 반영. puts = [[종류, 키, 대분류, 소분류, 값]], dels = [[종류, 키]]
 * 앱 동기화(doPost)와 겹치지 않게 같은 잠금을 쓰고, 잠금 안에서 시트를 다시 읽어 고친다.
 */
function saPutMeta(puts, dels) {
  saOwner_();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = syncSheet_(ss, SYNC_META_SHEET, SYNC_META_HEADER);
    var rows = saReadMeta_(sh);
    var at = {};
    rows.forEach(function (r, i) { at[r[0] + '\t' + r[1]] = i; });
    var gone = {};
    (dels || []).forEach(function (d) { var k = d[0] + '\t' + d[1]; if (k in at) gone[at[k]] = true; });
    (puts || []).forEach(function (p) {
      var r = [0, 1, 2, 3, 4].map(function (i) { return p[i] == null ? '' : String(p[i]); });
      var k = r[0] + '\t' + r[1];
      if (k in at) { rows[at[k]] = r; delete gone[at[k]]; } else { at[k] = rows.length; rows.push(r); }
    });
    rows = rows.filter(function (r, i) { return !gone[i]; });
    var last = sh.getLastRow();
    if (last > 1) sh.getRange(2, 1, last - 1, 5).clearContent();
    if (rows.length) sh.getRange(2, 1, rows.length, 5).setNumberFormat('@').setValues(rows);
    return rows.length;
  } finally {
    lock.releaseLock();
  }
}

/** 앱 연결 비밀번호 정하기 (Sync.gs 의 setSyncKey_ 를 주인 확인 뒤 부른다) */
function saSetSyncKey(key) {
  saOwner_();
  return setSyncKey_(key);
}

/** AI 키: 스크립트 속성 ANTHROPIC_KEY. 빈 값이면 지운다. */
function saSetAiKey(key) {
  saOwner_();
  key = String(key || '').trim();
  var props = PropertiesService.getScriptProperties();
  if (key) props.setProperty('ANTHROPIC_KEY', key); else props.deleteProperty('ANTHROPIC_KEY');
  return !!key;
}

/** AI 자동 분류: 화면이 만든 질문(가게 이름 목록)을 보내고 답 글자를 돌려준다. */
function saAi(prompt) {
  saOwner_();
  var key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_KEY');
  if (!key) throw new Error('설정에서 API 키를 먼저 넣어 주세요');
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 8000, messages: [{ role: 'user', content: String(prompt) }] }),
    muteHttpExceptions: true,
  });
  var j = JSON.parse(res.getContentText());
  if (res.getResponseCode() !== 200) throw new Error((j.error && j.error.message) || ('HTTP ' + res.getResponseCode()));
  return j.content.map(function (c) { return c.text || ''; }).join('');
}
