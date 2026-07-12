/* ============================================================================
   Mister RP — live price ticker (merged)
   ----------------------------------------------------------------------------
   Combines two things that used to live in separate files:

     1. Real anchors: median HDB resale price per town/flat-type, and the
        URA Private Residential Property Price Index, both pulled from
        data.gov.sg's keyless datastore_search endpoint. No API key needed.

     2. Live-feel motion (was main.js): each tick, every displayed price
        wobbles a little around its real anchor and gently eases back,
        so the ticker visibly moves instead of sitting static. The %
        change badge next to each price is NOT touched by this wobble —
        it always reflects the real reported month-over-month (HDB) or
        quarter-over-quarter (URA) change, so we never show a fake stat.

   Only one file renders into #tickerTrack now. Do not also load main.js —
   remove it from index.html and the repo if it's still there, it would
   fight this file over the same element.

   A NOTE ON URA psf DATA
   ----------------------------------------------------------------------------
   Actual per-transaction private prices ("$/psf") live in URA's own Data
   Service (eservice.ura.gov.sg), which needs a secret AccessKey + daily
   Token as headers and is not CORS-enabled — it cannot be called from the
   browser. If you get a URA key, proxy it from your own backend. Until
   then, the keyless Price Index above is the honest live signal.

   ON THE RED CONSOLE ERRORS
   ----------------------------------------------------------------------------
   If data.gov.sg's endpoint doesn't send CORS headers for browser-origin
   requests, the fetch below will fail and Chrome/Firefox will print a red
   network error in the console — that's the browser reporting it, not an
   uncaught exception in this file. It's already caught below, and the
   ticker falls back to sample figures with a note saying so. If you want
   those console errors gone entirely (and real numbers even when the
   browser can't reach data.gov.sg directly), the fix is to fetch the data
   server-side on a schedule (a GitHub Action or your n8n workflow) and
   have this script read a same-origin data.json instead of calling
   data.gov.sg directly. Ask if you want that wired up.
   ============================================================================ */

(function () {
  'use strict';

  var API = 'https://data.gov.sg/api/action/datastore_search';

  var DATASETS = {
    hdbResale: 'd_8b84c4ee58e3cfc0ece0d773c8ca6abc',
    uraPpi:    'd_97f8a2e995022d311c6c68cfda6d034c'
  };

  var HDB_ENTRIES = [
    { town: 'TAMPINES',   flat_type: '4 ROOM',    label: 'Tampines · 4-room HDB' },
    { town: 'BISHAN',     flat_type: '5 ROOM',    label: 'Bishan · 5-room HDB' },
    { town: 'PUNGGOL',    flat_type: '4 ROOM',    label: 'Punggol · 4-room HDB' },
    { town: 'QUEENSTOWN', flat_type: '3 ROOM',    label: 'Queenstown · 3-room HDB' },
    { town: 'SENGKANG',   flat_type: '4 ROOM',    label: 'Sengkang · 4-room HDB' },
    { town: 'BEDOK',      flat_type: '4 ROOM',    label: 'Bedok · 4-room HDB' },
    { town: 'WOODLANDS',  flat_type: '5 ROOM',    label: 'Woodlands · 5-room HDB' },
    { town: 'ANG MO KIO', flat_type: 'EXECUTIVE', label: 'Ang Mo Kio · Executive' }
  ];

  // Used whenever live data can't be reached. `anchor` is numeric so the
  // wobble animation has something real to nudge around.
  var FALLBACK = [
    { loc: 'Tampines · 4-room HDB',    kind: 'money', anchor: 598000, deltaText: '+1.2%', up: true },
    { loc: 'Bishan · 5-room HDB',      kind: 'money', anchor: 742500, deltaText: '+0.6%', up: true },
    { loc: 'Punggol · 4-room HDB',     kind: 'money', anchor: 521000, deltaText: '+2.1%', up: true },
    { loc: 'Queenstown · 3-room HDB',  kind: 'money', anchor: 468000, deltaText: '+0.3%', up: true },
    { loc: 'Sengkang · 4-room HDB',    kind: 'money', anchor: 545000, deltaText: '+0.8%', up: true },
    { loc: 'Bedok · 4-room HDB',       kind: 'money', anchor: 560000, deltaText: '+0.5%', up: true },
    { loc: 'Woodlands · 5-room HDB',   kind: 'money', anchor: 612000, deltaText: '+1.5%', up: true },
    { loc: 'Ang Mo Kio · Executive',   kind: 'money', anchor: 789000, deltaText: '+0.9%', up: true },
    { loc: 'Private Residential · URA', kind: 'index', anchor: 210.4, deltaText: '+0.9%', up: true }
  ];

  var CACHE_KEY = 'misterrp_ticker_v2';
  var CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
  var FETCH_TIMEOUT_MS = 9000;
  var WOBBLE_INTERVAL_MS = 2400;

  var activeItems = []; // whatever is currently on screen (live or fallback), with wobble state

  /* ---------- small helpers ---------------------------------------------- */

  function median(nums) {
    if (!nums.length) return null;
    var s = nums.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function formatMoney(n) {
    var rounded = Math.round(n / 500) * 500; // nearest $500
    return '$' + rounded.toLocaleString('en-US');
  }

  function formatIndex(n) {
    return 'PPI ' + n.toFixed(1);
  }

  function formatValue(item) {
    return item.kind === 'index' ? formatIndex(item.wobble) : formatMoney(item.wobble);
  }

  function pct(now, prev) {
    if (!prev) return { delta: '0.0%', up: true };
    var change = ((now - prev) / prev) * 100;
    var up = change >= 0;
    return { delta: (up ? '+' : '') + change.toFixed(1) + '%', up: up };
  }

  function monthLabel(ym) { // "2026-04" -> "Apr 2026"
    var parts = String(ym).split('-');
    if (parts.length < 2) return String(ym);
    var names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var mi = parseInt(parts[1], 10) - 1;
    return (names[mi] || parts[1]) + ' ' + parts[0];
  }

  function getJSON(url) {
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS) : null;
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (r) {
        if (t) clearTimeout(t);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
  }

  function buildURL(datasetId, extra) {
    var u = API + '?resource_id=' + encodeURIComponent(datasetId);
    for (var k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) {
        u += '&' + k + '=' + encodeURIComponent(extra[k]);
      }
    }
    return u;
  }

  /* ---------- HDB: real median price + real MoM change -------------------- */

  function loadHdbEntry(entry) {
    var url = buildURL(DATASETS.hdbResale, {
      filters: JSON.stringify({ town: entry.town, flat_type: entry.flat_type }),
      sort: 'month desc',
      limit: 400
    });

    return getJSON(url).then(function (json) {
      var rows = (json && json.result && json.result.records) || [];
      if (!rows.length) return null;

      var byMonth = {};
      rows.forEach(function (r) {
        var m = r.month;
        var price = parseFloat(r.resale_price);
        if (!m || isNaN(price)) return;
        (byMonth[m] = byMonth[m] || []).push(price);
      });

      var months = Object.keys(byMonth).sort().reverse();
      if (!months.length) return null;

      function pickFrom(startIdx) {
        for (var i = startIdx; i < months.length; i++) {
          if (byMonth[months[i]].length >= 3) return i;
        }
        return startIdx < months.length ? startIdx : -1;
      }
      var curIdx = pickFrom(0);
      var prevIdx = pickFrom(curIdx + 1);

      var curMedian = median(byMonth[months[curIdx]]);
      var prevMedian = prevIdx >= 0 ? median(byMonth[months[prevIdx]]) : null;
      var mv = pct(curMedian, prevMedian);

      return {
        loc: entry.label,
        kind: 'money',
        anchor: curMedian,
        deltaText: mv.delta,
        up: mv.up,
        _month: months[curIdx]
      };
    });
  }

  /* ---------- URA: real private price index + real QoQ change ------------ */

  function parseQuarterKey(v) {
    var s = String(v);
    var y = s.match(/(19|20)\d{2}/);
    var q = s.match(/[1-4]/g);
    var qm = s.match(/q\s*([1-4])/i) || s.match(/([1-4])\s*q/i);
    if (!y) return NaN;
    var quarter = qm ? parseInt(qm[1], 10) : (q ? parseInt(q[q.length - 1], 10) : 1);
    return parseInt(y[0], 10) * 10 + quarter;
  }

  function loadUraPpi() {
    return getJSON(buildURL(DATASETS.uraPpi, { limit: 1 })).then(function (meta) {
      var fields = (meta && meta.result && meta.result.fields) || [];
      var sample = (meta && meta.result && meta.result.records && meta.result.records[0]) || {};

      var periodField = null, valueField = null;
      fields.forEach(function (f) {
        var id = String(f.id).toLowerCase();
        if (!periodField && (/quarter|period|date|time/.test(id) || /(19|20)\d{2}.*[1-4]/.test(String(sample[f.id])))) {
          periodField = f.id;
        }
        if (!valueField && (/index|value/.test(id) || (f.type && /num|float|int/.test(String(f.type).toLowerCase())))) {
          valueField = f.id;
        }
      });
      if (!periodField && fields[0]) periodField = fields[0].id;
      if (!valueField && fields[1]) valueField = fields[1].id;
      if (!periodField || !valueField) throw new Error('URA PPI: columns not found');

      var url = buildURL(DATASETS.uraPpi, { sort: periodField + ' desc', limit: 200 });
      return getJSON(url).then(function (json) {
        var rows = (json && json.result && json.result.records) || [];
        rows = rows
          .map(function (r) {
            return { period: r[periodField], key: parseQuarterKey(r[periodField]), val: parseFloat(r[valueField]) };
          })
          .filter(function (r) { return !isNaN(r.key) && !isNaN(r.val); })
          .sort(function (a, b) { return b.key - a.key; });

        if (rows.length < 1) return null;
        var cur = rows[0];
        var prev = rows[1] || null;
        var mv = pct(cur.val, prev ? prev.val : null);
        var qLabel = String(cur.period).replace(/\s+/g, ' ').trim();

        return {
          loc: 'Private Residential · URA',
          kind: 'index',
          anchor: cur.val,
          deltaText: mv.delta,
          up: mv.up,
          _quarter: qLabel
        };
      });
    });
  }

  /* ---------- cache (stores anchors, not wobble state) --------------------- */

  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || (Date.now() - obj.ts) > CACHE_TTL_MS) return null;
      return obj;
    } catch (e) { return null; }
  }

  function writeCache(payload) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(payload)); } catch (e) {}
  }

  /* ---------- render + wobble ---------------------------------------------- */

  function itemHTML(item, idx) {
    return '' +
      '<div class="ticker-item" data-idx="' + idx + '">' +
        '<span class="loc">' + item.loc + '</span>' +
        '<span class="val">' + formatValue(item) + '</span>' +
        '<span class="' + (item.up ? 'up' : 'down') + '">' +
          (item.up ? '\u25B2' : '\u25BC') + ' ' + item.deltaText +
        '</span>' +
      '</div>';
  }

  function renderTicker(items) {
    var track = document.getElementById('tickerTrack');
    if (!track) return;
    items.forEach(function (it) { it.wobble = it.anchor; });
    activeItems = items;
    var seq = items.concat(items);
    track.innerHTML = seq.map(function (it, i) { return itemHTML(it, i % items.length); }).join('');
  }

  // One tick: nudge each item's displayed value with small noise plus a
  // gentle pull back toward its real anchor, so figures move believably
  // without drifting away from the real number. The delta badge is left
  // untouched — it's a real reported stat, not something to fake-animate.
  function wobbleStep() {
    activeItems.forEach(function (it, idx) {
      var prevWobble = it.wobble;
      var noise = (Math.random() - 0.5) * 0.006;               // ±0.3%
      var reversion = (it.anchor - it.wobble) / it.anchor * 0.04; // ease back
      it.wobble = it.wobble * (1 + noise + reversion);
      var lo = it.anchor * 0.97, hi = it.anchor * 1.03;          // stay within ±3%
      if (it.wobble < lo) it.wobble = lo;
      if (it.wobble > hi) it.wobble = hi;

      var tickUp = it.wobble >= prevWobble;
      var nodes = document.querySelectorAll('.ticker-item[data-idx="' + idx + '"] .val');
      nodes.forEach(function (valEl) {
        valEl.textContent = formatValue(it);
        valEl.classList.remove('tick-flash-up', 'tick-flash-down');
        void valEl.offsetWidth; // restart the flash
        valEl.classList.add(tickUp ? 'tick-flash-up' : 'tick-flash-down');
        setTimeout(function () {
          valEl.classList.remove('tick-flash-up', 'tick-flash-down');
        }, 700);
      });
    });
  }

  function setNote(text) {
    var note = document.getElementById('tickerNote');
    if (note) note.textContent = text;
  }

  function noteFromItems(items) {
    var hdbMonth = null, uraQ = null;
    items.forEach(function (i) {
      if (i._month && !hdbMonth) hdbMonth = i._month;
      if (i._quarter && !uraQ) uraQ = i._quarter;
    });
    var bits = [];
    if (hdbMonth) bits.push('HDB resale to ' + monthLabel(hdbMonth));
    if (uraQ) bits.push('URA PPI ' + uraQ);
    if (!bits.length) return null;
    return 'Live · ' + bits.join(' · ') + ' — source: data.gov.sg (HDB & URA)';
  }

  /* ---------- orchestration ---------------------------------------------- */

  function loadLive() {
    var jobs = HDB_ENTRIES.map(function (e) {
      return loadHdbEntry(e).catch(function () { return null; });
    });
    jobs.push(loadUraPpi().catch(function () { return null; }));

    return Promise.all(jobs).then(function (results) {
      var items = results.filter(Boolean);
      return items.length >= 4 ? items : null;
    });
  }

  function init() {
    var cached = readCache();
    if (cached && cached.items && cached.items.length) {
      renderTicker(cached.items);
      var cnote = noteFromItems(cached.items);
      if (cnote) setNote(cnote);
    } else {
      renderTicker(FALLBACK);
    }

    setInterval(wobbleStep, WOBBLE_INTERVAL_MS);

    if (cached) return;

    loadLive()
      .then(function (items) {
        if (!items) {
          setNote('Showing sample figures — live HDB/URA data is unavailable right now.');
          return;
        }
        renderTicker(items);
        var n = noteFromItems(items) || 'Live figures — source: data.gov.sg (HDB & URA)';
        setNote(n);
        writeCache({ ts: Date.now(), items: items });
      })
      .catch(function () {
        setNote('Showing sample figures — live HDB/URA data is unavailable right now.');
      });
  }

  /* ---------- scroll-reveal ------------------------------------------------ */

  function initReveal() {
    var revealEls = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) {
      revealEls.forEach(function (el) { el.classList.add('in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12 });
    revealEls.forEach(function (el) { io.observe(el); });
  }

  function boot() { init(); initReveal(); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* ============================================================================
     OPTIONAL: real private $/psf via your own URA proxy — see note at top
     of this file for why it can't be called directly from the browser.
     ============================================================================ */
})();
