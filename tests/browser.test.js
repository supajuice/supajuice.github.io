'use strict';
// Runs both pages in a real browser (Chromium) against the fake order service.
// Run with: npm test   (the browser tests need the playwright package and its Chromium; see README)
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startDevServer } = require('./dev-server');

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

// A fresh fake service, browser context and page for one test. Everything is closed afterwards.
async function open(t, opts) {
  opts = opts || {};
  const dev = await startDevServer({ mode: opts.mode || 'seeded', latency: opts.latency || 0, fee: opts.fee, quote: opts.quote, collections: opts.collections });
  const ctx = await browser.newContext({
    viewport: { width: opts.width || 390, height: opts.height || 844 },
    deviceScaleFactor: 1,
    isMobile: opts.mobile !== false,
    hasTouch: opts.mobile !== false,
    colorScheme: opts.scheme || 'light',
    permissions: ['clipboard-read', 'clipboard-write']
  });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: dev.siteUrl }).catch(() => {});
  if (opts.init) await ctx.addInitScript(opts.init);
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  t.after(async () => {
    await ctx.close();
    await dev.close();
  });
  return { dev, ctx, page, errors };
}

const kioskUrl = (dev) => dev.siteUrl + '/';

async function openKiosk(t, opts) {
  const env = await open(t, opts);
  await env.page.goto(kioskUrl(env.dev));
  return env;
}

async function openAdmin(t, opts) {
  const env = await open(t, opts);
  await env.page.goto(env.dev.adminUrl());
  await env.page.waitForSelector('.tabs');
  return env;
}

// The order page opens on two buttons. Tapping one shows the rest of the form.
async function choose(page, what) {
  await page.waitForSelector('#order-form:not([hidden])');
  if (await page.locator('#choose').isVisible()) await page.click(what === 'collect' ? '#choose-collect' : '#choose-deliver');
  await page.waitForSelector('#order-rest:not([hidden])');
}

// A collection time: the first free day and the given (or first) time on it.
async function pickTime(page, time) {
  const day = await page.locator('#collect-day option').nth(1).getAttribute('value');
  await page.selectOption('#collect-day', day);
  if (time) await page.selectOption('#collect-hour', time);
  else await page.selectOption('#collect-hour', { index: 1 });
  return day + ' ' + await page.inputValue('#collect-hour');
}

async function fillKiosk(page, over) {
  const d = Object.assign({
    name: 'Jane Doe', email: 'jane@example.com', contact: '@jane.runs', address: '12 Beach Rd, Sea Point', notes: '', more: 0
  }, over);
  await choose(page, d.collect ? 'collect' : 'deliver');
  if (d.collect) await pickTime(page, d.time);
  for (let i = 0; i < d.more; i++) await page.click('[aria-label="One more"]');
  await page.fill('#name', d.name);
  await page.fill('#email', d.email);
  await page.fill('#contact', d.contact);
  if (!d.collect) await page.fill('#address', d.address);
  await page.fill('#notes', d.notes);
}

const orderRows = (dev) => dev.gas.rows('Orders');
const text = (page, selector) => page.locator(selector).innerText();
const card = (page, invoice) => page.locator('article.order[aria-label="Order ' + invoice + '"]');

function noErrors(errors) {
  assert.deepEqual(errors, [], 'the page logged errors');
}

// ---------------------------------------------------------------------------
// Customer page
// ---------------------------------------------------------------------------

test('order page: shows the shop, the price and a total that follows the quantity', async (t) => {
  const { page, errors } = await openKiosk(t, { mode: 'ready' });
  await page.waitForSelector('#order-form:not([hidden])');
  assert.equal(await text(page, '#brand'), 'Supa Juice');
  assert.equal(await text(page, '#lede'), 'Order below. Pay by bank transfer. We deliver, or you can collect.');
  assert.doesNotMatch(await page.locator('#order-form').innerText(), /Cape Town/, 'no delivery area is shown to customers');
  await choose(page, 'deliver');
  assert.match(await text(page, '.qty-item'), /Running gel sachet, R40 each/);
  assert.equal(await text(page, '#submit'), 'Place order for R70');
  await page.click('[aria-label="One more"]');
  await page.click('[aria-label="One more"]');
  assert.equal(await page.inputValue('#qty'), '3');
  assert.equal(await text(page, '#submit'), 'Place order for R150');
  assert.match(await text(page, '#summary'), /3 x Running gel sachet\s+R120/);
  assert.match(await text(page, '#summary'), /Delivery\s+R30/);
  noErrors(errors);
});

test('order page: with a minimum order the quantity starts there and cannot go below it', async (t) => {
  const { dev, page, errors } = await open(t, { mode: 'ready' });
  dev.gas.call({ action: 'saveSettings', key: dev.key, values: { min_quantity: '3' } });
  await page.goto(kioskUrl(dev));
  await choose(page, 'deliver');
  assert.equal(await page.inputValue('#qty'), '3');
  assert.equal(await page.locator('[aria-label="One fewer"]').isDisabled(), true);
  assert.match(await text(page, '.qty-item'), /Running gel sachet, R40 each\. Minimum order 3\./);
  assert.equal(await text(page, '#submit'), 'Place order for R150');

  // Typing a smaller number is corrected to the minimum.
  await page.fill('#qty', '1');
  await page.locator('#qty').blur();
  assert.equal(await page.inputValue('#qty'), '3');

  await page.click('[aria-label="One more"]');
  assert.equal(await page.locator('[aria-label="One fewer"]').isDisabled(), false);
  await fillKiosk(page);
  await page.click('#submit');
  await page.waitForSelector('#view-done:not([hidden])');
  assert.equal(orderRows(dev)[0].Qty, 4);

  // Another order starts at the minimum again.
  await page.click('#new-order');
  await choose(page, 'deliver');
  assert.equal(await page.inputValue('#qty'), '3');
  noErrors(errors);
});

test('order page: the customer first picks Collect or Get delivered, and only then sees the form', async (t) => {
  const { page, errors } = await openKiosk(t, { mode: 'ready' });
  await page.waitForSelector('#order-form:not([hidden])');
  assert.equal(await text(page, '#choose-collect'), 'Collect\nFree · Sea Point');
  assert.equal(await text(page, '#choose-deliver'), 'Get delivered\nR30');
  for (const id of ['#order-rest', '#chosen', '#address-field', '#name', '#submit']) {
    assert.equal(await page.locator(id).isVisible(), false, id + ' waits for the choice');
  }

  await page.click('#choose-deliver');
  assert.equal(await page.locator('#choose').isHidden(), true);
  assert.equal(await text(page, '#chosen-text'), 'Get delivered');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'chosen-text', 'focus moves to the choice');
  assert.equal(await page.locator('#address-field').isVisible(), true);
  assert.equal(await page.locator('#collect-time').isHidden(), true);
  await page.fill('#name', 'Typed Before');

  // Change brings the two buttons back, and what was typed stays.
  await page.click('#choose-change');
  assert.equal(await page.locator('#choose').isVisible(), true);
  assert.equal(await page.locator('#order-rest').isHidden(), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'choose-deliver');
  await page.click('#choose-collect');
  assert.equal(await text(page, '#chosen-text'), 'Collect from Sea Point');
  assert.equal(await page.inputValue('#name'), 'Typed Before');
  assert.equal(await page.locator('#address-field').isHidden(), true, 'no address needed');
  assert.equal(await page.locator('#collect-time').isVisible(), true);
  noErrors(errors);
});

test('order page: a customer can collect at a time they pick, and the delivery fee comes off', async (t) => {
  const { dev, page, errors } = await openKiosk(t, { mode: 'ready' });
  await choose(page, 'collect');
  assert.match(await text(page, '#summary'), /Collection\s+Free/);
  assert.equal(await text(page, '#submit'), 'Place order for R40');

  // Days come from Greg's settings, from tomorrow. Times appear once a day is picked.
  assert.equal(await page.locator('#collect-hour').isDisabled(), true);
  const days = await page.locator('#collect-day option').allInnerTexts();
  assert.deepEqual(days.slice(0, 3), ['Choose a day', 'Thu 29 Oct', 'Fri 30 Oct']);
  assert.ok(!days.some((d) => d.startsWith('Sun')), 'no Sundays by default');
  await page.selectOption('#collect-day', '2026-10-29');
  assert.deepEqual(await page.locator('#collect-hour option').allInnerTexts(), ['Choose a time', '17:00', '17:30', '18:00', '18:30']);
  await page.selectOption('#collect-hour', '17:30');

  await page.click('[aria-label="One more"]');
  await page.fill('#name', 'Sam Collect');
  await page.fill('#email', 'sam@example.com');
  await page.click('#submit');
  await page.waitForSelector('#view-done:not([hidden])');
  assert.match(await text(page, '#done-sub'), /Pay R80 by bank transfer/);
  assert.equal(await text(page, '#done-collect'), 'Collect on Thu 29 Oct, 17:30 from Sea Point. A calendar invite is emailed once your payment is confirmed.');

  const row = orderRows(dev)[0];
  assert.equal(row.Collect, 'yes');
  assert.equal(row['Collect at'], '2026-10-29 17:30');
  assert.equal(row['Delivery fee'], 0);
  assert.equal(row.Total, 80);
  assert.equal(row.Address, '');

  await page.click('#copy-invoice');
  const invoice = await clipboard(page);
  assert.match(invoice, /Collection: free\nTotal due: R80\n\nCollecting: Thu 29 Oct, 17:30, Sea Point/);

  // The next order starts with the choice again, and the booked time is gone.
  await page.click('#new-order');
  await page.waitForSelector('#order-form:not([hidden])');
  assert.equal(await page.locator('#choose').isVisible(), true);
  await page.click('#choose-collect');
  await page.selectOption('#collect-day', '2026-10-29');
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('#collect-hour option')).some((o) => o.value === '17:30'));
  await page.click('#choose-change');
  await page.click('#choose-deliver');
  assert.equal(await page.locator('#address-field').isHidden(), false);
  assert.equal(await text(page, '#submit'), 'Place order for R70');
  noErrors(errors);
});

test('order page: a collection needs a day and a time before anything is sent', async (t) => {
  const { dev, page } = await openKiosk(t, { mode: 'ready' });
  await choose(page, 'collect');
  await page.fill('#name', 'Sam');
  await page.fill('#email', 'sam@example.com');
  const before = dev.calls.length;
  await page.click('#submit');
  assert.equal(await text(page, '#form-error'), 'Pick a day to collect.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'collect-day');
  await page.selectOption('#collect-day', { index: 1 });
  await page.click('#submit');
  assert.equal(await text(page, '#form-error'), 'Pick a time to collect.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'collect-hour');
  assert.equal(dev.calls.length, before, 'nothing was sent');
});

test('order page: a time someone else just booked is refused, and the fresh times are shown', async (t) => {
  const { dev, page, errors } = await openKiosk(t, { mode: 'ready' });
  await fillKiosk(page, { collect: true, time: '17:00' });
  // Someone books the same time first.
  dev.gas.call({
    action: 'order', name: 'Quick', email: 'q@example.com', qty: 1, collect: true, address: '', notes: '', website: '',
    collectAt: '2026-10-29 17:00', requestId: 'quick_000001', expectedTotal: 40
  });
  await page.click('#submit');
  await page.waitForSelector('#form-error:not([hidden])');
  assert.match(await text(page, '#form-error'), /just been taken/);
  assert.equal(await page.inputValue('#collect-day'), '2026-10-29', 'the day stays picked');
  assert.equal(await page.inputValue('#collect-hour'), '');
  assert.ok(!(await page.locator('#collect-hour option').allInnerTexts()).includes('17:00'));
  await page.selectOption('#collect-hour', '17:30');
  await page.click('#submit');
  await page.waitForSelector('#view-done:not([hidden])');
  assert.equal(orderRows(dev)[1]['Collect at'], '2026-10-29 17:30');
  noErrors(errors);
});

test('order page: with every time booked, the customer is told to choose delivery or DM', async (t) => {
  const { dev, page } = await open(t, { mode: 'ready' });
  dev.gas.call({ action: 'saveSettings', key: dev.key, values: { collection_days: 'thu', collection_hours: '17:00-17:30', collection_days_ahead: '1' } });
  dev.gas.call({
    action: 'order', name: 'Quick', email: 'q@example.com', qty: 1, collect: true, address: '', notes: '', website: '',
    collectAt: '2026-10-29 17:00', requestId: 'quick_000001', expectedTotal: 40
  });
  await page.goto(kioskUrl(dev));
  await choose(page, 'collect');
  assert.match(await text(page, '#collect-hint'), /No collection times are free in the next 1 days\. Choose delivery, or send us a DM\./);
  assert.equal(await page.locator('#collect-day').isDisabled(), true);
  await page.fill('#name', 'Sam');
  await page.fill('#email', 'sam@example.com');
  await page.click('#submit');
  assert.match(await text(page, '#form-error'), /No collection times are free right now/);
});

test('order page: with fees confirmed per order, a delivery is sent as a request with nothing to pay yet', async (t) => {
  const { dev, page, errors } = await openKiosk(t, { mode: 'ready', quote: true });
  await page.waitForSelector('#order-form:not([hidden])');
  assert.equal(await text(page, '#choose-deliver-sub'), 'From R30');
  await choose(page, 'deliver');
  assert.match(await text(page, '#summary'), /Delivery\s+From R30/);
  assert.match(await text(page, '#summary'), /Total before delivery\s+R40/);
  assert.equal(await text(page, '#submit'), 'Send order for R40 + delivery');
  assert.match(await text(page, '#next-note'), /There is nothing to pay yet/);

  await fillKiosk(page, { more: 2 });
  await page.click('#submit');
  await page.waitForSelector('#view-done:not([hidden])');
  assert.equal(await text(page, '#done-title'), 'Order request sent');
  assert.match(await text(page, '#done-sub'), /email your invoice to jane@example\.com with the bank details\. There is nothing to pay yet\./);
  assert.equal(await text(page, '#bib .bib-number'), 'SJ-0001');
  assert.equal(await text(page, '#bib .bib-caption'), 'Your order number');
  assert.equal(await page.locator('#pay-section').isHidden(), true, 'no bank details');
  assert.equal(await page.locator('#copy-invoice').isHidden(), true);
  assert.ok(!(await page.content()).includes('0012345678'));

  const row = orderRows(dev)[0];
  assert.deepEqual([row.Status, row.Total, row['Delivery fee']], ['New request', 120, '']);
  assert.equal(dev.gas.mail.length, 1, 'only Greg is emailed');

  // After a reload it still reads as a request.
  await page.reload();
  await page.waitForSelector('#view-done:not([hidden])');
  assert.equal(await text(page, '#done-title'), 'Your last request');

  // Collection is not a request: it is priced and paid straight away.
  await page.click('#new-order');
  await choose(page, 'collect');
  assert.equal(await text(page, '#submit'), 'Place order for R40', 'a new order starts at 1, with no fee');
  noErrors(errors);
});

test('order page: free delivery is shown as Free', async (t) => {
  const { page } = await openKiosk(t, { mode: 'ready', fee: 0 });
  await page.waitForSelector('#order-form:not([hidden])');
  assert.equal(await text(page, '#choose-deliver-sub'), 'Free');
  await choose(page, 'deliver');
  assert.match(await text(page, '#summary'), /Delivery\s+Free/);
  assert.equal(await text(page, '#submit'), 'Place order for R40');
});

test('order page: placing an order shows the invoice number and bank details, and saves the order', async (t) => {
  const { dev, page, errors } = await openKiosk(t, { mode: 'ready' });
  await fillKiosk(page, { more: 2, notes: 'Ring twice' });
  await page.click('#submit');
  await page.waitForSelector('#view-done:not([hidden])');

  assert.equal(await text(page, '#done-title'), 'Order received');
  assert.equal(await text(page, '#bib .bib-number'), 'SJ-0001');
  assert.match(await text(page, '#done-sub'), /Pay R150 by bank transfer and use SJ-0001 as the reference/);
  const pay = await text(page, '#pay');
  for (const bit of ['R150', 'Test Bank', 'G Bolus', '0012345678', '250655', 'Cheque', 'SJ-0001']) {
    assert.ok(pay.includes(bit), 'payment details include ' + bit);
  }
  assert.match(await text(page, '#pay-note'), /We will confirm once your payment reflects/);

  // The form is gone, the order is in the sheet with the server's own numbers.
  assert.equal(await page.locator('#order-form').isHidden(), true);
  const rows = orderRows(dev);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Invoice, 'SJ-0001');
  assert.equal(rows[0].Source, 'kiosk');
  assert.equal(rows[0].Name, 'Jane Doe');
  assert.equal(rows[0].Qty, 3);
  assert.equal(rows[0].Total, 150);
  assert.equal(rows[0].Status, 'Awaiting payment');
  assert.equal(rows[0].Notes, 'Ring twice');

  assert.equal(rows[0].Email, 'jane@example.com');

  // Greg is emailed, and so is the customer, with the invoice PDF.
  assert.equal(dev.gas.mail.length, 2);
  assert.match(dev.gas.mail[0].subject, /New order SJ-0001: 3 x Running gel sachet \(R150\)/);
  assert.equal(dev.gas.mail[1].to, 'jane@example.com');
  assert.equal(dev.gas.mail[1].attachments[0].getName(), 'SJ-0001.pdf');
  assert.match(await text(page, '#done-email'), /We have emailed your invoice to jane@example.com/);

  // The page talks to the service the way Apps Script needs: text/plain, so no preflight.
  const posts = dev.calls.filter((c) => c.method === 'POST');
  assert.ok(posts.length >= 2);
  posts.forEach((c) => assert.match(c.contentType, /^text\/plain/));
  noErrors(errors);
});

test('order page: copy buttons put the right text on the clipboard', async (t) => {
  const { page } = await openKiosk(t, { mode: 'ready' });
  await fillKiosk(page, { more: 1 });
  await page.click('#submit');
  await page.waitForSelector('#view-done:not([hidden])');

  await page.locator('.pay-row', { hasText: 'Account number' }).getByRole('button', { name: 'Copy' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '0012345678');
  await page.locator('.pay-row', { hasText: 'Amount' }).getByRole('button', { name: 'Copy' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '110');
  await page.locator('.pay-row', { hasText: 'Reference' }).getByRole('button', { name: 'Copy' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'SJ-0001');

  await page.click('#copy-invoice');
  const invoice = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
  assert.match(invoice, /^SUPA JUICE\nInvoice SJ-0001\nDate: 28 Oct 2026\n/);
  assert.match(invoice, /2 x Running gel sachet @ R40 = R80\nDelivery: R30\nTotal due: R110/);
  assert.match(invoice, /Account number: 0012345678\n/);
  assert.match(invoice, /Reference: SJ-0001\n/);
  assert.equal(await text(page, '#copy-invoice'), 'Copied');
});

test('order page: the confirmation survives a reload, and Place another order starts fresh', async (t) => {
  const { page } = await openKiosk(t, { mode: 'ready' });
  await fillKiosk(page);
  await page.click('#submit');
  await page.waitForSelector('#view-done:not([hidden])');

  await page.reload();
  await page.waitForSelector('#view-done:not([hidden])');
  assert.equal(await text(page, '#done-title'), 'Your last order');
  assert.equal(await text(page, '#bib .bib-number'), 'SJ-0001');

  await page.click('#new-order');
  await page.waitForSelector('#order-form:not([hidden])');
  assert.equal(await page.inputValue('#qty'), '1');
  await page.reload();
  await page.waitForSelector('#order-form:not([hidden])');
});

test('order page: missing details are caught before anything is sent', async (t) => {
  const { dev, page } = await openKiosk(t, { mode: 'ready' });
  await choose(page, 'deliver');
  const before = dev.calls.length;

  await page.click('#submit');
  assert.match(await text(page, '#form-error'), /Enter your name/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'name');

  await page.fill('#name', 'Jane');
  await page.click('#submit');
  assert.match(await text(page, '#form-error'), /Enter your email address/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'email');

  await page.fill('#email', 'jane@example');
  await page.click('#submit');
  assert.match(await text(page, '#form-error'), /Check your email address/);

  await page.fill('#email', 'jane@example.com');
  await page.click('#submit');
  assert.match(await text(page, '#form-error'), /delivery address/);
  assert.equal(await page.locator('#area-ok').count(), 0, 'there is no delivery-area tick box');

  assert.equal(dev.calls.length, before, 'nothing was sent');
  assert.equal(orderRows(dev).length, 0);
});

test('order page: a double tap places one order', async (t) => {
  const { dev, page } = await openKiosk(t, { mode: 'ready', latency: 400 });
  await fillKiosk(page);
  await page.dblclick('#submit');
  await page.waitForSelector('#view-done:not([hidden])');
  assert.equal(orderRows(dev).length, 1);
});

test('order page: a dropped connection after the order was saved does not create a second order', async (t) => {
  const { dev, page } = await openKiosk(t, { mode: 'ready' });
  await fillKiosk(page, { more: 1 });

  // The first attempt reaches the service and is saved, but the reply never arrives.
  let dropped = false;
  await page.route('**/exec', async (route) => {
    if (!dropped && route.request().method() === 'POST' && route.request().postData().includes('"action":"order"')) {
      dropped = true;
      await route.fetch();
      await route.abort('failed');
      return;
    }
    await route.continue();
  });

  await page.click('#submit');
  await page.waitForSelector('#form-error:not([hidden])');
  assert.match(await text(page, '#form-error'), /Could not reach the order service/);
  assert.match(await text(page, '#form-error'), /Your details are still here/);
  assert.equal(await page.inputValue('#name'), 'Jane Doe');
  assert.equal(orderRows(dev).length, 1, 'the first attempt was saved');

  // Trying again sends the same request id, so the service hands back that order.
  await page.click('#submit');
  await page.waitForSelector('#view-done:not([hidden])');
  assert.equal(await text(page, '#bib .bib-number'), 'SJ-0001');
  assert.equal(orderRows(dev).length, 1, 'still one order');
});

test('order page: a failed connection keeps the details and offers a DM', async (t) => {
  const { page } = await openKiosk(t, { mode: 'ready' });
  await fillKiosk(page);
  await page.route('**/exec', (route) => (route.request().method() === 'POST' ? route.abort('failed') : route.continue()));
  await page.click('#submit');
  await page.waitForSelector('#form-error:not([hidden])');
  const link = page.locator('#form-error a');
  assert.equal(await link.getAttribute('href'), 'https://www.instagram.com/gregbolus02/');
  assert.equal(await page.inputValue('#address'), '12 Beach Rd, Sea Point');
  assert.equal(await page.locator('#submit').isDisabled(), false);
});

test('order page: an unexpected reply from the service is explained', async (t) => {
  const { page } = await openKiosk(t, { mode: 'ready' });
  await fillKiosk(page);
  await page.route('**/exec', (route) => (route.request().method() === 'POST'
    ? route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Please sign in</html>' })
    : route.continue()));
  await page.click('#submit');
  await page.waitForSelector('#form-error:not([hidden])');
  assert.match(await text(page, '#form-error'), /sent back something unexpected/);
});

test('order page: if the price changed while the form was open, the customer sees the new total first', async (t) => {
  const { dev, page } = await openKiosk(t, { mode: 'ready' });
  await fillKiosk(page, { more: 1 });
  assert.equal(await text(page, '#submit'), 'Place order for R110');

  dev.gas.call({ action: 'saveSettings', key: dev.key, values: { price: '50' } });

  await page.click('#submit');
  await page.waitForSelector('#form-error:not([hidden])');
  assert.match(await text(page, '#form-error'), /price has just changed/);
  assert.equal(await text(page, '#submit'), 'Place order for R130');
  assert.equal(orderRows(dev).length, 0, 'nothing was ordered at the old price');

  await page.click('#submit');
  await page.waitForSelector('#view-done:not([hidden])');
  assert.match(await text(page, '#done-sub'), /Pay R130/);
  assert.equal(orderRows(dev)[0].Total, 130);
});

test('order page: ordering is closed until the price and bank details are set', async (t) => {
  const { page, errors } = await openKiosk(t, { mode: 'empty' });
  await page.waitForSelector('#view-closed:not([hidden])');
  assert.equal(await text(page, '#closed-title'), 'Ordering opens soon');
  assert.equal(await page.locator('#order-form').isHidden(), true);
  assert.equal(await page.locator('#lede').isHidden(), true);
  assert.equal(await page.locator('#closed-dm a').getAttribute('href'), 'https://www.instagram.com/gregbolus02/');
  noErrors(errors);
});

test('order page: a page that is not connected yet says what to do', async (t) => {
  const { dev, page } = await open(t, { mode: 'ready' });
  dev.setEndpoint('PASTE_THE_WEB_APP_ADDRESS_HERE');
  await page.goto(kioskUrl(dev));
  await page.waitForSelector('#view-closed:not([hidden])');
  assert.equal(await text(page, '#closed-title'), 'We could not load the order form');
  assert.match(await text(page, '#closed-text'), /config\.js/);
  assert.equal(await page.locator('#closed-retry').isVisible(), true);
});

test('order page: when the service is down the page can be retried', async (t) => {
  const { dev, page } = await open(t, { mode: 'ready' });
  let down = true;
  await page.route('**/exec**', (route) => (down ? route.abort('failed') : route.continue()));
  await page.goto(kioskUrl(dev));
  await page.waitForSelector('#view-closed:not([hidden])');
  assert.equal(await text(page, '#closed-title'), 'We could not load the order form');
  assert.match(await text(page, '#closed-text'), /Could not reach the order service/);
  down = false;
  await page.click('#closed-retry');
  await page.waitForSelector('#order-form:not([hidden])');
  assert.equal(await text(page, '#submit'), 'Place order for R70');
});

test('order page: a bot that fills the hidden field is turned away', async (t) => {
  const { dev, page } = await openKiosk(t, { mode: 'ready' });
  await fillKiosk(page);
  await page.evaluate(() => { document.getElementById('website').value = 'http://spam.example'; });
  await page.click('#submit');
  await page.waitForSelector('#form-error:not([hidden])');
  assert.match(await text(page, '#form-error'), /Could not place the order/);
  assert.equal(orderRows(dev).length, 0);
});

// ---------------------------------------------------------------------------
// Greg's page
// ---------------------------------------------------------------------------

const store = (page, key) => page.evaluate((k) => {
  const v = window.localStorage.getItem(k);
  return v === null ? null : JSON.parse(v);
}, key);

// Windows hands back copied line breaks as \r\n.
const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText()).then((s) => s.replace(/\r\n/g, '\n'));

async function chip(page, id) {
  await page.click('[data-role="chip-' + id + '"]');
  assert.equal(await page.getAttribute('[data-role="chip-' + id + '"]', 'aria-pressed'), 'true');
}

async function more(page, invoice, label) {
  await card(page, invoice).locator('details.more > summary').click();
  await card(page, invoice).getByRole('button', { name: label }).click();
}

// Toasts replace one another, so wait for the one that is expected rather than the first one seen.
async function toast(page, expected) {
  await page.waitForFunction((want) => {
    const n = document.getElementById('toast');
    return !!n && !n.hidden && (want instanceof Object ? new RegExp(want.source).test(n.textContent) : n.textContent === want);
  }, typeof expected === 'string' ? expected : { source: expected.source });
}

const chipCounts = (page) => page.evaluate(() => {
  const out = {};
  document.querySelectorAll('.chip').forEach((c) => {
    out[c.getAttribute('data-role').replace('chip-', '')] = Number(c.querySelector('.chip-count').textContent);
  });
  return out;
});

const serverStatus = (dev, invoice) => orderRows(dev).find((r) => r.Invoice === invoice);

test('admin: asks for the key, refuses a wrong one, accepts the right one, and can be locked', async (t) => {
  const { dev, page, errors } = await open(t);
  await page.goto(dev.siteUrl + '/admin.html');
  await page.waitForSelector('#login:not([hidden])');
  assert.equal(await page.locator('#topbar').isHidden(), true);

  await page.fill('#key', 'this-is-not-the-key-0123456789');
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#login-error:not([hidden])');
  assert.equal(await text(page, '#login-error'), 'That admin key is not right.');
  assert.equal(await store(page, 'sj_admin_key'), null);
  assert.equal(await page.locator('#topbar').isHidden(), true);

  await page.fill('#key', dev.key);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('.order');
  assert.equal(await page.locator('#topbar').isVisible(), true);
  assert.equal(await store(page, 'sj_admin_key'), dev.key);

  // Opening the page again later needs no key.
  await page.goto(dev.siteUrl + '/admin.html');
  await page.waitForSelector('.order');

  await page.click('#lock');
  await page.waitForSelector('#login:not([hidden])');
  assert.equal(await store(page, 'sj_admin_key'), null);
  assert.equal(await page.locator('.order').count(), 0, 'orders are cleared from the page');
  noErrors(errors.filter((e) => !/401|403/.test(e)));
});

test('admin: the private link signs in and is then removed from the address bar', async (t) => {
  const { dev, page } = await open(t);
  await page.goto(dev.adminUrl());
  await page.waitForSelector('.order');
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(await store(page, 'sj_admin_key'), dev.key);

  // Same with the k= form of the link.
  await page.evaluate(() => window.localStorage.clear());
  await page.goto('about:blank');
  await page.goto(dev.siteUrl + '/admin.html#k=' + dev.key);
  await page.waitForSelector('.order');
  assert.equal(new URL(page.url()).hash, '');
});

test('admin: opening the private link on the login screen of the same tab works', async (t) => {
  const { dev, page } = await open(t);
  await page.goto(dev.siteUrl + '/admin.html');
  await page.waitForSelector('#login:not([hidden])');
  await page.evaluate((k) => { window.location.hash = k; }, dev.key);
  await page.waitForSelector('.order');
});

test('admin: a bad link falls back to the login screen', async (t) => {
  const { dev, page } = await open(t);
  await page.goto(dev.adminUrl('wrongwrongwrongwrong1234'));
  await page.waitForSelector('#login:not([hidden])');
  assert.match(await text(page, '#login-error'), /not right/);
});

test('admin: shows the orders that need attention first, newest on top, with the facts Greg needs', async (t) => {
  const { page, errors } = await openAdmin(t);
  await page.waitForSelector('.order');

  assert.deepEqual(await chipCounts(page), { awaiting: 2, paid: 1, delivered: 1, cancelled: 1 });
  assert.equal(await page.getAttribute('[data-role="chip-awaiting"]', 'aria-pressed'), 'true');
  assert.equal(await text(page, '.list-total'), '2 orders waiting for payment, R340 in total.');

  const invoices = await page.locator('article.order .badge').allInnerTexts();
  assert.deepEqual(invoices, ['SJ-0005', 'SJ-0004']);

  const c5 = card(page, 'SJ-0005');
  const t5 = await c5.innerText();
  assert.match(t5, /R230/);
  assert.match(t5, /Pieter van der Merwe/);
  assert.match(t5, /Awaiting payment/);
  assert.match(t5, /5 x Running gel sachet at R40, delivery R30/);
  assert.match(t5, /Look for R230 with reference SJ-0005 on your bank statement\./);
  assert.match(t5, /Gate code 4412\. Please call on arrival\./);
  assert.match(t5, /Ordered Wed 28 Oct, 07:30/);
  assert.match(t5, /From the order page/);
  assert.equal(await c5.locator('a', { hasText: '0719876543' }).getAttribute('href'), 'tel:0719876543');
  assert.equal(
    await c5.locator('a', { hasText: '22 Main Rd' }).getAttribute('href'),
    'https://www.google.com/maps/search/?api=1&query=22%20Main%20Rd%2C%20Claremont%2C%20Cape%20Town'
  );

  const c4 = card(page, 'SJ-0004');
  assert.match(await c4.innerText(), /DM order/);
  assert.equal(await c4.locator('a', { hasText: '@ayesha_trails' }).getAttribute('href'), 'https://www.instagram.com/ayesha_trails/');

  // The yellow badge marks orders waiting for payment, and only those.
  assert.equal(await c5.locator('.badge--attention').count(), 1);
  await chip(page, 'paid');
  assert.equal(await page.locator('.badge--attention').count(), 0);
  assert.equal(await text(page, '.list-total'), '1 paid order to deliver, R70 in total.');
  assert.equal(await card(page, 'SJ-0003').locator('a', { hasText: '082 555 0147' }).getAttribute('href'), 'tel:0825550147');
  noErrors(errors);
});

test('admin: with no unpaid orders it opens on the paid ones, and empty lists say so', async (t) => {
  const { dev, page } = await open(t);
  dev.gas.call({ action: 'setStatus', key: dev.key, invoice: 'SJ-0004', status: 'Cancelled' });
  dev.gas.call({ action: 'setStatus', key: dev.key, invoice: 'SJ-0005', status: 'Cancelled' });
  await page.goto(dev.adminUrl());
  await page.waitForSelector('.order');
  assert.equal(await page.getAttribute('[data-role="chip-paid"]', 'aria-pressed'), 'true');
  await chip(page, 'awaiting');
  assert.match(await text(page, '.empty'), /Nothing is waiting for payment/);
});

test('admin: a brand new shop shows an empty list with a way to add the first order', async (t) => {
  const { page } = await openAdmin(t, { mode: 'ready' });
  assert.match(await text(page, '.empty'), /No orders yet/);
  await page.getByRole('button', { name: 'New order' }).first().click();
  await page.waitForSelector('#panel-new:not([hidden])');
});

test('admin: marking an order paid asks first, then moves it to Paid, ready to copy', async (t) => {
  const { dev, page, errors } = await openAdmin(t);
  await page.waitForSelector('.order');
  const c5 = card(page, 'SJ-0005');

  await c5.locator('[data-role="mark-paid"]').click();
  assert.match(await c5.locator('.confirm-row').innerText(), /Is R230 with reference SJ-0005 in your account\?/);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-role')), 'confirm');
  assert.equal(serverStatus(dev, 'SJ-0005').Status, 'Awaiting payment', 'nothing saved yet');

  await c5.getByRole('button', { name: 'Not yet' }).click();
  assert.equal(await c5.locator('.confirm-row').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-role')), 'mark-paid');

  await c5.locator('[data-role="mark-paid"]').click();
  await c5.getByRole('button', { name: 'Yes, mark paid' }).click();
  await toast(page, 'SJ-0005 marked paid. The paid invoice was emailed to pieter@example.com.');

  // Greg lands on the Paid list with the order highlighted and the Copy button ready.
  assert.equal(await page.getAttribute('[data-role="chip-paid"]', 'aria-pressed'), 'true');
  const paid = card(page, 'SJ-0005');
  await paid.waitFor();
  assert.equal(await paid.evaluate((n) => n.classList.contains('order--flash')), true);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-role')), 'copy');
  assert.match(await paid.innerText(), /Paid/);
  assert.match(await paid.innerText(), /Paid Wed 28 Oct, 15:41/);
  assert.equal(await paid.locator('.badge--attention').count(), 0);
  assert.deepEqual(await chipCounts(page), { awaiting: 1, paid: 2, delivered: 1, cancelled: 1 });

  const row = serverStatus(dev, 'SJ-0005');
  assert.equal(row.Status, 'Paid');
  assert.equal(row['Paid on'], '2026-10-28 15:41');
  noErrors(errors);
});

test('admin: the paid invoice and the unpaid invoice copy as the text Greg pastes into a DM', async (t) => {
  const { page } = await openAdmin(t);
  await page.waitForSelector('.order');

  await card(page, 'SJ-0005').locator('[data-role="copy"]').click();
  assert.equal(await clipboard(page), [
    'SUPA JUICE',
    'Invoice SJ-0005',
    'Date: 28 Oct 2026',
    '',
    'For: Pieter van der Merwe',
    '5 x Running gel sachet @ R40 = R200',
    'Delivery: R30',
    'Total due: R230',
    '',
    'Pay by bank transfer',
    'Bank: Test Bank',
    'Account holder: G Bolus',
    'Account number: 0012345678',
    'Branch code: 250655',
    'Account type: Cheque',
    'Amount: R230',
    'Reference: SJ-0005',
    '',
    'We will confirm once your payment reflects in our account, then deliver.'
  ].join('\n'));
  assert.equal(await card(page, 'SJ-0005').locator('[data-role="copy"]').innerText(), 'Copied');

  await chip(page, 'paid');
  await card(page, 'SJ-0003').locator('[data-role="copy"]').click();
  assert.equal(await clipboard(page), [
    'SUPA JUICE',
    'Invoice SJ-0003 (PAID)',
    'Date: 27 Oct 2026',
    'Paid: 27 Oct 2026',
    '',
    'For: Liam Peters',
    '1 x Running gel sachet @ R40 = R40',
    'Delivery: R30',
    'Total paid: R70',
    '',
    'Thank you for your order.'
  ].join('\n'));
});

test('admin: where copying is blocked the invoice text is shown to select by hand', async (t) => {
  const { page } = await openAdmin(t, {
    init: () => {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      document.execCommand = () => false;
    }
  });
  await page.waitForSelector('.order');
  await card(page, 'SJ-0005').locator('[data-role="copy"]').click();
  const preview = card(page, 'SJ-0005').locator('.preview');
  await preview.waitFor();
  assert.match(await preview.innerText(), /Invoice SJ-0005\nDate: 28 Oct 2026/);
  assert.match(await preview.innerText(), /Reference: SJ-0005/);
  assert.match(await text(page, 'article.order[aria-label="Order SJ-0005"]'), /Copying is blocked here/);
  await card(page, 'SJ-0005').getByRole('button', { name: 'Close' }).click();
  assert.equal(await page.locator('.preview').count(), 0);
});

test('admin: delivering, undoing, cancelling and reopening update the order and the counts', async (t) => {
  const { dev, page, errors } = await openAdmin(t);
  await page.waitForSelector('.order');

  // Paid -> Delivered
  await chip(page, 'paid');
  await card(page, 'SJ-0003').locator('[data-role="mark-delivered"]').click();
  await toast(page, 'SJ-0003 marked delivered.');
  assert.equal(await page.locator('article.order').count(), 0);
  assert.match(await text(page, '.empty'), /No paid orders are waiting for delivery/);
  assert.equal(serverStatus(dev, 'SJ-0003').Status, 'Delivered');
  assert.equal(serverStatus(dev, 'SJ-0003')['Delivered on'], '2026-10-28 15:41');
  assert.deepEqual(await chipCounts(page), { awaiting: 2, paid: 0, delivered: 2, cancelled: 1 });

  // Delivered -> back to Paid keeps the original paid date
  await chip(page, 'delivered');
  await more(page, 'SJ-0001', 'Undo delivered');
  await toast(page, 'SJ-0001 is back under Paid.');
  assert.equal(serverStatus(dev, 'SJ-0001').Status, 'Paid');
  assert.equal(serverStatus(dev, 'SJ-0001')['Paid on'], '2026-10-26 10:03');
  assert.equal(serverStatus(dev, 'SJ-0001')['Delivered on'], '');

  // Paid -> back to Awaiting payment clears the paid date
  await chip(page, 'paid');
  await more(page, 'SJ-0001', 'Undo paid');
  assert.equal(serverStatus(dev, 'SJ-0001').Status, 'Awaiting payment');
  assert.equal(serverStatus(dev, 'SJ-0001')['Paid on'], '');

  // Awaiting -> Cancelled, after a confirmation
  await chip(page, 'awaiting');
  await more(page, 'SJ-0004', 'Cancel order');
  assert.match(await card(page, 'SJ-0004').locator('.confirm-row').innerText(), /Cancel SJ-0004 for Ayesha Davids\?/);
  await card(page, 'SJ-0004').getByRole('button', { name: 'Keep order' }).click();
  assert.equal(serverStatus(dev, 'SJ-0004').Status, 'Awaiting payment');
  await more(page, 'SJ-0004', 'Cancel order');
  await card(page, 'SJ-0004').getByRole('button', { name: 'Yes, cancel order' }).click();
  await toast(page, 'SJ-0004 cancelled.');
  assert.equal(serverStatus(dev, 'SJ-0004').Status, 'Cancelled');

  // Cancelled -> reopened
  await chip(page, 'cancelled');
  await card(page, 'SJ-0002').locator('[data-role="reopen"]').click();
  await toast(page, 'SJ-0002 is waiting for payment again.');
  assert.equal(serverStatus(dev, 'SJ-0002').Status, 'Awaiting payment');
  assert.deepEqual(await chipCounts(page), { awaiting: 3, paid: 0, delivered: 1, cancelled: 1 });
  noErrors(errors);
});

test('admin: a change made on another phone is explained and the list catches up', async (t) => {
  const { dev, page } = await openAdmin(t);
  await page.waitForSelector('.order');
  // Someone cancels SJ-0005 elsewhere while this page still shows it as waiting.
  dev.gas.call({ action: 'setStatus', key: dev.key, invoice: 'SJ-0005', status: 'Cancelled' });

  await card(page, 'SJ-0005').locator('[data-role="mark-paid"]').click();
  await card(page, 'SJ-0005').getByRole('button', { name: 'Yes, mark paid' }).click();
  await toast(page, /An order that is Cancelled cannot be changed to Paid/);
  await page.waitForFunction(() => document.querySelectorAll('article.order').length === 1);
  assert.deepEqual(await chipCounts(page), { awaiting: 1, paid: 1, delivered: 1, cancelled: 2 });
  assert.equal(serverStatus(dev, 'SJ-0005').Status, 'Cancelled');
});

test('admin: Refresh and coming back to the page pick up new orders', async (t) => {
  const { dev, page } = await openAdmin(t);
  await page.waitForSelector('.order');
  const place = (name) => dev.gas.call({
    action: 'order', email: 'buyer@example.com', name, contact: '@x_' + name.toLowerCase(), address: '1 Test St', notes: '', qty: 1,
    areaConfirmed: true, requestId: 'req' + name + '0123456789', expectedTotal: 70, website: ''
  });

  assert.equal(place('Sipho').ok, true);
  assert.deepEqual((await chipCounts(page)).awaiting, 2, 'not seen yet');
  await page.click('[data-role="refresh"]');
  await page.waitForFunction(() => document.querySelectorAll('article.order').length === 3);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-role')), 'refresh');

  // Returning to the tab after a while refreshes without a tap.
  assert.equal(place('Thabo').ok, true);
  await page.evaluate(() => {
    const real = Date.now;
    Date.now = () => real() + 120000;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => document.querySelectorAll('article.order').length === 4);
});

test('admin: when the key stops working the page locks itself', async (t) => {
  const { dev, page } = await openAdmin(t);
  await page.waitForSelector('.order');
  dev.gas.run('rotateAdminKey()');
  await page.click('[data-role="refresh"]');
  await page.waitForSelector('#login:not([hidden])');
  assert.match(await text(page, '#login-error'), /not right/);
  assert.equal(await store(page, 'sj_admin_key'), null);
  assert.equal(await page.locator('.order').count(), 0);
});

test('admin: the page says when it cannot reach the service, and can try again', async (t) => {
  const { dev, page } = await open(t);
  let down = true;
  await page.route('**/exec**', (route) => (down ? route.abort('failed') : route.continue()));
  await page.goto(dev.adminUrl());
  await page.waitForSelector('#load-error:not([hidden])');
  assert.match(await text(page, '#load-error-text'), /Could not reach the order service/);
  down = false;
  await page.click('#load-retry');
  await page.waitForSelector('.order');
  assert.equal(await store(page, 'sj_admin_key'), dev.key, 'the key was kept while the service was down');
});

test('admin: a page that is not connected yet says what to do', async (t) => {
  const { dev, page } = await open(t);
  dev.setEndpoint('PASTE_THE_WEB_APP_ADDRESS_HERE');
  await page.goto(dev.adminUrl());
  await page.waitForSelector('#load-error:not([hidden])');
  assert.match(await text(page, '#load-error-text'), /config\.js/);
});

test('admin: customer text is shown as plain text, never as page code', async (t) => {
  const { dev, page } = await open(t);
  const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
  const res = dev.gas.call({
    action: 'order', email: 'buyer@example.com', name: evil, contact: '@evil_one', address: '<b>1 Test St</b>', notes: evil, qty: 1,
    areaConfirmed: true, requestId: 'evilrequest0123456', expectedTotal: 70, website: ''
  });
  assert.equal(res.ok, true);
  await page.goto(dev.adminUrl());
  await page.waitForSelector('.order');
  const c = card(page, res.order.invoice);
  assert.ok((await c.locator('.order-name').innerText()).includes('<img src=x'), 'shown literally');
  assert.equal(await c.locator('img, script, b').count(), 0, 'no elements were created from it');
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  await c.locator('[data-role="copy"]').click();
  assert.ok((await clipboard(page)).includes('For: ' + evil));
});

// --- New order from a DM ---

test('admin: a DM order is created, shows the invoice to send, and appears in the list', async (t) => {
  const { dev, page, errors } = await openAdmin(t);
  const mailBefore = dev.gas.mail.length;
  await page.click('.tab[data-tab="new"]');
  await page.waitForSelector('#panel-new:not([hidden])');
  assert.equal(await page.evaluate(() => document.querySelector('.tab[aria-current="page"]').dataset.tab), 'new');
  assert.match(await text(page, '#n-summary'), /Total\s+R70/);

  await page.click('[aria-label="One more"]');
  await page.click('[aria-label="One more"]');
  assert.match(await text(page, '#n-summary'), /Total\s+R150/);
  await page.fill('#n-name', 'Zanele Dlamini');
  await page.fill('#n-contact', '@zanele_d');
  await page.fill('#n-notes', 'Collect Friday');
  await page.click('#n-submit');
  await page.waitForSelector('#new-result:not([hidden])');

  assert.equal(await text(page, '#created-title'), 'SJ-0006 created');
  const shown = await text(page, '#new-result .preview');
  assert.match(shown, /^SUPA JUICE\nInvoice SJ-0006\nDate: 28 Oct 2026\n/);
  assert.match(shown, /For: Zanele Dlamini\n3 x Running gel sachet @ R40 = R120\nDelivery: R30\nTotal due: R150/);
  assert.match(shown, /Account number: 0012345678/);
  assert.match(shown, /Reference: SJ-0006/);

  await page.click('#new-result .btn-primary');
  assert.equal(await clipboard(page), shown);

  const row = serverStatus(dev, 'SJ-0006');
  assert.equal(row.Source, 'dm');
  assert.equal(row.Name, 'Zanele Dlamini');
  assert.equal(row.Total, 150);
  assert.equal(row.Status, 'Awaiting payment');
  assert.equal(dev.gas.mail.length, mailBefore, 'no alert email for orders Greg adds himself');

  await page.getByRole('button', { name: 'Back to orders' }).click();
  await page.waitForSelector('#panel-orders:not([hidden])');
  const c = card(page, 'SJ-0006');
  await c.waitFor();
  assert.equal(await c.evaluate((n) => n.classList.contains('order--flash')), true);
  assert.deepEqual((await chipCounts(page)).awaiting, 3);
  assert.match(await c.innerText(), /DM order/);

  // And another order can be started with a clean form.
  await page.click('.tab[data-tab="new"]');
  await page.getByRole('button', { name: 'New order' }).last().click();
  assert.equal(await page.inputValue('#n-name'), '');
  assert.equal(await page.inputValue('#n-qty'), '1');
  noErrors(errors);
});

test('admin: a DM order with an email gets the invoice PDF, and a bad address is caught first', async (t) => {
  const { dev, page, errors } = await openAdmin(t);
  await page.waitForSelector('.order');
  await page.click('.tab[data-tab="new"]');
  await page.fill('#n-name', 'Zanele Dlamini');
  await page.fill('#n-email', 'zanele@example');
  await page.click('#n-submit');
  assert.match(await text(page, '#n-error'), /Check the email address/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'n-email');

  const mailBefore = dev.gas.mail.length;
  await page.fill('#n-email', 'zanele@example.com');
  await page.click('#n-submit');
  await page.waitForSelector('#new-result:not([hidden])');
  assert.match(await text(page, '#new-result'), /The invoice PDF was also emailed to zanele@example.com/);
  assert.equal(dev.gas.mail.length, mailBefore + 1);
  assert.equal(dev.gas.mail[mailBefore].to, 'zanele@example.com');
  assert.equal(serverStatus(dev, 'SJ-0006').Email, 'zanele@example.com');
  noErrors(errors);
});

test('admin: an order shows its email and when the invoice was emailed, and can email it again', async (t) => {
  const { dev, page, errors } = await openAdmin(t);
  await page.waitForSelector('.order');
  const c5 = card(page, 'SJ-0005');
  const link = c5.getByRole('link', { name: 'pieter@example.com' });
  assert.equal(await link.getAttribute('href'), 'mailto:pieter@example.com');
  assert.match(await c5.innerText(), /Invoice emailed Wed 28 Oct, 07:30/);

  // The DM order without an email has nothing to resend.
  await card(page, 'SJ-0004').locator('details.more > summary').click();
  assert.equal(await card(page, 'SJ-0004').locator('[data-role="email"]').count(), 0);

  const mailBefore = dev.gas.mail.length;
  await more(page, 'SJ-0005', 'Email invoice');
  await toast(page, 'Invoice SJ-0005 emailed to pieter@example.com.');
  assert.equal(dev.gas.mail.length, mailBefore + 1);
  assert.match(await card(page, 'SJ-0005').innerText(), /Invoice emailed Wed 28 Oct, 15:41/);

  // When sending fails, Greg is told and the order is unchanged.
  dev.gas.mailQuota.left = 0;
  await more(page, 'SJ-0005', 'Email invoice');
  await toast(page, /could not be sent/);
  assert.equal(serverStatus(dev, 'SJ-0005').Status, 'Awaiting payment');
  noErrors(errors);
});

test('admin: Greg sets a minimum order and the DM form starts from it', async (t) => {
  const { page, errors } = await openAdmin(t);
  await page.waitForSelector('.order');
  await page.click('.tab[data-tab="settings"]');
  await page.waitForSelector('#settings-form');
  assert.equal(await page.inputValue('#s-min_quantity'), '1');

  await page.fill('#s-min_quantity', '30');
  await page.click('#settings-save');
  await page.waitForFunction(() => /cannot be more than/.test(document.getElementById('settings-error').textContent));

  await page.fill('#s-min_quantity', '2');
  await page.click('#settings-save');
  await toast(page, 'Settings saved.');

  await page.click('.tab[data-tab="new"]');
  assert.equal(await page.inputValue('#n-qty'), '2');
  assert.match(await text(page, '#n-summary'), /Total\s+R110/);
  assert.equal(await page.locator('#panel-new [aria-label="One fewer"]').isDisabled(), true);
  noErrors(errors);
});

// --- Order page photo ---

// A real 2400 x 1600 PNG, drawn in the browser, bigger than the admin page sends.
const bigPng = (page) => page.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 2400;
  c.height = 1600;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 2400, 1600);
  g.addColorStop(0, '#222');
  g.addColorStop(1, '#ddd');
  x.fillStyle = g;
  x.fillRect(0, 0, 2400, 1600);
  for (let i = 0; i < 400; i++) {
    x.fillStyle = 'rgb(' + (i * 37 % 255) + ',' + (i * 91 % 255) + ',' + (i * 53 % 255) + ')';
    x.fillRect(i * 97 % 2400, i * 61 % 1600, 40 + i % 90, 30 + i % 70);
  }
  return c.toDataURL('image/png').split(',')[1];
}).then((b64) => Buffer.from(b64, 'base64'));

const photoCalls = (dev) => dev.calls.filter((c) => c.action === 'photo').length;

async function openPhotoSettings(page) {
  await page.click('.tab[data-tab="settings"]');
  await page.waitForSelector('#photo-section h2');
}

test('admin: Greg adds a photo, it is made smaller on the phone, and the order page shows it', async (t) => {
  const { dev, page, errors } = await openAdmin(t);
  await page.waitForSelector('.order');
  await openPhotoSettings(page);
  assert.equal(await page.locator('#photo-pick').innerText(), 'Add photo');
  assert.equal(await page.locator('#photo-preview').count(), 0);

  await page.fill('#photo-alt', 'Gel sachets on a trail run');
  await page.setInputFiles('#photo-file', { name: 'trail.png', mimeType: 'image/png', buffer: await bigPng(page) });
  await toast(page, 'Photo saved. It now shows on your order page.');
  assert.equal(await page.locator('#photo-pick').innerText(), 'Replace photo');
  await page.waitForFunction(() => {
    const img = document.getElementById('photo-preview');
    return img && img.complete && img.naturalWidth > 0;
  });

  // What reached the sheet: a JPEG no wider than 1600 px and under 350 KB.
  const stored = dev.gas.call({ action: 'photo' }).photo;
  assert.equal(stored.type, 'image/jpeg');
  assert.ok(stored.data.length * 3 / 4 <= 350 * 1024, 'about ' + Math.round(stored.data.length * 3 / 4 / 1024) + ' KB');
  const cfg = dev.gas.call({ action: 'config' }).config.photo;
  assert.deepEqual([cfg.width, cfg.height, cfg.alt], [1600, 1067, 'Gel sachets on a trail run']);

  // The customer sees it above the form, with the space kept free while it loads.
  const callsBefore = photoCalls(dev);
  const customer = await page.context().newPage();
  await customer.goto(kioskUrl(dev));
  await customer.waitForSelector('#order-form:not([hidden])');
  await customer.waitForFunction(() => {
    const img = document.getElementById('photo-img');
    return !document.getElementById('photo').hidden && img.complete && img.naturalWidth === 1600;
  });
  assert.equal(await customer.getAttribute('#photo-img', 'alt'), 'Gel sachets on a trail run');
  assert.equal(await customer.evaluate(() => document.getElementById('photo').style.aspectRatio), '1600 / 1067');
  assert.equal(photoCalls(dev), callsBefore + 1);

  // A second visit uses the copy saved on the phone.
  await customer.reload();
  await customer.waitForFunction(() => document.getElementById('photo-img').naturalWidth === 1600);
  assert.equal(photoCalls(dev), callsBefore + 1, 'not downloaded again');

  // The photo belongs to the form: it is not shown with the order confirmation.
  await fillKiosk(customer);
  await customer.click('#submit');
  await customer.waitForSelector('#view-done:not([hidden])');
  assert.equal(await customer.locator('#photo').isHidden(), true);
  noErrors(errors);
});

test('admin: the photo description can be changed, and the photo removed', async (t) => {
  const { dev, page, errors } = await openAdmin(t);
  await page.waitForSelector('.order');
  await openPhotoSettings(page);
  await page.setInputFiles('#photo-file', { name: 'trail.png', mimeType: 'image/png', buffer: await bigPng(page) });
  await toast(page, 'Photo saved. It now shows on your order page.');
  const version = dev.gas.call({ action: 'config' }).config.photo.version;

  await page.fill('#photo-alt', 'Sachets lined up at a race');
  await page.click('[data-role="photo-alt-save"]');
  await toast(page, 'Photo description saved.');
  const after = dev.gas.call({ action: 'config' }).config.photo;
  assert.equal(after.alt, 'Sachets lined up at a race');
  assert.equal(after.version, version, 'same picture, so phones keep their copy');

  const customer = await page.context().newPage();
  await customer.goto(kioskUrl(dev));
  await customer.waitForFunction(() => document.getElementById('photo-img').naturalWidth > 0);
  assert.equal(await customer.getAttribute('#photo-img', 'alt'), 'Sachets lined up at a race');

  await page.click('[data-role="photo-remove"]');
  await toast(page, 'Photo removed from your order page.');
  assert.equal(await page.locator('#photo-pick').innerText(), 'Add photo');
  assert.equal(dev.gas.call({ action: 'config' }).config.photo, null);

  await customer.reload();
  await customer.waitForSelector('#order-form:not([hidden])');
  await customer.waitForFunction(() => document.getElementById('photo').hidden && !document.getElementById('photo-img').getAttribute('src'));
  assert.equal(await customer.evaluate(() => window.localStorage.getItem('sj_photo')), null, 'the saved copy is cleared');
  noErrors(errors);
});

test('admin: a file that is not a picture is refused and nothing changes', async (t) => {
  const { dev, page } = await openAdmin(t);
  await page.waitForSelector('.order');
  await openPhotoSettings(page);
  await page.setInputFiles('#photo-file', { name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('these are not pixels') });
  await toast(page, 'The photo was not changed.');
  assert.match(await text(page, '#photo-status'), /could not be opened here/);
  assert.equal(await page.locator('#photo-pick').isDisabled(), false, 'Greg can try again');
  assert.equal(dev.gas.call({ action: 'config' }).config.photo, null);
  assert.equal(dev.gas.sheet('Photo'), null);
});

// --- Collection and editing on Greg's page ---

test('admin: Greg edits an unpaid order completely, and the customer gets the new invoice', async (t) => {
  const { dev, page, errors } = await openAdmin(t);
  await page.waitForSelector('.order');
  const c5 = card(page, 'SJ-0005');
  await c5.locator('[data-role="edit"]').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'e-name', 'the form opens ready to type');
  assert.equal(await page.inputValue('#e-qty'), '5');
  assert.equal(await page.inputValue('#e-price'), '40');
  assert.equal(await page.inputValue('#e-fee'), '30');
  assert.match(await c5.innerText(), /New total: R230/);
  assert.equal(await page.isChecked('#e-send'), true, 'emailing the new invoice is ticked');
  assert.match(await c5.innerText(), /Email the updated invoice to pieter@example\.com/);

  await page.fill('#e-qty', '6');
  await page.fill('#e-price', '35');
  await page.check('#e-collect');
  assert.equal(await page.locator('#e-fee').isHidden(), true);
  assert.equal(await page.locator('#e-address').isHidden(), true);
  assert.match(await c5.innerText(), /New total: R210/);
  await page.fill('#e-notes', 'Collecting Saturday');

  const mailBefore = dev.gas.mail.length;
  await c5.locator('[data-role="edit-save"]').click();
  await toast(page, 'SJ-0005 updated. The new invoice was emailed to pieter@example.com.');
  const after = card(page, 'SJ-0005');
  assert.match(await after.innerText(), /6 x Running gel sachet at R35, collection/);
  assert.match(await after.innerText(), /R210/);
  assert.match(await after.innerText(), /The customer collects this order/);
  assert.match(await after.innerText(), /Edited Wed 28 Oct, 15:41/);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-role')), 'edit');

  const row = serverStatus(dev, 'SJ-0005');
  assert.deepEqual([row.Qty, row['Unit price'], row['Delivery fee'], row.Total, row.Collect, row.Notes], [6, 35, 0, 210, 'yes', 'Collecting Saturday']);
  assert.equal(dev.gas.mail.length, mailBefore + 1);
  assert.match(dev.gas.mail[mailBefore].body, /6 x Running gel sachet @ R35 = R210\nCollection: free\nTotal due: R210/);

  // Once paid, the next step reads "Mark collected", and editing is no longer offered.
  await after.locator('[data-role="mark-paid"]').click();
  await after.getByRole('button', { name: 'Yes, mark paid' }).click();
  await toast(page, /SJ-0005 marked paid/);
  const paid = card(page, 'SJ-0005');
  assert.equal(await paid.locator('[data-role="mark-delivered"]').innerText(), 'Mark collected');
  assert.equal(await paid.locator('[data-role="edit"]').count(), 0);
  await paid.locator('[data-role="mark-delivered"]').click();
  await toast(page, 'SJ-0005 marked collected.');
  noErrors(errors);
});

test('admin: an edit can be cancelled, a mistake is explained, and unticking skips the email', async (t) => {
  const { dev, page, errors } = await openAdmin(t);
  await page.waitForSelector('.order');
  const c5 = card(page, 'SJ-0005');
  await c5.locator('[data-role="edit"]').click();
  await page.fill('#e-name', 'Somebody Else');
  await c5.locator('[data-role="edit-cancel"]').click();
  assert.match(await c5.innerText(), /Pieter van der Merwe/);
  assert.equal(serverStatus(dev, 'SJ-0005').Name, 'Pieter van der Merwe');

  await c5.locator('[data-role="edit"]').click();
  assert.equal(await page.inputValue('#e-name'), 'Pieter van der Merwe', 'a cancelled draft is not kept');
  await page.fill('#e-qty', '0');
  assert.match(await c5.innerText(), /Check the quantity and prices/);
  await c5.locator('[data-role="edit-save"]').click();
  await page.waitForSelector('article.order[aria-label="Order SJ-0005"] .alert-bad');
  assert.match(await c5.locator('.alert-bad').innerText(), /quantity/);
  assert.equal(await page.inputValue('#e-qty'), '0', 'what Greg typed is still there');
  assert.equal(serverStatus(dev, 'SJ-0005').Qty, 5);

  const mailBefore = dev.gas.mail.length;
  await page.fill('#e-qty', '7');
  await page.uncheck('#e-send');
  await c5.locator('[data-role="edit-save"]').click();
  await toast(page, 'SJ-0005 updated.');
  assert.equal(serverStatus(dev, 'SJ-0005').Qty, 7);
  assert.equal(dev.gas.mail.length, mailBefore, 'no email when unticked');
  noErrors(errors);
});

test('admin: an order paid on another phone while being edited is not overwritten', async (t) => {
  const { dev, page } = await openAdmin(t);
  await page.waitForSelector('.order');
  const c5 = card(page, 'SJ-0005');
  await c5.locator('[data-role="edit"]').click();
  await page.fill('#e-qty', '9');
  dev.gas.call({ action: 'setStatus', key: dev.key, invoice: 'SJ-0005', status: 'Paid' });
  await c5.locator('[data-role="edit-save"]').click();
  await toast(page, /SJ-0005 is Paid\. Only new requests and orders waiting for payment can be edited/);
  assert.equal(serverStatus(dev, 'SJ-0005').Qty, 5);
});

test('admin: a DM order can be a collection, with no delivery fee', async (t) => {
  const { dev, page, errors } = await openAdmin(t);
  await page.waitForSelector('.order');
  await page.click('.tab[data-tab="new"]');
  await page.fill('#n-name', 'Lerato Collect');
  assert.equal(await page.locator('#n-time-field').isHidden(), true);
  await page.check('#n-collect');
  assert.equal(await page.locator('#n-address-field').isHidden(), true);
  await page.fill('#n-collect-date', '2026-10-31');
  await page.click('#n-submit');
  assert.equal(await text(page, '#n-error'), 'Pick both a date and a time to collect, or leave both empty.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'n-collect-time');
  await page.fill('#n-collect-time', '10:00');
  assert.match(await text(page, '#n-summary'), /Collection\s+Free/);
  assert.match(await text(page, '#n-summary'), /Total\s+R40/);
  await page.click('#n-submit');
  await page.waitForSelector('#new-result:not([hidden])');
  assert.match(await text(page, '#new-result .preview'), /Collection: free\nTotal due: R40/);
  assert.match(await text(page, '#new-result .preview'), /Collecting: Sat 31 Oct, 10:00, Sea Point/);
  const row = serverStatus(dev, 'SJ-0006');
  assert.equal(row.Collect, 'yes');
  assert.equal(row['Collect at'], '2026-10-31 10:00');
  assert.equal(row.Total, 40);

  await page.getByRole('button', { name: 'New order' }).last().click();
  assert.equal(await page.isChecked('#n-collect'), false, 'the next order starts as delivery');
  assert.equal(await page.locator('#n-address-field').isHidden(), false);
  assert.equal(await page.inputValue('#n-collect-date'), '');
  noErrors(errors);
});

// --- Collection times ---

test('admin: collection orders show their time, and a paid one can be moved with a new invite emailed', async (t) => {
  const { dev, page, errors } = await openAdmin(t, { collections: true });
  await page.waitForSelector('.order');
  assert.match(await card(page, 'SJ-0006').innerText(), /Collect\s*Thu 29 Oct, 17:00/);
  await chip(page, 'paid');
  const c7 = card(page, 'SJ-0007');
  assert.match(await c7.innerText(), /Collect\s*Thu 29 Oct, 18:00/);
  dev.gas.mail.length = 0;

  await more(page, 'SJ-0007', 'Change collection time');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'move-date');
  assert.equal(await page.inputValue('#move-date'), '2026-10-29');
  assert.equal(await page.inputValue('#move-time'), '18:00');
  assert.match(await c7.innerText(), /Jess Adams is emailed an updated calendar invite/);

  await page.fill('#move-date', '');
  await c7.locator('[data-role="move-save"]').click();
  assert.match(await c7.innerText(), /Pick a date and a time\./);
  assert.equal(dev.gas.mail.length, 0, 'nothing sent');

  await page.fill('#move-date', '2026-10-30');
  await page.fill('#move-time', '17:30');
  await c7.locator('[data-role="move-save"]').click();
  await toast(page, 'SJ-0007 moved to Fri 30 Oct, 17:30. Jess Adams was emailed the new invite.');
  assert.equal(serverStatus(dev, 'SJ-0007')['Collect at'], '2026-10-30 17:30');
  assert.equal(dev.gas.mail.length, 1);
  assert.equal(dev.gas.mail[0].subject, 'Supa Juice new collection time: SJ-0007');
  assert.match(await c7.innerText(), /Collect\s*Fri 30 Oct, 17:30/);

  // Keep time closes the form without a change.
  await more(page, 'SJ-0007', 'Change collection time');
  await c7.locator('[data-role="back"]').click();
  assert.equal(await page.locator('#move-date').count(), 0);
  noErrors(errors);
});

test('admin: the edit form changes the collection time, and Greg can pick any time', async (t) => {
  const { dev, page, errors } = await openAdmin(t, { collections: true });
  await page.waitForSelector('.order');
  const c6 = card(page, 'SJ-0006');
  await c6.locator('[data-role="edit"]').click();
  assert.equal(await page.inputValue('#edit-collect-date'), '2026-10-29');
  assert.equal(await page.inputValue('#edit-collect-time'), '17:00');

  await page.fill('#edit-collect-time', '');
  await c6.locator('[data-role="edit-save"]').click();
  assert.match(await c6.innerText(), /Pick both a date and a time to collect, or leave both empty/);

  await page.fill('#edit-collect-time', '19:15');
  await c6.locator('[data-role="edit-save"]').click();
  await toast(page, /^SJ-0006 updated/);
  assert.equal(serverStatus(dev, 'SJ-0006')['Collect at'], '2026-10-29 19:15', 'outside the hours customers see');
  assert.match(await c6.innerText(), /Collect\s*Thu 29 Oct, 19:15/);

  // Unticking collection hides the time, and the saved order has none.
  await c6.locator('[data-role="edit"]').click();
  await page.uncheck('#e-collect');
  assert.equal(await page.locator('#edit-collect-date').isVisible(), false);
  await page.fill('#e-address', '1 Long St');
  await c6.locator('[data-role="edit-save"]').click();
  await toast(page, /^SJ-0006 updated/);
  assert.equal(serverStatus(dev, 'SJ-0006')['Collect at'], '');
  noErrors(errors);
});

test('admin: collection days and hours are set in Settings, and the order page follows them', async (t) => {
  const { dev, page, errors } = await openAdmin(t);
  await page.waitForSelector('.order');
  await page.click('.tab[data-tab="settings"]');
  await page.waitForSelector('#settings-form');

  // Every day unticked is refused: collection is always on.
  for (const d of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat']) await page.uncheck('#s-collection_days-' + d);
  await page.click('#settings-save');
  await page.waitForSelector('#settings-error:not([hidden])');
  assert.equal(await text(page, '#settings-error'), 'Pick at least one collection day.');

  await page.check('#s-collection_days-sun');
  await page.fill('#s-collection_hours-from', '09:00');
  await page.fill('#s-collection_hours-until', '11:00');
  await page.selectOption('#s-collection_slot_minutes', '60');
  await page.fill('#s-collection_per_slot', '2');
  await page.click('#settings-save');
  await toast(page, 'Settings saved.');
  const saved = dev.gas.call({ action: 'getSettings', key: dev.key }).values;
  assert.deepEqual(
    [saved.collection_days, saved.collection_hours, saved.collection_slot_minutes, saved.collection_per_slot],
    ['sun', '09:00-11:00', '60', '2']);

  const customer = await page.context().newPage();
  await customer.goto(kioskUrl(dev));
  await choose(customer, 'collect');
  assert.deepEqual(await customer.locator('#collect-day option').allInnerTexts(), ['Choose a day', 'Sun 1 Nov', 'Sun 8 Nov']);
  await customer.selectOption('#collect-day', '2026-11-01');
  assert.deepEqual(await customer.locator('#collect-hour option').allInnerTexts(), ['Choose a time', '09:00', '10:00']);
  noErrors(errors);
});

// --- New requests ---

test('admin: Greg sets the delivery fee on a request and accepts it, and the customer gets the invoice', async (t) => {
  const { dev, page, errors } = await openAdmin(t, { quote: true });
  await page.waitForSelector('.order');
  // The page opens on what needs Greg first.
  assert.equal(await page.getAttribute('[data-role="chip-requests"]', 'aria-pressed'), 'true');
  assert.match(await text(page, '.list-head .list-total'), /1 new request to set a delivery fee for and accept/);
  const c6 = card(page, 'SJ-0006');
  assert.match(await c6.innerText(), /4 x Running gel sachet at R40, delivery fee to be set/);
  assert.match(await c6.innerText(), /5 Ou Kaapse Weg, Noordhoek/);
  assert.equal(await c6.locator('[data-role="mark-paid"]').count(), 0);
  assert.equal(await c6.locator('[data-role="copy"]').count(), 0, 'no invoice to copy yet');
  assert.equal(await page.inputValue('#fee-SJ-0006'), '30', 'the usual fee is the starting point');
  assert.match(await c6.innerText(), /Total with delivery: R190/);

  await page.fill('#fee-SJ-0006', '65');
  assert.match(await c6.innerText(), /Total with delivery: R225/);
  const mailBefore = dev.gas.mail.length;
  await c6.locator('[data-role="accept"]').click();
  await toast(page, 'SJ-0006 accepted. The invoice was emailed to megan@example.com.');

  // It now waits for payment, with its invoice ready to copy.
  assert.equal(await page.getAttribute('[data-role="chip-awaiting"]', 'aria-pressed'), 'true');
  const accepted = card(page, 'SJ-0006');
  assert.match(await accepted.innerText(), /delivery R65/);
  assert.match(await accepted.innerText(), /R225/);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-role')), 'copy');
  const row = serverStatus(dev, 'SJ-0006');
  assert.deepEqual([row.Status, row['Delivery fee'], row.Total], ['Awaiting payment', 65, 225]);
  const mail = dev.gas.mail[mailBefore];
  assert.equal(mail.to, 'megan@example.com');
  assert.match(mail.body, /Delivery: R65\nTotal due: R225/);
  assert.equal(await page.locator('[data-role="chip-requests"] .chip-count').innerText(), '0');
  noErrors(errors);
});

test('admin: accepting needs a fee, and a request can be edited first', async (t) => {
  const { dev, page, errors } = await openAdmin(t, { quote: true });
  await page.waitForSelector('.order');
  const c6 = card(page, 'SJ-0006');
  await page.fill('#fee-SJ-0006', '');
  assert.match(await c6.innerText(), /Enter the delivery fee for this address/);
  await c6.locator('[data-role="accept"]').click();
  await toast(page, 'Enter the delivery fee first.');
  assert.equal(serverStatus(dev, 'SJ-0006').Status, 'New request');

  await c6.locator('[data-role="edit"]').click();
  assert.equal(await page.locator('#e-fee').isHidden(), true, 'the fee is set when accepting');
  assert.equal(await page.locator('#e-send').isHidden(), true, 'no invoice is sent for a request');
  await page.fill('#e-qty', '6');
  assert.match(await c6.innerText(), /Total before delivery: R240/);
  await c6.locator('[data-role="edit-save"]').click();
  await toast(page, 'SJ-0006 updated.');
  assert.equal(serverStatus(dev, 'SJ-0006').Status, 'New request');
  assert.equal(serverStatus(dev, 'SJ-0006').Qty, 6);
  assert.match(await card(page, 'SJ-0006').innerText(), /Total with delivery|Enter the delivery fee/);
  noErrors(errors);
});

test('admin: declining a request cancels it and emails the customer the reason', async (t) => {
  const { dev, page, errors } = await openAdmin(t, { quote: true });
  await page.waitForSelector('.order');
  await more(page, 'SJ-0006', 'Decline');
  const c6 = card(page, 'SJ-0006');
  assert.match(await c6.innerText(), /Decline SJ-0006 for Megan Fourie\? The order is cancelled\./);
  assert.match(await c6.innerText(), /Reason \(optional, emailed to megan@example\.com\)/);
  await page.fill('#decline-reason', 'Noordhoek is outside our delivery area for now. You are welcome to collect in Sea Point.');
  const mailBefore = dev.gas.mail.length;
  await c6.getByRole('button', { name: 'Yes, decline' }).click();
  await toast(page, 'SJ-0006 declined. The customer was emailed.');
  assert.equal(serverStatus(dev, 'SJ-0006').Status, 'Cancelled');
  assert.match(dev.gas.mail[mailBefore].body, /Noordhoek is outside our delivery area/);
  assert.equal(await page.locator('[data-role="chip-cancelled"] .chip-count').innerText(), '2');
  noErrors(errors);
});

test('admin: a DM order can have its own delivery fee', async (t) => {
  const { dev, page, errors } = await openAdmin(t, { quote: true });
  await page.waitForSelector('.order');
  await page.click('.tab[data-tab="new"]');
  assert.equal(await page.inputValue('#n-fee'), '30');
  await page.fill('#n-name', 'Far Away Friend');
  await page.fill('#n-fee', '80');
  assert.match(await text(page, '#n-summary'), /Delivery\s+R80/);
  assert.match(await text(page, '#n-summary'), /Total\s+R120/);
  await page.check('#n-collect');
  assert.equal(await page.locator('#n-fee-field').isHidden(), true);
  await page.uncheck('#n-collect');
  await page.click('#n-submit');
  await page.waitForSelector('#new-result:not([hidden])');
  const row = serverStatus(dev, 'SJ-0007');
  assert.deepEqual([row.Status, row['Delivery fee'], row.Total], ['Awaiting payment', 80, 120]);
  await page.getByRole('button', { name: 'New order' }).last().click();
  assert.equal(await page.inputValue('#n-fee'), '30', 'the next order starts at the usual fee');
  noErrors(errors);
});

test('admin: unticking "Confirm the delivery fee" charges the fee straight away again', async (t) => {
  const { dev, page, errors } = await openAdmin(t, { quote: true });
  await page.waitForSelector('.order');
  await page.click('.tab[data-tab="settings"]');
  await page.waitForSelector('#settings-form');
  assert.equal(await page.isChecked('#s-delivery_quote'), true);
  await page.uncheck('#s-delivery_quote');
  await page.click('#settings-save');
  await toast(page, 'Settings saved.');
  assert.equal(dev.gas.call({ action: 'config' }).config.quote, false);
  assert.equal(await page.isChecked('#s-delivery_quote'), false);

  const customer = await page.context().newPage();
  await customer.goto(kioskUrl(dev));
  await customer.waitForSelector('#order-form:not([hidden])');
  assert.equal(await customer.locator('#choose-deliver-sub').innerText(), 'R30');
  await choose(customer, 'deliver');
  assert.equal(await customer.locator('#submit').innerText(), 'Place order for R70');
  noErrors(errors);
});

test('admin: a DM order needs a name, and a double tap makes one order', async (t) => {
  const { dev, page } = await openAdmin(t, { latency: 400 });
  await page.waitForSelector('.order');
  await page.click('.tab[data-tab="new"]');
  const before = orderRows(dev).length;
  await page.click('#n-submit');
  assert.equal(await text(page, '#n-error'), 'Enter the name of the customer.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'n-name');
  assert.equal(orderRows(dev).length, before);

  await page.fill('#n-name', 'Double Tap');
  await page.dblclick('#n-submit');
  await page.waitForSelector('#new-result:not([hidden])');
  assert.equal(orderRows(dev).length, before + 1);
});

test('admin: a dropped connection while creating a DM order does not create it twice', async (t) => {
  const { dev, page } = await openAdmin(t);
  await page.waitForSelector('.order');
  await page.click('.tab[data-tab="new"]');
  await page.fill('#n-name', 'Retry Person');
  const before = orderRows(dev).length;

  let dropped = false;
  await page.route('**/exec', async (route) => {
    if (!dropped && route.request().method() === 'POST' && route.request().postData().includes('"action":"create"')) {
      dropped = true;
      await route.fetch();
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  await page.click('#n-submit');
  await page.waitForSelector('#n-error:not([hidden])');
  assert.match(await text(page, '#n-error'), /Could not reach the order service.*Your details are still here/);
  assert.equal(orderRows(dev).length, before + 1);

  await page.click('#n-submit');
  await page.waitForSelector('#new-result:not([hidden])');
  assert.equal(orderRows(dev).length, before + 1, 'the retry returned the same order');
});

// --- Settings ---

test('admin: settings show the current values and the order page link', async (t) => {
  const { dev, page } = await openAdmin(t);
  await page.click('.tab[data-tab="settings"]');
  await page.waitForSelector('#settings-form');
  const values = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('#settings-form [name]').forEach((n) => { out[n.name] = n.value; });
    return out;
  });
  assert.deepEqual(values, {
    price: '40', delivery_fee: '30', delivery_area: 'Cape Town', delivery_quote: 'on',
    min_quantity: '1', max_quantity: '20',
    collection_note: 'Sea Point', collection_slot_minutes: '30', collection_per_slot: '1', collection_days_ahead: '14',
    bank_name: 'Test Bank', account_holder: 'G Bolus', account_number: '0012345678', branch_code: '250655',
    account_type: 'Cheque', payment_note: 'We will confirm once your payment reflects in our account, then deliver.',
    brand_name: 'Supa Juice', product_name: 'Running gel sachet', currency_symbol: 'R', invoice_prefix: 'SJ',
    alert_email: 'greg@example.com'
  });
  // Collection days are tick boxes and the hours are two times.
  const days = await page.locator('#s-collection_days input:checked').evaluateAll((ns) => ns.map((n) => n.value));
  assert.deepEqual(days, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
  assert.equal(await page.inputValue('#s-collection_hours-from'), '17:00');
  assert.equal(await page.inputValue('#s-collection_hours-until'), '19:00');
  assert.equal(await text(page, '.pay-value'), dev.siteUrl + '/');
  await page.locator('.pay-row').getByRole('button', { name: 'Copy' }).click();
  assert.equal(await clipboard(page), dev.siteUrl + '/');
});

test('admin: saving settings changes what customers see and what the invoices say', async (t) => {
  const { dev, page, errors } = await openAdmin(t);
  await page.click('.tab[data-tab="settings"]');
  await page.waitForSelector('#settings-form');
  await page.fill('#s-price', '45');
  await page.fill('#s-delivery_fee', '0');
  await page.fill('#s-delivery_area', 'Southern Suburbs');
  await page.fill('#s-brand_name', 'Supa Juice Co');
  await page.fill('#s-invoice_prefix', 'gel');
  await page.click('#settings-save');
  await toast(page, 'Settings saved.');
  assert.equal(await page.inputValue('#s-invoice_prefix'), 'GEL', 'shown the way it was saved');
  assert.equal(await text(page, '#brand'), 'Supa Juice Co');

  // The service has the new values.
  const saved = dev.gas.rows('Settings');
  const val = (k) => saved.find((r) => r.Key === k).Value;
  assert.equal(val('price'), '45');
  assert.equal(val('delivery_fee'), '0');
  assert.equal(val('invoice_prefix'), 'GEL');

  // The DM form uses them.
  await page.click('.tab[data-tab="new"]');
  assert.match(await text(page, '.qty-item'), /R45 each/);
  await page.fill('#n-name', 'New Price');
  await page.click('#n-submit');
  await page.waitForSelector('#new-result:not([hidden])');
  assert.equal(await text(page, '#created-title'), 'GEL-0006 created');
  assert.match(await text(page, '#new-result .preview'), /Delivery: free\nTotal due: R45/);

  // So does the customer page.
  const customer = await page.context().newPage();
  await customer.goto(dev.siteUrl + '/');
  await customer.waitForSelector('#order-form:not([hidden])');
  assert.equal(await customer.locator('#brand').innerText(), 'Supa Juice Co');
  assert.doesNotMatch(await customer.locator('#lede').innerText(), /Southern Suburbs/, 'the area is not shown to customers');
  const mapsLink = await page.locator('article.order a[href*="google.com/maps"]').first().getAttribute('href');
  assert.ok(mapsLink.includes(encodeURIComponent('Southern Suburbs')), 'but it helps Maps find addresses');
  assert.equal(await customer.locator('#submit').innerText(), 'Place order for R45');
  noErrors(errors);
});

test('admin: settings that make no sense are refused with a reason, and nothing is saved', async (t) => {
  const { dev, page } = await openAdmin(t);
  await page.click('.tab[data-tab="settings"]');
  await page.waitForSelector('#settings-form');

  await page.fill('#s-price', 'abc');
  await page.click('#settings-save');
  await page.waitForSelector('#settings-error:not([hidden])');
  assert.equal(await text(page, '#settings-error'), 'Price must be a number, for example 40.');
  assert.equal(await page.locator('#settings-save').isDisabled(), false);

  await page.fill('#s-price', '40');
  await page.fill('#s-alert_email', 'not-an-email');
  await page.click('#settings-save');
  await page.waitForFunction(() => /email address/.test(document.getElementById('settings-error').textContent));

  await page.fill('#s-alert_email', 'greg@example.com');
  await page.fill('#s-max_quantity', '0');
  await page.click('#settings-save');
  await page.waitForFunction(() => /whole number/.test(document.getElementById('settings-error').textContent));

  assert.equal(dev.gas.rows('Settings').find((r) => r.Key === 'price').Value, '40');
});

test('admin: before the shop is set up Greg is told, and filling in the details opens the order page', async (t) => {
  const { dev, page } = await openAdmin(t, { mode: 'empty' });
  await page.waitForSelector('.alert-wait');
  assert.match(await text(page, '#panel-orders .alert-wait'), /closed until you add the price and your bank details/);

  await page.click('.tab[data-tab="new"]');
  assert.match(await text(page, '#new-warning'), /Add the price and your bank details in Settings before you create orders/);
  await page.fill('#n-name', 'Too Early');
  await page.click('#n-submit');
  await page.waitForSelector('#n-error:not([hidden])');
  assert.match(await text(page, '#n-error'), /Add the price and your bank details in Settings first/);

  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.waitForSelector('#settings-form');
  await page.fill('#s-price', '40');
  await page.fill('#s-bank_name', 'Test Bank');
  await page.fill('#s-account_holder', 'G Bolus');
  await page.fill('#s-account_number', '0012345678');
  await page.click('#settings-save');
  await toast(page, 'Settings saved. Your order page is open.');
  assert.equal(await page.locator('.alert-wait').count(), 0);

  const customer = await page.context().newPage();
  await customer.goto(dev.siteUrl + '/');
  await customer.waitForSelector('#order-form:not([hidden])');
});

// Some in-app browsers refuse to let a page use browser storage at all.
const NO_STORAGE = () => {
  Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
};

test('storage blocked: the order page still takes an order', async (t) => {
  const { dev, page, errors } = await openKiosk(t, { mode: 'ready', init: NO_STORAGE });
  await fillKiosk(page);
  await page.click('#submit');
  await page.waitForSelector('#view-done:not([hidden])');
  assert.equal(await text(page, '#bib .bib-number'), 'SJ-0001');
  assert.equal(orderRows(dev).length, 1);
  noErrors(errors);
});

test('storage blocked: Greg can still sign in with his link and work through the orders', async (t) => {
  const { page, errors } = await openAdmin(t, { init: NO_STORAGE });
  await page.waitForSelector('.order');
  await card(page, 'SJ-0005').locator('[data-role="mark-paid"]').click();
  await card(page, 'SJ-0005').getByRole('button', { name: 'Yes, mark paid' }).click();
  await toast(page, 'SJ-0005 marked paid. The paid invoice was emailed to pieter@example.com.');
  noErrors(errors);
});

// ---------------------------------------------------------------------------
// Looks and accessibility
// ---------------------------------------------------------------------------

// Walks every visible piece of text and checks its contrast against the colour behind it.
function contrastFailures() {
  function parse(c) {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function over(top, bottom) {
    return {
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1
    };
  }
  function lum(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function ratio(a, b) {
    const l1 = lum(a);
    const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  function backgroundOf(node) {
    const chain = [];
    for (let n = node; n; n = n.parentElement) chain.unshift(n);
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    chain.forEach((n) => {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) bg = over(c, bg);
    });
    return bg;
  }
  function opacityOf(node) {
    let o = 1;
    for (let n = node; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity);
    return o;
  }
  const out = [];
  document.querySelectorAll('body *').forEach((node) => {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].indexOf(node.tagName) !== -1) return;
    const cs = getComputedStyle(node);
    if (cs.visibility === 'hidden' || cs.display === 'none') return;
    if (node.closest('[hidden], .hp, .sr-only') || !node.getClientRects().length) return;
    if (node.disabled || node.closest('button:disabled')) return; // inactive controls are exempt
    const hasText = Array.prototype.some.call(node.childNodes, (c) => c.nodeType === 3 && c.textContent.trim());
    const isField = (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') && node.value;
    if (!hasText && !isField) return;
    const bg = backgroundOf(node);
    const fg0 = parse(cs.color);
    const fg = over({ r: fg0.r, g: fg0.g, b: fg0.b, a: fg0.a * opacityOf(node) }, bg);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
    const need = large ? 3 : 4.5;
    const got = ratio(fg, bg);
    if (got < need) {
      out.push({
        tag: node.tagName.toLowerCase(), cls: String(node.className).slice(0, 40),
        text: (node.textContent || node.value || '').trim().slice(0, 40), ratio: Math.round(got * 100) / 100, need
      });
    }
  });
  return out;
}

function tapTargetFailures() {
  const out = [];
  document.querySelectorAll('button, summary, input, select, textarea, a.btn').forEach((n) => {
    if (n.type === 'hidden' || n.closest('[hidden], .hp')) return;
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    let rect = n.getBoundingClientRect();
    // A tick box or radio button inside its label can be tapped anywhere on the label.
    if ((n.type === 'checkbox' || n.type === 'radio') && n.closest('label')) rect = n.closest('label').getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if (rect.height < 40 || rect.width < 40) {
      out.push({ tag: n.tagName.toLowerCase(), text: (n.textContent || n.value || n.id || '').trim().slice(0, 30), w: Math.round(rect.width), h: Math.round(rect.height) });
    }
  });
  return out;
}

function unnamedControls() {
  const out = [];
  document.querySelectorAll('input, textarea, select').forEach((n) => {
    if (n.type === 'hidden' || n.closest('[hidden], .hp')) return;
    if (!(n.labels && n.labels.length) && !n.getAttribute('aria-label') && !n.getAttribute('aria-labelledby')) out.push(n.id || n.name || n.tagName);
  });
  document.querySelectorAll('button, summary, a').forEach((n) => {
    if (n.closest('[hidden]')) return;
    if (!(n.textContent || '').trim() && !n.getAttribute('aria-label')) out.push(n.tagName.toLowerCase() + '#' + n.id);
  });
  return out;
}

// Steps through every screen of both pages and runs a check on each.
async function everyScreen(t, scheme, check) {
  const found = [];
  const run = async (page, name) => {
    const bad = await page.evaluate(check);
    if (bad.length) found.push({ screen: name, scheme, bad });
  };

  const k = await openKiosk(t, { mode: 'ready', scheme });
  await k.page.waitForSelector('#order-form:not([hidden])');
  await run(k.page, 'order page: form');
  await fillKiosk(k.page, { more: 1 });
  await k.page.click('#submit');
  await k.page.waitForSelector('#view-done:not([hidden])');
  await k.page.waitForTimeout(600);
  await run(k.page, 'order page: confirmation');

  const c = await open(t, { mode: 'empty', scheme });
  await c.page.goto(kioskUrl(c.dev));
  await c.page.waitForSelector('#view-closed:not([hidden])');
  await run(c.page, 'order page: closed');

  const a = await open(t, { mode: 'seeded', scheme });
  await a.page.goto(a.dev.siteUrl + '/admin.html');
  await a.page.waitForSelector('#login:not([hidden])');
  await a.page.fill('#key', 'wrong-key-wrong-key-wrong');
  await a.page.click('#login-form button[type=submit]');
  await a.page.waitForSelector('#login-error:not([hidden])');
  await run(a.page, 'admin: login with an error');

  await a.page.goto(a.dev.adminUrl());
  await a.page.waitForSelector('.order');
  for (const f of ['awaiting', 'paid', 'delivered', 'cancelled']) {
    await a.page.click('[data-role="chip-' + f + '"]');
    await run(a.page, 'admin: ' + f + ' list');
  }
  await a.page.click('[data-role="chip-awaiting"]');
  await card(a.page, 'SJ-0005').locator('[data-role="mark-paid"]').click();
  await run(a.page, 'admin: confirm paid');
  await card(a.page, 'SJ-0005').getByRole('button', { name: 'Not yet' }).click();
  await a.page.locator('details.more > summary').first().click();
  await run(a.page, 'admin: more menu');
  await a.page.click('.tab[data-tab="new"]');
  await run(a.page, 'admin: new order');
  await a.page.fill('#n-name', 'Contrast Check');
  await a.page.click('#n-submit');
  await a.page.waitForSelector('#new-result:not([hidden])');
  await run(a.page, 'admin: order created');
  await a.page.click('.tab[data-tab="settings"]');
  await a.page.waitForSelector('#settings-form');
  await run(a.page, 'admin: settings');
  await a.page.fill('#s-price', 'abc');
  await a.page.click('#settings-save');
  await a.page.waitForSelector('#settings-error:not([hidden])');
  await run(a.page, 'admin: settings error');
  await a.page.waitForSelector('#toast:not([hidden])');
  await run(a.page, 'admin: toast');

  const e = await open(t, { mode: 'empty', scheme });
  await e.page.goto(e.dev.adminUrl());
  await e.page.waitForSelector('.alert-wait');
  await run(e.page, 'admin: set-up banner');
  return found;
}

for (const scheme of ['light', 'dark']) {
  test('looks: text has enough contrast on every screen (' + scheme + ')', async (t) => {
    const found = await everyScreen(t, scheme, contrastFailures);
    assert.deepEqual(found, [], JSON.stringify(found, null, 1));
  });
}

test('looks: every button and field is big enough to tap', async (t) => {
  const found = await everyScreen(t, 'light', tapTargetFailures);
  assert.deepEqual(found, [], JSON.stringify(found, null, 1));
});

test('looks: every field and button has a name a screen reader can read', async (t) => {
  const found = await everyScreen(t, 'light', unnamedControls);
  assert.deepEqual(found, [], JSON.stringify(found, null, 1));
});

for (const width of [320, 390, 768, 1280]) {
  test('looks: nothing scrolls sideways at ' + width + 'px wide', async (t) => {
    const over = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const bad = [];

    const k = await openKiosk(t, { mode: 'ready', width, mobile: width < 768 });
    await k.page.waitForSelector('#order-form:not([hidden])');
    bad.push(['form', await over(k.page)]);
    await fillKiosk(k.page, { name: 'A Very Long Name That Keeps Going And Going Without Any Break', address: 'Unit 1204, The Extraordinarily Long Building Name, 123456789 Very Long Street Name' });
    await k.page.click('#submit');
    await k.page.waitForSelector('#view-done:not([hidden])');
    bad.push(['confirmation', await over(k.page)]);

    const a = await open(t, { mode: 'seeded', width, mobile: width < 768 });
    a.dev.gas.call({
      action: 'order', email: 'buyer@example.com', name: 'Averyveryveryveryverylongnamewithoutanybreakswhatsoever Surname', contact: '@a_really_long_handle_that_goes_on',
      address: 'Unit1204TheExtraordinarilyLongBuildingNameWithoutSpaces 123456789 Street', notes: 'x'.repeat(250), qty: 20,
      areaConfirmed: true, requestId: 'longrequest0123456789', expectedTotal: 830, website: ''
    });
    await a.page.goto(a.dev.adminUrl());
    await a.page.waitForSelector('.order');
    bad.push(['orders', await over(a.page)]);
    await a.page.click('.tab[data-tab="new"]');
    bad.push(['new order', await over(a.page)]);
    await a.page.click('.tab[data-tab="settings"]');
    await a.page.waitForSelector('#settings-form');
    bad.push(['settings', await over(a.page)]);

    assert.deepEqual(bad.filter((b) => b[1] > 0), [], 'screens that scroll sideways');
  });
}
