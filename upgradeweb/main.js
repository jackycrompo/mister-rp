/* main.js — page behaviour for the Mister RP landing page.
   Extracted from the inline <script> in index.html.

   Two things happen here:
   1. The price ticker: values wander up and down over time like a
      real market feed, instead of being fixed strings.
   2. Scroll reveal: sections fade in as they enter the viewport.
*/
(function () {
  'use strict';

  /* Each row keeps its opening figure and the recent % move, exactly
     as the original static ticker showed them. From that we derive a
     fixed reference price, then let the live price wander around it. */
  const rows = [
    { loc: "Tampines · 4-room HDB",   start: 598000, unit: "total", openPct:  1.2 },
    { loc: "Bishan · 5-room HDB",     start: 742500, unit: "total", openPct:  0.6 },
    { loc: "River Valley · Condo",    start:   2180, unit: "psf",   openPct: -0.4 },
    { loc: "Punggol · 4-room HDB",    start: 521000, unit: "total", openPct:  2.1 },
    { loc: "Queenstown · 3-room HDB", start: 468000, unit: "total", openPct:  0.3 },
    { loc: "Tanjong Pagar · Condo",   start:   2640, unit: "psf",   openPct: -0.8 },
    { loc: "Woodlands · 5-room HDB",  start: 612000, unit: "total", openPct:  1.5 },
    { loc: "Ang Mo Kio · Executive",  start: 789000, unit: "total", openPct:  0.9 }
  ];

  /* cur = live price (starts at the figure the page always showed).
     open = fixed reference so the % change lines up with openPct. */
  rows.forEach(function (r) {
    r.cur = r.start;
    r.open = r.start / (1 + r.openPct / 100);
  });

  function formatValue(r) {
    if (r.unit === 'psf') {
      const v = Math.round(r.cur / 5) * 5;          // snap psf to nearest $5
      return '$' + v.toLocaleString('en-US') + ' psf';
    }
    const v = Math.round(r.cur / 100) * 100;        // snap totals to nearest $100
    return '$' + v.toLocaleString('en-US');
  }

  function computeDelta(r) {
    const pct = ((r.cur - r.open) / r.open) * 100;
    const up = pct >= 0;
    return { up: up, text: (up ? '+' : '-') + Math.abs(pct).toFixed(1) + '%' };
  }

  function itemHTML(r, idx) {
    const d = computeDelta(r);
    return '' +
      '<div class="ticker-item" data-idx="' + idx + '">' +
        '<span class="loc">' + r.loc + '</span>' +
        '<span class="val">' + formatValue(r) + '</span>' +
        '<span class="delta ' + (d.up ? 'up' : 'down') + '">' +
          (d.up ? '\u25B2' : '\u25BC') + ' ' + d.text +
        '</span>' +
      '</div>';
  }

  function renderTicker() {
    const track = document.getElementById('tickerTrack');
    if (!track) return;
    // Duplicate the set once so the marquee loops seamlessly.
    const seq = rows.concat(rows);
    track.innerHTML = seq
      .map(function (r, i) { return itemHTML(r, i % rows.length); })
      .join('');
  }

  /* One tick: nudge every price with a little random noise plus a gentle
     pull back toward its start value, so figures move believably without
     drifting off. Kept small so digit counts (and layout) stay stable. */
  function step() {
    rows.forEach(function (r) {
      const noise = (Math.random() - 0.5) * 0.006;          // ±0.3%
      const reversion = (r.start - r.cur) / r.start * 0.04; // ease back to start
      r.cur = r.cur * (1 + noise + reversion);
      const lo = r.start * 0.96, hi = r.start * 1.04;       // stay within ±4%
      if (r.cur < lo) r.cur = lo;
      if (r.cur > hi) r.cur = hi;
    });

    // Update every rendered copy of each row in place.
    rows.forEach(function (r, idx) {
      const d = computeDelta(r);
      const nodes = document.querySelectorAll('.ticker-item[data-idx="' + idx + '"]');
      nodes.forEach(function (item) {
        const valEl = item.querySelector('.val');
        const deltaEl = item.querySelector('.delta');
        if (valEl) valEl.textContent = formatValue(r);
        if (deltaEl) {
          deltaEl.textContent = (d.up ? '\u25B2' : '\u25BC') + ' ' + d.text;
          deltaEl.classList.toggle('up', d.up);
          deltaEl.classList.toggle('down', !d.up);
        }
        if (valEl) {                                    // brief green/red flash
          valEl.classList.remove('tick-flash-up', 'tick-flash-down');
          void valEl.offsetWidth;                       // restart the animation
          valEl.classList.add(d.up ? 'tick-flash-up' : 'tick-flash-down');
        }
      });
    });
  }

  function initReveal() {
    const revealEls = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) {
      revealEls.forEach(function (el) { el.classList.add('in'); });
      return;
    }
    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12 });
    revealEls.forEach(function (el) { io.observe(el); });
  }

  function init() {
    renderTicker();
    setInterval(step, 2400);
    initReveal();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
