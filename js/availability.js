/**
 * WI 64 Self Storage — Live Pricing & Availability
 * Reads data/availability.json and fills in:
 *   • "Starting at $X" on each unit detail card  (#unit-KEY .unit-price)
 *   • the Price/Mo column in the comparison table ([data-table-size="KEY"])
 *   • an availability badge in each card's avail bar (.unit-avail-bar--KEY)
 *   • a "prices updated" timestamp (#price-updated), if present
 *
 * Fails quietly: if the JSON is missing or a price is null, the existing
 * dash is left in place so the page never looks broken.
 */
(function () {
  var JSON_PATH = '/data/availability.json';
  var KEYS = ['8x8', '10x14', '10x20', '10x26'];

  fetch(JSON_PATH, { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) { if (data) apply(data); })
    .catch(function () { /* leave dashes in place */ });

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
    });

    // 4) Timestamp
    var ts = document.getElementById('price-updated');
    if (ts && data.lastUpdated) {
      var d = new Date(data.lastUpdated);
      if (!isNaN(d)) {
        ts.textContent = 'Prices updated ' +
          d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      }
    }
  }
})();
