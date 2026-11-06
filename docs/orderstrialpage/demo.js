/*
  Demo mode for the trial page. Loaded after shared.js and before order.js.

  The page still READS the live prices, collection times, photo and discount codes from the
  order service, so it looks exactly like the real page. Anything that would CREATE something
  is answered here instead, in the browser:
    - placing an order shows the confirmation screen, but nothing reaches the orders Sheet,
      no invoice number is used and no email is sent;
    - card payment is not started.
  Nothing is kept in the browser either: a reload starts afresh.
  To make the trial page place real orders, remove the demo.js line from index.html.
*/
(function () {
  'use strict';

  var realApi = SJ.api;
  var READ_ONLY = { config: true, photo: true, checkCode: true };
  var lastConfig = null;
  var demoCount = 0;

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = '0' + s;
    return s;
  }

  function now() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2) + ' ' + pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2);
  }

  // A pretend order, shaped like the order service's answer, from what the page sent.
  function fakeOrder(data) {
    var c = lastConfig || {};
    var price = Number(c.price) || 0;
    var qty = Number(data.qty) || 0;
    var items = Math.round(price * 100) * qty / 100;
    var total = typeof data.expectedTotal === 'number' ? data.expectedTotal : items;
    var collect = data.collect === true;
    // A delivery order waits for Greg to confirm the fee when fees are quoted per order.
    var request = !collect && c.quote && !c.ship && total <= items;
    var extra = Math.round((total - items) * 100) / 100;
    var discountPct = extra < 0 && items > 0 ? Math.round(-extra / items * 100) : 0;
    demoCount += 1;
    return {
      ok: true,
      emailed: true, // shows the wording customers normally see; no email is actually sent
      demo: true,
      order: {
        invoice: 'DEMO-' + pad(demoCount, 2),
        created: now(),
        source: 'kiosk',
        name: data.name || '',
        contact: data.contact || '',
        address: data.address || '',
        notes: data.notes || '',
        qty: qty,
        price: price,
        fee: collect || request ? 0 : Math.max(0, extra),
        total: total,
        status: request ? 'New request' : 'Awaiting payment',
        paidOn: '',
        deliveredOn: '',
        email: data.email || '',
        emailedOn: '',
        collect: collect,
        editedOn: '',
        collectAt: data.collectAt || '',
        code: data.code || '',
        discountPct: discountPct,
        freeDelivery: false,
        flavours: data.flavours || {}
      },
      brand: c.brand || 'Supa Juice',
      product: c.product || '',
      currency: c.currency || 'R',
      collectNote: c.collectNote || '',
      bank: { name: 'Example Bank', holder: 'Supa Juice (demo)', number: '0000 000 000', branch: '000000', type: 'Cheque' },
      paymentNote: 'This is the trial page: nothing was ordered and nothing was sent.'
    };
  }

  SJ.api = async function (action, data) {
    if (READ_ONLY[action]) {
      var res = await realApi(action, data);
      if (action === 'config' && res.config) lastConfig = res.config;
      return res;
    }
    // A short wait, so the "Placing your order" state can be seen.
    await new Promise(function (r) { setTimeout(r, 600); });
    if (action === 'order') return fakeOrder(data || {});
    throw new SJ.ApiError('demo', 'This is the trial page, so card payment is switched off. Nothing was charged.');
  };

  // Nothing is kept in the browser: the page's saved config, last order and photo live in memory only.
  var memory = {};
  SJ.store = {
    get: function (key) { return Object.prototype.hasOwnProperty.call(memory, key) ? JSON.parse(memory[key]) : null; },
    set: function (key, value) { memory[key] = JSON.stringify(value); },
    remove: function (key) { delete memory[key]; }
  };

  // A small label, so nobody mistakes the trial page for the real one.
  function label() {
    var tag = document.createElement('p');
    tag.className = 'demo-tag';
    tag.setAttribute('role', 'note');
    tag.textContent = 'Demo page: nothing is ordered or saved';
    document.body.appendChild(tag);
  }
  if (document.body) label();
  else document.addEventListener('DOMContentLoaded', label);
})();
