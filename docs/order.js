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

  var config = null;     // prices and settings, without bank details
  var stepper = null;
  var pending = null;    // { sig, id }: a retry of the same order reuses one request id
  var busy = false;
  var current = null;    // the order response being shown on the done view

  function showView(id) {
    VIEWS.forEach(function (v) { $(v).hidden = v !== id; });
    // "Order below..." only makes sense above the form.
    $('lede').hidden = id !== 'order-form';
  }

  // ---------- Form ----------

  function buildForm() {
    stepper = SJ.qtyStepper({ id: 'qty', label: 'Quantity', max: 20 });
    $('qty-slot').appendChild(stepper.node);
    stepper.onChange(renderTotals);
    $('order-form').addEventListener('submit', onSubmit);
  }

  function applyConfig(c) {
    config = c;
    $('brand').textContent = c.brand;
    document.title = c.brand;
    $('lede').textContent = 'Order below. Pay by bank transfer. We deliver in ' + c.area + '.';
    if (!stepper) buildForm();
    stepper.setMax(c.maxQty);
    stepper.setItem(c.product + ', ' + SJ.money(c.price, c.currency) + ' each');
    $('area-label').textContent = 'My address is in ' + c.area;
    renderTotals();
  }

  function renderTotals() {
    if (!config) return;
    var total = SJ.renderSummary($('summary'), config, stepper.get());
    if (!busy) $('submit').textContent = 'Place order for ' + SJ.money(total, config.currency);
  }

  function readForm() {
    return {
      name: $('name').value.trim(),
      contact: $('contact').value.trim(),
      address: $('address').value.trim(),
      notes: $('notes').value.trim(),
      qty: stepper.get(),
      areaConfirmed: $('area-ok').checked
    };
  }

  function validate(d) {
    if (!d.name) return { id: 'name', message: 'Enter your name.' };
    if (d.contact.length < 3) return { id: 'contact', message: 'Add an Instagram handle or phone number so we can reach you.' };
    if (!d.address) return { id: 'address', message: 'Enter your delivery address.' };
    if (!d.areaConfirmed) return { id: 'area-ok', message: 'Tick the box to confirm your address is in ' + config.area + '.' };
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

    var sig = JSON.stringify([data.name, data.contact, data.address, data.notes, data.qty]);
    if (!pending || pending.sig !== sig) pending = { sig: sig, id: SJ.newRequestId() };

    setSubmitting(true);
    try {
      var res = await SJ.api('order', Object.assign({}, data, {
        requestId: pending.id,
        expectedTotal: SJ.totalFor(data.qty, config.price, config.fee),
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

  function pin(position) {
    return el('span', { class: 'pin pin-' + position, 'aria-hidden': 'true' });
  }

  function showDone(res, restored) {
    current = res;
    var o = res.order;
    var sym = res.currency;
    var bank = res.bank || {};

    $('done-title').textContent = restored ? 'Your last order' : 'Order received';
    var sub = SJ.clear($('done-sub'));
    if (restored) {
      sub.textContent = 'Placed ' + SJ.formatWhen(o.created) + '. If you have already paid, there is nothing more to do.';
    } else {
      sub.appendChild(document.createTextNode('Pay ' + SJ.money(o.total, sym) + ' by bank transfer and use '));
      sub.appendChild(el('span', { class: 'nowrap' }, o.invoice));
      sub.appendChild(document.createTextNode(' as the reference.'));
    }

    var bib = $('bib');
    SJ.clear(bib);
    bib.className = 'bib' + (restored ? '' : ' bib--arrive');
    bib.appendChild(pin('tl'));
    bib.appendChild(pin('tr'));
    bib.appendChild(pin('bl'));
    bib.appendChild(pin('br'));
    bib.appendChild(el('div', { class: 'bib-main' },
      el('p', { class: 'bib-brand' }, res.brand),
      el('p', { class: 'bib-number' }, o.invoice),
      el('p', { class: 'bib-caption' }, 'Your invoice number')));
    bib.appendChild(el('div', { class: 'bib-tear' }, el('span', null, 'Use it as your payment reference')));

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
    if (stepper) stepper.set(1);
    hideError();
    showView(config && config.ready ? 'order-form' : 'view-loading');
    window.scrollTo(0, 0);
    if (!config) init();
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
