/* Greg's order desk: orders, new DM order, settings. */
(function () {
  'use strict';

  var SJ = window.SJ;
  var el = SJ.el;
  var $ = function (id) { return document.getElementById(id); };

  var KEY_STORE = 'sj_admin_key';
  var STALE_AFTER = 30 * 1000;
  var LIST_LIMIT = 500; // the most orders the service sends back

  var REQUESTED = 'New request';
  var AWAITING = 'Awaiting payment';
  var PAID = 'Paid';
  var DELIVERED = 'Delivered';
  var CANCELLED = 'Cancelled';

  var FILTERS = [
    { id: 'requests', status: REQUESTED, label: 'New requests' },
    { id: 'awaiting', status: AWAITING, label: 'Awaiting payment' },
    { id: 'paid', status: PAID, label: 'Paid' },
    { id: 'delivered', status: DELIVERED, label: 'Delivered' },
    { id: 'cancelled', status: CANCELLED, label: 'Cancelled' },
    // Not a status: every collection still to hand over, by date and time.
    { id: 'collections', status: null, label: 'Collections' }
  ];
  var BULK_MAX = 50; // the most orders the service changes at once
  var LOW_EMAILS = 10; // warn when fewer emails than this can still be sent today

  var STATUS_CLASS = {};
  STATUS_CLASS[REQUESTED] = 'awaiting';
  STATUS_CLASS[AWAITING] = 'awaiting';
  STATUS_CLASS[PAID] = 'paid';
  STATUS_CLASS[DELIVERED] = 'delivered';
  STATUS_CLASS[CANCELLED] = 'cancelled';

  var SETTINGS_LAYOUT = [
    {
      id: 'price',
      title: 'Price and delivery',
      about: 'Price, delivery fee, how many per order',
      fields: [
        { key: 'price', label: 'Price per sachet', hint: 'A number, for example 40', mode: 'decimal', max: 12 },
        { key: 'delivery_fee', label: 'Delivery fee', hint: '0 means free delivery. With the box below ticked, customers see it as "from".', mode: 'decimal', max: 12 },
        { key: 'delivery_quote', label: 'Confirm the delivery fee for each order', hint: 'Delivery orders from your order page wait under New requests until you set the fee and accept them. The invoice is emailed then. Untick to charge the fee above straight away.', type: 'checkbox', wide: true },
        { key: 'min_quantity', label: 'Fewest sachets per order', hint: 'The quantity starts here. 1 means no minimum', mode: 'numeric', max: 3 },
        { key: 'max_quantity', label: 'Most sachets per order', mode: 'numeric', max: 3 }
      ]
    },
    {
      id: 'collection',
      title: 'Collection',
      about: 'Place, dates and times customers can collect',
      fields: [
        { key: 'collection_note', label: 'Collection place', hint: 'Where customers collect, for example Sea Point. Shown on your order page, invoices and calendar invites. Collection is free.', wide: true, max: 200 },
        { key: 'collection_hours', label: 'Usual times', hint: 'New dates start with these. You can change any date below.', type: 'hours' },
        { key: 'collection_slot_minutes', label: 'Length of each time', type: 'select', options: [['15', '15 minutes'], ['30', '30 minutes'], ['60', '1 hour']] },
        { key: 'collection_per_slot', label: 'Customers per time', hint: '1 means no two customers share a time', mode: 'numeric', max: 2 },
        { key: 'collection_dates', label: 'Dates and times you hand over orders', hint: 'Tap a date, then set From and To for each time you are there that day. Customers pick a time inside it. From tomorrow up to 30 days ahead. Add new dates as the weeks go by.', type: 'dates' }
      ]
    },
    {
      id: 'bank',
      title: 'Bank details',
      about: 'Where customers pay',
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
      id: 'shop',
      title: 'Shop',
      about: 'Names, invoice numbers, order alerts',
      fields: [
        { key: 'brand_name', label: 'Brand name', max: 60 },
        { key: 'product_name', label: 'Product name', max: 60 },
        { key: 'currency_symbol', label: 'Currency symbol', max: 4 },
        { key: 'invoice_prefix', label: 'Invoice prefix', hint: 'SJ gives SJ-0001, SJ-0002 and so on', max: 6 },
        { key: 'alert_email', label: 'Email me new orders', hint: 'Orders from your order page are sent here. Leave blank for none.', type: 'email', wide: true, max: 120 }
      ]
    }
  ];
  var SETTING_FIELDS = [];
  SETTINGS_LAYOUT.forEach(function (s) { s.fields.forEach(function (f) { SETTING_FIELDS.push(f); }); });

  var WEEK_HEAD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var datesDraft = {};     // collection times being set: { date: [{ from, to }] }. null means the usual times.
  var datesEditing = null; // the date whose times are shown under the calendar

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
    acceptFees: {},     // delivery fee typed for each new request, by invoice
    declineReason: '',
    query: '',          // the search box
    selected: {},       // ticked orders in the list shown, by invoice
    bulk: null,         // { op, reason, subject, message, error } while a bulk action is being confirmed
    bulkFailures: [],   // orders the last bulk action could not change, with the reason
    bulkPreview: null,  // the hand-over list, shown when copying it failed
    emailsLeft: null,   // emails Google still allows today
    moveDraft: null,    // { date, time } typed for a new collection time
    moveError: null,
    editing: null,      // invoice being edited
    editDraft: null,    // what has been typed into the edit form so far
    editError: null,
    flash: null,
    focus: null,        // { invoice?, role } to focus after the next draw
    settings: null,
    settingsLoaded: false,
    openGroups: {}      // settings sections Greg has opened, by id
  };

  var cards = {};
  var refreshBtn = null;
  var newStepper = null;
  var newPending = null; // { sig, id }: a retry of the same order reuses one request id
  var newBusy = false;
  var newFeeTouched = false; // Greg typed his own fee, so a settings change does not overwrite it
  var newChoice = null;      // 'collect' or 'deliver' on the DM form, null until Greg picks
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

  // Customers order from all over South Africa, so Maps is only told the country.
  function mapsHref(address) {
    var q = String(address || '').replace(/\s+/g, ' ').trim();
    if (!q) return null;
    if (!/south africa/i.test(q)) q += ', South Africa';
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
    state.editing = null;
    state.editDraft = null;
    state.editError = null;
    state.acceptFees = {};
    state.declineReason = '';
    state.flash = null;
    state.focus = null;
    state.settings = null;
    state.settingsLoaded = false;
    photoSrc = null;
    photoSrcVersion = null;
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
    if (typeof res.emailsLeft === 'number') state.emailsLeft = res.emailsLeft;
    // Ticks stay only on orders that are still in the list shown.
    var shown = visibleOrders(currentFilter()).map(function (o) { return o.invoice; });
    Object.keys(state.selected).forEach(function (inv) { if (shown.indexOf(inv) === -1) delete state.selected[inv]; });
    state.loadedAt = Date.now();
    SJ.store.set(KEY_STORE, state.key);
    if (!state.shown) {
      state.shown = true;
      // Open on whatever needs Greg first: requests to price, then payments to check, then deliveries.
      state.filter = countOf(REQUESTED) > 0 ? 'requests'
        : countOf(AWAITING) > 0 ? 'awaiting' : (countOf(PAID) > 0 ? 'paid' : 'awaiting');
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
    // Typing in the search box redraws the list: the cursor goes back where it was.
    var active = document.activeElement;
    var caret = active && active.id === 'order-search' ? active.selectionStart : null;
    SJ.clear(panel);
    cards = {};
    refreshBtn = null;
    var c = state.config;
    if (!c) return;

    if (!c.ready) panel.appendChild(setupBanner('Your order page is closed until you add the price and your bank details.'));
    else if (c.collectDatesLeft === 0) panel.appendChild(setupBanner('No collection dates are left, so customers cannot collect. Tick more dates in Settings.'));
    else if (c.collectDatesLeft < 4) panel.appendChild(setupBanner('Collection dates run out after ' + SJ.formatDay(c.collectLastDate) + '. Tick more dates in Settings.'));
    if (typeof state.emailsLeft === 'number' && state.emailsLeft < LOW_EMAILS) {
      panel.appendChild(el('div', { class: 'alert alert-wait', role: 'status' }, el('p', null,
        state.emailsLeft === 0
          ? 'No more emails can be sent today. Invoices and calendar invites go out again tomorrow. Copy invoices into DMs until then.'
          : 'Only ' + plural(state.emailsLeft, 'email') + ' can be sent today. Google allows about 100 a day.')));
    }
    panel.appendChild(searchBox());
    panel.appendChild(chipsRow());

    var f = currentFilter();
    var list = visibleOrders(f);
    pickable = canSelect(f) && list.length > 0;
    panel.appendChild(listHead(f, list));

    if (!list.length) {
      panel.appendChild(searching() ? el('div', { class: 'empty' }, el('p', null, 'No orders match.')) : emptyState(f));
    } else if (f.id === 'collections' && !searching()) {
      collectionGroups(list).forEach(function (g) {
        panel.appendChild(el('h3', { class: 'collect-day' }, g.title));
        var ul = el('ul', { class: 'orders' });
        g.orders.forEach(function (o) { ul.appendChild(el('li', null, orderCard(o))); });
        panel.appendChild(ul);
      });
    } else {
      var ul = el('ul', { class: 'orders' });
      list.forEach(function (o) { ul.appendChild(el('li', null, orderCard(o))); });
      panel.appendChild(ul);
    }
    if (state.orders.length >= LIST_LIMIT) {
      panel.appendChild(el('p', { class: 'fine' }, 'Showing the latest ' + LIST_LIMIT + ' orders. Older ones are still in your sheet.'));
    }
    var bar = pickable ? bulkBar(f, list) : null;
    if (bar) panel.appendChild(bar);
    if (caret !== null) {
      var box = $('order-search');
      box.focus({ preventScroll: true });
      box.setSelectionRange(caret, caret);
    }
    restoreFocus();
  }

  // ---------- Search, collections and the lists ----------

  function searching() {
    return !!state.query.trim();
  }

  // Ticking several orders only makes sense where they are all at the same step.
  function canSelect(f) {
    return !searching() && f.id !== 'collections';
  }

  // A collection still to hand over: placed or paid, not yet collected or cancelled.
  function upcomingCollection(o) {
    return o.collect && (o.status === AWAITING || o.status === PAID);
  }

  function filterCount(f) {
    return f.id === 'collections' ? state.orders.filter(upcomingCollection).length : countOf(f.status);
  }

  // Name, invoice number, email, contact or address. Phone numbers match with or without spaces.
  function matches(o, query) {
    var q = query.trim().toLowerCase();
    var text = [o.invoice, o.name, o.email, o.contact, o.address].join(' ').toLowerCase();
    if (text.indexOf(q) !== -1) return true;
    var digits = q.replace(/\D/g, '');
    return digits.length >= 4 && String(o.contact || '').replace(/\D/g, '').indexOf(digits) !== -1;
  }

  function byCollectTime(a, b) {
    if (!a.collectAt !== !b.collectAt) return a.collectAt ? -1 : 1;
    return a.collectAt < b.collectAt ? -1 : a.collectAt > b.collectAt ? 1 : newestFirst(a, b);
  }

  function visibleOrders(f) {
    if (searching()) return state.orders.filter(function (o) { return matches(o, state.query); }).sort(newestFirst);
    if (f.id === 'collections') return state.orders.filter(upcomingCollection).sort(byCollectTime);
    return state.orders.filter(function (o) { return o.status === f.status; }).sort(newestFirst);
  }

  // A date on this phone as 2026-10-29.
  function dateText(d) {
    return d.getFullYear() + '-' + (d.getMonth() < 9 ? '0' : '') + (d.getMonth() + 1) + '-' + (d.getDate() < 10 ? '0' : '') + d.getDate();
  }

  // [{ title, orders }]: collections before today that were not marked collected, then each day, then no time.
  function collectionGroups(list) {
    var now = new Date();
    var today = dateText(now);
    var tomorrow = dateText(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    var groups = [];
    function group(title) {
      var g = groups.filter(function (x) { return x.title === title; })[0];
      if (!g) groups.push(g = { title: title, orders: [] });
      return g;
    }
    list.forEach(function (o) {
      var day = SJ.dayOf(o.collectAt);
      var title;
      if (!o.collectAt) title = 'No time yet';
      else if (day < today) title = 'Earlier, not yet collected';
      else title = (day === today ? 'Today, ' : day === tomorrow ? 'Tomorrow, ' : '') + SJ.formatWhen(day + ' 00:00').split(',')[0];
      group(title).orders.push(o);
    });
    return groups;
  }

  function searchBox() {
    var input = el('input', {
      type: 'search', id: 'order-search', 'aria-label': 'Search orders', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Search name, invoice, phone or email', 'data-role': 'search'
    });
    input.value = state.query;
    input.addEventListener('input', function () {
      state.query = input.value;
      state.selected = {};
      state.bulk = null;
      state.bulkFailures = [];
      state.bulkPreview = null;
      renderOrders();
    });
    return el('div', { class: 'field search-field' }, input);
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
      // With a fixed delivery fee there are no requests, so the filter would only be clutter.
      if (f.status === REQUESTED && !state.config.quote && countOf(REQUESTED) === 0 && state.filter !== 'requests') return;
      var btn = el('button', {
        type: 'button', class: 'chip', 'aria-pressed': state.filter === f.id ? 'true' : 'false', 'data-role': 'chip-' + f.id
      }, f.label, el('span', { class: 'chip-count' }, String(filterCount(f))));
      btn.addEventListener('click', function () {
        state.filter = f.id;
        state.query = '';
        state.selected = {};
        state.bulk = null;
        state.bulkFailures = [];
        state.bulkPreview = null;
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
    if (searching()) return plural(n, 'order') + ' match \u201c' + state.query.trim() + '\u201d.';
    if (!n) return '';
    var total = SJ.money(sumOf(list), state.config.currency);
    if (f.id === 'collections') return plural(n, 'collection') + ' to hand over.';
    if (f.id === 'requests') return plural(n, 'new request') + ' to set a delivery fee for and accept.';
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
    var head = el('div', { class: 'list-head' }, el('p', { class: 'list-total' }, listSummary(f, list)),
      searching() ? actionButton('Clear search', 'btn-quiet', 'clear-search', function () {
        state.query = '';
        state.focus = { role: 'search' };
        renderOrders();
      }) : refreshBtn);
    if (!pickable) return head;

    var picked = list.filter(function (o) { return state.selected[o.invoice]; }).length;
    var all = el('input', { type: 'checkbox', id: 'select-all', 'data-role': 'select-all' });
    all.checked = picked === list.length;
    all.indeterminate = picked > 0 && picked < list.length;
    all.addEventListener('change', function () {
      state.selected = {};
      if (all.checked) list.slice(0, BULK_MAX).forEach(function (o) { state.selected[o.invoice] = true; });
      state.bulk = null;
      state.bulkFailures = [];
      state.bulkPreview = null;
      state.focus = { role: 'select-all' };
      renderOrders();
    });
    return el('div', { class: 'stack-sm' }, head,
      el('label', { class: 'check select-all' }, all,
        el('span', null, list.length > BULK_MAX ? 'Select the first ' + BULK_MAX : 'Select all')));
  }

  // ---------- Several orders at once ----------

  var pickable = false; // the list shown has tick boxes

  // The same rules as the service: which customers an action emails.
  function emailsFor(op, o) {
    if (!SJ.isEmail(o.email)) return false;
    if (op === 'paid') return o.status === AWAITING;
    if (op === 'decline') return o.status === REQUESTED;
    if (op === 'cancel') return o.status === PAID && o.collect && !!o.collectAt;
    if (op === 'email') return o.status !== CANCELLED && o.status !== REQUESTED;
    return op === 'message';
  }

  function chosenOrders(list) {
    return list.filter(function (o) { return state.selected[o.invoice]; });
  }

  function bulkActions(f, chosen) {
    var msg = { op: 'message', label: 'Send a message' };
    var email = { op: 'email', label: 'Email invoices' };
    var cancel = { op: 'cancel', label: 'Cancel', cls: 'btn-danger' };
    var collect = chosen.every(function (o) { return o.collect; });
    var deliver = chosen.every(function (o) { return !o.collect; });
    if (f.id === 'requests') return [{ op: 'decline', label: 'Decline', cls: 'btn-danger' }, msg];
    if (f.id === 'awaiting') return [{ op: 'paid', label: 'Mark paid', cls: 'btn-primary' }, email, msg, cancel];
    if (f.id === 'paid') {
      return [
        { op: 'delivered', label: collect ? 'Mark collected' : deliver ? 'Mark delivered' : 'Mark delivered or collected', cls: 'btn-primary' },
        { op: 'copy', label: 'Copy hand-over list', run: function () { copyHandOver(chosen); } },
        email, msg, cancel];
    }
    if (f.id === 'delivered') return [email, msg];
    return [{ op: 'reopen', label: 'Reopen', cls: 'btn-primary' }, msg];
  }

  function clearBulk(focusRole) {
    state.selected = {};
    state.bulk = null;
    state.bulkFailures = [];
    state.bulkPreview = null;
    state.focus = { role: focusRole || 'select-all' };
    renderOrders();
  }

  function bulkBar(f, list) {
    var chosen = chosenOrders(list);
    if (!chosen.length) return null;
    var c = state.config;
    var bar = el('section', { class: 'bulk-bar stack-sm', 'aria-label': 'Selected orders' });
    bar.appendChild(el('p', { class: 'bulk-count', role: 'status' },
      plural(chosen.length, 'order') + ' selected \u00b7 ' + SJ.money(sumOf(chosen), c.currency)));
    if (state.bulkFailures.length) {
      bar.appendChild(el('div', { class: 'alert alert-bad', role: 'alert' },
        el('p', null, 'These were not changed and are still ticked:'),
        el('ul', { class: 'bulk-failures' }, state.bulkFailures.map(function (r) { return el('li', null, r.invoice + ': ' + r.message); }))));
    }
    if (state.bulk) {
      bar.appendChild(bulkConfirm(f, chosen));
      return bar;
    }
    var working = !!state.working;
    var row = el('div', { class: 'order-actions' });
    bulkActions(f, chosen).forEach(function (a) {
      row.appendChild(actionButton(a.label, a.cls || 'btn-quiet', 'bulk-' + a.op, a.run || function () { askBulk(a.op); }, working));
    });
    row.appendChild(actionButton('Clear', 'btn-quiet', 'bulk-clear', function () { clearBulk(); }, working));
    bar.appendChild(row);
    if (state.bulkPreview) {
      bar.appendChild(el('p', { class: 'fine' }, 'Copying did not work here. Press and hold the list to copy it.'));
      bar.appendChild(el('div', { class: 'preview', 'data-role': 'bulk-preview', tabindex: '-1' }, state.bulkPreview));
    }
    return bar;
  }

  function askBulk(op) {
    var c = state.config;
    state.bulk = { op: op, reason: '', subject: op === 'message' ? c.brand + ' update' : '', message: '', error: null };
    state.bulkPreview = null;
    state.focus = { role: op === 'message' ? 'bulk-message' : op === 'decline' ? 'bulk-reason' : 'bulk-confirm' };
    renderOrders();
  }

  function bulkConfirm(f, chosen) {
    var b = state.bulk;
    var c = state.config;
    var total = SJ.money(sumOf(chosen), c.currency);
    var mailOnly = b.op === 'email' || b.op === 'message';
    var targets = mailOnly ? chosen.filter(function (o) { return SJ.isEmail(o.email); }) : chosen;
    var skipped = chosen.length - targets.length;
    var needed = targets.filter(function (o) { return emailsFor(b.op, o); }).length;
    var n = chosen.length;
    var collect = chosen.every(function (o) { return o.collect; });
    var texts = {
      paid: 'Mark ' + plural(n, 'order') + ' paid (' + total + ')?' + (needed ? ' ' + plural(needed, 'customer') + ' with an email ' + (needed === 1 ? 'gets' : 'get') + ' the paid invoice.' : ''),
      delivered: 'Mark ' + plural(n, 'order') + ' ' + (collect ? 'collected' : 'delivered') + '?',
      cancel: 'Cancel ' + plural(n, 'order') + ' (' + total + ')?' + (needed ? ' ' + plural(needed, 'customer') + ' with a collection booked ' + (needed === 1 ? 'gets' : 'get') + ' a cancellation for the calendar invite.' : ''),
      reopen: 'Reopen ' + plural(n, 'order') + '? They go back to Awaiting payment.',
      decline: 'Decline ' + plural(n, 'request') + '? They are cancelled' + (needed ? ', and ' + plural(needed, 'customer') + ' with an email ' + (needed === 1 ? 'is' : 'are') + ' told.' : '.'),
      email: 'Email the invoice to ' + plural(targets.length, 'customer') + '?',
      message: 'Email your own message to ' + plural(targets.length, 'customer') + '. It starts with "Hi" and their name.'
    };
    var box = el('div', { class: 'stack-sm' });
    var text = texts[b.op];
    if (skipped) text += ' ' + plural(skipped, 'selected order') + ' with no email address ' + (skipped === 1 ? 'is' : 'are') + ' left out.';
    box.appendChild(el('p', null, text));

    if (b.op === 'decline') {
      var reason = el('textarea', { id: 'bulk-reason', rows: '2', maxlength: '300', 'data-role': 'bulk-reason' });
      reason.value = b.reason;
      reason.addEventListener('input', function () { b.reason = reason.value; });
      box.appendChild(el('div', { class: 'field' }, el('label', { for: 'bulk-reason' }, 'Reason (optional, emailed to each customer)'), reason));
    }
    if (b.op === 'message') {
      var subject = el('input', { type: 'text', id: 'bulk-subject', maxlength: '120', autocomplete: 'off', 'data-role': 'bulk-subject' });
      subject.value = b.subject;
      subject.addEventListener('input', function () { b.subject = subject.value; });
      var message = el('textarea', { id: 'bulk-message', rows: '5', maxlength: '2000', 'data-role': 'bulk-message' });
      message.value = b.message;
      message.addEventListener('input', function () { b.message = message.value; });
      box.appendChild(el('div', { class: 'field' }, el('label', { for: 'bulk-subject' }, 'Subject'), subject));
      box.appendChild(el('div', { class: 'field' }, el('label', { for: 'bulk-message' }, 'Message'), message));
    }

    var left = state.emailsLeft;
    var over = needed > 0 && typeof left === 'number' && needed > left;
    if (over) {
      box.appendChild(el('div', { class: 'alert alert-bad', role: 'alert' },
        'This sends ' + plural(needed, 'email') + ', but only ' + left + ' can be sent today. Pick fewer orders, or try again tomorrow.'));
    } else if (needed > 0 && typeof left === 'number') {
      box.appendChild(el('p', { class: 'fine' }, plural(needed, 'email') + ' to send. ' + left + ' left today.'));
    }
    if (b.error) box.appendChild(el('div', { class: 'alert alert-bad', role: 'alert' }, b.error));

    var labels = { paid: 'Yes, mark paid', delivered: collect ? 'Yes, mark collected' : 'Yes, mark delivered', cancel: 'Yes, cancel', reopen: 'Yes, reopen', decline: 'Yes, decline', email: 'Yes, email', message: 'Send' };
    var working = state.working === 'bulk';
    box.appendChild(el('div', { class: 'order-actions' },
      actionButton(working ? 'Working\u2026' : labels[b.op], b.op === 'cancel' || b.op === 'decline' ? 'btn-danger' : 'btn-primary', 'bulk-confirm',
        function () { runBulk(); }, working || over || !targets.length),
      actionButton('Back', 'btn-quiet', 'bulk-back', function () {
        state.bulk = null;
        state.focus = { role: 'bulk-' + b.op };
        renderOrders();
      }, working)));
    return box;
  }

  async function runBulk() {
    if (state.working) return;
    var b = state.bulk;
    var chosen = chosenOrders(visibleOrders(currentFilter()));
    var targets = b.op === 'email' || b.op === 'message' ? chosen.filter(function (o) { return SJ.isEmail(o.email); }) : chosen;
    if (b.op === 'message' && !b.message.trim()) {
      b.error = 'Write the message to send.';
      state.focus = { role: 'bulk-message' };
      renderOrders();
      return;
    }
    if (!targets.length) return;
    state.working = 'bulk';
    b.error = null;
    renderOrders();
    try {
      var res = await SJ.api('bulk', {
        key: state.key, op: b.op, invoices: targets.map(function (o) { return o.invoice; }),
        reason: b.reason.trim(), subject: b.subject.trim(), message: b.message
      });
      state.version++;
      res.results.forEach(function (r) { if (r.order) replaceOrder(r.order); });
      if (typeof res.emailsLeft === 'number') state.emailsLeft = res.emailsLeft;
      var failed = res.results.filter(function (r) { return !r.ok; });
      var done = res.results.length - failed.length;
      var emailed = res.results.filter(function (r) { return r.emailed === true; }).length;
      var unsent = res.results.filter(function (r) { return r.emailed === false; }).length;
      state.working = null;
      state.bulk = null;
      state.selected = {};
      failed.forEach(function (r) { state.selected[r.invoice] = true; });
      state.bulkFailures = failed;
      var done1 = {
        paid: ' marked paid.', delivered: ' marked ' + (chosen.every(function (o) { return o.collect; }) ? 'collected.' : 'delivered.'),
        cancel: ' cancelled.', reopen: ' reopened.', decline: ' declined.', email: ' emailed the invoice.', message: ' sent your message.'
      }[b.op];
      var who = b.op === 'email' || b.op === 'message' ? plural(done, 'customer') : plural(done, b.op === 'decline' ? 'request' : 'order');
      var text = who + done1;
      if (b.op === 'paid' && emailed) text += ' ' + plural(emailed, 'paid invoice') + ' emailed.';
      if (unsent) text += ' ' + plural(unsent, 'email') + ' did not send.';
      if (failed.length) text += ' ' + plural(failed.length, 'order') + ' could not be changed.';
      state.focus = { role: failed.length ? 'select-all' : 'search' };
      renderOrders();
      SJ.toast(text, failed.length || unsent ? 'bad' : undefined);
    } catch (err) {
      state.working = null;
      if (err.code === 'unauthorized') {
        lock(err.message);
        return;
      }
      if (err.data && typeof err.data.emailsLeft === 'number') state.emailsLeft = err.data.emailsLeft;
      b.error = err.message;
      state.focus = { role: 'bulk-confirm' };
      renderOrders();
    }
  }

  // A list to hand to a driver or keep at the collection spot: deliveries first, then collections by time.
  function handOverText(chosen) {
    var c = state.config;
    var deliveries = chosen.filter(function (o) { return !o.collect; });
    var collections = chosen.filter(function (o) { return o.collect; }).sort(byCollectTime);
    var lines = [c.brand.toUpperCase() + ': ' + plural(chosen.length, 'order') + ' to hand over'];
    var n = 0;
    function add(o, where) {
      n++;
      lines.push('', n + '. ' + o.name + ' (' + o.invoice + ')', '   ' + o.qty + ' x ' + c.product, '   ' + where);
      if (o.contact) lines.push('   Contact: ' + o.contact);
      if (o.notes) lines.push('   Note: ' + o.notes);
    }
    deliveries.forEach(function (o) { add(o, 'Deliver to: ' + (o.address || 'no address yet')); });
    collections.forEach(function (o) { add(o, 'Collecting: ' + (o.collectAt ? SJ.formatWhen(o.collectAt) : 'no time yet')); });
    return lines.join('\n');
  }

  async function copyHandOver(chosen) {
    var text = handOverText(chosen);
    var ok = await SJ.copyText(text);
    if (ok) {
      state.bulkPreview = null;
      SJ.toast('Hand-over list copied: ' + plural(chosen.length, 'order') + '.');
      return;
    }
    state.bulkPreview = text;
    state.focus = { role: 'bulk-preview' };
    renderOrders();
  }

  function emptyState(f) {
    var none = state.orders.length === 0;
    var texts = {
      requests: 'No new requests.',
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
    var href = mapsHref(address);
    return href ? el('a', { href: href, target: '_blank', rel: 'noopener' }, address) : address;
  }

  function labelled(label, value) {
    return el('p', { class: 'order-text' }, el('span', { class: 'order-label' }, label), value);
  }

  function metaRow(o) {
    var row = el('div', { class: 'order-meta' });
    row.appendChild(el('span', null, 'Ordered ' + SJ.formatWhen(o.created)));
    if (o.paidOn) row.appendChild(el('span', null, 'Paid ' + SJ.formatWhen(o.paidOn)));
    if (o.deliveredOn) row.appendChild(el('span', null, (o.collect ? 'Collected ' : 'Delivered ') + SJ.formatWhen(o.deliveredOn)));
    if (o.emailedOn) row.appendChild(el('span', null, 'Invoice emailed ' + SJ.formatWhen(o.emailedOn)));
    if (o.editedOn) row.appendChild(el('span', null, 'Edited ' + SJ.formatWhen(o.editedOn)));
    row.appendChild(el('span', null, o.source === 'kiosk' ? 'From the order page' : 'DM order'));
    return row;
  }

  function orderCard(o) {
    var c = state.config;
    var sym = c.currency;
    var awaiting = o.status === AWAITING;
    var request = o.status === REQUESTED;
    var card = el('article', {
      class: 'order' + (state.flash === o.invoice ? ' order--flash' : ''),
      'aria-label': 'Order ' + o.invoice
    });
    cards[o.invoice] = card;

    var badge = el('span', { class: 'badge' + (awaiting || request ? ' badge--attention' : '') }, o.invoice);
    if (pickable) {
      var pick = el('input', { type: 'checkbox', 'data-role': 'pick', 'aria-label': 'Select ' + o.invoice + ', ' + o.name });
      pick.checked = !!state.selected[o.invoice];
      pick.addEventListener('change', function () {
        if (pick.checked) state.selected[o.invoice] = true;
        else delete state.selected[o.invoice];
        state.bulk = null;
        state.bulkPreview = null;
        state.focus = { invoice: o.invoice, role: 'pick' };
        renderOrders();
      });
      badge = el('label', { class: 'pick' }, pick, badge);
      if (state.selected[o.invoice]) card.classList.add('order--picked');
    }
    card.appendChild(el('div', { class: 'order-head' },
      badge,
      el('span', { class: 'order-amount' }, SJ.money(o.total, sym))));

    card.appendChild(el('div', { class: 'order-who' },
      el('span', { class: 'order-name' }, o.name),
      el('span', { class: 'status status-' + (STATUS_CLASS[o.status] || 'cancelled') }, o.status)));

    if (state.editing === o.invoice && (awaiting || request)) {
      card.appendChild(editForm(o));
      return card;
    }

    card.appendChild(el('p', { class: 'order-text' },
      o.qty + ' x ' + c.product + ' at ' + SJ.money(o.price, sym) + ', ' +
      (o.collect ? 'collection' : request ? 'delivery fee to be set'
        : (o.fee > 0 ? 'delivery ' + SJ.money(o.fee, sym) : 'free delivery'))));

    if (awaiting) {
      card.appendChild(el('p', { class: 'order-match' },
        'Look for ' + SJ.money(o.total, sym) + ' with reference ', el('span', { class: 'nowrap' }, o.invoice), ' on your bank statement.'));
    }

    var contact = contactNode(o.contact);
    if (contact) card.appendChild(labelled('Contact', contact));
    if (o.email) card.appendChild(labelled('Email', el('a', { href: 'mailto:' + o.email }, o.email)));
    if (o.collect) card.appendChild(labelled('Collect', o.collectAt ? SJ.formatWhen(o.collectAt) : 'The customer collects this order. No time set yet.'));
    else if (o.address) card.appendChild(labelled('Address', addressNode(o.address)));
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
    if (o.status === REQUESTED) return 'accept';
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
    if (asking === 'decline') {
      var reason = el('textarea', { id: 'decline-reason', rows: '2', maxlength: '300', 'data-role': 'decline-reason' });
      reason.value = state.declineReason;
      reason.addEventListener('input', function () { state.declineReason = reason.value; });
      return el('div', { class: 'confirm-row' },
        el('p', null, 'Decline ', el('span', { class: 'nowrap' }, o.invoice), ' for ' + o.name + '? The order is cancelled.'),
        o.email
          ? el('div', { class: 'field' }, el('label', { for: 'decline-reason' }, 'Reason (optional, emailed to ' + o.email + ')'), reason)
          : el('p', { class: 'fine' }, 'This customer has no email address. Let them know by DM.'),
        el('div', { class: 'order-actions' },
          actionButton('Yes, decline', 'btn-danger', 'confirm', function () { declineOrder(o); }),
          actionButton('Keep request', 'btn-quiet', 'back', function () { dropConfirm(o); })));
    }
    if (asking === 'move') return moveForm(o, working);
    if (asking === 'cancel') {
      return el('div', { class: 'confirm-row' },
        el('p', null, 'Cancel ', el('span', { class: 'nowrap' }, o.invoice), ' for ' + o.name + '?'),
        el('div', { class: 'order-actions' },
          actionButton('Yes, cancel order', 'btn-danger', 'confirm', function () { setStatus(o, CANCELLED); }),
          actionButton('Keep order', 'btn-quiet', 'back', function () { dropConfirm(o); })));
    }

    if (o.status === REQUESTED) return requestRow(o, working);

    var saving = 'Saving…';
    // Only orders with an email address can have the invoice emailed again.
    var resend = o.email ? [{ label: 'Email invoice', role: 'email', run: function () { emailInvoice(o); } }] : [];
    var row = el('div', { class: 'order-actions' });
    if (o.status === AWAITING) {
      row.appendChild(actionButton(working ? saving : 'Mark paid', 'btn-primary', 'mark-paid', function () { askConfirm(o, 'paid'); }, working));
      row.appendChild(invoiceButton(o, working));
      row.appendChild(actionButton('Edit', 'btn-quiet', 'edit', function () { startEdit(o); }, working));
      row.appendChild(moreMenu(o, resend.concat([
        { label: 'Cancel order', role: 'cancel', danger: true, run: function () { askConfirm(o, 'cancel'); } }
      ]), working));
    } else if (o.status === PAID) {
      row.appendChild(actionButton(working ? saving : (o.collect ? 'Mark collected' : 'Mark delivered'), 'btn-primary', 'mark-delivered', function () { setStatus(o, DELIVERED); }, working));
      row.appendChild(invoiceButton(o, working));
      var move = o.collect ? [{ label: 'Change collection time', role: 'move-time', run: function () { askMove(o); } }] : [];
      row.appendChild(moreMenu(o, resend.concat(move, [
        { label: 'Undo paid', role: 'undo-paid', run: function () { setStatus(o, AWAITING); } },
        { label: 'Cancel order', role: 'cancel', danger: true, run: function () { askConfirm(o, 'cancel'); } }
      ]), working));
    } else if (o.status === DELIVERED) {
      row.appendChild(invoiceButton(o, working));
      row.appendChild(moreMenu(o, resend.concat([
        { label: o.collect ? 'Undo collected' : 'Undo delivered', role: 'undo-delivered', run: function () { setStatus(o, PAID); } }
      ]), working));
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
        if (res.emailed === true) SJ.toast(inv + ' marked paid. The paid invoice was emailed to ' + res.order.email + '.');
        else if (res.emailed === false) SJ.toast(inv + ' marked paid, but the invoice email did not send. Copy the invoice, or try More > Email invoice later.', 'bad');
        else SJ.toast(inv + ' marked paid. Copy the invoice to send it.');
      } else {
        renderOrders();
        if (target === PAID) SJ.toast(inv + ' is back under Paid.');
        else if (target === DELIVERED) SJ.toast(inv + (res.order.collect ? ' marked collected.' : ' marked delivered.'));
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

  // ---------- New requests: set the delivery fee, then accept or decline ----------

  function feeNumber(text) {
    var t = String(text || '').trim().replace(/^[^\d-]*/, '').replace(/\s/g, '').replace(',', '.');
    return /^\d+(\.\d+)?$/.test(t) ? parseFloat(t) : null;
  }

  function requestRow(o, working) {
    var c = state.config;
    if (state.acceptFees[o.invoice] === undefined) state.acceptFees[o.invoice] = String(c.fee);
    var total = el('p', { class: 'list-total', role: 'status' });
    var input = el('input', {
      type: 'text', inputmode: 'decimal', id: 'fee-' + o.invoice, 'data-role': 'accept-fee', maxlength: '12', autocomplete: 'off'
    });
    input.value = state.acceptFees[o.invoice];
    function sync() {
      var fee = feeNumber(input.value);
      total.textContent = fee === null ? 'Enter the delivery fee for this address.'
        : 'Total with delivery: ' + SJ.money(SJ.totalFor(o.qty, o.price, fee), c.currency);
    }
    input.addEventListener('input', function () {
      state.acceptFees[o.invoice] = input.value;
      sync();
    });
    sync();

    var actions = el('div', { class: 'order-actions' },
      actionButton(working ? 'Saving…' : (o.email ? 'Accept and email invoice' : 'Accept'), 'btn-primary', 'accept', function () { acceptOrder(o); }, working),
      actionButton('Edit', 'btn-quiet', 'edit', function () { startEdit(o); }, working),
      moreMenu(o, [{ label: 'Decline', role: 'decline', danger: true, run: function () { state.declineReason = ''; askConfirm(o, 'decline'); } }], working));
    if (o.collect) return actions;
    return el('div', { class: 'stack' },
      el('div', { class: 'field' }, el('label', { for: 'fee-' + o.invoice }, 'Delivery fee for this address'), input),
      total,
      actions);
  }

  async function acceptOrder(o) {
    if (state.working) return;
    var fee = o.collect ? 0 : feeNumber(state.acceptFees[o.invoice]);
    if (fee === null) {
      SJ.toast('Enter the delivery fee first.', 'bad');
      state.focus = { invoice: o.invoice, role: 'accept-fee' };
      renderOrders();
      return;
    }
    state.working = o.invoice;
    renderOrders();
    try {
      var res = await SJ.api('acceptOrder', { key: state.key, invoice: o.invoice, fee: String(fee) });
      state.version++;
      replaceOrder(res.order);
      state.working = null;
      delete state.acceptFees[o.invoice];
      var inv = res.order.invoice;
      // The order now waits for payment: show it there, ready to copy into a DM if needed.
      state.filter = 'awaiting';
      state.focus = { invoice: inv, role: 'copy' };
      flashOrder(inv);
      if (res.emailed === true) SJ.toast(inv + ' accepted. The invoice was emailed to ' + res.order.email + '.');
      else if (res.emailed === false) SJ.toast(inv + ' accepted, but the invoice email did not send. Copy the invoice to send it.', 'bad');
      else SJ.toast(inv + ' accepted. Copy the invoice to send it.');
    } catch (err) {
      state.working = null;
      if (err.code === 'unauthorized') {
        lock(err.message);
        return;
      }
      SJ.toast(err.message, 'bad');
      if (err.code === 'not_found' || /Only new requests/.test(err.message)) refresh({ quiet: true });
      else renderOrders();
    }
  }

  async function declineOrder(o) {
    if (state.working) return;
    var reason = state.declineReason.trim();
    state.working = o.invoice;
    state.confirm = null;
    renderOrders();
    try {
      var res = await SJ.api('declineOrder', { key: state.key, invoice: o.invoice, reason: reason });
      state.version++;
      replaceOrder(res.order);
      state.working = null;
      state.declineReason = '';
      delete state.acceptFees[o.invoice];
      renderOrders();
      var inv = res.order.invoice;
      if (res.emailed === true) SJ.toast(inv + ' declined. The customer was emailed.');
      else if (res.emailed === false) SJ.toast(inv + ' declined, but the email did not send. Let the customer know by DM.', 'bad');
      else SJ.toast(inv + ' declined.');
    } catch (err) {
      state.working = null;
      if (err.code === 'unauthorized') {
        lock(err.message);
        return;
      }
      SJ.toast(err.message, 'bad');
      refresh({ quiet: true });
    }
  }

  // ---------- Collection times ----------

  // A date and a time for a collection. Greg can pick any time, also one customers cannot book.
  function collectTimeInputs(prefix, date, time, onInput) {
    var step = String(((state.config && state.config.collectStep) || 30) * 60);
    var d = el('input', { type: 'date', id: prefix + '-date', 'data-role': prefix + '-date' });
    var t = el('input', { type: 'time', id: prefix + '-time', 'data-role': prefix + '-time', step: step });
    d.value = date || '';
    t.value = time || '';
    function changed() { onInput(d.value, t.value); }
    d.addEventListener('input', changed);
    t.addEventListener('input', changed);
    return el('div', { class: 'slot-pickers' },
      el('div', { class: 'field' }, el('label', { for: d.id }, 'Date'), d),
      el('div', { class: 'field' }, el('label', { for: t.id }, 'Time'), t));
  }

  // "2026-11-03 17:30", '' when both are empty, or null when only one is filled in.
  function joinSlot(date, time) {
    date = String(date || '').trim();
    time = String(time || '').trim().slice(0, 5);
    if (!date && !time) return '';
    return date && time ? date + ' ' + time : null;
  }

  function askMove(o) {
    state.moveDraft = { date: SJ.dayOf(o.collectAt), time: String(o.collectAt || '').slice(11) };
    state.moveError = null;
    state.confirm = { invoice: o.invoice, kind: 'move' };
    state.preview = null;
    state.focus = { invoice: o.invoice, role: 'move-date' };
    renderOrders();
  }

  function moveForm(o, working) {
    var m = state.moveDraft;
    return el('div', { class: 'confirm-row' },
      el('p', null, 'New collection time for ', el('span', { class: 'nowrap' }, o.invoice),
        o.email ? '. ' + o.name + ' is emailed an updated calendar invite.' : '.'),
      collectTimeInputs('move', m.date, m.time, function (date, time) { m.date = date; m.time = time; }),
      state.moveError ? el('div', { class: 'alert alert-bad', role: 'alert' }, state.moveError) : null,
      el('div', { class: 'order-actions' },
        actionButton(working ? 'Saving…' : 'Save new time', 'btn-primary', 'move-save', function () { moveTime(o); }, working),
        actionButton('Keep time', 'btn-quiet', 'back', function () { dropConfirm(o); }, working)));
  }

  async function moveTime(o) {
    if (state.working) return;
    var m = state.moveDraft;
    var at = joinSlot(m.date, m.time);
    if (!at) {
      state.moveError = 'Pick a date and a time.';
      state.focus = { invoice: o.invoice, role: m.date ? 'move-time' : 'move-date' };
      renderOrders();
      return;
    }
    state.working = o.invoice;
    state.moveError = null;
    renderOrders();
    try {
      var res = await SJ.api('setCollectTime', { key: state.key, invoice: o.invoice, collectAt: at });
      state.version++;
      replaceOrder(res.order);
      state.working = null;
      state.confirm = null;
      state.moveDraft = null;
      state.focus = { invoice: o.invoice, role: primaryRole(res.order) };
      renderOrders();
      var moved = o.invoice + ' moved to ' + SJ.formatWhen(res.order.collectAt);
      if (res.emailed === true) SJ.toast(moved + '. ' + res.order.name + ' was emailed the new invite.');
      else if (res.emailed === false) SJ.toast(moved + ', but the invite email did not send. Let ' + res.order.name + ' know by DM.', 'bad');
      else SJ.toast(moved + '.');
    } catch (err) {
      state.working = null;
      if (err.code === 'unauthorized') {
        lock(err.message);
        return;
      }
      if (err.code === 'not_found' || /cancelled|not a collection/.test(err.message)) {
        state.confirm = null;
        state.moveDraft = null;
        SJ.toast(err.message, 'bad');
        refresh({ quiet: true });
        return;
      }
      state.moveError = err.message;
      renderOrders();
    }
  }

  // ---------- Editing an unpaid order ----------

  function startEdit(o) {
    state.editing = o.invoice;
    state.editDraft = {
      name: o.name, email: o.email, contact: o.contact, address: o.address, notes: o.notes,
      qty: String(o.qty), collect: o.collect, price: String(o.price), fee: String(o.fee), sendInvoice: true,
      collectDate: SJ.dayOf(o.collectAt), collectTime: String(o.collectAt || '').slice(11)
    };
    state.editError = null;
    state.confirm = null;
    state.preview = null;
    state.moreOpen = null;
    state.focus = { invoice: o.invoice, role: 'edit-name' };
    renderOrders();
  }

  function stopEdit(o) {
    state.editing = null;
    state.editDraft = null;
    state.editError = null;
    state.focus = { invoice: o.invoice, role: 'edit' };
    renderOrders();
  }

  // The total as it will be saved, or null while a number does not make sense yet.
  function draftTotal(d, request) {
    var qty = Number(d.qty);
    var price = Number(String(d.price).replace(',', '.'));
    var fee = d.collect || request ? 0 : Number(String(d.fee).replace(',', '.'));
    if (!isFinite(qty) || Math.floor(qty) !== qty || qty < 1 || !isFinite(price) || price < 0 || !isFinite(fee) || fee < 0) return null;
    return SJ.totalFor(qty, price, fee);
  }

  function editForm(o) {
    var d = state.editDraft;
    var request = o.status === REQUESTED;
    var sym = state.config.currency;
    var working = state.working === o.invoice;
    var totalLine = el('p', { class: 'list-total', role: 'status' });
    var sendRow;
    var addressField;
    var feeField;
    var timeField;

    function sync() {
      var total = draftTotal(d, request);
      totalLine.textContent = total === null ? 'Check the quantity and prices.'
        : (request ? 'Total before delivery: ' : 'New total: ') + SJ.money(total, sym);
      addressField.hidden = d.collect;
      timeField.hidden = !d.collect;
      // A request's fee is set when it is accepted, and its invoice is sent then.
      feeField.hidden = d.collect || request;
      var email = d.email.trim();
      sendRow.hidden = !email || request;
      sendRow.querySelector('span').textContent = 'Email the updated invoice to ' + email;
    }

    function input(key, label, opts) {
      opts = opts || {};
      var id = 'e-' + key;
      var attrs = { id: id, 'data-role': 'edit-' + key, maxlength: String(opts.max || 80), autocomplete: 'off' };
      var node = opts.long
        ? el('textarea', Object.assign({ rows: '2' }, attrs))
        : el('input', Object.assign({ type: opts.type || 'text', inputmode: opts.mode || null }, attrs));
      node.value = d[key];
      node.addEventListener('input', function () { d[key] = node.value; sync(); });
      return el('div', { class: 'field' }, el('label', { for: id }, label), node);
    }

    var collect = el('input', { type: 'checkbox', id: 'e-collect', 'data-role': 'edit-collect' });
    collect.checked = d.collect;
    collect.addEventListener('change', function () { d.collect = collect.checked; sync(); });

    var send = el('input', { type: 'checkbox', id: 'e-send', 'data-role': 'edit-send' });
    send.checked = d.sendInvoice;
    send.addEventListener('change', function () { d.sendInvoice = send.checked; });
    sendRow = el('label', { class: 'check' }, send, el('span'));

    addressField = input('address', 'Delivery address', { long: true, max: 300 });
    feeField = input('fee', 'Delivery fee', { mode: 'decimal', max: 12 });
    timeField = el('fieldset', { class: 'field choice' },
      el('legend', null, 'Collection time'),
      collectTimeInputs('edit-collect', d.collectDate, d.collectTime, function (date, time) { d.collectDate = date; d.collectTime = time; }),
      el('p', { class: 'hint' }, 'Leave both empty to arrange a time by DM.'));

    var form = el('form', { class: 'stack confirm-row', novalidate: true, 'aria-label': 'Edit order ' + o.invoice },
      el('p', { class: 'fine' }, 'Change anything below. The invoice number stays ' + o.invoice + '.'),
      input('name', 'Customer name'),
      input('email', 'Email', { type: 'email', max: 120 }),
      input('contact', 'Instagram handle or phone'),
      input('qty', 'Quantity', { mode: 'numeric', max: 3 }),
      input('price', 'Price per sachet', { mode: 'decimal', max: 12 }),
      el('label', { class: 'check' }, collect, el('span', null, 'Customer collects (no delivery fee)')),
      timeField,
      feeField,
      addressField,
      input('notes', 'Notes', { max: 300 }),
      totalLine,
      sendRow,
      state.editError ? el('div', { class: 'alert alert-bad', role: 'alert' }, state.editError) : null,
      el('div', { class: 'order-actions' },
        el('button', { type: 'submit', class: 'btn btn-small btn-primary', 'data-role': 'edit-save', disabled: working }, working ? 'Saving…' : 'Save changes'),
        actionButton('Cancel', 'btn-quiet', 'edit-cancel', function () { stopEdit(o); }, working)));
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      saveEdit(o);
    });
    sync();
    return form;
  }

  async function saveEdit(o) {
    if (state.working) return;
    var d = state.editDraft;
    if (!d.name.trim()) {
      state.editError = 'Enter the name of the customer.';
      state.focus = { invoice: o.invoice, role: 'edit-name' };
      renderOrders();
      return;
    }
    if (d.email.trim() && !SJ.isEmail(d.email.trim())) {
      state.editError = 'Check the email address. It should look like name@example.com.';
      state.focus = { invoice: o.invoice, role: 'edit-email' };
      renderOrders();
      return;
    }
    var collectAt = d.collect ? joinSlot(d.collectDate, d.collectTime) : '';
    if (collectAt === null) {
      state.editError = 'Pick both a date and a time to collect, or leave both empty.';
      state.focus = { invoice: o.invoice, role: d.collectDate ? 'edit-collect-time' : 'edit-collect-date' };
      renderOrders();
      return;
    }
    state.working = o.invoice;
    state.editError = null;
    renderOrders();
    try {
      var email = d.email.trim();
      var res = await SJ.api('editOrder', {
        key: state.key, invoice: o.invoice,
        name: d.name.trim(), email: email, contact: d.contact.trim(),
        address: d.collect ? '' : d.address.trim(), notes: d.notes.trim(),
        qty: Number(d.qty), collect: d.collect, collectAt: collectAt, price: d.price, fee: d.collect || o.status === REQUESTED ? '0' : d.fee,
        sendInvoice: !!(email && d.sendInvoice && o.status === AWAITING)
      });
      state.version++;
      replaceOrder(res.order);
      state.working = null;
      state.editing = null;
      state.editDraft = null;
      state.focus = { invoice: o.invoice, role: 'edit' };
      renderOrders();
      var inv = res.order.invoice;
      if (res.emailed === true) SJ.toast(inv + ' updated. The new invoice was emailed to ' + res.order.email + '.');
      else if (res.emailed === false) SJ.toast(inv + ' updated, but the invoice email did not send. Try More > Email invoice later.', 'bad');
      else SJ.toast(inv + ' updated.');
    } catch (err) {
      state.working = null;
      if (err.code === 'unauthorized') {
        lock(err.message);
        return;
      }
      if (err.code === 'not_found' || /can be edited/.test(err.message)) {
        // Someone changed it on another phone: show the order as it is now.
        state.editing = null;
        state.editDraft = null;
        SJ.toast(err.message, 'bad');
        refresh({ quiet: true });
        return;
      }
      state.editError = err.message;
      renderOrders();
    }
  }

  async function emailInvoice(o) {
    if (state.working) return;
    state.working = o.invoice;
    state.preview = null;
    renderOrders();
    try {
      var res = await SJ.api('sendInvoice', { key: state.key, invoice: o.invoice });
      state.version++;
      replaceOrder(res.order);
      state.working = null;
      state.focus = { invoice: o.invoice, role: primaryRole(res.order) };
      renderOrders();
      SJ.toast('Invoice ' + o.invoice + ' emailed to ' + res.order.email + '.');
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
    $('n-choose-collect').addEventListener('click', function () { chooseNew('collect'); });
    $('n-choose-deliver').addEventListener('click', function () { chooseNew('deliver'); });
    $('n-choose-change').addEventListener('click', function () {
      var was = newChoice;
      newChoice = null;
      $('n-error').hidden = true;
      syncNewChoice();
      $(was === 'collect' ? 'n-choose-collect' : 'n-choose-deliver').focus();
    });
    $('n-collect-day').addEventListener('change', function () { fillNewTimes(''); });
    $('n-fee').addEventListener('input', function () {
      newFeeTouched = true;
      renderNewTotals();
    });
  }

  // Like the order page: Collect or Get delivered first, then the rest of the form.
  function chooseNew(what) {
    newChoice = what;
    $('n-error').hidden = true;
    syncNewChoice();
    $('n-chosen-text').focus();
  }

  function syncNewChoice() {
    var c = state.config;
    var collect = newChoice === 'collect';
    $('n-choose').hidden = !!newChoice;
    $('n-chosen').hidden = !newChoice;
    $('n-rest').hidden = !newChoice;
    $('n-choose-collect').setAttribute('aria-pressed', String(collect));
    $('n-choose-deliver').setAttribute('aria-pressed', String(newChoice === 'deliver'));
    if (c) {
      $('n-choose-collect-sub').textContent = 'Free' + (c.collectNote ? ' · ' + c.collectNote : '');
      $('n-choose-deliver-sub').textContent = c.fee > 0 ? 'Usual fee ' + SJ.money(c.fee, c.currency) : 'Free';
    }
    $('n-chosen-text').textContent = collect ? 'Collect' + (c && c.collectNote ? ' from ' + c.collectNote : '') : 'Get delivered';
    renderNewTotals();
  }

  // Greg sees every time on his collection dates, full ones marked, and can book any of them.
  function renderNewSlots() {
    var days = (state.config && state.config.collectSlotsAll) || [];
    var wantTime = $('n-collect-hour').value;
    SJ.fillSlotDays($('n-collect-day'), days, 'No time yet');
    fillNewTimes(wantTime);
  }

  function fillNewTimes(want) {
    var days = (state.config && state.config.collectSlotsAll) || [];
    SJ.fillSlotTimes($('n-collect-hour'), SJ.slotDay(days, $('n-collect-day').value), want);
  }

  function applyConfigToNew() {
    var c = state.config;
    if (!c || !newStepper) return;
    newStepper.setRange(c.minQty, c.maxQty);
    newStepper.setItem(SJ.itemLine(c));
    if (!newFeeTouched) $('n-fee').value = String(c.fee);
    renderNewSlots();
    syncNewChoice();
    var warn = $('new-warning');
    SJ.clear(warn);
    if (!c.ready) warn.appendChild(setupBanner('Add the price and your bank details in Settings before you create orders.'));
    renderNewTotals();
  }

  function renderNewTotals() {
    if (!state.config || !newStepper) return;
    var collect = newChoice === 'collect';
    $('n-address-field').hidden = collect;
    $('n-fee-field').hidden = collect;
    $('n-time-field').hidden = !collect;
    var fee = feeNumber($('n-fee').value);
    SJ.renderSummary($('n-summary'), state.config, newStepper.get(), { collect: collect, fee: fee === null ? undefined : fee });
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

    var collect = newChoice === 'collect';
    var day = $('n-collect-day').value;
    var data = {
      name: $('n-name').value.trim(),
      email: $('n-email').value.trim(),
      contact: $('n-contact').value.trim(),
      address: collect ? '' : $('n-address').value.trim(),
      notes: $('n-notes').value.trim(),
      qty: newStepper.get(),
      collect: collect,
      collectAt: collect ? joinSlot(day, $('n-collect-hour').value) : '',
      fee: collect ? '' : $('n-fee').value.trim()
    };
    if (!data.name) {
      showNewError('Enter the name of the customer.');
      $('n-name').focus();
      return;
    }
    if (data.email && !SJ.isEmail(data.email)) {
      showNewError('Check the email address. It should look like name@example.com.');
      $('n-email').focus();
      return;
    }
    if (data.collectAt === null) {
      showNewError('Pick a time to collect, or set the day back to No time yet.');
      $('n-collect-hour').focus();
      return;
    }

    var sig = JSON.stringify([data.name, data.email, data.contact, data.address, data.notes, data.qty, data.collect, data.collectAt, data.fee]);
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
      // A booked collection time is now full, so fetch the times again for the next DM order.
      if (data.collectAt) refresh({ quiet: true });
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
      el('p', { class: 'lede' }, 'Send this to ' + o.name + ' in your DM. It has the bank details and the reference to use.'),
      res.emailed === true ? el('p', { class: 'fine' }, 'The invoice PDF was also emailed to ' + o.email + '.') : null,
      res.emailed === false ? el('p', { class: 'fine' }, 'The invoice email to ' + o.email + ' did not send. You can try again from the order under More.') : null));
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
          $('n-choose-collect').focus();
        }
      }, 'New order')));

    $('new-form').hidden = true;
    result.hidden = false;
    window.scrollTo(0, 0);
    $('created-title').focus({ preventScroll: true });
  }

  function resetNewForm() {
    newPending = null;
    ['n-name', 'n-email', 'n-contact', 'n-address', 'n-notes', 'n-collect-day'].forEach(function (id) { $(id).value = ''; });
    newChoice = null;
    fillNewTimes('');
    syncNewChoice();
    newFeeTouched = false;
    if (state.config) $('n-fee').value = String(state.config.fee);
    renderNewTotals();
    if (newStepper) newStepper.reset();
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

  // Each field gets its saved value from writeSetting once the form is on the page.
  function settingField(f) {
    if (f.type === 'checkbox') {
      var boxId = 's-' + f.key;
      var box = el('input', { type: 'checkbox', id: boxId, name: f.key, 'aria-describedby': f.hint ? boxId + '-hint' : null });
      return el('div', { class: 'field span-all' },
        el('label', { class: 'check' }, box, el('span', null, f.label)),
        f.hint ? el('p', { class: 'hint', id: boxId + '-hint' }, f.hint) : null);
    }
    if (f.type === 'dates') return datesField(f);
    if (f.type === 'hours') {
      var from = el('input', { type: 'time', id: 's-' + f.key + '-from', step: '900' });
      var until = el('input', { type: 'time', id: 's-' + f.key + '-until', step: '900' });
      return el('fieldset', { class: 'field choice span-all', id: 's-' + f.key, 'aria-describedby': 's-' + f.key + '-hint' },
        el('legend', null, f.label),
        el('div', { class: 'slot-pickers' },
          el('div', { class: 'field' }, el('label', { for: from.id }, 'From'), from),
          el('div', { class: 'field' }, el('label', { for: until.id }, 'Until'), until)),
        el('p', { class: 'hint', id: 's-' + f.key + '-hint' }, f.hint));
    }
    if (f.type === 'select') {
      return el('div', { class: 'field' },
        el('label', { for: 's-' + f.key }, f.label),
        el('select', { id: 's-' + f.key, name: f.key }, f.options.map(function (o) { return el('option', { value: o[0] }, o[1]); })));
    }
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
    return el('div', { class: 'field' + (f.wide ? ' span-all' : '') },
      el('label', { for: id }, f.label),
      input,
      f.hint ? el('p', { class: 'hint', id: id + '-hint' }, f.hint) : null);
  }

  // One folded section of the Settings tab. It stays open or closed while Greg is on the page.
  function settingsGroup(id, title, about, content) {
    // Until the shop is set up, the sections with what is missing start open.
    var needed = !(state.config && state.config.ready) && (id === 'price' || id === 'bank');
    var d = el('details', { class: 'group', id: 'group-' + id, open: !!state.openGroups[id] || needed },
      el('summary', null,
        el('span', { class: 'group-title' }, title),
        el('span', { class: 'group-about' }, about)),
      el('div', { class: 'group-body stack' }, content));
    d.addEventListener('toggle', function () {
      state.openGroups[id] = d.open;
      if (id === 'photo' && d.open) loadPhotoPreview();
    });
    return d;
  }

  function renderSettings() {
    var body = $('settings-body');
    SJ.clear(body);
    var wrap = el('div', { class: 'stack' });

    wrap.appendChild(settingsGroup('link', 'Your order page', 'The link for your Instagram bio', [
      el('p', { class: 'fine' }, 'Put this link in your Instagram bio.'),
      el('div', { class: 'pay' }, orderLinkRow())]));

    wrap.appendChild(settingsGroup('photo', 'Order page photo', 'The photo above the order form', el('div', { class: 'stack', id: 'photo-section' })));

    var form = el('form', { id: 'settings-form', class: 'stack', novalidate: true });
    SETTINGS_LAYOUT.forEach(function (section) {
      var grid = el('div', { class: 'form-grid form-grid--two' });
      section.fields.forEach(function (f) { grid.appendChild(settingField(f)); });
      form.appendChild(settingsGroup(section.id, section.title, section.about, grid));
    });
    form.appendChild(el('div', { class: 'alert alert-bad', id: 'settings-error', role: 'alert', hidden: true }));
    form.appendChild(el('button', { type: 'submit', class: 'btn btn-primary btn-block', id: 'settings-save' }, 'Save settings'));
    form.addEventListener('submit', onSaveSettings);
    wrap.appendChild(form);
    body.appendChild(wrap);
    SETTING_FIELDS.forEach(writeSetting);
    renderDates();
    ['s-collection_hours-from', 's-collection_hours-until', 's-collection_slot_minutes'].forEach(function (id) {
      $(id).addEventListener('input', function () { renderDates(); });
    });
    renderPhotoSection();
    loadPhotoPreview();
  }

  // ---------- Settings: order page photo ----------

  // Photos are made smaller on the phone before they are sent: at most this many pixels on
  // the long side, as JPEG, stepping the quality down until the file is under the target size.
  var PHOTO_MAX_SIDE = 1600;
  var PHOTO_TARGET_BYTES = 350 * 1024;
  var photoBusy = false;
  var photoSrc = null; // data URL of the current photo, for the preview
  var photoSrcVersion = null; // which photo photoSrc shows
  var photoPreview = '';      // '', 'loading' or 'failed'
  var PHOTO_STORE = 'sj_photo'; // where the order page keeps the photo on this phone

  function renderPhotoSection(status) {
    var box = $('photo-section');
    if (!box) return;
    var p = state.config && state.config.photo;
    // While saving, keep what was typed rather than the saved description.
    var altValue = photoBusy && $('photo-alt') ? $('photo-alt').value : (p ? p.alt : '');
    SJ.clear(box);

    var file = el('input', { type: 'file', id: 'photo-file', accept: 'image/*', hidden: true });
    file.addEventListener('change', function () {
      var chosen = file.files && file.files[0];
      file.value = '';
      if (chosen) uploadPhoto(chosen);
    });
    var pick = el('button', {
      type: 'button', class: 'btn btn-small ' + (p ? 'btn-quiet' : 'btn-primary'), id: 'photo-pick', disabled: photoBusy
    }, p ? 'Replace photo' : 'Add photo');
    pick.addEventListener('click', function () { file.click(); });

    box.appendChild(el('p', { class: 'fine' }, p
      ? 'This photo shows at the top of your order page.'
      : 'Add a photo to show at the top of your order page. It is made smaller on this phone before it is sent.'));
    if (p) {
      // The photo's own shape keeps its space while it loads.
      box.appendChild(el('figure', { class: 'photo photo-preview', style: p.width && p.height ? 'aspect-ratio: ' + p.width + ' / ' + p.height : null },
        photoSrc ?el('img', { id: 'photo-preview', alt: p.alt || 'Your order page photo', src: photoSrc }) : previewNote()));
    }
    box.appendChild(el('div', { class: 'field' },
      el('label', { for: 'photo-alt' }, 'Describe the photo'),
      el('input', { type: 'text', id: 'photo-alt', maxlength: '150', autocomplete: 'off', 'aria-describedby': 'photo-alt-hint', value: altValue }),
      el('p', { class: 'hint', id: 'photo-alt-hint' }, 'Read out to customers who use a screen reader. For example: Gel sachets on a trail run.')));
    box.appendChild(el('p', { class: 'fine', id: 'photo-status', role: 'status' }, status || ''));
    box.appendChild(el('div', { class: 'order-actions' },
      pick,
      p ? actionButton('Save description', 'btn-quiet', 'photo-alt-save', saveAlt, photoBusy) : null,
      p ? actionButton('Remove photo', 'btn-danger', 'photo-remove', removePhoto, photoBusy) : null,
      file));
  }

  // Shown in the photo's place until it has loaded, or when it could not be loaded.
  function previewNote() {
    if (photoPreview === 'failed') {
      return el('div', { class: 'photo-note' },
        el('p', null, 'The preview could not load.'),
        el('button', { type: 'button', class: 'btn btn-quiet btn-small', 'data-role': 'photo-retry', onclick: loadPhotoPreview }, 'Try again'));
    }
    return el('div', { class: 'photo-note' }, el('p', { role: 'status' }, 'Loading the preview…'));
  }

  async function loadPhotoPreview() {
    var p = state.config && state.config.photo;
    if (!p || photoPreview === 'loading' || (photoSrc && photoSrcVersion === p.version)) return;
    // The order page keeps the photo on this phone. Use it when it is the same one.
    var saved = SJ.store.get(PHOTO_STORE);
    var picture = saved && saved.version === p.version && saved.data ? saved : null;
    if (!picture) {
      photoPreview = 'loading';
      if (!photoBusy) renderPhotoSection();
      try {
        var res = await SJ.api('photo');
        picture = res.photo && res.photo.data ? res.photo : null;
      } catch (err) {
        picture = null;
      }
      if (picture) SJ.store.set(PHOTO_STORE, picture);
    }
    photoPreview = picture ? '' : 'failed';
    if (picture) {
      photoSrc = 'data:' + picture.type + ';base64,' + picture.data;
      photoSrcVersion = picture.version;
    }
    if (!photoBusy) renderPhotoSection();
  }

  function readImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
      img.src = url;
    });
  }

  // Returns { type, data (base64), dataUrl, width, height }.
  async function shrinkPhoto(file) {
    var img;
    try {
      img = await readImage(file);
    } catch (err) {
      throw new SJ.ApiError('photo', 'This photo could not be opened here. Try a JPEG or PNG photo.');
    }
    var scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    var width = Math.max(1, Math.round(img.naturalWidth * scale));
    var height = Math.max(1, Math.round(img.naturalHeight * scale));
    var canvas = document.createElement('canvas');
    for (var attempt = 0; attempt < 6; attempt++) {
      canvas.width = width;
      canvas.height = height;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; // JPEG has no transparency
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      var qualities = [0.85, 0.75, 0.65];
      for (var i = 0; i < qualities.length; i++) {
        var dataUrl = canvas.toDataURL('image/jpeg', qualities[i]);
        var data = dataUrl.slice(dataUrl.indexOf(',') + 1);
        if (data.length * 3 / 4 <= PHOTO_TARGET_BYTES) {
          return { type: 'image/jpeg', data: data, dataUrl: dataUrl, width: width, height: height };
        }
      }
      width = Math.max(1, Math.round(width * 0.8));
      height = Math.max(1, Math.round(height * 0.8));
    }
    throw new SJ.ApiError('photo', 'This photo is too detailed to send. Please choose another one.');
  }

  function photoFailed(err) {
    photoBusy = false;
    if (err.code === 'unauthorized') {
      lock(err.message);
      return;
    }
    renderPhotoSection(err.message);
    SJ.toast('The photo was not changed.', 'bad');
  }

  async function uploadPhoto(file) {
    if (photoBusy) return;
    photoBusy = true;
    var alt = $('photo-alt') ? $('photo-alt').value.trim() : '';
    renderPhotoSection('Preparing the photo…');
    try {
      var prepared = await shrinkPhoto(file);
      renderPhotoSection('Sending the photo…');
      var res = await SJ.api('setPhoto', {
        key: state.key, type: prepared.type, data: prepared.data, width: prepared.width, height: prepared.height, alt: alt
      });
      photoBusy = false;
      state.config.photo = res.photo;
      photoSrc = prepared.dataUrl;
      photoSrcVersion = res.photo.version;
      photoPreview = '';
      renderPhotoSection();
      SJ.toast('Photo saved. It now shows on your order page.');
    } catch (err) {
      photoFailed(err);
    }
  }

  async function saveAlt() {
    if (photoBusy) return;
    photoBusy = true;
    var alt = $('photo-alt').value.trim();
    renderPhotoSection('Saving…');
    try {
      var res = await SJ.api('setPhoto', { key: state.key, alt: alt });
      photoBusy = false;
      state.config.photo = res.photo;
      renderPhotoSection();
      SJ.toast('Photo description saved.');
    } catch (err) {
      photoFailed(err);
    }
  }

  async function removePhoto() {
    if (photoBusy) return;
    photoBusy = true;
    renderPhotoSection('Removing…');
    try {
      await SJ.api('removePhoto', { key: state.key });
      photoBusy = false;
      state.config.photo = null;
      photoSrc = null;
      photoSrcVersion = null;
      renderPhotoSection();
      SJ.toast('Photo removed from your order page.');
    } catch (err) {
      photoFailed(err);
    }
  }

  // ---------- Settings: collection dates and times ----------

  function toMinutes(t) {
    var m = /^(\d{2}):(\d{2})/.exec(t || '');
    return m ? +m[1] * 60 + +m[2] : null;
  }

  function clockText(min) {
    return (min < 600 ? '0' : '') + Math.floor(min / 60) + ':' + (min % 60 < 10 ? '0' : '') + (min % 60);
  }

  function slotStep() {
    return Number($('s-collection_slot_minutes').value) || 30;
  }

  // The usual From and To on the form, or null while one of them is empty.
  function usualRange() {
    var from = $('s-collection_hours-from').value.slice(0, 5);
    var to = $('s-collection_hours-until').value.slice(0, 5);
    return from && to ? { from: from, to: to } : null;
  }

  // A date's From-To times. In the draft, null means the usual times and a missing date has none.
  function draftRanges(date) {
    var own = datesDraft[date];
    if (own === undefined) return [];
    if (own === null) {
      var usual = usualRange();
      return usual ? [usual] : [];
    }
    return own;
  }

  // The times customers can pick: each From-To split by the length, ending by To. The same rule as the server.
  function rangeTimes(ranges) {
    var step = slotStep();
    var out = [];
    ranges.forEach(function (r) {
      var start = toMinutes(r.from);
      var end = toMinutes(r.to);
      if (start === null || end === null) return;
      for (var m = start; m + step <= end; m += step) if (out.indexOf(clockText(m)) === -1) out.push(clockText(m));
    });
    return out.sort();
  }

  function rangesText(ranges) {
    return ranges.filter(function (r) { return r.from && r.to; })
      .map(function (r) { return r.from + ' to ' + r.to; }).join(', ');
  }

  function dateCellLabel(d, ranges) {
    return d.label + ', ' + (rangeTimes(ranges).length ? rangesText(ranges) : 'no times');
  }

  // The fieldset is built once. renderDates fills it, and again whenever the times change.
  function datesField(f) {
    return el('fieldset', { class: 'field choice span-all', id: 's-' + f.key, 'aria-describedby': 's-' + f.key + '-hint' },
      el('legend', null, f.label),
      el('p', { class: 'hint', id: 's-' + f.key + '-hint' }, f.hint),
      el('div', { class: 'stack', id: 'dates-body' }));
  }

  // The next 30 dates as a calendar, Monday first, with the times of the tapped date below it.
  // focus: what to focus afterwards ({ date } or { id }), so redrawing keeps Greg's place.
  function renderDates(focus) {
    var body = $('dates-body');
    if (!body) return;
    var days = (state.config && state.config.collectWindow) || [];
    SJ.clear(body);

    var cal = el('div', { class: 'cal' });
    WEEK_HEAD.forEach(function (n) { cal.appendChild(el('span', { class: 'cal-head', 'aria-hidden': 'true' }, n)); });
    var lead = days.length ? (days[0].weekday + 6) % 7 : 0;
    for (var i = 0; i < lead; i++) cal.appendChild(el('span', { class: 'cal-blank', 'aria-hidden': 'true' }));
    days.forEach(function (d, i) {
      var num = Number(d.date.slice(8));
      var ranges = draftRanges(d.date);
      var btn = el('button', {
        type: 'button', class: 'cal-day' + (rangeTimes(ranges).length ? ' cal-day--on' : ''), 'data-date': d.date,
        'aria-pressed': String(datesEditing === d.date), 'aria-label': dateCellLabel(d, ranges)
      }, el('span', { class: 'cal-box', 'aria-hidden': 'true' },
        el('span', { class: 'cal-month' }, i === 0 || num === 1 ? d.label.slice(-3) : ''),
        el('span', { class: 'cal-num' }, String(num))));
      btn.addEventListener('click', function () {
        datesEditing = d.date;
        renderDates({ date: d.date });
      });
      cal.appendChild(btn);
    });
    body.appendChild(cal);

    body.appendChild(el('div', { class: 'cal-tools' },
      el('button', {
        type: 'button', class: 'btn btn-quiet btn-small', onclick: function () {
          days.forEach(function (d) { datesDraft[d.date] = null; });
          renderDates();
        }
      }, 'Every date, usual times'),
      el('button', {
        type: 'button', class: 'btn btn-quiet btn-small', onclick: function () {
          datesDraft = {};
          renderDates();
        }
      }, 'Clear all')));

    var day = days.filter(function (d) { return d.date === datesEditing; })[0];
    if (day) body.appendChild(timesEditor(day, days));
    else body.appendChild(el('p', { class: 'hint' }, 'Tap a date to set its times.'));

    var target = focus && (focus.date ? body.querySelector('[data-date="' + focus.date + '"]') : $(focus.id));
    if (target) target.focus();
  }

  // The From-To rows of one date. Typing only updates the date's square and the times line,
  // so the cursor stays where it is. Adding or removing a row redraws.
  function timesEditor(day, days) {
    var ranges = draftRanges(day.date);
    var usual = datesDraft[day.date] === null;
    var box = el('div', { class: 'times-editor stack', id: 'times-editor' });
    box.appendChild(el('p', { class: 'label', id: 'times-title', tabindex: '-1' }, 'Times on ' + day.label));
    if (usual) box.appendChild(el('p', { class: 'hint' }, 'Your usual times. Change them here for this date only.'));

    var preview = el('p', { class: 'hint', id: 'times-preview', 'aria-live': 'polite' });
    function rowsNow() {
      return Array.prototype.map.call(box.querySelectorAll('.range-row'), function (row) {
        return { from: row.querySelector('.range-from').value.slice(0, 5), to: row.querySelector('.range-to').value.slice(0, 5) };
      });
    }
    function update() {
      var list = rangeTimes(rowsNow());
      preview.textContent = list.length ? 'Customers can pick ' + list.join(', ') + '.' : 'No times customers can pick on this date.';
      var cell = document.querySelector('.cal-day[data-date="' + day.date + '"]');
      if (cell) {
        cell.classList.toggle('cal-day--on', list.length > 0);
        cell.setAttribute('aria-label', dateCellLabel(day, rowsNow()));
      }
    }

    var step = String(slotStep() * 60);
    ranges.forEach(function (r, i) {
      var from = el('input', { type: 'time', class: 'range-from', id: 'range-from-' + i, step: step });
      var to = el('input', { type: 'time', class: 'range-to', id: 'range-to-' + i, step: step });
      from.value = r.from || '';
      to.value = r.to || '';
      [from, to].forEach(function (input) {
        input.addEventListener('input', function () {
          datesDraft[day.date] = rowsNow();
          update();
        });
      });
      box.appendChild(el('div', { class: 'range-row' },
        el('div', { class: 'slot-pickers' },
          el('div', { class: 'field' }, el('label', { for: from.id }, 'From'), from),
          el('div', { class: 'field' }, el('label', { for: to.id }, 'To'), to)),
        el('button', {
          type: 'button', class: 'btn btn-quiet btn-small', 'data-role': 'range-remove',
          'aria-label': 'Remove ' + (r.from && r.to ? r.from + ' to ' + r.to : 'this time'),
          onclick: function () {
            datesDraft[day.date] = rowsNow().filter(function (x, j) { return j !== i; });
            renderDates({ id: 'range-add' });
          }
        }, 'Remove')));
    });
    box.appendChild(preview);

    box.appendChild(el('div', { class: 'cal-tools' },
      el('button', {
        type: 'button', class: 'btn btn-quiet btn-small', id: 'range-add', onclick: function () {
          var rows = rowsNow();
          var last = rows[rows.length - 1];
          // The next time starts where the last one ends, an hour long. Otherwise the usual times.
          var start = last ? toMinutes(last.to) : null;
          var next = start !== null && start + 60 < 24 * 60 ? { from: clockText(start), to: clockText(start + 60) } : (usualRange() || { from: '', to: '' });
          datesDraft[day.date] = rows.concat([next]);
          renderDates({ id: 'range-from-' + rows.length });
        }
      }, '+ Add ' + (ranges.length ? 'another time' : 'a time')),
      ranges.length ? el('button', {
        type: 'button', class: 'btn btn-quiet btn-small', onclick: function () {
          var rows = rowsNow();
          days.forEach(function (d) {
            if (d.date !== day.date && rangeTimes(draftRanges(d.date)).length) datesDraft[d.date] = rows.map(function (r) { return { from: r.from, to: r.to }; });
          });
          renderDates({ id: 'times-title' });
          SJ.toast('These times are now set on every date that has times.');
        }
      }, 'Use on all dates with times') : null));
    update();
    return box;
  }

  // "2026-11-03 07:00-08:00 17:00-19:00,2026-11-04" -> datesDraft. A date on its own means the usual times.
  // A single time from an earlier version becomes one collection time long.
  function readDatesDraft(value) {
    datesDraft = {};
    String(value || '').split(',').forEach(function (entry) {
      var parts = entry.trim().split(/\s+/).filter(String);
      if (!parts.length) return;
      datesDraft[parts[0]] = parts.length > 1 ? parts.slice(1).map(function (token) {
        var pair = token.split('-');
        if (pair.length === 2) return { from: pair[0], to: pair[1] };
        var start = toMinutes(token);
        return { from: token, to: start === null ? '' : clockText(Math.min(start + slotStep(), 23 * 60 + 59)) };
      }) : null;
    });
    var days = (state.config && state.config.collectWindow) || [];
    var stillShown = days.some(function (d) { return d.date === datesEditing; });
    if (!stillShown) {
      var first = days.filter(function (d) { return datesDraft[d.date] !== undefined; })[0] || days[0];
      datesEditing = first ? first.date : null;
    }
  }

  function readSetting(f) {
    var node = $('s-' + f.key);
    if (f.type === 'checkbox') return node.checked ? 'yes' : 'no';
    if (f.type === 'dates') {
      // Dates on the usual times are saved on their own, so they follow later changes to the usual times.
      var days = (state.config && state.config.collectWindow) || [];
      return days.map(function (d) {
        var own = datesDraft[d.date];
        if (own === undefined) return '';
        if (own === null) return d.date;
        var ranges = own.filter(function (r) { return r.from && r.to; });
        return ranges.length ? d.date + ' ' + ranges.map(function (r) { return r.from + '-' + r.to; }).join(' ') : '';
      }).filter(String).join(',');
    }
    if (f.type === 'hours') return $('s-' + f.key + '-from').value + '-' + $('s-' + f.key + '-until').value;
    return node.value;
  }

  function writeSetting(f) {
    var value = String(state.settings[f.key] || '');
    var node = $('s-' + f.key);
    if (f.type === 'checkbox') {
      node.checked = value.toLowerCase() !== 'no';
    } else if (f.type === 'dates') {
      readDatesDraft(value);
    } else if (f.type === 'hours') {
      var parts = value.split('-');
      $('s-' + f.key + '-from').value = parts[0] || '';
      $('s-' + f.key + '-until').value = parts[1] || '';
    } else {
      node.value = value;
    }
  }

  async function onSaveSettings(ev) {
    ev.preventDefault();
    if (savingSettings) return;
    var box = $('settings-error');
    var btn = $('settings-save');
    box.hidden = true;

    var values = {};
    SETTING_FIELDS.forEach(function (f) { values[f.key] = readSetting(f); });

    savingSettings = true;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      var wasReady = !!(state.config && state.config.ready);
      var res = await SJ.api('saveSettings', { key: state.key, values: values });
      state.version++;
      state.settings = res.values || {};
      state.config = res.config;
      SETTING_FIELDS.forEach(writeSetting);
      renderDates();
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
