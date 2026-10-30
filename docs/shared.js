/* Helpers shared by the order page and the admin page. Exposes window.SJ. */
(function () {
  'use strict';

  var cfg = window.SJ_CONFIG || {};

  // ---------- Talking to the Apps Script web app ----------

  function ApiError(code, message, data) {
    this.name = 'ApiError';
    this.code = code;
    this.message = message || code;
    this.data = data || {};
  }
  ApiError.prototype = Object.create(Error.prototype);

  // POST with the JSON sent as text/plain. That is a "simple" request, so the browser
  // does not send a preflight, which Apps Script cannot answer.
  async function api(action, data) {
    var url = cfg.endpoint;
    if (!url || !/^https?:\/\//.test(url)) {
      throw new ApiError('not_configured', 'This page is not connected yet. Add the web app address to config.js.');
    }
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 30000);
    var json = null;
    try {
      var res;
      try {
        res = await fetch(url, {
          method: 'POST',
          body: JSON.stringify(Object.assign({ action: action }, data || {})),
          signal: controller.signal
        });
      } catch (err) {
        throw new ApiError('network', 'Could not reach the order service. Check your connection and try again.');
      }
      try {
        json = await res.json();
      } catch (err) {
        json = null;
      }
    } finally {
      clearTimeout(timer);
    }
    if (!json || typeof json !== 'object') {
      throw new ApiError('bad_response', 'The order service sent back something unexpected. Please try again.');
    }
    if (json.ok !== true) {
      throw new ApiError(json.error || 'server_error', json.message || 'Something went wrong. Please try again.', json);
    }
    return json;
  }

  // ---------- Small formatting helpers ----------

  function money(n, symbol) {
    n = Number(n) || 0;
    var text = Math.abs(n - Math.round(n)) < 0.005 ? String(Math.round(n)) : n.toFixed(2);
    return (symbol === undefined || symbol === null ? 'R' : symbol) + text;
  }

  // Order total in cents-safe arithmetic. Same rule as the server.
  function totalFor(qty, price, fee) {
    return (Math.round(price * 100) * qty + Math.round(fee * 100)) / 100;
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // "2026-10-28 15:41" (written by the server in Cape Town time) -> Date with the same clock reading.
  function parseWhen(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
  }

  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function formatWhen(s) {
    var d = parseWhen(s);
    if (!d) return s || '';
    return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ', ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function dayOf(s) {
    return String(s || '').slice(0, 10);
  }

  // "2026-10-28 15:41" -> "28 Oct 2026"
  function formatDay(s) {
    var d = parseWhen(dayOf(s) + ' 00:00');
    return d ? d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() : dayOf(s);
  }

  function instagramUrl(contact) {
    var h = String(contact || '').trim().replace(/^@/, '');
    if (/^[A-Za-z0-9._]{1,30}$/.test(h) && /[A-Za-z_.]/.test(h)) return 'https://www.instagram.com/' + h + '/';
    return null;
  }

  // The same rule as the server.
  function isEmail(s) {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ''));
  }

  function newRequestId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID().replace(/-/g, '');
    var bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(bytes, function (b) { return pad2(b.toString(16)).slice(-2); }).join('');
  }

  // ---------- The invoice text that gets pasted into DMs ----------

  // c: { brand, product, currency, bank, paymentNote, collectNote }
  function invoiceText(order, c) {
    var sym = c.currency || 'R';
    var paid = order.status === 'Paid' || order.status === 'Delivered';
    var lines = [];
    lines.push(String(c.brand || '').toUpperCase());
    lines.push('Invoice ' + order.invoice + (paid ? ' (PAID)' : ''));
    lines.push('Date: ' + formatDay(order.created));
    if (paid && order.paidOn) lines.push('Paid: ' + formatDay(order.paidOn));
    lines.push('');
    lines.push('For: ' + order.name);
    lines.push(order.qty + ' x ' + c.product + ' @ ' + money(order.price, sym) + ' = ' + money(totalFor(order.qty, order.price, 0), sym));
    lines.push(order.collect ? 'Collection: free' : 'Delivery: ' + (order.fee > 0 ? money(order.fee, sym) : 'free'));
    lines.push((paid ? 'Total paid: ' : 'Total due: ') + money(order.total, sym));
    if (order.collect) {
      lines.push('');
      lines.push('Collecting: ' + (order.collectAt ? formatWhen(order.collectAt) + ', ' : '') + (c.collectNote || ''));
    }
    if (paid) {
      lines.push('');
      lines.push('Thank you for your order.');
    } else {
      var b = c.bank || {};
      lines.push('');
      lines.push('Pay by bank transfer');
      if (b.name) lines.push('Bank: ' + b.name);
      if (b.holder) lines.push('Account holder: ' + b.holder);
      if (b.number) lines.push('Account number: ' + b.number);
      if (b.branch) lines.push('Branch code: ' + b.branch);
      if (b.type) lines.push('Account type: ' + b.type);
      lines.push('Amount: ' + money(order.total, sym));
      lines.push('Reference: ' + order.invoice);
      if (c.paymentNote) {
        lines.push('');
        lines.push(c.paymentNote);
      }
    }
    return lines.join('\n');
  }

  // ---------- DOM helpers ----------

  // el('div', {class: 'x', onclick: fn}, 'text', childNode, [more children])
  // Strings always become text nodes, so customer-supplied text can never inject markup.
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }

  function append(node, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) child.forEach(function (c) { append(node, c); });
    else if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) { /* fall through to the older way */ }
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (err) {
      return false;
    }
  }

  // A small button that copies text and says so.
  function copyButton(getText, label, extraClass) {
    var btn = el('button', { type: 'button', class: 'btn btn-quiet btn-small' + (extraClass ? ' ' + extraClass : '') }, label || 'Copy');
    var timer = null;
    btn.addEventListener('click', async function () {
      var ok = await copyText(typeof getText === 'function' ? getText() : getText);
      btn.textContent = ok ? 'Copied' : 'Press and hold to copy';
      clearTimeout(timer);
      timer = setTimeout(function () { btn.textContent = label || 'Copy'; }, 1800);
    });
    return btn;
  }

  var toastTimer = null;
  function toast(message, kind) {
    var node = document.getElementById('toast');
    if (!node) {
      node = el('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(node);
    }
    node.className = 'toast' + (kind === 'bad' ? ' toast--bad' : '');
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.hidden = true; }, kind === 'bad' ? 7000 : 4500);
  }

  // localStorage that never throws (some in-app browsers block it).
  var store = {
    get: function (key) {
      try {
        var v = window.localStorage.getItem(key);
        return v === null ? null : JSON.parse(v);
      } catch (err) { return null; }
    },
    set: function (key, value) {
      try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* ignore */ }
    },
    remove: function (key) {
      try { window.localStorage.removeItem(key); } catch (err) { /* ignore */ }
    }
  };

  // ---------- Quantity stepper (used on both pages) ----------

  function qtyStepper(opts) {
    var id = opts.id;
    var min = opts.min || 1;
    var max = opts.max || 20;
    var listeners = [];
    var input = el('input', {
      id: id, class: 'qty-input', type: 'number', inputmode: 'numeric', min: String(min), max: String(max), value: String(min),
      'aria-describedby': id + '-item'
    });
    var down = el('button', { type: 'button', class: 'qty-btn', 'aria-label': 'One fewer' }, '−');
    var up = el('button', { type: 'button', class: 'qty-btn', 'aria-label': 'One more' }, '+');
    var item = el('p', { id: id + '-item', class: 'qty-item' });
    var node = el('div', { class: 'qty' },
      el('label', { class: 'qty-label', for: id }, opts.label || 'Quantity'),
      el('div', { class: 'qty-controls' }, down, input, up),
      item
    );

    function read() {
      var n = parseInt(input.value, 10);
      return isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
    }
    function sync() {
      var n = read();
      down.disabled = n <= min;
      up.disabled = n >= max;
    }
    function changed() {
      sync();
      listeners.forEach(function (fn) { fn(read()); });
    }
    function set(n) {
      input.value = String(Math.max(min, Math.min(max, n)));
      changed();
    }
    down.addEventListener('click', function () { set(read() - 1); });
    up.addEventListener('click', function () { set(read() + 1); });
    input.addEventListener('input', changed);
    input.addEventListener('change', function () { input.value = String(read()); changed(); });
    input.addEventListener('focus', function () { input.select(); });
    sync();

    return {
      node: node,
      input: input,
      get: read,
      set: set,
      reset: function () { set(min); },
      // Sets both limits. A count that was sitting at the old minimum moves to the new one.
      setRange: function (lo, hi) {
        var wasAtMin = read() === min;
        min = Math.max(1, lo || 1);
        max = Math.max(min, hi || min);
        input.min = String(min);
        input.max = String(max);
        set(wasAtMin ? min : read());
      },
      setItem: function (text) { item.textContent = text; },
      onChange: function (fn) { listeners.push(fn); }
    };
  }

  // The line under the quantity, e.g. "Running gel sachet, R40 each. Minimum order 3."
  function itemLine(c) {
    var text = c.product + ', ' + money(c.price, c.currency) + ' each';
    return (c.minQty || 1) > 1 ? text + '. Minimum order ' + c.minQty + '.' : text;
  }

  // The "3 x sachet / Delivery / Total" block.
  //   opts.collect  collection: no fee
  //   opts.quote    the fee is confirmed later, so the total covers the sachets only
  //   opts.fee      a fee to use instead of the usual one (Greg's DM orders)
  function renderSummary(dl, c, qty, opts) {
    opts = opts || {};
    var sym = c.currency;
    var quote = !!opts.quote && !opts.collect;
    var fee = opts.collect || quote ? 0 : (typeof opts.fee === 'number' ? opts.fee : c.fee);
    var total = totalFor(qty, c.price, fee);
    var feeText = quote ? (c.fee > 0 ? 'From ' + money(c.fee, sym) : 'Confirmed later') : (fee > 0 ? money(fee, sym) : 'Free');
    clear(dl);
    dl.appendChild(el('div', { class: 'summary-row' },
      el('dt', null, qty + ' x ' + c.product),
      el('dd', null, money(totalFor(qty, c.price, 0), sym))));
    dl.appendChild(el('div', { class: 'summary-row' },
      el('dt', null, opts.collect ? 'Collection' : 'Delivery'),
      el('dd', null, feeText)));
    dl.appendChild(el('div', { class: 'summary-row summary-total' },
      el('dt', null, quote ? 'Total before delivery' : 'Total'),
      el('dd', null, money(total, sym))));
    return total;
  }

  window.SJ = {
    cfg: cfg,
    ApiError: ApiError,
    api: api,
    money: money,
    totalFor: totalFor,
    formatWhen: formatWhen,
    formatDay: formatDay,
    dayOf: dayOf,
    instagramUrl: instagramUrl,
    isEmail: isEmail,
    newRequestId: newRequestId,
    invoiceText: invoiceText,
    el: el,
    clear: clear,
    copyText: copyText,
    copyButton: copyButton,
    toast: toast,
    store: store,
    qtyStepper: qtyStepper,
    itemLine: itemLine,
    renderSummary: renderSummary
  };
})();
