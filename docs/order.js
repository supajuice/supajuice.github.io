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
  var stepper = null;
  var pending = null;    // { sig, id }: a retry of the same order reuses one request id
  var busy = false;
  var current = null;    // the order response being shown on the done view
  var photo = null;      // { version, alt, width, height } from the config, or null
  var choice = null;     // 'collect' or 'deliver', null until the customer picks one

  function showView(id) {
    VIEWS.forEach(function (v) { $(v).hidden = v !== id; });
    // "Order below..." and the photo only make sense above the form.
    $('lede').hidden = id !== 'order-form';
    $('photo').hidden = !photo || id !== 'order-form';
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

  function buildForm() {
    stepper = SJ.qtyStepper({ id: 'qty', label: 'Quantity', max: 20 });
    $('qty-slot').appendChild(stepper.node);
    stepper.onChange(renderTotals);
    $('order-form').addEventListener('submit', onSubmit);
    $('choose-collect').addEventListener('click', function () { choose('collect'); });
    $('choose-deliver').addEventListener('click', function () { choose('deliver'); });
    $('choose-change').addEventListener('click', function () {
      var was = choice;
      choice = null;
      hideError();
      syncFulfil();
      $(was === 'collect' ? 'choose-collect' : 'choose-deliver').focus();
    });
    $('collect-day').addEventListener('change', function () { fillTimes(''); });
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
    return !!(config && config.quote) && !collecting();
  }

  // An older order service sends no collection times. Collection then works without one.
  function slotsOn() {
    return !!(config && Array.isArray(config.collectSlots));
  }

  function deliveryText(c) {
    if (c.quote) return c.fee > 0 ? 'From ' + SJ.money(c.fee, c.currency) : 'Fee confirmed after you order';
    return c.fee > 0 ? SJ.money(c.fee, c.currency) : 'Free';
  }

  function syncFulfil() {
    var collect = collecting();
    var place = config ? config.collectNote : '';
    $('choose').hidden = !!choice;
    $('chosen').hidden = !choice;
    $('order-rest').hidden = !choice;
    $('choose-collect').setAttribute('aria-pressed', String(collect));
    $('choose-deliver').setAttribute('aria-pressed', String(choice === 'deliver'));
    if (config) {
      $('choose-collect-sub').textContent = 'Free' + (place ? ' · ' + place : '');
      $('choose-deliver-sub').textContent = deliveryText(config);
    }
    $('chosen-text').textContent = collect ? 'Collect' + (place ? ' from ' + place : '') : 'Get delivered';
    $('address-field').hidden = collect;
    $('collect-time').hidden = !collect || !slotsOn();
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
    document.title = c.brand;
    $('lede').textContent = 'Order below. Pay by bank transfer. We deliver, or you can collect.';
    if (!stepper) buildForm();
    stepper.setRange(c.minQty, c.maxQty);
    stepper.setItem(SJ.itemLine(c));
    renderSlots();
    syncFulfil();
    applyPhoto(c.photo || null);
  }

  function renderTotals() {
    if (!config) return;
    var quote = quoting();
    var total = SJ.renderSummary($('summary'), config, stepper.get(), { collect: collecting(), quote: quote });
    if (!busy) $('submit').textContent = (quote ? 'Send order for ' : 'Place order for ') + SJ.money(total, config.currency) + (quote ? ' + delivery' : '');
    $('next-note').textContent = quote
      ? 'Next we work out the delivery fee for your address and email your invoice with the bank details. There is nothing to pay yet.'
      : 'Next you will see the bank details and your invoice number. Use the invoice number as your payment reference.';
  }

  function readForm() {
    return {
      name: $('name').value.trim(),
      email: $('email').value.trim(),
      contact: $('contact').value.trim(),
      address: $('address').value.trim(),
      notes: $('notes').value.trim(),
      qty: stepper.get(),
      collect: collecting(),
      collectAt: collecting() && $('collect-day').value && $('collect-hour').value
        ? $('collect-day').value + ' ' + $('collect-hour').value : ''
    };
  }

  function validate(d) {
    if (d.collect && slotsOn()) {
      if (!config.collectSlots.length) return { id: 'choose-change', message: 'No collection times are free right now. Choose delivery, or send us a DM.' };
      if (!$('collect-day').value) return { id: 'collect-day', message: 'Pick a day to collect.' };
      if (!d.collectAt) return { id: 'collect-hour', message: 'Pick a time to collect.' };
    }
    if (!d.name) return { id: 'name', message: 'Enter your name.' };
    if (!d.email) return { id: 'email', message: 'Enter your email address so we can send your invoice.' };
    if (!SJ.isEmail(d.email)) return { id: 'email', message: 'Check your email address. It should look like name@example.com.' };
    if (d.collect) return null;
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
    if (on) $('submit').textContent = 'Placing order…';
    else renderTotals();
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    if (busy || !config) return;
    hideError();

    var data = readForm();
    var problem = validate(data);
    if (problem) {
      showError(problem.message);
      $(problem.id).focus();
      return;
    }

    // A collection order does not send the address that is hidden on the form.
    if (data.collect) data.address = '';
    var sig = JSON.stringify([data.name, data.email, data.contact, data.address, data.notes, data.qty, data.collect, data.collectAt]);
    if (!pending || pending.sig !== sig) pending = { sig: sig, id: SJ.newRequestId() };

    setSubmitting(true);
    try {
      var res = await SJ.api('order', Object.assign({}, data, {
        requestId: pending.id,
        // The total the customer was shown: without a fee for collection, or for a request.
        expectedTotal: SJ.totalFor(data.qty, config.price, data.collect || config.quote ? 0 : config.fee),
        website: $('website').value
      }));
      pending = null;
      SJ.store.set(LAST_KEY, { savedAt: Date.now(), data: res });
      showDone(res, false);
    } catch (err) {
      onOrderError(err);
    } finally {
      setSubmitting(false);
    }
  }

  function onOrderError(err) {
    if (err.code === 'price_changed' && err.data && err.data.config) {
      pending = null;
      SJ.store.set(CONFIG_KEY, err.data.config);
      applyConfig(err.data.config);
      showError('The price has just changed. Check the new total, then place your order again.');
    } else if (err.code === 'slot_taken' && err.data && err.data.config) {
      // Someone else booked the time first. The free times come back with the error.
      pending = null;
      SJ.store.set(CONFIG_KEY, err.data.config);
      applyConfig(err.data.config);
      showError(err.message);
      $($('collect-day').value ? 'collect-hour' : 'collect-day').focus();
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
    $('pay-section').hidden = request;
    $('copy-invoice').hidden = request;
    $('done-keep').textContent = 'Take a screenshot of this page to keep your ' + (request ? 'order' : 'invoice') + ' number.';

    $('done-title').textContent = request
      ? (restored ? 'Your last request' : 'Order request sent')
      : (restored ? 'Your last order' : 'Order received');
    var sub = SJ.clear($('done-sub'));
    if (request) {
      sub.textContent = restored
        ? 'Sent ' + SJ.formatWhen(o.created) + '. We will email your invoice once the delivery fee is confirmed.'
        : 'We will work out the delivery fee for your address and email your invoice to ' + o.email +
          ' with the bank details. There is nothing to pay yet.';
    } else if (restored) {
      sub.textContent = 'Placed ' + SJ.formatWhen(o.created) + '. If you have already paid, there is nothing more to do.';
    } else {
      sub.appendChild(document.createTextNode('Pay ' + SJ.money(o.total, sym) + ' by bank transfer and use '));
      sub.appendChild(el('span', { class: 'nowrap' }, o.invoice));
      sub.appendChild(document.createTextNode(' as the reference.'));
    }

    var emailNote = $('done-email');
    emailNote.hidden = restored || request || !o.email;
    if (o.emailedOn) emailNote.textContent = 'We have emailed your invoice to ' + o.email + '. Check your spam folder if it is not there.';
    else emailNote.textContent = 'We could not email your invoice just now. Take a screenshot of this page instead.';

    var collectNote = $('done-collect');
    collectNote.hidden = !o.collect;
    var place = res.collectNote ? ' from ' + res.collectNote : '';
    if (!o.collect) collectNote.textContent = '';
    else if (o.collectAt) collectNote.textContent = 'Collect on ' + SJ.formatWhen(o.collectAt) + place + '. A calendar invite is emailed once your payment is confirmed.';
    else collectNote.textContent = 'You are collecting this order' + place + '. We will DM you to arrange a time.';

    var bib = $('bib');
    SJ.clear(bib);
    bib.className = 'bib' + (restored ? '' : ' bib--arrive');
    bib.appendChild(el('div', { class: 'bib-main' },
      el('p', { class: 'bib-brand' }, res.brand),
      el('p', { class: 'bib-number' }, o.invoice),
      el('p', { class: 'bib-caption' }, request ? 'Your order number' : 'Your invoice number')));
    bib.appendChild(el('div', { class: 'bib-tear' }, el('span', null, request ? 'Mention it if you contact us' : 'Use it as your payment reference')));

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

    showView('view-done');
    window.scrollTo(0, 0);
    $('done-title').focus({ preventScroll: true });
  }

  function newOrder() {
    SJ.store.remove(LAST_KEY);
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

    if (last) showDone(last.data, true);
    else if (config) showView('order-form');
    else showView('view-loading');

    try {
      var res = await SJ.api('config');
      SJ.store.set(CONFIG_KEY, res.config);
      if (!res.config.ready) {
        if (!last) showClosed('Ordering opens soon', 'We are not taking orders on this page yet. Please check back soon.');
        return;
      }
      applyConfig(res.config);
      if (!last && $('view-done').hidden) showView('order-form');
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
  $('closed-retry').addEventListener('click', function () {
    showView('view-loading');
    init();
  });

  init();
})();
