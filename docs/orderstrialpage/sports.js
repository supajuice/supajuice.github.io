/* Sports cards: starts the motion in the "Whatever gets you out there" section.
   - .is-ready on the section turns the motion styles on (so with no script, cards just show).
   - .is-in is added once, the first time a card scrolls into view: it rises in and the gel pops.
   - .is-live is on while a card is on screen: the gel pulses and the scene moves.
     It comes off when the card leaves the screen, so nothing animates out of sight.
   Devices that ask for less motion get the still cards (shop.css only animates for the rest). */
(function () {
  'use strict';
  var section = document.getElementById('sports');
  if (!section || !('IntersectionObserver' in window)) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var cards = section.querySelectorAll('.sport');
  section.classList.add('is-ready');

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        e.target.classList.add('is-in', 'is-live');
      } else {
        e.target.classList.remove('is-live');
      }
    });
  }, { threshold: 0.05 });

  for (var i = 0; i < cards.length; i++) io.observe(cards[i]);
})();
