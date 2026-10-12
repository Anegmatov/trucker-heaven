/*
 * Trucker Heaven site chrome for the booking pages (parking, rentals).
 * Renders the main site's header (icons, hover menus, mobile menu) and footer into
 *   <header class="th-chrome" id="siteHeader" data-th-current="Parking" data-th-my="My Parking|#my-parking|my-parking">
 *   <footer class="th-chrome" data-th-section="Parking">
 * Menu data mirrors app/site.ts + SiteChrome.tsx in the main website repo. Keep them in step.
 *
 * Config (optional, set before this script): window.TH_CHROME = { parent: 'https://truckerheaven.com' }
 * When the page is served as a page of the main site (/parking, /rentals) the parent is the page origin.
 */
(function () {
  'use strict';
  const PARENT = (function () {
    const configured = (window.TH_CHROME && window.TH_CHROME.parent)
      || (window.PARKING_CONFIG && window.PARKING_CONFIG.parentSiteUrl)
      || (window.DriveOpsConfig && window.DriveOpsConfig.PARENT_SITE_URL);
    if (configured) return String(configured).replace(/\/$/, '');
    if (/^\/(parking|rentals)(\/|$)/.test(location.pathname)) return location.origin;
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    return local ? 'http://localhost:5176' : 'https://truckerheaven.com';
  })();
  const PHONE = '+16154705075', PHONE_TEXT = '615-470-5075', ADDRESS = '8037 Eastgate Blvd, Mt. Juliet, TN 37122';

  const ICONS = {
    Parking: '<path d="M3 15V7a1 1 0 0 1 1-1h10v9M14 9h4l3 3v3h-7"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M9 17h6M3 15h2"/>',
    'Truck Service': '<path d="M14.5 5.5a4 4 0 0 0-5.3 5.3L4 16l2 2 5.2-5.2a4 4 0 0 0 5.3-5.3l-2.3 2.3-1.7-1.7z"/><path d="M16 15l4 4"/>',
    'Fleet Services': '<path d="M2 13V8h8v5M10 10h3l2 2v1"/><circle cx="5" cy="15" r="1.6"/><circle cx="13" cy="15" r="1.6"/><path d="M9 19V14h8v5M17 16h3l2 2v1"/><circle cx="12" cy="21" r="1.6"/><circle cx="20" cy="21" r="1.6"/>',
    Rentals: '<path d="M4 14l1.6-4.5A2 2 0 0 1 7.5 8h9a2 2 0 0 1 1.9 1.5L20 14v4H4z"/><circle cx="7.5" cy="16" r="1.4"/><circle cx="16.5" cy="16" r="1.4"/><path d="M4 14h16"/><circle cx="18" cy="5" r="1.5"/><path d="M19 6l2.5 2.5-1.5 1.5"/>',
    'T Heaven Motors': '<path d="M3 15l1.6-4.5A2 2 0 0 1 6.5 9h9a2 2 0 0 1 1.9 1.5L19 15v4H3z"/><circle cx="6.5" cy="17" r="1.4"/><circle cx="15.5" cy="17" r="1.4"/><path d="M3 15h16"/><path d="M15 4h5v5l-3 3-4-4z"/>',
    'Silk Road Grill': '<path d="M4 12h16a8 8 0 0 1-16 0z"/><path d="M8 12V9M12 12V8M16 12V9"/><path d="M9 5c0 1-1 1-1 2M13 4c0 1-1 1-1 2"/><path d="M6 19h12"/>',
    ITIP: '<path d="M12 3l9 4-9 4-9-4z"/><path d="M6 9.5V14c0 1.5 3 3 6 3s6-1.5 6-3V9.5"/><path d="M21 7v5"/>',
    'My Parking': '<path d="M3 15V7a1 1 0 0 1 1-1h10v9M14 9h4l3 3v3h-7"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M9 17h6"/><path d="M19 3v4M17 5h4"/>',
    'My Rental': '<path d="M4 14l1.6-4.5A2 2 0 0 1 7.5 8h9a2 2 0 0 1 1.9 1.5L20 14v4H4z"/><circle cx="7.5" cy="16" r="1.4"/><circle cx="16.5" cy="16" r="1.4"/><path d="M4 14h16"/><path d="M19 3v4M17 5h4"/>'
  };
  const P = path => `${PARENT}${path}`;
  const MENUS = [
    { label: 'Parking', href: P('/parking'), description: 'Daily, weekly and monthly truck parking, reserved online and paid at the office.', image: P('/images/homepage-aerial-real.jpg'), imageAlt: 'Aerial view of the Trucker Heaven parking lot in Mt. Juliet', links: [['Find Parking', P('/parking')], ['My Parking', P('/parking#my-parking')]] },
    { label: 'Truck Service', href: P('/service'), description: 'Truck care and support, together on the property.', image: P('/media/campaign/truck-repair-workshop.jpg'), imageAlt: 'A mechanic at his tools beside a red semi truck in a repair workshop', links: [['Services Offered', P('/service#shop-types-title')], ['Request Service', P('/service#request')]] },
    { label: 'Fleet Services', href: P('/fleet-management'), description: 'Maintenance plans and service support for companies running more than one truck.', image: P('/media/campaign/truck-fleet.jpg'), imageAlt: 'A row of semi trucks in a fleet yard', links: [['Fleet Management Plans', P('/fleet-management')], ['Fleet & Commercial Service', P('/fleet')], ['Fleet Service Bay', P('/service#fleet-service')], ['Get a Fleet Quote', P('/fleet-management#quote')]] },
    { label: 'Rentals', href: P('/rentals'), description: 'Cars and SUVs to rent from the counter at Trucker Heaven. Pick your dates, pay when you pick up.', image: P('/images/homepage-rentals-real.jpg'), imageAlt: 'A rental SUV at Trucker Heaven', links: [['Our Cars', P('/rentals')], ['My Rental', P('/rentals#find')]] },
    { label: 'T Heaven Motors', href: 'https://theavenmotors.com/inventory?clearall=1', description: 'Small-car inventory and dealership appointments.', image: P('/images/homepage-motors-real.jpg'), imageAlt: 'Compact SUV representing T Heaven Motors inventory', links: [['Browse Inventory', 'https://theavenmotors.com/inventory?clearall=1'], ['Contact Dealership', 'https://theavenmotors.com/sendcomments']] },
    { label: 'Silk Road Grill', href: 'https://silkroadgrilltn.com/menu', description: 'Uzbek and Central Asian food at Trucker Heaven.', image: P('/images/homepage-food-real.jpg'), imageAlt: 'Prepared Silk Road Grill dishes', links: [['Menu & Order Online', 'https://silkroadgrilltn.com/menu'], ['Catering', 'https://silkroadgrilltn.com/catering']] },
    { label: 'ITIP', href: P('/itip'), plain: true }
  ];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = name => ICONS[name] ? `<svg class="thc-nav-icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>` : '';
  const external = href => /^https?:/.test(href) && !href.startsWith(PARENT);

  function renderHeader(header) {
    const current = header.dataset.thCurrent || '';
    const [myLabel, myHref, myRoute] = String(header.dataset.thMy || '').split('|');
    const link = (m, extra = '') => {
      const own = m.label === current;
      const href = own ? '#' : m.label === 'My' ? myHref : m.href;
      return `<a class="thc-trigger" href="${esc(href)}" ${own ? 'aria-current="page"' : ''} ${external(m.href) ? 'rel="noopener"' : ''} data-th-menu="${esc(m.label)}" ${extra}>${icon(m.label)}<span>${esc(m.label)}</span></a>`;
    };
    const my = myLabel ? `<a class="thc-trigger thc-my" href="${esc(myHref)}" data-route="${esc(myRoute || '')}" data-nav="${esc(myRoute || '')}">${icon(myLabel)}<span>${esc(myLabel)}</span></a>` : '';
    header.innerHTML = `
      <div class="thc-inner">
        <a class="thc-brand" href="${esc(P('/'))}" aria-label="Trucker Heaven home"><img src="assets/logo.svg" alt="" width="48" height="48"><span class="thc-wordmark" aria-hidden="true"><span>TRUCKER</span><span>HEAVEN</span></span></a>
        <nav class="thc-nav" aria-label="Main navigation">
          <div class="thc-nav-center">${MENUS.map(m => link(m, m.plain ? '' : 'aria-haspopup="true" aria-expanded="false"')).join('')}</div>
          ${my}
          <a class="thc-visit" href="${esc(P('/visit'))}">Visit</a>
        </nav>
        ${myLabel ? `<a class="thc-my thc-mobile-only" href="${esc(myHref)}" data-route="${esc(myRoute || '')}" data-nav="${esc(myRoute || '')}">${esc(myLabel)}</a>` : ''}
        <button class="thc-menu-toggle" type="button" aria-expanded="false" id="menuToggle" aria-controls="mobileMenu" data-th-menu-toggle><span>Menu</span><i aria-hidden="true"></i></button>
      </div>
      <div class="thc-panel" id="thcMegaMenu" aria-hidden="true"></div>
      <div class="thc-scrim" data-th-scrim></div>
      <div class="thc-mobile" id="mobileMenu" hidden data-th-mobile-panel>
        <a href="${esc(P('/'))}">Home</a>
        ${MENUS.map(m => m.plain ? `<a href="${esc(m.href)}">${esc(m.label)}</a>` : `<div class="thc-mobile-group"><button type="button" aria-expanded="false">${esc(m.label)}<span aria-hidden="true">+</span></button><div class="thc-mobile-links" hidden>${m.links.map(([t, h]) => `<a href="${esc(h)}" ${external(h) ? 'rel="noopener"' : ''}>${esc(t)}<span aria-hidden="true">${external(h) ? '↗' : '→'}</span></a>`).join('')}</div></div>`).join('')}
        ${myLabel ? `<a href="${esc(myHref)}" data-route="${esc(myRoute || '')}" data-nav="${esc(myRoute || '')}">${esc(myLabel)}</a>` : ''}
        <a href="${esc(P('/visit'))}">Visit</a>
        <a href="tel:${PHONE}" data-phone-link>Call <span data-phone-text>${PHONE_TEXT}</span></a>
      </div>`;
    wireMenus(header);
  }

  function wireMenus(header) {
    const panel = header.querySelector('#thcMegaMenu'); const scrim = header.querySelector('[data-th-scrim]');
    const triggers = [...header.querySelectorAll('.thc-trigger[aria-haspopup]')];
    let active = null; let closeTimer = null;
    const cancelClose = () => { if (closeTimer) clearTimeout(closeTimer); closeTimer = null; };
    const close = () => {
      cancelClose(); active = null; panel.classList.remove('is-open'); panel.setAttribute('aria-hidden', 'true'); scrim.classList.remove('is-open');
      header.classList.remove('is-menu-open'); triggers.forEach(t => t.setAttribute('aria-expanded', 'false'));
    };
    const scheduleClose = () => { cancelClose(); closeTimer = setTimeout(close, 180); };
    const open = label => {
      cancelClose(); const menu = MENUS.find(m => m.label === label); if (!menu || menu.plain) return;
      if (active === label) return; active = label;
      triggers.forEach(t => t.setAttribute('aria-expanded', String(t.dataset.thMenu === label)));
      panel.innerHTML = `<div class="thc-mega"><img class="thc-mega-image" src="${esc(menu.image)}" alt="${esc(menu.imageAlt)}"><div class="thc-mega-intro"><p>Explore Trucker Heaven</p><h2>${esc(menu.label)}</h2><span>${esc(menu.description)}</span></div><div class="thc-mega-links">${menu.links.map(([t, h]) => `<a href="${esc(h)}" ${external(h) ? 'rel="noopener"' : ''}>${esc(t)}<b aria-hidden="true">${external(h) ? '↗' : '→'}</b></a>`).join('')}</div></div>`;
      panel.classList.add('is-open'); panel.setAttribute('aria-hidden', 'false'); scrim.classList.add('is-open'); header.classList.add('is-menu-open');
    };
    triggers.forEach(t => {
      t.addEventListener('pointerenter', () => open(t.dataset.thMenu));
      t.addEventListener('focus', () => open(t.dataset.thMenu));
      t.addEventListener('click', e => { if (t.getAttribute('aria-current') === 'page') { e.preventDefault(); close(); } });
    });
    header.querySelectorAll('.thc-trigger:not([aria-haspopup]), .thc-visit, .thc-brand').forEach(el => el.addEventListener('pointerenter', scheduleClose));
    header.querySelector('.thc-nav').addEventListener('pointerleave', scheduleClose);
    panel.addEventListener('pointerenter', cancelClose); panel.addEventListener('pointerleave', scheduleClose);
    scrim.addEventListener('click', close); scrim.addEventListener('pointerenter', scheduleClose);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { close(); closeMobile(); } });

    // Mobile menu: the parking app also toggles body.th-menu-open; keep both in step.
    const toggle = header.querySelector('[data-th-menu-toggle]'); const mobile = header.querySelector('#mobileMenu');
    const closeMobile = () => { mobile.hidden = true; toggle.setAttribute('aria-expanded', 'false'); document.body.classList.remove('th-menu-open'); toggle.querySelector('span').textContent = 'Menu'; };
    toggle.addEventListener('click', () => {
      const opening = mobile.hidden; mobile.hidden = !opening; toggle.setAttribute('aria-expanded', String(opening));
      document.body.classList.toggle('th-menu-open', opening); toggle.querySelector('span').textContent = opening ? 'Close' : 'Menu'; if (opening) close();
    });
    mobile.querySelectorAll('.thc-mobile-group > button').forEach(b => b.addEventListener('click', () => {
      const links = b.nextElementSibling; const opening = links.hidden; links.hidden = !opening; b.setAttribute('aria-expanded', String(opening)); b.querySelector('span').textContent = opening ? '−' : '+';
    }));
    mobile.addEventListener('click', e => { if (e.target.closest('a')) closeMobile(); });
    window.TH_CHROME = Object.assign({}, window.TH_CHROME, { closeMobile, closeMenu: close });
  }

  function renderFooter(footer) {
    const section = footer.dataset.thSection || 'Parking';
    const own = section === 'Rentals'
      ? `<h2>Rentals</h2><a href="#cars" data-nav="cars">Our cars</a><a href="#find" data-nav="find">My rental</a>`
      : `<h2>Parking</h2><a href="#parking" data-route="parking">Find Parking</a><a href="#my-parking" data-route="my-parking">My Parking</a>`;
    const tail = section === 'Rentals' ? '<span>Rental counter: <span data-office-hours>Mon–Sat, 8 AM–6 PM</span></span>' : '<span>Truck parking, 24/7</span>';
    footer.innerHTML = `
      <div class="thc-shell">
        <div class="thc-footer-grid">
          <div class="thc-footer-lead">
            <div class="thc-footer-brand"><img class="thc-footer-logo" src="assets/logo.svg" alt="" width="58" height="58"><span class="thc-wordmark" aria-hidden="true"><span>TRUCKER</span><span>HEAVEN</span></span></div>
            <p>One physical and digital ecosystem built around the truck in Mt. Juliet, Tennessee.</p>
            <a href="tel:${PHONE}" data-phone-link id="footerSupportLink"><span data-phone-text>${PHONE_TEXT}</span></a>
            <span data-office-address>${ADDRESS}</span>
          </div>
          <div>${own}<a href="https://www.google.com/maps/search/?api=1&amp;query=8037+Eastgate+Blvd+Mt.+Juliet+TN+37122" target="_blank" rel="noopener" data-directions>Directions</a></div>
          <div><h2>Explore</h2><a href="${esc(P('/visit'))}">Visit Trucker Heaven</a><a href="${esc(P('/services'))}">Services</a><a href="${esc(P('/contact'))}">Contact</a></div>
          <div><h2>Information</h2><a href="${esc(P('/privacy'))}">Privacy Policy</a><a href="${esc(P('/terms'))}">Terms of Use</a><a href="${esc(P('/accessibility'))}">Accessibility</a></div>
        </div>
        <div class="thc-footer-bottom"><span>© <span id="footerYear">${new Date().getFullYear()}</span> Trucker Heaven</span>${tail}</div>
      </div>`;
  }

  document.querySelectorAll('header.th-chrome').forEach(renderHeader);
  document.querySelectorAll('footer.th-chrome').forEach(renderFooter);
  window.TH_CHROME = Object.assign({}, window.TH_CHROME, { parent: PARENT, menus: MENUS });
  if (!window.TH_CHROME.closeMobile) window.TH_CHROME.closeMobile = () => {};
})();
