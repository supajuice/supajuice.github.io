/* The public order page. */
(function () {
  'use strict';

  var SJ = window.SJ;
  var el = SJ.el;
  var $ = function (id) { return document.getElementById(id); };

  var VIEWS = ['view-loading', 'order-form', 'view-done', 'view-closed'];
  var CONFIG_KEY = 'sj_config';
  var LAST_KEY = 'sj_last_order';
  var LAST_MAX_AGE = 48 * 3600 * 1000;
  var PHOTO_KEY = 'sj_photo';

  var config = null;     // prices and settings, without bank details
  var stepper = null;    // the flavour picker: how many of each flavour. The quantity is their total.
  var pending = null;    // { sig, id }: a retry of the same order reuses one request id
  var busy = false;
  var current = null;    // the order response being shown on the done view
  var photo = null;      // { version, alt, width, height } from the config, or null
  var choice = null;     // 'collect', 'deliver' (to the door) or 'locker', null until the customer picks one
  var paying = false;    // waiting for Paystack's payment page
  var discount = null;   // the applied discount code: { code, percent, delivery }, or null
  var checkingCode = false;
  // How long door delivery usually takes, from paying to the door. Always shown as a range.
  var DOOR_DAYS = '3 to 5 working days';
  // The Courier Guy's price for the door address typed in, when the shop prices doors live.
  // status: 'idle' (address not complete), 'loading', 'ok' (data is { fee, service }) or
  // 'error' (it could not be priced: the order is sent and Greg emails the fee).
  var ship = { key: '', status: 'idle', data: null, message: '' };
  var shipTimer = null;
  var shipAsk = null;    // the price being asked for: a promise, so placing the order can wait for it
  var shipAskKey = '';   // which address and number of gels it is for
  var shipSeen = {};     // prices already asked for, by address and number of gels

  // ---------- Discount from an ad link ----------
  // An ad links to the page with ?code=... on the end, for example ?code=FBVK5WRNRG.
  // The code is applied by itself and never shown: the code box stays hidden and the
  // address bar is tidied, so only people who tap the ad get the offer. The order still
  // saves the code, so the Orders sheet shows which orders came from the ad.
  var LINK_CODE_KEY = 'sj_link_code';
  var linkCode = (function () {
    var typed = '';
    try { typed = new URLSearchParams(location.search).get('code') || ''; } catch (err) { /* old browser */ }
    typed = typed.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
    try {
      if (typed) sessionStorage.setItem(LINK_CODE_KEY, typed);
      else typed = sessionStorage.getItem(LINK_CODE_KEY) || '';
    } catch (err) { /* private browsing */ }
    if (/[?&]code=/.test(location.search)) {
      var q = new URLSearchParams(location.search);
      q.delete('code');
      var rest = q.toString();
      try { history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash); } catch (err) { /* old browser */ }
    }
    return typed;
  })();
  var linkTried = false;

  // True when the applied discount came from the ad link.
  function viaLink() {
    return !!(discount && linkCode && discount.code === linkCode);
  }

  // The blue strip at the top: says the ad offer is on, while it is.
  function syncLinkPromo() {
    var strip = $('link-promo');
    if (!strip) return;
    strip.hidden = !viaLink();
    if (strip.hidden) return;
    SJ.clear(strip);
    strip.appendChild(el('strong', { class: 'promo-code' },
      discount.delivery ? 'Free delivery' : discount.percent + '% off'));
    strip.appendChild(el('span', null, 'applied. Order below'));
    var other = document.querySelector('.promo:not(#link-promo)');
    if (other) other.hidden = true;
  }

  // Applies the ad link's code once the prices have loaded.
  async function applyLinkCode() {
    if (!linkCode || linkTried || discount || !config) return;
    linkTried = true;
    $('code').value = linkCode;
    if (await applyCode()) return;
    var msg = $('code-msg').textContent;
    $('code').value = '';
    if (/^Could not check/.test(msg)) {
      linkTried = false; // a network hiccup: try again when the page next loads prices
      syncCode('');
      return;
    }
    // The offer has been switched off. Order at the normal price, without a code.
    try { sessionStorage.removeItem(LINK_CODE_KEY); } catch (err) { /* private browsing */ }
    syncCode('');
    showError('That ad offer has ended, sorry. You can still order below at the normal price.');
  }

  function showView(id) {
    VIEWS.forEach(function (v) { $(v).hidden = v !== id; });
    // "Order below..." and the photo only make sense above the form.
    $('lede').hidden = id !== 'order-form' || step !== 'bag';
    $('photo').hidden = !photo || id !== 'order-form' || step !== 'bag';
    // After ordering (or while a card payment is checked) the invoice takes over the page.
    document.body.classList.toggle('shop--done', id === 'view-done' || (id === 'view-loading' && !!returnedReference()));
  }

  // ---------- Photo ----------

  // The photo is optional: if anything goes wrong it is simply left out.
  // Each version is downloaded once and then kept on the phone.
  async function applyPhoto(want) {
    var box = $('photo');
    var img = $('photo-img');
    if (!want) {
      photo = null;
      box.hidden = true;
      img.removeAttribute('src');
      SJ.store.remove(PHOTO_KEY);
      return;
    }
    var sameVersion = photo && photo.version === want.version;
    photo = want;
    img.alt = want.alt || '';
    // Keep the photo's space free while it loads, so the form does not jump.
    box.style.aspectRatio = want.width && want.height ? want.width + ' / ' + want.height : '';
    box.hidden = $('order-form').hidden;
    if (sameVersion && img.getAttribute('src')) return;

    var saved = SJ.store.get(PHOTO_KEY);
    var picture = saved && saved.version === want.version && saved.data ? saved : null;
    if (!picture) {
      try {
        var res = await SJ.api('photo');
        picture = res.photo;
      } catch (err) {
        picture = null;
      }
      if (!picture || !photo || picture.version !== photo.version) {
        if (!picture) { photo = null; box.hidden = true; }
        return;
      }
      SJ.store.set(PHOTO_KEY, picture);
    }
    img.src = 'data:' + picture.type + ';base64,' + picture.data;
  }

  // ---------- Form ----------

  // ---------- Steps (trial page): the bag, then a checkout in parts ----------
  //
  // 1. The bag: choose the gels, see the total, tap Checkout (the landing looks like the live page).
  // 2. Checkout, one part at a time, like big online shops:
  //      Delivery      how to get it and what that needs (collection time, or the address)
  //      Your details  name, email, phone, notes, discount code
  //      Payment       one Pay button, straight to the secure payment page
  //    Parts not reached yet are blurred and can't be used. A finished part folds into one line
  //    with Change. The bag sits on the right (on a phone, a "Show order summary" bar at the top).
  //    The order number is shown only once paid.

  // Two pages: this landing page (the bag) and checkout/ (its own address, like big online shops).
  // The bag travels between them in this browser tab only (sessionStorage): just the gel counts.
  var ON_CHECKOUT = document.body.getAttribute('data-page') === 'checkout';
  var BAG_KEY = 'sj_trial_bag';
  var bagApplied = false;

  function saveBag() {
    try { sessionStorage.setItem(BAG_KEY, JSON.stringify({ flavours: stepper.get() })); } catch (err) { /* private browsing */ }
  }
  function readBag() {
    try { return JSON.parse(sessionStorage.getItem(BAG_KEY) || 'null'); } catch (err) { return null; }
  }
  function clearBag() {
    try {
      sessionStorage.removeItem(BAG_KEY);
      sessionStorage.removeItem(FORM_KEY);
    } catch (err) { /* private browsing */ }
  }

  // What was typed at checkout, kept for this browser tab only, so going back to the bag (Edit, or
  // the Back button) and returning loses nothing. Cleared once the order is placed.
  var FORM_KEY = BAG_KEY + '_form';
  var FORM_FIELDS = ['name', 'email', 'contact', 'notes', 'address', 'door-street', 'door-unit', 'door-suburb', 'door-city', 'door-code', 'door-province'];

  function saveForm() {
    if (!ON_CHECKOUT) return;
    var f = { choice: choice, day: $('collect-day').value, hour: $('collect-hour').value, kind: doorKind(), fields: {} };
    FORM_FIELDS.forEach(function (id) { f.fields[id] = $(id).value; });
    try { sessionStorage.setItem(FORM_KEY, JSON.stringify(f)); } catch (err) { /* private browsing */ }
  }

  function restoreForm() {
    var f = null;
    try { f = JSON.parse(sessionStorage.getItem(FORM_KEY) || 'null'); } catch (err) { f = null; }
    if (!f || typeof f !== 'object') return;
    FORM_FIELDS.forEach(function (id) {
      if (f.fields && typeof f.fields[id] === 'string' && !$(id).value) $(id).value = f.fields[id];
    });
    if (f.kind && $('door-kind-' + f.kind)) {
      $('door-kind-' + f.kind).checked = true;
      syncDoorKind();
    }
    if (f.choice === 'collect' || f.choice === 'deliver' || f.choice === 'locker') {
      choice = f.choice;
      syncFulfil();
    }
    // The collection time, if it is still free.
    if (f.day && Array.prototype.some.call($('collect-day').options, function (o) { return o.value === f.day; })) {
      $('collect-day').value = f.day;
      fillTimes(f.hour || '');
    }
    renderTotals();
    if (courierOn()) askShip(true);
  }
  // The trial's test settings (?window=30, ?late=refund) travel with the customer between pages.
  function trialQuery() {
    var q = new URLSearchParams(location.search);
    var keep = new URLSearchParams();
    ['window', 'late'].forEach(function (k) { if (q.get(k)) keep.set(k, q.get(k)); });
    var t = keep.toString();
    return t ? '?' + t : '';
  }
  function toLanding() {
    location.href = (ON_CHECKOUT ? '../' : '') + trialQuery() + '#order';
  }

  // The landing shows the bag again (after Back or Edit). Checkout takes its gels from it, and sends
  // anyone without a bag back to choose some.
  function applyBag() {
    if (bagApplied || !stepper) return;
    var bag = readBag();
    if (!ON_CHECKOUT) {
      if (bag && bag.flavours) stepper.set(bag.flavours);
      bagApplied = true;
      return;
    }
    if (!bag || !bag.flavours) {
      if (!SJ.store.get(LAST_KEY)) location.replace('../#order'); // else init shows the order just placed
      return;
    }
    stepper.set(bag.flavours);
    if (stepper.total() < stepper.min() || stepper.total() > stepper.max()) { location.replace('../#order'); return; }
    bagApplied = true;
    showStep('checkout', false);
    restoreForm();
  }

  var step = 'bag';           // 'bag' or 'checkout'
  var part = 'delivery';      // the open part of checkout: 'delivery', 'details' or 'pay'
  var partDone = { delivery: false, details: false };
  var PARTS = ['delivery', 'details', 'pay'];

  function bagTotal() {
    return SJ.totalFor(stepper.total(), config.price, 0, 0);
  }

  function renderBag() {
    if (!config || !stepper) return;
    var qty = stepper.total();
    var sym = config.currency;
    var min = stepper.min();
    var max = stepper.max();
    var lines = SJ.clear($('bag-lines'));
    var picked = stepper.get();
    stepper.list.forEach(function (f) {
      var n = picked[f.key] || 0;
      if (!n) return;
      lines.appendChild(el('li', { class: 'bag-line' },
        el('span', { class: 'bag-line-dot bag-line-dot--' + f.key, 'aria-hidden': 'true' }),
        el('span', { class: 'bag-line-name' }, n + ' × ' + f.name),
        el('span', { class: 'bag-line-price' }, SJ.money(SJ.totalFor(n, config.price, 0, 0), sym))));
    });
    if (!qty) lines.appendChild(el('li', { class: 'bag-line bag-line--empty' }, 'Your bag is empty. Choose your gels.'));

    $('bag-total').textContent = qty === 0 ? 'Your bag is empty'
      : qty + (qty === 1 ? ' gel' : ' gels') + ' · ' + SJ.money(bagTotal(), sym);
    var btn = $('to-checkout');
    btn.disabled = qty < min || qty > max;
    btn.textContent = qty === 0 ? 'Choose your gels'
      : qty < min ? 'Add ' + (min - qty) + ' more (at least ' + min + ')'
      : qty > max ? 'At most ' + max + ' gels per order'
      : 'Checkout';
    $('bag-panel-title').textContent = qty ? 'Your bag (' + qty + ')' : 'Your bag';
  }

  function showStep(next, focus) {
    step = next;
    var checkout = next === 'checkout';
    $('bag-step').hidden = checkout;
    $('checkout-step').hidden = !checkout;
    $('lede').hidden = checkout;
    $('photo').hidden = !photo || checkout;
    $('order-form').classList.toggle('in-checkout', checkout);
    $('bag-edit').hidden = !checkout;
    openSummary(false);
    if (checkout) {
      // Start at the first part that isn't finished.
      part = !partDone.delivery ? 'delivery' : !partDone.details ? 'details' : 'pay';
      renderParts();
    }
    renderBag();
    renderTotals();
    if (focus === false) return;
    $('order').scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (checkout) $('step-' + part + '-title').focus({ preventScroll: true });
  }

  // On a phone, the order summary at checkout folds into one bar.
  function openSummary(open) {
    $('bag-panel').classList.toggle('bagpanel--open', open);
    $('bag-toggle').setAttribute('aria-expanded', String(open));
    $('bag-toggle-text').textContent = open ? 'Hide order summary' : 'Show order summary';
  }

  // Each part: open (being filled in), done (folded, with Change) or locked (blurred, not reached).
  function renderParts() {
    PARTS.forEach(function (k) {
      var state = k === part ? 'open' : (k !== 'pay' && partDone[k]) ? 'done' : 'locked';
      var box = $('step-' + k);
      var body = $('step-' + k + '-body');
      box.setAttribute('data-state', state);
      box.querySelector('.cstep-num').textContent = state === 'done' ? '✓' : String(PARTS.indexOf(k) + 1);
      body.hidden = state === 'done';
      if (state === 'locked') body.setAttribute('inert', '');
      else body.removeAttribute('inert');
      $('step-' + k + '-done').hidden = state !== 'done';
      $('step-' + k + '-change').hidden = state !== 'done';
      if (state === 'done') $('step-' + k + '-done').textContent = partSummary(k);
    });
  }

  function partSummary(k) {
    var d = readForm();
    var sym = config.currency;
    if (k === 'details') return [d.name, d.email, d.contact].filter(Boolean).join(' · ');
    if (d.collect) {
      var place = config.collectNote ? ' from ' + config.collectNote : '';
      return 'Free collection' + place + (d.collectAt ? ', ' + SJ.formatWhen(d.collectAt) : '');
    }
    if (courierOn()) {
      var fee = shipFee();
      return 'To your door: ' + doorLine(d.door) + (fee === null ? '' : ' · ' + SJ.money(fee, sym));
    }
    if (choice === 'locker') return 'Pudo locker nearest ' + d.address;
    return 'To your door: ' + d.address;
  }

  function partError(k, message) {
    var box = $('step-' + k + '-error');
    box.textContent = message || '';
    box.hidden = !message;
  }

  // What the delivery part still needs: { id, message }, or null.
  function deliveryProblem(d) {
    if (!choice) return { id: 'choose-collect', message: 'Choose how you would like your order: collect, to your door or to a Pudo locker.' };
    if (d.collect && slotsOn()) {
      if (!config.collectSlots.length) return { id: 'choose-change', message: 'No collection times are free right now. Choose delivery, or send us a DM.' };
      if (!$('collect-day').value) return { id: 'collect-day', message: 'Pick a day to collect.' };
      if (!d.collectAt) return { id: 'collect-hour', message: 'Pick a time to collect.' };
    }
    if (pudoOn() && pudoFee() === null) return { id: 'choose-change', message: 'For more than ' + pudoMax() + ' sachets, please send us a DM and we will arrange delivery.' };
    if (d.collect) return null;
    if (d.door) return doorProblem(d.door);
    if (d.ship === 'locker') return d.address ? null : { id: 'address', message: 'Enter your address so we can pick the Pudo locker nearest to you.' };
    return d.address ? null : { id: 'address', message: 'Enter your delivery address.' };
  }

  // What the details part still needs: { id, message }, or null.
  function detailsProblem(d) {
    if (!d.name) return { id: 'name', message: 'Enter your name.' };
    if (!d.email) return { id: 'email', message: 'Enter your email address so we can send your invoice.' };
    if (!SJ.isEmail(d.email)) return { id: 'email', message: 'Check your email address. It should look like name@example.com.' };
    if (!d.contact) return { id: 'contact', message: 'Enter your phone number.' };
    if (!isPhone(d.contact)) return { id: 'contact', message: 'Check your phone number. It should look like 082 123 4567.' };
    return null;
  }

  // Which part a field is in, for errors found when paying.
  function partOf(id) {
    if (/^(name|email|contact|notes|code)$/.test(id)) return 'details';
    return 'delivery';
  }

  function openPart(k, focusId) {
    part = k;
    PARTS.forEach(function (x) { if (x !== 'pay') partError(x, ''); });
    renderParts();
    renderTotals();
    var box = $('step-' + k);
    box.scrollIntoView({ block: 'start', behavior: 'smooth' });
    var target = focusId && $(focusId) ? $(focusId) : $('step-' + k + '-title');
    target.focus({ preventScroll: true });
  }

  async function finishDelivery() {
    var d = readForm();
    var problem = deliveryProblem(d);
    if (!problem && courierOn() && !freeDeliveryCode() && ship.status !== 'ok' && ship.status !== 'error') {
      // The door price comes from The Courier Guy: wait for it, so the next parts show the real total.
      $('step-delivery-next').disabled = true;
      $('step-delivery-next').textContent = 'Getting your delivery price…';
      askShip(true);
      try { if (shipAsk) await shipAsk; } catch (err) { /* shown on the delivery card */ }
      $('step-delivery-next').disabled = false;
      $('step-delivery-next').textContent = 'Continue';
      if (ship.status !== 'ok' && ship.status !== 'error') problem = { id: 'door-street', message: 'Check your address so we can work out the delivery price.' };
    }
    if (problem) {
      partError('delivery', problem.message);
      if ($(problem.id)) $(problem.id).focus();
      return;
    }
    partError('delivery', '');
    partDone.delivery = true;
    openPart(partDone.details ? 'pay' : 'details');
  }

  async function finishDetails() {
    // A code typed but not applied is checked first, so it is never silently left out.
    var typedCode = $('code').value.trim();
    if (!$('code-field').hidden && typedCode && !(discount && discount.code === typedCode.toUpperCase())) {
      if (!(await applyCode())) {
        partError('details', 'Check your discount code, or clear it to carry on without one.');
        $('code').focus();
        return;
      }
    }
    var problem = detailsProblem(readForm());
    if (problem) {
      partError('details', problem.message);
      $(problem.id).focus();
      return;
    }
    partError('details', '');
    partDone.details = true;
    openPart(partDone.delivery ? 'pay' : 'delivery');
  }

  // Changing an earlier part: it opens, and payment waits until it is finished again.
  function changePart(k) {
    partDone[k] = false;
    hideError();
    openPart(k);
  }

  function buildForm() {
    stepper = SJ.flavourPicker({ id: 'qty', list: SJ.flavoursFor(config), legend: 'Choose your flavours' });
    $('qty-slot').appendChild(stepper.node);
    stepper.onChange(function () {
      renderBag();
      renderTotals();
      if (courierOn()) askShip(true);
    });
    $('to-checkout').addEventListener('click', function () {
      if (stepper.total() < stepper.min() || stepper.total() > stepper.max()) return;
      saveBag();
      location.href = 'checkout/' + trialQuery();
    });
    $('bag-edit').addEventListener('click', function () {
      saveBag();
      toLanding();
    });
    // Checkout remembers what is typed (see saveForm).
    $('checkout-step').addEventListener('input', saveForm);
    $('checkout-step').addEventListener('change', saveForm);
    $('checkout-step').addEventListener('click', function (ev) {
      if (ev.target.closest && ev.target.closest('.choose-btn, #choose-change')) setTimeout(saveForm, 0);
    });
    $('bag-toggle').addEventListener('click', function () {
      openSummary(!$('bag-panel').classList.contains('bagpanel--open'));
    });
    $('step-delivery-next').addEventListener('click', function () { finishDelivery(); });
    // The payment note says how long the window is.
    var payNote = document.querySelector('#pay-with .paywith-note');
    if (payNote) {
      payNote.textContent = "Tap Pay to open Paystack's secure payment. You have " +
        (PAY_WINDOW_SECONDS >= 60 ? Math.round(PAY_WINDOW_SECONDS / 60) + ' minutes' : PAY_WINDOW_SECONDS + ' seconds') + ' to complete it.';
    }
    $('late-same').addEventListener('click', function () { latePayment(false); });
    $('late-changed').addEventListener('click', function () { latePayment(true); });
    // An error goes away as soon as the customer starts fixing it.
    ['delivery', 'details'].forEach(function (k) {
      var body = $('step-' + k + '-body');
      var clearIt = function (ev) {
        if (ev.type === 'click' && !(ev.target.closest && ev.target.closest('.choose-btn, #choose-change'))) return;
        partError(k, '');
      };
      body.addEventListener('input', clearIt);
      body.addEventListener('change', clearIt);
      body.addEventListener('click', clearIt);
    });
    $('step-details-next').addEventListener('click', function () { finishDetails(); });
    $('step-delivery-change').addEventListener('click', function () { changePart('delivery'); });
    $('step-details-change').addEventListener('click', function () { changePart('details'); });
    // Enter in a field of an earlier part continues to the next part instead of paying.
    $('order-form').addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' || step !== 'checkout' || part === 'pay') return;
      var t = ev.target;
      if (!t || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.id === 'code') return;
      ev.preventDefault();
      if (part === 'delivery') finishDelivery();
      else finishDetails();
    });
    DOOR_KINDS.forEach(function (k) {
      $('door-kind-' + k).addEventListener('change', function () {
        syncDoorKind();
        askShip(true);
      });
    });
    DOOR_FIELDS.forEach(function (k) {
      var box = $('door-' + k);
      box.addEventListener(k === 'province' ? 'change' : 'input', function () { askShip(false); });
      // Leaving a field asks straight away, without waiting.
      box.addEventListener('blur', function () { askShip(true); });
    });
    $('ship-retry').addEventListener('click', function () {
      delete shipSeen[shipKey()];
      ship.key = '';
      askShip(true);
    });
    $('order-form').addEventListener('submit', onSubmit);
    $('choose-collect').addEventListener('click', function () { choose('collect'); });
    $('choose-deliver').addEventListener('click', function () { choose('deliver'); });
    $('choose-locker').addEventListener('click', function () { choose('locker'); });
    $('choose-change').addEventListener('click', function () {
      var was = choice;
      choice = null;
      hideError();
      syncFulfil();
      $('choose-' + (was || 'deliver')).focus();
    });
    $('collect-day').addEventListener('change', function () { fillTimes(''); });
    $('code-apply').addEventListener('click', function () { applyCode(); });
    $('code').addEventListener('keydown', function (ev) {
      // Enter in the code box applies the code instead of placing the order.
      if (ev.key === 'Enter') { ev.preventDefault(); applyCode(); }
    });
    $('code').addEventListener('input', function () {
      // A changed code has to be applied again.
      if (discount && $('code').value.trim().toUpperCase() !== discount.code) {
        discount = null;
        syncCode('');
        renderTotals();
      }
    });
  }

  // ---------- Discount code ----------

  function freeDeliveryCode() {
    return !!(discount && discount.delivery);
  }

  // Shows the code box when the shop has a live code, and what the applied code does.
  function syncCode(message) {
    $('code-field').hidden = (!(config && config.codesOn) && !discount) || viaLink();
    syncLinkPromo();
    var msg = SJ.clear($('code-msg'));
    if (discount) {
      msg.appendChild(el('span', { class: 'code-ok' }, discount.code + ': ' +
        (discount.delivery ? 'free delivery' : discount.percent + '% off your sachets')));
      if (discount.delivery && collecting()) msg.appendChild(document.createTextNode(' (applies when we deliver)'));
      msg.appendChild(document.createTextNode('. '));
      var remove = el('button', { type: 'button', class: 'link-btn', id: 'code-remove' }, 'Remove');
      remove.addEventListener('click', function () {
        discount = null;
        $('code').value = '';
        syncCode('');
        renderTotals();
        $('code').focus();
      });
      msg.appendChild(remove);
    } else if (message) {
      msg.textContent = message;
    }
  }

  // Asks the order service whether the typed code is live. Resolves true when it is applied.
  async function applyCode() {
    var typed = $('code').value.trim();
    if (!typed) {
      discount = null;
      syncCode('Enter a discount code first.');
      renderTotals();
      return false;
    }
    if (discount && discount.code === typed.toUpperCase()) return true;
    if (checkingCode) return false;
    checkingCode = true;
    $('code-apply').disabled = true;
    $('code-apply').textContent = 'Checking…';
    try {
      var res = await SJ.api('checkCode', { code: typed, email: $('email').value.trim() });
      discount = res.discount;
      $('code').value = discount.code;
      syncCode('');
      renderTotals();
      return true;
    } catch (err) {
      discount = null;
      syncCode(err.code === 'bad_code' ? err.message : 'Could not check the code. ' + err.message);
      renderTotals();
      return false;
    } finally {
      checkingCode = false;
      $('code-apply').disabled = false;
      $('code-apply').textContent = 'Apply';
    }
  }

  // ---------- Collect or delivery ----------

  // The customer picks first. The rest of the form appears for that choice.
  function choose(what) {
    choice = what;
    hideError();
    syncFulfil();
    $('chosen-text').focus();
  }

  function collecting() {
    return choice === 'collect';
  }

  // A delivery whose fee Greg confirms after the order: it is sent as a request.
  function quoting() {
    if (collecting() || freeDeliveryCode() || !config) return false;
    if (courierOn()) return ship.status === 'error';
    if (choice === 'locker' && lockerRates()) return lockerFee() === null;
    return !!config.quote;
  }

  // ---------- Fixed Pudo locker prices ----------

  // Greg's set prices for a Pudo locker, by number of sachets. More than the last one: he sends a price.
  function lockerRates() {
    return !!(config && !pudoOn() && config.lockerFees && config.lockerFees.length);
  }

  // The locker price for the sachets chosen, or null when it is more than the prices cover.
  function lockerFee() {
    var qty = Math.max(1, stepper.total());
    var fees = config.lockerFees;
    for (var i = 0; i < fees.length; i++) if (qty <= fees[i].upTo) return fees[i].fee;
    return null;
  }

  function lockerMax() {
    return config.lockerFees[config.lockerFees.length - 1].upTo;
  }

  // ---------- Door price from The Courier Guy ----------

  var DOOR_FIELDS = ['street', 'unit', 'suburb', 'city', 'code', 'province'];
  var DOOR_KINDS = ['house', 'flat', 'business'];

  // Door delivery is priced live for the customer's address.
  function courierOn() {
    return !!(config && config.courier) && choice === 'deliver';
  }

  // House, flat or complex, or business. '' until the customer picks one.
  function doorKind() {
    var picked = document.querySelector('input[name="door-kind"]:checked');
    return picked ? picked.value : '';
  }

  function readDoor() {
    var d = {};
    DOOR_FIELDS.forEach(function (k) { d[k] = $('door-' + k).value.trim(); });
    d.code = d.code.replace(/\D/g, '');
    d.kind = doorKind();
    // A house has no unit: anything typed there before switching to House is left out.
    if (d.kind === 'house') d.unit = '';
    return d;
  }

  // The unit or business name field shows for a flat or a business, worded for each.
  function syncDoorKind() {
    var kind = doorKind();
    $('door-unit-field').hidden = kind !== 'flat' && kind !== 'business';
    $('door-unit-label').textContent = kind === 'business' ? 'Business name, floor or unit' : 'Unit number and complex name';
    $('door-unit-hint').textContent = kind === 'business' ? 'For example Acme Ltd, 3rd floor' : 'For example Unit 4, Ocean View';
  }

  function doorLine(d) {
    return [d.unit, d.street, d.suburb, d.city, d.code].filter(Boolean).join(', ');
  }

  // The first part of the door address still to fill in: { id, message }, or null.
  function doorProblem(d) {
    if (!d.kind) return { id: 'door-kind-house', message: 'Choose the type of address: house, flat or complex, or business.' };
    if (!d.street) return { id: 'door-street', message: 'Enter your street number and street name.' };
    if (!/\d/.test(d.street) || !/[A-Za-z]{2}/.test(d.street)) return { id: 'door-street', message: 'Enter your street number and street name, for example 12 Beach Road.' };
    if (d.kind === 'flat' && d.unit.length < 2) return { id: 'door-unit', message: 'Enter your unit number and the name of your complex or building.' };
    if (d.kind === 'business' && d.unit.length < 2) return { id: 'door-unit', message: 'Enter the business name, and the floor or unit if there is one.' };
    if (d.suburb.length < 2) return { id: 'door-suburb', message: 'Enter your suburb.' };
    if (d.city.length < 2) return { id: 'door-city', message: 'Enter your city or town.' };
    if (!/^\d{4}$/.test(d.code)) return { id: 'door-code', message: 'Enter your 4-digit postal code.' };
    if (!d.province) return { id: 'door-province', message: 'Choose your province.' };
    return null;
  }

  function shipKey() {
    var d = readDoor();
    return JSON.stringify([d.street, d.suburb, d.city, d.code, d.province].map(function (v) { return v.toLowerCase(); }).concat(stepper.total()));
  }

  function setShip(next) {
    ship = next;
    renderTotals();
  }

  // Asks for the price once the address is complete. now: without waiting for more typing.
  function askShip(now) {
    if (!courierOn()) return;
    var d = readDoor();
    var key = shipKey();
    if (doorProblem(d) || stepper.total() < 1) {
      clearTimeout(shipTimer);
      if (ship.status !== 'idle') setShip({ key: '', status: 'idle', data: null, message: '' });
      return;
    }
    if (key === ship.key && (ship.status === 'ok' || ship.status === 'error')) return;
    if (shipSeen[key]) {
      clearTimeout(shipTimer);
      setShip({ key: key, status: 'ok', data: shipSeen[key], message: '' });
      return;
    }
    if (key === ship.key && ship.status === 'loading' && (shipAskKey === key || !now)) return;
    clearTimeout(shipTimer);
    // While still typing, show it is coming but wait a moment before asking.
    if (ship.key !== key || ship.status !== 'loading') setShip({ key: key, status: 'loading', data: null, message: '' });
    if (now) fetchShip(key, d);
    else shipTimer = setTimeout(function () { fetchShip(key, readDoor()); }, 700);
  }

  function fetchShip(key, d) {
    shipAskKey = key;
    var ask = SJ.api('deliveryQuote', { qty: stepper.total(), door: d }).then(function (res) {
      shipSeen[key] = res.quote;
      if (ship.key === key) setShip({ key: key, status: 'ok', data: res.quote, message: '' });
    }, function (err) {
      if (ship.key !== key) return;
      var msg = err.code === 'network' ? 'We could not reach the delivery prices. Check your connection.' : err.message;
      setShip({ key: key, status: 'error', data: null, message: msg, retry: err.code !== 'invalid' });
    });
    shipAsk = ask;
    ask.then(function () {
      if (shipAsk === ask) { shipAsk = null; shipAskKey = ''; }
    });
    return ask;
  }

  // The delivery card under the address, like a checkout's shipping method.
  function renderShip() {
    var on = courierOn();
    $('ship').hidden = !on;
    if (!on) return;
    var card = $('ship-card');
    var free = freeDeliveryCode();
    card.className = 'ship-card ship-card--' + ship.status;
    $('ship-name').textContent = ship.status === 'ok' ? 'The Courier Guy · ' + ship.data.service : 'The Courier Guy';
    // A range, never a date: the courier's own date leaves out the time to make the batch.
    $('ship-sub').textContent = ship.status === 'ok' ? 'To your door in ' + DOOR_DAYS
      : ship.status === 'loading' ? 'Getting the price for your address…'
      : ship.status === 'error' ? ship.message + ' You can still order: we will email you the delivery fee.'
      : doorProblem(readDoor()) ? 'Enter your address to see the delivery price.'
      : 'Choose your gels to see the delivery price.';
    $('ship-fee').textContent = ship.status === 'ok' ? (free ? 'Free' : SJ.money(ship.data.fee, config.currency)) : '';
    $('ship-retry').hidden = !(ship.status === 'error' && ship.retry);
  }

  // The door fee the customer sees and is charged, or null while it is not known.
  function shipFee() {
    return courierOn() && ship.status === 'ok' ? ship.data.fee : null;
  }

  // Card payments on the page for this order (not for one that waits for Greg's fee).
  function payNow() {
    return !!(config && config.cardPay) && !!choice && !quoting();
  }

  // ---------- Pudo fees ----------

  // The fee comes from the box and Pudo size for the number of sachets.
  function pudoOn() {
    return !!(config && config.ship && config.ship.tiers && config.ship.tiers.length);
  }

  function pudoTier(qty) {
    var tiers = config.ship.tiers;
    for (var i = 0; i < tiers.length; i++) if (qty <= tiers[i].upTo) return tiers[i];
    return null;
  }

  function pudoMax() {
    var tiers = config.ship.tiers;
    return tiers[tiers.length - 1].upTo;
  }

  // The fee for the current choice and quantity, or null when it is too many to send.
  function pudoFee() {
    var t = pudoTier(Math.max(1, stepper.total()));
    if (!t) return null;
    return choice === 'collect' ? t.collect : choice === 'locker' ? t.locker : t.door;
  }

  // The cheapest fee for a choice, for the buttons: "From R55".
  function pudoFrom(kind) {
    return config.ship.tiers.reduce(function (min, t) { return Math.min(min, t[kind]); }, Infinity);
  }

  // An older order service sends no collection times. Collection then works without one.
  function slotsOn() {
    return !!(config && Array.isArray(config.collectSlots));
  }

  // A starting price from config.js (fromPrices), for when the fee is confirmed after
  // the order and no Pudo rates are set. Null when there is none to show.
  function fixedFrom(kind) {
    if (!config || !config.quote || pudoOn()) return null;
    var p = SJ.cfg.fromPrices;
    var n = p && Number(p[kind]);
    return n > 0 ? n : null;
  }

  function fixedFromText(kind) {
    var n = fixedFrom(kind);
    return n === null ? '' : 'From ' + SJ.money(n, config.currency);
  }

  function deliveryText(c) {
    if (c.quote) return c.fee > 0 ? 'From ' + SJ.money(c.fee, c.currency) : 'Fee confirmed after you order';
    return c.fee > 0 ? SJ.money(c.fee, c.currency) : 'Free';
  }

  // While the fee is confirmed after the order, a starting price says so.
  // Each part of a choice's small text goes on its own line (see .choose-sub in shop.css).
  var QUOTE_NOTE = '*\n*Location dependent';

  // The starting price for door or locker, with the note, or '' when there is none.
  function quoteFromText(kind) {
    if (!config || !config.quote || pudoOn()) return '';
    var text = fixedFromText(kind) || (config.fee > 0 ? 'From ' + SJ.money(config.fee, config.currency) : '');
    return text ? text + QUOTE_NOTE : '';
  }

  function syncFulfil() {
    var collect = collecting();
    var place = config ? config.collectNote : '';
    $('choose').hidden = !!choice;
    $('chosen').hidden = !choice;
    $('order-rest').hidden = !choice;
    var pudo = pudoOn();
    $('choose-collect').setAttribute('aria-pressed', String(collect));
    $('choose-deliver').setAttribute('aria-pressed', String(choice === 'deliver'));
    $('choose-locker').setAttribute('aria-pressed', String(choice === 'locker'));
    // Door and locker are always offered. Without Pudo prices both use the delivery fee.
    $('choose-locker').hidden = false;
    $('choose').querySelector('.choose-row').classList.add('choose-row--three');
    $('choose-deliver-title').textContent = 'To your door';
    if (config) {
      var collectFree = !pudo || pudoFrom('collect') === 0;
      // The heading says it is free (only when it is), the small text says where.
      $('choose-collect-title').textContent = collectFree ? 'Free collection' : 'Collect';
      $('choose-collect-sub').textContent = place ? 'From ' + place : '';
      $('choose-deliver-sub').textContent = config.courier ? 'Priced for your address'
        : pudo ? 'From ' + SJ.money(pudoFrom('door'), config.currency) : quoteFromText('door') || deliveryText(config);
      $('choose-locker-sub').textContent = pudo ? 'From ' + SJ.money(pudoFrom('locker'), config.currency)
        : lockerRates() ? 'From ' + SJ.money(config.lockerFees[0].fee, config.currency)
        : quoteFromText('locker') || deliveryText(config);
    }
    $('chosen-text').textContent = collect ? 'Collect' + (place ? ' from ' + place : '')
      : choice === 'locker' ? 'Send to a Pudo locker'
      : 'Deliver to your door';
    // The locker uses the address too: Greg picks the Pudo locker nearest to it.
    $('address-field').hidden = collect || courierOn();
    $('door-fields').hidden = !courierOn();
    renderShip();
    if (courierOn()) askShip(true);
    $('address-label').textContent = choice === 'locker' ? 'Your address' : 'Delivery address';
    $('locker-hint').hidden = choice !== 'locker';
    $('collect-time').hidden = !collect || !slotsOn();
    syncCode($('code-msg').textContent && !discount ? $('code-msg').textContent : '');
    renderTotals();
  }

  // ---------- Collection time ----------

  // Keeps the day and time already picked when they are still free.
  function renderSlots() {
    if (!slotsOn()) return;
    var slots = config.collectSlots;
    var day = $('collect-day');
    var wantTime = $('collect-hour').value;
    SJ.fillSlotDays(day, slots, slots.length ? 'Choose a day' : 'No times free');
    day.disabled = !slots.length;
    fillTimes(wantTime);
    $('collect-hint').textContent = slots.length
      ? 'Free times for the next ' + (config.collectAhead || 30) + ' days.'
      : 'No collection times are free in the next ' + (config.collectAhead || 30) + ' days. Choose delivery, or send us a DM.';
  }

  function fillTimes(want) {
    SJ.fillSlotTimes($('collect-hour'), SJ.slotDay(config.collectSlots, $('collect-day').value), want);
  }

  function applyConfig(c) {
    config = c;
    $('brand').textContent = c.brand;
    document.title = (ON_CHECKOUT ? 'Checkout · ' : '') + c.brand + ' (trial)';
    // Each sentence on its own line (the lede keeps line breaks, see shop.css).
    $('lede').textContent = (c.collectNote ? 'Collect in ' + c.collectNote + ', or we send them to you.\n' : 'We send them to you, or you can collect.\n') +
      (c.cardPay ? 'Pay securely here by card, Apple Pay or Google Pay.' : 'Pay by bank transfer.');
    if (!stepper) buildForm();
    stepper.setRange(c.minQty, c.maxQty);
    stepper.setItem(SJ.itemLine(c));
    renderSlots();
    syncFulfil();
    renderBag();
    applyBag();
    applyPhoto(c.photo || null);
  }

  function renderTotals() {
    if (!config) return;
    var quote = quoting();
    var opts = { collect: collecting(), quote: quote };
    if (pudoOn() && choice) {
      var fee = pudoFee();
      opts.fee = fee === null ? 0 : fee;
      opts.collectFee = opts.fee;
      if (fee === null) opts.feeText = 'DM us for over ' + pudoMax();
    }
    if (courierOn()) {
      opts.label = 'Delivery to your door';
      var sf = shipFee();
      if (sf !== null) opts.fee = sf;
      else {
        opts.quote = true;
        opts.feeText = ship.status === 'loading' ? 'Working it out…' : ship.status === 'error' ? 'We email you the fee' : 'Enter your address';
      }
    }
    if (choice === 'locker') opts.label = 'Delivery to a Pudo locker';
    if (choice === 'locker' && lockerRates()) {
      var lf = lockerFee();
      if (lf === null) opts.feeText = 'We send you the price (over ' + lockerMax() + ')';
      else opts.fee = lf;
    } else if (choice && !collecting() && !courierOn() && quoteFromText(choice === 'locker' ? 'locker' : 'door')) {
      opts.feeText = quoteFromText(choice === 'locker' ? 'locker' : 'door');
    }
    opts.discount = discount;
    opts.flavours = SJ.flavourText(stepper.get(), stepper.list);
    var qty = stepper.total();
    var total = SJ.renderSummary($('summary'), config, qty, opts);
    $('bag-toggle-total').textContent = SJ.money(total, config.currency);
    renderShip();
    var waiting = courierOn() && !quote && shipFee() === null && !freeDeliveryCode();
    if (!busy) {
      $('submit').textContent = qty < stepper.min() ? 'Choose at least ' + (stepper.min() === 1 ? '1 gel' : stepper.min() + ' gels')
        : waiting ? 'Place order for ' + SJ.money(total, config.currency) + ' + delivery'
        : quote ? 'Send order for ' + SJ.money(total, config.currency) + ' + delivery'
        : payNow() ? 'Pay ' + SJ.money(total, config.currency) + ' securely'
        : 'Place order for ' + SJ.money(total, config.currency);
    }
    $('pay-with').hidden = !payNow();
    $('next-note').textContent = quote
      ? 'Next we work out the delivery fee for your address and email your invoice' + (config.cardPay ? ' with a link to pay.' : ' with the bank details.') + ' There is nothing to pay yet.'
      : payNow() ? 'You pay on Paystack\'s secure page by card, Apple Pay or Google Pay. Your order number comes once the payment goes through.'
      : 'Next you will see the bank details and your invoice number. Use the invoice number as your payment reference.';
  }

  function readForm() {
    return {
      name: $('name').value.trim(),
      email: $('email').value.trim(),
      contact: $('contact').value.trim(),
      address: courierOn() ? doorLine(readDoor()) : $('address').value.trim(),
      door: courierOn() ? readDoor() : null,
      ship: choice === 'locker' ? 'locker' : 'door',
      locker: '',
      notes: $('notes').value.trim(),
      qty: stepper.total(),
      flavours: stepper.get(),
      collect: collecting(),
      collectAt: collecting() && $('collect-day').value && $('collect-hour').value
        ? $('collect-day').value + ' ' + $('collect-hour').value : '',
      code: discount ? discount.code : ''
    };
  }

  // A phone number: digits with optional spaces, dashes, brackets and a leading +.
  function isPhone(s) {
    if (!/^\+?[\d\s()-]{9,20}$/.test(s)) return false;
    var digits = s.replace(/\D/g, '').length;
    return digits >= 9 && digits <= 15;
  }

  function validate(d) {
    var first = stepper.firstInput().id;
    if (d.collect && slotsOn()) {
      if (!config.collectSlots.length) return { id: 'choose-change', message: 'No collection times are free right now. Choose delivery, or send us a DM.' };
      if (!$('collect-day').value) return { id: 'collect-day', message: 'Pick a day to collect.' };
      if (!d.collectAt) return { id: 'collect-hour', message: 'Pick a time to collect.' };
    }
    // The flavours come next on the form, under the collection time.
    if (d.qty < stepper.min()) {
      return { id: first, message: d.qty === 0 ? 'Choose how many of each flavour you would like.'
        : 'The minimum order is ' + stepper.min() + ' gels. Add ' + (stepper.min() - d.qty) + ' more.' };
    }
    if (d.qty > stepper.max()) return { id: first, message: 'The most one order can include is ' + stepper.max() + ' gels.' };
    if (!d.name) return { id: 'name', message: 'Enter your name.' };
    if (!d.email) return { id: 'email', message: 'Enter your email address so we can send your invoice.' };
    if (!SJ.isEmail(d.email)) return { id: 'email', message: 'Check your email address. It should look like name@example.com.' };
    if (!d.contact) return { id: 'contact', message: 'Enter your phone number.' };
    if (!isPhone(d.contact)) return { id: 'contact', message: 'Check your phone number. It should look like 082 123 4567.' };
    if (pudoOn() && pudoFee() === null) {
      return { id: first, message: 'For more than ' + pudoMax() + ' sachets, please send us a DM and we will arrange delivery.' };
    }
    if (d.collect) return null;
    if (d.door) return doorProblem(d.door);
    if (d.ship === 'locker') return d.address ? null : { id: 'address', message: 'Enter your address so we can pick the Pudo locker nearest to you.' };
    if (!d.address) return { id: 'address', message: 'Enter your delivery address.' };
    return null;
  }

  function showError(message, withDm) {
    var box = $('form-error');
    SJ.clear(box);
    box.appendChild(document.createTextNode(message));
    if (withDm) {
      var dm = dmLink();
      if (dm) {
        box.appendChild(document.createTextNode(' '));
        box.appendChild(dm);
      }
    }
    box.hidden = false;
  }

  function hideError() {
    $('form-error').hidden = true;
  }

  function dmLink() {
    var handle = String(SJ.cfg.instagram || '').replace(/^@/, '');
    if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) return null;
    return el('a', { href: 'https://www.instagram.com/' + handle + '/', target: '_blank', rel: 'noopener' }, 'Send us a DM on Instagram');
  }

  function setSubmitting(on) {
    busy = on;
    $('submit').disabled = on;
    if (on) $('submit').textContent = payNow() ? 'Opening secure payment…' : 'Placing order…';
    else renderTotals();
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    if (busy || !config) return;
    // The trial page never reaches the live order service: without demo mode (demo.js) it stops here.
    if (!SJ.demo) {
      showError('This trial page is not in demo mode, so it will not place orders.');
      return;
    }
    hideError();

    // A code typed but not applied is checked first, so it is never silently left out.
    var typedCode = $('code').value.trim();
    if (!$('code-field').hidden && typedCode && !(discount && discount.code === typedCode.toUpperCase())) {
      if (!(await applyCode())) {
        showError('Check your discount code, or clear it to order without one.');
        $('code').focus();
        return;
      }
    }

    var data = readForm();
    var problem = validate(data);
    if (problem) {
      if (problem.id === stepper.firstInput().id) {
        saveBag();
        toLanding();
        return;
      }
      var k = partOf(problem.id);
      partDone[k] = false;
      openPart(k, problem.id);
      partError(k, problem.message);
      return;
    }
    if (part !== 'pay') return;

    // A door order waits for its delivery price, so the customer is charged what they see.
    if (courierOn() && !freeDeliveryCode() && ship.status !== 'ok' && ship.status !== 'error') {
      setSubmitting(true);
      askShip(true);
      try { if (shipAsk) await shipAsk; } catch (err) { /* shown on the delivery card */ }
      setSubmitting(false);
      if (ship.status === 'ok') {
        showError('Your delivery price is ' + SJ.money(ship.data.fee, config.currency) + '. Check the total, then place your order.');
        $('ship-card').scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      if (ship.status !== 'error') return;
    }

    // A collection order does not send the address that is hidden on the form.
    if (data.collect) data.address = '';
    if (!data.door) delete data.door;
    // Sent as the locker too, for an order service from before lockers used the address.
    data.locker = data.ship === 'locker' ? data.address : '';
    // An order service from before flavours does not store them, so they go in the notes.
    if (!Array.isArray(config.flavours)) {
      var picked = 'Flavours: ' + SJ.flavourText(data.flavours, stepper.list);
      data.notes = (picked + (data.notes ? '. ' + data.notes : '')).slice(0, 300);
    }
    var sig = JSON.stringify([data.name, data.email, data.contact, data.address, data.locker, data.ship, data.notes, data.qty, data.flavours, data.collect, data.collectAt, data.code, ship.status === 'ok' ? ship.data.fee : null]);
    if (!pending || pending.sig !== sig) pending = { sig: sig, id: SJ.newRequestId() };

    setSubmitting(true);
    try {
      var res = await SJ.api('order', Object.assign({}, data, {
        requestId: pending.id,
        // The total the customer was shown: without a fee for collection, or for a request.
        expectedTotal: SJ.totalFor(data.qty, config.price,
          freeDeliveryCode() && !data.collect ? 0 : courierOn() ? (shipFee() === null ? 0 : shipFee())
            : pudoOn() ? pudoFee()
            : data.ship === 'locker' && !data.collect && lockerRates() ? (lockerFee() === null ? 0 : lockerFee())
            : data.collect || config.quote ? 0 : config.fee,
          discount && !discount.delivery ? discount.percent : 0),
        website: $('website').value
      }));
      pending = null;
      SJ.store.set(LAST_KEY, { savedAt: Date.now(), data: res });
      if (cardOn(res.order)) {
        // Straight to the secure payment page. The order number is shown only once it is paid.
        await payStraightAway(res);
        return;
      }
      clearBag();
      showDone(res, false);
    } catch (err) {
      onOrderError(err);
    } finally {
      setSubmitting(false);
    }
  }

  // ---------- Payment window (trial page) ----------
  //
  // Paystack's payment links never expire by themselves, so the checkout gives the customer a
  // window to pay (like payment gateways in India): a countdown from the moment they tap Pay.
  // When it runs out the payment is closed and nothing is charged; Pay starts a fresh one.
  // What happens to a payment that still arrives late is decided by the order service (see
  // "For Greg - payment window.txt"). On the trial page two buttons show both outcomes.
  //   ?window=30     a 30-second window, to try it quickly (trial page only)
  //   ?late=refund   late payments are always refunded (the default accepts one that can
  //                  still be honoured: same price, collection time still free)

  var params = new URLSearchParams(location.search);
  var PAY_WINDOW_SECONDS = (function () {
    var q = Number(params.get('window'));
    return q >= 5 && q <= 3600 ? Math.round(q) : 15 * 60;
  })();
  var LATE_POLICY = params.get('late') === 'refund' ? 'refund' : 'accept';
  var windowTimer = null;
  var windowEnds = 0;

  function clockText(seconds) {
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }

  function windowLeft() {
    return Math.max(0, Math.ceil((windowEnds - Date.now()) / 1000));
  }

  function windowTick() {
    var left = windowLeft();
    var line = $('pay-window');
    line.hidden = false;
    line.textContent = 'Complete your payment within ' + clockText(left);
    line.classList.toggle('pay-window--late', left <= 60);
    document.dispatchEvent(new CustomEvent('sj:pay-window', { detail: { left: left, text: clockText(left) } }));
    if (left === 0) closeWindow(true);
  }

  function startWindow() {
    stopWindow();
    $('pay-expired').hidden = true;
    windowEnds = Date.now() + PAY_WINDOW_SECONDS * 1000;
    windowTick();
    windowTimer = setInterval(windowTick, 1000);
  }

  function stopWindow() {
    if (windowTimer) clearInterval(windowTimer);
    windowTimer = null;
    $('pay-window').hidden = true;
  }

  // Time is up: the payment closes (the demo's pretend Paystack listens for this).
  function closeWindow(expired) {
    stopWindow();
    if (!expired) return;
    document.dispatchEvent(new CustomEvent('sj:pay-window-closed'));
    var minutes = PAY_WINDOW_SECONDS >= 60 ? Math.round(PAY_WINDOW_SECONDS / 60) + '-minute' : PAY_WINDOW_SECONDS + '-second';
    var article = /^(8|11|18|80)|^8\d-/.test(minutes) ? 'an ' : 'a ';
    $('pay-expired-text').textContent = 'You had ' + article + minutes + ' window to pay, and nothing was charged. Tap Pay to start again.';
    $('pay-expired-trial').hidden = !SJ.demo;
    $('pay-expired').hidden = false;
    hideError();
    $('pay-expired').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // Trial page only: the old payment link is paid after the window closed. The order service
  // would check whether the order can still be honoured, then accept it or refund it.
  function latePayment(changed) {
    if (!SJ.demo || !current) return;
    var o = current.order;
    var sym = current.currency;
    $('pay-expired').hidden = true;
    if (!changed && LATE_POLICY === 'accept') {
      saveShown(Object.assign({}, current, { order: Object.assign({}, o, { status: 'Paid' }) }));
      showDone(current, false);
      $('done-sub').textContent = 'Your payment of ' + SJ.money(o.total, sym) + ' came in after the payment window closed, ' +
        'but nothing had changed, so your order went through as normal.' + (o.email ? ' Your paid invoice is on its way to ' + o.email + '.' : '');
      return;
    }
    var why = changed ? 'after your payment window closed, and by then your collection time had been taken by someone else'
      : 'after your payment window closed';
    showClosed('Your payment was refunded',
      'We received ' + SJ.money(o.total, sym) + ' ' + why + '. It has been refunded to your card automatically: it can take ' +
      'a few working days to show on your statement. Greg has been told. Please place your order again.', false);
    var again = el('button', { type: 'button', class: 'btn btn-primary' }, 'Order again');
    again.addEventListener('click', function () { newOrder(); });
    $('closed-dm').appendChild(again);
  }

  async function payStraightAway(res) {
    current = res;
    startWindow();
    try {
      var pay = await SJ.api('startPayment', {
        invoice: res.order.invoice, email: res.order.email, returnUrl: location.origin + location.pathname
      });
      if (pay.paid) {
        stopWindow();
        saveShown(Object.assign({}, res, { order: Object.assign({}, res.order, { status: 'Paid' }) }));
        showDone(current, false);
        return;
      }
      if (typeof pay.url !== 'string' || !/^https:\/\//.test(pay.url)) throw new Error('Card payment is not working right now. Please try again in a moment.');
      window.location.assign(pay.url);
    } catch (err) {
      // Back at checkout, everything still filled in. No order number is shown.
      if (err.code === 'expired') return; // closeWindow has said so already
      stopWindow();
      current = null;
      showError(err.code === 'cancelled' ? err.message : err.message + ' Nothing was charged.');
    }
  }

  function onOrderError(err) {
    if (err.code === 'bad_code') {
      // The code was switched off after it was applied.
      pending = null;
      discount = null;
      if (err.data && err.data.config) {
        SJ.store.set(CONFIG_KEY, err.data.config);
        applyConfig(err.data.config);
      }
      syncCode(err.message);
      renderTotals();
      // The code is in Your details: that part opens again, with the message there.
      partDone.details = false;
      openPart('details', 'code');
      partError('details', err.message);
    } else if (err.code === 'quote_changed') {
      // The Courier Guy's price moved (or could not be had) since it was shown.
      pending = null;
      var q = err.data && err.data.quote;
      var key = shipKey();
      if (q) shipSeen[key] = q;
      else delete shipSeen[key];
      setShip(q ? { key: key, status: 'ok', data: q, message: '' }
        : { key: key, status: 'error', data: null, message: 'We could not get a delivery price just now.', retry: true });
      showError(err.message);
    } else if (err.code === 'price_changed' && err.data && err.data.config) {
      pending = null;
      SJ.store.set(CONFIG_KEY, err.data.config);
      applyConfig(err.data.config);
      showError('The price has just changed. Check the new total, then place your order again.');
    } else if (err.code === 'slot_taken' && err.data && err.data.config) {
      // Someone else booked the time first. The free times come back with the error.
      pending = null;
      SJ.store.set(CONFIG_KEY, err.data.config);
      applyConfig(err.data.config);
      // The time is in Delivery: that part opens again, with the message there.
      partDone.delivery = false;
      openPart('delivery', $('collect-day').value ? 'collect-hour' : 'collect-day');
      partError('delivery', err.message);
    } else if (err.code === 'not_ready') {
      showClosed('Ordering opens soon', 'We are not taking orders on this page yet. Please check back soon.');
    } else if (err.code === 'invalid') {
      showError(err.message);
    } else if (err.code === 'busy' || err.code === 'rejected') {
      showError(err.message, true);
    } else {
      showError(err.message + ' Your details are still here.', err.code === 'network');
    }
  }

  // ---------- Confirmation ----------

  function payRow(label, value, copyValue) {
    return el('div', { class: 'pay-row' },
      el('div', { class: 'pay-main' },
        el('span', { class: 'pay-label' }, label),
        el('span', { class: 'pay-value' }, value)),
      copyValue ? SJ.copyButton(copyValue, 'Copy') : null);
  }

  function showDone(res, restored) {
    current = res;
    var o = res.order;
    var sym = res.currency;
    var bank = res.bank || {};

    // A delivery request has no fee yet, so no bank details: the invoice comes by email later.
    var request = o.status === 'New request';
    var paid = isPaid(o);
    if (paid) clearBag();

    // Tell the Meta Pixel about a new order, once per invoice (pixel.js). The value is the gels' total.
    if (!restored && typeof window.fbq === 'function') {
      var tracked = '';
      try { tracked = sessionStorage.getItem('sj_pixel_last') || ''; } catch (err) { /* private browsing */ }
      if (tracked !== String(o.invoice)) {
        try {
          window.fbq('track', 'Purchase', { value: Number(o.total) || 0, currency: 'ZAR', num_items: Number(o.qty) || 0 }, { eventID: String(o.invoice) });
          sessionStorage.setItem('sj_pixel_last', String(o.invoice));
        } catch (err) { /* never let tracking get in the way of the order */ }
      }
    }
    var follow = $('done-follow');
    if (follow && SJ.cfg.instagram) {
      var igHandle = String(SJ.cfg.instagram).replace(/^@/, '');
      follow.href = 'https://www.instagram.com/' + igHandle + '/';
      follow.textContent = 'Follow @' + igHandle + ' for new flavours and drops';
    }
    $('pay-section').hidden = request || paid;
    $('copy-invoice').hidden = request;
    $('done-keep').textContent = 'Take a screenshot of this page to keep your ' + (request ? 'order' : 'invoice') + ' number.';

    $('done-title').textContent = paid ? 'Paid, thank you'
      : request ? (restored ? 'Your last request' : 'Order request sent')
      : (restored ? 'Your last order' : 'Order received');
    var sub = SJ.clear($('done-sub'));
    if (paid) {
      sub.textContent = 'We have received your payment of ' + SJ.money(o.total, sym) + '.' +
        (o.email ? ' Your paid invoice is on its way to ' + o.email + '.' : '');
    } else if (request) {
      sub.textContent = restored
        ? 'Sent ' + SJ.formatWhen(o.created) + '. We will email your invoice once the delivery fee is confirmed.'
        : 'We will work out the delivery fee for your address and email your invoice to ' + o.email +
          (config && config.cardPay ? ' with a link to pay on our website.' : ' with the bank details.') + ' There is nothing to pay yet.';
    } else if (restored) {
      sub.textContent = 'Placed ' + SJ.formatWhen(o.created) + '. If you have already paid, there is nothing more to do.';
    } else if (cardOn(o)) {
      sub.textContent = 'Pay ' + SJ.money(o.total, sym) + ' below to confirm your order.';
    } else {
      sub.appendChild(document.createTextNode('Pay ' + SJ.money(o.total, sym) + ' by bank transfer and use '));
      sub.appendChild(el('span', { class: 'nowrap' }, o.invoice));
      sub.appendChild(document.createTextNode(' as the reference.'));
    }

    var emailNote = $('done-email');
    emailNote.hidden = restored || request || paid || !o.email;
    if (!o.emailedOn && cardOn(o)) emailNote.textContent = 'Once you have paid, we email your paid invoice to ' + o.email + '.';
    else if (o.emailedOn) emailNote.textContent = 'We have emailed your invoice to ' + o.email + '. Check your spam folder if it is not there.';
    else emailNote.textContent = 'We could not email your invoice just now. Take a screenshot of this page instead.';

    var collectNote = $('done-collect');
    collectNote.hidden = !o.collect;
    var place = res.collectNote ? ' from ' + res.collectNote : '';
    if (!o.collect) collectNote.textContent = '';
    else if (o.collectAt && paid) collectNote.textContent = 'Collect on ' + SJ.formatWhen(o.collectAt) + place + '. The address and calendar invite are in your email.';
    else if (o.collectAt && !o.emailedOn && cardOn(o)) collectNote.textContent = 'Collect on ' + SJ.formatWhen(o.collectAt) + place + '. Once you have paid, the address and a calendar invite are emailed to you.';
    else if (o.collectAt) collectNote.textContent = 'Collect on ' + SJ.formatWhen(o.collectAt) + place + '. The address is in your email, and a calendar invite follows once your payment is confirmed.';
    else collectNote.textContent = 'You are collecting this order' + place + '. We will DM you to arrange a time.';

    var bib = $('bib');
    SJ.clear(bib);
    bib.className = 'bib' + (restored ? '' : ' bib--arrive');
    bib.appendChild(el('div', { class: 'bib-main' },
      el('p', { class: 'bib-brand' }, res.brand),
      el('p', { class: 'bib-number' }, o.invoice),
      el('p', { class: 'bib-caption' }, request ? 'Your order number' : 'Your invoice number')));
    bib.appendChild(el('div', { class: 'bib-tear' }, el('span', null,
      paid ? (o.collect ? 'Show it when you collect' : 'Mention it if you contact us')
        : request ? 'Mention it if you contact us' : 'Use it as your payment reference')));

    var pay = $('pay');
    SJ.clear(pay);
    pay.appendChild(payRow('Amount', SJ.money(o.total, sym), String(o.total)));
    if (bank.name) pay.appendChild(payRow('Bank', bank.name));
    if (bank.holder) pay.appendChild(payRow('Account holder', bank.holder));
    if (bank.number) pay.appendChild(payRow('Account number', bank.number, bank.number));
    if (bank.branch) pay.appendChild(payRow('Branch code', bank.branch, bank.branch));
    if (bank.type) pay.appendChild(payRow('Account type', bank.type));
    pay.appendChild(payRow('Reference', o.invoice, o.invoice));
    $('pay-note').textContent = res.paymentNote || '';
    hideCardError();
    syncCard();

    // At checkout, an order that isn't paid yet (back from Paystack without paying) shows no
    // order number: only what is owed and the way to pay.
    var unpaidHere = ON_CHECKOUT && !paid && !request && cardOn(o);
    $('bib').hidden = unpaidHere;
    $('done-keep').hidden = unpaidHere;
    if (unpaidHere) {
      $('copy-invoice').hidden = true;
      $('done-email').hidden = true;
      $('done-title').textContent = 'Payment not completed';
      $('done-sub').textContent = 'Nothing was charged. Pay ' + SJ.money(o.total, sym) + ' below to confirm your order.';
    }

    showView('view-done');
    window.scrollTo(0, 0);
    $('done-title').focus({ preventScroll: true });
  }

  // ---------- Card payment (Paystack) ----------

  function isPaid(o) {
    return o.status === 'Paid' || o.status === 'Delivered';
  }

  // Orders waiting for payment can be paid by card, once Greg has switched it on.
  function cardOn(o) {
    return !!(config && config.cardPay) && o.status === 'Awaiting payment' && !!o.email;
  }

  function syncCard() {
    var on = !!current && cardOn(current.order);
    $('card-section').hidden = !on;
    // With card payments on, customers pay here and nowhere else: no bank details are shown.
    // They only appear if card payments are switched off (no Paystack key), as a fallback.
    var eft = $('pay-section');
    eft.classList.toggle('eft--only', !on);
    if (on) eft.hidden = true;
    else eft.open = true;
    $('pay-title').textContent = 'Pay by bank transfer';
    if (on) $('checkout-amount').textContent = SJ.money(current.order.total, current.currency);
    if (on && !paying) {
      $('pay-card').disabled = false;
      $('pay-card-text').textContent = 'Pay ' + SJ.money(current.order.total, current.currency) + ' now';
    }
  }

  function showCardError(message) {
    var box = $('card-error');
    box.textContent = message;
    box.hidden = false;
  }

  function hideCardError() {
    $('card-error').hidden = true;
    $('card-error').textContent = '';
  }

  function saveShown(res) {
    current = res;
    SJ.store.set(LAST_KEY, { savedAt: Date.now(), data: res });
  }

  async function startCard() {
    if (!current || paying) return;
    var o = current.order;
    var btn = $('pay-card');
    paying = true;
    btn.disabled = true;
    $('pay-card-text').textContent = 'Opening secure payment…';
    hideCardError();
    try {
      var res = await SJ.api('startPayment', {
        invoice: o.invoice, email: o.email, returnUrl: location.origin + location.pathname
      });
      if (res.paid) {
        paying = false;
        saveShown(Object.assign({}, current, { order: Object.assign({}, o, { status: 'Paid' }) }));
        showDone(current, false);
        return;
      }
      if (typeof res.url !== 'string' || !/^https:\/\//.test(res.url)) throw new Error('Card payment is not working right now. Please try again in a moment.');
      window.location.assign(res.url);
    } catch (err) {
      paying = false;
      syncCard();
      showCardError(err.message);
    }
  }

  // The "Pay by card" link in an invoice email: ?pay=SJ-0001#their@email. The email stays
  // after # so it never reaches a server, and is taken out of the address straight away.
  function payLinkRequest() {
    var q = new URLSearchParams(location.search);
    var invoice = q.get('pay') || '';
    if (!invoice) return null;
    var email = '';
    try { email = decodeURIComponent(location.hash.slice(1)); } catch (err) { email = ''; }
    try { history.replaceState(null, '', location.pathname); } catch (err) { /* old browser */ }
    return { invoice: invoice, email: email };
  }

  async function payFromLink(req) {
    showView('view-loading');
    try {
      var res = await SJ.api('startPayment', { invoice: req.invoice, email: req.email, returnUrl: location.origin + location.pathname });
      if (res.paid) {
        showClosed('This order is already paid', 'Thank you. Your paid invoice is in your email.', false);
        return true;
      }
      if (typeof res.url !== 'string' || !/^https:\/\//.test(res.url)) throw new Error('Card payment is not working right now. Please try again in a moment.');
      window.location.assign(res.url);
      return true;
    } catch (err) {
      showClosed('We could not open the card payment', err.message + ' If it keeps happening, reply to your invoice email and we will help.', false);
      return true;
    }
  }

  // Coming back from Paystack: the address has ?reference=... on it.
  function returnedReference() {
    var q = new URLSearchParams(location.search);
    return q.get('reference') || q.get('trxref') || '';
  }

  function clearReference() {
    try { history.replaceState(null, '', location.pathname + location.hash); } catch (err) { /* old browser */ }
  }

  // The server asks Paystack whether the money came in, and marks the order paid if it did.
  async function confirmReturn(reference, last) {
    showView('view-loading');
    try {
      var res = await SJ.api('confirmPayment', { reference: reference });
      clearReference();
      saveShown(res);
      showDone(res, !res.paid);
      if (!res.paid) showCardError('Your payment did not go through, so nothing was charged. Please try again.');
    } catch (err) {
      if (err.code !== 'network' && err.code !== 'busy') clearReference();
      var msg = err.code === 'pay_mismatch' || err.code === 'not_found' ? err.message
        : 'We could not check your payment just now. If you paid, it is safe: reload this page in a moment.';
      if (last) {
        showDone(last.data, true);
        showCardError(msg);
      } else {
        showClosed('We could not check your payment', msg, err.code === 'network' || err.code === 'busy' || err.code === 'pay_failed');
      }
    }
  }

  // Back from the payment page with the browser's Back button: the button works again.
  window.addEventListener('pageshow', function (ev) {
    if (ev.persisted && paying) {
      paying = false;
      syncCard();
    }
  });

  function newOrder() {
    SJ.store.remove(LAST_KEY);
    clearBag();
    if (ON_CHECKOUT) {
      location.href = '../' + trialQuery() + '#order';
      return;
    }
    current = null;
    pending = null;
    $('notes').value = '';
    if (stepper) stepper.reset();
    choice = null;
    $('collect-day').value = '';
    if (config) {
      renderSlots();
      syncFulfil();
    }
    hideError();
    step = 'bag';
    partDone = { delivery: false, details: false };
    if (config) showStep('bag', false);
    showView(config && config.ready ? 'order-form' : 'view-loading');
    window.scrollTo(0, 0);
    if (!config) init();
    else refreshConfig();
  }

  // Fresh collection times for the next order. The form keeps working if this fails.
  async function refreshConfig() {
    try {
      var res = await SJ.api('config');
      SJ.store.set(CONFIG_KEY, res.config);
      if (res.config.ready) applyConfig(res.config);
    } catch (err) {
      // The times shown may be a little old. The server still checks the one picked.
    }
  }

  // ---------- Closed or failed ----------

  function showClosed(title, text, retry) {
    $('closed-title').textContent = title;
    $('closed-text').textContent = text;
    $('closed-retry').hidden = !retry;
    var dm = $('closed-dm');
    SJ.clear(dm);
    var link = dmLink();
    if (link) dm.appendChild(el('p', null, link));
    showView('view-closed');
  }

  // ---------- Start ----------

  function readLast() {
    var last = SJ.store.get(LAST_KEY);
    if (!last || !last.data || !last.data.order || Date.now() - last.savedAt > LAST_MAX_AGE) {
      SJ.store.remove(LAST_KEY);
      return null;
    }
    return last;
  }

  async function init() {
    var last = readLast();
    var cached = SJ.store.get(CONFIG_KEY);
    if (cached && cached.ready) applyConfig(cached);
    var reference = returnedReference();
    var payLink = reference ? null : payLinkRequest();
    if (payLink && await payFromLink(payLink)) return;

    if (reference) await confirmReturn(reference, last);
    else if (last && (!ON_CHECKOUT || !readBag())) showDone(last.data, true);
    else if (config) showView('order-form');
    else showView('view-loading');

    try {
      var res = await SJ.api('config');
      SJ.store.set(CONFIG_KEY, res.config);
      if (!res.config.ready) {
        if (!last && !reference) showClosed('Ordering opens soon', 'We are not taking orders on this page yet. Please check back soon.');
        return;
      }
      applyConfig(res.config);
      syncCard();
      applyLinkCode();
      if (!last && !reference && $('view-done').hidden) showView('order-form');
    } catch (err) {
      if (!config) showClosed('We could not load the order form', err.message, true);
    }
  }

  $('copy-invoice').addEventListener('click', async function (ev) {
    if (!current) return;
    var btn = ev.currentTarget;
    var ok = await SJ.copyText(SJ.invoiceText(current.order, current));
    btn.textContent = ok ? 'Copied' : 'Press and hold to copy';
    setTimeout(function () { btn.textContent = 'Copy invoice'; }, 1800);
  });
  $('new-order').addEventListener('click', newOrder);
  $('pay-card').addEventListener('click', startCard);
  // Once the customer opens or closes the bank details themselves, leave them as they are.
  $('pay-section').addEventListener('toggle', function () {
    if ($('pay-section').classList.contains('eft--only')) return;
    $('pay-section').dataset.touched = '1';
    // Opening the bank details means they may pay by transfer: Greg is told about the order
    // (he otherwise hears only once it is paid by card), and they get the invoice by email.
    var o = current && current.order;
    if ($('pay-section').open && o && o.status === 'Awaiting payment' && o.email && eftTold !== o.invoice) {
      eftTold = o.invoice;
      SJ.api('payByEft', { invoice: o.invoice, email: o.email }).catch(function () { eftTold = ''; });
    }
  });
  var eftTold = ''; // the order already reported as paying by bank transfer
  $('closed-retry').addEventListener('click', function () {
    showView('view-loading');
    init();
  });

  // The Instagram handle from config.js, in the footer.
  (function footerInstagram() {
    var link = dmLink();
    if (!link) return;
    link.textContent = '@' + String(SJ.cfg.instagram).replace(/^@/, '');
    link.setAttribute('aria-label', 'Supa Juice on Instagram, @' + String(SJ.cfg.instagram).replace(/^@/, ''));
    link.className = 'foot-ig-link';
    $('foot-ig').appendChild(link);
    $('foot-ig').hidden = false;
  })();

  // Tapping a flavour card shows its ingredients; tapping again hides them.
  Array.prototype.forEach.call(document.querySelectorAll('.flav-more'), function (btn) {
    btn.addEventListener('click', function () {
      var card = btn.closest('.flav-card');
      var open = !card.classList.contains('is-open');
      card.classList.toggle('is-open', open);
      btn.setAttribute('aria-expanded', String(open));
    });
  });

  // The floating Instagram button follows the handle in config.js.
  (function floatingInstagram() {
    var handle = String(SJ.cfg.instagram || '').replace(/^@/, '');
    var btn = $('ig-float');
    if (!btn) return;
    if (!handle) { btn.hidden = true; return; }
    btn.href = 'https://www.instagram.com/' + handle + '/';
  })();

  init();
})();
