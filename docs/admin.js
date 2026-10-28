/* Greg's order desk: orders, new DM order, settings. */
(function () {
  'use strict';

  var SJ = window.SJ;
  var el = SJ.el;
  var $ = function (id) { return document.getElementById(id); };

  var KEY_STORE = 'sj_admin_key';
  var STALE_AFTER = 30 * 1000;
  var LIST_LIMIT = 500; // the most orders the service sends back

  var AWAITING = 'Awaiting payment';
  var PAID = 'Paid';
  var DELIVERED = 'Delivered';
  var CANCELLED = 'Cancelled';

  var FILTERS = [
    { id: 'awaiting', status: AWAITING, label: 'Awaiting payment' },
    { id: 'paid', status: PAID, label: 'Paid' },
    { id: 'delivered', status: DELIVERED, label: 'Delivered' },
    { id: 'cancelled', status: CANCELLED, label: 'Cancelled' }
  ];

  var STATUS_CLASS = {};
  STATUS_CLASS[AWAITING] = 'awaiting';
  STATUS_CLASS[PAID] = 'paid';
  STATUS_CLASS[DELIVERED] = 'delivered';
  STATUS_CLASS[CANCELLED] = 'cancelled';

  var SETTINGS_LAYOUT = [
    {
      title: 'Price and delivery',
      fields: [
        { key: 'price', label: 'Price per sachet', hint: 'A number, for example 40', mode: 'decimal', max: 12 },
        { key: 'delivery_fee', label: 'Delivery fee', hint: '0 means free delivery', mode: 'decimal', max: 12 },
        { key: 'delivery_area', label: 'Delivery area', hint: 'Customers tick a box to say their address is inside it', max: 60 },
        { key: 'max_quantity', label: 'Most sachets per order', mode: 'numeric', max: 3 }
      ]
    },
    {
      title: 'Bank details',
      fields: [
        { key: 'bank_name', label: 'Bank', max: 60 },
        { key: 'account_holder', label: 'Account holder', max: 80 },
        { key: 'account_number', label: 'Account number', mode: 'numeric', max: 40 },
        { key: 'branch_code', label: 'Branch code', mode: 'numeric', max: 20 },
        { key: 'account_type', label: 'Account type', hint: 'For example Cheque or Savings', max: 30 },
        { key: 'payment_note', label: 'Note under the payment details', long: true, wide: true, max: 300 }
      ]
    },
    {
      title: 'Shop',
      fields: [
        { key: 'brand_name', label: 'Brand name', max: 60 },
        { key: 'product_name', label: 'Product name', max: 60 },
        { key: 'currency_symbol', label: 'Currency symbol', max: 4 },
        { key: 'invoice_prefix', label: 'Invoice prefix', hint: 'SJ gives SJ-0001, SJ-0002 and so on', max: 6 },
        { key: 'alert_email', label: 'Email me new orders', hint: 'Orders from your order page are sent here. Leave blank for none.', type: 'email', wide: true, max: 120 }
      ]
    }
  ];
  var SETTING_KEYS = [];
  SETTINGS_LAYOUT.forEach(function (s) { s.fields.forEach(function (f) { SETTING_KEYS.push(f.key); }); });

  var state = {
    key: null,
    screen: 'loading',
    tab: 'orders',
    orders: [],
    config: null,
    loadedAt: 0,
    shown: false,       // the orders have loaded at least once
    refreshing: false,
    version: 0,         // counts changes made on this phone, so a slow list never overwrites them
    filter: 'awaiting',
    confirm: null,      // { invoice, kind: 'paid' | 'cancel' }
    moreOpen: null,
    working: null,      // invoice being saved
    preview: null,      // invoice whose text is shown because copying failed
    flash: null,
    focus: null,        // { invoice?, role } to focus after the next draw
    settings: null,
    settingsLoaded: false
  };

  var cards = {};
  var refreshBtn = null;
  var newStepper = null;
  var newPending = null; // { sig, id }: a retry of the same order reuses one request id
  var newBusy = false;
  var savingSettings = false;

  // ---------- Small helpers ----------

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : (many || one + 's'));
  }

  function sumOf(list) {
    return list.reduce(function (sum, o) { return sum + Math.round(o.total * 100); }, 0) / 100;
  }

  function phoneHref(contact) {
    var t = String(contact || '').trim();
    if (!/^\+?[\d\s()-]{7,20}$/.test(t)) return null;
    var digits = t.replace(/\D/g, '');
    return digits.length >= 7 ? 'tel:' + (t.charAt(0) === '+' ? '+' : '') + digits : null;
  }

  function mapsHref(address, area) {
    var q = String(address || '').replace(/\s+/g, ' ').trim();
    if (!q) return null;
    if (area && q.toLowerCase().indexOf(String(area).toLowerCase()) === -1) q += ', ' + area;
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
  }

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function flashLabel(btn, text, original) {
    btn.textContent = text;
    clearTimeout(btn._labelTimer);
    btn._labelTimer = setTimeout(function () { btn.textContent = original; }, 1800);
  }

  function selectContents(node) {
    try {
      var range = document.createRange();
      range.selectNodeContents(node);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (err) { /* selecting is only a convenience */ }
  }

  function newestFirst(a, b) {
    return b.created.localeCompare(a.created) || b.invoice.localeCompare(a.invoice, undefined, { numeric: true });
  }

  function countOf(status) {
    return state.orders.filter(function (o) { return o.status === status; }).length;
  }

  function currentFilter() {
    return FILTERS.filter(function (f) { return f.id === state.filter; })[0] || FILTERS[0];
  }

  function orderPageUrl() {
    try { return new URL('./', window.location.href).href; } catch (err) { return window.location.href.replace(/admin\.html.*$/, ''); }
  }

  // ---------- Screens ----------

  function showScreen(name) {
    state.screen = name;
    $('loading').hidden = name !== 'loading';
    $('login').hidden = name !== 'login';
    $('load-error').hidden = name !== 'error';
    $('topbar').hidden = name !== 'app';
    syncPanels();
  }

  function syncPanels() {
    ['orders', 'new', 'settings'].forEach(function (t) {
      $('panel-' + t).hidden = !(state.screen === 'app' && state.tab === t);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      if (b.getAttribute('data-tab') === state.tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
  }

  function showLogin(message) {
    var box = $('login-error');
    box.textContent = message || '';
    box.hidden = !message;
    showScreen('login');
  }

  function showLoadError(err) {
    $('load-error-text').textContent = err.message;
    showScreen('error');
  }

  function setTab(name) {
    state.tab = name;
    syncPanels();
    window.scrollTo(0, 0);
    if (name === 'orders' && state.shown && Date.now() - state.loadedAt > STALE_AFTER) refresh({ quiet: true });
    if (name === 'settings' && !state.settingsLoaded) loadSettings();
  }

  // ---------- Sign in ----------

  // The private link is admin.html#KEY. The key is stored on this phone and the address is cleaned up.
  function takeKeyFromHash() {
    var raw = String(window.location.hash || '').replace(/^#/, '');
    if (!raw) return null;
    try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (err) { /* ignore */ }
    var key = raw.replace(/^k=/, '');
    try { key = decodeURIComponent(key); } catch (err) { /* keep as is */ }
    return /^[A-Za-z0-9_-]{16,128}$/.test(key) ? key : null;
  }

  function lock(message) {
    SJ.store.remove(KEY_STORE);
    state.key = null;
    state.orders = [];
    state.config = null;
    state.shown = false;
    state.tab = 'orders';
    state.confirm = null;
    state.moreOpen = null;
    state.working = null;
    state.preview = null;
    state.flash = null;
    state.focus = null;
    state.settings = null;
    state.settingsLoaded = false;
    refreshBtn = null;
    cards = {};
    resetNewForm();
    SJ.clear($('panel-orders'));
    SJ.clear($('settings-body'));
    showLogin(message);
    $('key').focus();
  }

  // ---------- Loading the orders ----------

  async function refresh(opts) {
    opts = opts || {};
    if (state.refreshing) return;
    state.refreshing = true;
    syncRefreshButton();
    try {
      for (var attempt = 0; attempt < 3; attempt++) {
        var started = state.version;
        var res = await SJ.api('list', { key: state.key });
        // Something was changed on this phone while the list was on its way: ask again.
        if (state.version !== started && attempt < 2) continue;
        state.refreshing = false; // so the redrawn Refresh button can take focus back
        accept(res);
        return;
      }
    } catch (err) {
      if (err.code === 'unauthorized') {
        lock(err.message);
      } else if (!state.shown) {
        showLoadError(err);
      } else if (!opts.quiet) {
        SJ.toast(err.message, 'bad');
      }
    } finally {
      state.refreshing = false;
      syncRefreshButton();
    }
  }

  function accept(res) {
    state.orders = res.orders || [];
    state.config = res.config;
    state.loadedAt = Date.now();
    SJ.store.set(KEY_STORE, state.key);
    if (!state.shown) {
      state.shown = true;
      state.filter = countOf(AWAITING) > 0 ? 'awaiting' : (countOf(PAID) > 0 ? 'paid' : 'awaiting');
    }
    renderAll();
    showScreen('app');
  }

  function syncRefreshButton() {
    if (!refreshBtn) return;
    refreshBtn.disabled = state.refreshing;
    refreshBtn.textContent = state.refreshing ? 'Refreshing…' : 'Refresh';
  }

  function renderAll() {
    $('brand').textContent = state.config.brand;
    document.title = state.config.brand + ' orders';
    renderOrders();
    applyConfigToNew();
  }

  // ---------- Orders tab ----------

  function setupBanner(text) {
    return el('div', { class: 'alert alert-wait', role: 'status' },
      el('p', null, text),
      el('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: function () { setTab('settings'); } }, 'Open settings'));
  }

  function renderOrders() {
    var panel = $('panel-orders');
    SJ.clear(panel);
    cards = {};
    refreshBtn = null;
    var c = state.config;
    if (!c) return;

    if (!c.ready) panel.appendChild(setupBanner('Your order page is closed until you add the price and your bank details.'));
    panel.appendChild(chipsRow());

    var f = currentFilter();
    var list = state.orders.filter(function (o) { return o.status === f.status; }).sort(newestFirst);
    panel.appendChild(listHead(f, list));

    if (!list.length) {
      panel.appendChild(emptyState(f));
    } else {
      var ul = el('ul', { class: 'orders' });
      list.forEach(function (o) { ul.appendChild(el('li', null, orderCard(o))); });
      panel.appendChild(ul);
    }
    if (state.orders.length >= LIST_LIMIT) {
      panel.appendChild(el('p', { class: 'fine' }, 'Showing the latest ' + LIST_LIMIT + ' orders. Older ones are still in your sheet.'));
    }
    restoreFocus();
  }

  function restoreFocus() {
    var f = state.focus;
    state.focus = null;
    if (!f) return;
    var scope = f.invoice ? cards[f.invoice] : $('panel-orders');
    var node = scope && scope.querySelector('[data-role="' + f.role + '"]');
    if (node) node.focus({ preventScroll: true });
  }

  function chipsRow() {
    var row = el('div', { class: 'chips', role: 'group', 'aria-label': 'Show orders that are' });
    FILTERS.forEach(function (f) {
      var btn = el('button', {
        type: 'button', class: 'chip', 'aria-pressed': state.filter === f.id ? 'true' : 'false', 'data-role': 'chip-' + f.id
      }, f.label, el('span', { class: 'chip-count' }, String(countOf(f.status))));
      btn.addEventListener('click', function () {
        state.filter = f.id;
        state.confirm = null;
        state.preview = null;
        state.moreOpen = null;
        state.focus = { role: 'chip-' + f.id };
        renderOrders();
      });
      row.appendChild(btn);
    });
    return row;
  }

  function listSummary(f, list) {
    var n = list.length;
    if (!n) return '';
    var total = SJ.money(sumOf(list), state.config.currency);
    if (f.id === 'awaiting') return plural(n, 'order') + ' waiting for payment, ' + total + ' in total.';
    if (f.id === 'paid') return plural(n, 'paid order') + ' to deliver, ' + total + ' in total.';
    if (f.id === 'delivered') return plural(n, 'delivered order') + ', ' + total + ' in total.';
    return plural(n, 'cancelled order') + '.';
  }

  function listHead(f, list) {
    refreshBtn = el('button', { type: 'button', class: 'btn btn-quiet btn-small', 'data-role': 'refresh' }, 'Refresh');
    refreshBtn.addEventListener('click', function () {
      state.focus = { role: 'refresh' };
      refresh({});
    });
    syncRefreshButton();
    return el('div', { class: 'list-head' }, el('p', { class: 'list-total' }, listSummary(f, list)), refreshBtn);
  }

  function emptyState(f) {
    var none = state.orders.length === 0;
    var texts = {
      awaiting: 'Nothing is waiting for payment.',
      paid: 'No paid orders are waiting for delivery.',
      delivered: 'No orders have been delivered yet.',
      cancelled: 'No orders have been cancelled.'
    };
    var box = el('div', { class: 'empty stack' },
      el('p', null, none ? 'No orders yet. Orders from your order page and the DM orders you add will show up here.' : texts[f.id]));
    if (none) {
      box.appendChild(el('button', { type: 'button', class: 'btn btn-primary', onclick: function () { setTab('new'); } }, 'New order'));
    }
    return box;
  }

  function contactNode(contact) {
    if (!contact) return null;
    var ig = SJ.instagramUrl(contact);
    if (ig) return el('a', { href: ig, target: '_blank', rel: 'noopener' }, contact);
    var tel = phoneHref(contact);
    if (tel) return el('a', { href: tel }, contact);
    return contact;
  }

  function addressNode(address) {
    var href = mapsHref(address, state.config.area);
    return href ? el('a', { href: href, target: '_blank', rel: 'noopener' }, address) : address;
  }

  function labelled(label, value) {
    return el('p', { class: 'order-text' }, el('span', { class: 'order-label' }, label), value);
  }

  function metaRow(o) {
    var row = el('div', { class: 'order-meta' });
    row.appendChild(el('span', null, 'Ordered ' + SJ.formatWhen(o.created)));
    if (o.paidOn) row.appendChild(el('span', null, 'Paid ' + SJ.formatWhen(o.paidOn)));
    if (o.deliveredOn) row.appendChild(el('span', null, 'Delivered ' + SJ.formatWhen(o.deliveredOn)));
    row.appendChild(el('span', null, o.source === 'kiosk' ? 'From the order page' : 'DM order'));
    return row;
  }

  function orderCard(o) {
    var c = state.config;
    var sym = c.currency;
    var awaiting = o.status === AWAITING;
    var card = el('article', {
      class: 'order' + (state.flash === o.invoice ? ' order--flash' : ''),
      'aria-label': 'Order ' + o.invoice
    });
    cards[o.invoice] = card;

    card.appendChild(el('div', { class: 'order-head' },
      el('span', { class: 'badge' + (awaiting ? ' badge--attention' : '') }, o.invoice),
      el('span', { class: 'order-amount' }, SJ.money(o.total, sym))));

    card.appendChild(el('div', { class: 'order-who' },
      el('span', { class: 'order-name' }, o.name),
      el('span', { class: 'status status-' + (STATUS_CLASS[o.status] || 'cancelled') }, o.status)));

    card.appendChild(el('p', { class: 'order-text' },
      o.qty + ' x ' + c.product + ' at ' + SJ.money(o.price, sym) + ', ' +
      (o.fee > 0 ? 'delivery ' + SJ.money(o.fee, sym) : 'free delivery')));

    if (awaiting) {
      card.appendChild(el('p', { class: 'order-match' },
        'Look for ' + SJ.money(o.total, sym) + ' with reference ', el('span', { class: 'nowrap' }, o.invoice), ' on your bank statement.'));
    }

    var contact = contactNode(o.contact);
    if (contact) card.appendChild(labelled('Contact', contact));
    if (o.address) card.appendChild(labelled('Address', addressNode(o.address)));
    if (o.notes) card.appendChild(labelled('Note', o.notes));

    card.appendChild(metaRow(o));
    card.appendChild(actionsFor(o));
    var preview = previewFor(o);
    if (preview) card.appendChild(preview);
    return card;
  }

  function actionButton(label, cls, role, handler, disabled) {
    var b = el('button', {
      type: 'button', class: 'btn btn-small ' + cls, 'data-role': role, disabled: disabled ? true : null
    }, label);
    b.addEventListener('click', handler);
    return b;
  }

  function primaryRole(o) {
    return o.status === AWAITING ? 'mark-paid' : (o.status === PAID ? 'mark-delivered' : 'copy');
  }

  function askConfirm(o, kind) {
    state.confirm = { invoice: o.invoice, kind: kind };
    state.preview = null;
    state.focus = { invoice: o.invoice, role: 'confirm' };
    renderOrders();
  }

  function dropConfirm(o) {
    state.confirm = null;
    state.focus = { invoice: o.invoice, role: primaryRole(o) };
    renderOrders();
  }

  function moreMenu(o, items, disabled) {
    var d = el('details', { class: 'more', open: state.moreOpen === o.invoice });
    d.appendChild(el('summary', null, 'More'));
    var menu = el('div', { class: 'more-menu' });
    items.forEach(function (it) {
      menu.appendChild(actionButton(it.label, it.danger ? 'btn-danger' : 'btn-quiet', it.role, function () {
        state.moreOpen = null;
        it.run();
      }, disabled));
    });
    d.appendChild(menu);
    d.addEventListener('toggle', function () {
      if (d.open) state.moreOpen = o.invoice;
      else if (state.moreOpen === o.invoice) state.moreOpen = null;
    });
    return d;
  }

  function invoiceButton(o, disabled) {
    return actionButton('Copy invoice', 'btn-quiet', 'copy', async function (ev) {
      var btn = ev.currentTarget;
      var ok = await SJ.copyText(SJ.invoiceText(o, state.config));
      if (ok) {
        flashLabel(btn, 'Copied', 'Copy invoice');
        return;
      }
      // Some in-app browsers block copying. Show the text so it can be selected by hand.
      state.preview = o.invoice;
      renderOrders();
      var box = cards[o.invoice] && cards[o.invoice].querySelector('.preview');
      if (box) selectContents(box);
    }, disabled);
  }

  function previewFor(o) {
    if (state.preview !== o.invoice) return null;
    return el('div', { class: 'stack' },
      el('p', { class: 'fine' }, 'Copying is blocked here. Press and hold the text below to copy it.'),
      el('div', { class: 'preview' }, SJ.invoiceText(o, state.config)),
      actionButton('Close', 'btn-quiet', 'close-preview', function () {
        state.preview = null;
        renderOrders();
      }));
  }

  function actionsFor(o) {
    var sym = state.config.currency;
    var working = state.working === o.invoice;
    var asking = state.confirm && state.confirm.invoice === o.invoice ? state.confirm.kind : null;

    if (asking === 'paid') {
      return el('div', { class: 'confirm-row' },
        el('p', null, 'Is ' + SJ.money(o.total, sym) + ' with reference ', el('span', { class: 'nowrap' }, o.invoice), ' in your account?'),
        el('div', { class: 'order-actions' },
          actionButton('Yes, mark paid', 'btn-primary', 'confirm', function () { setStatus(o, PAID); }),
          actionButton('Not yet', 'btn-quiet', 'back', function () { dropConfirm(o); })));
    }
    if (asking === 'cancel') {
      return el('div', { class: 'confirm-row' },
        el('p', null, 'Cancel ', el('span', { class: 'nowrap' }, o.invoice), ' for ' + o.name + '?'),
        el('div', { class: 'order-actions' },
          actionButton('Yes, cancel order', 'btn-danger', 'confirm', function () { setStatus(o, CANCELLED); }),
          actionButton('Keep order', 'btn-quiet', 'back', function () { dropConfirm(o); })));
    }

    var saving = 'Saving…';
    var row = el('div', { class: 'order-actions' });
    if (o.status === AWAITING) {
      row.appendChild(actionButton(working ? saving : 'Mark paid', 'btn-primary', 'mark-paid', function () { askConfirm(o, 'paid'); }, working));
      row.appendChild(invoiceButton(o, working));
      row.appendChild(moreMenu(o, [
        { label: 'Cancel order', role: 'cancel', danger: true, run: function () { askConfirm(o, 'cancel'); } }
      ], working));
    } else if (o.status === PAID) {
      row.appendChild(actionButton(working ? saving : 'Mark delivered', 'btn-primary', 'mark-delivered', function () { setStatus(o, DELIVERED); }, working));
      row.appendChild(invoiceButton(o, working));
      row.appendChild(moreMenu(o, [
        { label: 'Undo paid', role: 'undo-paid', run: function () { setStatus(o, AWAITING); } },
        { label: 'Cancel order', role: 'cancel', danger: true, run: function () { askConfirm(o, 'cancel'); } }
      ], working));
    } else if (o.status === DELIVERED) {
      row.appendChild(invoiceButton(o, working));
      row.appendChild(moreMenu(o, [
        { label: 'Undo delivered', role: 'undo-delivered', run: function () { setStatus(o, PAID); } }
      ], working));
    } else if (o.status === CANCELLED) {
      row.appendChild(actionButton(working ? saving : 'Reopen order', 'btn-quiet', 'reopen', function () { setStatus(o, AWAITING); }, working));
    }
    return row;
  }

  function replaceOrder(order) {
    for (var i = 0; i < state.orders.length; i++) {
      if (state.orders[i].invoice === order.invoice) {
        state.orders[i] = order;
        return;
      }
    }
    state.orders.push(order);
  }

  // Highlights an order and brings it into view.
  function flashOrder(invoice) {
    state.flash = invoice;
    renderOrders();
    var card = cards[invoice];
    if (card) card.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    setTimeout(function () { if (state.flash === invoice) state.flash = null; }, 2200);
  }

  async function setStatus(o, target) {
    if (state.working) return;
    var before = o.status;
    state.working = o.invoice;
    state.confirm = null;
    state.preview = null;
    renderOrders();
    try {
      var res = await SJ.api('setStatus', { key: state.key, invoice: o.invoice, status: target });
      state.version++;
      replaceOrder(res.order);
      state.working = null;
      var inv = res.order.invoice;
      if (target === PAID && before === AWAITING) {
        // The next job is sending the paid invoice, so show the order under Paid with its Copy button.
        state.filter = 'paid';
        state.focus = { invoice: inv, role: 'copy' };
        flashOrder(inv);
        SJ.toast(inv + ' marked paid. Copy the invoice to send it.');
      } else {
        renderOrders();
        if (target === PAID) SJ.toast(inv + ' is back under Paid.');
        else if (target === DELIVERED) SJ.toast(inv + ' marked delivered.');
        else if (target === CANCELLED) SJ.toast(inv + ' cancelled.');
        else SJ.toast(inv + ' is waiting for payment again.');
      }
    } catch (err) {
      state.working = null;
      if (err.code === 'unauthorized') {
        lock(err.message);
        return;
      }
      SJ.toast(err.message, 'bad');
      if (err.code === 'invalid' || err.code === 'not_found') refresh({ quiet: true });
      else renderOrders();
    }
  }

  // ---------- New order tab ----------

  function initNewForm() {
    newStepper = SJ.qtyStepper({ id: 'n-qty', label: 'Quantity', max: 20 });
    $('new-qty-slot').appendChild(newStepper.node);
    newStepper.onChange(renderNewTotals);
    $('new-form').addEventListener('submit', onCreate);
  }

  function applyConfigToNew() {
    var c = state.config;
    if (!c || !newStepper) return;
    newStepper.setMax(c.maxQty);
    newStepper.setItem(c.product + ', ' + SJ.money(c.price, c.currency) + ' each');
    var warn = $('new-warning');
    SJ.clear(warn);
    if (!c.ready) warn.appendChild(setupBanner('Add the price and your bank details in Settings before you create orders.'));
    renderNewTotals();
  }

  function renderNewTotals() {
    if (!state.config || !newStepper) return;
    SJ.renderSummary($('n-summary'), state.config, newStepper.get());
  }

  function showNewError(message) {
    var box = $('n-error');
    box.textContent = message;
    box.hidden = false;
  }

  function setNewBusy(on) {
    newBusy = on;
    $('n-submit').disabled = on;
    $('n-submit').textContent = on ? 'Creating order…' : 'Create order';
  }

  async function onCreate(ev) {
    ev.preventDefault();
    if (newBusy) return;
    $('n-error').hidden = true;

    var data = {
      name: $('n-name').value.trim(),
      contact: $('n-contact').value.trim(),
      address: $('n-address').value.trim(),
      notes: $('n-notes').value.trim(),
      qty: newStepper.get()
    };
    if (!data.name) {
      showNewError('Enter the name of the customer.');
      $('n-name').focus();
      return;
    }

    var sig = JSON.stringify([data.name, data.contact, data.address, data.notes, data.qty]);
    if (!newPending || newPending.sig !== sig) newPending = { sig: sig, id: SJ.newRequestId() };

    setNewBusy(true);
    try {
      var res = await SJ.api('create', Object.assign({ key: state.key, requestId: newPending.id }, data));
      newPending = null;
      state.version++;
      replaceOrder(res.order);
      state.filter = 'awaiting';
      renderOrders();
      showCreated(res);
    } catch (err) {
      if (err.code === 'unauthorized') {
        lock(err.message);
      } else if (err.code === 'not_ready') {
        showNewError('Add the price and your bank details in Settings first.');
        refresh({ quiet: true });
      } else {
        showNewError(err.message + (err.code === 'network' ? ' Your details are still here.' : ''));
      }
    } finally {
      setNewBusy(false);
    }
  }

  function showCreated(res) {
    var o = res.order;
    var text = SJ.invoiceText(o, res);
    var result = $('new-result');
    SJ.clear(result);

    var preview = el('div', { class: 'preview' }, text);
    var copy = el('button', { type: 'button', class: 'btn btn-primary btn-block' }, 'Copy invoice');
    copy.addEventListener('click', async function () {
      var ok = await SJ.copyText(text);
      if (ok) {
        flashLabel(copy, 'Copied', 'Copy invoice');
      } else {
        selectContents(preview);
        flashLabel(copy, 'Press and hold the text to copy', 'Copy invoice');
      }
    });

    result.appendChild(el('div', null,
      el('h2', { class: 'section-title', id: 'created-title', tabindex: '-1' }, o.invoice + ' created'),
      el('p', { class: 'lede' }, 'Send this to ' + o.name + ' in your DM. It has the bank details and the reference to use.')));
    result.appendChild(preview);
    result.appendChild(copy);
    result.appendChild(el('div', { class: 'actions actions--pair' },
      el('button', {
        type: 'button', class: 'btn btn-quiet',
        onclick: function () {
          resetNewForm();
          setTab('orders');
          flashOrder(o.invoice);
        }
      }, 'Back to orders'),
      el('button', {
        type: 'button', class: 'btn btn-quiet',
        onclick: function () {
          resetNewForm();
          $('n-name').focus();
        }
      }, 'New order')));

    $('new-form').hidden = true;
    result.hidden = false;
    window.scrollTo(0, 0);
    $('created-title').focus({ preventScroll: true });
  }

  function resetNewForm() {
    newPending = null;
    ['n-name', 'n-contact', 'n-address', 'n-notes'].forEach(function (id) { $(id).value = ''; });
    if (newStepper) newStepper.set(1);
    $('n-error').hidden = true;
    $('new-form').hidden = false;
    $('new-result').hidden = true;
    SJ.clear($('new-result'));
  }

  // ---------- Settings tab ----------

  async function loadSettings() {
    var body = $('settings-body');
    SJ.clear(body);
    body.appendChild(el('p', { class: 'fine', role: 'status' }, 'Loading settings…'));
    try {
      var res = await SJ.api('getSettings', { key: state.key });
      state.settings = res.values || {};
      state.settingsLoaded = true;
      renderSettings();
    } catch (err) {
      if (err.code === 'unauthorized') {
        lock(err.message);
        return;
      }
      SJ.clear(body);
      body.appendChild(el('div', { class: 'stack' },
        el('p', null, err.message),
        el('button', { type: 'button', class: 'btn btn-primary', onclick: loadSettings }, 'Try again')));
    }
  }

  function orderLinkRow() {
    var url = orderPageUrl();
    return el('div', { class: 'pay-row' },
      el('div', { class: 'pay-main' },
        el('span', { class: 'pay-label' }, 'Order page'),
        el('a', { class: 'pay-value', href: url, target: '_blank', rel: 'noopener' }, url)),
      SJ.copyButton(url, 'Copy'));
  }

  function settingField(f) {
    var id = 's-' + f.key;
    var common = { id: id, name: f.key, maxlength: String(f.max), autocomplete: 'off' };
    if (f.hint) common['aria-describedby'] = id + '-hint';
    var input;
    if (f.long) {
      input = el('textarea', Object.assign({ rows: '3' }, common));
    } else {
      input = el('input', Object.assign({ type: f.type || 'text', inputmode: f.mode || null }, common));
      if (f.type === 'email') {
        input.setAttribute('autocapitalize', 'none');
        input.setAttribute('spellcheck', 'false');
      }
    }
    input.value = state.settings[f.key] || '';
    return el('div', { class: 'field' + (f.wide ? ' span-all' : '') },
      el('label', { for: id }, f.label),
      input,
      f.hint ? el('p', { class: 'hint', id: id + '-hint' }, f.hint) : null);
  }

  function renderSettings() {
    var body = $('settings-body');
    SJ.clear(body);
    var wrap = el('div', { class: 'stack-xl' });

    wrap.appendChild(el('section', { class: 'stack' },
      el('h2', { class: 'section-title' }, 'Your order page'),
      el('p', { class: 'fine' }, 'Put this link in your Instagram bio.'),
      el('div', { class: 'pay' }, orderLinkRow())));

    var form = el('form', { id: 'settings-form', class: 'stack-xl', novalidate: true });
    SETTINGS_LAYOUT.forEach(function (section) {
      var grid = el('div', { class: 'form-grid form-grid--two' });
      section.fields.forEach(function (f) { grid.appendChild(settingField(f)); });
      form.appendChild(el('section', { class: 'stack' }, el('h2', { class: 'section-title' }, section.title), grid));
    });
    form.appendChild(el('div', { class: 'alert alert-bad', id: 'settings-error', role: 'alert', hidden: true }));
    form.appendChild(el('button', { type: 'submit', class: 'btn btn-primary btn-block', id: 'settings-save' }, 'Save settings'));
    form.addEventListener('submit', onSaveSettings);
    wrap.appendChild(form);
    body.appendChild(wrap);
  }

  async function onSaveSettings(ev) {
    ev.preventDefault();
    if (savingSettings) return;
    var box = $('settings-error');
    var btn = $('settings-save');
    box.hidden = true;

    var values = {};
    SETTING_KEYS.forEach(function (k) { values[k] = $('s-' + k).value; });

    savingSettings = true;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      var wasReady = !!(state.config && state.config.ready);
      var res = await SJ.api('saveSettings', { key: state.key, values: values });
      state.version++;
      state.settings = res.values || {};
      state.config = res.config;
      SETTING_KEYS.forEach(function (k) { $('s-' + k).value = state.settings[k] || ''; });
      renderAll();
      SJ.toast(!wasReady && res.config.ready ? 'Settings saved. Your order page is open.' : 'Settings saved.');
    } catch (err) {
      if (err.code === 'unauthorized') {
        lock(err.message);
        return;
      }
      box.textContent = err.message;
      box.hidden = false;
      SJ.toast('Settings were not saved.', 'bad');
    } finally {
      savingSettings = false;
      btn.disabled = false;
      btn.textContent = 'Save settings';
    }
  }

  // ---------- Start ----------

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
    b.addEventListener('click', function () { setTab(b.getAttribute('data-tab')); });
  });

  $('lock').addEventListener('click', function () { lock(''); });

  $('login-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var key = $('key').value.trim();
    if (!key) {
      showLogin('Paste your admin key.');
      $('key').focus();
      return;
    }
    state.key = key;
    $('key').value = '';
    showScreen('loading');
    refresh({});
  });

  $('load-retry').addEventListener('click', function () {
    showScreen('loading');
    refresh({});
  });

  // The private link opened while this page is already open only changes the part after #.
  // Reloading lets the start-up code pick the key up.
  window.addEventListener('hashchange', function () {
    if (window.location.hash.length > 1) window.location.reload();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.key && state.shown && !state.refreshing &&
        Date.now() - state.loadedAt > STALE_AFTER) {
      refresh({ quiet: true });
    }
  });

  initNewForm();

  (function boot() {
    var key = takeKeyFromHash() || SJ.store.get(KEY_STORE);
    if (typeof key !== 'string' || !key) {
      showLogin('');
      return;
    }
    state.key = key;
    showScreen('loading');
    refresh({});
  })();
})();
