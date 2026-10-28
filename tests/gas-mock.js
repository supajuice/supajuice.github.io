'use strict';
// A small in-memory stand-in for the parts of Google Apps Script that Code.gs uses.
// It is deliberately strict where the real thing is strict (writes outside the
// sheet grid throw, text-formatted cells keep text, "=..." in other cells becomes
// a formula, numeric-looking text in General cells becomes a number).

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class MockRange {
  constructor(sheet, row, col, numRows, numCols) {
    if (row < 1 || col < 1) throw new Error('The coordinates of the range are invalid.');
    if (numRows < 1 || numCols < 1) throw new Error('The number of rows and columns must be at least 1.');
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  _each(fn) {
    for (let i = 0; i < this.numRows; i++) for (let j = 0; j < this.numCols; j++) fn(this.row + i, this.col + j, i, j);
  }
  _checkWritable() {
    if (this.row + this.numRows - 1 > this.sheet.maxRows) {
      throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    }
  }
  getValues() {
    const out = [];
    for (let i = 0; i < this.numRows; i++) {
      const line = [];
      for (let j = 0; j < this.numCols; j++) {
        const cell = this.sheet.cells.get((this.row + i) + ',' + (this.col + j));
        line.push(cell ? cell.v : '');
      }
      out.push(line);
    }
    return out;
  }
  _write(cell, v) {
    if (v === undefined || v === null) v = '';
    if (cell.fmt === '@') {
      cell.v = String(v);
      cell.formula = false;
    } else if (typeof v === 'string' && v.startsWith('=')) {
      cell.v = v;
      cell.formula = true;
    } else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) {
      cell.v = Number(v);
      cell.formula = false;
    } else {
      cell.v = v;
      cell.formula = false;
    }
  }
  setValues(values) {
    this._checkWritable();
    if (values.length !== this.numRows || values[0].length !== this.numCols) {
      throw new Error('The number of rows in the range is ' + this.numRows + ', but the number of rows in the data is ' + values.length + '.');
    }
    this._each((r, c, i, j) => this._write(this.sheet._cell(r, c), values[i][j]));
    return this;
  }
  setValue(v) {
    this._checkWritable();
    this._each((r, c) => this._write(this.sheet._cell(r, c), v));
    return this;
  }
  setNumberFormat(f) {
    this._each((r, c) => { this.sheet._cell(r, c).fmt = f; });
    return this;
  }
  setNumberFormats(formats) {
    this._each((r, c, i, j) => { this.sheet._cell(r, c).fmt = formats[i][j]; });
    return this;
  }
  setFontWeight() { return this; }
}

class MockSheet {
  constructor(name, maxRows) {
    this.name = name;
    this.maxRows = maxRows || 1000;
    this.cells = new Map();
    this.frozen = 0;
  }
  _cell(r, c) {
    const k = r + ',' + c;
    if (!this.cells.has(k)) this.cells.set(k, { v: '', fmt: 'General', formula: false });
    return this.cells.get(k);
  }
  getMaxRows() { return this.maxRows; }
  getLastRow() {
    let last = 0;
    for (const [k, cell] of this.cells) if (cell.v !== '') last = Math.max(last, Number(k.split(',')[0]));
    return last;
  }
  getLastColumn() {
    let last = 0;
    for (const [k, cell] of this.cells) if (cell.v !== '') last = Math.max(last, Number(k.split(',')[1]));
    return last;
  }
  getRange(r, c, nr, nc) { return new MockRange(this, r, c, nr === undefined ? 1 : nr, nc === undefined ? 1 : nc); }
  setFrozenRows(n) { this.frozen = n; }
  setColumnWidth() {}
  insertRowsAfter(after, n) { this.maxRows += n; }
}

class MockSpreadsheet {
  constructor() { this.sheets = [new MockSheet('Sheet1')]; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new MockSheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets.slice(); }
  deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
}

// A blob that remembers its source. Converting HTML to PDF keeps the HTML, so tests can read what the PDF shows.
class MockBlob {
  constructor(data, type, name) {
    Object.assign(this, { data: String(data), type, name });
  }
  getAs(type) {
    if (type === 'application/pdf' && this.type !== 'text/html') throw new Error('mock only converts HTML to PDF');
    return new MockBlob(this.data, type, this.name);
  }
  setName(name) { this.name = name; return this; }
  getName() { return this.name; }
  getContentType() { return this.type; }
  getDataAsString() { return this.data; }
}

function formatDate(date, tz, fmt) {
  if (fmt !== 'yyyy-MM-dd HH:mm') throw new Error('mock formatDate only supports yyyy-MM-dd HH:mm');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  return parts.year + '-' + parts.month + '-' + parts.day + ' ' + parts.hour + ':' + parts.minute;
}

function createGas() {
  const ss = new MockSpreadsheet();
  const clock = { now: Date.UTC(2026, 9, 28, 13, 41, 0) }; // 15:41 in Cape Town
  const mail = [];
  const logs = [];
  const errors = [];
  const sleeps = [];
  const store = new Map();
  const cacheStore = new Map();
  const lock = { failNext: false, held: false };
  const mailQuota = { left: 100 }; // a consumer Gmail account's daily limit

  class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(clock.now); else super(...a); }
    static now() { return clock.now; }
  }

  const sandbox = {
    Date: FakeDate,
    console: { log() {}, error: (m) => errors.push(String(m)), warn() {} },
    Logger: { log: (m) => logs.push(String(m)) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
    LockService: {
      getScriptLock: () => ({
        waitLock() {
          if (lock.failNext) { lock.failNext = false; throw new Error('Could not obtain lock after 20000 milliseconds.'); }
          if (lock.held) throw new Error('Lock already held (not re-entrant in this mock).');
          lock.held = true;
        },
        releaseLock() { lock.held = false; }
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (store.has(k) ? store.get(k) : null),
        setProperty: (k, v) => { store.set(k, String(v)); },
        deleteProperty: (k) => { store.delete(k); }
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : null),
        put: (k, v) => { cacheStore.set(k, String(v)); }
      })
    },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (s) => ({ content: s, setMimeType() { return this; }, getContent() { return this.content; } })
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate,
      sleep: (ms) => sleeps.push(ms),
      newBlob: (data, type, name) => new MockBlob(data, type, name)
    },
    Session: { getScriptTimeZone: () => 'Africa/Johannesburg' },
    MailApp: {
      // Both forms Apps Script accepts: (to, subject, body) and ({ to, subject, body, attachments, ... }).
      sendEmail: (to, subject, body) => {
        if (mailQuota.left < 1) throw new Error('Service invoked too many times for one day: email.');
        mailQuota.left--;
        mail.push(typeof to === 'object' ? Object.assign({}, to) : { to, subject, body });
      },
      getRemainingDailyQuota: () => mailQuota.left
    }
  };

  const ctx = vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  vm.runInContext(code, ctx, { filename: 'Code.gs' });

  const gas = {
    ctx, ss, clock, mail, mailQuota, logs, errors, sleeps, lock, store, cacheStore,
    // Send one request through doPost, like the pages do.
    call(body) {
      const out = ctx.doPost({ postData: { contents: JSON.stringify(body), type: 'text/plain' } });
      return JSON.parse(out.getContent());
    },
    raw(contents) {
      return JSON.parse(ctx.doPost({ postData: { contents, type: 'text/plain' } }).getContent());
    },
    get(params) {
      return JSON.parse(ctx.doGet({ parameter: params || {} }).getContent());
    },
    run(expr) { return vm.runInContext(expr, ctx); },
    key() { return store.get('ADMIN_KEY'); },
    // Rows of a tab as objects keyed by the header row.
    rows(tab) {
      const sheet = ss.getSheetByName(tab);
      const last = sheet.getLastRow();
      if (last < 1) return [];
      const lastCol = sheet.getLastColumn();
      const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
      const out = [];
      for (let r = 2; r <= last; r++) {
        const vals = sheet.getRange(r, 1, 1, lastCol).getValues()[0];
        const o = {};
        header.forEach((h, i) => { o[h] = vals[i]; });
        out.push(o);
      }
      return out;
    },
    sheet(tab) { return ss.getSheetByName(tab); }
  };
  return gas;
}

module.exports = { createGas };
