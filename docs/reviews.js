// Reviews carousel on the shop page.
//
// Gets the reviews Greg has approved from the feedback web app (supajuice/feedback, apps-script/Code.gs,
// GET ?action=reviews). A review shows only when, in the Supa Juice Feedback Sheet, May post,
// Verified buyer and Show on site all say yes. Only the stars, the words, the flavour and what they
// used them for come back: never a name or email.
//
// With no approved reviews, or if the feedback web app can't be reached, the section stays hidden.
(function () {
  'use strict';

  // The feedback web app's address: the same one as in the feedback repo's docs/config.js.
  var FEEDBACK = 'https://script.google.com/macros/s/AKfycbyUiaVxfnyA--NNlhBib9JiOsziR_QrnIOLSB7QW_S1DaqWy1cttGLGrXmQtuP7_kIx/exec';

  var section = document.getElementById('reviews');
  var track = document.getElementById('revs-track');
  var viewport = document.getElementById('revs-viewport');
  if (!section || !track || !viewport || !window.fetch) return;

  var STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.83 5.74 6.33.92-4.58 4.46 1.08 6.3L12 17.25l-5.66 2.97 1.08-6.3-4.58-4.46 6.33-.92z"/></svg>';

  function card(r, copy) {
    var li = document.createElement('li');
    li.className = 'rev';
    if (copy) li.setAttribute('aria-hidden', 'true');

    var stars = document.createElement('div');
    stars.className = 'rev-stars';
    stars.setAttribute('role', 'img');
    stars.setAttribute('aria-label', r.stars + ' out of 5 stars');
    for (var i = 1; i <= 5; i++) {
      var s = document.createElement('span');
      if (i > r.stars) s.className = 'off';
      s.innerHTML = STAR;
      stars.appendChild(s);
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

  function show(reviews) {
    reviews = (reviews || []).filter(function (r) {
      return r && r.text && r.stars >= 1 && r.stars <= 5;
    });
    if (!reviews.length) return;
    // A short list is repeated so the track is always wider than the screen.
    var set = reviews.slice();
    while (set.length < 6) set = set.concat(reviews);
    set.forEach(function (r) { track.appendChild(card(r, false)); });
    set.forEach(function (r) { track.appendChild(card(r, true)); }); // the second copy, for the loop
    // About 7 seconds a card, whatever the number of reviews.
    section.style.setProperty('--revs-time', (set.length * 7) + 's');
    section.hidden = false;
    section.classList.add('is-moving');
  }

  // Phones have no hover: holding a finger on the carousel pauses it.
  viewport.addEventListener('touchstart', function () { viewport.classList.add('is-held'); }, { passive: true });
  ['touchend', 'touchcancel'].forEach(function (ev) {
    viewport.addEventListener(ev, function () { viewport.classList.remove('is-held'); }, { passive: true });
  });

  fetch(FEEDBACK + '?action=reviews')
    .then(function (res) { return res.json(); })
    .then(function (data) { if (data && data.ok) show(data.reviews); })
    .catch(function () { /* leave the section hidden */ });
})();
