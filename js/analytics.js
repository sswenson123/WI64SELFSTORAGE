/**
 * WI 64 Self Storage — GA4 + conversion events (event delegation).
 * SETUP: replace GA_ID below with the real Measurement ID (G-XXXXXXXXXX).
 * Until then this file is inert — it loads nothing and tracks nothing.
 *
 * Events:
 *   rent_click      — any "move-in" / reserve link to the storEDGE portal
 *   call_click      — any tel: link
 *   pay_rent_click  — storEDGE login/pay-rent links
 *   waitlist_submit — waitlist form (only exists on some pages; guarded)
 */
(function () {
  var GA_ID = 'G-XXXXXXXXXX';
  if (!/^G-[A-Z0-9]{6,}$/.test(GA_ID) || GA_ID === 'G-XXXXXXXXXX') return;

  // Load gtag
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', GA_ID);

  // One listener catches every matching link on the page
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a');
    if (!a || !a.href) return;
    var href = a.href;
    if (href.indexOf('storedge.com') !== -1) {
      if (href.indexOf('#/login') !== -1) {
        gtag('event', 'pay_rent_click', { link_text: (a.textContent || '').trim().slice(0, 60) });
      } else {
        gtag('event', 'rent_click', { link_text: (a.textContent || '').trim().slice(0, 60) });
      }
    } else if (href.indexOf('tel:') === 0) {
      gtag('event', 'call_click', { phone: href.replace('tel:', '') });
    }
  }, true);

  // Waitlist form — only on some pages
  var wf = document.getElementById('waitlist-form') || document.querySelector('#waitlist-modal form');
  if (wf) {
    wf.addEventListener('submit', function () {
      gtag('event', 'waitlist_submit', {});
    });
  }
})();
