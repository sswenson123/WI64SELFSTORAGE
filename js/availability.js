/**
 * WI 64 Self Storage — LIVE Pricing & Availability
 * Fetches StorEdge's unit-groups API directly in the browser (CORS-open — it
 * reflects the site origin), so prices and availability are ALWAYS current.
 * No scraper, no cron, no cached file to go stale.
 *
 * Fills in on /units:
 *   • "Starting at $X" on each unit detail card  (#unit-KEY .unit-price)
 *   • the Price/Mo column in the comparison table ([data-table-size="KEY"])
 *   • an availability badge in each card's avail bar (.unit-avail-bar--KEY)
 *   • routes each size's CTA to the waitlist when full, Rent link when open
 *   • a "prices updated" timestamp (#price-updated)
 *
 * Fails quietly: if the API is unreachable the existing page values stay.
 */
(function () {
  var API_URL = 'https://rental-center.storedge.com/v1/facilities/c621f5d9-15d0-4cc0-b26f-d4aa778139e7/unit-groups';
  var KEYS = ['8x8', '10x14', '10x20', '10x26'];

  // StorEdge size (any dimension order, e.g. "20x10") → this site's unit key.
  var CANON_TO_KEY = { '8x8': '8x8', '10x14': '10x14', '10x20': '10x20', '10x26': '10x26' };
  function canon(size) {
    var n = (String(size).toLowerCase().match(/\d+/g) || []).map(Number);
    if (n.length < 2) return null;
    n.sort(function (a, b) { return b - a; });
    return n.slice(0, 2).sort(function (a, b) { return a - b; }).join('x');
  }

  // Turn the live API payload into the { units, lastUpdated } shape apply() expects.
  function buildData(raw) {
    var groups = Array.isArray(raw) ? raw : Object.keys(raw).map(function (k) { return raw[k]; });
    var units = {};
    groups.forEach(function (g) {
      var key = CANON_TO_KEY[canon(g.size)];
      if (!key) return;
      units[key] = {
        price: (g.price != null ? '$' + g.price : null),
        available: (g.available_units_count || 0) > 0
      };
    });
    return { units: units, lastUpdated: new Date().toISOString() };
  }

  fetch(API_URL)
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (raw) { if (raw) apply(buildData(raw)); })
    .catch(function () { /* leave existing page values in place */ });

  function apply(data) {
    var units = data.units || {};

    KEYS.forEach(function (key) {
      var u = units[key];
      if (!u) return;

      // 1) Price on the detail card
      var card = document.getElementById('unit-' + key);
      if (card) {
        var priceEl = card.querySelector('.unit-price');
        if (priceEl && u.price) priceEl.textContent = u.price;

        // 2) Availability badge in the card's avail bar
        var bar = card.querySelector('.unit-avail-bar--' + key);
        if (bar) {
          bar.textContent = u.available ? 'Available now' : 'Currently full — join the waitlist';
          bar.className = 'unit-avail-bar unit-avail-bar--' + key +
            ' avail-badge ' + (u.available ? 'avail-yes' : 'avail-no');
        }
      }

      // 3) Price in the comparison table
      var cell = document.querySelector('[data-table-size="' + key + '"]');
      if (cell && u.price) cell.textContent = u.price;

      // 4) Route this size's Reserve/Rent CTAs: waitlist when full, rent link when open
      document.querySelectorAll('.unit-cta-' + key).forEach(function (cta) {
        if (!cta.dataset.origHref) {
          cta.dataset.origHref = cta.getAttribute('href');
          cta.dataset.origText = cta.textContent;
        }
        if (!u.available && typeof window.openWaitlist === 'function') {
          cta.textContent = 'Join the Waitlist →';
          cta.setAttribute('href', '#');
          cta.onclick = function (e) { e.preventDefault(); window.openWaitlist(key); };
        } else if (u.available) {
          cta.textContent = cta.dataset.origText;
          cta.setAttribute('href', cta.dataset.origHref);
          cta.onclick = null;
        }
      });
    });

    // 5) Timestamp — live feed, stamp with today.
    var ts = document.getElementById('price-updated');
    if (ts) {
      ts.textContent = 'Prices & availability updated live — ' +
        new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  }
})();
