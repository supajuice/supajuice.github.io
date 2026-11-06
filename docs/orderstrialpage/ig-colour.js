/*
  Trial page: the floating Instagram button matches what it floats over.
  Over a light part of the page (yellow, cream, white) it is blue with a white glyph.
  Over a dark part (the blue strip, the navy footer) it is yellow with a black glyph.
  The colour is read from the page itself, so it keeps working when sections change.
*/
(function () {
  'use strict';

  var button = document.getElementById('ig-float');
  if (!button || !document.elementsFromPoint) return;
  var waiting = false;

  // The first solid background colour at or above an element, as [r, g, b].
  function backgroundOf(el) {
    for (; el && el.nodeType === 1; el = el.parentElement) {
      var c = getComputedStyle(el).backgroundColor;
      var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(c);
      if (m && (m[4] === undefined || Number(m[4]) > 0.5)) return [Number(m[1]), Number(m[2]), Number(m[3])];
    }
    return [255, 255, 255];
  }

  // How light a colour looks, from 0 (black) to 1 (white).
  function lightness(rgb) {
    var lin = rgb.map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }

  function sync() {
    waiting = false;
    if (button.hidden) return;
    var r = button.getBoundingClientRect();
    var under = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).filter(function (el) {
      return el !== button && !button.contains(el) && !el.classList.contains('demo-tag');
    })[0];
    button.classList.toggle('ig-float--on-dark', lightness(backgroundOf(under)) < 0.3);
  }

  function soon() {
    if (waiting) return;
    waiting = true;
    window.requestAnimationFrame(sync);
  }

  window.addEventListener('scroll', soon, { passive: true });
  window.addEventListener('resize', soon);
  window.addEventListener('load', soon);
  soon();
})();
