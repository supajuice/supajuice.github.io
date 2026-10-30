'use strict';
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGas } = require('./gas-mock');

let seq = 0;
const rid = () => 'req_' + String(++seq).padStart(6, '0') + 'abcd';

const BANK = {
  bank_name: 'Test Bank', account_holder: 'G Bolus', account_number: '0012345678',
  branch_code: '250655', account_type: 'Cheque'
};

// A configured system: price 40, delivery 30, bank details set, alerts on.
function ready() {
  const gas = createGas();
  gas.run('setup()');
  const key = gas.key();
  const saved = gas.call(Object.assign(
    { action: 'saveSettings', key },
    { values: Object.assign({ price: '40', delivery_fee: '30', alert_email: 'greg@example.com' }, BANK) }
  ));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  return { gas, key };
}

const order = (over) => Object.assign({
  action: 'order', name: 'Jane Doe', contact: '@jane', email: 'jane@example.com', address: '12 Beach Rd, Sea Point',
  notes: '', qty: 3, areaConfirmed: true, requestId: rid(), expectedTotal: 150, website: ''
}, over);

const dm = (key, over) => Object.assign({
  action: 'create', key, name: 'Sam', contact: '', address: '', notes: '', qty: 2, requestId: rid()
}, over);

function wipeOrders(gas) {
  const s = gas.sheet('Orders');
  for (const k of [...s.cells.keys()]) if (Number(k.split(',')[0]) >= 2) s.cells.delete(k);
}

test('setup creates the tabs, defaults and an admin key, and is safe to repeat', () => {
  const gas = createGas();
  gas.run('setup()');
  assert.ok(gas.sheet('Orders'));
  assert.ok(gas.sheet('Settings'));
  assert.equal(gas.sheet('Sheet1'), null, 'empty default tab removed');
  const header = gas.sheet('Orders').getRange(1, 1, 1, 15).getValues()[0];
  assert.equal(header[0], 'Invoice');
  assert.equal(header[14], 'Request ID');
  assert.equal(gas.sheet('Orders').getRange(1, 16, 1, 2).getValues()[0].join('|'), 'Email|Invoice emailed');
  const key = gas.key();
  assert.match(key, /^[0-9a-f]{64}$/);

  // Hand-edit a setting, run setup again: value and key survive.
  const settings = gas.rows('Settings');
  const brandRow = settings.findIndex((r) => r.Key === 'brand_name') + 2;
  gas.sheet('Settings').getRange(brandRow, 2).setValue('Hand Edited');
  gas.run('setup()');
  assert.equal(gas.key(), key);
  assert.equal(gas.rows('Settings').find((r) => r.Key === 'brand_name').Value, 'Hand Edited');
  assert.equal(gas.rows('Settings').filter((r) => r.Key === 'price').length, 1, 'no duplicate rows');
});

test('orders are refused until price and bank details are set', () => {
  const gas = createGas();
  gas.run('setup()');
  const cfg = gas.call({ action: 'config' });
  assert.equal(cfg.ok, true);
  assert.equal(cfg.config.ready, false);
  const r = gas.call(order());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_ready');
  assert.equal(gas.rows('Orders').length, 0);
});

test('public config shows the price but no bank details', () => {
  const { gas } = ready();
  const cfg = gas.call({ action: 'config' }).config;
  assert.deepEqual(cfg, {
    brand: 'Supa Juice', product: 'Running gel sachet', price: 40, fee: 30,
    currency: 'R', area: 'Cape Town', collectNote: '', minQty: 1, maxQty: 20, photo: null, ready: true
  });
  assert.ok(!JSON.stringify(cfg).includes('0012345678'));
});

test('a kiosk order is numbered, totalled on the server, stored and returned with bank details', () => {
  const { gas } = ready();
  const r = gas.call(order({ price: 1, total: 1, fee: 0 })); // the page cannot set money fields
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.order.invoice, 'SJ-0001');
  assert.equal(r.order.total, 150);
  assert.equal(r.order.status, 'Awaiting payment');
  assert.equal(r.order.created, '2026-10-28 15:41');
  assert.equal(r.bank.number, '0012345678', 'leading zero kept');
  assert.equal(r.brand, 'Supa Juice');

  const rows = gas.rows('Orders');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Source, 'kiosk');
  assert.equal(rows[0].Qty, 3);
  assert.equal(rows[0]['Unit price'], 40);
  assert.equal(rows[0]['Delivery fee'], 30);
  assert.equal(rows[0].Total, 150);

  assert.equal(rows[0].Email, 'jane@example.com');
  assert.equal(rows[0]['Invoice emailed'], '2026-10-28 15:41');

  // Greg gets an alert, the customer gets the invoice.
  assert.equal(gas.mail.length, 2);
  assert.equal(gas.mail[0].to, 'greg@example.com');
  assert.equal(gas.mail[0].subject, 'New order SJ-0001: 3 x Running gel sachet (R150)');
  assert.match(gas.mail[0].body, /Jane Doe/);
  assert.equal(r.emailed, true);
  assert.equal(r.order.emailedOn, '2026-10-28 15:41');
});

test('the customer is emailed the unpaid invoice as a PDF, with the bank details', () => {
  const { gas } = ready();
  gas.call(order());
  const m = gas.mail[1];
  assert.equal(m.to, 'jane@example.com');
  assert.equal(m.subject, 'Supa Juice invoice SJ-0001');
  assert.equal(m.name, 'Supa Juice');
  assert.equal(m.replyTo, 'greg@example.com', 'replies go to Greg');
  assert.match(m.body, /^Hi Jane Doe,/);
  assert.match(m.body, /3 x Running gel sachet @ R40 = R120\nDelivery: R30\nTotal due: R150/);
  assert.match(m.body, /Reference: SJ-0001/);
  assert.equal(m.attachments.length, 1);
  const pdf = m.attachments[0];
  assert.equal(pdf.getContentType(), 'application/pdf');
  assert.equal(pdf.getName(), 'SJ-0001.pdf');
  const html = pdf.getDataAsString();
  for (const bit of ['Invoice SJ-0001', '28 Oct 2026', 'Total due', 'R150', 'Test Bank', '0012345678', '250655', '12 Beach Rd']) {
    assert.ok(html.includes(bit), 'PDF shows ' + bit);
  }
  assert.ok(!html.includes('PAID'));
});

test('invoice numbers never repeat, even after rows are deleted, until numbering is reset', () => {
  const { gas } = ready();
  assert.equal(gas.call(order()).order.invoice, 'SJ-0001');
  assert.equal(gas.call(order()).order.invoice, 'SJ-0002');
  wipeOrders(gas);
  assert.equal(gas.call(order()).order.invoice, 'SJ-0003');

  assert.throws(() => gas.run('resetNumbering()'), /Delete all the order rows/);
  wipeOrders(gas);
  gas.run('resetNumbering()');
  assert.equal(gas.call(order()).order.invoice, 'SJ-0001');
});

test('numbering continues from the highest invoice in the sheet if the counter is lost', () => {
  const { gas } = ready();
  gas.call(order());
  gas.call(order());
  gas.store.delete('LAST_NO'); // for example the Sheet was copied to a new account
  assert.equal(gas.call(order()).order.invoice, 'SJ-0003');
});

test('the same request id returns the existing order and does not email twice', () => {
  const { gas } = ready();
  const first = gas.call(order({ requestId: 'same_request_1' }));
  const again = gas.call(order({ requestId: 'same_request_1' }));
  assert.equal(first.order.invoice, again.order.invoice);
  assert.equal(gas.rows('Orders').length, 1);
  assert.equal(gas.mail.length, 2, 'one alert and one invoice');
});

test('the hidden honeypot field rejects bots without writing a row', () => {
  const { gas } = ready();
  const r = gas.call(order({ website: 'http://spam.example' }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'rejected');
  assert.equal(gas.rows('Orders').length, 0);
});

test('invalid kiosk input is rejected with a readable message', () => {
  const { gas } = ready();
  const bad = [
    [{ name: '  ' }, /name/i],
    [{ email: '' }, /email address/],
    [{ email: 'jane at example.com' }, /email address does not look right/],
    [{ email: 'jane@example' }, /email address does not look right/],
    [{ address: '' }, /address/i],
    [{ areaConfirmed: false }, /delivery area/],
    [{ areaConfirmed: 'true' }, /delivery area/],
    [{ qty: 0 }, /quantity/],
    [{ qty: -2 }, /quantity/],
    [{ qty: 1.5 }, /quantity/],
    [{ qty: 'abc' }, /quantity/],
    [{ qty: 21 }, /most you can order/]
  ];
  for (const [over, message] of bad) {
    const r = gas.call(order(over));
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.error, 'invalid', JSON.stringify(over));
    assert.match(r.message, message, JSON.stringify(over));
  }
  assert.equal(gas.rows('Orders').length, 0);
  assert.equal(gas.call(order({ qty: '2', expectedTotal: 110 })).ok, true, 'numeric string quantity is fine');
  assert.equal(gas.call(order({ contact: '' })).ok, true, 'Instagram handle or phone is optional');
});

test('a minimum order is enforced on the server for every kind of order', () => {
  const { gas, key } = ready();
  const saved = gas.call({ action: 'saveSettings', key, values: { min_quantity: '3' } });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.config.minQty, 3);
  assert.equal(gas.call({ action: 'config' }).config.minQty, 3, 'the order page is told the minimum');

  const small = gas.call(order({ qty: 2, expectedTotal: 110 }));
  assert.equal(small.error, 'invalid');
  assert.match(small.message, /smallest order is 3/);
  assert.equal(gas.call(dm(key, { qty: 2 })).error, 'invalid', 'DM orders follow the same minimum');
  assert.equal(gas.rows('Orders').length, 0);
  assert.equal(gas.call(order({ qty: 3, expectedTotal: 150 })).ok, true);
});

test('minimum and maximum order settings must make sense together', () => {
  const { gas, key } = ready();
  for (const values of [{ min_quantity: '0' }, { min_quantity: '2.5' }, { min_quantity: 'abc' }, { min_quantity: '201' }]) {
    assert.equal(gas.call({ action: 'saveSettings', key, values }).error, 'invalid', JSON.stringify(values));
  }
  // Checked against the saved maximum (20) when only the minimum changes, and the other way round.
  assert.match(gas.call({ action: 'saveSettings', key, values: { min_quantity: '25' } }).message, /cannot be more than/);
  gas.call({ action: 'saveSettings', key, values: { min_quantity: '5' } });
  assert.match(gas.call({ action: 'saveSettings', key, values: { max_quantity: '4' } }).message, /cannot be more than/);
  assert.equal(gas.call({ action: 'saveSettings', key, values: { min_quantity: '2', max_quantity: '4' } }).ok, true, 'both at once');
  assert.equal(gas.call({ action: 'saveSettings', key, values: { min_quantity: '' } }).values.min_quantity, '1', 'blank means no minimum');

  // A minimum typed into the sheet above the maximum is pulled down instead of blocking every order.
  const rows = gas.rows('Settings').map((r) => r.Key);
  gas.sheet('Settings').getRange(rows.indexOf('min_quantity') + 2, 2).setValue('50');
  assert.equal(gas.call({ action: 'config' }).config.minQty, 4);
});

test('long and multi-line text is trimmed and flattened', () => {
  const { gas } = ready();
  const r = gas.call(order({ name: 'A'.repeat(200), address: '1 Long St\nGardens\r\nCape Town', notes: 'x'.repeat(500) }));
  assert.equal(r.ok, true);
  assert.equal(r.order.name.length, 80);
  assert.equal(r.order.address, '1 Long St, Gardens, Cape Town');
  assert.equal(r.order.notes.length, 300);
});

test('a stale total is refused and the fresh config is returned', () => {
  const { gas, key } = ready();
  gas.call({ action: 'saveSettings', key, values: { price: '45' } });
  const r = gas.call(order({ expectedTotal: 150 }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'price_changed');
  assert.equal(r.config.price, 45);
  assert.equal(gas.rows('Orders').length, 0);
  const ok = gas.call(order({ expectedTotal: 165 }));
  assert.equal(ok.ok, true);
  assert.equal(ok.order.total, 165);
});

test('old orders keep the price they were made at', () => {
  const { gas, key } = ready();
  gas.call(order());
  gas.call({ action: 'saveSettings', key, values: { price: '99', delivery_fee: '10' } });
  const listed = gas.call({ action: 'list', key });
  assert.equal(listed.orders[0].total, 150);
  assert.equal(listed.orders[0].price, 40);
});

test('totals are exact with cents', () => {
  const { gas, key } = ready();
  gas.call({ action: 'saveSettings', key, values: { price: '33.33', delivery_fee: '10' } });
  const r = gas.call(order({ qty: 3, expectedTotal: 109.99 }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.order.total, 109.99);
});

test('free delivery works', () => {
  const { gas, key } = ready();
  gas.call({ action: 'saveSettings', key, values: { delivery_fee: '0' } });
  const r = gas.call(order({ qty: 2, expectedTotal: 80 }));
  assert.equal(r.order.total, 80);
});

test('customer text can never become a formula', () => {
  const { gas } = ready();
  const evil = '=IMPORTXML("http://evil.example","//a")';
  const r = gas.call(order({ name: evil, contact: '+27 82 000 0000', address: '@cmd', notes: '-2+3', email: '=x@evil.example' }));
  assert.equal(r.ok, true);
  const sheet = gas.sheet('Orders');
  for (const col of [4, 5, 6, 7, 16]) {
    const cell = sheet.cells.get('2,' + col);
    assert.equal(cell.formula, false, 'column ' + col);
    assert.ok(!/^[=+\-@]/.test(cell.v), 'column ' + col + ' starts with ' + cell.v[0]);
  }
  assert.equal(r.order.name, evil, 'trimmed value still reads the same');
});

test('the public page is capped per hour, Greg is not, and the cap resets', () => {
  const { gas, key } = ready();
  for (let i = 0; i < 12; i++) assert.equal(gas.call(order()).ok, true, 'order ' + i);
  const blocked = gas.call(order());
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'busy');
  assert.equal(gas.call(dm(key)).ok, true, 'DM orders are not capped');
  gas.clock.now += 3600 * 1000;
  assert.equal(gas.call(order()).ok, true);
});

test('a busy lock returns a friendly error instead of a crash', () => {
  const { gas } = ready();
  gas.lock.failNext = true;
  const r = gas.call(order());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'busy');
  assert.equal(gas.rows('Orders').length, 0);
  assert.equal(gas.call(order()).ok, true, 'lock was not left held');
});

test('writes keep working after the 1000-row grid is full', () => {
  const { gas } = ready();
  gas.sheet('Orders').maxRows = 3;
  for (let i = 0; i < 4; i++) assert.equal(gas.call(order()).ok, true, 'order ' + i);
  assert.equal(gas.rows('Orders').length, 4);
  assert.ok(gas.sheet('Orders').maxRows >= 5);
});

test('admin actions need the key and kiosk visitors cannot reach them', () => {
  const { gas, key } = ready();
  gas.call(order());
  for (const body of [
    { action: 'list' },
    { action: 'list', key: 'nope' },
    { action: 'list', key: 12345 },
    { action: 'list', key: key + 'x' },
    { action: 'create', name: 'x', qty: 1 },
    { action: 'setStatus', invoice: 'SJ-0001', status: 'Paid' },
    { action: 'sendInvoice', invoice: 'SJ-0001' },
    { action: 'getSettings' },
    { action: 'saveSettings', values: { price: '1' } }
  ]) {
    const r = gas.call(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(r.error, 'unauthorized', JSON.stringify(body));
  }
  assert.ok(gas.sleeps.length >= 9, 'failed attempts are slowed down');
  assert.equal(gas.call({ action: 'list', key }).ok, true);
  assert.equal(gas.rows('Orders')[0].Status, 'Awaiting payment');
});

test('admin is locked when no key exists', () => {
  const gas = createGas();
  gas.run('setup()');
  gas.store.delete('ADMIN_KEY');
  assert.equal(gas.call({ action: 'list', key: '' }).error, 'unauthorized');
  assert.equal(gas.call({ action: 'list' }).error, 'unauthorized');
});

test('rotating the admin key invalidates the old one', () => {
  const { gas, key } = ready();
  gas.run('rotateAdminKey()');
  assert.notEqual(gas.key(), key);
  assert.equal(gas.call({ action: 'list', key }).error, 'unauthorized');
  assert.equal(gas.call({ action: 'list', key: gas.key() }).ok, true);
});

test('Greg can add a DM order: no email, address and contact optional', () => {
  const { gas, key } = ready();
  const r = gas.call(dm(key, { name: 'Sam', qty: 2 }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.order.invoice, 'SJ-0001');
  assert.equal(r.order.total, 110);
  assert.equal(r.order.source, 'dm');
  assert.equal(gas.mail.length, 0);
  assert.equal(gas.call(dm(key, { name: '' })).error, 'invalid');
  assert.equal(gas.call(dm(key, { email: 'nope' })).error, 'invalid', 'an email, if given, must look right');
});

test('a DM order with an email sends the customer the invoice, but no alert to Greg', () => {
  const { gas, key } = ready();
  const r = gas.call(dm(key, { name: 'Sam', email: 'sam@example.com' }));
  assert.equal(r.ok, true);
  assert.equal(r.emailed, true);
  assert.equal(gas.mail.length, 1);
  assert.equal(gas.mail[0].to, 'sam@example.com');
  assert.equal(gas.mail[0].attachments[0].getName(), 'SJ-0001.pdf');
});

test('marking paid emails the paid invoice once; undoing and other moves send nothing', () => {
  const { gas, key } = ready();
  gas.call(order());
  gas.mail.length = 0;
  const set = (status) => gas.call({ action: 'setStatus', key, invoice: 'SJ-0001', status });

  gas.clock.now += 3600 * 1000;
  const paid = set('Paid');
  assert.equal(paid.emailed, true);
  assert.equal(paid.order.emailedOn, '2026-10-28 16:41');
  assert.equal(gas.mail.length, 1);
  const m = gas.mail[0];
  assert.equal(m.subject, 'Supa Juice invoice SJ-0001 (paid)');
  assert.match(m.body, /Invoice SJ-0001 \(PAID\)\nDate: 28 Oct 2026\nPaid: 28 Oct 2026/);
  assert.match(m.body, /Total paid: R150/);
  assert.ok(!m.body.includes('0012345678'), 'no bank details on a paid invoice');
  const html = m.attachments[0].getDataAsString();
  assert.ok(html.includes('PAID') && html.includes('Total paid') && !html.includes('0012345678'));

  set('Delivered');
  set('Paid'); // undo delivered
  set('Paid'); // same again
  assert.equal(gas.mail.length, 1, 'no second paid email');
  assert.equal(set('Delivered').emailed, undefined);
});

test('orders without an email are never emailed', () => {
  const { gas, key } = ready();
  gas.call(dm(key));
  assert.equal(gas.call({ action: 'setStatus', key, invoice: 'SJ-0001', status: 'Paid' }).emailed, undefined);
  assert.equal(gas.mail.length, 0);
  const r = gas.call({ action: 'sendInvoice', key, invoice: 'SJ-0001' });
  assert.equal(r.error, 'invalid');
  assert.match(r.message, /no email address/);
});

test('Greg can email an invoice again, but not for a cancelled or unknown order', () => {
  const { gas, key } = ready();
  gas.call(order());
  gas.mail.length = 0;
  gas.clock.now += 600 * 1000;
  const r = gas.call({ action: 'sendInvoice', key, invoice: 'sj-0001' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.order.emailedOn, '2026-10-28 15:51');
  assert.equal(gas.rows('Orders')[0]['Invoice emailed'], '2026-10-28 15:51');
  assert.equal(gas.mail.length, 1);
  assert.equal(gas.mail[0].subject, 'Supa Juice invoice SJ-0001');

  gas.call({ action: 'setStatus', key, invoice: 'SJ-0001', status: 'Cancelled' });
  assert.match(gas.call({ action: 'sendInvoice', key, invoice: 'SJ-0001' }).message, /cancelled/);
  assert.equal(gas.call({ action: 'sendInvoice', key, invoice: 'SJ-0404' }).error, 'not_found');
});

test('a failed invoice email does not fail the order, and a resend says it failed', () => {
  const { gas, key } = ready();
  gas.mailQuota.left = 1; // enough for Greg's alert only
  const r = gas.call(order());
  assert.equal(r.ok, true);
  assert.equal(r.emailed, false);
  assert.equal(r.order.emailedOn, '');
  assert.equal(gas.rows('Orders')[0]['Invoice emailed'], '');
  assert.ok(gas.errors.some((e) => e.includes('Invoice email failed for SJ-0001')));
  const again = gas.call({ action: 'sendInvoice', key, invoice: 'SJ-0001' });
  assert.equal(again.error, 'email_failed');
  assert.equal(gas.call({ action: 'setStatus', key, invoice: 'SJ-0001', status: 'Paid' }).ok, true, 'marking paid still works');
});

test('customer text in the PDF is shown as text, never as markup', () => {
  const { gas } = ready();
  gas.call(order({ name: '<img src=x onerror=alert(1)>', address: '"1 & 2" <b>St</b>' }));
  const html = gas.mail[1].attachments[0].getDataAsString();
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&quot;1 &amp; 2&quot; &lt;b&gt;St&lt;/b&gt;'));
});

test('rows written before the email columns existed still list and change status', () => {
  const { gas, key } = ready();
  const sheet = gas.sheet('Orders');
  sheet.getRange(2, 1, 1, 15).setValues([[
    'SJ-0001', '2026-10-27 10:00', 'kiosk', 'Old Row', '@old', '1 Old St', '',
    1, 40, 30, 70, 'Awaiting payment', '', '', 'req_old_0001'
  ]]);
  const listed = gas.call({ action: 'list', key }).orders[0];
  assert.equal(listed.email, '');
  assert.equal(listed.emailedOn, '');
  assert.equal(gas.call({ action: 'setStatus', key, invoice: 'SJ-0001', status: 'Paid' }).emailed, undefined);
  assert.equal(gas.call(order()).order.invoice, 'SJ-0002');
});

test('list returns orders and the admin config with bank details', () => {
  const { gas, key } = ready();
  gas.call(order());
  gas.call(dm(key));
  const r = gas.call({ action: 'list', key });
  assert.equal(r.ok, true);
  assert.equal(r.orders.length, 2);
  assert.equal(r.orders[0].invoice, 'SJ-0001');
  assert.equal(r.config.bank.number, '0012345678');
  assert.equal(r.config.prefix, 'SJ');
  assert.equal(r.config.ready, true);
  assert.ok(!('requestId' in r.orders[0]));
});

test('status changes follow the allowed moves and keep the dates right', () => {
  const { gas, key } = ready();
  gas.call(order());
  const set = (status) => gas.call({ action: 'setStatus', key, invoice: 'SJ-0001', status });

  // not allowed straight from Awaiting payment to Delivered
  let r = set('Delivered');
  assert.equal(r.error, 'invalid');

  gas.clock.now += 3600 * 1000;
  r = set('Paid');
  assert.equal(r.ok, true);
  assert.equal(r.order.status, 'Paid');
  assert.equal(r.order.paidOn, '2026-10-28 16:41');
  assert.equal(r.order.deliveredOn, '');

  gas.clock.now += 3600 * 1000;
  r = set('Delivered');
  assert.equal(r.order.status, 'Delivered');
  assert.equal(r.order.paidOn, '2026-10-28 16:41');
  assert.equal(r.order.deliveredOn, '2026-10-28 17:41');

  // undo delivered: back to Paid, original paid date kept
  r = set('Paid');
  assert.equal(r.order.status, 'Paid');
  assert.equal(r.order.paidOn, '2026-10-28 16:41');
  assert.equal(r.order.deliveredOn, '');

  // undo paid: back to Awaiting, dates cleared
  r = set('Awaiting payment');
  assert.equal(r.order.status, 'Awaiting payment');
  assert.equal(r.order.paidOn, '');

  // cancel and reopen
  assert.equal(set('Cancelled').order.status, 'Cancelled');
  assert.equal(set('Paid').error, 'invalid');
  assert.equal(set('Awaiting payment').order.status, 'Awaiting payment');

  // same status again is a harmless no-op
  assert.equal(set('Awaiting payment').ok, true);

  const row = gas.rows('Orders')[0];
  assert.equal(row.Status, 'Awaiting payment');
  assert.equal(row['Paid on'], '');
});

test('status changes reject unknown orders and statuses', () => {
  const { gas, key } = ready();
  assert.equal(gas.call({ action: 'setStatus', key, invoice: 'SJ-9999', status: 'Paid' }).error, 'not_found');
  gas.call(order());
  assert.equal(gas.call({ action: 'setStatus', key, invoice: 'SJ-0001', status: 'Refunded' }).error, 'invalid');
  assert.equal(gas.call({ action: 'setStatus', key, invoice: 'sj-0001', status: 'Paid' }).ok, true, 'invoice lookup ignores case');
});

test('settings are validated, whitelisted and stored as text', () => {
  const { gas, key } = ready();
  const bad = [
    { price: 'abc' }, { price: '-5' }, { price: '4O' }, { price: '1-2' }, { delivery_fee: '-1' }, { max_quantity: '0' }, { max_quantity: '2.5' },
    { invoice_prefix: 'TOO-LONG!' }, { alert_email: 'not an email' }, { brand_name: '  ' }
  ];
  for (const values of bad) {
    const r = gas.call({ action: 'saveSettings', key, values });
    assert.equal(r.ok, false, JSON.stringify(values));
    assert.equal(r.error, 'invalid', JSON.stringify(values));
  }
  const r = gas.call({
    action: 'saveSettings', key,
    values: { price: 'R42,50', invoice_prefix: 'bib', brand_name: 'Supa Juice Co', max_quantity: '10', evil_key: 'x', account_number: '0099887766' }
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.values.price, '42.5');
  assert.equal(r.values.invoice_prefix, 'BIB');
  assert.equal(r.values.account_number, '0099887766');
  assert.ok(!('evil_key' in r.values));
  assert.ok(!gas.rows('Settings').some((row) => row.Key === 'evil_key'));
  assert.equal(r.config.price, 42.5);
  assert.equal(r.config.maxQty, 10);

  // new prefix applies to the next order
  assert.equal(gas.call(order({ qty: 1, expectedTotal: 72.5 })).order.invoice, 'BIB-0001');
});

test('a setting that starts with = is stored as text', () => {
  const { gas, key } = ready();
  gas.call({ action: 'saveSettings', key, values: { payment_note: '=HYPERLINK("http://evil.example")' } });
  const settings = gas.sheet('Settings');
  const keys = gas.rows('Settings').map((r) => r.Key);
  const row = keys.indexOf('payment_note') + 2;
  assert.equal(settings.cells.get(row + ',2').formula, false);
});

test('a missing settings row is added when saved', () => {
  const { gas, key } = ready();
  const settings = gas.sheet('Settings');
  const keys = gas.rows('Settings').map((r) => r.Key);
  const row = keys.indexOf('account_type') + 2;
  for (const k of [...settings.cells.keys()]) if (k.startsWith(row + ',')) settings.cells.delete(k);
  assert.equal(gas.call({ action: 'getSettings', key }).values.account_type, '');
  gas.call({ action: 'saveSettings', key, values: { account_type: 'Savings' } });
  assert.equal(gas.call({ action: 'getSettings', key }).values.account_type, 'Savings');
});

test('bad requests do not crash the endpoint', () => {
  const { gas, key } = ready();
  assert.equal(gas.raw('not json').error, 'bad_request');
  assert.equal(gas.raw('').error, 'bad_request');
  assert.equal(gas.raw('"just a string"').error, 'bad_request');
  assert.equal(gas.raw('null').error, 'bad_request');
  assert.equal(gas.call({ action: 'nonsense' }).error, 'unauthorized');
  assert.equal(gas.call({ action: 'nonsense', key }).error, 'bad_request');
});

test('an unexpected failure returns a generic error and is logged, not leaked', () => {
  const gas = createGas(); // no setup: the tabs do not exist
  const r = gas.call({ action: 'config' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_ready');
  const { gas: g2 } = ready();
  g2.ctx.SpreadsheetApp.getActiveSpreadsheet = () => { throw new Error('secret internals'); };
  const r2 = g2.call({ action: 'config' });
  assert.equal(r2.error, 'server_error');
  assert.ok(!JSON.stringify(r2).includes('secret'));
  assert.ok(g2.errors.some((e) => e.includes('secret internals')));
});

test('opening the web app address shows it is alive, and config can be read with GET', () => {
  const { gas } = ready();
  assert.deepEqual(gas.get({}), { ok: true, service: 'orders' });
  assert.equal(gas.get({ action: 'config' }).config.price, 40);
});

test('a failing alert email does not fail the order', () => {
  const { gas } = ready();
  gas.ctx.MailApp.sendEmail = () => { throw new Error('quota'); };
  const r = gas.call(order());
  assert.equal(r.ok, true);
  assert.ok(gas.errors.some((e) => e.includes('Alert email failed')));
  assert.ok(gas.errors.some((e) => e.includes('Invoice email failed')));
});

test('no alert email address means no email', () => {
  const { gas, key } = ready();
  gas.call({ action: 'saveSettings', key, values: { alert_email: '' } });
  gas.call(order());
  assert.equal(gas.mail.length, 1, 'only the customer invoice');
  assert.equal(gas.mail[0].to, 'jane@example.com');
  assert.equal(gas.mail[0].replyTo, undefined);
});

// ---------------------------------------------------------------------------
// Order page photo
// ---------------------------------------------------------------------------

// A fake image of the given size whose first bytes say what it is.
function image(type, bytes) {
  const head = { jpeg: [0xff, 0xd8, 0xff, 0xe0], png: [0x89, 0x50, 0x4e, 0x47], webp: [0x52, 0x49, 0x46, 0x46] }[type];
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = (i * 7 + 3) % 256;
  head.forEach((b, i) => { buf[i] = b; });
  return buf.toString('base64');
}

test('there is no photo until Greg adds one, and adding one needs the key', () => {
  const { gas } = ready();
  assert.equal(gas.call({ action: 'config' }).config.photo, null);
  assert.deepEqual(gas.call({ action: 'photo' }), { ok: true, photo: null });
  const r = gas.call({ action: 'setPhoto', type: 'image/jpeg', data: image('jpeg', 1000) });
  assert.equal(r.error, 'unauthorized');
  assert.equal(r.ok, false);
  assert.equal(gas.call({ action: 'removePhoto' }).error, 'unauthorized');
  assert.equal(gas.sheet('Photo'), null);
});

test('a photo is stored in a hidden tab in pieces and comes back exactly as sent', () => {
  const { gas, key } = ready();
  const data = image('jpeg', 300 * 1024); // about 400,000 characters of base64
  const r = gas.call({ action: 'setPhoto', key, type: 'image/jpeg', data: 'data:image/jpeg;base64,' + data, alt: 'Runner holding a gel sachet' });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.match(r.photo.version, /^[0-9a-f]{12}$/);
  assert.equal(r.photo.alt, 'Runner holding a gel sachet');

  const sheet = gas.sheet('Photo');
  assert.equal(sheet.isSheetHidden(), true);
  const pieces = sheet.getLastRow() - 2;
  assert.ok(pieces >= 9, 'split across ' + pieces + ' cells');
  for (let row = 3; row < 3 + pieces; row++) assert.ok(String(sheet.cells.get(row + ',1').v).length <= 50000);

  const back = gas.call({ action: 'photo' }).photo;
  assert.equal(back.data, data);
  assert.equal(back.type, 'image/jpeg');
  assert.equal(back.version, r.photo.version);
  assert.deepEqual(gas.call({ action: 'config' }).config.photo, { version: r.photo.version, alt: 'Runner holding a gel sachet' });
  assert.deepEqual(gas.call({ action: 'list', key }).config.photo, r.photo, 'the admin page sees it too');
});

test('photo pieces are stored as text, so one starting with + or / is never read as a formula', () => {
  const { gas, key } = ready();
  // Base64 uses + and /, and any piece after the first can start with one of them.
  const r = gas.call({ action: 'setPhoto', key, type: 'image/png', data: image('png', 46000 * 3) });
  assert.equal(r.ok, true);
  const sheet = gas.sheet('Photo');
  assert.ok(sheet.getLastRow() >= 5);
  for (let row = 2; row <= sheet.getLastRow(); row++) {
    const cell = sheet.cells.get(row + ',1');
    assert.equal(cell.fmt, '@', 'row ' + row + ' is a text cell');
    assert.equal(cell.formula, false);
  }
  assert.equal(gas.call({ action: 'photo' }).photo.data, image('png', 46000 * 3));
});

test('a new photo replaces the old one completely and gets a new version', () => {
  const { gas, key } = ready();
  const first = gas.call({ action: 'setPhoto', key, type: 'image/jpeg', data: image('jpeg', 200 * 1024) }).photo;
  const small = image('webp', 5000);
  const second = gas.call({ action: 'setPhoto', key, type: 'image/webp', data: small, alt: 'New' }).photo;
  assert.notEqual(second.version, first.version);
  assert.equal(gas.sheet('Photo').getLastRow(), 3, 'old pieces cleared');
  const back = gas.call({ action: 'photo' }).photo;
  assert.equal(back.data, small);
  assert.equal(back.type, 'image/webp');
});

test('the description can be changed without sending the photo again', () => {
  const { gas, key } = ready();
  assert.match(gas.call({ action: 'setPhoto', key, alt: 'Nothing yet' }).message, /Add a photo first/);
  const first = gas.call({ action: 'setPhoto', key, type: 'image/jpeg', data: image('jpeg', 2000), alt: 'Old' }).photo;
  const r = gas.call({ action: 'setPhoto', key, alt: 'Sachets on a trail' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.photo, { version: first.version, alt: 'Sachets on a trail' }, 'same version, so phones keep their saved copy');
  assert.equal(gas.call({ action: 'photo' }).photo.data, image('jpeg', 2000));
});

test('files that are not images, or too big, are refused and nothing changes', () => {
  const { gas, key } = ready();
  const ok = gas.call({ action: 'setPhoto', key, type: 'image/jpeg', data: image('jpeg', 1000) }).photo;
  const bad = [
    [{ type: 'image/gif', data: image('jpeg', 1000) }, /JPEG, PNG or WebP/],
    [{ type: 'text/html', data: Buffer.from('<script>').toString('base64') }, /JPEG, PNG or WebP/],
    [{ type: 'image/png', data: image('jpeg', 1000) }, /not a JPEG, PNG or WebP/],
    [{ type: 'image/jpeg', data: Buffer.from('MZ this is a program').toString('base64') }, /not a JPEG, PNG or WebP/],
    [{ type: 'image/jpeg', data: 'not base64 at all!' }, /could not be read/],
    [{ type: 'image/jpeg', data: image('jpeg', 700 * 1024) }, /too large/]
  ];
  for (const [over, message] of bad) {
    const r = gas.call(Object.assign({ action: 'setPhoto', key }, over));
    assert.equal(r.error, 'invalid', JSON.stringify(over).slice(0, 80));
    assert.match(r.message, message);
  }
  assert.equal(gas.call({ action: 'photo' }).photo.version, ok.version, 'the old photo is still there');
});

test('removing the photo takes it off the order page', () => {
  const { gas, key } = ready();
  assert.equal(gas.call({ action: 'removePhoto', key }).ok, true, 'removing when there is none is fine');
  gas.call({ action: 'setPhoto', key, type: 'image/jpeg', data: image('jpeg', 100 * 1024) });
  const r = gas.call({ action: 'removePhoto', key });
  assert.deepEqual(r, { ok: true, photo: null });
  assert.equal(gas.call({ action: 'config' }).config.photo, null);
  assert.equal(gas.call({ action: 'photo' }).photo, null);
  // And a new one can be added afterwards.
  assert.equal(gas.call({ action: 'setPhoto', key, type: 'image/jpeg', data: image('jpeg', 1000) }).ok, true);
});

test('a broken Photo tab, for example edited by hand, means no photo instead of an error', () => {
  const { gas, key } = ready();
  gas.call({ action: 'setPhoto', key, type: 'image/jpeg', data: image('jpeg', 1000) });
  gas.sheet('Photo').getRange(2, 1).setValue('{oops');
  assert.equal(gas.call({ action: 'config' }).config.photo, null);
  assert.equal(gas.call({ action: 'photo' }).photo, null);
  assert.equal(gas.call(order()).ok, true, 'orders still work');
});

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

const COLLECT_NOTE = 'Sea Point. We DM you to arrange a time.';

function readyWithCollection() {
  const env = ready();
  const r = env.gas.call({ action: 'saveSettings', key: env.key, values: { collection_note: COLLECT_NOTE } });
  assert.equal(r.ok, true, JSON.stringify(r));
  return env;
}

test('collection is only offered once Greg writes a collection note', () => {
  const { gas, key } = ready();
  const refused = gas.call(order({ collect: true, address: '', areaConfirmed: false, qty: 3, expectedTotal: 120 }));
  assert.equal(refused.error, 'invalid');
  assert.match(refused.message, /Collection is not available/);
  gas.call({ action: 'saveSettings', key, values: { collection_note: COLLECT_NOTE } });
  assert.equal(gas.call({ action: 'config' }).config.collectNote, COLLECT_NOTE);
});

test('a collection order has no delivery fee and needs no address', () => {
  const { gas } = readyWithCollection();
  // 3 x R40, no R30 delivery fee.
  const r = gas.call(order({ collect: true, address: '', areaConfirmed: false, qty: 3, expectedTotal: 120 }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.order.collect, true);
  assert.equal(r.order.fee, 0);
  assert.equal(r.order.total, 120);
  assert.equal(r.collectNote, COLLECT_NOTE);
  const row = gas.rows('Orders')[0];
  assert.equal(row.Collect, 'yes');
  assert.equal(row['Delivery fee'], 0);

  // The customer's invoice says where to collect, and Greg's alert says it is a collection.
  const invoice = gas.mail.find((m) => m.to === 'jane@example.com');
  assert.match(invoice.body, /3 x Running gel sachet @ R40 = R120\nCollection: free\nTotal due: R120/);
  assert.match(invoice.body, /Collecting: Sea Point\. We DM you to arrange a time\./);
  const html = invoice.attachments[0].getDataAsString();
  assert.ok(html.includes('Collecting:') && html.includes('Sea Point') && !html.includes('Deliver to'));
  const alert = gas.mail.find((m) => m.to === 'greg@example.com');
  assert.match(alert.body, /Collects the order \(no delivery\)/);
});

test('a page that shows the delivery total cannot slip in a collection order, or the other way round', () => {
  const { gas } = readyWithCollection();
  // Collection chosen but the delivery total sent: the totals do not match, so the order is refused.
  assert.equal(gas.call(order({ collect: true, qty: 3, expectedTotal: 150 })).error, 'price_changed');
  assert.equal(gas.call(order({ collect: false, qty: 3, expectedTotal: 120 })).error, 'price_changed');
  // Anything other than true means delivery.
  const r = gas.call(order({ collect: 'yes', qty: 3, expectedTotal: 150 }));
  assert.equal(r.order.collect, false);
  assert.equal(r.order.fee, 30);
});

test('delivery orders still need an address and the area tick', () => {
  const { gas } = readyWithCollection();
  assert.match(gas.call(order({ address: '' })).message, /delivery address/);
  assert.match(gas.call(order({ areaConfirmed: false })).message, /delivery area/);
});

test('Greg can enter a collection order by DM even when collection is not offered on the order page', () => {
  const { gas, key } = ready();
  const r = gas.call(dm(key, { collect: true, qty: 2 }));
  assert.equal(r.ok, true);
  assert.equal(r.order.total, 80);
  assert.equal(r.order.collect, true);
});

// ---------------------------------------------------------------------------
// Editing an order
// ---------------------------------------------------------------------------

const edit = (key, over) => Object.assign({
  action: 'editOrder', key, invoice: 'SJ-0001', name: 'Jane Doe', contact: '@jane', email: 'jane@example.com',
  address: '12 Beach Rd, Sea Point', notes: '', qty: 3, collect: false, price: '40', fee: '30', sendInvoice: false
}, over);

test('Greg can change everything on an unpaid order, and the total is worked out again', () => {
  const { gas, key } = ready();
  gas.call(order());
  gas.clock.now += 3600 * 1000;
  const r = gas.call(edit(key, {
    name: 'Jane Smith', contact: '082 555 0000', email: 'jane.smith@example.com', address: '1 Long St, Gardens',
    notes: 'Ring the bell', qty: 5, price: '35.50', fee: '20'
  }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.emailed, undefined, 'not emailed unless asked');
  const o = r.order;
  assert.equal(o.invoice, 'SJ-0001', 'same invoice number');
  assert.deepEqual([o.name, o.contact, o.email, o.address, o.notes], ['Jane Smith', '082 555 0000', 'jane.smith@example.com', '1 Long St, Gardens', 'Ring the bell']);
  assert.deepEqual([o.qty, o.price, o.fee, o.total], [5, 35.5, 20, 197.5]);
  assert.equal(o.status, 'Awaiting payment');
  assert.equal(o.created, '2026-10-28 15:41', 'the order date does not change');
  assert.equal(o.editedOn, '2026-10-28 16:41');

  const row = gas.rows('Orders')[0];
  assert.equal(row.Total, 197.5);
  assert.equal(row['Edited on'], '2026-10-28 16:41');
  assert.equal(gas.rows('Orders').length, 1, 'no new row');
});

test('switching an order to collection takes the delivery fee off, whatever fee is sent', () => {
  const { gas, key } = ready();
  gas.call(order());
  const r = gas.call(edit(key, { collect: true, fee: '30', address: '' }));
  assert.equal(r.order.collect, true);
  assert.equal(r.order.fee, 0);
  assert.equal(r.order.total, 120);
  // And back to delivery with a fee Greg chooses.
  const back = gas.call(edit(key, { collect: false, fee: '45' }));
  assert.equal(back.order.fee, 45);
  assert.equal(back.order.total, 165);
});

test('a price of 0 is allowed, for example a free sample', () => {
  const { gas, key } = ready();
  gas.call(order());
  const r = gas.call(edit(key, { price: '0', fee: '0' }));
  assert.equal(r.ok, true);
  assert.equal(r.order.total, 0);
});

test('the updated invoice is emailed only when Greg asks and the order has an email', () => {
  const { gas, key } = ready();
  gas.call(order());
  gas.mail.length = 0;
  const r = gas.call(edit(key, { qty: 4, sendInvoice: true }));
  assert.equal(r.emailed, true);
  assert.equal(gas.mail.length, 1);
  assert.match(gas.mail[0].body, /4 x Running gel sachet @ R40 = R160\nDelivery: R30\nTotal due: R190/);
  assert.equal(gas.call(edit(key, { email: '', sendInvoice: true })).emailed, undefined, 'no address, no email');
  assert.equal(gas.mail.length, 1);
});

test('only orders waiting for payment can be edited', () => {
  const { gas, key } = ready();
  gas.call(order());
  gas.call({ action: 'setStatus', key, invoice: 'SJ-0001', status: 'Paid' });
  const r = gas.call(edit(key, { qty: 9 }));
  assert.equal(r.error, 'invalid');
  assert.match(r.message, /SJ-0001 is Paid\. Only orders waiting for payment can be edited/);
  assert.equal(gas.rows('Orders')[0].Qty, 3, 'unchanged');
  gas.call({ action: 'setStatus', key, invoice: 'SJ-0001', status: 'Cancelled' });
  assert.equal(gas.call(edit(key)).error, 'invalid');
  assert.equal(gas.call(edit(key, { invoice: 'SJ-0404' })).error, 'not_found');
});

test('edits are checked like new orders, and nothing is saved when one is wrong', () => {
  const { gas, key } = ready();
  gas.call(order());
  const bad = [
    [{ name: ' ' }, /name/],
    [{ email: 'nope' }, /email address/],
    [{ qty: 0 }, /quantity/],
    [{ qty: 2.5 }, /quantity/],
    [{ qty: 21 }, /most one order/],
    [{ price: 'abc' }, /Price per sachet/],
    [{ price: '-1' }, /Price per sachet/],
    [{ fee: 'R abc' }, /Delivery fee/]
  ];
  for (const [over, message] of bad) {
    const r = gas.call(edit(key, over));
    assert.equal(r.error, 'invalid', JSON.stringify(over));
    assert.match(r.message, message);
  }
  const row = gas.rows('Orders')[0];
  assert.equal(row.Name, 'Jane Doe');
  assert.equal(row['Edited on'], '');
  assert.equal(gas.call(Object.assign(edit(key), { key: 'wrong' })).error, 'unauthorized');
});

test('edited text can never become a formula', () => {
  const { gas, key } = ready();
  gas.call(order());
  gas.call(edit(key, { name: '=HYPERLINK("http://evil.example")', notes: '+1', address: '@x' }));
  const sheet = gas.sheet('Orders');
  for (const col of [4, 6, 7]) assert.equal(sheet.cells.get('2,' + col).formula, false, 'column ' + col);
});

test('rows from before these columns existed can still be edited', () => {
  const { gas, key } = ready();
  gas.sheet('Orders').getRange(2, 1, 1, 15).setValues([[
    'SJ-0001', '2026-10-27 10:00', 'kiosk', 'Old Row', '@old', '1 Old St', '',
    1, 40, 30, 70, 'Awaiting payment', '', '', 'req_old_0001'
  ]]);
  const listed = gas.call({ action: 'list', key }).orders[0];
  assert.equal(listed.collect, false);
  assert.equal(listed.editedOn, '');
  const r = gas.call(edit(key, { name: 'Old Row', qty: 2, email: '' }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.order.total, 110);
});
