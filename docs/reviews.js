// Reviews on the shop page: one at a time, with previous and next buttons.
//
// Gets the reviews Greg has approved from the feedback web app (supajuice/feedback, apps-script/Code.gs,
// GET ?action=reviews). A review shows only when, in the Supa Juice Feedback Sheet, May post,
// Verified buyer and Show on site all say yes. Only the stars, the words, the flavour and what they
// used them for come back: never a name or email.
//
// Each review is shown once. With one review there are no buttons. On a phone you can also swipe,
// and with a keyboard the arrow keys work once the buttons have focus.
// With no approved reviews, or if the feedback web app can't be reached, the section stays hidden.
(function () {
  'use strict';

  // The feedback web app's address: the same one as in the feedback repo's docs/config.js.
  var FEEDBACK = 'https://script.google.com/macros/s/AKfycbyUiaVxfnyA--NNlhBib9JiOsziR_QrnIOLSB7QW_S1DaqWy1cttGLGrXmQtuP7_kIx/exec';

  var section = document.getElementById('reviews');
  var list = document.getElementById('revs-list');
  var prev = document.getElementById('revs-prev');
  var next = document.getElementById('revs-next');
  var count = document.getElementById('revs-count');
  if (!section || !list || !prev || !next || !count || !window.fetch) return;

  var STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.83 5.74 6.33.92-4.58 4.46 1.08 6.3L12 17.25l-5.66 2.97 1.08-6.3-4.58-4.46 6.33-.92z"/></svg>';

  var cards = [];
  var at = 0;

  function card(r, i, total) {
    var li = document.createElement('li');
    li.className = 'rev';
    li.setAttribute('aria-roledescription', 'review');
    li.setAttribute('aria-label', (i + 1) + ' of ' + total);

    var stars = document.createElement('div');
    stars.className = 'rev-stars';
    stars.setAttribute('role', 'img');
    stars.setAttribute('aria-label', r.stars + ' out of 5 stars');
    for (var s = 1; s <= 5; s++) {
      var star = document.createElement('span');
      if (s > r.stars) star.className = 'off';
      star.innerHTML = STAR;
      stars.appendChild(star);
    }

    var text = document.createElement('p');
    text.className = 'rev-text';
    text.textContent = '“' + r.text + '”';

    var meta = document.createElement('p');
    meta.className = 'rev-meta';
    meta.textContent = ['Verified buyer', r.used, r.flavour && r.flavour !== 'Both' ? r.flavour : '']
      .filter(Boolean).join(' · ');

    li.appendChild(stars);
    li.appendChild(text);
    li.appendChild(meta);
    return li;
  }

  function go(i) {
    at = (i + cards.length) % cards.length; // after the last comes the first again
    // All the reviews stay in place, stacked, so the box is as tall as the longest one and
    // nothing jumps. Only the current one is seen, and read out by screen readers.
    cards.forEach(function (c, n) {
      c.classList.toggle('is-off', n !== at);
      c.setAttribute('aria-hidden', n !== at ? 'true' : 'false');
    });
    count.textContent = (at + 1) + ' of ' + cards.length;
  }

  function show(reviews) {
    reviews = (reviews || []).filter(function (r) {
      return r && r.text && r.stars >= 1 && r.stars <= 5;
    });
    if (!reviews.length) return;
    cards = reviews.map(function (r, i) { return card(r, i, reviews.length); });
    cards.forEach(function (c) { list.appendChild(c); });
    var several = cards.length > 1;
    prev.hidden = !several;
    next.hidden = !several;
    count.hidden = !several;
    section.classList.toggle('revs--one', !several);
    go(0);
    section.hidden = false;
  }

  prev.addEventListener('click', function () { go(at - 1); });
  next.addEventListener('click', function () { go(at + 1); });
  section.addEventListener('keydown', function (ev) {
    if (cards.length < 2 || (ev.target !== prev && ev.target !== next)) return;
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); go(at - 1); prev.focus(); }
    if (ev.key === 'ArrowRight') { ev.preventDefault(); go(at + 1); next.focus(); }
  });

  // Swipe left or right on a phone.
  var startX = null;
  list.addEventListener('touchstart', function (ev) { startX = ev.touches[0].clientX; }, { passive: true });
  list.addEventListener('touchend', function (ev) {
    if (startX === null || cards.length < 2) return;
    var dx = ev.changedTouches[0].clientX - startX;
    startX = null;
    if (Math.abs(dx) > 40) go(at + (dx < 0 ? 1 : -1));
  }, { passive: true });

  fetch(FEEDBACK + '?action=reviews')
    .then(function (res) { return res.json(); })
    .then(function (data) { if (data && data.ok) show(data.reviews); })
    .catch(function () { /* leave the section hidden */ });
})();
