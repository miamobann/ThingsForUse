/**
 * 가계부 앱 ↔ 구글 시트 동기화 (앱이 부르는 부분).
 * 분석 화면과 같은 앱스 스크립트 프로젝트에 넣는다. 웹 앱은 "나로 실행", 액세스 "모든 사용자"로 배포.
 * (모든 사용자여도 연결 비밀번호가 맞아야만 읽고 쓴다)
 *
 * 앱이 보내는 것 (POST, JSON):
 *   { protocol: 1, key: "연결 비밀번호", action: "sync",
 *     edits: [{ id: "123", category: "식비" }],          // 앱에서 고친 대분류 ("" = 분류 없음)
 *     rows:  [["123","2026-10-15","15:20","29000", ...14개 열], ...] }  // 앱 내역 전체
 * 돌려주는 것:
 *   { ok: true, categories: [{ id: "123", category: "식비" }], rowCount: 608 }
 *   { ok: false, error: "이유" }
 *
 * 시트1 '내역': 앱만 쓴다. 보낼 때마다 통째로 다시 쓴다. id는 앱 id라 바뀌지 않는다.
 * 시트2 '분류 자료': 열 = 종류, 키, 대분류, 소분류, 값. 앱은 종류='건별'인 줄의 대분류만 읽고 쓴다.
 */

var SYNC_TX_SHEET = '내역';
var SYNC_META_SHEET = '분류 자료';
var SYNC_TX_HEADER = ['id', '날짜', '시각', '금액', '가게명', '원래가게명', '카테고리', '결제수단', '할부',
  '송금여부', '지출포함여부', '취소됨', '메모', '출처'];
var SYNC_META_HEADER = ['종류', '키', '대분류', '소분류', '값'];

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return syncJson_({ ok: false, error: '요청을 읽지 못했어요' });
  }
  var key = PropertiesService.getScriptProperties().getProperty('SYNC_KEY');
  if (!key) return syncJson_({ ok: false, error: '시트에 연결 비밀번호가 아직 없어요. 분석 화면 설정에서 정해 주세요' });
  if (req.key !== key) return syncJson_({ ok: false, error: '연결 비밀번호가 맞지 않아요' });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    syncApplyEdits_(ss, req.edits || []);
    if (req.rows) syncWriteTx_(ss, req.rows);
    return syncJson_({ ok: true, categories: syncReadCategories_(ss), rowCount: (req.rows || []).length });
  } catch (err) {
    return syncJson_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/** 분석 화면 설정에서 부른다: 연결 비밀번호 정하기 (8자 이상) */
function setSyncKey_(key) {
  key = String(key || '').trim();
  if (key.length < 8) throw new Error('비밀번호는 8자 이상으로 정해 주세요');
  PropertiesService.getScriptProperties().setProperty('SYNC_KEY', key);
  return true;
}

function hasSyncKey_() {
  return !!PropertiesService.getScriptProperties().getProperty('SYNC_KEY');
}

function syncSheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function syncWriteTx_(ss, rows) {
  var sh = syncSheet_(ss, SYNC_TX_SHEET, SYNC_TX_HEADER);
  var n = SYNC_TX_HEADER.length;
  var values = rows.map(function (r) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(r[i] == null ? '' : String(r[i]));
    out[3] = out[3] === '' ? '' : Number(out[3]);           // 금액
    out[8] = out[8] === '' ? '' : Number(out[8]);           // 할부
    return out;
  });
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, Math.max(n, sh.getLastColumn())).clearContent();
  sh.getRange(1, 1, 1, n).setValues([SYNC_TX_HEADER]);
  if (values.length) {
    var range = sh.getRange(2, 1, values.length, n);
    range.setNumberFormat('@');                               // 날짜·id가 숫자/날짜로 바뀌지 않게 글자로
    sh.getRange(2, 4, values.length, 1).setNumberFormat('#,##0');
    sh.getRange(2, 9, values.length, 1).setNumberFormat('0');
    range.setValues(values);
  }
}

function syncReadMeta_(ss) {
  var sh = syncSheet_(ss, SYNC_META_SHEET, SYNC_META_HEADER);
  var last = sh.getLastRow();
  var data = last > 1 ? sh.getRange(2, 1, last - 1, 3).getValues() : [];
  return { sheet: sh, data: data };
}

function syncReadCategories_(ss) {
  var meta = syncReadMeta_(ss);
  var out = [];
  meta.data.forEach(function (r) {
    if (String(r[0]) === '건별' && String(r[2]) !== '') out.push({ id: String(r[1]), category: String(r[2]) });
  });
  return out;
}

function syncApplyEdits_(ss, edits) {
  if (!edits.length) return;
  var meta = syncReadMeta_(ss);
  var rowOf = {};
  meta.data.forEach(function (r, i) {
    if (String(r[0]) === '건별') rowOf[String(r[1])] = i + 2;
  });
  var append = [];
  edits.forEach(function (e) {
    var id = String(e.id), cat = String(e.category || '');
    if (rowOf[id]) meta.sheet.getRange(rowOf[id], 3).setValue(cat);
    else if (cat !== '') append.push(['건별', id, cat, '', '']);
  });
  if (append.length) {
    var start = meta.sheet.getLastRow() + 1;
    meta.sheet.getRange(start, 1, append.length, 5).setNumberFormat('@').setValues(append);
  }
}

function syncJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
