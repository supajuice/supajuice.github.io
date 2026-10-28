/**
 * Supa Juice orders: Google Apps Script backend.
 *
 * Lives in a Google Sheet (Extensions > Apps Script) and is deployed as a web
 * app (Execute as: Me, Who has access: Anyone). The Sheet is the database:
 *
 *   Orders    one row per order
 *   Settings  key / value / note, editable here or from the admin page
 *
 * The pages call this with POST requests. The body is JSON sent as text/plain,
 * which avoids a CORS preflight request (Apps Script cannot answer one).
 *
 * Public actions   config, order
 * Admin actions    list, create, setStatus, getSettings, saveSettings
 *                  (all need the admin key kept in Script properties)
 *
 * Run setup() once after pasting this in. See README.md.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORDERS_TAB = 'Orders';
const SETTINGS_TAB = 'Settings';

// Orders from the public page are capped per clock hour, so a bot cannot
// flood the Sheet or use up the daily email quota. Orders Greg enters are not capped.
const MAX_KIOSK_ORDERS_PER_HOUR = 12;

// How many of the newest rows the admin page loads.
const MAX_ORDERS_LISTED = 500;

const HEADERS = [
  'Invoice', 'Created', 'Source', 'Name', 'Contact', 'Address', 'Notes',
  'Qty', 'Unit price', 'Delivery fee', 'Total', 'Status', 'Paid on', 'Delivered on', 'Request ID'
];
const COL = {
  INVOICE: 0, CREATED: 1, SOURCE: 2, NAME: 3, CONTACT: 4, ADDRESS: 5, NOTES: 6,
  QTY: 7, PRICE: 8, FEE: 9, TOTAL: 10, STATUS: 11, PAID: 12, DELIVERED: 13, REQUEST: 14
};
// Text columns are stored as plain text so Sheets never turns input into a formula or a date.
const FORMATS = ['@', '@', '@', '@', '@', '@', '@', '0', '0.00', '0.00', '0.00', '@', '@', '@', '@'];

const STATUS = {
  AWAITING: 'Awaiting payment',
  PAID: 'Paid',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled'
};
// Which status can follow which. Includes the "undo" moves.
const TRANSITIONS = {
  'Awaiting payment': ['Paid', 'Cancelled'],
  'Paid': ['Delivered', 'Awaiting payment', 'Cancelled'],
  'Delivered': ['Paid'],
  'Cancelled': ['Awaiting payment']
};

const SETTING_DEFS = [
  { key: 'brand_name', value: 'Supa Juice', note: 'Shown at the top of the order page and on invoices.' },
  { key: 'product_name', value: 'Running gel sachet', note: 'Shown on the order page and on invoices.' },
  { key: 'price', value: '', note: 'REQUIRED. Price of one sachet, as a number (for example 40).' },
  { key: 'delivery_fee', value: '0', note: 'Delivery fee per order. 0 means free delivery.' },
  { key: 'currency_symbol', value: 'R', note: 'Shown before amounts.' },
  { key: 'delivery_area', value: 'Cape Town', note: 'Customers tick a box to confirm their address is inside this area.' },
  { key: 'max_quantity', value: '20', note: 'Most sachets one order can include.' },
  { key: 'invoice_prefix', value: 'SJ', note: 'Letters before the invoice number, for example SJ-0001. Up to 6 letters or digits.' },
  { key: 'alert_email', value: '', note: 'New orders from the order page are emailed here. Leave blank for no emails.' },
  { key: 'bank_name', value: '', note: 'REQUIRED. Bank that receives the payments.' },
  { key: 'account_holder', value: '', note: 'REQUIRED.' },
  { key: 'account_number', value: '', note: 'REQUIRED.' },
  { key: 'branch_code', value: '', note: '' },
  { key: 'account_type', value: '', note: 'For example Cheque or Savings.' },
  { key: 'payment_note', value: 'We will confirm once your payment reflects in our account, then deliver.', note: 'Shown under the payment details and on unpaid invoices.' }
];

// Longest allowed text per setting.
const SETTING_MAX = {
  brand_name: 60, product_name: 60, currency_symbol: 4, delivery_area: 60, alert_email: 120,
  bank_name: 60, account_holder: 80, account_number: 40, branch_code: 20, account_type: 30, payment_note: 300
};

// ---------------------------------------------------------------------------
// Web app entry points
// ---------------------------------------------------------------------------

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e && e.postData && e.postData.contents ? e.postData.contents : '');
  } catch (err) {
    return json_({ ok: false, error: 'bad_request', message: 'Could not read the request.' });
  }
  return json_(handle_(body));
}

// Opening the web app address in a browser shows that it is alive.
function doGet(e) {
  const action = e && e.parameter ? e.parameter.action : '';
  if (action === 'config') return json_(handle_({ action: 'config' }));
  return json_({ ok: true, service: 'orders' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(body) {
  try {
    if (!body || typeof body !== 'object') throw fail_('bad_request', 'Could not read the request.');

    // Public actions.
    if (body.action === 'config') return { ok: true, config: publicConfig_(readTypedSettings_()) };
    if (body.action === 'order') return placeKioskOrder_(body);

    // Everything else needs the admin key.
    requireAdmin_(body.key);
    switch (body.action) {
      case 'list': return listOrders_();
      case 'create': return createOrder_(body, 'dm');
      case 'setStatus': return setStatus_(body);
      case 'getSettings': return { ok: true, values: readSettings_() };
      case 'saveSettings': return saveSettings_(body);
      default: throw fail_('bad_request', 'Unknown action.');
    }
  } catch (err) {
    if (err && err.code) {
      const out = { ok: false, error: err.code, message: err.publicMessage || '' };
      if (err.data) Object.keys(err.data).forEach(function (k) { out[k] = err.data[k]; });
      return out;
    }
    console.error(err && err.stack ? err.stack : String(err));
    return { ok: false, error: 'server_error', message: 'Something went wrong. Please try again.' };
  }
}

// An error with a code the pages understand and a message safe to show.
function fail_(code, message, data) {
  const e = new Error(message || code);
  e.code = code;
  e.publicMessage = message || '';
  if (data) e.data = data;
  return e;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

function placeKioskOrder_(body) {
  // A hidden field real people never fill in. Bots usually do.
  if (body.website) throw fail_('rejected', 'Could not place the order.');
  return createOrder_(body, 'kiosk');
}

// Shared by the public page (source "kiosk") and Greg's page (source "dm").
function createOrder_(body, source) {
  const kiosk = source === 'kiosk';

  const name = clean_(body.name, 80);
  const contact = clean_(body.contact, 80);
  const address = clean_(body.address, 300);
  const notes = clean_(body.notes, 300);
  const qty = Number(body.qty);
  const requestId = /^[A-Za-z0-9_-]{8,64}$/.test(String(body.requestId || '')) ? String(body.requestId) : '';

  if (!name) throw fail_('invalid', 'Please enter a name.');
  if (kiosk && contact.length < 3) throw fail_('invalid', 'Please add an Instagram handle or phone number so we can reach you.');
  if (kiosk && !address) throw fail_('invalid', 'Please enter your delivery address.');
  if (kiosk && body.areaConfirmed !== true) throw fail_('invalid', 'Please confirm your address is inside the delivery area.');
  if (!isFinite(qty) || Math.floor(qty) !== qty || qty < 1) throw fail_('invalid', 'Please choose a quantity of at least 1.');

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    throw fail_('busy', 'We are busy right now. Please try again in a moment.');
  }

  let order;
  let settings;
  try {
    settings = readTypedSettings_();
    if (!settings.ready) throw fail_('not_ready', 'Ordering is not open yet.');
    if (qty > settings.maxQty) throw fail_('invalid', 'The most you can order at once is ' + settings.maxQty + '.');

    const sheet = ordersSheet_();

    // The same request twice (a double tap, or a retry after a dropped
    // connection) returns the order that already exists instead of making another.
    if (requestId) {
      const existing = findByRequestId_(sheet, requestId);
      if (existing) return orderResponse_(existing, settings);
    }

    const totalCents = Math.round(settings.price * 100) * qty + Math.round(settings.fee * 100);
    const total = totalCents / 100;

    // The total the customer saw must still be the real total.
    if (kiosk && body.expectedTotal !== undefined && Math.round(Number(body.expectedTotal) * 100) !== totalCents) {
      throw fail_('price_changed', 'The price has just changed. Please check the new total.', { config: publicConfig_(settings) });
    }

    if (kiosk) takeKioskSlot_();

    const number = nextNumber_(sheet);
    const invoice = settings.prefix + '-' + String(number).padStart(4, '0');
    const row = [
      invoice, nowString_(), source,
      safe_(name), safe_(contact), safe_(address), safe_(notes),
      qty, settings.price, settings.fee, total,
      STATUS.AWAITING, '', '', requestId
    ];
    writeRow_(sheet, sheet.getLastRow() + 1, row);
    SpreadsheetApp.flush();
    order = rowToOrder_(row);
  } finally {
    lock.releaseLock();
  }

  if (kiosk) sendAlert_(order, settings);
  return orderResponse_(order, settings);
}

function orderResponse_(order, s) {
  return {
    ok: true,
    order: order,
    brand: s.brand,
    product: s.product,
    currency: s.currency,
    area: s.area,
    bank: s.bank,
    paymentNote: s.paymentNote
  };
}

function listOrders_() {
  const sheet = ordersSheet_();
  const last = sheet.getLastRow();
  let orders = [];
  if (last >= 2) {
    const first = Math.max(2, last - MAX_ORDERS_LISTED + 1);
    orders = sheet.getRange(first, 1, last - first + 1, HEADERS.length).getValues()
      .filter(function (r) { return str_(r[COL.INVOICE]) !== ''; })
      .map(rowToOrder_);
  }
  return { ok: true, orders: orders, config: adminConfig_(readTypedSettings_()) };
}

function setStatus_(body) {
  const invoice = clean_(body.invoice, 32);
  const target = String(body.status || '');
  if (!TRANSITIONS[target]) throw fail_('invalid', 'Unknown status.');

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    throw fail_('busy', 'Busy right now. Please try again.');
  }
  try {
    const sheet = ordersSheet_();
    const rowNum = findRow_(sheet, invoice);
    if (!rowNum) throw fail_('not_found', 'Order ' + invoice + ' was not found.');

    const row = sheet.getRange(rowNum, 1, 1, HEADERS.length).getValues()[0];
    const current = str_(row[COL.STATUS]);
    if (current === target) return { ok: true, order: rowToOrder_(row) };
    if ((TRANSITIONS[current] || []).indexOf(target) === -1) {
      throw fail_('invalid', 'An order that is ' + current + ' cannot be changed to ' + target + '.');
    }

    const now = nowString_();
    row[COL.STATUS] = target;
    if (target === STATUS.AWAITING) {
      row[COL.PAID] = '';
      row[COL.DELIVERED] = '';
    } else if (target === STATUS.PAID) {
      if (current === STATUS.AWAITING) row[COL.PAID] = now; // back from Delivered keeps the original date
      row[COL.DELIVERED] = '';
    } else if (target === STATUS.DELIVERED) {
      row[COL.DELIVERED] = now;
    }
    sheet.getRange(rowNum, COL.STATUS + 1, 1, 3).setValues([[row[COL.STATUS], row[COL.PAID], row[COL.DELIVERED]]]);
    SpreadsheetApp.flush();
    return { ok: true, order: rowToOrder_(row) };
  } finally {
    lock.releaseLock();
  }
}

function rowToOrder_(r) {
  return {
    invoice: str_(r[COL.INVOICE]),
    created: str_(r[COL.CREATED]),
    source: str_(r[COL.SOURCE]),
    name: str_(r[COL.NAME]),
    contact: str_(r[COL.CONTACT]),
    address: str_(r[COL.ADDRESS]),
    notes: str_(r[COL.NOTES]),
    qty: Number(r[COL.QTY]) || 0,
    price: Number(r[COL.PRICE]) || 0,
    fee: Number(r[COL.FEE]) || 0,
    total: Number(r[COL.TOTAL]) || 0,
    status: str_(r[COL.STATUS]),
    paidOn: str_(r[COL.PAID]),
    deliveredOn: str_(r[COL.DELIVERED])
  };
}

function findRow_(sheet, invoice) {
  const last = sheet.getLastRow();
  if (last < 2 || !invoice) return 0;
  const col = sheet.getRange(2, COL.INVOICE + 1, last - 1, 1).getValues();
  const wanted = invoice.toUpperCase();
  for (let i = 0; i < col.length; i++) {
    if (str_(col[i][0]).toUpperCase() === wanted) return i + 2;
  }
  return 0;
}

function findByRequestId_(sheet, requestId) {
  const last = sheet.getLastRow();
  if (last < 2) return null;
  const first = Math.max(2, last - 199);
  const rows = sheet.getRange(first, 1, last - first + 1, HEADERS.length).getValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (str_(rows[i][COL.REQUEST]) === requestId) return rowToOrder_(rows[i]);
  }
  return null;
}

// Next invoice number. Never reuses a number, even if rows are deleted.
function nextNumber_(sheet) {
  const props = PropertiesService.getScriptProperties();
  const stored = Number(props.getProperty('LAST_NO') || 0);
  let highest = 0;
  const last = sheet.getLastRow();
  if (last >= 2) {
    sheet.getRange(2, COL.INVOICE + 1, last - 1, 1).getValues().forEach(function (r) {
      const m = /(\d+)\s*$/.exec(str_(r[0]));
      if (m) highest = Math.max(highest, parseInt(m[1], 10));
    });
  }
  const next = Math.max(stored, highest) + 1;
  props.setProperty('LAST_NO', String(next));
  return next;
}

function writeRow_(sheet, rowNum, values) {
  // A new tab has 1000 rows. Add more before writing past the end.
  if (rowNum > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), Math.max(500, rowNum - sheet.getMaxRows()));
  }
  const range = sheet.getRange(rowNum, 1, 1, HEADERS.length);
  range.setNumberFormats([FORMATS]);
  range.setValues([values]);
}

function takeKioskSlot_() {
  const cache = CacheService.getScriptCache();
  const key = 'kiosk_' + Math.floor(Date.now() / 3600000);
  const count = Number(cache.get(key) || 0);
  if (count >= MAX_KIOSK_ORDERS_PER_HOUR) {
    throw fail_('busy', 'We are getting a lot of orders right now. Please send us a DM to place yours.');
  }
  cache.put(key, String(count + 1), 7200);
}

function sendAlert_(order, s) {
  if (!s.alertEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.alertEmail)) return;
  try {
    const subject = 'New order ' + order.invoice + ': ' + order.qty + ' x ' + s.product + ' (' + money_(order.total, s.currency) + ')';
    const lines = [
      order.invoice + ' is waiting for payment.',
      '',
      'Name: ' + order.name,
      'Contact: ' + order.contact,
      'Address: ' + order.address,
      'Notes: ' + (order.notes || '-'),
      'Order: ' + order.qty + ' x ' + s.product + ' at ' + money_(order.price, s.currency),
      'Delivery: ' + money_(order.fee, s.currency),
      'Total: ' + money_(order.total, s.currency),
      '',
      'Check your bank statement for the reference ' + order.invoice + ', then mark the order paid on the admin page.'
    ];
    MailApp.sendEmail(s.alertEmail, subject, lines.join('\n'));
  } catch (err) {
    console.error('Alert email failed: ' + err);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// Raw settings as text, keyed by setting name.
function readSettings_() {
  const values = {};
  SETTING_DEFS.forEach(function (d) { values[d.key] = d.value; });
  const sheet = settingsSheet_();
  const last = sheet.getLastRow();
  if (last >= 2) {
    sheet.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
      const key = str_(r[0]);
      if (Object.prototype.hasOwnProperty.call(values, key)) values[key] = str_(r[1]);
    });
  }
  return values;
}

function readTypedSettings_() {
  const raw = readSettings_();
  const price = round2_(Math.max(0, parseNumber_(raw.price, 0)));
  const fee = round2_(Math.max(0, parseNumber_(raw.delivery_fee, 0)));
  const bank = {
    name: raw.bank_name,
    holder: raw.account_holder,
    number: raw.account_number,
    branch: raw.branch_code,
    type: raw.account_type
  };
  return {
    brand: raw.brand_name || 'Supa Juice',
    product: raw.product_name || 'Running gel sachet',
    price: price,
    fee: fee,
    currency: raw.currency_symbol || 'R',
    area: raw.delivery_area || 'Cape Town',
    maxQty: Math.min(200, Math.max(1, Math.floor(parseNumber_(raw.max_quantity, 20)))),
    prefix: (raw.invoice_prefix || 'SJ').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'SJ',
    alertEmail: raw.alert_email,
    bank: bank,
    paymentNote: raw.payment_note,
    ready: price > 0 && !!bank.name && !!bank.holder && !!bank.number
  };
}

// What anyone may see. No bank details: customers get those after they order.
function publicConfig_(s) {
  return {
    brand: s.brand,
    product: s.product,
    price: s.price,
    fee: s.fee,
    currency: s.currency,
    area: s.area,
    maxQty: s.maxQty,
    ready: s.ready
  };
}

function adminConfig_(s) {
  const c = publicConfig_(s);
  c.prefix = s.prefix;
  c.alertEmail = s.alertEmail;
  c.bank = s.bank;
  c.paymentNote = s.paymentNote;
  return c;
}

function saveSettings_(body) {
  const incoming = body.values;
  if (!incoming || typeof incoming !== 'object') throw fail_('bad_request', 'No settings to save.');

  const checked = {};
  SETTING_DEFS.forEach(function (d) {
    if (Object.prototype.hasOwnProperty.call(incoming, d.key)) checked[d.key] = validateSetting_(d.key, incoming[d.key]);
  });

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    throw fail_('busy', 'Busy right now. Please try again.');
  }
  try {
    const sheet = settingsSheet_();
    const last = sheet.getLastRow();
    const rowOf = {};
    if (last >= 2) {
      sheet.getRange(2, 1, last - 1, 1).getValues().forEach(function (r, i) { rowOf[str_(r[0])] = i + 2; });
    }
    let next = Math.max(last, 1) + 1;
    Object.keys(checked).forEach(function (key) {
      let rowNum = rowOf[key];
      if (!rowNum) {
        rowNum = next++;
        const def = SETTING_DEFS.filter(function (d) { return d.key === key; })[0];
        sheet.getRange(rowNum, 1, 1, 3).setNumberFormat('@').setValues([[key, '', def.note]]);
      }
      sheet.getRange(rowNum, 2).setNumberFormat('@').setValue(safe_(checked[key]));
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, values: readSettings_(), config: adminConfig_(readTypedSettings_()) };
}

function validateSetting_(key, value) {
  const text = clean_(value, SETTING_MAX[key] || 100);
  switch (key) {
    case 'price': {
      if (text === '') return '';
      const n = parseNumber_(text, NaN);
      if (!isFinite(n) || n < 0 || n > 100000) throw fail_('invalid', 'Price must be a number, for example 40.');
      return String(round2_(n));
    }
    case 'delivery_fee': {
      if (text === '') return '0';
      const n = parseNumber_(text, NaN);
      if (!isFinite(n) || n < 0 || n > 100000) throw fail_('invalid', 'Delivery fee must be a number. Use 0 for free delivery.');
      return String(round2_(n));
    }
    case 'max_quantity': {
      const n = parseNumber_(text, NaN);
      if (!isFinite(n) || Math.floor(n) !== n || n < 1 || n > 200) throw fail_('invalid', 'Most per order must be a whole number from 1 to 200.');
      return String(n);
    }
    case 'invoice_prefix':
      if (!/^[A-Za-z0-9]{1,6}$/.test(text)) throw fail_('invalid', 'Invoice prefix must be 1 to 6 letters or digits.');
      return text.toUpperCase();
    case 'alert_email':
      if (text !== '' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)) throw fail_('invalid', 'That email address does not look right.');
      return text;
    case 'brand_name':
    case 'product_name':
    case 'currency_symbol':
    case 'delivery_area':
      if (text === '') throw fail_('invalid', 'Brand, product, currency and delivery area cannot be blank.');
      return text;
    default:
      return text;
  }
}

// ---------------------------------------------------------------------------
// Admin key
// ---------------------------------------------------------------------------

function requireAdmin_(key) {
  const expected = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  const given = typeof key === 'string' ? key : '';
  if (!expected || !sameText_(given, expected)) {
    Utilities.sleep(700); // slows down guessing
    throw fail_('unauthorized', 'That admin key is not right.');
  }
}

function sameText_(a, b) {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function newKey_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

function ordersSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss && ss.getSheetByName(ORDERS_TAB);
  if (!sheet) throw fail_('not_ready', 'Ordering is not set up yet.');
  return sheet;
}

function settingsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss && ss.getSheetByName(SETTINGS_TAB);
  if (!sheet) throw fail_('not_ready', 'Ordering is not set up yet.');
  return sheet;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function str_(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

// Plain text from the outside world: no line breaks or control characters, limited length.
function clean_(v, max) {
  let s = v === null || v === undefined ? '' : String(v);
  s = s.replace(/\s*[\r\n]+\s*/g, ', ');
  s = s.replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, max);
}

// Text that starts with = + - or @ could be read as a formula. A leading space prevents that.
function safe_(s) {
  return /^[=+\-@]/.test(s) ? ' ' + s : s;
}

// Reads "40", "R40", "R 42,50" or "-5". Anything else (such as "4O" or "1-2") gives the fallback.
function parseNumber_(v, fallback) {
  const t = String(v).trim().replace(/^[^\d-]*/, '').replace(/\s/g, '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : fallback;
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}

function money_(n, symbol) {
  return symbol + (Math.floor(n) === n ? String(n) : n.toFixed(2));
}

function nowString_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
}

// ---------------------------------------------------------------------------
// One-off functions, run from the Apps Script editor
// ---------------------------------------------------------------------------

/** Run once. Creates the Orders and Settings tabs and the admin key. Safe to run again. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Open this script from a Google Sheet (Extensions > Apps Script), then run setup again.');

  // Orders tab
  const orders = ss.getSheetByName(ORDERS_TAB) || ss.insertSheet(ORDERS_TAB);
  orders.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  orders.setFrozenRows(1);
  if (orders.getMaxRows() < 2) orders.insertRowsAfter(1, 998);
  FORMATS.forEach(function (format, i) {
    orders.getRange(2, i + 1, orders.getMaxRows() - 1, 1).setNumberFormat(format);
  });
  [110, 130, 70, 160, 160, 260, 200, 50, 80, 90, 80, 120, 130, 130, 120].forEach(function (w, i) {
    orders.setColumnWidth(i + 1, w);
  });

  // Settings tab. Existing values are never overwritten.
  const settings = ss.getSheetByName(SETTINGS_TAB) || ss.insertSheet(SETTINGS_TAB);
  settings.getRange(1, 1, 1, 3).setValues([['Key', 'Value', 'Note']]).setFontWeight('bold');
  settings.setFrozenRows(1);
  const have = {};
  const last = settings.getLastRow();
  if (last >= 2) {
    settings.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) { have[str_(r[0])] = true; });
  }
  let next = Math.max(last, 1) + 1;
  SETTING_DEFS.forEach(function (d) {
    if (!have[d.key]) {
      settings.getRange(next, 1, 1, 3).setNumberFormat('@').setValues([[d.key, d.value, d.note]]);
      next++;
    }
  });
  settings.getRange(1, 2, settings.getMaxRows(), 1).setNumberFormat('@');
  settings.setColumnWidth(1, 150);
  settings.setColumnWidth(2, 260);
  settings.setColumnWidth(3, 460);

  // Remove the empty default tab.
  const spare = ss.getSheetByName('Sheet1');
  if (spare && spare.getLastRow() === 0 && spare.getLastColumn() === 0 && ss.getSheets().length > 2) ss.deleteSheet(spare);

  // Admin key, created once.
  const props = PropertiesService.getScriptProperties();
  let created = false;
  if (!props.getProperty('ADMIN_KEY')) {
    props.setProperty('ADMIN_KEY', newKey_());
    created = true;
  }
  Logger.log(created ? 'Setup done. Admin key created.' : 'Setup done. Admin key already existed.');
  Logger.log('Admin key: ' + props.getProperty('ADMIN_KEY'));
  Logger.log('Give the key only to the person who runs the orders.');
}

/** Logs the admin key again. */
function showAdminKey() {
  const key = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  Logger.log(key ? 'Admin key: ' + key : 'No admin key yet. Run setup first.');
}

/** Replaces the admin key. The old key and any saved links stop working. */
function rotateAdminKey() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('ADMIN_KEY', newKey_());
  Logger.log('New admin key: ' + props.getProperty('ADMIN_KEY'));
}

/** After deleting test orders: makes the next invoice SJ-0001 again. Refuses if any orders remain. */
function resetNumbering() {
  const sheet = ordersSheet_();
  if (sheet.getLastRow() > 1) throw new Error('Delete all the order rows first (keep the header row), then run this again.');
  PropertiesService.getScriptProperties().deleteProperty('LAST_NO');
  Logger.log('Invoice numbers will start again from 1.');
}
