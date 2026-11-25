/**
 * Хранилище событий прототипа «Под ключ» в Google-таблице.
 *  - doPost: прототип шлёт пачки событий {events:[...]} → строки на листе "events".
 *  - doGet:  дашборд забирает все события JSON-ом (?since=ISO-время — только новые).
 * Развернуть: Расширения → Apps Script → вставить этот код → Развернуть → Новое развертывание →
 * тип «Веб-приложение», «Выполнять от моего имени», доступ «Все» → скопировать URL /exec.
 */
var SHEET = 'events';
var COLS = [
  'ts', 't', 'session', 'r', 'proto', 'type', 'el', 'text', 'dead', 'section',
  'x', 'y', 'xr', 'yr', 'sxr', 'syr', 'vw', 'vh', 'sy', 'pct', 'ms', 'max_scroll',
  'q', 'open', 'len', 'to', 'ua', 'dpr', 'ref', 'doc_h'
];

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET);
  if (!sh) {
    sh = ss.insertSheet(SHEET);
    sh.appendRow(COLS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'bad json' }); }
  var events = (body.events || []).slice(0, 500);
  if (!events.length) return out_({ ok: true, n: 0 });
  var rows = events.map(function (ev) {
    return COLS.map(function (c) {
      var v = ev[c];
      if (v === undefined || v === null) return '';
      return typeof v === 'object' ? JSON.stringify(v) : String(v).slice(0, 500);
    });
  });
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = sheet_();
    var rng = sh.getRange(sh.getLastRow() + 1, 1, rows.length, COLS.length);
    rng.setNumberFormat('@'); // всё как текст, чтобы таблица не превращала время и числа в свои форматы
    rng.setValues(rows);
  } finally {
    lock.releaseLock();
  }
  return out_({ ok: true, n: rows.length });
}

function doGet(e) {
  var since = (e && e.parameter && e.parameter.since) || '';
  var sh = sheet_();
  var n = sh.getLastRow() - 1;
  if (n <= 0) return out_({ ok: true, events: [] });
  var values = sh.getRange(2, 1, n, COLS.length).getDisplayValues();
  var events = [];
  for (var i = 0; i < values.length; i++) {
    if (since && values[i][0] <= since) continue;
    var ev = {};
    for (var j = 0; j < COLS.length; j++) if (values[i][j] !== '') ev[COLS[j]] = values[i][j];
    events.push(ev);
  }
  return out_({ ok: true, events: events, total: n });
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
