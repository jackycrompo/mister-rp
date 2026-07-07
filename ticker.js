/* ============================================================================
   Mister RP — live price ticker
   ----------------------------------------------------------------------------
   Pulls real figures from Singapore government open data and scrolls them
   left-to-right. No API key required for anything in this file.

   Sources (all via data.gov.sg's keyless datastore_search endpoint):
     • HDB resale flat prices, Jan-2017 onwards
       dataset d_8b84c4ee58e3cfc0ece0d773c8ca6abc
       → real median resale price per town + flat type, and the real
         month-over-month change.
     • URA Private Residential Property Price Index (2009-Q1 = 100), quarterly
       dataset d_97f8a2e995022d311c6c68cfda6d034c
       → real private-market index level and the real quarter-over-quarter
         change.

   A NOTE ON URA psf DATA
   ----------------------------------------------------------------------------
   Actual per-transaction private prices (i.e. "$/psf") live in URA's own
   Data Service (eservice.ura.gov.sg). That API needs a secret AccessKey +
   a daily Token sent as request headers, so it CANNOT be called from the
   browser: the key would be exposed to every visitor and the endpoint is not
   CORS-enabled. If you have a URA key, proxy it from your own backend and
   fetch that proxy here instead — see the commented stub at the bottom.

   RESILIENCE
   ----------------------------------------------------------------------------
   The ticker paints instantly with the last-known sample values so it is
   never empty, then quietly swaps in live data when it arrives. If the network
   fails, CORS blocks the request, or you hit the rate limit, it simply keeps
   the sample values. Results are cached in localStorage for a few hours so
   repeat visits don't re-hit the API (HDB data only changes monthly).
   ============================================================================ */

(function () {
  'use strict';

  var API = 'https://data.gov.sg/api/action/datastore_search';

  var DATASETS = {
    hdbResale: 'd_8b84c4ee58e3cfc0ece0d773c8ca6abc',
    uraPpi:    'd_97f8a2e995022d311c6c68cfda6d034c'
  };

  // HDB entries to show. `town` and `flat_type` must match the dataset's
  // spelling exactly (towns are UPPERCASE; flat types like "4 ROOM").
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

  // Shown if live data can't be reached — same illustrative values the page
  // originally shipped with, so nothing ever looks broken.
  var FALLBACK = [
    { loc: 'Tampines · 4-room HDB',   val: '$598,000',  delta: '+1.2%', up: true },
    { loc: 'Bishan · 5-room HDB',     val: '$742,500',  delta: '+0.6%', up: true },
    { loc: 'Punggol · 4-room HDB',    val: '$521,000',  delta: '+2.1%', up: true },
    { loc: 'Queenstown · 3-room HDB', val: '$468,000',  delta: '+0.3%', up: true },
    { loc: 'Sengkang · 4-room HDB',   val: '$545,000',  delta: '+0.8%', up: true },
    { loc: 'Bedok · 4-room HDB',      val: '$560,000',  delta: '+0.5%', up: true },
    { loc: 'Woodlands · 5-room HDB',  val: '$612,000',  delta: '+1.5%', up: true },
    { loc: 'Ang Mo Kio · Executive',  val: '$789,000',  delta: '+0.9%', up: true },
    { loc: 'Private Residential · URA', val: 'PPI 210.4', delta: '+0.9%', up: true }
  ];

  var CACHE_KEY = 'misterrp_ticker_v1';
  var CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
  var FETCH_TIMEOUT_MS = 9000;

  /* ---------- small helpers ---------------------------------------------- */

  function median(nums) {
    if (!nums.length) return null;
    var s = nums.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function money(n) {
    // round to the nearest $500 so the ticker reads cleanly (e.g. $597,500)
    var rounded = Math.round(n / 500) * 500;
    return '$' + rounded.toLocaleString('en-US');
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

  // fetch with a timeout so a hung request can't stall the ticker forever
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

      // group resale_price by month
      var byMonth = {};
      rows.forEach(function (r) {
        var m = r.month;
        var price = parseFloat(r.resale_price);
        if (!m || isNaN(price)) return;
        (byMonth[m] = byMonth[m] || []).push(price);
      });

      // distinct months, newest first
      var months = Object.keys(byMonth).sort().reverse();
      if (!months.length) return null;

      // pick the newest month with a usable sample, and the previous such month
      function pickFrom(startIdx) {
        for (var i = startIdx; i < months.length; i++) {
          if (byMonth[months[i]].length >= 3) return i;
        }
        return startIdx < months.length ? startIdx : -1; // fall back to whatever exists
      }
      var curIdx = pickFrom(0);
      var prevIdx = pickFrom(curIdx + 1);

      var curMedian = median(byMonth[months[curIdx]]);
      var prevMedian = prevIdx >= 0 ? median(byMonth[months[prevIdx]]) : null;
      var mv = pct(curMedian, prevMedian);

      return {
        loc: entry.label,
        val: money(curMedian),
        delta: mv.delta,
        up: mv.up,
        _month: months[curIdx]
      };
    });
  }

  /* ---------- URA: real private price index + real QoQ change ------------ */
  // Column names on this dataset aren't guaranteed, so detect them from the
  // returned schema (a period-like text field + a numeric index field).

  function parseQuarterKey(v) { // "2026-Q1" / "2026 1Q" / "2026Q1" -> 20261
    var s = String(v);
    var y = s.match(/(19|20)\d{2}/);
    var q = s.match(/[1-4]/g); // last single digit 1-4 that appears near a Q
    var qm = s.match(/q\s*([1-4])/i) || s.match(/([1-4])\s*q/i);
    if (!y) return NaN;
    var quarter = qm ? parseInt(qm[1], 10) : (q ? parseInt(q[q.length - 1], 10) : 1);
    return parseInt(y[0], 10) * 10 + quarter;
  }

  function loadUraPpi() {
    // First pull the schema + a sample to identify the columns.
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
      // last-ditch guesses
      if (!periodField && fields[0]) periodField = fields[0].id;
      if (!valueField && fields[1]) valueField = fields[1].id;
      if (!periodField || !valueField) throw new Error('URA PPI: columns not found');

      // Sort the whole series by the detected period, newest first.
      var url = buildURL(DATASETS.uraPpi, { sort: periodField + ' desc', limit: 200 });
      return getJSON(url).then(function (json) {
        var rows = (json && json.result && json.result.records) || [];
        // Re-sort client-side by a parsed quarter key so we don't depend on the
        // server's lexical ordering matching chronological order.
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
          val: 'PPI ' + cur.val.toFixed(1),
          delta: mv.delta,
          up: mv.up,
          _quarter: qLabel
        };
      });
    });
  }

  /* ---------- cache ------------------------------------------------------- */

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

  /* ---------- render ----------------------------------------------------- */

  function renderTicker(items) {
    var track = document.getElementById('tickerTrack');
    if (!track) return;
    // Duplicate the list once: the CSS animation translates the track by -50%,
    // so two identical copies produce a seamless loop for any item count.
    var html = items.concat(items).map(function (d) {
      return '' +
        '<div class="ticker-item">' +
          '<span class="loc">' + d.loc + '</span>' +
          '<span>' + d.val + '</span>' +
          '<span class="' + (d.up ? 'up' : 'down') + '">' +
            (d.up ? '\u25B2' : '\u25BC') + ' ' + d.delta +
          '</span>' +
        '</div>';
    }).join('');
    track.innerHTML = html;
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
      // Require a reasonable amount of real data before replacing the sample,
      // otherwise keep the fallback so the ticker never looks half-empty.
      return items.length >= 4 ? items : null;
    });
  }

  function init() {
    // 1) Paint immediately so the band is never blank and starts scrolling.
    var cached = readCache();
    if (cached && cached.items && cached.items.length) {
      renderTicker(cached.items);
      var cnote = noteFromItems(cached.items);
      if (cnote) setNote(cnote);
    } else {
      renderTicker(FALLBACK);
    }

    // 2) Fetch live data (skip the network if the cache is still fresh).
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

  /* ---------- scroll-reveal (unchanged, moved out of index.html) ---------- */

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
     OPTIONAL: real private $/psf via your own URA proxy
     ----------------------------------------------------------------------------
     URA's Data Service returns transaction-level private prices (from which you
     can derive $/psf), but it needs an AccessKey + daily Token as headers and
     is not CORS-enabled — so it must be called server-side, never here.

     Deploy a tiny backend (e.g. a serverless function) that:
       1. keeps your URA AccessKey secret,
       2. once a day fetches a Token:
            GET https://eservice.ura.gov.sg/uraDataService/insertNewToken/v1
            header: AccessKey: <your key>
       3. calls the transactions endpoint with AccessKey + Token:
            GET https://eservice.ura.gov.sg/uraDataService/invokeUraDS/v1
                ?service=PMI_Resi_Transaction&batch=1
       4. returns JSON your page can read from the same origin.

     Then replace loadUraPpi() with a fetch of YOUR proxy, e.g.:

       function loadUraPsf() {
         return getJSON('/api/ura-transactions').then(function (json) {
           // aggregate json into { loc, val: '$X,XXX psf', delta, up }
         });
       }

     Until then, the keyless URA Price Index above is the honest live signal.
     ============================================================================ */
})();
