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
 * Public actions   config, order, photo
 * Admin actions    list, create, editOrder, acceptOrder, declineOrder, setStatus, sendInvoice,
 *                  setCollectTime, bulk, getSettings, saveSettings,
 *                  setPhoto, removePhoto
 *                  (all need the admin key kept in Script properties)
 *
 * Customers with an email address get their invoice as a PDF: the unpaid one
 * when the order is placed, the paid one when it is marked paid.
 *
 * When delivery fees are confirmed per order (the default), a delivery order from
 * the order page starts as a "New request". Greg sets the fee and accepts it, and
 * only then is the invoice with the bank details sent. Collection orders skip this.
 *
 * Customers who collect pick a time slot from the collection hours in Settings. When
 * the order is marked paid, the paid invoice email carries a calendar invite (.ics).
 * Moving the time or cancelling a paid order emails an update to that invite.
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
  'Qty', 'Unit price', 'Delivery fee', 'Total', 'Status', 'Paid on', 'Delivered on', 'Request ID',
  'Email', 'Invoice emailed', 'Collect', 'Edited on', 'Collect at'
];
// New columns go at the end, so rows written by an older version still line up.
const COL = {
  INVOICE: 0, CREATED: 1, SOURCE: 2, NAME: 3, CONTACT: 4, ADDRESS: 5, NOTES: 6,
  QTY: 7, PRICE: 8, FEE: 9, TOTAL: 10, STATUS: 11, PAID: 12, DELIVERED: 13, REQUEST: 14,
  EMAIL: 15, EMAILED: 16, COLLECT: 17, EDITED: 18, COLLECT_AT: 19
};
// Text columns are stored as plain text so Sheets never turns input into a formula or a date.
const FORMATS = ['@', '@', '@', '@', '@', '@', '@', '0', '0.00', '0.00', '0.00', '@', '@', '@', '@', '@', '@', '@', '@', '@'];

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const STATUS = {
  REQUESTED: 'New request',
  AWAITING: 'Awaiting payment',
  PAID: 'Paid',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled'
};
// Which status can follow which. Includes the "undo" moves.
// A new request becomes "Awaiting payment" only through acceptOrder, which sets the delivery fee.
const TRANSITIONS = {
  'New request': ['Cancelled'],
  'Awaiting payment': ['Paid', 'Cancelled'],
  'Paid': ['Delivered', 'Awaiting payment', 'Cancelled'],
  'Delivered': ['Paid'],
  'Cancelled': ['Awaiting payment']
};

const SETTING_DEFS = [
  { key: 'brand_name', value: 'Supa Juice', note: 'Shown at the top of the order page and on invoices.' },
  { key: 'product_name', value: 'Running gel sachet', note: 'Shown on the order page and on invoices.' },
  { key: 'price', value: '', note: 'REQUIRED. Price of one sachet, as a number (for example 40).' },
  { key: 'delivery_fee', value: '0', note: 'Delivery fee per order. 0 means free delivery. When fees are confirmed per order, customers see it as "from" and it is suggested when you accept a request.' },
  { key: 'delivery_quote', value: 'yes', note: 'yes: delivery orders from the order page wait for you to set the fee and accept them. no: the delivery fee above is charged straight away.' },
  { key: 'currency_symbol', value: 'R', note: 'Shown before amounts.' },
  { key: 'collection_note', value: 'Sea Point', note: 'REQUIRED. Where customers collect, for example "Sea Point". Shown on the order page, invoices and calendar invites. Collection is free.' },
  { key: 'collection_dates', value: '', note: 'Dates and times customers can collect, for example "2026-11-03 07:00-08:00 17:00-19:00, 2026-11-04". A date on its own uses the usual times. Set them on the admin page, which shows the next 30 days.' },
  { key: 'collection_hours', value: '17:00-19:00', note: 'The usual collection times, for example 17:00-19:00. New dates start with these, and each date can have its own.' },
  { key: 'collection_slot_minutes', value: '30', note: 'Length of one collection time in minutes: 15, 30 or 60.' },
  { key: 'collection_per_slot', value: '1', note: 'How many customers can book the same collection time.' },
  { key: 'min_quantity', value: '1', note: 'Fewest sachets one order can include. The quantity starts here.' },
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
  brand_name: 60, product_name: 60, currency_symbol: 4, collection_note: 200, alert_email: 120,
  collection_dates: 8000, collection_hours: 20,
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
    if (body.action === 'config') return { ok: true, config: customerConfig_() };
    if (body.action === 'order') return placeKioskOrder_(body);
    if (body.action === 'photo') return { ok: true, photo: readPhoto_() };

    // Everything else needs the admin key.
    requireAdmin_(body.key);
    switch (body.action) {
      case 'list': return listOrders_();
      case 'create': return createOrder_(body, 'dm');
      case 'editOrder': return editOrder_(body);
      case 'acceptOrder': return acceptOrder_(body);
      case 'declineOrder': return declineOrder_(body);
      case 'setStatus': return setStatus_(body);
      case 'sendInvoice': return sendInvoice_(body);
      case 'setCollectTime': return setCollectTime_(body);
      case 'bulk': return bulk_(body);
      case 'getSettings': return { ok: true, values: readSettings_() };
      case 'saveSettings': return saveSettings_(body);
      case 'setPhoto': return setPhoto_(body);
      case 'removePhoto': return removePhoto_();
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
  const email = clean_(body.email, 120);
  const address = clean_(body.address, 300);
  const notes = clean_(body.notes, 300);
  const qty = Number(body.qty);
  const collect = body.collect === true;
  const collectAt = collect ? slotText_(body.collectAt) : '';
  const requestId = /^[A-Za-z0-9_-]{8,64}$/.test(String(body.requestId || '')) ? String(body.requestId) : '';

  if (!name) throw fail_('invalid', 'Please enter a name.');
  if (kiosk && !email) throw fail_('invalid', 'Please enter your email address so we can send your invoice.');
  if (email && !EMAIL_PATTERN.test(email)) throw fail_('invalid', 'That email address does not look right.');
  if (kiosk && !collect && !address) throw fail_('invalid', 'Please enter your delivery address.');
  if (kiosk && collect && !collectAt) throw fail_('invalid', 'Please pick a collection time.');
  if (!isFinite(qty) || Math.floor(qty) !== qty || qty < 1) throw fail_('invalid', 'Please choose a quantity of at least 1.');
  // Greg can set the delivery fee for a DM order himself. Customers never can.
  const customFee = !kiosk && body.fee !== undefined && body.fee !== null && body.fee !== '' ? parseNumber_(body.fee, NaN) : null;
  if (customFee !== null && (!isFinite(customFee) || customFee < 0 || customFee > 100000)) {
    throw fail_('invalid', 'Delivery fee must be a number. Use 0 for free delivery.');
  }

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
    if (qty < settings.minQty) throw fail_('invalid', 'The smallest order is ' + settings.minQty + '.');
    if (qty > settings.maxQty) throw fail_('invalid', 'The most you can order at once is ' + settings.maxQty + '.');

    const sheet = ordersSheet_();

    // The same request twice (a double tap, or a retry after a dropped
    // connection) returns the order that already exists instead of making another.
    if (requestId) {
      const existing = findByRequestId_(sheet, requestId);
      if (existing) return orderResponse_(existing, settings);
    }

    // Customers can only book a free time. Greg can put a DM order at any time, even a full one.
    if (kiosk && collect) {
      const free = freeSlots_(settings, sheet);
      if (!slotIsFree_(free, collectAt)) {
        throw fail_('slot_taken', 'That collection time has just been taken. Please pick another.', { config: publicConfig_(settings, free) });
      }
    }

    // With fees confirmed per order, a delivery from the order page is a request: the fee is
    // left blank and the total covers the sachets only, until Greg accepts it.
    const request = kiosk && !collect && settings.quote;
    const fee = collect || request ? 0 : (customFee !== null ? round2_(customFee) : settings.fee);
    const totalCents = Math.round(settings.price * 100) * qty + Math.round(fee * 100);
    const total = totalCents / 100;

    // The total the customer saw must still be the real total.
    if (kiosk && body.expectedTotal !== undefined && Math.round(Number(body.expectedTotal) * 100) !== totalCents) {
      throw fail_('price_changed', 'The price has just changed. Please check the new total.', { config: publicConfig_(settings, freeSlots_(settings, sheet)) });
    }

    if (kiosk) takeKioskSlot_();

    const number = nextNumber_(sheet);
    const invoice = settings.prefix + '-' + String(number).padStart(4, '0');
    const row = [
      invoice, nowString_(), source,
      safe_(name), safe_(contact), safe_(address), safe_(notes),
      qty, settings.price, request ? '' : fee, total,
      request ? STATUS.REQUESTED : STATUS.AWAITING, '', '', requestId,
      safe_(email), '', collect ? 'yes' : '', '', collectAt
    ];
    writeRow_(sheet, sheet.getLastRow() + 1, row);
    SpreadsheetApp.flush();
    order = rowToOrder_(row);
  } finally {
    lock.releaseLock();
  }

  if (kiosk) sendAlert_(order, settings);
  // A request gets no email yet: the invoice goes out when Greg accepts it.
  const emailed = order.email && order.status === STATUS.AWAITING ? emailInvoice_(order, settings) : undefined;
  return orderResponse_(order, settings, emailed);
}

// emailed: true or false when an invoice email was attempted, left out otherwise.
// A new request gets no bank details: there is nothing to pay until the fee is set.
function orderResponse_(order, s, emailed) {
  const request = order.status === STATUS.REQUESTED;
  return {
    ok: true,
    emailed: emailed,
    order: order,
    brand: s.brand,
    product: s.product,
    currency: s.currency,
    collectNote: s.collectNote,
    bank: request ? null : s.bank,
    paymentNote: request ? '' : s.paymentNote
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
  return { ok: true, orders: orders, config: adminConfig_(readTypedSettings_()), emailsLeft: MailApp.getRemainingDailyQuota() };
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
  let order;
  let sendPaidInvoice = false;
  let sendCancel = false;
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
    order = rowToOrder_(row);
    // Only a fresh payment sends the paid invoice. Undoing "delivered" does not send it again.
    sendPaidInvoice = current === STATUS.AWAITING && target === STATUS.PAID && !!order.email;
    // A paid collection already has an invite in the customer's calendar. Cancelling removes it.
    sendCancel = current === STATUS.PAID && target === STATUS.CANCELLED && !!order.email && hasInvite_(order);
  } finally {
    lock.releaseLock();
  }
  const out = { ok: true, order: order };
  if (sendPaidInvoice) {
    const s = readTypedSettings_();
    out.emailed = emailInvoice_(order, s, hasInvite_(order) ? [inviteBlob_(order, s, 'REQUEST')] : []);
  }
  if (sendCancel) out.emailed = emailInvite_(order, readTypedSettings_(), 'cancel');
  return out;
}

// Greg sends the invoice again, for example when the customer cannot find it.
function sendInvoice_(body) {
  const invoice = clean_(body.invoice, 32);
  const sheet = ordersSheet_();
  const rowNum = findRow_(sheet, invoice);
  if (!rowNum) throw fail_('not_found', 'Order ' + invoice + ' was not found.');
  const order = rowToOrder_(sheet.getRange(rowNum, 1, 1, HEADERS.length).getValues()[0]);
  if (!order.email) throw fail_('invalid', 'Order ' + order.invoice + ' has no email address.');
  if (order.status === STATUS.CANCELLED) throw fail_('invalid', 'Order ' + order.invoice + ' is cancelled.');
  if (order.status === STATUS.REQUESTED) throw fail_('invalid', 'Order ' + order.invoice + ' is a new request. Accept it first to send the invoice.');
  if (!emailInvoice_(order, readTypedSettings_())) {
    throw fail_('email_failed', 'The invoice email could not be sent. Please try again later.');
  }
  return { ok: true, order: order, emailed: true };
}

// Greg changes an order that is still waiting for payment: the customer's details, the quantity,
// delivery or collection, and the price and fee for this order (for example a discount).
// The invoice number stays the same and the total is worked out again here.
function editOrder_(body) {
  const invoice = clean_(body.invoice, 32);
  const name = clean_(body.name, 80);
  const contact = clean_(body.contact, 80);
  const email = clean_(body.email, 120);
  const address = clean_(body.address, 300);
  const notes = clean_(body.notes, 300);
  const qty = Number(body.qty);
  const collect = body.collect === true;
  const price = parseNumber_(body.price, NaN);
  const fee = collect ? 0 : parseNumber_(body.fee, NaN);
  // Left out by an older admin page: the collection time stays as it is.
  const keepTime = body.collectAt === undefined;
  const collectAt = collect && !keepTime ? slotText_(body.collectAt) : '';

  if (!name) throw fail_('invalid', 'Please enter a name.');
  if (email && !EMAIL_PATTERN.test(email)) throw fail_('invalid', 'That email address does not look right.');
  if (!isFinite(qty) || Math.floor(qty) !== qty || qty < 1) throw fail_('invalid', 'Please choose a quantity of at least 1.');
  if (!isFinite(price) || price < 0 || price > 100000) throw fail_('invalid', 'Price per sachet must be a number, for example 40.');

  const settings = readTypedSettings_();
  if (qty < settings.minQty) throw fail_('invalid', 'The smallest order is ' + settings.minQty + '.');
  if (qty > settings.maxQty) throw fail_('invalid', 'The most one order can include is ' + settings.maxQty + '.');

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    throw fail_('busy', 'Busy right now. Please try again.');
  }
  let order;
  try {
    const sheet = ordersSheet_();
    const rowNum = findRow_(sheet, invoice);
    if (!rowNum) throw fail_('not_found', 'Order ' + invoice + ' was not found.');
    const row = sheet.getRange(rowNum, 1, 1, HEADERS.length).getValues()[0];
    const status = str_(row[COL.STATUS]);
    if (status !== STATUS.AWAITING && status !== STATUS.REQUESTED) {
      throw fail_('invalid', 'Order ' + str_(row[COL.INVOICE]) + ' is ' + status + '. Only new requests and orders waiting for payment can be edited.');
    }
    // A request keeps its fee blank: the fee is set when Greg accepts it.
    const request = status === STATUS.REQUESTED;
    if (!request && (!isFinite(fee) || fee < 0 || fee > 100000)) {
      throw fail_('invalid', 'Delivery fee must be a number. Use 0 for free delivery.');
    }

    const unit = round2_(price);
    const delivery = request ? 0 : round2_(fee);
    const total = (Math.round(unit * 100) * qty + Math.round(delivery * 100)) / 100;
    row[COL.NAME] = safe_(name);
    row[COL.CONTACT] = safe_(contact);
    row[COL.ADDRESS] = safe_(address);
    row[COL.NOTES] = safe_(notes);
    row[COL.QTY] = qty;
    row[COL.PRICE] = unit;
    row[COL.FEE] = request ? '' : delivery;
    row[COL.TOTAL] = total;
    row[COL.EMAIL] = safe_(email);
    row[COL.COLLECT] = collect ? 'yes' : '';
    row[COL.COLLECT_AT] = collect ? (keepTime ? str_(row[COL.COLLECT_AT]) : collectAt) : '';
    row[COL.EDITED] = nowString_();
    // The whole row is written back with its formats, which also fills in columns older rows lack.
    sheet.getRange(rowNum, 1, 1, HEADERS.length).setNumberFormats([FORMATS]).setValues([row]);
    SpreadsheetApp.flush();
    order = rowToOrder_(row);
  } finally {
    lock.releaseLock();
  }
  const out = { ok: true, order: order };
  if (body.sendInvoice === true && order.email && order.status === STATUS.AWAITING) out.emailed = emailInvoice_(order, settings);
  return out;
}

// ---------------------------------------------------------------------------
// Several orders at once
// ---------------------------------------------------------------------------

const BULK_MAX = 50;
const BULK_OPS = ['paid', 'delivered', 'cancel', 'reopen', 'decline', 'email', 'message'];

// Greg ticks orders and picks one action for all of them. Each order is done on its own, like
// the single actions, so one that cannot be changed does not stop the rest. Before anything
// changes, the emails it would send are checked against what Google still allows today.
function bulk_(body) {
  const op = String(body.op || '');
  if (BULK_OPS.indexOf(op) === -1) throw fail_('bad_request', 'Unknown action.');
  const invoices = (Array.isArray(body.invoices) ? body.invoices : [])
    .map(function (v) { return clean_(v, 32); })
    .filter(function (v, i, all) { return v && all.indexOf(v) === i; });
  if (!invoices.length) throw fail_('invalid', 'Pick at least one order.');
  if (invoices.length > BULK_MAX) throw fail_('invalid', 'Pick at most ' + BULK_MAX + ' orders at a time.');
  const reason = clean_(body.reason, 300);
  const subject = clean_(body.subject, 120);
  const message = cleanMessage_(body.message, 2000);
  if (op === 'message' && !message) throw fail_('invalid', 'Write the message to send.');

  const sheet = ordersSheet_();
  const needed = invoices.filter(function (invoice) {
    const rowNum = findRow_(sheet, invoice);
    return rowNum && emailsFor_(op, rowToOrder_(sheet.getRange(rowNum, 1, 1, HEADERS.length).getValues()[0]));
  }).length;
  const left = MailApp.getRemainingDailyQuota();
  if (needed > left) {
    throw fail_('quota', 'This would send ' + needed + ' emails, but only ' + left + ' can be sent today. Pick fewer orders, or try again tomorrow.', { emailsLeft: left });
  }

  const results = invoices.map(function (invoice) {
    try {
      let out;
      if (op === 'paid') out = setStatus_({ invoice: invoice, status: STATUS.PAID });
      else if (op === 'delivered') out = setStatus_({ invoice: invoice, status: STATUS.DELIVERED });
      else if (op === 'cancel') out = setStatus_({ invoice: invoice, status: STATUS.CANCELLED });
      else if (op === 'reopen') out = setStatus_({ invoice: invoice, status: STATUS.AWAITING });
      else if (op === 'decline') out = declineOrder_({ invoice: invoice, reason: reason });
      else if (op === 'email') out = sendInvoice_({ invoice: invoice });
      else out = messageOrder_(invoice, subject, message);
      return { invoice: invoice, ok: true, order: out.order, emailed: out.emailed };
    } catch (err) {
      if (!err.code) console.error(err && err.stack ? err.stack : String(err));
      return { invoice: invoice, ok: false, message: err.code ? err.publicMessage : 'Something went wrong with this order.' };
    }
  });
  return { ok: true, results: results, emailsLeft: MailApp.getRemainingDailyQuota() };
}

// Whether an action sends this customer an email. The same rules as the single actions.
function emailsFor_(op, o) {
  if (!EMAIL_PATTERN.test(o.email)) return false;
  if (op === 'paid') return o.status === STATUS.AWAITING;
  if (op === 'decline') return o.status === STATUS.REQUESTED;
  if (op === 'cancel') return o.status === STATUS.PAID && hasInvite_(o);
  if (op === 'email') return o.status !== STATUS.CANCELLED && o.status !== STATUS.REQUESTED;
  return op === 'message';
}

// Greg's own message to the customer of one order, for example "Collection moves to 18:00 today".
function messageOrder_(invoice, subject, message) {
  const sheet = ordersSheet_();
  const rowNum = findRow_(sheet, invoice);
  if (!rowNum) throw fail_('not_found', 'Order ' + invoice + ' was not found.');
  const order = rowToOrder_(sheet.getRange(rowNum, 1, 1, HEADERS.length).getValues()[0]);
  if (!EMAIL_PATTERN.test(order.email)) throw fail_('invalid', 'Order ' + order.invoice + ' has no email address.');
  if (!emailMessage_(order, subject, message, readTypedSettings_())) {
    throw fail_('email_failed', 'The email to ' + order.email + ' could not be sent. Please try again later.');
  }
  return { order: order, emailed: true };
}

// Returns true when sent. Never throws.
function emailMessage_(order, subject, message, s) {
  try {
    if (MailApp.getRemainingDailyQuota() < 1) throw new Error('the daily email quota is used up');
    const mail = {
      to: order.email,
      subject: subject || s.brand + ' order ' + order.invoice,
      body: 'Hi ' + order.name + ',\n\n' + message + '\n\n' + s.brand + '\nOrder ' + order.invoice,
      name: s.brand
    };
    if (EMAIL_PATTERN.test(s.alertEmail)) mail.replyTo = s.alertEmail;
    MailApp.sendEmail(mail);
    return true;
  } catch (err) {
    console.error('Message email failed for ' + order.invoice + ': ' + err);
    return false;
  }
}

// Greg moves the collection to another time. Once paid, the customer is emailed an
// updated invite that replaces the event in their calendar.
function setCollectTime_(body) {
  const invoice = clean_(body.invoice, 32);
  const collectAt = slotText_(body.collectAt);
  if (!collectAt) throw fail_('invalid', 'Please pick a collection date and time.');
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    throw fail_('busy', 'Busy right now. Please try again.');
  }
  let order;
  let changed = false;
  try {
    const sheet = ordersSheet_();
    const rowNum = findRow_(sheet, invoice);
    if (!rowNum) throw fail_('not_found', 'Order ' + invoice + ' was not found.');
    const row = sheet.getRange(rowNum, 1, 1, HEADERS.length).getValues()[0];
    const status = str_(row[COL.STATUS]);
    if (str_(row[COL.COLLECT]).toLowerCase() !== 'yes') throw fail_('invalid', 'Order ' + str_(row[COL.INVOICE]) + ' is a delivery, not a collection.');
    if (status === STATUS.CANCELLED) throw fail_('invalid', 'Order ' + str_(row[COL.INVOICE]) + ' is cancelled.');
    changed = str_(row[COL.COLLECT_AT]) !== collectAt;
    if (changed) {
      row[COL.COLLECT_AT] = collectAt;
      sheet.getRange(rowNum, COL.COLLECT_AT + 1).setNumberFormat('@').setValue(collectAt);
      SpreadsheetApp.flush();
    }
    order = rowToOrder_(row);
  } finally {
    lock.releaseLock();
  }
  const out = { ok: true, order: order };
  if (changed && order.status === STATUS.PAID && order.email) out.emailed = emailInvite_(order, readTypedSettings_(), 'update');
  return out;
}

// Greg sets the delivery fee on a new request and accepts it. The customer is then
// emailed the invoice with the bank details.
function acceptOrder_(body) {
  const invoice = clean_(body.invoice, 32);
  const fee = parseNumber_(body.fee, NaN);
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    throw fail_('busy', 'Busy right now. Please try again.');
  }
  let order;
  try {
    const sheet = ordersSheet_();
    const rowNum = findRow_(sheet, invoice);
    if (!rowNum) throw fail_('not_found', 'Order ' + invoice + ' was not found.');
    const row = sheet.getRange(rowNum, 1, 1, HEADERS.length).getValues()[0];
    const status = str_(row[COL.STATUS]);
    if (status !== STATUS.REQUESTED) {
      throw fail_('invalid', 'Order ' + str_(row[COL.INVOICE]) + ' is ' + status + '. Only new requests can be accepted.');
    }
    const collect = str_(row[COL.COLLECT]).toLowerCase() === 'yes';
    if (!collect && (!isFinite(fee) || fee < 0 || fee > 100000)) {
      throw fail_('invalid', 'Delivery fee must be a number. Use 0 for free delivery.');
    }
    const delivery = collect ? 0 : round2_(fee);
    const items = Math.round((Number(row[COL.PRICE]) || 0) * 100) * (Number(row[COL.QTY]) || 0);
    row[COL.FEE] = delivery;
    row[COL.TOTAL] = (items + Math.round(delivery * 100)) / 100;
    row[COL.STATUS] = STATUS.AWAITING;
    sheet.getRange(rowNum, 1, 1, HEADERS.length).setNumberFormats([FORMATS]).setValues([row]);
    SpreadsheetApp.flush();
    order = rowToOrder_(row);
  } finally {
    lock.releaseLock();
  }
  const out = { ok: true, order: order };
  if (order.email) out.emailed = emailInvoice_(order, readTypedSettings_());
  return out;
}

// Greg turns down a new request, for example when the address is too far. The order is
// cancelled (it can be reopened) and the customer is emailed, with his reason if he gave one.
function declineOrder_(body) {
  const invoice = clean_(body.invoice, 32);
  const reason = clean_(body.reason, 300);
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    throw fail_('busy', 'Busy right now. Please try again.');
  }
  let order;
  try {
    const sheet = ordersSheet_();
    const rowNum = findRow_(sheet, invoice);
    if (!rowNum) throw fail_('not_found', 'Order ' + invoice + ' was not found.');
    const row = sheet.getRange(rowNum, 1, 1, HEADERS.length).getValues()[0];
    const status = str_(row[COL.STATUS]);
    if (status !== STATUS.REQUESTED) {
      throw fail_('invalid', 'Order ' + str_(row[COL.INVOICE]) + ' is ' + status + '. Only new requests can be declined.');
    }
    row[COL.STATUS] = STATUS.CANCELLED;
    sheet.getRange(rowNum, COL.STATUS + 1).setValue(STATUS.CANCELLED);
    SpreadsheetApp.flush();
    order = rowToOrder_(row);
  } finally {
    lock.releaseLock();
  }
  const out = { ok: true, order: order };
  if (order.email) out.emailed = emailDecline_(order, reason, readTypedSettings_());
  return out;
}

// Returns true when sent. Never throws.
function emailDecline_(order, reason, s) {
  if (!EMAIL_PATTERN.test(order.email)) return false;
  try {
    if (MailApp.getRemainingDailyQuota() < 1) throw new Error('the daily email quota is used up');
    const lines = ['Hi ' + order.name + ',', '', 'Sorry, we cannot fill your order ' + order.invoice + '.'];
    if (reason) lines.push('', reason);
    lines.push('', 'There is nothing to pay. Reply to this email if you have any questions.', '', s.brand);
    const message = { to: order.email, subject: s.brand + ' order ' + order.invoice, body: lines.join('\n'), name: s.brand };
    if (EMAIL_PATTERN.test(s.alertEmail)) message.replyTo = s.alertEmail;
    MailApp.sendEmail(message);
    return true;
  } catch (err) {
    console.error('Decline email failed for ' + order.invoice + ': ' + err);
    return false;
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
    deliveredOn: str_(r[COL.DELIVERED]),
    email: str_(r[COL.EMAIL]),
    emailedOn: str_(r[COL.EMAILED]),
    collect: str_(r[COL.COLLECT]).toLowerCase() === 'yes',
    editedOn: str_(r[COL.EDITED]),
    collectAt: str_(r[COL.COLLECT_AT])
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
  if (!EMAIL_PATTERN.test(s.alertEmail)) return;
  try {
    const request = order.status === STATUS.REQUESTED;
    if (request) {
      MailApp.sendEmail(s.alertEmail, 'New request ' + order.invoice + ': ' + order.qty + ' x ' + s.product + ', set the delivery fee', [
        order.invoice + ' needs a delivery fee before the customer can pay.',
        '',
        'Name: ' + order.name,
        'Contact: ' + order.contact,
        'Email: ' + order.email,
        'Address: ' + order.address,
        'Notes: ' + (order.notes || '-'),
        'Order: ' + order.qty + ' x ' + s.product + ' at ' + money_(order.price, s.currency) + ' = ' + money_(order.total, s.currency),
        '',
        'Open the admin page, set the delivery fee for this address and accept the request. The customer is then emailed the invoice.'
      ].join('\n'));
      return;
    }
    const subject = 'New order ' + order.invoice + ': ' + order.qty + ' x ' + s.product + ' (' + money_(order.total, s.currency) + ')';
    const lines = [
      order.invoice + ' is waiting for payment.',
      '',
      'Name: ' + order.name,
      'Contact: ' + order.contact,
      order.collect ? 'Collects: ' + collectLine_(order, s) : 'Address: ' + order.address,
      'Notes: ' + (order.notes || '-'),
      'Order: ' + order.qty + ' x ' + s.product + ' at ' + money_(order.price, s.currency),
      order.collect ? 'Collection: free' : 'Delivery: ' + money_(order.fee, s.currency),
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
// Invoice emails
// ---------------------------------------------------------------------------

// Emails the invoice to the customer as a PDF and notes the time on the order.
// extra: more attachments, such as the calendar invite for a paid collection.
// Returns true when sent. Never throws: a failed email must not fail the order.
function emailInvoice_(order, s, extra) {
  const invite = !!(extra && extra.length);
  if (!EMAIL_PATTERN.test(order.email)) return false;
  try {
    if (MailApp.getRemainingDailyQuota() < 1) throw new Error('the daily email quota is used up');
    const pdf = Utilities.newBlob(invoiceHtml_(order, s), 'text/html', order.invoice + '.html')
      .getAs('application/pdf')
      .setName(order.invoice + '.pdf');
    const message = {
      to: order.email,
      subject: s.brand + ' invoice ' + order.invoice + (isPaid_(order) ? ' (paid)' : ''),
      body: 'Hi ' + order.name + ',\n\nYour invoice is attached.' +
        (invite ? ' So is a calendar invite for your collection on ' + formatSlot_(order.collectAt) + '.\n' +
          'Using Google Calendar? Add it here: ' + googleCalendarLink_(order, s) : '') +
        '\n\n' + invoiceText_(order, s),
      name: s.brand,
      attachments: [pdf].concat(extra || [])
    };
    // Mail comes from the account that deployed the script. Replies go to Greg.
    if (EMAIL_PATTERN.test(s.alertEmail)) message.replyTo = s.alertEmail;
    MailApp.sendEmail(message);
  } catch (err) {
    console.error('Invoice email failed for ' + order.invoice + ': ' + err);
    return false;
  }
  order.emailedOn = nowString_();
  try {
    const sheet = ordersSheet_();
    const rowNum = findRow_(sheet, order.invoice);
    if (rowNum) sheet.getRange(rowNum, COL.EMAILED + 1).setNumberFormat('@').setValue(order.emailedOn);
  } catch (err) {
    console.error('Could not note the invoice email for ' + order.invoice + ': ' + err);
  }
  return true;
}

function isPaid_(order) {
  return order.status === STATUS.PAID || order.status === STATUS.DELIVERED;
}

// The same wording as the invoice Greg copies into DMs (invoiceText in docs/shared.js).
function invoiceText_(o, s) {
  const paid = isPaid_(o);
  const b = s.bank;
  const lines = [
    s.brand.toUpperCase(),
    'Invoice ' + o.invoice + (paid ? ' (PAID)' : ''),
    'Date: ' + formatDay_(o.created)
  ];
  if (paid && o.paidOn) lines.push('Paid: ' + formatDay_(o.paidOn));
  lines.push('', 'For: ' + o.name);
  lines.push(o.qty + ' x ' + s.product + ' @ ' + money_(o.price, s.currency) + ' = ' + money_(lineTotal_(o), s.currency));
  lines.push(o.collect ? 'Collection: free' : 'Delivery: ' + (o.fee > 0 ? money_(o.fee, s.currency) : 'free'));
  lines.push((paid ? 'Total paid: ' : 'Total due: ') + money_(o.total, s.currency));
  if (o.collect) lines.push('', 'Collecting: ' + collectLine_(o, s));
  if (paid) {
    lines.push('', 'Thank you for your order.');
  } else {
    lines.push('', 'Pay by bank transfer');
    if (b.name) lines.push('Bank: ' + b.name);
    if (b.holder) lines.push('Account holder: ' + b.holder);
    if (b.number) lines.push('Account number: ' + b.number);
    if (b.branch) lines.push('Branch code: ' + b.branch);
    if (b.type) lines.push('Account type: ' + b.type);
    lines.push('Amount: ' + money_(o.total, s.currency));
    lines.push('Reference: ' + o.invoice);
    if (s.paymentNote) lines.push('', s.paymentNote);
  }
  return lines.join('\n');
}

// The PDF invoice, written as HTML for Apps Script to convert. Every value is escaped.
function invoiceHtml_(o, s) {
  const paid = isPaid_(o);
  const b = s.bank;
  const m = function (n) { return esc_(money_(n, s.currency)); };
  const detail = function (label, value) {
    return value ? '<tr><td class="k">' + esc_(label) + '</td><td>' + esc_(value) + '</td></tr>' : '';
  };

  const parts = [];
  parts.push(
    '<html><head><meta charset="utf-8"><style>',
    'body{font-family:Arial,Helvetica,sans-serif;color:#111111;font-size:11pt;margin:32px}',
    'h1{font-size:20pt;margin:0;letter-spacing:0}',
    '.top{border-bottom:2px solid #111111;padding-bottom:12px;margin-bottom:20px}',
    '.no{font-size:16pt;font-weight:bold;margin:6px 0 0}',
    '.stamp{color:#ffffff;background:#111111;padding:2px 8px;font-size:10pt}',
    'table{border-collapse:collapse;width:100%;margin:12px 0}',
    'td,th{padding:7px 4px;text-align:left;border-bottom:1px solid #dddddd}',
    'th{font-size:9pt;color:#555555;text-transform:uppercase}',
    '.r{text-align:right}',
    '.total td{font-weight:bold;font-size:13pt;border-bottom:none}',
    '.k{color:#555555;width:40%}',
    'h2{font-size:13pt;margin:24px 0 4px}',
    'p{margin:4px 0}',
    '.note{color:#555555;font-size:10pt;margin-top:16px}',
    '</style></head><body>'
  );
  parts.push(
    '<div class="top"><h1>' + esc_(s.brand.toUpperCase()) + '</h1>',
    '<p class="no">Invoice ' + esc_(o.invoice) + (paid ? ' <span class="stamp">PAID</span>' : '') + '</p>',
    '<p>Date: ' + esc_(formatDay_(o.created)) + '</p>',
    paid && o.paidOn ? '<p>Paid: ' + esc_(formatDay_(o.paidOn)) + '</p>' : '',
    '</div>'
  );
  parts.push('<p><strong>For:</strong> ' + esc_(o.name) + '</p>');
  if (o.collect) parts.push('<p><strong>Collecting:</strong> ' + esc_(collectLine_(o, s)) + '</p>');
  else if (o.address) parts.push('<p><strong>Deliver to:</strong> ' + esc_(o.address) + '</p>');
  parts.push(
    '<table><tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Amount</th></tr>',
    '<tr><td>' + esc_(s.product) + '</td><td class="r">' + o.qty + '</td><td class="r">' + m(o.price) + '</td><td class="r">' + m(lineTotal_(o)) + '</td></tr>',
    '<tr><td>' + (o.collect ? 'Collection' : 'Delivery') + '</td><td></td><td></td><td class="r">' + (o.fee > 0 ? m(o.fee) : 'Free') + '</td></tr>',
    '<tr class="total"><td>' + (paid ? 'Total paid' : 'Total due') + '</td><td></td><td></td><td class="r">' + m(o.total) + '</td></tr>',
    '</table>'
  );
  if (paid) {
    parts.push('<h2>Thank you for your order.</h2>');
  } else {
    parts.push(
      '<h2>Pay by bank transfer</h2><table>',
      detail('Bank', b.name), detail('Account holder', b.holder), detail('Account number', b.number),
      detail('Branch code', b.branch), detail('Account type', b.type),
      detail('Amount', money_(o.total, s.currency)), detail('Reference', o.invoice),
      '</table>'
    );
    if (s.paymentNote) parts.push('<p class="note">' + esc_(s.paymentNote) + '</p>');
  }
  parts.push('</body></html>');
  return parts.join('');
}

// "Tue 3 Nov, 17:30, Sea Point", or just the place when no time is set.
function collectLine_(o, s) {
  return (o.collectAt ? formatSlot_(o.collectAt) + ', ' : '') + s.collectNote;
}

// ---------------------------------------------------------------------------
// Calendar invites
// ---------------------------------------------------------------------------

// Every order keeps one event (the same UID), so an update or a cancellation replaces
// the event in the customer's calendar instead of adding another.
function hasInvite_(order) {
  return order.collect && SLOT_PATTERN.test(order.collectAt);
}

// Start and end of the collection, in milliseconds since 1970 (UTC).
function collectRange_(o, s) {
  const m = SLOT_PATTERN.exec(o.collectAt);
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) - COLLECT_UTC_OFFSET * 3600000;
  return { start: start, end: start + s.slots.step * 60000 };
}

// method: REQUEST for a new or moved time, CANCEL to remove it.
// Without an email for Greg there is no organiser, so the invite is published instead.
function inviteIcs_(o, s, method) {
  const cancel = method === 'CANCEL';
  const organiser = EMAIL_PATTERN.test(s.alertEmail);
  const r = collectRange_(o, s);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//' + icsText_(s.brand) + '//Orders//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:' + (organiser ? method : 'PUBLISH'),
    'BEGIN:VEVENT',
    'UID:' + o.invoice + '@supajuice.github.io',
    // Always higher than the last one sent, so calendars take the newest version.
    'SEQUENCE:' + Math.floor(Date.now() / 1000),
    'DTSTAMP:' + icsTime_(Date.now()),
    'DTSTART:' + icsTime_(r.start),
    'DTEND:' + icsTime_(r.end),
    'SUMMARY:' + icsText_('Collect ' + s.brand + ' order ' + o.invoice),
    'LOCATION:' + icsText_(s.collectNote),
    'DESCRIPTION:' + icsText_(o.qty + ' x ' + s.product + '. Reply to the invoice email if you need another time.'),
    'STATUS:' + (cancel ? 'CANCELLED' : 'CONFIRMED')
  ];
  if (organiser) {
    lines.push('ORGANIZER;CN=' + icsName_(s.brand) + ':mailto:' + s.alertEmail);
    lines.push('ATTENDEE;CN=' + icsName_(o.name) + ';ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:' + o.email);
  }
  if (!cancel) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsText_('Collect your ' + s.brand + ' order'), 'TRIGGER:-PT1H', 'END:VALARM');
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(icsFold_).join('\r\n') + '\r\n';
}

function inviteBlob_(o, s, method) {
  return Utilities.newBlob(inviteIcs_(o, s, method), 'text/calendar; charset=utf-8; method=' + method, 'invite.ics');
}

// 20261103T153000Z
function icsTime_(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

// Text values escape backslashes, semicolons, commas and line breaks.
function icsText_(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// A name inside a property, in quotes, which cannot hold quotes or line breaks.
function icsName_(v) {
  return '"' + String(v).replace(/["\r\n]/g, '') + '"';
}

// Lines longer than 75 characters continue on the next line after a space.
function icsFold_(line) {
  const out = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = ' ' + rest.slice(74);
  }
  out.push(rest);
  return out.join('\r\n');
}

function googleCalendarLink_(o, s) {
  const r = collectRange_(o, s);
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
    '&text=' + encodeURIComponent('Collect ' + s.brand + ' order ' + o.invoice) +
    '&dates=' + icsTime_(r.start) + '/' + icsTime_(r.end) +
    '&location=' + encodeURIComponent(s.collectNote) +
    '&details=' + encodeURIComponent(o.qty + ' x ' + s.product);
}

// kind: 'update' for a new time, 'cancel' when the order is cancelled. Returns true when sent. Never throws.
function emailInvite_(order, s, kind) {
  if (!EMAIL_PATTERN.test(order.email) || !hasInvite_(order)) return false;
  try {
    if (MailApp.getRemainingDailyQuota() < 1) throw new Error('the daily email quota is used up');
    const cancel = kind === 'cancel';
    const when = formatSlot_(order.collectAt);
    const lines = ['Hi ' + order.name + ',', ''];
    if (cancel) {
      lines.push('Your collection of order ' + order.invoice + ' on ' + when + ' is cancelled. The attached update removes it from your calendar.');
    } else {
      lines.push('Your collection of order ' + order.invoice + ' is now on ' + when + ' at ' + s.collectNote + '.',
        '', 'The attached invite updates your calendar.',
        'Using Google Calendar? Add the new time here: ' + googleCalendarLink_(order, s));
    }
    lines.push('', 'Reply to this email if you have any questions.', '', s.brand);
    const message = {
      to: order.email,
      subject: s.brand + (cancel ? ' collection cancelled: ' : ' new collection time: ') + order.invoice,
      body: lines.join('\n'),
      name: s.brand,
      attachments: [inviteBlob_(order, s, cancel ? 'CANCEL' : 'REQUEST')]
    };
    if (EMAIL_PATTERN.test(s.alertEmail)) message.replyTo = s.alertEmail;
    MailApp.sendEmail(message);
    return true;
  } catch (err) {
    console.error('Invite email failed for ' + order.invoice + ': ' + err);
    return false;
  }
}

function lineTotal_(o) {
  return Math.round(o.price * 100) * o.qty / 100;
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
  let weekdays = '';
  if (last >= 2) {
    sheet.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
      const key = str_(r[0]);
      if (Object.prototype.hasOwnProperty.call(values, key)) values[key] = str_(r[1]);
      else if (key === 'collection_days') weekdays = str_(r[1]);
    });
  }
  // Collection is always offered, so these fall back to their defaults when left blank in the sheet.
  NEVER_BLANK.forEach(function (key) {
    if (values[key] === '') values[key] = SETTING_DEFS.filter(function (d) { return d.key === key; })[0].value;
  });
  // Until Greg ticks dates, the next 30 days on his old collection weekdays (Monday to Saturday by default).
  if (values.collection_dates === '') values.collection_dates = datesOnWeekdays_(weekdays || 'mon,tue,wed,thu,fri,sat');
  return values;
}

const NEVER_BLANK = ['collection_note', 'collection_hours', 'collection_slot_minutes', 'collection_per_slot'];
// Settings from earlier versions. setup marks their rows as no longer used.
const OLD_SETTINGS = ['collection_days', 'collection_days_ahead', 'delivery_area'];

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
  const maxQty = Math.min(200, Math.max(1, Math.floor(parseNumber_(raw.max_quantity, 20))));
  return {
    brand: raw.brand_name || 'Supa Juice',
    product: raw.product_name || 'Running gel sachet',
    price: price,
    fee: fee,
    currency: raw.currency_symbol || 'R',
    collectNote: raw.collection_note,
    quote: String(raw.delivery_quote).toLowerCase() !== 'no',
    // A minimum above the maximum (possible by editing the sheet) is pulled down to the maximum.
    minQty: Math.min(maxQty, Math.max(1, Math.floor(parseNumber_(raw.min_quantity, 1)))),
    maxQty: maxQty,
    prefix: (raw.invoice_prefix || 'SJ').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'SJ',
    alertEmail: raw.alert_email,
    bank: bank,
    paymentNote: raw.payment_note,
    slots: readSlots_(raw),
    photo: publicPhoto_(photoMeta_()),
    ready: price > 0 && !!bank.name && !!bank.holder && !!bank.number
  };
}

// What anyone may see. No bank details: customers get those after they order.
// slots: the free collection times, sent only to the order page.
function publicConfig_(s, slots) {
  return {
    brand: s.brand,
    product: s.product,
    price: s.price,
    fee: s.fee,
    currency: s.currency,
    collectNote: s.collectNote, // where customers collect
    quote: s.quote, // true: the delivery fee is confirmed by Greg after the customer orders
    minQty: s.minQty,
    maxQty: s.maxQty,
    photo: s.photo, // { version, alt } or null. The picture itself comes from the "photo" action.
    collectSlots: slots, // [{ date, label, times }], the free collection times
    collectAhead: COLLECT_WINDOW_DAYS,
    ready: s.ready
  };
}

function customerConfig_() {
  const s = readTypedSettings_();
  return publicConfig_(s, freeSlots_(s, ordersSheet_()));
}

function adminConfig_(s) {
  const c = publicConfig_(s);
  c.prefix = s.prefix;
  c.alertEmail = s.alertEmail;
  c.bank = s.bank;
  c.paymentNote = s.paymentNote;
  c.collectStep = s.slots.step;
  // The next 30 dates for the settings calendar, and how many of them Greg has ticked.
  c.collectWindow = collectWindow_().map(function (d) { return { date: d.date, label: d.label, weekday: d.weekday }; });
  c.collectDatesLeft = s.slots.dates.length;
  c.collectLastDate = s.slots.dates.length ? s.slots.dates[s.slots.dates.length - 1] : '';
  // Every time on the ticked dates, full ones included, for Greg's DM orders.
  c.collectSlotsAll = allSlots_(s, ordersSheet_());
  return c;
}

function saveSettings_(body) {
  const incoming = body.values;
  if (!incoming || typeof incoming !== 'object') throw fail_('bad_request', 'No settings to save.');

  const checked = {};
  SETTING_DEFS.forEach(function (d) {
    if (Object.prototype.hasOwnProperty.call(incoming, d.key)) checked[d.key] = validateSetting_(d.key, incoming[d.key]);
  });

  // The two limits are checked together, using the saved value for whichever one is not being changed.
  if (checked.min_quantity !== undefined || checked.max_quantity !== undefined) {
    const saved = readSettings_();
    const min = Number(checked.min_quantity !== undefined ? checked.min_quantity : saved.min_quantity);
    const max = Number(checked.max_quantity !== undefined ? checked.max_quantity : saved.max_quantity);
    if (min > max) throw fail_('invalid', 'Fewest per order cannot be more than most per order.');
  }

  // At least one collection time has to fit inside the collection hours.
  if (checked.collection_hours !== undefined || checked.collection_slot_minutes !== undefined) {
    const saved = readSettings_();
    const hours = parseHours_(checked.collection_hours !== undefined ? checked.collection_hours : saved.collection_hours);
    const step = Number(checked.collection_slot_minutes !== undefined ? checked.collection_slot_minutes : saved.collection_slot_minutes);
    if (hours && hours.end - hours.start < step) throw fail_('invalid', 'The usual times are shorter than one collection time.');
  }

  // The same for every time set on a date.
  if (checked.collection_dates !== undefined || checked.collection_slot_minutes !== undefined) {
    const saved = readSettings_();
    const step = Number(checked.collection_slot_minutes !== undefined ? checked.collection_slot_minutes : saved.collection_slot_minutes);
    const picked = parseDates_(checked.collection_dates !== undefined ? checked.collection_dates : saved.collection_dates, step) || {};
    Object.keys(picked).forEach(function (date) {
      (picked[date] || []).forEach(function (r) {
        if (r.end - r.start < step) {
          throw fail_('invalid', clock_(r.start) + '-' + clock_(r.end) + ' on ' + dayOf_(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8)))).label + ' is shorter than one collection time.');
        }
      });
    });
  }

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
    case 'delivery_quote': {
      const t = text.toLowerCase();
      if (t === 'yes' || t === 'true') return 'yes';
      if (t === 'no' || t === 'false') return 'no';
      throw fail_('invalid', 'Confirm the delivery fee for each order must be yes or no.');
    }
    case 'min_quantity': {
      if (text === '') return '1';
      const n = parseNumber_(text, NaN);
      if (!isFinite(n) || Math.floor(n) !== n || n < 1 || n > 200) throw fail_('invalid', 'Fewest per order must be a whole number from 1 to 200.');
      return String(n);
    }
    case 'max_quantity': {
      const n = parseNumber_(text, NaN);
      if (!isFinite(n) || Math.floor(n) !== n || n < 1 || n > 200) throw fail_('invalid', 'Most per order must be a whole number from 1 to 200.');
      return String(n);
    }
    case 'collection_note':
      if (text === '') throw fail_('invalid', 'Collection place cannot be blank.');
      return text;
    case 'collection_dates': {
      const picked = parseDates_(text);
      if (!picked) throw fail_('invalid', 'Collection times must look like 2026-11-03 17:00-19:00, each ending after it starts.');
      // Only dates customers can still book are kept, in date order, each with its times in order.
      const entries = collectWindow_().filter(function (d) { return picked[d.date] !== undefined; }).map(function (d) {
        const ranges = picked[d.date];
        return ranges ? d.date + ' ' + ranges.map(function (r) { return clock_(r.start) + '-' + clock_(r.end); }).join(' ') : d.date;
      });
      if (!entries.length) throw fail_('invalid', 'Pick at least one collection date and time.');
      return entries.join(',');
    }
    case 'collection_hours': {
      const h = parseHours_(text);
      if (!h) throw fail_('invalid', 'Collection hours must look like 17:00-19:00, with the start before the end.');
      return clock_(h.start) + '-' + clock_(h.end);
    }
    case 'collection_slot_minutes': {
      const n = parseNumber_(text, NaN);
      if ([15, 30, 60].indexOf(n) === -1) throw fail_('invalid', 'A collection time must be 15, 30 or 60 minutes.');
      return String(n);
    }
    case 'collection_per_slot': {
      const n = parseNumber_(text, NaN);
      if (!isFinite(n) || Math.floor(n) !== n || n < 1 || n > 20) throw fail_('invalid', 'Collections per time must be a whole number from 1 to 20.');
      return String(n);
    }
    case 'invoice_prefix':
      if (!/^[A-Za-z0-9]{1,6}$/.test(text)) throw fail_('invalid', 'Invoice prefix must be 1 to 6 letters or digits.');
      return text.toUpperCase();
    case 'alert_email':
      if (text !== '' && !EMAIL_PATTERN.test(text)) throw fail_('invalid', 'That email address does not look right.');
      return text;
    case 'brand_name':
    case 'product_name':
    case 'currency_symbol':
      if (text === '') throw fail_('invalid', 'Brand, product and currency cannot be blank.');
      return text;
    default:
      return text;
  }
}

// ---------------------------------------------------------------------------
// Collection times
// ---------------------------------------------------------------------------

// Times are Cape Town wall-clock text, "2026-11-03 17:30". Dates are worked out with
// UTC arithmetic so the server's time zone never shifts a day.
const SLOT_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Cape Town is UTC+2 all year: South Africa has no daylight saving.
const COLLECT_UTC_OFFSET = 2;
const DAY_MS = 86400000;
// Customers can book from tomorrow up to this many days ahead, on the dates Greg ticks.
const COLLECT_WINDOW_DAYS = 30;

// "17:00-19:00" -> { start: 1020, end: 1140 } in minutes, or null.
function parseHours_(text) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(str_(text));
  if (!m) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (Number(m[1]) > 23 || Number(m[3]) > 23 || Number(m[2]) > 59 || Number(m[4]) > 59 || start >= end) return null;
  return { start: start, end: end };
}

function clock_(minutes) {
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}

// The next 30 days, from tomorrow: [{ date, label, weekday }].
function collectWindow_() {
  const today = SLOT_PATTERN.exec(nowString_());
  const base = Date.UTC(Number(today[1]), Number(today[2]) - 1, Number(today[3]));
  const out = [];
  for (let i = 1; i <= COLLECT_WINDOW_DAYS; i++) out.push(dayOf_(base + i * DAY_MS));
  return out;
}

// "mon,tue" -> the dates in the next 30 days that fall on those weekdays.
function datesOnWeekdays_(text) {
  const days = String(text).toLowerCase().split(/[\s,]+/).map(function (d) { return DAY_KEYS.indexOf(d); });
  return collectWindow_().filter(function (d) { return days.indexOf(d.weekday) !== -1; })
    .map(function (d) { return d.date; }).join(',');
}

// The settings as numbers. Unreadable hours or lengths fall back to the defaults.
// dates: the ticked dates customers can still book, in order.
function readSlots_(raw) {
  let step = parseNumber_(raw.collection_slot_minutes, 30);
  if ([15, 30, 60].indexOf(step) === -1) step = 30;
  let hours = parseHours_(raw.collection_hours);
  if (!hours || hours.end - hours.start < step) hours = parseHours_('17:00-19:00');
  // Each date's times: every From-To split into collection times, one length apart and ending by To.
  // A date on its own uses the usual times.
  const picked = parseDates_(raw.collection_dates, step) || {};
  const times = {};
  const dates = [];
  collectWindow_().forEach(function (d) {
    if (picked[d.date] === undefined) return;
    const list = [];
    (picked[d.date] || [hours]).forEach(function (r) {
      for (let m = r.start; m + step <= r.end; m += step) if (list.indexOf(clock_(m)) === -1) list.push(clock_(m));
    });
    list.sort();
    if (!list.length) return;
    times[d.date] = list;
    dates.push(d.date);
  });
  return {
    dates: dates,
    times: times,
    step: step,
    perSlot: Math.min(20, Math.max(1, Math.floor(parseNumber_(raw.collection_per_slot, 1))))
  };
}

// "2026-11-03 07:00-08:00 17:00-19:00, 2026-11-04" ->
//   { '2026-11-03': [{ start: 420, end: 480 }, { start: 1020, end: 1140 }], '2026-11-04': null }
// Times are in minutes, sorted. null means the usual times. A single time such as 17:30 (from an
// earlier version) is one collection time long. Returns null when anything does not make sense.
function parseDates_(text, step) {
  const out = {};
  let ok = true;
  String(text || '').split(',').forEach(function (entry) {
    const parts = entry.trim().split(/\s+/).filter(String);
    if (!parts.length) return;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0]);
    const real = m && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDate() === Number(m[3]);
    const ranges = parts.slice(1).map(function (token) {
      const r = parseHours_(token);
      if (r) return r;
      const single = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(token);
      if (!single) return null;
      const start = Number(single[1]) * 60 + Number(single[2]);
      return { start: start, end: start + (step || 30) };
    });
    if (!real || ranges.some(function (r) { return !r; })) {
      ok = false;
      return;
    }
    ranges.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    out[parts[0]] = ranges.length ? ranges.filter(function (r, i) {
      return !i || r.start !== ranges[i - 1].start || r.end !== ranges[i - 1].end;
    }) : null;
  });
  return ok ? out : null;
}

// "2026-11-03 17:30" as text, '' for blank. Throws for anything else.
function slotText_(v) {
  const text = str_(v);
  if (!text) return '';
  const m = SLOT_PATTERN.exec(text);
  const d = m && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (!m || d.getUTCDate() !== Number(m[3]) || Number(m[4]) > 23 || Number(m[5]) > 59) {
    throw fail_('invalid', 'That collection time does not look right.');
  }
  return text;
}

function dayOf_(ms) {
  const d = new Date(ms);
  return {
    date: d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'),
    label: DAY_NAMES[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()],
    weekday: d.getUTCDay()
  };
}

// "2026-11-03 17:30" -> "Tue 3 Nov, 17:30"
function formatSlot_(text) {
  const m = SLOT_PATTERN.exec(text || '');
  if (!m) return str_(text);
  return dayOf_(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).label + ', ' + m[4] + ':' + m[5];
}

// How many open collection orders hold each time.
function bookedCounts_(sheet) {
  const counts = {};
  const last = sheet.getLastRow();
  if (last < 2) return counts;
  const first = Math.max(2, last - 999);
  sheet.getRange(first, 1, last - first + 1, HEADERS.length).getValues().forEach(function (r) {
    const at = str_(r[COL.COLLECT_AT]);
    if (!at || str_(r[COL.COLLECT]).toLowerCase() !== 'yes' || str_(r[COL.STATUS]) === STATUS.CANCELLED) return;
    counts[at] = (counts[at] || 0) + 1;
  });
  return counts;
}

// Every time on the ticked dates, grouped by day, with the ones already booked up:
// [{ date: '2026-11-03', label: 'Tue 3 Nov', times: ['17:00', '17:30'], full: ['17:00'] }]
function allSlots_(s, sheet) {
  const slots = s.slots;
  const booked = bookedCounts_(sheet);
  const out = [];
  collectWindow_().forEach(function (day) {
    if (slots.dates.indexOf(day.date) === -1) return;
    const times = slots.times[day.date];
    const full = times.filter(function (t) { return (booked[day.date + ' ' + t] || 0) >= slots.perSlot; });
    out.push({ date: day.date, label: day.label, times: times.slice(), full: full });
  });
  return out;
}

// The times customers can still book: [{ date: '2026-11-03', label: 'Tue 3 Nov', times: ['17:30'] }]
function freeSlots_(s, sheet) {
  return allSlots_(s, sheet).map(function (d) {
    return { date: d.date, label: d.label, times: d.times.filter(function (t) { return d.full.indexOf(t) === -1; }) };
  }).filter(function (d) { return d.times.length; });
}

function slotIsFree_(free, text) {
  const date = text.slice(0, 10);
  const time = text.slice(11);
  return free.some(function (d) { return d.date === date && d.times.indexOf(time) !== -1; });
}

// ---------------------------------------------------------------------------
// Order page photo
// ---------------------------------------------------------------------------

// One photo, kept in a hidden "Photo" tab as base64 text, so no Google Drive permission is needed.
//   A1        what the tab is for
//   A2        { type, alt, version, pieces } as JSON
//   A3 down   the picture, in pieces, because one cell holds at most 50,000 characters
// The admin page shrinks the photo before sending it, so it is normally 100 to 300 KB.
const PHOTO_TAB = 'Photo';
const PHOTO_MAX_BYTES = 600 * 1024;
const PHOTO_PIECE = 45000;
// The first bytes of each kind of image, to check a file is what it says it is.
const PHOTO_TYPES = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/webp': [0x52, 0x49, 0x46, 0x46]
};

// The stored { type, alt, version, pieces }, or null when there is no photo.
function photoMeta_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss && ss.getSheetByName(PHOTO_TAB);
  if (!sheet || sheet.getLastRow() < 3) return null;
  const text = str_(sheet.getRange(2, 1).getValue());
  let meta = null;
  try {
    meta = JSON.parse(text);
  } catch (err) {
    return null; // edited by hand: treat as no photo rather than break the order page
  }
  return meta && meta.version && meta.pieces > 0 ? meta : null;
}

// What the pages need to know without downloading the picture. The version changes with every new photo.
// The size lets the order page keep the right space free while the picture loads.
function publicPhoto_(meta) {
  if (!meta) return null;
  const out = { version: meta.version, alt: meta.alt || '' };
  if (meta.width && meta.height) {
    out.width = meta.width;
    out.height = meta.height;
  }
  return out;
}

function readPhoto_() {
  const meta = photoMeta_();
  if (!meta) return null;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PHOTO_TAB);
  const data = sheet.getRange(3, 1, meta.pieces, 1).getValues().map(function (r) { return String(r[0]); }).join('');
  return { version: meta.version, alt: meta.alt || '', type: meta.type, data: data };
}

// Saves a new photo, or with no data, changes only the description of the current one.
function setPhoto_(body) {
  const alt = clean_(body.alt, 150);
  const hasData = body.data !== undefined && body.data !== null && body.data !== '';
  const type = String(body.type || '');
  let data = '';
  if (hasData) {
    if (!PHOTO_TYPES[type]) throw fail_('invalid', 'The photo must be a JPEG, PNG or WebP image.');
    data = String(body.data).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw fail_('invalid', 'The photo could not be read. Please try another one.');
    if (Math.floor(data.length * 3 / 4) > PHOTO_MAX_BYTES) throw fail_('invalid', 'The photo is too large. Please choose a smaller one.');
    let bytes;
    try {
      bytes = Utilities.base64Decode(data);
    } catch (err) {
      throw fail_('invalid', 'The photo could not be read. Please try another one.');
    }
    const magic = PHOTO_TYPES[type];
    for (let i = 0; i < magic.length; i++) {
      if (((bytes[i] || 0) & 0xff) !== magic[i]) throw fail_('invalid', 'That file is not a JPEG, PNG or WebP image.');
    }
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    throw fail_('busy', 'Busy right now. Please try again.');
  }
  let meta;
  try {
    const current = photoMeta_();
    if (!hasData && !current) throw fail_('invalid', 'Add a photo first.');
    const sheet = photoSheet_();
    if (hasData) {
      const pieces = [];
      for (let i = 0; i < data.length; i += PHOTO_PIECE) pieces.push([data.slice(i, i + PHOTO_PIECE)]);
      const last = sheet.getLastRow();
      if (last >= 3) sheet.getRange(3, 1, last - 2, 1).clearContent();
      sheet.getRange(3, 1, pieces.length, 1).setNumberFormat('@').setValues(pieces);
      meta = { type: type, alt: alt, version: Utilities.getUuid().replace(/-/g, '').slice(0, 12), pieces: pieces.length };
      const width = Number(body.width);
      const height = Number(body.height);
      if (Math.floor(width) === width && Math.floor(height) === height && width >= 1 && height >= 1 && width <= 10000 && height <= 10000) {
        meta.width = width;
        meta.height = height;
      }
    } else {
      meta = Object.assign({}, current, { alt: alt });
    }
    sheet.getRange(2, 1).setNumberFormat('@').setValue(JSON.stringify(meta));
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, photo: publicPhoto_(meta) };
}

function removePhoto_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss && ss.getSheetByName(PHOTO_TAB);
  if (sheet && sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).clearContent();
    SpreadsheetApp.flush();
  }
  return { ok: true, photo: null };
}

// The Photo tab, made the first time a photo is saved and hidden so it stays out of the way.
function photoSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(PHOTO_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(PHOTO_TAB);
    sheet.getRange(1, 1).setValue('The order page photo, stored as text. Change it from the admin page, not here.');
    sheet.hideSheet();
  }
  return sheet;
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

// Longer text that keeps its line breaks, such as a message to customers.
function cleanMessage_(v, max) {
  let s = v === null || v === undefined ? '' : String(v);
  s = s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F\u2028\u2029]+/g, ' ');
  s = s.split('\n').map(function (line) { return line.replace(/\s+/g, ' ').trim(); }).join('\n');
  return s.replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-10-28 15:41" -> "28 Oct 2026"
function formatDay_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  return m ? Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1] : str_(s);
}

// Text for HTML.
function esc_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
  [110, 130, 70, 160, 160, 260, 200, 50, 80, 90, 80, 120, 130, 130, 120, 200, 130, 70, 130, 130].forEach(function (w, i) {
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
  // Settings this version no longer reads stay in the sheet, marked so they can be deleted.
  if (last >= 2) {
    settings.getRange(2, 1, last - 1, 1).getValues().forEach(function (r, i) {
      if (OLD_SETTINGS.indexOf(str_(r[0])) !== -1) settings.getRange(i + 2, 3).setValue('No longer used. You can delete this row.');
    });
  }
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
