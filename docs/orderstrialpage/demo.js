/*
  Demo mode for the trial page. Loaded after shared.js and before order.js.

  The page still READS the live prices, collection times, photo and discount codes from the
  order service, so it looks exactly like the real page. Anything that would CREATE something
  is answered here instead, in the browser:
    - placing an order shows the confirmation screen, but nothing reaches the orders Sheet,
      no invoice number is used and no email is sent;
    - card payment opens a pretend payment sheet (Pay / Cancel) instead of Paystack: nothing is charged.
  Nothing is kept in the browser either: a reload starts afresh.
  To make the trial page place real orders, remove the demo.js line from index.html.
*/
(function () {
  'use strict';

  var realApi = SJ.api;
  var READ_ONLY = { config: true, photo: true, checkCode: true, deliveryQuote: true };
  var lastOrder = null;
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
    if (action === 'order') {
      lastOrder = fakeOrder(data || {});
      return lastOrder;
    }
    if (action === 'startPayment') return pretendPayment();
    if (action === 'payByEft') return { ok: true };
    throw new SJ.ApiError('demo', 'This is the trial page, so this is switched off. Nothing was charged.');
  };

  // A stand-in for Paystack's page: the amount, Pay and Cancel. Pay answers like a payment that went
  // through; Cancel like one that was given up. Nothing is charged.
  function pretendPayment() {
    var o = lastOrder && lastOrder.order;
    var amount = o ? SJ.money(o.total, lastOrder.currency) : '';
    return new Promise(function (resolve, reject) {
      var sheet = SJ.el('div', { class: 'demo-pay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'demo-pay-title' },
        SJ.el('div', { class: 'demo-pay-box' },
          SJ.el('p', { class: 'demo-pay-brand' }, 'paystack (demo)'),
          SJ.el('p', { class: 'demo-pay-title', id: 'demo-pay-title' }, 'Pay ' + amount),
          SJ.el('p', { class: 'demo-pay-email' }, o && o.email ? o.email : ''),
          SJ.el('p', { class: 'demo-pay-timer', id: 'demo-pay-timer', role: 'timer' }, ''),
          SJ.el('p', { class: 'demo-pay-note' }, "This stands in for Paystack's secure page on the trial page. Nothing is charged."),
          SJ.el('button', { type: 'button', class: 'btn btn-pay btn-block', id: 'demo-pay-ok' }, 'Pay ' + amount),
          SJ.el('button', { type: 'button', class: 'btn btn-quiet btn-block', id: 'demo-pay-cancel' }, 'Cancel payment')));
      document.body.appendChild(sheet);
      // The checkout's payment window: the time left shows here, and the sheet closes when it ends,
      // as the real Paystack pop-up would.
      function onTick(ev) { sheet.querySelector('#demo-pay-timer').textContent = 'Time left to pay: ' + ev.detail.text; }
      function onClosed() {
        close();
        reject(new SJ.ApiError('expired', 'Your payment window has closed. Nothing was charged.'));
      }
      // The time left right away, from the checkout's own countdown; then every second.
      var line = document.getElementById('pay-window');
      if (line && !line.hidden) {
        sheet.querySelector('#demo-pay-timer').textContent = line.textContent.replace('Complete your payment within', 'Time left to pay:');
      }
      document.addEventListener('sj:pay-window', onTick);
      document.addEventListener('sj:pay-window-closed', onClosed);
      function close() {
        document.removeEventListener('sj:pay-window', onTick);
        document.removeEventListener('sj:pay-window-closed', onClosed);
        sheet.remove();
      }
      sheet.querySelector('#demo-pay-ok').addEventListener('click', function () {
        close();
        if (lastOrder) lastOrder.order.status = 'Paid';
        resolve({ ok: true, paid: true });
      });
      sheet.querySelector('#demo-pay-cancel').addEventListener('click', function () {
        close();
        reject(new SJ.ApiError('cancelled', 'Payment cancelled. Nothing was charged and no order was placed.'));
      });
      sheet.querySelector('#demo-pay-ok').focus();
    });
  }

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
  // order.js on the trial page refuses to place anything unless this is set.
  SJ.demo = true;

  if (document.body) label();
  else document.addEventListener('DOMContentLoaded', label);
})();
