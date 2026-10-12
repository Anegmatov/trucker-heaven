(() => {
  'use strict';

  const apiClient = window.ParkingAdminApi;
  const adminRoutes = window.ParkingAdminRoutes;
  const adminCore = window.ParkingAdminCore;
  if (!adminRoutes) throw new Error('ParkingOps route registry failed to load.');
  if (!adminCore) throw new Error('ParkingOps shared admin utilities failed to load.');
  const configEntities = ['locations', 'zones', 'categories', 'closures'];
  const configMeta = {
    closures: { singular: 'closure', listId: 'closuresList' }
  };
  const configState = Object.fromEntries(configEntities.map(name => [name, []]));
  let adminUsers = [];
  const knownStatuses = new Set(['PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED']);
  let currentBooking;
  let currentUser;
  let currentView = 'dashboard';
  const reservationState = { bookings: [], tab: 'all', listGate: adminCore.createRequestGate(), detailGate: adminCore.createRequestGate() };
  const configUi = { dirty: { business: false, policies: false, closures: false }, activeTab: 'property', baselines: {} };
  const layoutState = { locations: [], location: null, draft: null, published: null, baseline: null, selectedId: null, selectedIds: new Set(), configDirty: false, geometryDirty: false, zoom: 1, userZoomed: false, drag: null, pan: null, tool: 'select', history: [], future: [], previewRestore: null, editLayout: false, canonicalMaintenanceLocked: false, ratePlans: [], ratePlanDialogTrigger: null };
  const dialogState = { reassignmentTrigger: null, statusTrigger: null, submitting: false };
  let operationalLocations = [];
  const liveState = { data: null, selectedId: null, evaluatedAt: null, requestedAt: null, loading: false, zoom: 1, userZoomed: false, pan: null,
    detail: null, detailLoading: false, timeline: null, timelineLoading: false, search: null, searchLoading: false,
    searchTimer: null, searchError: '', lastFocus: null, fittedLayoutId: null,
    snapshotGate: adminCore.createRequestGate(), detailGate: adminCore.createRequestGate(), timelineGate: adminCore.createRequestGate(), searchGate: adminCore.createRequestGate(),
    filters: { operationalStatus: '', parkingUse: '', vehicleCategoryId: '', availableOnly: false, issuesOnly: false, futureOnly: false, monthlyOnly: false },
    filterOptions: { vehicles: [], uses: [] } };
  let routeTransitioning = false;
  let routeRequestId = 0;
  let activeRefresh = null;

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const isOwner = () => currentUser?.role === 'OWNER';
  const vehicleType = value => ({ BOBTAIL: 'Bobtail', TRACTOR_ONLY: 'Tractor Only', TRAILER_ONLY: 'Trailer Only', TRACTOR_TRAILER: 'Tractor + Trailer' }[value] || String(value || '').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase()));
  const friendlyState = value => String(value || 'Unknown').replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, letter => letter.toUpperCase());
  const assignmentPresentation = booking => {
    if (booking?.assignment_mode_snapshot === 'ZONE_CAPACITY') return {
      area: true, monthly: false, model: 'Area parking',
      detail: `${booking.category_name || 'Parking Area'} · no numbered position`
    };
    if (booking?.assignment_mode_snapshot === 'CUSTOMER_SELECTED_SPOT') return {
      area: false, monthly: true, model: 'Customer-selected monthly position',
      detail: booking.assigned_spot_label ? `Position ${booking.assigned_spot_label}` : 'Selected position unavailable'
    };
    return {
      area: false, monthly: false, model: 'Historical automatic exact position',
      detail: booking?.assigned_spot_label ? `Position ${booking.assigned_spot_label}` : 'Historical assignment unavailable'
    };
  };

  function date(value) {
    if (!value) return '—';
    const timezone = layoutState.location?.timezone || liveState.data?.location?.timezone || canonicalLocation()?.timezone || 'America/Chicago';
    try { return adminCore.formatInZone(value, timezone); } catch (_) { return '—'; }
  }

  function dateForInput(value) {
    if (!value) return '';
    try { return adminCore.formatDateTimeLocal(value, canonicalLocation()?.timezone || 'America/Chicago'); } catch (_) { return ''; }
  }

  function displayNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString() : '—';
  }

  function money(cents) {
    const value = Number(cents);
    return Number.isFinite(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value / 100) : '—';
  }

  function centsForInput(cents) {
    if (cents === null || cents === undefined || cents === '') return '';
    const value = Number(cents);
    return Number.isFinite(value) ? (value / 100).toFixed(2) : '';
  }

  function statusBadge(status) {
    const className = knownStatuses.has(status) ? ` ${status}` : '';
    return `<span class="badge${className}">${esc(status ? friendlyState(status) : '—')}</span>`;
  }

  function activePill(active) {
    return `<span class="state ${active ? 'is-active' : 'is-inactive'}">${active ? 'Active' : 'Inactive'}</span>`;
  }

  function noteVisibilityBadge(visibility) {
    const customerVisible = visibility === 'CUSTOMER';
    return `<span class="note-visibility ${customerVisible ? 'customer-visible' : 'internal-only'}">${customerVisible ? 'Customer-visible' : 'Internal'}</span>`;
  }

  function priceSnapshot(snapshot, adjustments = []) {
    let details = snapshot;
    if (typeof details === 'string') {
      try { details = JSON.parse(details); } catch (_) { details = null; }
    }
    if (!details || typeof details !== 'object' || Array.isArray(details)) return '<section class="detail-section price-snapshot"><h3>Immutable price snapshot</h3><p class="empty">Price snapshot unavailable.</p></section>';
    const duration = details.duration ? `${details.duration}${details.units !== undefined && details.units !== null ? ` · ${displayNumber(details.units)} unit${Number(details.units) === 1 ? '' : 's'}` : ''}` : '—';
    const rows = [
      ['Duration', duration],
      ['Base parking', money(details.baseParkingCents)],
      ['Fees', money(details.feesCents)],
      ['Tax', money(details.taxCents)],
      ['Discount', Number(details.discountCents || 0) ? `−${money(Math.abs(Number(details.discountCents)))}` : money(0)],
      ['Manual adjustment', money(details.manualAdjustmentCents)],
      ['Payment', details.paymentMode || '—']
    ];
    const normalizedAdjustments = Array.isArray(adjustments) ? adjustments : [];
    const adjustmentTotal = normalizedAdjustments.reduce((total, item) => total + Number(item.amount_cents || item.amountCents || 0), 0);
    const adjustmentRows = normalizedAdjustments.map(item => `<li><b>${esc(String(item.adjustment_type || item.adjustmentType || '').replaceAll('_', ' '))}</b> · ${esc(money(item.amount_cents ?? item.amountCents))}<br><small>${esc(item.reason || '')} · ${esc(date(item.created_at || item.createdAt))} · ${esc(item.username || 'System')}</small></li>`).join('');
    return `<section class="detail-section price-snapshot"><h3>Immutable price snapshot</h3><dl>${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}<div class="price-total"><dt>Original total</dt><dd>${esc(money(details.totalCents))}</dd></div></dl><h4>Post-booking adjustments</h4>${adjustmentRows ? `<ol class="history">${adjustmentRows}</ol>` : '<p class="empty">No post-booking adjustments.</p>'}<dl><div class="price-total"><dt>Current total</dt><dd>${esc(money(Number(details.totalCents || 0) + adjustmentTotal))}</dd></div></dl></section>`;
  }

  function customerAccountSummary(account) {
    if (!account) return `<section class="detail-section"><h3>Customer account</h3><p class="empty">This reservation is not linked to a verified My Parking account. Historical access can be claimed only through the secure customer flow.</p></section>`;
    const reservations = Array.isArray(account.reservations) ? account.reservations : [];
    const vehicles = Array.isArray(account.vehicles) ? account.vehicles : [];
    const documents = Array.isArray(account.documents) ? account.documents : [];
    const verified = (value, isVerified) => `${esc(value || 'Not provided')} <small>${isVerified ? 'Verified' : 'Not verified'}</small>`;
    return `<section class="detail-section customer-account-summary">
      <h3>My Parking customer account</h3>
      <dl class="reservation-detail-groups">
        <div><dt>Account</dt><dd>${esc(`${account.firstName} ${account.lastName}`)}<br><small>${esc(friendlyState(account.status))}${account.openConflictCount ? ` · ${esc(displayNumber(account.openConflictCount))} recovery conflict${Number(account.openConflictCount) === 1 ? '' : 's'}` : ''}</small></dd></div>
        <div><dt>Phone</dt><dd>${verified(account.phone, account.phoneVerified)}</dd></div>
        <div><dt>Email</dt><dd>${verified(account.email, account.emailVerified)}</dd></div>
        <div><dt>Linked activity</dt><dd>${esc(displayNumber(account.reservationCount))} reservations · ${esc(displayNumber(account.vehicleCount))} vehicles · ${esc(displayNumber(account.paidPaymentCount))} paid payments</dd></div>
      </dl>
      <h4>Recent linked parking</h4>
      ${reservations.length ? `<ol class="history">${reservations.map(item => `<li><b>${esc(item.reservationNumber)}</b> · ${esc(friendlyState(item.product))} · ${esc(friendlyState(item.status))}<br><small>${esc(date(item.arrivalAt))} → ${esc(date(item.departureAt))}${item.space ? ` · Space ${esc(item.space)}` : ''} · Payment ${esc(friendlyState(item.paymentStatus))}${item.subscriptionStatus ? ` · Subscription ${esc(friendlyState(item.subscriptionStatus))}` : ''}</small></li>`).join('')}</ol>` : '<p class="empty">No linked reservations.</p>'}
      <h4>Vehicles</h4>
      ${vehicles.length ? `<ol class="history">${vehicles.map(item => `<li><b>${esc(item.unitNumber)}</b> · ${esc(item.licensePlate)} (${esc(item.licensePlateState)}) · ${esc(friendlyState(item.classification))}</li>`).join('')}</ol>` : '<p class="empty">No active profile vehicles.</p>'}
      <h4>Documents</h4>
      ${documents.length ? `<ol class="history">${documents.map(item => `<li><b>${esc(friendlyState(item.type))}</b> · ${esc(friendlyState(item.uploadStatus))} · ${esc(friendlyState(item.verificationStatus))}${item.expiresAt ? `<br><small>Expires ${esc(date(item.expiresAt))}</small>` : ''}</li>`).join('')}</ol>` : '<p class="empty">No customer documents.</p>'}
      ${isOwner() ? `<h4>Audited account recovery</h4><form method="post" id="customerRecoveryForm" class="booking-note-form" data-customer-account="${esc(account.publicId)}">
        <label>Contact to replace<select name="contactType"><option value="PHONE">Phone</option><option value="EMAIL">Email</option></select></label>
        <label>New verified phone or email<input name="identifier" maxlength="254" required></label>
        <label>Verification reference<input name="verificationReference" maxlength="160" required placeholder="Support ticket or offline verification reference"></label>
        <label>Recovery reason<textarea name="reason" maxlength="1000" required></textarea></label>
        <label class="check"><input name="verifiedOwnership" type="checkbox" required> I verified this customer's ownership outside this browser session.</label>
        <p class="field-help">This revokes every customer session. A contact already owned by another account is never merged and creates a recovery conflict.</p>
        <div class="form-actions"><button>Apply verified recovery</button></div>
      </form>` : ''}
    </section>`;
  }

  function bookingSnapshot(booking) {
    let snapshot = booking?.snapshot;
    if (typeof snapshot === 'string') {
      try { snapshot = JSON.parse(snapshot); } catch (_) { snapshot = null; }
    }
    return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : null;
  }

  function bookingDuration(booking) {
    return bookingSnapshot(booking)?.duration || '';
  }

  function bookingZoneControl(booking) {
    const selected = booking.assigned_zone_id === null || booking.assigned_zone_id === undefined ? '' : String(booking.assigned_zone_id);
    const zones = isOwner() ? configState.zones.filter(zone => String(zone.location_id) === String(booking.location_id) && (zone.active || String(zone.id) === selected)) : [];
    const known = zones.some(zone => String(zone.id) === selected);
    const selectedFallback = selected && !known ? `<option value="${esc(selected)}" selected>Current assigned zone #${esc(selected)}</option>` : '';
    const choices = `<option value="">No zone assignment</option>${selectedFallback}${zones.map(zone => `<option value="${esc(zone.id)}"${String(zone.id) === selected ? ' selected' : ''}>${esc(zone.name)}${zone.active ? '' : ' (inactive)'}</option>`).join('')}`;
    const enabled = zones.length > 0;
    return {
      choices,
      disabled: enabled ? '' : ' disabled',
      help: enabled ? 'Choose a parking zone for the operational assignment, or leave it unassigned.' : (isOwner() ? 'No zones are configured for this booking location.' : 'Zone reassignment is available to Owners with configuration access.')
    };
  }

  function setMessage(selector, message, kind = '') {
    const element = $(selector);
    if (!element) return;
    element.classList.remove('success', 'error', 'info', 'loading');
    if (kind) element.classList.add(kind);
    element.textContent = message;
  }

  function setConfigMessage(message, kind = '') {
    setMessage('#configStatus', message, kind);
  }

  function setDetailMessage(message, kind = '') {
    setMessage('#detailMessage', message, kind);
  }

  function renderPageMeta(view) {
    const route = adminRoutes.routes[view] || adminRoutes.routes.dashboard;
    $('#shellPageKicker').textContent = route.ownerOnly ? 'CONFIGURATION' : 'OPERATIONS';
    $('#shellPageTitle').textContent = route.title;
    $('#shellPageSubtitle').textContent = route.subtitle;
    $('#openLiveLot').hidden = view !== 'dashboard';
    $('#shellLiveLotTime').hidden = view !== 'live-lot';
    document.title = `${route.title} | ParkingOps`;
  }

  function showPanelError(selector, error) {
    const element = $(selector);
    if (element) element.innerHTML = `<p class="error">${esc(error.message || 'Request failed')}</p>`;
  }

  async function call(path, options = {}) {
    if (!apiClient?.advanced) throw new Error('ParkingOps runtime configuration is unavailable.');
    return apiClient.advanced(path, options);
  }

  function dashboardDonut(parts) {
    const total = parts.reduce((sum, item) => sum + item.value, 0);
    if (!total) return '<div class="honest-empty"><strong>No live capacity is reported.</strong><p>Configure and publish parking inventory to populate the occupancy chart.</p></div>';
    const circumference = 289.03;
    let offset = 0;
    const arcs = parts.filter(item => item.value > 0).map(item => {
      const length = item.value / total * circumference;
      const arc = `<circle class="donut-segment ${esc(item.className)}" cx="60" cy="60" r="46" pathLength="289.03" stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"></circle>`;
      offset += length;
      return arc;
    }).join('');
    return `<svg viewBox="0 0 120 120" role="img" aria-label="${esc(`${total} live spaces: ${parts.map(item => `${item.label} ${item.value}`).join(', ')}`)}"><circle class="donut-track" cx="60" cy="60" r="46"></circle>${arcs}<text x="60" y="56" class="donut-total">${esc(displayNumber(total))}</text><text x="60" y="72" class="donut-caption">LIVE SPACES</text></svg>`;
  }

  async function dashboard() {
    try {
      const data = await call('/admin/parking/v1/dashboard');
      const summary = data.summary || {};
      const alerts = Number(summary.overdue || 0) + Number(summary.no_shows || 0) + Number(summary.blocked_spaces || 0) + Number(summary.capacity_shortfalls || 0) + operationalLocations.filter(item => item.assignment_mode === 'EXACT_SPOT' && !item.exact_mode_active).length;
      const metrics = [
        ['Available now', displayNumber(summary.available_spaces), 'available', 'Bookable physical spaces now'],
        ['Occupied', displayNumber(summary.checked_in), 'occupied', 'Checked in now'],
        ['Reserved', displayNumber(summary.reserved_spaces), 'reserved', 'Protected reservations now'],
        ['Monthly active', displayNumber(summary.monthly_active), 'monthly', 'Current monthly stays'],
        ['Arrivals today', displayNumber(summary.arrivals), 'arrivals', 'Pending or confirmed arrivals'],
        ['Departures today', displayNumber(summary.departures), 'departures', 'Confirmed or checked-in departures'],
        ['Attention required', displayNumber(alerts), 'alerts', 'Blocked, overdue, no-show, or setup issue']
      ];
      $('#summary').innerHTML = metrics.map(([label, value, kind, hint]) => `<article class="metric-card metric-${esc(kind)}"><div><small>${esc(label)}</small><b>${esc(value)}</b></div><span>${esc(hint)}</span></article>`).join('');
      $('#dashboardPhysicalContext').textContent = `${displayNumber(summary.active_physical_spaces)} physical published spaces · ${displayNumber(summary.publicly_bookable_spaces)} customer-bookable`;
      const donutParts = [
        { label: 'Available', value: Number(summary.available_spaces || 0), className: 'available' },
        { label: 'Occupied', value: Number(summary.checked_in || 0), className: 'occupied' },
        { label: 'Reserved', value: Number(summary.reserved_spaces || 0), className: 'reserved' },
        { label: 'Blocked', value: Number(summary.blocked_spaces || 0), className: 'blocked' }
      ];
      $('#occupancyDonut').innerHTML = dashboardDonut(donutParts);
      $('#occupancyLegend').innerHTML = donutParts.map(item => `<span class="occupancy-key ${esc(item.className)}"><i></i>${esc(item.label)} <b>${esc(displayNumber(item.value))}</b></span>`).join('');
      const operationList = (title, items, timeKey, empty) => `<section class="attention-group"><h4>${esc(title)}</h4>${items.length ? items.slice(0, 4).map(item => `<button type="button" data-overview-booking="${esc(item.id)}"><span><strong>${esc(item.reservation_number)}</strong><small>${esc(date(item[timeKey]))}</small></span><em>${esc(assignmentPresentation({ ...item, category_name: item.category_name || item.area_name }).detail)}</em></button>`).join('') : `<p class="inline-empty">${esc(empty)}</p>`}</section>`;
      const todayOperations = [
        ['Arrivals', summary.arrivals, 'arriving-today'],
        ['Departures', summary.departures, 'departing-today'],
        ['Checked in', summary.checked_in, 'checked-in'],
        ...(Number(summary.overdue || 0) ? [['Overdue', summary.overdue, 'attention']] : []),
        ...(Number(summary.no_shows || 0) ? [['No-show', summary.no_shows, 'attention']] : [])
      ];
      $('#todayOperations').innerHTML = todayOperations.map(([label, value, tab]) => `<button type="button" class="today-operation" data-reservation-tab="${esc(tab)}"><small>${esc(label)}</small><strong>${esc(displayNumber(value))}</strong><span>View reservations →</span></button>`).join('');
      const exactWarnings = operationalLocations.filter(item => item.assignment_mode === 'EXACT_SPOT' && !item.exact_mode_active);
      const capacityShortfalls = (data.areaCapacity || []).filter(item => Number(item.shortfall || 0) > 0);
      $('#operationalVisibility').innerHTML = `${exactWarnings.length ? `<div class="setup-warning"><strong>Exact-space setup needs attention</strong><p>${esc(exactWarnings.map(item => item.name).join(', '))} cannot assign numbered spaces publicly until Lot Setup is complete and published.</p><button type="button" class="secondary compact" data-dashboard-setup>Open Lot Setup</button></div>` : ''}
        ${capacityShortfalls.map(item => `<div class="setup-warning"><strong>CAPACITY SHORTFALL · ${esc(item.area)}</strong><p>Reserved: ${esc(displayNumber(Number(item.reservedCapacity || 0) + Number(item.checkedInCapacity || 0)))} · Usable physical capacity: ${esc(displayNumber(item.usablePhysical))} · Shortfall: ${esc(displayNumber(item.shortfall))}. New reservations remain unavailable until capacity is valid.</p></div>`).join('')}
        ${Number(summary.blocked_spaces || 0) ? `<div class="attention-callout"><strong>${esc(displayNumber(summary.blocked_spaces))} blocked space${Number(summary.blocked_spaces) === 1 ? '' : 's'}</strong><span>Review the Parking Lot map for active blocks.</span><button type="button" class="text-button" data-view="live-lot">Open Parking Lot</button></div>` : ''}
        ${operationList('Reservation attention', data.attentionRequired || [], 'arrival_at', 'Nothing needs immediate attention.')}`;
      $$('[data-overview-booking]').forEach(button => button.addEventListener('click', async () => { if (await setView('reservations')) await detail(button.dataset.overviewBooking); }));
      $('[data-dashboard-setup]')?.addEventListener('click', () => setView('lot-setup'));
      $$('#operationalVisibility [data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
      $$('#todayOperations [data-reservation-tab]').forEach(button => button.addEventListener('click', async () => { if (await setView('reservations')) selectReservationTab(button.dataset.reservationTab); }));
      const activityRows = (data.recentActivity || []).map(item => `<li><span>${esc(date(item.created_at))}</span><b>${esc(item.reservation_number)}</b>${statusBadge(item.new_status)}</li>`).join('');
      $('#recentActivity').innerHTML = `<ol class="recent-activity-list">${activityRows || '<li class="inline-empty">No recent reservation activity.</li>'}</ol>`;
    } catch (error) {
      showPanelError('#summary', error);
      showPanelError('#occupancyDonut', error);
      showPanelError('#todayOperations', error);
      showPanelError('#operationalVisibility', error);
      showPanelError('#recentActivity', error);
    }
  }

  function bookingSearchQuery() {
    const values = new FormData($('#search'));
    values.delete('parking_type');
    const timezone = operationalLocations.find(item => item.timezone)?.timezone || canonicalLocation()?.timezone || 'America/Chicago';
    for (const name of ['from', 'to']) {
      const value = values.get(name);
      if (value) values.set(name, adminCore.localDateTimeToInstant(value, timezone));
    }
    return new URLSearchParams(values).toString();
  }

  function bookingDay(booking, value) {
    if (!value) return '';
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: booking.location_timezone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
    } catch (_) { return new Date(value).toISOString().slice(0, 10); }
  }

  function todayForBooking(booking) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: booking.location_timezone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    } catch (_) { return new Date().toISOString().slice(0, 10); }
  }

  function filteredBookings() {
    const parkingType = $('#search [name="parking_type"]')?.value || '';
    const now = new Date();
    return reservationState.bookings.filter(booking => {
      if (parkingType && booking.category_name !== parkingType) return false;
      if (reservationState.tab === 'upcoming') return ['PENDING', 'CONFIRMED'].includes(booking.status) && new Date(booking.arrival_at) >= now;
      if (reservationState.tab === 'arriving-today') return ['PENDING', 'CONFIRMED'].includes(booking.status) && bookingDay(booking, booking.arrival_at) === todayForBooking(booking);
      if (reservationState.tab === 'checked-in') return booking.status === 'CHECKED_IN';
      if (reservationState.tab === 'departing-today') return ['CONFIRMED', 'CHECKED_IN'].includes(booking.status) && bookingDay(booking, booking.departure_at) === todayForBooking(booking);
      if (reservationState.tab === 'monthly') return bookingDuration(booking) === 'MONTHLY';
      if (reservationState.tab === 'completed') return ['CHECKED_OUT', 'COMPLETED'].includes(booking.status);
      if (reservationState.tab === 'attention') return booking.status === 'NO_SHOW' || (booking.status === 'CHECKED_IN' && new Date(booking.departure_at) < now);
      return true;
    });
  }

  function reservationStay(booking) {
    const duration = bookingDuration(booking);
    const durationLabel = duration ? ` · ${friendlyState(duration)}` : '';
    const timezone = booking.location_timezone || 'America/Chicago';
    return `${liveDate(booking.arrival_at, timezone)} → ${liveDate(booking.departure_at, timezone)}${durationLabel}`;
  }

  function renderReservationList() {
    const items = filteredBookings();
    const timezone = reservationState.bookings.find(item => item.location_timezone)?.location_timezone || operationalLocations.find(item => item.timezone)?.timezone || 'America/Chicago';
    $('#reservationTimeHelp').textContent = `Date filters and operating-day tabs use ${timezone}.`;
    const types = [...new Set(reservationState.bookings.map(booking => booking.category_name).filter(Boolean))].sort();
    const parkingType = $('#search [name="parking_type"]');
    if (parkingType) {
      const value = parkingType.value;
      parkingType.innerHTML = `<option value="">All parking types</option>${types.map(type => `<option value="${esc(type)}">${esc(type)}</option>`).join('')}`;
      parkingType.value = types.includes(value) ? value : '';
    }
    $$('[data-reservation-tab]').forEach(button => {
      const selected = button.dataset.reservationTab === reservationState.tab;
      button.classList.toggle('is-current', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    $('#bookings').innerHTML = items.length ? items.map(booking => `<button type="button" class="reservation-row${String(currentBooking?.id) === String(booking.id) ? ' is-selected' : ''}" data-booking="${esc(booking.id)}">
      <span class="reservation-row-top"><strong>${esc(booking.reservation_number)}</strong>${statusBadge(booking.status)}</span>
      <span class="reservation-row-customer">${esc(booking.first_name)} ${esc(booking.last_name)} · ${esc(booking.company_name || 'Company unavailable')}</span>
      <small>${esc([booking.tractor_unit_number, booking.license_plate].filter(Boolean).join(' · ') || 'Vehicle details unavailable')}</small>
      <small>${esc(assignmentPresentation(booking).model)} · ${esc(assignmentPresentation(booking).detail)}</small>
      <small>${esc(reservationStay(booking))}</small>
    </button>`).join('') : `<div class="reservation-empty"><strong>No reservations match this view.</strong><p>Try another tab or clear the current filters.</p><button type="button" class="secondary compact" data-reservation-clear>Reset filters</button></div>`;
    $$('[data-booking]').forEach(button => button.addEventListener('click', () => detail(button.dataset.booking)));
    $('[data-reservation-clear]')?.addEventListener('click', resetReservationFilters);
    if (!items.length && !currentBooking) $('#detail').innerHTML = '<div class="reservation-empty detail-empty"><strong>No reservation selected.</strong><p>Select a result to review its parking details and available actions.</p></div>';
  }

  function selectReservationTab(tab = 'all') {
    reservationState.tab = ['all', 'upcoming', 'arriving-today', 'checked-in', 'departing-today', 'monthly', 'completed', 'attention'].includes(tab) ? tab : 'all';
    renderReservationList();
  }

  function resetReservationFilters() {
    const form = $('#search');
    form.reset();
    reservationState.tab = 'all';
    bookings();
  }

  async function bookings(query = null) {
    const request = reservationState.listGate.next();
    try {
      query = query === null ? bookingSearchQuery() : query;
      const data = await call(`/admin/parking/v1/bookings${query ? `?${query}` : ''}`, { signal: request.signal });
      if (!request.current()) return;
      reservationState.bookings = data.bookings || [];
      renderReservationList();
    } catch (error) {
      if (!request.current() || error.name === 'AbortError') return;
      showPanelError('#bookings', error);
    }
  }

  async function detail(id) {
    const request = reservationState.detailGate.next();
    try {
      const data = await call(`/admin/parking/v1/bookings/${encodeURIComponent(id)}`, { signal: request.signal });
      if (!request.current()) return;
      const booking = data.booking;
      const presentation = assignmentPresentation(booking);
      const areaMode = presentation.area;
      currentBooking = booking;
      renderReservationList();
      const actions = {
        PENDING: [['confirm', 'Confirm'], ['cancel', 'Cancel']],
        CONFIRMED: [['check-in', 'Check in'], ['no-show', 'Mark no-show'], ['cancel', 'Cancel']],
        CHECKED_IN: [['check-out', 'Check out']],
        CHECKED_OUT: [['complete', 'Complete']]
      };
      const history = (data.history || []).map(item => `<li>${esc(date(item.created_at))} — ${esc(item.previous_status || 'New')} → <b>${esc(item.new_status)}</b>${item.reason ? ` (${esc(item.reason)})` : ''}</li>`).join('');
      const assignmentHistory = (data.assignments || []).map(item => `<li>${esc(date(item.assigned_at))} — <b>Space ${esc(item.public_label)}</b> · ${esc(item.area_name)}${item.released_at ? ` · ended ${esc(date(item.released_at))}` : ' · current'}${item.assignment_reason ? `<br>${esc(item.assignment_reason)}` : ''}</li>`).join('');
      const notes = (data.notes || []).map(item => `<li><b>${esc(item.username || 'System')}</b> · ${esc(date(item.created_at))} ${noteVisibilityBadge(item.visibility)}<br>${esc(item.note)}</li>`).join('');
      const zone = bookingZoneControl(booking);
      $('#detail').innerHTML = `<section class="reservation-detail-summary">
        <div class="reservation-detail-title"><p class="page-kicker">RESERVATION</p><h3>${esc(booking.reservation_number)}</h3>${statusBadge(booking.status)}</div>
        <dl class="reservation-detail-groups">
          <div><dt>Stay</dt><dd>${esc(reservationStay(booking))}</dd></div>
          <div><dt>Driver</dt><dd>${esc(`${booking.first_name} ${booking.last_name}`)}<br><small>${esc([booking.mobile_phone, booking.email, booking.company_name].filter(Boolean).join(' · '))}</small></dd></div>
          <div><dt>Vehicle & parking</dt><dd>${esc([booking.tractor_unit_number, booking.license_plate && `Plate ${booking.license_plate}`, booking.trailer_number && `Trailer ${booking.trailer_number}`].filter(Boolean).join(' · ') || 'Vehicle details unavailable')}<br><small>${esc(presentation.detail)}</small></dd></div>
          <div><dt>Parking model</dt><dd>${esc(presentation.model)}<br><small>${areaMode ? `Area capacity commitment: ${esc(booking.category_name || 'Parking Area')}` : presentation.monthly ? `Monthly eligible at booking · ${esc(reservationStay(booking))}` : 'Legacy compatibility record; not a selectable product'}</small></dd></div>
        </dl>
      </section>
      <div class="actions" id="actions">${(actions[booking.status] || []).map(([path, label]) => `<button type="button" class="primary" data-action="${esc(path)}">${esc(label)}</button>`).join('')}${(data.assignments || []).some(item => !item.released_at) && ['PENDING','CONFIRMED','CHECKED_IN'].includes(booking.status) ? '<button type="button" class="secondary" id="reassignBooking">Reassign space</button>' : ''}</div>
      <p id="detailMessage" class="status-message" aria-live="polite"></p>
      ${customerAccountSummary(data.customerAccount)}
      ${priceSnapshot(booking.snapshot, data.adjustments)}
      ${isOwner() ? `<section class="detail-section">
        <h3>Post-booking adjustment</h3>
        <form method="post" id="bookingAdjustmentForm" class="booking-note-form">
          <label>Type<select name="adjustmentType"><option value="DISCOUNT">Discount</option><option value="ADDITIONAL_CHARGE">Additional charge</option><option value="MANUAL_ADJUSTMENT">Manual adjustment (+ or −)</option></select></label>
          <label>Amount (USD)<input name="amount" type="number" step="0.01" required></label>
          <label>Reason<textarea name="reason" maxlength="1000" required></textarea></label>
          <p class="field-help">Discounts reduce the total; additional charges increase it. A manual adjustment may be positive or negative and always requires a reason.</p>
          <div class="form-actions"><button>Record adjustment</button></div>
        </form>
      </section>` : ''}
      <section class="detail-section">
        <h3>Edit reservation details</h3>
        <form method="post" id="bookingEditForm" class="booking-edit-form">
          <div class="detail-form-grid">
            <label>First name<input name="first_name" maxlength="80" required value="${esc(booking.first_name)}"></label>
            <label>Last name<input name="last_name" maxlength="80" required value="${esc(booking.last_name)}"></label>
            <label>Mobile phone<input name="mobile_phone" type="tel" maxlength="40" required value="${esc(booking.mobile_phone)}"></label>
            <label>Email<input name="email" type="email" maxlength="254" required value="${esc(booking.email)}"></label>
            <label>Company / Carrier name<input name="company_name" maxlength="120" required value="${esc(booking.company_name || '')}"></label>
            <label>Tractor / unit number<input name="tractor_unit_number" maxlength="80" required value="${esc(booking.tractor_unit_number)}"></label>
            <label>License plate<input name="license_plate" maxlength="30" required value="${esc(booking.license_plate)}"></label>
            <label>Plate state / province<input name="license_plate_state" maxlength="40" required value="${esc(booking.license_plate_state)}"></label>
            <label>Trailer number<input name="trailer_number" maxlength="80" value="${esc(booking.trailer_number || '')}"></label>
            ${areaMode ? `<div class="read-only-field"><span>Reserved area</span><strong>${esc(booking.category_name || 'Parking Area')}</strong><small>No numbered position assigned. Customer instruction: park anywhere physically available within the highlighted area.</small></div>` : booking.assigned_spot_label ? `<div class="read-only-field"><span>${presentation.monthly ? 'Selected monthly position' : 'Historical assigned position'}</span><strong>Position ${esc(booking.assigned_spot_label)}</strong><small>${presentation.monthly ? 'Customer-selected and validated for the complete interval. Use reassignment only for an explicit operational move.' : 'Historical automatic exact-space compatibility record.'}</small></div>` : `<label>Assigned zone<select name="assigned_zone_id"${zone.disabled}>${zone.choices}</select><span class="field-help">${esc(zone.help)}</span></label>`}
          </div>
          <label>Special instructions<textarea name="special_instructions" maxlength="1000">${esc(booking.special_instructions || '')}</textarea></label>
          <label>Operational notes<textarea name="operational_notes" maxlength="4000">${esc(booking.operational_notes || '')}</textarea></label>
          <div class="form-actions"><button>Save reservation details</button></div>
        </form>
      </section>
      <section class="detail-section">
        <h3>Add note</h3>
        <form method="post" id="bookingNoteForm" class="booking-note-form">
          <label>Note<textarea name="note" maxlength="1000" required></textarea></label>
          <label>Visibility<select name="visibility"><option value="INTERNAL">Internal only</option><option value="CUSTOMER">Customer-visible</option></select></label>
          <p class="field-help">Customer-visible notes are marked for customer communication; internal notes remain staff-only.</p>
          <div class="form-actions"><button>Add note</button></div>
        </form>
      </section>
      <h3>Immutable status history</h3><ol class="history">${history || '<li>No status history is available.</li>'}</ol>
      <h3>${areaMode ? 'Parking-area commitment' : presentation.monthly ? 'Customer-selected monthly assignment history' : 'Historical exact assignment history'}</h3><ol class="history">${assignmentHistory || `<li>${areaMode ? `${esc(booking.category_name || 'Parking Area')} · no numbered position assigned.` : 'No numbered-position assignment history is available.'}</li>`}</ol>
      <h3>Notes</h3><ol class="history">${notes || '<li>No notes.</li>'}</ol>`;
      $$('[data-action]').forEach(button => button.addEventListener('click', () => action(button.dataset.action, button)));
      $('#bookingEditForm')?.addEventListener('submit', saveBookingDetails);
      $('#bookingNoteForm')?.addEventListener('submit', saveBookingNote);
      $('#bookingAdjustmentForm')?.addEventListener('submit', saveBookingAdjustment);
      $('#customerRecoveryForm')?.addEventListener('submit', saveCustomerRecovery);
      $('#reassignBooking')?.addEventListener('click', event => reassignBooking(booking.id, event.currentTarget));
    } catch (error) {
      if (!request.current() || error.name === 'AbortError') return;
      showPanelError('#detail', error);
    }
  }

  async function reassignBooking(bookingId, trigger = document.activeElement) {
    const dialog = $('#reassignmentDialog'); const form = $('#reassignmentForm');
    dialogState.reassignmentTrigger = trigger; form.reset(); form.dataset.complete = 'false';
    form.elements.bookingId.value = bookingId; form.elements.spotId.value = '';
    $('#reassignmentAlternatives').innerHTML = '<p class="status-message loading">Loading eligible replacement spaces…</p>';
    setMessage('#reassignmentStatus', '', '');
    const checkedIn = (String(currentBooking?.id) === String(bookingId) && currentBooking?.status === 'CHECKED_IN')
      || (String(liveState.detail?.currentReservation?.id) === String(bookingId) && liveState.detail?.currentReservation?.status === 'CHECKED_IN');
    $('#reassignmentSafeMoveLabel').hidden = !checkedIn;
    form.elements.safeMoveAcknowledged.required = checkedIn;
    form.querySelector('[type="submit"]').disabled = true;
    dialog.showModal();
    try {
      const data = await call(`/admin/parking/v1/bookings/${encodeURIComponent(bookingId)}/spot-alternatives`);
      const alternatives = data.alternatives || [];
      $('#reassignmentAlternatives').innerHTML = alternatives.length ? alternatives.map((item, index) => `<label class="reassignment-option"><input type="radio" name="alternative" value="${esc(item.id)}"${index === 0 ? ' checked' : ''}><span><strong>Space ${esc(item.public_label)}</strong><small>${esc(item.area_name || 'Area not provided')}</small></span></label>`).join('') : '<p class="empty">No eligible replacement spaces are available for the full reservation interval.</p>';
      if (alternatives.length) form.elements.spotId.value = alternatives[0].id;
      form.querySelectorAll('[name="alternative"]').forEach(control => control.addEventListener('change', () => { form.elements.spotId.value = control.value; }));
      form.querySelector('[type="submit"]').disabled = !alternatives.length;
      (alternatives.length ? form.querySelector('[name="alternative"]') : form.elements.reason).focus({ preventScroll: true });
    } catch (error) {
      $('#reassignmentAlternatives').innerHTML = '';
      setMessage('#reassignmentStatus', error.message || 'Unable to load eligible replacement spaces.', 'error');
    }
  }

  async function submitReassignment(event) {
    event.preventDefault(); if (dialogState.submitting) return;
    const form = event.currentTarget; const bookingId = form.elements.bookingId.value;
    try {
      const spotId = Number(form.elements.spotId.value); const reason = requiredText(form, 'reason', 'Reassignment reason');
      if (!Number.isSafeInteger(spotId)) throw new Error('Choose an eligible replacement space.');
      if (!$('#reassignmentSafeMoveLabel').hidden && !form.elements.safeMoveAcknowledged.checked) throw new Error('Confirm the checked-in driver can safely move.');
      dialogState.submitting = true; setFormBusy(form, true); setMessage('#reassignmentStatus', 'Reassigning space…', 'loading');
      await call(`/admin/parking/v1/bookings/${encodeURIComponent(bookingId)}/reassign-spot`, {
        method: 'POST', body: JSON.stringify({ spotId, reason })
      });
      form.dataset.complete = 'true'; setMessage('#reassignmentStatus', 'Space reassigned successfully.', 'success');
      await Promise.all([currentView === 'reservations' ? detail(bookingId) : Promise.resolve(), bookings(), loadLiveLot({ quiet: true })]);
    } catch (error) { setMessage('#reassignmentStatus', error.message || 'Unable to reassign this reservation.', 'error'); }
    finally { dialogState.submitting = false; setFormBusy(form, false); if (form.dataset.complete === 'true') form.querySelector('[type="submit"]').disabled = true; }
  }

  function closeReassignmentDialog() { if (!dialogState.submitting && $('#reassignmentDialog')?.open) $('#reassignmentDialog').close(); }

  function action(path, trigger = document.activeElement) {
    if (!currentBooking) return;
    const dialog = $('#statusTransitionDialog'); const form = $('#statusTransitionForm');
    dialogState.statusTrigger = trigger; form.reset(); form.dataset.complete = 'false';
    form.elements.action.value = path; form.elements.bookingId.value = currentBooking.id; form.elements.version.value = currentBooking.version;
    const actionName = friendlyState(path);
    $('#statusTransitionDialogHeading').textContent = actionName;
    $('#statusTransitionReservation').textContent = `${currentBooking.reservation_number} · current version ${currentBooking.version}`;
    $('#statusTransitionCheckIn').hidden = path !== 'check-in';
    $('#statusTransitionSubmit').textContent = actionName;
    setMessage('#statusTransitionStatus', '', '');
    dialog.showModal(); form.elements.reason.focus({ preventScroll: true });
  }

  async function submitStatusTransition(event) {
    event.preventDefault(); if (dialogState.submitting) return;
    const form = event.currentTarget; const path = form.elements.action.value; const bookingId = form.elements.bookingId.value;
    try {
      const reason = requiredText(form, 'reason', 'Reason or note');
      dialogState.submitting = true; setFormBusy(form, true); setMessage('#statusTransitionStatus', 'Updating reservation…', 'loading');
      await call(`/admin/parking/v1/bookings/${encodeURIComponent(bookingId)}/${encodeURIComponent(path)}`, { method: 'POST', body: JSON.stringify({
        version: Number(form.elements.version.value), reason, note: reason,
        policyAcknowledged: path === 'check-in' && form.elements.policyAcknowledged.checked,
        conditionNote: path === 'check-in' ? String(form.elements.conditionNote.value || '').trim() : ''
      }) });
      form.dataset.complete = 'true'; setMessage('#statusTransitionStatus', 'Reservation status updated successfully.', 'success');
      await Promise.all([detail(bookingId), dashboard(), bookings()]);
    } catch (error) { setMessage('#statusTransitionStatus', error.message || 'Unable to update the reservation.', 'error'); }
    finally { dialogState.submitting = false; setFormBusy(form, false); if (form.dataset.complete === 'true') form.querySelector('[type="submit"]').disabled = true; }
  }

  function closeStatusTransitionDialog() { if (!dialogState.submitting && $('#statusTransitionDialog')?.open) $('#statusTransitionDialog').close(); }

  function bookingPatchPayload(form) {
    const required = (name, label) => requiredText(form, name, label);
    const optional = name => textValue(form, name) || null;
    const payload = {
      version: currentBooking.version,
      first_name: required('first_name', 'First name'),
      last_name: required('last_name', 'Last name'),
      mobile_phone: required('mobile_phone', 'Mobile phone'),
      email: required('email', 'Email'),
      company_name: optional('company_name'),
      tractor_unit_number: required('tractor_unit_number', 'Tractor / unit number'),
      license_plate: required('license_plate', 'License plate'),
      license_plate_state: required('license_plate_state', 'Plate state / province'),
      trailer_number: optional('trailer_number'),
      special_instructions: optional('special_instructions'),
      operational_notes: textValue(form, 'operational_notes')
    };
    const assignedZone = form.elements.namedItem('assigned_zone_id');
    if (assignedZone && !assignedZone.disabled && !currentBooking.assigned_spot_label) payload.assigned_zone_id = assignedZone.value ? identifier(form, 'assigned_zone_id', 'assigned zone') : null;
    return payload;
  }

  async function saveBookingDetails(event) {
    event.preventDefault();
    if (!currentBooking) return;
    const form = event.currentTarget;
    try {
      const payload = bookingPatchPayload(form);
      setFormBusy(form, true);
      setDetailMessage('Saving reservation details…', 'loading');
      await call(`/admin/parking/v1/bookings/${encodeURIComponent(currentBooking.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      await Promise.all([detail(currentBooking.id), dashboard(), bookings()]);
      setDetailMessage('Reservation details saved successfully.', 'success');
    } catch (error) {
      setDetailMessage(error.message || 'Unable to save reservation details.', 'error');
    } finally {
      setFormBusy(form, false);
    }
  }

  async function saveCustomerRecovery(event) {
    event.preventDefault();
    if (!currentBooking) return;
    const form = event.currentTarget;
    try {
      const payload = {
        contactType: textValue(form, 'contactType'),
        identifier: requiredText(form, 'identifier', 'New verified phone or email'),
        verificationReference: requiredText(form, 'verificationReference', 'Verification reference'),
        reason: requiredText(form, 'reason', 'Recovery reason'),
        verifiedOwnership: Boolean(form.elements.verifiedOwnership.checked)
      };
      setFormBusy(form, true);
      setDetailMessage('Applying verified account recovery...', 'loading');
      await call(`/admin/parking/v1/customer-accounts/${encodeURIComponent(form.dataset.customerAccount)}/recovery`, {
        method: 'PATCH', body: JSON.stringify(payload)
      });
      await detail(currentBooking.id);
      setDetailMessage('Customer login identity updated and prior customer sessions revoked.', 'success');
    } catch (error) {
      setDetailMessage(error.message || 'Unable to complete account recovery.', 'error');
    } finally {
      setFormBusy(form, false);
    }
  }

  async function saveBookingNote(event) {
    event.preventDefault();
    if (!currentBooking) return;
    const form = event.currentTarget;
    try {
      const note = requiredText(form, 'note', 'Note');
      const visibility = textValue(form, 'visibility');
      if (!['INTERNAL', 'CUSTOMER'].includes(visibility)) throw new Error('Select a valid note visibility.');
      setFormBusy(form, true);
      setDetailMessage('Adding note…', 'loading');
      await call(`/admin/parking/v1/bookings/${encodeURIComponent(currentBooking.id)}/notes`, { method: 'POST', body: JSON.stringify({ note, visibility }) });
      await detail(currentBooking.id);
      setDetailMessage(visibility === 'CUSTOMER' ? 'Customer-visible note added.' : 'Internal note added.', 'success');
    } catch (error) {
      setDetailMessage(error.message || 'Unable to add the note.', 'error');
    } finally {
      setFormBusy(form, false);
    }
  }

  function adjustmentAmountCents(form, type) {
    const value = Number(String(form.elements.namedItem('amount')?.value || '').trim());
    const cents = Math.round(value * 100);
    if (!Number.isFinite(value) || !Number.isSafeInteger(cents) || !cents || Math.abs(value * 100 - cents) > 0.000001) throw new Error('Enter a non-zero amount with no more than two decimal places.');
    if (type !== 'MANUAL_ADJUSTMENT' && cents < 0) throw new Error('Discounts and additional charges must be entered as positive amounts.');
    return cents;
  }

  async function saveBookingAdjustment(event) {
    event.preventDefault();
    if (!currentBooking || !isOwner()) return;
    const form = event.currentTarget;
    try {
      const adjustmentType = textValue(form, 'adjustmentType');
      if (!['DISCOUNT', 'ADDITIONAL_CHARGE', 'MANUAL_ADJUSTMENT'].includes(adjustmentType)) throw new Error('Select a valid adjustment type.');
      const amountCents = adjustmentAmountCents(form, adjustmentType);
      const reason = requiredText(form, 'reason', 'Adjustment reason');
      setFormBusy(form, true);
      setDetailMessage('Recording adjustment…', 'loading');
      await call(`/admin/parking/v1/bookings/${encodeURIComponent(currentBooking.id)}/adjustments`, { method: 'POST', body: JSON.stringify({ version: currentBooking.version, adjustmentType, amountCents, reason }) });
      await Promise.all([detail(currentBooking.id), dashboard(), bookings()]);
      setDetailMessage('Post-booking adjustment recorded.', 'success');
    } catch (error) {
      setDetailMessage(error.message || 'Unable to record the adjustment.', 'error');
    } finally {
      setFormBusy(form, false);
    }
  }

  function options(items, label, { emptyLabel = null } = {}) {
    const empty = emptyLabel === null ? '' : `<option value="">${esc(emptyLabel)}</option>`;
    return empty + items.map(item => `<option value="${esc(item.id)}">${esc(label(item))}</option>`).join('');
  }

  function populateSelect(id, items, label, settings = {}) {
    const select = $(`#${id}`);
    if (!select) return;
    const previous = select.value;
    select.innerHTML = items.length ? options(items, label, settings) : `<option value="">${esc(settings.emptyLabel || 'No options available')}</option>`;
    if (items.some(item => String(item.id) === String(previous))) select.value = previous;
  }

  function populateConfigSelects() {
    const parkingTypes = canonicalParkingCategories();
    populateSelect('closureCategoryId', parkingTypes, item => parkingTypeLabel(item), { emptyLabel: 'Select parking type' });
  }

  function canonicalLocation() {
    const exact = operationalLocations.find(item => item.exact_mode_active);
    return configState.locations.find(item => String(item.id) === String(exact?.id))
      || configState.locations.find(item => /trucker heaven/i.test(item.name || ''))
      || configState.locations[0]
      || null;
  }

  function canonicalParkingCategories() {
    const order = { BOBTAIL: 1, TRACTOR_TRAILER: 2 };
    return configState.categories.filter(item => item.active !== false && Object.hasOwn(order, item.code)).sort((left, right) => order[left.code] - order[right.code]);
  }

  function parkingTypeLabel(category) {
    return category?.code === 'BOBTAIL' ? 'Bobtail' : category?.code === 'TRACTOR_TRAILER' ? 'General Truck' : '';
  }

  function categoryParkingType(categoryId) { return parkingTypeLabel(configState.categories.find(category => String(category.id) === String(categoryId))); }

  function configTable(headers, rows, emptyMessage) {
    if (!rows.length) return `<p class="empty">${esc(emptyMessage)}</p>`;
    return `<table><thead><tr>${headers.map(header => `<th>${esc(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  function editButton(entity, id) {
    return `<button type="button" class="secondary compact" data-config-edit="${esc(entity)}" data-config-id="${esc(id)}">Edit</button>`;
  }

  function renderConfigLists() {
    const renderList = (selector, content) => { const target = $(selector); if (target) target.innerHTML = content; };
    const closures = configState.closures.filter(item => item.location_id || item.category_id).filter(item => !item.category_id || Boolean(categoryParkingType(item.category_id)));
    renderList('#closuresList', closures.length ? closures.map(item => {
      const scope = item.category_id ? categoryParkingType(item.category_id) : 'Entire lot';
      const type = item.closure_type === 'CAPACITY_REDUCTION' ? `Capacity reduction · ${displayNumber(item.capacity_reduction)} spaces` : 'Full closure';
      return `<article class="closure-card"><div class="closure-card-heading"><div><span class="closure-scope">${esc(scope)}</span><h4>${esc(type)}</h4></div>${activePill(item.active)}</div><p>${esc(date(item.starts_at))} → ${esc(date(item.ends_at))}</p><p>${esc(item.reason)}</p><div class="closure-card-footer"><span>${esc(item.customer_message || 'No customer-facing message')}</span>${editButton('closures', item.id)}</div></article>`;
    }).join('') : '<div class="config-empty-state"><strong>No closures scheduled</strong><p>Schedule a lot or parking-type closure only when operations require it.</p></div>');
    $$('[data-config-edit]').forEach(button => button.addEventListener('click', () => startConfigEdit(button.dataset.configEdit, button.dataset.configId)));
  }

  function renderConfig() {
    populateConfigSelects();
    hydrateCanonicalSettings();
    renderConfigLists();
    updateClosureFields();
    renderConfigHeader();
  }

  function setFormValue(form, name, value) {
    const field = form.elements.namedItem(name);
    if (!field) return;
    if (field.type === 'checkbox') field.checked = Boolean(value);
    else field.value = value ?? '';
  }

  function formSnapshot(form) {
    return Object.fromEntries([...form.elements].filter(field => field.name).map(field => [field.name, field.type === 'checkbox' ? Boolean(field.checked) : field.value]));
  }

  function captureFormBaseline(name, form) { if (form) configUi.baselines[name] = formSnapshot(form); }
  function restoreFormBaseline(name, form) {
    const baseline = configUi.baselines[name];
    if (!form || !baseline) return false;
    Object.entries(baseline).forEach(([field, value]) => setFormValue(form, field, value));
    return true;
  }
  function updateBaselineField(name, field, value) { if (configUi.baselines[name]) configUi.baselines[name][field] = String(value ?? ''); }

  function submitButton(form) {
    return form.querySelector('.form-actions button:first-child');
  }

  function populateCanonicalForm(form, location, fields) {
    if (!form || !location) return;
    setFormValue(form, 'id', location.id);
    setFormValue(form, 'version', location.version);
    fields.forEach(field => setFormValue(form, field, location[field]));
  }

  function hydrateCanonicalSettings() {
    const location = canonicalLocation();
    const businessForm = $('#businessSettingsForm');
    const policyForm = $('#bookingPoliciesForm');
    if (!location) {
      businessForm?.querySelectorAll('input, textarea, select, button').forEach(control => { control.disabled = true; });
      policyForm?.querySelectorAll('input, textarea, select, button').forEach(control => { control.disabled = true; });
      return;
    }
    businessForm?.querySelectorAll('input, textarea, select, button').forEach(control => { control.disabled = false; });
    policyForm?.querySelectorAll('input, textarea, select, button').forEach(control => { control.disabled = false; });
    if (!configUi.dirty.business) {
      populateCanonicalForm(businessForm, location, ['name', 'public_description', 'address', 'timezone', 'phone', 'business_hours', 'arrival_instructions', 'exit_instructions', 'road_directions_url', 'active']);
      captureFormBaseline('business', businessForm);
    }
    if (!configUi.dirty.policies) {
      populateCanonicalForm(policyForm, location, ['booking_approval_mode', 'cancellation_cutoff_hours', 'payment_instructions']);
      captureFormBaseline('policies', policyForm);
    }
    const hint = $('#businessSettingsHint');
    if (hint) hint.textContent = location ? 'Changes are saved to Trucker Heaven Parking.' : 'The parking property is unavailable.';
  }

  function renderConfigHeader() {
    $$('[data-config-group="business"]').forEach(tab => { tab.hidden = false; });
  }

  function resetConfigForm(entity) {
    const form = $(`[data-config-form="${entity}"]`);
    if (!form) return;
    form.reset();
    setFormValue(form, 'id', '');
    setFormValue(form, 'version', '');
    setFormValue(form, 'active', true);
    if (entity === 'zones') setFormValue(form, 'public_visible', true);
    if (entity === 'inventory') setFormValue(form, 'public_remaining_capacity', false);
    if (entity === 'closures') {
      setFormValue(form, 'closure_type', 'FULL_CLOSURE');
      setFormValue(form, 'capacity_reduction', '0');
      setFormValue(form, 'scope', 'LOT');
    }
    const title = $(`[data-form-title="${entity}"]`);
    if (title) title.textContent = `Add ${configMeta[entity].singular}`;
    const button = submitButton(form);
    if (button) button.textContent = `Save ${configMeta[entity].singular}`;
    updateClosureFields();
    if (entity === 'closures') captureFormBaseline(entity, form);
  }

  function startConfigEdit(entity, id) {
    const item = configState[entity]?.find(candidate => String(candidate.id) === String(id));
    if (!item) {
      setConfigMessage('That configuration item is no longer available. Refresh configuration and try again.', 'error');
      return;
    }
    selectConfigTab(entity);
    const form = $(`[data-config-form="${entity}"]`);
    resetConfigForm(entity);
    if (form) form.hidden = false;
    setFormValue(form, 'id', item.id);
    setFormValue(form, 'version', item.version);
    if (entity === 'closures') {
      if (!item.location_id && !item.category_id) {
        setConfigMessage('This legacy closure scope is retained for compatibility and is not editable in the one-property workspace.', 'info');
        return;
      }
      setFormValue(form, 'scope', item.category_id ? 'PARKING_TYPE' : 'LOT');
      ['category_id', 'closure_type', 'capacity_reduction', 'reason', 'internal_note', 'customer_message', 'active'].forEach(name => setFormValue(form, name, item[name]));
      setFormValue(form, 'starts_at', dateForInput(item.starts_at));
      setFormValue(form, 'ends_at', dateForInput(item.ends_at));
    }
    $(`[data-form-title="${entity}"]`).textContent = `Edit ${configMeta[entity].singular}`;
    submitButton(form).textContent = `Update ${configMeta[entity].singular}`;
    updateClosureFields();
    captureFormBaseline(entity, form);
    setConfigMessage(`Editing ${configMeta[entity].singular}. ParkingOps will protect against stale changes.`, 'info');
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function selectConfigTab(entity) {
    const allowed = adminRoutes.visibleConfigTabs(currentView);
    const selectedEntity = allowed.includes(entity) ? entity : allowed[0];
    configUi.activeTab = selectedEntity;
    $('#businessSettingsForm').hidden = !['property', 'contact', 'instructions'].includes(selectedEntity);
    ['property', 'contact', 'instructions', 'policies', 'closures'].forEach(name => {
      const panel = $(`#config-${name}`);
      if (panel) panel.hidden = name !== selectedEntity;
      const tab = $(`#tab-${name}`);
      if (tab) { const selected = name === selectedEntity; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; }
    });
  }

  function requiredText(form, name, label) {
    const value = String(form.elements.namedItem(name)?.value || '').trim();
    if (!value) throw new Error(`${label} is required.`);
    return value;
  }

  function textValue(form, name) {
    return String(form.elements.namedItem(name)?.value || '').trim();
  }

  function checked(form, name) {
    return Boolean(form.elements.namedItem(name)?.checked);
  }

  function identifier(form, name, label, optional = false) {
    const value = String(form.elements.namedItem(name)?.value || '').trim();
    if (!value && optional) return null;
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < 1) throw new Error(`Select a valid ${label}.`);
    return numeric;
  }

  function wholeNumber(form, name, label, { min = 0, optional = false } = {}) {
    const value = String(form.elements.namedItem(name)?.value || '').trim();
    if (!value && optional) return null;
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < min || numeric > 2_147_483_647) throw new Error(`${label} must be a whole number${min ? ` of at least ${min}` : ''} within the supported range.`);
    return numeric;
  }

  function moneyToCents(form, name, label, { optional = false } = {}) {
    const value = String(form.elements.namedItem(name)?.value || '').trim();
    if (!value && optional) return null;
    const numeric = Number(value);
    const cents = Math.round(numeric * 100);
    if (!Number.isFinite(numeric) || numeric < 0 || !Number.isSafeInteger(cents) || Math.abs(numeric * 100 - cents) > 0.000001) throw new Error(`${label} must be a non-negative amount with no more than two decimals.`);
    return cents;
  }

  function taxBasisPoints(form) {
    const value = String(form.elements.namedItem('tax_rate')?.value || '').trim();
    const numeric = value === '' ? 0 : Number(value);
    const basisPoints = Math.round(numeric * 100);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100 || !Number.isSafeInteger(basisPoints) || Math.abs(numeric * 100 - basisPoints) > 0.000001) throw new Error('Tax rate must be between 0% and 100%, with no more than two decimals.');
    return basisPoints;
  }

  function dateTimeValue(form, name, label, { required = false } = {}) {
    const value = String(form.elements.namedItem(name)?.value || '').trim();
    if (!value && !required) return null;
    if (!value) throw new Error(`${label} is required.`);
    const timezone = canonicalLocation()?.timezone || 'America/Chicago';
    try { return adminCore.localDateTimeToInstant(value, timezone); }
    catch (error) { throw new Error(`${label}: ${error.message}`); }
  }

  function buildConfigPayload(entity, form) {
    if (entity === 'closures') {
      const startsAt = dateTimeValue(form, 'starts_at', 'Starts', { required: true });
      const endsAt = dateTimeValue(form, 'ends_at', 'Ends', { required: true });
      if (new Date(endsAt) <= new Date(startsAt)) throw new Error('Closure end must be after its start.');
      const type = textValue(form, 'closure_type');
      if (!['FULL_CLOSURE', 'CAPACITY_REDUCTION'].includes(type)) throw new Error('Select a valid closure type.');
      const location = canonicalLocation();
      if (!location) throw new Error('The parking property is unavailable. Refresh and try again.');
      const scope = textValue(form, 'scope');
      if (!['LOT', 'PARKING_TYPE'].includes(scope)) throw new Error('Select a valid closure scope.');
      return {
        location_id: scope === 'LOT' ? Number(location.id) : null, zone_id: null, inventory_id: null,
        category_id: scope === 'PARKING_TYPE' ? identifier(form, 'category_id', 'parking type') : null,
        closure_type: type, capacity_reduction: type === 'CAPACITY_REDUCTION' ? wholeNumber(form, 'capacity_reduction', 'Spaces unavailable', { min: 1 }) : 0, starts_at: startsAt, ends_at: endsAt, reason: requiredText(form, 'reason', 'Reason'), internal_note: textValue(form, 'internal_note'), customer_message: textValue(form, 'customer_message'), active: checked(form, 'active')
      };
    }
    throw new Error('Unknown configuration form.');
  }

  function setFormBusy(form, busy) {
    adminCore.setFormBusy(form, busy);
  }

  async function saveConfig(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const entity = form.dataset.configForm;
    const id = String(form.elements.namedItem('id').value || '').trim();
    try {
      const payload = buildConfigPayload(entity, form);
      if (id) {
        const version = wholeNumber(form, 'version', 'Configuration version', { min: 1 });
        payload.version = version;
      }
      setFormBusy(form, true);
      setConfigMessage(`Saving ${configMeta[entity].singular}…`, 'loading');
      const result = await call(`/admin/parking/v1/${entity}${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      resetConfigForm(entity);
      configUi.dirty[entity] = false;
      const affectedBookings = entity === 'closures' && Array.isArray(result.affectedBookings) ? ` ${result.affectedBookings.length} active or future reservation${result.affectedBookings.length === 1 ? '' : 's'} overlap this closure.` : '';
      await loadConfig({ successMessage: `${configMeta[entity].singular.charAt(0).toUpperCase()}${configMeta[entity].singular.slice(1)} saved successfully.${affectedBookings}` });
    } catch (error) {
      setConfigMessage(error.message || 'Unable to save this configuration item.', 'error');
    } finally {
      setFormBusy(form, false);
    }
  }

  function resetCanonicalSettings() {
    configUi.dirty.business = false;
    if (!restoreFormBaseline('business', $('#businessSettingsForm'))) hydrateCanonicalSettings();
    const hint = $('#businessSettingsHint');
    if (hint) hint.textContent = 'Changes are saved to Trucker Heaven Parking.';
    setConfigMessage('Unsaved changes were reset.', 'info');
  }

  async function saveCanonicalLocation(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const location = canonicalLocation();
    if (!location) return setConfigMessage('The parking property is unavailable. Refresh and try again.', 'error');
    try {
      const roadDirections = textValue(form, 'road_directions_url');
      if (roadDirections && !/^https?:\/\//i.test(roadDirections)) throw new Error('Driving directions must use an http or https URL.');
      const payload = {
        name: requiredText(form, 'name', 'Property name'), public_description: textValue(form, 'public_description'),
        address: requiredText(form, 'address', 'Street address'), timezone: requiredText(form, 'timezone', 'IANA timezone'),
        phone: textValue(form, 'phone') || null, business_hours: textValue(form, 'business_hours'),
        arrival_instructions: textValue(form, 'arrival_instructions'), exit_instructions: textValue(form, 'exit_instructions'),
        road_directions_url: roadDirections, active: checked(form, 'active'), version: wholeNumber(form, 'version', 'Configuration version', { min: 1 })
      };
      setFormBusy(form, true);
      setConfigMessage('Saving property changes…', 'loading');
      const result = await call(`/admin/parking/v1/locations/${encodeURIComponent(location.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      const updated = result.item || { ...location, ...payload, version: Number(location.version) + 1 };
      configState.locations = configState.locations.map(item => String(item.id) === String(location.id) ? updated : item);
      configUi.dirty.business = false;
      populateCanonicalForm(form, updated, ['name', 'public_description', 'address', 'timezone', 'phone', 'business_hours', 'arrival_instructions', 'exit_instructions', 'road_directions_url', 'active']);
      captureFormBaseline('business', form);
      if (configUi.dirty.policies) { setFormValue($('#bookingPoliciesForm'), 'version', updated.version); updateBaselineField('policies', 'version', updated.version); }
      else { populateCanonicalForm($('#bookingPoliciesForm'), updated, ['booking_approval_mode', 'cancellation_cutoff_hours', 'payment_instructions']); captureFormBaseline('policies', $('#bookingPoliciesForm')); }
      setConfigMessage('Property changes saved successfully.', 'success');
    } catch (error) {
      setConfigMessage(error.message || 'Unable to save property changes.', 'error');
    } finally { setFormBusy(form, false); }
  }

  async function saveBookingPolicies(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const location = canonicalLocation();
    if (!location) return setConfigMessage('The parking property is unavailable. Refresh and try again.', 'error');
    try {
      const approval = textValue(form, 'booking_approval_mode');
      if (!['AUTO_CONFIRM', 'MANUAL_CONFIRM'].includes(approval)) throw new Error('Select a valid booking confirmation policy.');
      const payload = {
        booking_approval_mode: approval, cancellation_cutoff_hours: wholeNumber(form, 'cancellation_cutoff_hours', 'Cancellation cutoff'),
        payment_instructions: textValue(form, 'payment_instructions'), version: wholeNumber(form, 'version', 'Configuration version', { min: 1 })
      };
      setFormBusy(form, true);
      setConfigMessage('Saving booking policies…', 'loading');
      const result = await call(`/admin/parking/v1/locations/${encodeURIComponent(location.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      const updated = result.item || { ...location, ...payload, version: Number(location.version) + 1 };
      configState.locations = configState.locations.map(item => String(item.id) === String(location.id) ? updated : item);
      configUi.dirty.policies = false;
      populateCanonicalForm(form, updated, ['booking_approval_mode', 'cancellation_cutoff_hours', 'payment_instructions']);
      captureFormBaseline('policies', form);
      if (configUi.dirty.business) { setFormValue($('#businessSettingsForm'), 'version', updated.version); updateBaselineField('business', 'version', updated.version); }
      else { populateCanonicalForm($('#businessSettingsForm'), updated, ['name', 'public_description', 'address', 'timezone', 'phone', 'business_hours', 'arrival_instructions', 'exit_instructions', 'road_directions_url', 'active']); captureFormBaseline('business', $('#businessSettingsForm')); }
      setConfigMessage('Booking policies saved successfully.', 'success');
    } catch (error) {
      setConfigMessage(error.message || 'Unable to save booking policies.', 'error');
    } finally { setFormBusy(form, false); }
  }

  function updateClosureFields() {
    const form = $('[data-config-form="closures"]');
    if (!form) return;
    const reduction = $('#closureReductionWrap');
    const parkingType = $('#closureParkingTypeWrap');
    const capacity = form.elements.namedItem('capacity_reduction');
    const category = form.elements.namedItem('category_id');
    const isReduction = form.elements.namedItem('closure_type').value === 'CAPACITY_REDUCTION';
    const isParkingType = form.elements.namedItem('scope').value === 'PARKING_TYPE';
    reduction.hidden = !isReduction;
    parkingType.hidden = !isParkingType;
    capacity.required = isReduction;
    category.required = isParkingType;
    capacity.min = isReduction ? '1' : '0';
    if (isReduction && Number(capacity.value || 0) < 1) capacity.value = '1';
    if (!isReduction) capacity.value = '0';
  }

  async function loadConfig({ successMessage = '', quiet = false } = {}) {
    if (!isOwner()) return;
    if (!quiet) setConfigMessage('Loading configuration…', 'loading');
    try {
      const results = await Promise.all(configEntities.map(entity => call(`/admin/parking/v1/${entity}`)));
      results.forEach((result, index) => { configState[configEntities[index]] = Array.isArray(result.items) ? result.items : []; });
      renderConfig();
      setConfigMessage(successMessage || 'Configuration is up to date.', 'success');
    } catch (error) {
      setConfigMessage(error.status === 403 ? 'Configuration access requires an Owner account.' : (error.message || 'Unable to load configuration.'), 'error');
    }
  }

  function setAdminUsersMessage(message, kind = '') {
    setMessage('#adminUsersStatus', message, kind);
  }

  function isCurrentAdminUser(user) {
    return String(user.username || '').toLowerCase() === String(currentUser?.username || '').toLowerCase();
  }

  function resetAdminUserForm() {
    const form = $('#adminUserForm');
    form.reset();
    setFormValue(form, 'id', '');
    setFormValue(form, 'version', '');
    setFormValue(form, 'self', '');
    setFormValue(form, 'displayName', '');
    setFormValue(form, 'email', '');
    setFormValue(form, 'username', '');
    setFormValue(form, 'role', 'STAFF');
    setFormValue(form, 'password', '');
    setFormValue(form, 'active', true);
    form.elements.namedItem('username').disabled = false;
    form.elements.namedItem('role').disabled = false;
    form.elements.namedItem('active').disabled = true;
    $('#adminUserActiveLabel').hidden = true;
    $('#adminUserFormTitle').textContent = 'Add Team Member';
    $('#adminUserFormCopy').textContent = 'Create an account for a team member. Share the initial password through your approved internal process.';
    $('#adminPasswordLabel').firstChild.textContent = 'Initial password ';
    $('#adminPasswordHelp').textContent = 'Required for a new account. Minimum 16 characters. Passwords are never displayed or stored in plain text.';
    submitButton(form).textContent = 'Save Team Member';
    $('#adminSelfHelp').hidden = true;
    form.hidden = true;
  }

  function adminRoleLabel(role) {
    return role === 'OWNER' ? 'Owner' : 'Staff';
  }

  function renderAdminUsers() {
    if (!isOwner()) return;
    const rows = adminUsers.map(user => {
      const current = isCurrentAdminUser(user);
      const name = user.display_name || user.username;
      return `<tr><td data-label="Name"><strong>${esc(name)}</strong>${current ? ' <span class="current-user">You</span>' : ''}</td><td data-label="Username or Email"><span>${esc(user.username)}</span>${user.email ? `<small>${esc(user.email)}</small>` : ''}</td><td data-label="Role"><span class="user-role role-${esc(String(user.role || '').toLowerCase())}">${esc(adminRoleLabel(user.role))}</span></td><td data-label="Status">${activePill(user.active)}</td><td data-label="Last Login">${user.last_login_at ? date(user.last_login_at) : 'Never'}</td><td data-label="Added">${date(user.created_at)}</td><td data-label="Actions"><button type="button" class="secondary compact" data-admin-user-edit="${esc(user.id)}" aria-label="Manage ${esc(name)}">Manage</button></td></tr>`;
    });
    const noAdditionalUsers = adminUsers.filter(user => !isCurrentAdminUser(user)).length === 0;
    $('#adminUsersList').innerHTML = rows.length ? `<table class="team-table"><thead><tr><th>Name</th><th>Username or Email</th><th>Role</th><th>Status</th><th>Last Login</th><th>Added</th><th>Actions</th></tr></thead><tbody>${rows.join('')}</tbody></table>${noAdditionalUsers ? '<div class="user-empty-state"><strong>No additional team members</strong><p>Add an account when someone else needs operational access.</p></div>' : ''}` : '<div class="user-empty-state"><strong>No team accounts are available.</strong><p>Add an account when someone else needs operational access.</p></div>';
    $$('[data-admin-user-edit]').forEach(button => button.addEventListener('click', () => startAdminUserEdit(button.dataset.adminUserEdit)));
  }

  function startAdminUserEdit(id) {
    const user = adminUsers.find(item => String(item.id) === String(id));
    if (!user) {
      setAdminUsersMessage('That admin user is no longer available. Refresh the list and try again.', 'error');
      return;
    }
    const form = $('#adminUserForm');
    resetAdminUserForm();
    const current = isCurrentAdminUser(user);
    setFormValue(form, 'id', user.id);
    setFormValue(form, 'version', user.version);
    setFormValue(form, 'self', current ? 'true' : '');
    setFormValue(form, 'displayName', user.display_name || '');
    setFormValue(form, 'email', user.email || '');
    setFormValue(form, 'username', user.username);
    setFormValue(form, 'role', user.role);
    setFormValue(form, 'active', user.active);
    form.elements.namedItem('username').disabled = true;
    form.elements.namedItem('role').disabled = current;
    form.elements.namedItem('active').disabled = current;
    $('#adminUserActiveLabel').hidden = false;
    $('#adminUserFormTitle').textContent = current ? 'Your Team Account' : `Manage ${user.display_name || user.username}`;
    $('#adminUserFormCopy').textContent = current ? 'Update your name, email, or password. Your access level remains protected.' : 'Update the name, email, role, status, or password for this account.';
    $('#adminPasswordLabel').firstChild.textContent = 'New password (optional) ';
    $('#adminPasswordHelp').textContent = 'Leave blank to keep the existing password. Minimum 16 characters. Passwords are never displayed or stored in plain text.';
    submitButton(form).textContent = 'Save Changes';
    $('#adminSelfHelp').hidden = !current;
    form.hidden = false;
    setAdminUsersMessage(current ? 'Editing your account. You can update your name, email, or password.' : `Editing ${user.username}.`, 'info');
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function adminUserPayload(form) {
    const id = String(form.elements.namedItem('id').value || '').trim();
    const username = textValue(form, 'username').toLowerCase();
    const displayName = textValue(form, 'displayName');
    const adminEmail = textValue(form, 'email');
    const role = textValue(form, 'role').toUpperCase();
    const password = String(form.elements.namedItem('password').value || '');
    const self = form.elements.namedItem('self').value === 'true';
    if (!['STAFF', 'OWNER'].includes(role)) throw new Error('Select a valid admin role.');
    if (password && password.length < 16) throw new Error('Password must be at least 16 characters.');
    if (!id) {
      if (!/^[a-z0-9._-]{3,80}$/.test(username)) throw new Error('Enter a valid lowercase username.');
      if (password.length < 16) throw new Error('Password must be at least 16 characters.');
      return { id: '', payload: { username, displayName, email: adminEmail || null, role, password } };
    }
    const payload = { displayName, email: adminEmail || null };
    if (!self) {
      const existing = adminUsers.find(item => String(item.id) === id);
      const active = checked(form, 'active');
      if (existing?.role === 'OWNER' && existing.active && (role !== 'OWNER' || !active) && adminUsers.filter(item => item.role === 'OWNER' && item.active).length <= 1) throw new Error('At least one active Owner account must remain.');
      payload.role = role;
      payload.active = active;
    }
    if (password) payload.password = password;
    const userVersion = Number(form.elements.namedItem('version').value);
    if (!Number.isSafeInteger(userVersion) || userVersion < 1) throw new Error('This user changed. Refresh the list and try again.');
    payload.version = userVersion;
    return { id, payload };
  }

  async function saveAdminUser(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const { id, payload } = adminUserPayload(form);
      setFormBusy(form, true);
      setAdminUsersMessage(id ? 'Updating admin user…' : 'Creating admin user…', 'loading');
      await call(`/admin/parking/v1/admin-users${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      resetAdminUserForm();
      await loadAdminUsers({ successMessage: id ? 'Admin user updated successfully.' : 'Admin user created successfully.' });
    } catch (error) {
      setAdminUsersMessage(error.message || 'Unable to save this admin user.', 'error');
    } finally {
      setFormBusy(form, false);
    }
  }

  async function loadAdminUsers({ successMessage = '', quiet = false } = {}) {
    if (!isOwner()) return;
    if (!quiet) setAdminUsersMessage('Loading admin users…', 'loading');
    try {
      const result = await call('/admin/parking/v1/admin-users');
      adminUsers = Array.isArray(result.items) ? result.items : [];
      renderAdminUsers();
      setAdminUsersMessage(successMessage || 'Admin users are up to date.', 'success');
    } catch (error) {
      setAdminUsersMessage(error.status === 403 ? 'Admin user management requires an Owner account.' : (error.message || 'Unable to load admin users.'), 'error');
    }
  }

  const clone = value => value ? JSON.parse(JSON.stringify(value)) : value;
  const layoutValue = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const layoutElements = () => (layoutState.draft || layoutState.published)?.elements || [];
  const compactLayout = () => window.matchMedia('(max-width: 800px)').matches;
  const layoutElement = id => layoutElements().find(item => String(item.id) === String(id));
  const lotSpaceElements = () => layoutElements().filter(item => item.parking_spot_id && item.element_type === 'PARKING_SPOT');
  const lotConfigurationEditable = () => isOwner() && Boolean(layoutState.draft) && !compactLayout();
  const lotStructuralEditable = () => lotConfigurationEditable() && !layoutState.canonicalMaintenanceLocked;
  const lotGeometryEditable = () => lotStructuralEditable() && layoutState.editLayout;
  const lotPurpose = item => item.parking_purpose || (['CUSTOMER', 'CUSTOMER_BOBTAIL', 'DAILY', 'WEEKLY', 'MONTHLY'].includes(item.spot_parking_use) ? 'CUSTOMER' : item.spot_parking_use === 'COMPANY' ? 'COMPANY' : String(item.spot_parking_use || '').startsWith('SHOP') ? 'SHOP' : 'UNRESOLVED');
  const lotPublic = item => item.space_public_bookable ?? item.spot_public_bookable ?? false;
  const lotSpaceType = item => item._requestedPurpose || item._requestedSpaceType || (lotPurpose(item) !== 'CUSTOMER' ? lotPurpose(item) : item.spot_category_code === 'BOBTAIL' ? 'BOBTAIL' : item.spot_category_code === 'TRACTOR_TRAILER' ? 'GENERAL_TRUCK' : 'UNRESOLVED');
  const lotSpaceTypeLabel = value => ({ BOBTAIL: 'Bobtail', GENERAL_TRUCK: 'General Truck', SHOP: 'Shop', COMPANY: 'Company', UNRESOLVED: 'Needs selection' }[value] || 'Needs selection');
  const lotConfigKeys = ['parking_purpose', 'rate_plan_id', 'daily_eligible', 'monthly_eligible', 'space_public_bookable', 'active', 'space_internal_note'];
  const lotSelected = () => lotSpaceElements().filter(item => layoutState.selectedIds.has(String(item.id)));
  const lotPurposeLabel = value => ({ CUSTOMER: 'Customer Parking', SHOP: 'Shop', COMPANY: 'Company', UNRESOLVED: 'Needs selection' }[value] || 'Needs selection');
  const lotRatePlan = item => layoutState.ratePlans.find(plan => String(plan.id) === String(item.rate_plan_id));
  const lotRatePlanSummary = plan => plan ? `${plan.plan_name || 'Rate plan'}\n${plan.daily_rate_cents === null ? '—' : money(plan.daily_rate_cents)}/day${plan.weekly_rate_cents === null ? '' : ` · ${money(plan.weekly_rate_cents)}/week`}${plan.monthly_rate_cents === null ? '' : ` · ${money(plan.monthly_rate_cents)}/month`}` : 'No rate plan assigned';
  const lotTypeCategoryCode = type => ({ BOBTAIL: 'BOBTAIL', GENERAL_TRUCK: 'TRACTOR_TRAILER' }[type] || null);

  function lotStoredGeometry(item) {
    return { x: layoutValue(item.x), y: layoutValue(item.y), width: layoutValue(item.width, 1), height: layoutValue(item.height, 1), rotation: layoutValue(item.rotation) };
  }

  function lotPresentationGeometry(item) {
    return lotStoredGeometry(item);
  }

  function layoutScene(elements) {
    const bounds = adminCore.boundsFor(elements) || { minX: 0, minY: 0, maxX: 100, maxY: 100, width: 100, height: 100 };
    const padX = Math.max(1, bounds.width * .015); const padY = Math.max(1, bounds.height * .015);
    return { minX: bounds.minX - padX, minY: bounds.minY - padY, width: Math.max(1, bounds.width + padX * 2), height: Math.max(1, bounds.height + padY * 2) };
  }

  function lotCssGeometry(item, scene) {
    const geometry = lotStoredGeometry(item);
    return { ...geometry, x: (geometry.x - scene.minX) / scene.width * 100, y: (geometry.y - scene.minY) / scene.height * 100,
      width: geometry.width / scene.width * 100, height: geometry.height / scene.height * 100 };
  }

  function prepareLotGeometryForEdit(item) {
    return lotPresentationGeometry(item);
  }

  function renderLotDecorations(elements, scene) {
    return elements.filter(item => !item.parking_spot_id && item.element_type !== 'PARKING_SPOT').map(item => {
      const geometry = lotCssGeometry(item, scene);
      const kind = String(item.element_type || 'LABEL').toLowerCase().replaceAll('_', '-');
      const style = `left:${geometry.x}%;top:${geometry.y}%;width:${geometry.width}%;height:${geometry.height}%;z-index:${layoutValue(item.layer_order, 1)};transform:rotate(${geometry.rotation}deg)`;
      return `<div class="lot-map-decoration ${esc(kind)}" style="${style}" aria-hidden="true">${item.label ? `<span>${esc(item.label)}</span>` : ''}</div>`;
    }).join('');
  }

  function lotSetMessage(message, kind = '') { setMessage('#layoutStatus', message, kind); }
  function lotSnapshot() { return clone(layoutState.draft?.elements || []); }
  function lotPushHistory() {
    if (!layoutState.draft) return;
    layoutState.history.push(lotSnapshot());
    if (layoutState.history.length > 40) layoutState.history.shift();
    layoutState.future = [];
  }
  function lotChanged(item, key) {
    const baseline = (layoutState.baseline?.elements || []).find(candidate => String(candidate.id) === String(item.id));
    return Boolean(baseline) && String(item[key] ?? '') !== String(baseline[key] ?? '');
  }
  const lotDirty = () => layoutState.configDirty || layoutState.geometryDirty;
  const lotPublishable = () => lotConfigurationEditable() && !lotDirty();
  function lotSetDirty(message = 'Draft changes are ready to save.', kind = 'config') { layoutState[kind === 'geometry' ? 'geometryDirty' : 'configDirty'] = true; lotSetMessage(message, 'info'); renderLotSetup(); }
  function lotMixed(items, key) { return items.some(item => String(item[key] ?? '') !== String(items[0]?.[key] ?? '')); }
  function lotApplyInspectorValues(item, form, batch, selectedType, selectedPlan) {
    if (selectedType) {
      if (['SHOP', 'COMPANY'].includes(selectedType)) { item._requestedPurpose = selectedType; delete item._requestedSpaceType; item.parking_purpose = selectedType; }
      else { item._requestedSpaceType = selectedType; delete item._requestedPurpose; item.parking_purpose = selectedType === 'UNRESOLVED' ? 'UNRESOLVED' : 'CUSTOMER'; }
    }
    const bookingTerm = form.elements.bookingTerm?.value || '';
    if (bookingTerm) {
      item.daily_eligible = bookingTerm === 'DAILY';
      item.weekly_eligible = true;
      item.monthly_eligible = bookingTerm === 'MONTHLY';
    }
    for (const [field, key] of [['publiclyBookable','space_public_bookable'],['active','active']]) {
      if (batch) { if (form.elements[field].value !== '') item[key] = form.elements[field].value === 'true'; }
      else item[key] = form.elements[field].checked;
    }
    if (selectedPlan && selectedPlan !== '__none__') item.rate_plan_id = Number(selectedPlan);
    if (selectedPlan === '__none__') item.rate_plan_id = null;
    if (!batch) item.space_internal_note = form.elements.internalNote.value;
    if (['SHOP', 'COMPANY', 'UNRESOLVED'].includes(lotSpaceType(item))) {
      item.rate_plan_id = null; item.daily_eligible = false; item.weekly_eligible = false;
      item.monthly_eligible = false; item.space_public_bookable = false;
    }
    return item;
  }
  function lotEligibilityWarnings(items) {
    return items.flatMap(item => adminCore.bookingEligibilityWarnings(item, lotRatePlan(item)));
  }
  function lotCapabilitySummary() {
    const elements = lotSpaceElements(); const now = Date.now();
    const planReady = (item, plan) => Boolean(plan?.id && plan.active !== false
      && (!plan.starts_at || new Date(plan.starts_at).getTime() <= now)
      && (!plan.ends_at || new Date(plan.ends_at).getTime() > now)
      && (!plan.category_code || plan.category_code === lotTypeCategoryCode(lotSpaceType(item))));
    const customerReady = item => lotPurpose(item) === 'CUSTOMER' && item.active !== false && lotPublic(item)
      && Boolean(lotTypeCategoryCode(lotSpaceType(item)));
    const valid = (item, product) => {
      const plan = lotRatePlan(item); const enabled = product === 'DAILY' ? item.daily_eligible : item.monthly_eligible;
      const price = product === 'DAILY' ? plan?.daily_rate_cents : plan?.monthly_rate_cents;
      return customerReady(item) && enabled === true && planReady(item, plan) && price != null;
    };
    const invalid = elements.filter(item => customerReady(item) && (
      (item.daily_eligible === true && !valid(item, 'DAILY')) || (item.monthly_eligible === true && !valid(item, 'MONTHLY'))
    )).length;
    return { daily: elements.filter(item => valid(item, 'DAILY')).length, monthly: elements.filter(item => valid(item, 'MONTHLY')).length, invalid };
  }

  function renderLotCanvas(target, elements, { preview = false, sceneElements = elements } = {}) {
    if (!target) return;
    const scene = layoutScene(sceneElements);
    const zoom = preview ? 1 : layoutState.zoom;
    const baseWidth = 760;
    target.style.width = `${Math.round(baseWidth * zoom)}px`;
    target.style.height = `${Math.round(baseWidth * scene.height / scene.width * zoom)}px`;
    target.dataset.scene = JSON.stringify(scene);
    const spaces = elements.filter(item => item.parking_spot_id && item.element_type === 'PARKING_SPOT');
    let focusAssigned = false;
    const rendered = spaces.map(item => {
      const geometry = lotCssGeometry(item, scene);
      const style = `left:${geometry.x}%;top:${geometry.y}%;width:${geometry.width}%;height:${geometry.height}%;z-index:${layoutValue(item.layer_order, 20)};transform:rotate(${geometry.rotation}deg)`;
      const label = item.label || item.spot_label || String(item.element_type || '').replaceAll('_', ' ');
      const selected = !preview && layoutState.selectedIds.has(String(item.id));
      const focusable = selected || (!focusAssigned && !layoutState.selectedIds.size);
      if (focusable) focusAssigned = true;
      const purpose = lotPurpose(item).toLowerCase();
      return `<button type="button" class="lot-map-space purpose-${esc(purpose)}${item.active === false ? ' is-inactive' : ''}${selected ? ' is-selected' : ''}" style="${style}" data-lot-space="${esc(item.id)}" role="option" tabindex="${focusable ? '0' : '-1'}" aria-selected="${selected}" aria-label="${esc(`Space ${label}, ${lotPurposeLabel(lotPurpose(item))}${item.monthly_eligible ? ', monthly eligible' : ''}`)}"${preview ? ' disabled' : ''}><span>${esc(label)}</span>${item.monthly_eligible ? '<b aria-hidden="true">M</b>' : ''}</button>`;
    }).join('');
    target.innerHTML = `${renderLotDecorations(elements, scene)}${rendered || '<p class="layout-empty">No published map is available.</p>'}`;
  }

  function renderLotInspector() {
    const panel = $('#layoutProperties'); const items = lotSelected();
    if (!items.length) { panel.innerHTML = `<p class="empty">Select a space to edit.</p>${lotConfigurationEditable() ? '<p class="field-help" title="Hold Shift while selecting spaces to edit more than one.">Shift-click to select more than one.</p>' : ''}`; return; }
    const batch = items.length > 1; const sample = items[0];
    const checked = key => !lotMixed(items, key) && Boolean(sample[key]) ? ' checked' : '';
    const triState = (name, label, key) => `<label>${label}<select name="${name}"><option value="">Leave unchanged</option><option value="true"${!lotMixed(items, key) && Boolean(sample[key]) ? ' selected' : ''}>Enabled</option><option value="false"${!lotMixed(items, key) && !Boolean(sample[key]) ? ' selected' : ''}>Disabled</option></select></label>`;
    const spaceType = items.some(item => lotSpaceType(item) !== lotSpaceType(sample)) ? '' : lotSpaceType(sample);
    const planValue = lotMixed(items, 'rate_plan_id') ? '' : (sample.rate_plan_id ? String(sample.rate_plan_id) : '__none__');
    const categoryCode = lotTypeCategoryCode(spaceType);
    const plans = layoutState.ratePlans.filter(plan => String(plan.id) === planValue || (plan.active && (!categoryCode || plan.category_code === categoryCode)));
    const plan = lotRatePlan(sample);
    panel.innerHTML = `<form method="post" id="layoutPropertiesForm" class="lot-inspector-form">
      <p class="page-kicker">${batch ? `${items.length} SPACES SELECTED` : 'SPACE'}</p><h3>${batch ? 'Batch edit spaces' : 'Space inspector'}</h3>
      ${batch ? '' : `<dl class="space-readout"><div><dt>Space number</dt><dd>${esc(sample.label)}</dd></div></dl>`}
      <label>Classification<select name="spaceType"><option value=""${!spaceType ? ' selected' : ''}>Mixed / unchanged</option>${['BOBTAIL','GENERAL_TRUCK','SHOP','COMPANY','UNRESOLVED'].map(type => `<option value="${type}"${spaceType === type ? ' selected' : ''}${type === 'UNRESOLVED' ? ' disabled' : ''}>${esc(lotSpaceTypeLabel(type))}</option>`).join('')}</select></label>
      <label>Rate plan<select name="ratePlanId"${!spaceType || ['SHOP','COMPANY','UNRESOLVED'].includes(spaceType) ? ' disabled' : ''}><option value=""${planValue === '' ? ' selected' : ''}>Mixed / unchanged</option><option value="__none__"${planValue === '__none__' ? ' selected' : ''}>No rate plan</option>${plans.map(item => { const incompatible = Boolean(categoryCode && item.category_code !== categoryCode); return `<option value="${esc(item.id)}"${planValue === String(item.id) ? ' selected' : ''}${incompatible || !item.active ? ' disabled' : ''}>${esc(item.plan_name || `${friendlyState(item.category_code)} rate plan`)}${!item.active ? ' (inactive)' : ''}${incompatible ? ' (incompatible)' : ''}</option>`; }).join('')}</select></label>
      ${!batch && plan ? `<div class="rate-plan-summary"><strong>${esc(plan.plan_name || 'Rate plan')}</strong><span>${esc(lotRatePlanSummary(plan).split('\n')[1])}</span><button type="button" class="secondary compact" data-edit-rate-plan="${esc(plan.id)}">Edit Rate Plan</button></div>` : ''}
      <fieldset class="booking-availability"><legend>Booking term</legend>
        <label>Customer booking term<select name="bookingTerm"${['SHOP','COMPANY','UNRESOLVED'].includes(spaceType) ? ' disabled' : ''}><option value="">${batch ? 'Mixed / unchanged' : 'Select a term'}</option><option value="DAILY"${!lotMixed(items, 'daily_eligible') && sample.daily_eligible === true && sample.monthly_eligible !== true ? ' selected' : ''}>Daily</option><option value="MONTHLY"${!lotMixed(items, 'monthly_eligible') && sample.monthly_eligible === true && sample.daily_eligible !== true ? ' selected' : ''}>Monthly</option></select></label>
        <p class="field-help">Spaces 101–129 are Daily. Other active customer spaces are Monthly. Changes remain private until published.</p>
        <div class="booking-availability-warning" data-booking-availability-warning aria-live="polite"></div>
      </fieldset>
      ${batch ? `${triState('publiclyBookable', 'Publicly bookable', 'space_public_bookable')}${triState('active', 'Active', 'active')}` : `<label class="check"><input name="publiclyBookable" type="checkbox"${checked('space_public_bookable')}${['SHOP','COMPANY','UNRESOLVED'].includes(spaceType) ? ' disabled' : ''}> Publicly bookable</label><label class="check"><input name="active" type="checkbox"${checked('active')}> Active</label>`}
      ${batch ? '' : `<details class="lot-inspector-advanced"><summary>Advanced</summary><label>Internal note<textarea name="internalNote" maxlength="1000">${esc(sample.space_internal_note || '')}</textarea></label></details>`}
      ${lotConfigurationEditable() ? `<button type="submit">${batch ? 'Apply to selected spaces' : 'Apply space changes'}</button>` : '<p class="field-help">Only an Owner can change this draft.</p>'}</form>`;
    $('#layoutPropertiesForm')?.addEventListener('submit', applyLotInspector);
    $('#layoutPropertiesForm [name="spaceType"]')?.addEventListener('change', event => {
      const form = event.currentTarget.form; const type = event.currentTarget.value;
      const internal = ['SHOP', 'COMPANY', 'UNRESOLVED'].includes(type);
      for (const name of ['publiclyBookable', 'bookingTerm']) if (form.elements[name]) form.elements[name].disabled = internal;
      const planSelect = form.elements.ratePlanId;
      planSelect.disabled = internal || !type;
      if (internal) planSelect.value = '__none__';
      else if (type) {
        const code = lotTypeCategoryCode(type);
        const current = planSelect.value;
        planSelect.innerHTML = `<option value="">Leave unchanged</option><option value="__none__">No rate plan</option>${layoutState.ratePlans.filter(plan => plan.active && plan.category_code === code).map(plan => `<option value="${esc(plan.id)}">${esc(plan.plan_name || `${friendlyState(plan.category_code)} rate plan`)}</option>`).join('')}`;
        planSelect.value = [...planSelect.options].some(option => option.value === current) ? current : '__none__';
      }
    });
    const form = $('#layoutPropertiesForm');
    const refreshWarnings = () => {
      const prospective = items.map(item => lotApplyInspectorValues(clone(item), form, batch, form.elements.spaceType.value, form.elements.ratePlanId.value));
      const warnings = lotEligibilityWarnings(prospective);
      form.querySelector('[data-booking-availability-warning]').innerHTML = warnings.length
        ? warnings.map(item => `<p class="setup-warning">${esc(item.message)}</p>`).join('')
        : '<p class="field-help">The selected booking products and rate plan are compatible.</p>';
    };
    form.addEventListener('change', refreshWarnings);
    refreshWarnings();
    $('[data-edit-rate-plan]')?.addEventListener('click', event => openRatePlanDialog(event.currentTarget.dataset.editRatePlan, event.currentTarget));
  }

  function renderLotPricing() {
    const target = $('#layoutRatePlans'); if (!target) return;
    target.innerHTML = layoutState.ratePlans.length ? layoutState.ratePlans.map(plan => {
      const incomplete = plan.weekly_rate_cents === null || plan.weekly_rate_cents === undefined
        || [plan.daily_rate_cents, plan.monthly_rate_cents].every(value => value === null || value === undefined);
      const category = plan.category_code === 'BOBTAIL' ? 'Bobtail' : plan.category_code === 'TRACTOR_TRAILER' ? 'General Truck' : friendlyState(plan.category_name || plan.category_code);
      const assignedCount = lotSpaceElements().filter(item => String(item.rate_plan_id) === String(plan.id)).length;
      return `<article class="rate-plan-card${!plan.active ? ' is-inactive' : ''}${incomplete ? ' has-warning' : ''}"><div><span class="classification-info">${esc(category)}</span><h4>${esc(plan.plan_name || `${category} rate plan`)}</h4><p>${esc(displayNumber(assignedCount))} assigned draft space${assignedCount === 1 ? '' : 's'}</p></div><dl><div><dt>Daily</dt><dd>${esc(money(plan.daily_rate_cents))}</dd></div><div><dt>Weekly</dt><dd>${esc(money(plan.weekly_rate_cents))}</dd></div><div><dt>Monthly</dt><dd>${esc(money(plan.monthly_rate_cents))}</dd></div></dl><div>${activePill(Boolean(plan.active))}${incomplete ? '<span class="state is-warning">Incomplete</span>' : ''}</div><button type="button" class="secondary compact" data-edit-rate-plan="${esc(plan.id)}">Edit</button></article>`;
    }).join('') : '<div class="config-empty-state"><strong>No rate plans are available.</strong><p>Create a Bobtail or General Truck plan, then assign it to draft spaces.</p></div>';
    target.querySelectorAll('[data-edit-rate-plan]').forEach(button => button.addEventListener('click', event => openRatePlanDialog(event.currentTarget.dataset.editRatePlan, event.currentTarget)));
    $('#ratePlanCreate').disabled = !isOwner() || !layoutState.location;
  }

  function renderLotSetup() {
    const geometryEditing = lotGeometryEditable();
    const capability = lotCapabilitySummary(); const capabilitySource = layoutState.draft ? 'Draft' : 'Published';
    $('#layoutOwnerTools').hidden = !lotConfigurationEditable();
    $('#layoutMobileNotice').hidden = !isOwner() || !compactLayout();
    $('#layoutStatusBadges').innerHTML = layoutState.draft
      ? `<span class="state ${lotDirty() ? 'is-warning' : 'is-active'}" title="Changes remain private until you publish.">Editing draft</span><span class="state ${geometryEditing ? 'is-warning' : 'is-inactive'}">Layout editing ${geometryEditing ? 'on' : 'off'}</span>${layoutState.configDirty ? '<span class="state dirty">Configuration changed</span>' : ''}${layoutState.geometryDirty ? '<span class="state dirty">Geometry changed</span>' : ''}`
      : `<span class="state is-inactive">Published map</span>`;
    const invalidPriceSummary = capability.invalid
      ? `<span class="has-warning"><strong>${esc(displayNumber(capability.invalid))}</strong> product-enabled spaces without a valid matching price</span>`
      : '';
    $('#layoutCapabilitySummary').innerHTML = `<span><strong>${esc(displayNumber(capability.daily))}</strong> Daily-capable customer spaces</span><span><strong>${esc(displayNumber(capability.monthly))}</strong> Monthly-capable customer spaces</span>${invalidPriceSummary}<span>${capabilitySource} summary · Draft changes require Review &amp; Publish before customer visibility changes.</span>`;
    renderLotCanvas($('#layoutCanvas'), (layoutState.draft || layoutState.published)?.elements || []);
    $('#layoutCanvas').classList.toggle('is-layout-editing', geometryEditing);
    renderLotInspector();
    renderLotPricing();
    $('#layoutMaintenanceNotice').hidden = !layoutState.canonicalMaintenanceLocked;
    $('#layoutCreateDraft').hidden = !isOwner() || Boolean(layoutState.draft);
    $('#layoutCreateDraft').disabled = !layoutState.location;
    $('#layoutEditMode').hidden = !lotConfigurationEditable();
    $('#layoutEditMode').disabled = !lotStructuralEditable();
    $('#layoutEditMode').setAttribute('aria-pressed', String(geometryEditing));
    $('#layoutEditMode').textContent = geometryEditing ? 'Finish layout editing' : 'Edit layout';
    $('#layoutCanvas').style.transform = '';
    $('#layoutZoomValue').value = `${Math.round(layoutState.zoom * 100)}%`;
    $('#layoutUndo').disabled = !lotConfigurationEditable() || !layoutState.history.length;
    $('#layoutRedo').disabled = !lotConfigurationEditable() || !layoutState.future.length;
    $('#layoutSave').disabled = !lotConfigurationEditable() || !lotDirty();
    $('#layoutReviewPublish').disabled = !lotPublishable();
    $('#layoutReviewPublish').title = lotDirty() ? 'Save the draft before reviewing publication.' : '';
    $('#layoutRotate').disabled = !geometryEditing;
  }

  async function loadLotSetup({ quiet = false } = {}) {
    if (!layoutState.location) return;
    try {
      if (!quiet) lotSetMessage('Loading Trucker Heaven map…', 'loading');
      const response = await call(`/admin/parking/v1/locations/${encodeURIComponent(layoutState.location.id)}/layout`);
      layoutState.draft = response.draft || null; layoutState.published = response.published || null; layoutState.ratePlans = response.ratePlans || []; layoutState.canonicalMaintenanceLocked = Boolean(response.canonicalMaintenanceLocked);
      layoutState.baseline = clone(layoutState.draft); layoutState.configDirty = false; layoutState.geometryDirty = false; layoutState.selectedId = null; layoutState.selectedIds = new Set(); layoutState.history = []; layoutState.future = []; layoutState.editLayout = false;
      renderLotSetup(); lotSetMessage(layoutState.canonicalMaintenanceLocked ? 'The physical map is locked outside an approved maintenance window.' : (layoutState.draft ? 'Draft loaded. Layout dragging remains off until Edit layout is enabled.' : 'Published map loaded read-only. Start Changes to begin an owner edit.'), 'info');
      requestAnimationFrame(fitLotMap);
    } catch (error) { lotSetMessage(error.status === 403 ? 'Lot Setup is available to Owners only.' : (error.message || 'Unable to load the map.'), 'error'); }
  }

  async function loadLotSetupLocations({ preserve = true } = {}) {
    if (!configState.categories.length && isOwner()) {
      const categories = await call('/admin/parking/v1/categories');
      configState.categories = categories.items || [];
    }
    const locations = configState.locations.length ? configState.locations : operationalLocations;
    const previous = preserve ? String(layoutState.location?.id || '') : '';
    layoutState.locations = locations || [];
    layoutState.location = layoutState.locations.find(item => String(item.id) === previous)
      || layoutState.locations.find(item => item.exact_mode_active) || layoutState.locations.find(item => /trucker heaven/i.test(item.name || '')) || layoutState.locations[0] || null;
    if (layoutState.location) await loadLotSetup({ quiet: true }); else renderLotSetup();
  }

  async function createLotDraft() {
    if (!isOwner() || !layoutState.location) return lotSetMessage('Draft creation is unavailable.', 'error');
    try {
      const response = await call(`/admin/parking/v1/locations/${encodeURIComponent(layoutState.location.id)}/layout`, { method: 'POST', body: JSON.stringify({ name: `${layoutState.location.name} map draft` }) });
      layoutState.draft = response.draft; layoutState.baseline = clone(response.draft); layoutState.configDirty = false; layoutState.geometryDirty = false; layoutState.history = []; layoutState.future = []; layoutState.editLayout = false; renderLotSetup();
      lotSetMessage('A private draft was created from the published map.', 'success');
    } catch (error) { if (error.code === 'DRAFT_LAYOUT_EXISTS') return loadLotSetup({ quiet: true }); lotSetMessage(error.message || 'Unable to create a draft.', 'error'); }
  }

  function selectLotSpace(id, additive = false) {
    const key = String(id); if (!additive) layoutState.selectedIds = new Set([key]); else if (layoutState.selectedIds.has(key)) layoutState.selectedIds.delete(key); else layoutState.selectedIds.add(key);
    layoutState.selectedId = [...layoutState.selectedIds][0] || null; renderLotSetup();
    if (layoutState.selectedIds.has(key)) requestAnimationFrame(() => document.querySelector(`[data-lot-space="${CSS.escape(key)}"]`)?.focus({ preventScroll: true }));
  }
  function applyLotInspector(event) {
    event.preventDefault(); if (!lotConfigurationEditable()) return;
    const form = event.currentTarget; const items = lotSelected(); if (!items.length) return; const batch = items.length > 1; const selectedType = form.elements.spaceType.value; const selectedPlan = form.elements.ratePlanId.value;
    const prospective = items.map(item => lotApplyInspectorValues(clone(item), form, batch, selectedType, selectedPlan));
    const blocking = lotEligibilityWarnings(prospective).filter(item => item.blocking);
    if (blocking.length) return lotSetMessage(blocking[0].message, 'error');
    lotPushHistory();
    items.forEach((item, index) => Object.assign(item, prospective[index]));
    lotSetDirty('Space configuration updated locally. Save Draft to keep it.');
  }
  function ratePlanMoneyToCents(value, label) {
    const text = String(value || '').trim();
    if (!text) return null;
    const number = Number(text); const cents = Math.round(number * 100);
    if (!Number.isFinite(number) || number < 0 || !Number.isSafeInteger(cents) || Math.abs(number * 100 - cents) > .000001) throw new Error(`${label} must be a non-negative amount with no more than two decimals.`);
    return cents;
  }
  function openRatePlanDialog(id = '', trigger) {
    const plan = id ? layoutState.ratePlans.find(item => String(item.id) === String(id)) : null; const dialog = $('#ratePlanDialog'); const form = $('#ratePlanForm');
    if (id && !plan || !dialog || !form) return;
    layoutState.ratePlanDialogTrigger = trigger || null;
    form.reset(); form.dataset.mode = plan ? 'edit' : 'create';
    form.elements.id.value = plan?.id || ''; form.elements.version.value = plan?.version || '';
    form.elements.dailyRate.value = centsForInput(plan?.daily_rate_cents); form.elements.weeklyRate.value = centsForInput(plan?.weekly_rate_cents); form.elements.monthlyRate.value = centsForInput(plan?.monthly_rate_cents);
    const categoryWrap = $('#ratePlanCategoryWrap'); categoryWrap.hidden = Boolean(plan); form.elements.categoryId.required = !plan;
    form.elements.categoryId.innerHTML = `<option value="">Select parking type</option>${canonicalParkingCategories().map(item => `<option value="${esc(item.id)}">${esc(parkingTypeLabel(item))}</option>`).join('')}`;
    $('#ratePlanDialogHeading').textContent = plan ? `Edit ${plan.plan_name || 'Rate Plan'}` : 'Create Rate Plan';
    const assignedCount = plan ? lotSpaceElements().filter(item => String(item.rate_plan_id) === String(plan.id)).length : 0;
    $('#ratePlanSharedCount').textContent = plan ? `Changes affect ${displayNumber(assignedCount)} assigned space${assignedCount === 1 ? '' : 's'}. New draft assignments require publication before they affect public quotes.` : 'Create an applicable plan, then assign it to draft spaces. Publication is required before assignments affect public quotes.';
    setMessage('#ratePlanStatus', '', '');
    dialog.showModal(); form.elements.dailyRate.focus({ preventScroll: true });
  }
  function closeRatePlanDialog() { const dialog = $('#ratePlanDialog'); if (dialog?.open) dialog.close(); }
  async function saveRatePlan(event) {
    event.preventDefault(); if (!isOwner()) return;
    const form = event.currentTarget;
    try {
      const values = { dailyRateCents: ratePlanMoneyToCents(form.elements.dailyRate.value, 'Daily rate'), weeklyRateCents: ratePlanMoneyToCents(form.elements.weeklyRate.value, 'Weekly rate'), monthlyRateCents: ratePlanMoneyToCents(form.elements.monthlyRate.value, 'Monthly rate') };
      if (values.weeklyRateCents === null) throw new Error('Configure the Weekly rate used by customer and Admin booking.');
      if (values.dailyRateCents === null && values.monthlyRateCents === null) throw new Error('Configure at least one Daily or Monthly base rate.');
      setFormBusy(form, true); setMessage('#ratePlanStatus', 'Saving rate plan…', 'loading');
      if (form.dataset.mode === 'create') {
        const categoryId = Number(form.elements.categoryId.value);
        if (!Number.isSafeInteger(categoryId)) throw new Error('Select Bobtail or General Truck.');
        await call('/admin/parking/v1/rates', { method: 'POST', body: JSON.stringify({ location_id: Number(layoutState.location.id), zone_id: null, category_id: categoryId, daily_rate_cents: values.dailyRateCents, weekly_rate_cents: values.weeklyRateCents, monthly_rate_cents: values.monthlyRateCents, fee_cents: 0, tax_basis_points: 0, priority: 0, active: true }) });
      } else {
        await call(`/admin/parking/v1/rate-plans/${encodeURIComponent(form.elements.id.value)}`, { method: 'PATCH', body: JSON.stringify({ version: Number(form.elements.version.value), ...values }) });
      }
      await loadLotSetup({ quiet: true }); closeRatePlanDialog(); lotSetMessage('Rate plan saved. Draft assignments still require publication before they affect public quotes.', 'success');
    } catch (error) { setMessage('#ratePlanStatus', error.message || 'Unable to save rate plan.', 'error'); }
    finally { setFormBusy(form, false); }
  }
  function moveLotSelection(dx, dy) {
    const items = lotSelected(); if (!lotGeometryEditable() || !items.length) return; lotPushHistory();
    items.forEach(item => { const geometry = prepareLotGeometryForEdit(item); item.x = geometry.x + dx; item.y = geometry.y + dy; }); lotSetDirty('Draft space position updated. Save Draft to keep it.', 'geometry');
  }
  function rotateLotSelection() { const items = lotSelected(); if (!lotGeometryEditable() || !items.length) return; lotPushHistory(); items.forEach(item => { const geometry = prepareLotGeometryForEdit(item); item.rotation = (geometry.rotation + 90) % 360; }); lotSetDirty('Draft space rotation updated. Save Draft to keep it.', 'geometry'); }
  function undoLotChange() { if (!lotConfigurationEditable() || !layoutState.history.length) return; layoutState.future.push(lotSnapshot()); layoutState.draft.elements = layoutState.history.pop(); layoutState.configDirty = true; layoutState.geometryDirty = true; renderLotSetup(); lotSetMessage('Undid the last draft change.', 'info'); }
  function redoLotChange() { if (!lotConfigurationEditable() || !layoutState.future.length) return; layoutState.history.push(lotSnapshot()); layoutState.draft.elements = layoutState.future.pop(); layoutState.configDirty = true; layoutState.geometryDirty = true; renderLotSetup(); lotSetMessage('Restored the draft change.', 'info'); }

  async function saveLotDraft() {
    if (!lotConfigurationEditable() || !lotDirty()) return lotSetMessage('There are no draft changes to save.', 'info');
    try {
      lotSetMessage('Saving draft map…', 'loading'); const draft = layoutState.draft;
      const moved = lotSpaceElements().filter(item => lotChanged(item, 'x') || lotChanged(item, 'y') || lotChanged(item, 'rotation'));
      if (moved.length) {
        const response = await call(`/admin/parking/v1/layouts/${encodeURIComponent(draft.id)}/space-positions`, { method: 'PATCH', body: JSON.stringify({ layoutVersion: draft.version, moves: moved.map(item => ({ elementId: item.id, version: item.version, x: item.x, y: item.y, rotation: item.rotation })) }) });
        response.items.forEach(updated => Object.assign(layoutElement(updated.id), updated)); draft.version = response.layoutVersion;
      }
      const configured = lotSpaceElements().filter(item => item._requestedSpaceType || item._requestedPurpose || lotConfigKeys.some(key => lotChanged(item, key)));
      for (const item of configured) {
        const payload = { layoutVersion: draft.version, version: item.version, parkingSpotVersion: item.parking_spot_version };
        if (item._requestedSpaceType) payload.spaceType = lotSpaceType(item);
        if (item._requestedPurpose) payload.parkingPurpose = item._requestedPurpose;
        if (lotChanged(item, 'rate_plan_id') || item._requestedSpaceType || item._requestedPurpose) payload.ratePlanId = item.rate_plan_id || null;
        if (lotChanged(item, 'daily_eligible') || item._requestedSpaceType || item._requestedPurpose) payload.dailyEligible = Boolean(item.daily_eligible);
        if (lotChanged(item, 'monthly_eligible') || item._requestedSpaceType || item._requestedPurpose) payload.monthlyEligible = Boolean(item.monthly_eligible);
        if (lotChanged(item, 'space_public_bookable') || item._requestedSpaceType || item._requestedPurpose) payload.publiclyBookable = Boolean(lotPublic(item));
        if (lotChanged(item, 'active')) payload.active = item.active !== false;
        if (lotChanged(item, 'space_internal_note')) payload.internalNote = item.space_internal_note || '';
        const response = await call(`/admin/parking/v1/layouts/${encodeURIComponent(draft.id)}/spaces/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
        Object.assign(item, response.item); draft.version = response.layoutVersion;
      }
      await loadLotSetup({ quiet: true }); lotSetMessage('Changes saved privately. Parking Lot and customer views still use the published map.', 'success');
    } catch (error) { lotSetMessage(error.code === 'LAYOUT_VERSION_CONFLICT' || error.code === 'LAYOUT_ELEMENT_VERSION_CONFLICT' ? 'This draft changed in another session. Refresh before saving again.' : (error.message || 'Unable to save the draft.'), 'error'); }
  }
  async function publishLotDraft(event) {
    event?.preventDefault?.();
    if (!lotPublishable()) return lotSetMessage('Save the draft before publishing.', 'info');
    try {
      if (!$('#publishPhysicalConfirmation').checked) return setMessage('#publishChecklistStatus', 'Confirm the physical checklist before publishing.', 'error');
      lotSetMessage('Publishing draft map…', 'loading'); const response = await call(`/admin/parking/v1/layouts/${encodeURIComponent(layoutState.draft.id)}/publish`, { method: 'POST', body: JSON.stringify({ version: layoutState.draft.version, physicalConfirmation: true }) });
      layoutState.draft = response.draft; layoutState.published = response.published; layoutState.baseline = clone(response.draft); layoutState.configDirty = false; layoutState.geometryDirty = false; layoutState.history = []; layoutState.future = []; renderLotSetup(); lotSetMessage('Changes published. The new immutable version is now authoritative.', 'success');
      $('#publishChecklistDialog').close();
    } catch (error) { lotSetMessage(error.message || 'Unable to publish the draft.', 'error'); }
  }
  async function reviewLotPublish() {
    if (!lotConfigurationEditable()) return lotSetMessage('An Owner on a supported desktop must open a saved draft before publication.', 'error');
    if (!lotPublishable()) return lotSetMessage('Save the draft before reviewing the publish checklist.', 'info');
    const dialog = $('#publishChecklistDialog');
    const target = $('#publishChecklistItems');
    $('#publishPhysicalConfirmation').checked = false;
    $('#layoutPublish').disabled = true;
    target.innerHTML = '<p class="status-message loading">Checking the draft…</p>';
    setMessage('#publishChecklistStatus', '', '');
    dialog.showModal();
    try {
      const checklist = await call(`/admin/parking/v1/locations/${encodeURIComponent(layoutState.location.id)}/setup-checklist?layoutId=${encodeURIComponent(layoutState.draft.id)}`);
      const blocking = (checklist.checks || []).filter(item => item.code !== 'PHYSICAL_LAYOUT_CONFIRMED' && !item.passed);
      target.innerHTML = (checklist.checks || []).map(item => `<div class="publish-check ${item.passed ? 'passed' : 'failed'}"><span aria-hidden="true">${item.passed ? '✓' : '!'}</span><p><strong>${esc(item.label)}</strong>${item.message && !item.passed ? `<small>${esc(item.message)}</small>` : ''}</p></div>`).join('');
      $('#publishChecklistForm').dataset.ready = String(blocking.length === 0);
      setMessage('#publishChecklistStatus', blocking.length ? `${blocking.length} required check${blocking.length === 1 ? '' : 's'} must pass before publishing.` : 'Automated checks passed. Complete the physical confirmation to publish.', blocking.length ? 'error' : 'success');
    } catch (error) {
      $('#publishChecklistForm').dataset.ready = 'false';
      target.innerHTML = '';
      setMessage('#publishChecklistStatus', error.message || 'Unable to load the publish checklist.', 'error');
    }
  }

  function fitLotMap() {
    const stage = $('#layoutCanvasStage');
    const scene = layoutScene(layoutElements()); const baseHeight = 760 * scene.height / scene.width;
    layoutState.zoom = stage ? Math.max(.45, Math.min(1.5, (stage.clientWidth - 32) / 760, (stage.clientHeight - 32) / baseHeight)) : 1;
    layoutState.userZoomed = false;
    renderLotSetup();
    if (stage) requestAnimationFrame(() => { stage.scrollLeft = Math.max(0, ($('#layoutCanvas').scrollWidth - stage.clientWidth) / 2); stage.scrollTop = Math.max(0, ($('#layoutCanvas').scrollHeight - stage.clientHeight) / 2); });
  }
  function lotPointerDown(event) {
    if (event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const stage = $('#layoutCanvasStage'); const canvas = $('#layoutCanvas'); const button = event.target.closest('[data-lot-space]');
    if (!button || layoutState.tool === 'pan') { layoutState.pan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop }; canvas.setPointerCapture?.(event.pointerId); event.preventDefault(); return; }
    selectLotSpace(button.dataset.lotSpace, event.shiftKey);
    if (!lotGeometryEditable()) return;
    const items = lotSelected(); const rect = $('#layoutCanvas').getBoundingClientRect();
    layoutState.drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, rect, scene: layoutScene(layoutElements()), before: lotSnapshot(), items: items.map(item => ({ id: item.id, ...lotPresentationGeometry(item) })), moved: false }; canvas.setPointerCapture?.(event.pointerId); event.preventDefault();
  }
  function lotPointerMove(event) {
    if (layoutState.pan) { const stage = $('#layoutCanvasStage'); stage.scrollLeft = layoutState.pan.left - (event.clientX - layoutState.pan.x); stage.scrollTop = layoutState.pan.top - (event.clientY - layoutState.pan.y); return; }
    const drag = layoutState.drag; if (!drag || drag.pointerId !== event.pointerId) return; const dx = Math.round((event.clientX - drag.startX) / drag.rect.width * drag.scene.width * 10) / 10; const dy = Math.round((event.clientY - drag.startY) / drag.rect.height * drag.scene.height * 10) / 10;
    if (!drag.moved && (Math.abs(event.clientX - drag.startX) > 2 || Math.abs(event.clientY - drag.startY) > 2)) { layoutState.history.push(drag.before); if (layoutState.history.length > 40) layoutState.history.shift(); layoutState.future = []; drag.moved = true; }
    if (!drag.moved) return;
    drag.items.forEach(origin => {
      const item = layoutElement(origin.id); prepareLotGeometryForEdit(item); item.x = origin.x + dx; item.y = origin.y + dy;
      const geometry = lotCssGeometry(item, drag.scene); const node = document.querySelector(`[data-lot-space="${CSS.escape(String(item.id))}"]`);
      if (node) node.style.cssText = `left:${geometry.x}%;top:${geometry.y}%;width:${geometry.width}%;height:${geometry.height}%;z-index:${layoutValue(item.layer_order, 20)};transform:rotate(${geometry.rotation}deg)`;
    });
  }
  function lotPointerUp(event) { const moved = layoutState.drag?.moved; const pointerId = layoutState.drag?.pointerId ?? layoutState.pan?.pointerId; layoutState.drag = null; layoutState.pan = null; if (pointerId !== undefined && event?.currentTarget?.hasPointerCapture?.(pointerId)) event.currentTarget.releasePointerCapture(pointerId); if (moved) lotSetDirty('Draft space position updated. Save Draft to keep it.', 'geometry'); }
  function focusLotSearch() { const term = $('#layoutSpaceSearch').value.trim(); if (!term) return; const item = lotSpaceElements().find(space => String(space.label) === term); if (!item) return lotSetMessage(`Space ${term} is not in this map.`, 'error'); selectLotSpace(item.id); document.querySelector(`[data-lot-space="${CSS.escape(String(item.id))}"]`)?.focus({ preventScroll: true }); }
  function closeLotPreview() { $('#layoutPreviewPanel').hidden = true; layoutState.previewRestore?.focus?.({ preventScroll: true }); layoutState.previewRestore = null; }

  async function loadOperationalLocations() {
    const result = await call('/admin/parking/v1/operational-locations');
    operationalLocations = result.items || [];
  }

  function liveDateTimeForZone(value, timezone) {
    try { return adminCore.formatDateTimeLocal(value, timezone || 'UTC'); } catch (_) { return ''; }
  }

  function liveDate(value, timezone = liveState.data?.location?.timezone) {
    const instant = new Date(value);
    if (Number.isNaN(instant.getTime())) return '—';
    try {
      return new Intl.DateTimeFormat(undefined, { timeZone: timezone || undefined, dateStyle: 'medium', timeStyle: 'short' }).format(instant);
    } catch (_) {
      return date(value);
    }
  }

  function liveTimestampFromInput(value, timezone) {
    return adminCore.localDateTimeToInstant(value, timezone || 'UTC');
  }

  function liveOperationalStatus(spot) { return adminCore.canonicalStatus(spot); }
  function liveStatusClass(spot) { return adminCore.statusClass(spot); }
  function setLiveZoom(next) {
    liveState.zoom = Math.max(.45, Math.min(1.6, Math.round(next * 100) / 100));
    liveState.userZoomed = true;
    if (liveState.data) renderLiveLot();
  }

  function resetLiveMapViewport() {
    const stage = $('#liveLotMapStage');
    const scene = layoutScene(liveState.data?.layout?.elements || []); const baseHeight = 610 * scene.height / scene.width;
    liveState.zoom = stage ? Math.max(.45, Math.min(1.5, (stage.clientWidth - 32) / 610, (stage.clientHeight - 32) / baseHeight)) : 1;
    liveState.userZoomed = false;
    if (stage) requestAnimationFrame(() => { stage.scrollLeft = Math.max(0, ($('#liveLotMap').scrollWidth - stage.clientWidth) / 2); stage.scrollTop = Math.max(0, ($('#liveLotMap').scrollHeight - stage.clientHeight) / 2); });
    if (liveState.data) renderLiveLot();
  }

  function liveSpots() {
    const spaces = liveState.data?.spaces || [];
    return adminCore.filterLiveSpaces(spaces, liveState.filters);
  }

  function liveStatusBadge(space) {
    const future = space.nextReservation ? '<span class="live-marker" title="Future reservation" aria-label="Future reservation">◷</span>' : '';
    const warningCount = (space.warnings || []).filter(item => item.severity !== 'INFO').length;
    const warning = warningCount ? `<span class="live-warning-marker" aria-label="${esc(`${warningCount} configuration warning${warningCount === 1 ? '' : 's'}`)}">!</span>` : '';
    return `<span class="live-status-label state-${esc(liveStatusClass(space))}">${esc(friendlyState(liveOperationalStatus(space)))}${future}${warning}</span>`;
  }

  function renderLiveControls() {
    const spaces = liveState.data?.spaces || [];
    const vehicles = [...new Map(spaces.flatMap(space => space.vehicleEligibility || []).map(item => [String(item.id), item])).values()];
    const uses = [...new Set(spaces.map(space => space.parkingUse).filter(useName => useName && useName !== 'UNCLASSIFIED'))];
    if (vehicles.length) liveState.filterOptions.vehicles = vehicles;
    if (uses.length) liveState.filterOptions.uses = uses;
    const visibleVehicles = [...new Map([...vehicles, ...liveState.filterOptions.vehicles].map(item => [String(item.id), item])).values()];
    const visibleUses = [...new Set([...uses, ...liveState.filterOptions.uses])];
    $('#liveLotVehicle').innerHTML = `<option value="">All vehicle types</option>${visibleVehicles.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}`;
    $('#liveLotUse').innerHTML = `<option value="">All parking use</option>${visibleUses.map(item => `<option value="${esc(item)}">${esc(friendlyState(item))}</option>`).join('')}`;
    $('#liveLotState').value = liveState.filters.operationalStatus;
    $('#liveLotVehicle').value = liveState.filters.vehicleCategoryId;
    $('#liveLotUse').value = liveState.filters.parkingUse;
    $('#liveLotAvailableOnly').checked = liveState.filters.availableOnly;
    $('#liveLotIssuesOnly').checked = liveState.filters.issuesOnly;
    $('#liveLotFutureOnly').checked = liveState.filters.futureOnly;
    $('#liveLotMonthlyOnly').checked = liveState.filters.monthlyOnly;
    const timezone = liveState.data?.location?.timezone || 'UTC';
    const updated = `${liveDate(liveState.data?.evaluatedAt, timezone)} · ${timezone}`;
    $('#liveLotTime').textContent = updated;
    $('#shellLiveLotTime').textContent = `Last updated ${updated}`;
    $('#liveLotAt').value = liveDateTimeForZone(liveState.data?.evaluatedAt, timezone);
    const future = Boolean(liveState.requestedAt);
    $('#liveLotFutureNotice').hidden = !future;
    $('#liveLotFutureNotice').textContent = future ? `Viewing future state: ${liveDate(liveState.data?.evaluatedAt, timezone)} (${timezone})` : '';
  }

  function renderLiveLegend() {
    const statuses = ['AVAILABLE', 'RESERVED', 'OCCUPIED', 'BLOCKED', 'INACTIVE', 'UNKNOWN'];
    $('#liveLotLegend').innerHTML = `${statuses.map(status => `<span class="legend-${status.toLowerCase()}"><i></i>${esc(friendlyState(status))}</span>`).join('')}<span><i class="legend-monthly"></i>Monthly capable</span><span><i class="legend-shop"></i>Shop</span><span><i class="legend-company"></i>Company</span><span><i class="legend-customer"></i>Customer-bookable</span><span><i class="legend-warning"></i>Needs classification</span><span><i class="legend-future"></i>Future reservation</span>`;
  }

  function renderLiveMap(spaces) {
    const map = $('#liveLotMap'); const snapshot = liveState.data; const byId = new Map(spaces.map(space => [String(space.id), space]));
    const scene = layoutScene(snapshot?.layout?.elements || []);
    map.style.width = `${Math.round(610 * liveState.zoom)}px`;
    map.style.height = 'auto';
    $('#liveLotZoomValue').value = `${Math.round(liveState.zoom * 100)}%`;
    $('#liveLotZoomValue').textContent = `${Math.round(liveState.zoom * 100)}%`;
    if (!snapshot?.layout) {
      map.setAttribute('viewBox', `${scene.minX} ${scene.minY} ${scene.width} ${scene.height}`);
      map.innerHTML = `<text x="50" y="50" text-anchor="middle" class="live-map-svg-message">No published physical map is available.</text>`;
      return;
    }
    let focusAssigned = false;
    const objects = snapshot.layout.elements.filter(element => element.active !== false).map(element => {
      const space = element.spaceId ? byId.get(String(element.spaceId)) : null;
      const x = Number(element.x), y = Number(element.y), width = Number(element.width), height = Number(element.height);
      const rotation = Number(element.rotation || 0); const transform = rotation ? ` transform="rotate(${rotation} ${x + width / 2} ${y + height / 2})"` : '';
      if (element.spaceId) {
        if (!space) return '';
        const selected = String(space.id) === String(liveState.selectedId);
        const focusable = selected || (!focusAssigned && !liveState.selectedId);
        if (focusable) focusAssigned = true;
        const warningCount = (space.warnings || []).filter(item => item.severity !== 'INFO').length;
        const internal = ['SHOP','COMPANY','INTERNAL'].includes(String(space.parkingPurpose || space.parkingUse).toUpperCase());
        const semanticState = internal ? (String(space.parkingPurpose || space.parkingUse).toUpperCase() === 'INTERNAL' ? 'INTERNAL' : String(space.parkingPurpose || space.parkingUse).toUpperCase()) : liveOperationalStatus(space);
        const current = space.currentReservation;
        const operationalDetail = current ? [current.customer?.name, current.vehicle?.licensePlate,
          current.vehicle?.unitNumber && `Unit ${current.vehicle.unitNumber}`].filter(Boolean).join(' · ') : '';
        return `<g class="live-space state-${esc(liveStatusClass(space))} use-${esc(String(space.parkingUse || '').toLowerCase())} purpose-${esc(String(space.parkingPurpose || 'unresolved').toLowerCase())}${adminCore.publiclyBookableAvailable(space) ? ' customer-bookable' : ' internal-only'}${space.monthlyEligible ? ' is-monthly-eligible' : ''}${space.classificationState === 'NEEDS_CLASSIFICATION' ? ' needs-classification' : ''}${selected ? ' is-selected' : ''}${warningCount ? ' has-warning' : ''}" data-live-spot="${esc(space.id)}" data-live-select="${esc(space.id)}" data-space-id="${esc(space.id)}" data-physical-label="${esc(space.number)}" role="option" tabindex="${focusable ? '0' : '-1'}" aria-selected="${selected}" aria-label="Space ${esc(space.number)}, ${esc(semanticState)}, ${esc(space.parkingUseLabel || friendlyState(space.parkingUse))}${operationalDetail ? `, ${esc(operationalDetail)}` : ''}"${transform}><title>Space ${esc(space.number)} · ${esc(semanticState)}${operationalDetail ? ` · ${esc(operationalDetail)}` : ''}${current?.rateCents ? ` · ${esc(money(current.rateCents))}` : ''}</title><rect x="${x}" y="${y}" width="${width}" height="${height}" rx=".12"/><text class="compact-map-label" x="${x + width / 2}" y="${y + height / 2 - .35}" text-anchor="middle" dominant-baseline="central">${esc(space.number)}</text><text class="live-state-label" x="${x + width / 2}" y="${y + height / 2 + .55}" text-anchor="middle">${esc(semanticState)}</text>${space.monthlyEligible ? `<text class="live-monthly-marker" x="${x + width - .18}" y="${y + height - .15}" text-anchor="end">M</text>` : ''}${space.nextReservation ? `<circle class="live-future-dot" cx="${x + width - .18}" cy="${y + .18}" r=".16"/>` : ''}${warningCount ? `<circle class="live-warning-dot" cx="${x + .18}" cy="${y + .18}" r=".16"/>` : ''}</g>`;
      }
      const type = String(element.type || '').toLowerCase();
      const logo = type === 'building' && /trucker heaven/i.test(String(element.label || '')) ? `<g class="live-map-brand" transform="translate(${x + width / 2} ${y + height / 2})"><text y="-.55" text-anchor="middle">TH</text><text y=".3" text-anchor="middle">TRUCKER</text><text y="1.05" text-anchor="middle">HEAVEN</text></g>` : '';
      const label = element.label ? `<text class="compact-map-label" x="${x + width / 2}" y="${y + height / 2}" text-anchor="middle" dominant-baseline="central">${esc(element.label)}</text>` : logo;
      return `<g class="live-map-object type-${esc(type)}"${transform}><title>${esc(element.label || friendlyState(element.type))}</title><rect x="${x}" y="${y}" width="${width}" height="${height}"/>${label}</g>`;
    }).join('');
    map.setAttribute('viewBox', `${scene.minX} ${scene.minY} ${scene.width} ${scene.height}`); map.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    map.innerHTML = objects || `<text x="${scene.minX + scene.width / 2}" y="${scene.minY + scene.height / 2}" text-anchor="middle" class="live-map-svg-message">The published diagram has no visible elements.</text>`;
  }

  function renderLiveFallback(spaces) {
    const placedIds = new Set((liveState.data?.layout?.elements || []).filter(element => element.spaceId).map(element => String(element.spaceId)));
    const placed = spaces.filter(space => placedIds.has(String(space.id)));
    const unplaced = spaces.filter(space => !placedIds.has(String(space.id)));
    const renderRows = rows => rows.map(space => `<button type="button" class="space-row state-${esc(liveStatusClass(space))}${placedIds.has(String(space.id)) ? ' is-placed' : ''}${String(space.id) === String(liveState.selectedId) ? ' is-selected' : ''}" data-live-list-space="${esc(space.id)}" data-live-select="${esc(space.id)}"><span><strong>Space ${esc(space.number)}</strong><small>${esc(space.parkingUseLabel || 'Operational space')}${space.monthlyEligible ? ' · Monthly capable' : ''}</small></span>${liveStatusBadge(space)}<small>${space.currentReservation ? esc([space.currentReservation.customer?.name,space.currentReservation.vehicle?.licensePlate,space.currentReservation.vehicle?.unitNumber && `Unit ${space.currentReservation.vehicle.unitNumber}`,space.currentReservation.rateCents && money(space.currentReservation.rateCents)].filter(Boolean).join(' · ')) : (space.nextReservation ? `Next: ${esc(liveDate(space.nextReservation.startsAt))}` : 'No current booking')}</small></button>`).join('');
    $('#liveLotList').innerHTML = placed.length
      ? renderRows(placed)
      : '<p class="empty">No mapped spaces match the selected filters.</p>';
    $('#liveLotUnplaced').hidden = !unplaced.length;
    $('#liveLotUnplacedList').innerHTML = unplaced.length ? renderRows(unplaced) : '';
  }

  function renderLiveLot() {
    const data = liveState.data;
    if (!data) return;
    renderLiveControls(); renderLiveLegend();
    const spaces = liveSpots();
    const liveCounts = adminCore.summarizeLiveSpaces(data.spaces || [], data.summary);
    const areaCapacity = (data.areaCapacity || []).map(item => `<div class="live-count area-capacity-count${Number(item.shortfall || 0) ? ' state-capacity-shortfall' : ''}"><small>${esc(item.area)}</small><strong>${esc(displayNumber(item.availableCapacity))} available</strong><span>${esc(displayNumber(item.reservedCapacity))} reserved · ${esc(displayNumber(item.checkedInCapacity))} checked in · ${esc(displayNumber(item.blockedPhysical))} blocked / ${esc(displayNumber(item.physicalCapacity))} physical${Number(item.shortfall || 0) ? ` · SHORTFALL ${esc(displayNumber(item.shortfall))}` : ''}</span></div>`).join('');
    $('#liveLotSummary').innerHTML = `${areaCapacity}${[['Physical active', liveCounts.physical], ['Visible results', spaces.length], ['Available exact spaces', liveCounts.available], ['Customer-bookable', liveCounts.customerBookable], ['Exact reserved', liveCounts.reserved], ['Exact occupied', liveCounts.occupied], ['Blocked', liveCounts.blocked], ['Inactive', liveCounts.inactive], ['Unknown', liveCounts.unknown], ['Unresolved', liveCounts.unresolved], ['Configuration warnings', liveCounts.configurationWarnings]].map(([label, value]) => `<div class="live-count state-${esc(String(label).toLowerCase().replaceAll(' ', '-').replaceAll('/', '-'))}"><small>${esc(label)}</small><strong>${esc(displayNumber(value || 0))}</strong></div>`).join('')}`;
    const warnings = data.warnings || [];
    if (warnings.length) setMessage('#liveLotStatus', `${warnings.length} configuration warning${warnings.length === 1 ? '' : 's'} need attention.`, 'info');
    else if (!liveState.loading) {
      const hasFilters = Object.values(liveState.filters).some(Boolean);
      setMessage('#liveLotStatus', spaces.length ? 'Parking Lot is up to date.' : (hasFilters ? 'No spaces match the selected filters.' : 'No numbered spaces are configured for this parking lot.'), spaces.length ? 'success' : 'info');
    }
    renderLiveMap(spaces); renderLiveFallback(spaces);
    $$('[data-live-select]').forEach(button => {
      button.addEventListener('click', () => selectLiveSpot(button.dataset.liveSelect, button));
    });
    $$('[data-live-spot]').forEach(button => {
      button.addEventListener('focus', () => { $$('[data-live-spot]').forEach(item => { item.tabIndex = item === button ? 0 : -1; }); });
      button.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectLiveSpot(button.dataset.liveSpot, button); return; }
        if (event.key === 'Escape') { const id = button.dataset.liveSpot; event.preventDefault(); liveState.detailGate.cancel(); liveState.timelineGate.cancel(); liveState.selectedId = null; liveState.detail = null; liveState.timeline = null; liveState.detailLoading = false; liveState.timelineLoading = false; renderLiveLot(); document.querySelector(`[data-live-spot="${CSS.escape(String(id))}"]`)?.focus(); return; }
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        const candidates = $$('[data-live-spot]'); const index = candidates.indexOf(button);
        const direction = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
        event.preventDefault(); candidates[(index + direction + candidates.length) % candidates.length]?.focus();
      });
    });
    renderLiveSpacePanel();
  }

  async function selectLiveSpot(id, trigger = document.activeElement) {
    liveState.detailGate.cancel(); liveState.timelineGate.cancel();
    liveState.selectedId = String(id); liveState.lastFocus = trigger; liveState.detail = null; liveState.timeline = null;
    renderLiveLot();
    document.querySelector(`.space-row[data-live-list-space="${CSS.escape(String(id))}"]`)?.scrollIntoView({ block: 'nearest' });
    await loadLiveDetail(id);
  }

  function renderTimeline(detail) {
    if (liveState.timelineLoading) return '<p class="status-message loading">Loading availability timeline…</p>';
    if (!liveState.timeline) return '<p class="empty">Availability timeline is unavailable. <button type="button" class="secondary compact" data-live-retry-timeline>Retry</button></p>';
    const timeline = liveState.timeline;
    return `<section class="live-timeline"><h4>Availability timeline</h4><p class="field-help">Next 30 days · ${esc(timeline.space.timezone)} · [start, end)</p>${timeline.warnings?.length ? `<p class="inline-alert">${esc(timeline.warnings.map(item => item.message).join(' '))}</p>` : ''}<ol>${timeline.intervals.map(item => `<li class="state-${esc(String(item.type).toLowerCase())}"><b>${esc(friendlyState(item.type))}</b><span>${esc(liveDate(item.startsAt, timeline.space.timezone))} → ${esc(liveDate(item.endsAt, timeline.space.timezone))}</span>${item.reservationNumber ? `<small>${esc(item.reservationNumber)}${item.customer?.name ? ` · ${esc(item.customer.name)}` : ''}</small>` : ''}${item.reason ? `<small>${esc(item.reason)}</small>` : ''}</li>`).join('') || '<li>No future intervals were returned.</li>'}</ol></section>`;
  }

  function liveReservationActionLabel(detailData) {
    if (!detailData.currentReservation) return '';
    if (detailData.actions?.canCheckIn) return 'Open check-in workflow';
    if (detailData.actions?.canCheckOut) return 'Open check-out workflow';
    return 'View reservation';
  }

  function renderLiveSpacePanel() {
    const panel = $('#liveLotPanelDetail'); const snapshotSpace = liveState.data?.spaces.find(item => String(item.id) === String(liveState.selectedId));
    panel.classList.toggle('is-open', Boolean(snapshotSpace));
    if (!snapshotSpace) { panel.innerHTML = '<p class="empty">Select a space to view details.</p>'; return; }
    if (liveState.detailLoading) { panel.innerHTML = `<button type="button" class="panel-close" data-live-close aria-label="Close selected space">×</button><p class="status-message loading">Loading Space ${esc(snapshotSpace.number)}…</p>`; bindLivePanel(); return; }
    const detailData = { ...(liveState.detail || snapshotSpace) }; const current = detailData.currentReservation; const customer = detailData.currentCustomer; const vehicle = detailData.currentVehicle;
    const actionableWarnings = (detailData.warnings || []).filter(item => item.severity !== 'INFO');
    const classificationInfo = detailData.classificationState === 'COMPLETE' && ['SHOP', 'SHOP_BOBTAIL', 'COMPANY'].includes(detailData.parkingUse)
      ? '<section class="live-detail-section classification-info"><h4>Internal classification</h4><p>Booking eligibility: Internal only<br>Configuration: Complete</p></section>' : '';
    panel.innerHTML = `<button type="button" class="panel-close" data-live-close aria-label="Close selected space">×</button><p class="page-kicker">SPACE ${esc(detailData.number)}</p><h3>${liveStatusBadge(detailData)}</h3><dl class="space-details"><div><dt>Physical section</dt><dd>${esc(detailData.physicalSection || 'Not configured')}</dd></div><div><dt>Parking use</dt><dd>${esc(detailData.parkingUseLabel || friendlyState(detailData.parkingUse))}</dd></div><div><dt>Classification</dt><dd>${esc(friendlyState(detailData.classificationState))}</dd></div><div><dt>Daily</dt><dd>${detailData.dailyEligible ? 'Enabled' : 'Disabled'}</dd></div><div><dt>Monthly</dt><dd>${detailData.monthlyEligible ? 'Enabled' : 'Disabled'}</dd></div><div><dt>Rate-plan status</dt><dd>${detailData.ratePlan ? `${esc(detailData.ratePlan.name)} · ${detailData.ratePlan.active ? 'Active' : 'Unavailable'}` : 'No rate plan assigned'}</dd></div><div><dt>Public booking status</dt><dd>${detailData.publicBookable && (detailData.dailyEligible || detailData.weeklyEligible || detailData.monthlyEligible) ? 'Enabled for configured products' : 'Not customer-bookable'}</dd></div><div><dt>Vehicle eligibility</dt><dd>${esc((detailData.vehicleEligibility || []).map(item => item.name).join(', ') || 'Not configured')}</dd></div></dl>${classificationInfo}${actionableWarnings.length ? `<section class="live-warnings"><h4>Needs attention</h4>${actionableWarnings.map(item => `<p class="severity-${esc(String(item.severity).toLowerCase())}">${esc(item.message)}</p>`).join('')}</section>` : ''}${current ? `<section class="live-detail-section"><h4>Current parking</h4><p><b>${esc(current.reservationNumber)}</b> · ${esc(friendlyState(current.status))}${current.duration ? ` · ${esc(friendlyState(current.duration))}` : ''}</p><p>${esc(customer?.name || 'Customer details loading')} ${customer?.company ? `· ${esc(customer.company)}` : ''}</p><p>${esc(customer?.phone || '—')}<br>${esc(customer?.email || '—')}</p><p>Arrival: ${esc(detailData.currentAssignment?.actualCheckInAt ? liveDate(detailData.currentAssignment.actualCheckInAt) : liveDate(current.startsAt))}<br>Expected departure: ${esc(liveDate(current.endsAt))}</p><p>${vehicle ? `Unit ${esc(vehicle.unitNumber || '—')} · Trailer ${esc(vehicle.trailerNumber || '—')} · Plate ${esc(vehicle.licensePlate || '—')}${vehicle.licensePlateState ? ` (${esc(vehicle.licensePlateState)})` : ''}` : ''}</p></section>` : '<section class="live-detail-section"><h4>Current parking</h4><p class="muted">No active reservation is assigned to this space.</p></section>'}${detailData.nextReservation ? `<section class="live-detail-section"><h4>Upcoming</h4><p><b>${esc(detailData.nextReservation.reservationNumber)}</b><br>${esc(liveDate(detailData.nextReservation.startsAt))} → ${esc(liveDate(detailData.nextReservation.endsAt))}</p></section>` : ''}<section class="live-detail-section"><h4>Recent activity</h4>${detailData.recentHistory?.length ? `<ol class="history">${detailData.recentHistory.map(item => `<li>${esc(item.reservationNumber)} · ${esc(friendlyState(item.status))}<br><small>${esc(liveDate(item.assignedAt))}${item.reason ? ` · ${esc(item.reason)}` : ''}</small></li>`).join('')}</ol>` : '<p class="muted">No assignment history is available.</p>'}</section>${detailData.notes?.length ? `<section class="live-detail-section"><h4>Internal notes</h4><ol class="history">${detailData.notes.map(item => `<li>${esc(item.note)}<br><small>${esc(liveDate(item.createdAt))}</small></li>`).join('')}</ol></section>` : ''}${renderTimeline(detailData)}<div class="space-actions">${current ? `<button type="button" data-live-reservation>${esc(liveReservationActionLabel(detailData))}</button>` : ''}${detailData.actions?.canMove ? '<button type="button" class="secondary" data-live-move>Reassign space</button>' : ''}${isOwner() ? '<button type="button" class="secondary" data-live-diagram>Open Lot Setup</button>' : ''}</div>`;
    bindLivePanel();
  }

  function bindLivePanel() {
    $('[data-live-close]')?.addEventListener('click', () => { const closedId = liveState.selectedId; liveState.detailGate.cancel(); liveState.timelineGate.cancel(); liveState.selectedId = null; liveState.detail = null; liveState.timeline = null; liveState.detailLoading = false; liveState.timelineLoading = false; renderLiveLot(); document.querySelector(`[data-live-spot="${CSS.escape(String(closedId))}"], [data-live-list-space="${CSS.escape(String(closedId))}"]`)?.focus(); });
    $('[data-live-reservation]')?.addEventListener('click', async () => { const id = liveState.detail?.currentReservation?.id; if (id && await setView('reservations')) await detail(id); });
    $('[data-live-move]')?.addEventListener('click', event => { const id = liveState.detail?.currentReservation?.id; if (id) reassignBooking(id, event.currentTarget); });
    $('[data-live-diagram]')?.addEventListener('click', () => setView('lot-setup'));
    $('[data-live-retry-detail]')?.addEventListener('click', () => loadLiveDetail(liveState.selectedId));
    $('[data-live-retry-timeline]')?.addEventListener('click', () => loadLiveTimeline(liveState.selectedId));
  }

  async function loadLiveDetail(id) {
    const request = liveState.detailGate.next();
    if (!id) return; liveState.detailLoading = true; renderLiveSpacePanel();
    try {
      const at = liveState.data?.evaluatedAt ? `?at=${encodeURIComponent(liveState.data.evaluatedAt)}` : '';
      const detailData = await call(`/admin/parking/v1/spaces/${encodeURIComponent(id)}/operational-detail${at}`, { signal: request.signal });
      if (!request.current() || String(id) !== String(liveState.selectedId)) return;
      liveState.detail = detailData; liveState.detailLoading = false; renderLiveSpacePanel(); loadLiveTimeline(id);
    } catch (error) { if (request.current() && error.name !== 'AbortError' && String(id) === String(liveState.selectedId)) { liveState.detailLoading = false; liveState.detail = null; $('#liveLotPanelDetail').innerHTML = `<button type="button" class="panel-close" data-live-close aria-label="Close selected space">×</button><p class="error">${esc(error.message || 'Unable to load space detail.')}</p><button type="button" class="secondary" data-live-retry-detail>Retry</button>`; bindLivePanel(); } }
  }

  async function loadLiveTimeline(id) {
    const request = liveState.timelineGate.next();
    if (!id || String(id) !== String(liveState.selectedId)) return; liveState.timelineLoading = true; renderLiveSpacePanel();
    try {
      const from = liveState.data?.evaluatedAt || new Date().toISOString(); const to = new Date(new Date(from).getTime() + 30 * 86400000).toISOString();
      const timeline = await call(`/admin/parking/v1/spaces/${encodeURIComponent(id)}/timeline?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { signal: request.signal });
      if (request.current() && String(id) === String(liveState.selectedId)) { liveState.timeline = timeline; liveState.timelineLoading = false; renderLiveSpacePanel(); }
    } catch (error) { if (request.current() && error.name !== 'AbortError' && String(id) === String(liveState.selectedId)) { liveState.timelineLoading = false; renderLiveSpacePanel(); } }
  }

  function renderLiveSearchResults() {
    const target = $('#liveLotSearchResults'); const results = liveState.search;
    const input = $('#liveLotSearch');
    if (liveState.searchLoading) { input.setAttribute('aria-expanded', 'true'); target.hidden = false; target.innerHTML = '<p class="status-message loading">Searching operational records…</p>'; return; }
    if (!results) { input.setAttribute('aria-expanded', 'false'); target.hidden = true; return; }
    const group = (label, rows, render) => rows?.length ? `<section><h4>${esc(label)}</h4>${rows.slice(0, 8).map(render).join('')}</section>` : '';
    input.setAttribute('aria-expanded', 'true'); target.hidden = false;
    target.innerHTML = liveState.searchError
      ? `<p class="error">${esc(liveState.searchError)}</p>`
      : `${group('Spaces', results.spaces, item => `<button type="button" role="option" data-search-space="${esc(item.id)}">Space ${esc(item.number)}</button>`)}${group('Reservations', results.reservations, item => `<button type="button" role="option" data-search-reservation="${esc(item.id)}" data-search-space-number="${esc(item.space || '')}"><b>${esc(item.reservationNumber)}</b><small>${esc(item.space ? `Space ${item.space} · ` : '')}${esc(friendlyState(item.status))} · ${esc(date(item.arrival))}</small></button>`)}${group('Customers', results.customers, item => `<button type="button" role="option" data-search-query="${esc(item.email || item.phone || item.name)}"><b>${esc(item.name)}</b><small>${esc([item.company, item.phone, item.email].filter(Boolean).join(' · '))}</small></button>`)}${group('Vehicles', results.vehicles, item => `<button type="button" role="option" data-search-reservation="${esc(item.reservationId)}" data-search-space-number="${esc(item.space || '')}"><b>${esc(item.unitNumber || item.licensePlate || item.reservationNumber)}</b><small>${esc([item.trailerNumber && `Trailer ${item.trailerNumber}`, item.licensePlate && `Plate ${item.licensePlate}`, item.space && `Space ${item.space}`].filter(Boolean).join(' · '))}</small></button>`)}` || '<p class="empty">No operational records match this search.</p>';
    $$('[data-search-space]').forEach(button => button.addEventListener('click', () => openLiveSearchSpace(button.dataset.searchSpace, button)));
    $$('[data-search-reservation]').forEach(button => button.addEventListener('click', () => openLiveSearchReservation(button.dataset.searchReservation, button.dataset.searchSpaceNumber, button)));
    $$('[data-search-query]').forEach(button => button.addEventListener('click', () => openLiveSearchQuery(button.dataset.searchQuery)));
    const options = $$('[data-search-space], [data-search-reservation], [data-search-query]');
    options.forEach((option, index) => option.addEventListener('keydown', event => {
      const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : null;
      if (next === null) return;
      event.preventDefault(); options[(next + options.length) % options.length].focus();
    }));
  }

  function clearLiveSearch() {
    clearTimeout(liveState.searchTimer); liveState.searchTimer = null; liveState.searchGate.cancel();
    $('#liveLotSearch').value = ''; liveState.search = null; liveState.searchLoading = false; liveState.searchError = ''; renderLiveSearchResults();
  }

  async function openLiveSearchSpace(id, trigger) {
    clearLiveSearch();
    if (!liveState.data?.spaces.some(space => String(space.id) === String(id))) await resetLiveFilters({ reload: true });
    selectLiveSpot(id, trigger);
  }

  async function openLiveSearchReservation(id, number, trigger) {
    const space = liveState.data?.spaces.find(item => String(item.number) === String(number));
    if (space) { clearLiveSearch(); selectLiveSpot(space.id, trigger); return; }
    if (await setView('reservations')) await detail(id);
  }

  async function openLiveSearchQuery(query) {
    if (!await setView('reservations')) return;
    $('#search [name="q"]').value = query; await bookings();
  }

  async function searchLiveLot() {
    const query = $('#liveLotSearch').value.trim(); if (query.length < 2) { liveState.searchGate.cancel(); liveState.search = null; liveState.searchLoading = false; liveState.searchError = ''; return renderLiveSearchResults(); }
    const request = liveState.searchGate.next(); liveState.searchLoading = true; liveState.searchError = ''; renderLiveSearchResults();
    try { const results = await call(`/admin/parking/v1/canonical-live-lot/search?q=${encodeURIComponent(query)}&limit=20`, { signal: request.signal }); if (request.current()) { liveState.search = results; liveState.searchLoading = false; renderLiveSearchResults(); } }
    catch (error) { if (request.current() && error.name !== 'AbortError') { liveState.searchLoading = false; liveState.search = { spaces: [], reservations: [], customers: [], vehicles: [] }; liveState.searchError = error.message || 'Unable to search operational records.'; renderLiveSearchResults(); } }
  }

  async function resetLiveFilters({ reload = false } = {}) {
    liveState.filters = { operationalStatus: '', parkingUse: '', vehicleCategoryId: '', availableOnly: false, issuesOnly: false, futureOnly: false, monthlyOnly: false };
    if (reload) await loadLiveLot();
    else if (liveState.data) renderLiveLot();
  }

  async function loadLiveLot({ quiet = false } = {}) {
    liveState.detailGate.cancel(); liveState.timelineGate.cancel(); liveState.detailLoading = false; liveState.timelineLoading = false; liveState.detail = null; liveState.timeline = null;
    const request = liveState.snapshotGate.next(); liveState.loading = true;
    const overlay = $('#liveLotMapMessage');
    if (!quiet) { setMessage('#liveLotStatus', 'Loading Parking Lot…', 'loading'); overlay.hidden = false; overlay.textContent = 'Loading published lot diagram…'; }
    try {
    const query = new URLSearchParams(); const at = liveState.requestedAt;
      if (at) query.set('at', at);
      const snapshot = await call(`/admin/parking/v1/canonical-live-lot/snapshot${query.size ? `?${query}` : ''}`, { signal: request.signal });
      if (!request.current()) return;
      liveState.data = snapshot; liveState.loading = false; liveState.evaluatedAt = snapshot.evaluatedAt;
      overlay.hidden = true; overlay.textContent = '';
      if (liveState.selectedId && !snapshot.spaces.some(item => String(item.id) === String(liveState.selectedId))) { liveState.selectedId = null; liveState.detail = null; liveState.timeline = null; }
      renderLiveLot();
      const layoutId = snapshot.layout?.id || null;
      if (layoutId && String(layoutId) !== String(liveState.fittedLayoutId)) { liveState.fittedLayoutId = layoutId; requestAnimationFrame(resetLiveMapViewport); }
      if (liveState.selectedId && !liveState.detailLoading) loadLiveDetail(liveState.selectedId);
    } catch (error) { if (request.current() && error.name !== 'AbortError') { liveState.loading = false; setMessage('#liveLotStatus', error.message || 'Unable to load Parking Lot.', 'error'); overlay.hidden = false; overlay.textContent = 'Parking Lot data is unavailable. Use Refresh to retry.'; $('#liveLotMap').replaceChildren(); } }
  }

  function closeNavigation({ restoreFocus = false } = {}) {
    const nav = $('#appNav');
    const toggle = $('#menuToggle');
    const wasOpen = nav?.classList.contains('is-open');
    nav?.classList.remove('is-open');
    $('#navBackdrop').hidden = true;
    toggle?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && wasOpen) toggle?.focus();
  }

  function focusWorkspaceHeading() {
    const heading = $('.workspace-header h1');
    if (!heading) return;
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }

  function clearLotPointerState() {
    layoutState.drag = null; layoutState.pan = null;
    $('#layoutCanvasStage')?.classList.remove('is-panning');
  }

  function cancelLiveActivity({ clearSelection = false } = {}) {
    clearTimeout(liveState.searchTimer); liveState.searchTimer = null;
    for (const gate of [liveState.snapshotGate, liveState.detailGate, liveState.timelineGate, liveState.searchGate]) gate.cancel();
    liveState.loading = false; liveState.detailLoading = false; liveState.timelineLoading = false; liveState.searchLoading = false; liveState.pan = null;
    $('#liveLotMapStage')?.classList.remove('is-panning');
    if (clearSelection) { liveState.selectedId = null; liveState.detail = null; liveState.timeline = null; liveState.search = null; liveState.searchError = ''; }
  }

  const allRoutePanels = () => Object.values(adminRoutes.panels).flat().map(id => $(`#${id}`)).filter(Boolean);
  const dirtyFeatures = () => [lotDirty() ? 'Lot Setup draft' : '', ...Object.entries(configUi.dirty).filter(([, dirty]) => dirty).map(([name]) => name === 'business' ? 'Property settings' : friendlyState(name))].filter(Boolean);

  function confirmDiscardForNavigation() {
    const dirty = dirtyFeatures();
    if (!dirty.length) return true;
    if (!window.confirm(`Leave without saving ${dirty.join(' and ')}?`)) return false;
    if (lotDirty()) {
      layoutState.draft = clone(layoutState.baseline);
      layoutState.configDirty = false; layoutState.geometryDirty = false; layoutState.history = []; layoutState.future = []; layoutState.editLayout = false;
    }
    for (const key of Object.keys(configUi.dirty)) {
      if (configUi.dirty[key]) {
        const form = key === 'business' ? $('#businessSettingsForm') : key === 'policies' ? $('#bookingPoliciesForm') : $(`[data-config-form="${key}"]`);
        restoreFormBaseline(key, form);
      }
      configUi.dirty[key] = false;
    }
    return true;
  }

  async function loadRouteData(view) {
    if (view === 'dashboard') {
      try { await loadOperationalLocations(); } catch (_) { operationalLocations = []; }
      return dashboard();
    }
    if (view === 'reservations') {
      if (!operationalLocations.length) await loadOperationalLocations();
      if (isOwner() && !configState.zones.length) {
        const [bookingResult, zoneResult] = await Promise.all([bookings(), call('/admin/parking/v1/zones')]);
        configState.zones = zoneResult.items || [];
        return bookingResult;
      }
      return bookings();
    }
    if (view === 'live-lot') return loadLiveLot();
    if (view === 'lot-setup') { await loadOperationalLocations(); return loadLotSetupLocations({ preserve: true }); }
    if (view === 'business-settings') return loadConfig();
    if (view === 'staff-accounts') return loadAdminUsers();
  }

  async function setView(requested, configTarget = '', options = {}) {
    let target = adminRoutes.resolve(requested);
    const notice = $('#routeNotice');
    notice.hidden = true;
    if (!target.supported) {
      notice.textContent = target.notice;
      notice.hidden = false;
      if (!options.replaceHistory && currentView && adminRoutes.routes[currentView]) {
        history.replaceState(null, '', `#${currentView}`);
        return false;
      }
      target = adminRoutes.resolve('dashboard');
    }
    if (target.route.ownerOnly && !isOwner()) {
      notice.textContent = `${target.route.label} requires an Owner account.`;
      notice.hidden = false;
      target = adminRoutes.resolve('dashboard');
    }
    const view = target.view;
    if (view === currentView && options.fromHistory && !routeTransitioning) {
      if (view === 'business-settings') selectConfigTab(configTarget || target.configTab || configUi.activeTab);
      renderPageMeta(view);
      return true;
    }
    if (routeTransitioning && view === currentView && !options.fromHistory) return false;
    const leaving = currentView && currentView !== view;
    if (leaving && !options.skipGuard && !confirmDiscardForNavigation()) {
      history.replaceState(null, '', `#${currentView}`);
      return false;
    }
    if (leaving && currentView === 'live-lot') cancelLiveActivity({ clearSelection: true });
    if (leaving && currentView === 'reservations') { reservationState.listGate.cancel(); reservationState.detailGate.cancel(); }
    if (leaving && currentView === 'lot-setup') { clearLotPointerState(); closeLotPreview(); }
    routeTransitioning = true;
    const transitionId = ++routeRequestId;
    allRoutePanels().forEach(panel => { panel.hidden = true; });
    $('#routeLoading').hidden = false;
    $('#app').setAttribute('aria-busy', 'true');
    currentView = view;
    $('.app-workspace').dataset.currentView = view;
    renderPageMeta(view);
    $('#appNav')?.querySelectorAll('[data-view]').forEach(button => {
      const selected = button.dataset.view === view;
      button.classList.toggle('is-current', selected);
      if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    if (view === 'reservations' && target.reservationTab) reservationState.tab = target.reservationTab;
    if (view === 'business-settings') selectConfigTab(configTarget || target.configTab || 'property');
    if (!options.fromHistory) {
      const method = options.replaceHistory ? 'replaceState' : 'pushState';
      history[method](null, '', `#${target.requested || view}`);
    }
    closeNavigation();
    try {
      await loadRouteData(view);
    } catch (error) {
      notice.textContent = error.message || `Unable to load ${target.route.label}.`;
      notice.hidden = false;
    } finally {
      if (transitionId !== routeRequestId) return false;
      (adminRoutes.panels[view] || []).map(id => $(`#${id}`)).filter(Boolean).forEach(panel => { panel.hidden = false; });
      $('#routeLoading').hidden = true;
      $('#app').setAttribute('aria-busy', 'false');
      routeTransitioning = false;
    }
    return true;
  }

  async function refreshOperations() {
    if (activeRefresh) return activeRefresh;
    if (!confirmDiscardForNavigation()) return false;
    const button = $('#refresh');
    button.disabled = true; button.classList.add('is-loading');
    activeRefresh = loadRouteData(currentView).finally(() => { activeRefresh = null; button.disabled = false; button.classList.remove('is-loading'); });
    return activeRefresh;
  }


  let advancedBindingsReady = false;
  function bindAdvancedEvents() {
    if (advancedBindingsReady) return;
    advancedBindingsReady = true;
  $$('[data-config-tab]').forEach(tab => tab.addEventListener('click', () => selectConfigTab(tab.dataset.configTab)));
  $('#configTabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = $$('[data-config-tab]:not([hidden])');
    const index = tabs.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault(); tabs[next].click(); tabs[next].focus();
  });
  $$('[data-config-form]').forEach(form => form.addEventListener('submit', saveConfig));
  $$('[data-config-cancel]').forEach(button => button.addEventListener('click', () => {
    const entity = button.dataset.configCancel; const form = $(`[data-config-form="${entity}"]`);
    if (!restoreFormBaseline(entity, form)) resetConfigForm(entity);
    configUi.dirty[entity] = false; updateClosureFields();
    setConfigMessage('Edit cancelled.', 'info');
  }));
  $('#configRefresh').addEventListener('click', () => { if (confirmDiscardForNavigation()) loadConfig(); });
  $('#ratePlanForm')?.addEventListener('submit', saveRatePlan);
  $('#ratePlanCreate')?.addEventListener('click', event => openRatePlanDialog('', event.currentTarget));
  $$('[data-rate-plan-close]').forEach(button => button.addEventListener('click', closeRatePlanDialog));
  $('#ratePlanDialog')?.addEventListener('close', () => { layoutState.ratePlanDialogTrigger?.focus?.({ preventScroll: true }); layoutState.ratePlanDialogTrigger = null; });
  $('#reassignmentForm')?.addEventListener('submit', submitReassignment);
  $$('[data-reassignment-close]').forEach(button => button.addEventListener('click', closeReassignmentDialog));
  $('#reassignmentDialog')?.addEventListener('cancel', event => { if (dialogState.submitting) event.preventDefault(); });
  $('#reassignmentDialog')?.addEventListener('close', () => { dialogState.reassignmentTrigger?.focus?.({ preventScroll: true }); dialogState.reassignmentTrigger = null; });
  $('#statusTransitionForm')?.addEventListener('submit', submitStatusTransition);
  $$('[data-status-transition-close]').forEach(button => button.addEventListener('click', closeStatusTransitionDialog));
  $('#statusTransitionDialog')?.addEventListener('cancel', event => { if (dialogState.submitting) event.preventDefault(); });
  $('#statusTransitionDialog')?.addEventListener('close', () => { dialogState.statusTrigger?.focus?.({ preventScroll: true }); dialogState.statusTrigger = null; });
  $('#businessSettingsForm').addEventListener('submit', saveCanonicalLocation);
  $('#bookingPoliciesForm').addEventListener('submit', saveBookingPolicies);
  $('#businessSettingsReset').addEventListener('click', resetCanonicalSettings);
  $('#bookingPoliciesReset').addEventListener('click', () => { configUi.dirty.policies = false; if (!restoreFormBaseline('policies', $('#bookingPoliciesForm'))) hydrateCanonicalSettings(); setConfigMessage('Unsaved policy changes were reset.', 'info'); });
  $$('#businessSettingsForm input, #businessSettingsForm textarea, #businessSettingsForm select').forEach(control => {
    control.addEventListener('input', () => { configUi.dirty.business = true; });
    control.addEventListener('change', () => { configUi.dirty.business = true; });
  });
  $$('#bookingPoliciesForm input, #bookingPoliciesForm textarea, #bookingPoliciesForm select').forEach(control => {
    control.addEventListener('input', () => { configUi.dirty.policies = true; });
    control.addEventListener('change', () => { configUi.dirty.policies = true; });
  });
  $$('[data-config-form="closures"] input, [data-config-form="closures"] select, [data-config-form="closures"] textarea').forEach(control => {
    const entity = control.closest('[data-config-form]').dataset.configForm;
    control.addEventListener('input', () => { configUi.dirty[entity] = true; });
    control.addEventListener('change', () => { configUi.dirty[entity] = true; });
  });
  $('#adminUsersRefresh').addEventListener('click', () => loadAdminUsers());
  $('#adminUserAdd').addEventListener('click', () => {
    resetAdminUserForm();
    const form = $('#adminUserForm');
    form.hidden = false;
    form.elements.namedItem('username').focus({ preventScroll: true });
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#adminUserForm').addEventListener('submit', saveAdminUser);
  $('#adminUserCancel').addEventListener('click', () => {
    resetAdminUserForm();
    setAdminUsersMessage('Edit cancelled.', 'info');
  });
  $('#closureType').addEventListener('change', updateClosureFields);
  $('#closureScope').addEventListener('change', updateClosureFields);
  $('#layoutSave').addEventListener('click', saveLotDraft);
  $('#layoutPublish').addEventListener('click', publishLotDraft);
  $('#layoutCreateDraft').addEventListener('click', createLotDraft);
  $('#layoutReviewPublish').addEventListener('click', reviewLotPublish);
  $$('[data-publish-close]').forEach(button => button.addEventListener('click', () => $('#publishChecklistDialog').close()));
  $('#publishPhysicalConfirmation').addEventListener('change', event => { $('#layoutPublish').disabled = $('#publishChecklistForm').dataset.ready !== 'true' || !event.currentTarget.checked; });
  $('#publishChecklistForm').addEventListener('submit', publishLotDraft);
  $('#layoutEditMode').addEventListener('click', () => {
    if (!lotStructuralEditable()) return;
    layoutState.editLayout = !layoutState.editLayout;
    layoutState.tool = layoutState.editLayout ? 'select' : 'pan';
    $$('[data-map-tool]').forEach(item => item.classList.toggle('is-active', item.dataset.mapTool === layoutState.tool));
    renderLotSetup();
    lotSetMessage(layoutState.editLayout ? 'Layout editing is active. Dragging and keyboard movement are enabled.' : 'Layout editing is off. You can still select spaces and change their settings.', 'info');
  });
  $('#layoutPreview').addEventListener('click', () => {
    const source = layoutState.draft || layoutState.published;
    const elements = (source?.elements || []).filter(item => item.parking_spot_id ? (item.active !== false && lotPurpose(item) === 'CUSTOMER' && lotPublic(item)) : (item.active !== false && item.public_visible !== false));
    renderLotCanvas($('#layoutPreviewCanvas'), elements, { preview: true, sceneElements: source?.elements || [] });
    layoutState.previewRestore = document.activeElement; $('#layoutPreviewPanel').hidden = false; $('#layoutPreviewClose').focus({ preventScroll: true });
  });
  $('#layoutPreviewClose').addEventListener('click', closeLotPreview);
  $('#layoutUndo').addEventListener('click', undoLotChange);
  $('#layoutRedo').addEventListener('click', redoLotChange);
  $('#layoutRotate').addEventListener('click', rotateLotSelection);
  $('#layoutZoomIn').addEventListener('click', () => { layoutState.userZoomed = true; layoutState.zoom = Math.min(1.5, layoutState.zoom + .1); renderLotSetup(); });
  $('#layoutZoomOut').addEventListener('click', () => { layoutState.userZoomed = true; layoutState.zoom = Math.max(.6, layoutState.zoom - .1); renderLotSetup(); });
  $('#layoutFit').addEventListener('click', fitLotMap);
  $('#layoutSpaceSearch').addEventListener('change', focusLotSearch);
  $('#layoutSpaceSearch').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); focusLotSearch(); } });
  $$('[data-map-tool]').forEach(button => button.addEventListener('click', () => { layoutState.tool = button.dataset.mapTool; $$('[data-map-tool]').forEach(item => item.classList.toggle('is-active', item === button)); }));
  $('#layoutCanvas').addEventListener('pointerdown', lotPointerDown);
  $('#layoutCanvas').addEventListener('pointermove', lotPointerMove);
  $('#layoutCanvas').addEventListener('pointerup', lotPointerUp);
  $('#layoutCanvas').addEventListener('pointercancel', lotPointerUp);
  $('#layoutCanvas').addEventListener('lostpointercapture', lotPointerUp);
  $('#layoutCanvas').addEventListener('click', event => {
    const button = event.target.closest('[data-lot-space]');
    if (button && event.detail === 0) selectLotSpace(button.dataset.lotSpace, event.shiftKey);
  });
  $('#layoutCanvas').addEventListener('keydown', event => {
    if (!lotGeometryEditable() || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); moveLotSelection(event.key === 'ArrowLeft' ? -.5 : event.key === 'ArrowRight' ? .5 : 0, event.key === 'ArrowUp' ? -.5 : event.key === 'ArrowDown' ? .5 : 0);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('#layoutPreviewPanel').hidden) { event.preventDefault(); closeLotPreview(); }
  });
  window.addEventListener('beforeunload', event => {
    if (!dirtyFeatures().length) return;
    event.preventDefault(); event.returnValue = '';
  });
  window.addEventListener('blur', clearLotPointerState);
  if (typeof ResizeObserver !== 'undefined') {
    let lastLotWidth = 0;
    let lotResizeFrame = 0;
    new ResizeObserver(entries => {
      const width = entries[0]?.contentRect?.width || 0;
      if (currentView !== 'lot-setup' || layoutState.userZoomed || Math.abs(width - lastLotWidth) <= 24 || lotResizeFrame) return;
      lastLotWidth = width;
      lotResizeFrame = requestAnimationFrame(() => { lotResizeFrame = 0; fitLotMap(); });
    }).observe($('#layoutCanvasStage'));
  }
  $('[data-config-form="categories"] input[name="code"]')?.addEventListener('input', event => { event.currentTarget.value = event.currentTarget.value.toUpperCase(); });
  resetConfigForm('closures');
  resetAdminUserForm();
  }

  function resetAdvancedState() {
    currentUser = undefined;
    currentView = 'lot-setup';
    currentBooking = undefined;
    adminUsers = [];
    operationalLocations = [];
    configEntities.forEach(entity => { configState[entity] = []; });
    configUi.dirty = { business: false, policies: false, closures: false };
    configUi.activeTab = 'property';
    configUi.baselines = {};
    Object.assign(layoutState, {
      locations: [], location: null, draft: null, published: null, baseline: null,
      selectedId: null, selectedIds: new Set(), configDirty: false, geometryDirty: false,
      zoom: 1, userZoomed: false, drag: null, pan: null, tool: 'select', history: [],
      future: [], previewRestore: null, editLayout: false, canonicalMaintenanceLocked: false,
      ratePlans: [], ratePlanDialogTrigger: null
    });
    document.querySelectorAll('#advancedAdminRoot dialog[open]').forEach(dialog => dialog.close());
    document.querySelectorAll('#advancedAdminRoot form').forEach(form => form.reset());
    ['layoutCanvas', 'layoutPreviewCanvas', 'layoutProperties', 'layoutRatePlans', 'closuresList', 'adminUsersList'].forEach(id => {
      const element = $(`#${id}`);
      if (element) element.replaceChildren();
    });
    ['layoutStatus', 'configStatus', 'adminUsersStatus'].forEach(id => setMessage(`#${id}`, ''));
    const root = $('#advancedAdminRoot');
    if (root) root.hidden = true;
  }

  function deactivate() {
    const root = $('#advancedAdminRoot');
    if (root) root.hidden = true;
  }

  async function activate(user, requestedView = 'lot-setup') {
    const root = $('#advancedAdminRoot');
    if (!root || user?.role !== 'OWNER') {
      deactivate();
      return false;
    }
    bindAdvancedEvents();
    currentUser = { ...user };
    currentView = ['lot-setup', 'business-settings', 'staff-accounts'].includes(requestedView) ? requestedView : 'lot-setup';
    root.hidden = false;
    $('#lotLayoutPanel').hidden = currentView !== 'lot-setup';
    $('#configuration').hidden = currentView !== 'business-settings';
    $('#adminUsersPanel').hidden = currentView !== 'staff-accounts';
    $('#layoutOwnerTools').hidden = false;
    try {
      if (currentView === 'staff-accounts') {
        await loadAdminUsers();
      } else {
        await loadOperationalLocations();
        await loadConfig({ quiet: true });
        if (currentView === 'lot-setup') await loadLotSetupLocations();
        else selectConfigTab(configUi.activeTab || 'property');
      }
      return true;
    } catch (error) {
      const selector = currentView === 'lot-setup' ? '#layoutStatus' : currentView === 'staff-accounts' ? '#adminUsersStatus' : '#configStatus';
      setMessage(selector, error?.message || 'Advanced configuration could not be loaded.', 'error');
      return false;
    }
  }

  window.ParkingAdvancedAdmin = Object.freeze({ activate, deactivate, clearPrivateState: resetAdvancedState });
})();
