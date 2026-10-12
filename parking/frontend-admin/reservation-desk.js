(() => {
  'use strict';

  const api = window.ParkingAdminApi;
  const state = {
    userId: null, bootstrap: null, loading: false, message: '', error: '', step: 1,
    customerResults: [], selectedCustomer: null, availability: null, detail: null,
    editMode: false, priceMode: false, uploadProgress: 0, idempotencyKey: '', draft: null, demoLink: '', preselectedSpace: null, pendingReservationId: ''
  };

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[character]);
  const money = cents => new Intl.NumberFormat([], { style: 'currency', currency: 'USD' }).format(Number(cents || 0) / 100);
  const dateTime = value => value ? new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
  const localValue = date => {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const dollarValue = cents => (Number(cents || 0) / 100).toFixed(2);
  const dollarsToCents = value => {
    const text = String(value || '').trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('Enter a valid dollar amount.');
    const [whole, fraction = ''] = text.split('.');
    return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  };
  const paymentLabel = value => value === 'DEMO_BYPASSED' ? 'DEMO / NO PAYMENT' : value === 'NOT_REQUIRED' ? 'PAY AT THE OFFICE' : String(value || '—').replaceAll('_', ' ');
  const payOnSite = () => state.bootstrap?.payment?.onlinePayment === false;
  const reviewLabel = () => payOnSite() ? 'Review' : 'Review & Payment';

  function freshDraft() {
    const arrival = new Date(); arrival.setDate(arrival.getDate() + 1); arrival.setHours(9, 0, 0, 0);
    const departure = new Date(arrival); departure.setHours(18, 0, 0, 0);
    return {
      customer: { existingPublicId: '', firstName: '', lastName: '', mobilePhone: '', email: '', companyName: '', usdotNumber: '', mcNumber: '' },
      vehicle: { existingPublicId: '', unitNumber: '', licensePlate: '', licensePlateState: 'TN', trailerNumber: '' },
      parking: { locationId: '', duration: 'DAILY', categoryCode: 'TRACTOR_TRAILER', arrivalLocal: localValue(arrival),
        departureLocal: localValue(departure), inventoryId: '', selectedSpotId: '' },
      price: { override: false, finalPriceCents: null, reason: '' }, payment: { method: 'STRIPE' }, customerNotes: '', internalNotes: ''
    };
  }

  function resetDraft({ keepPreselectedSpace = false } = {}) {
    state.step = 1; state.customerResults = []; state.selectedCustomer = null; state.availability = null;
    state.detail = null; state.editMode = false; state.priceMode = false; state.error = ''; state.message = '';
    state.idempotencyKey = ''; state.demoLink = ''; state.draft = freshDraft();
    if (!keepPreselectedSpace) state.preselectedSpace = null;
    if (state.bootstrap?.locations?.[0]) state.draft.parking.locationId = String(state.bootstrap.locations[0].id);
  }

  function applySpacePrefill(space) {
    if (!space || !state.draft) return;
    const monthly = String(space.bookingTerm || '').toUpperCase() === 'MONTHLY';
    state.preselectedSpace = { id: String(space.id || ''), number: String(space.number || ''), bookingTerm: String(space.bookingTerm || ''), vehicleType: String(space.vehicleType || '') };
    state.detail = null; state.availability = null; state.step = 1; state.error = '';
    state.draft.parking.duration = monthly ? 'MONTHLY' : 'DAILY';
    state.draft.parking.categoryCode = String(space.vehicleType || '').toUpperCase() === 'BOBTAIL' ? 'BOBTAIL' : 'TRACTOR_TRAILER';
    state.draft.parking.inventoryId = ''; state.draft.parking.selectedSpotId = '';
    state.message = `Space ${space.number || ''} is preselected. Check availability to confirm it for the requested dates.`;
  }

  function rerender() { document.dispatchEvent(new CustomEvent('parkingdesk:render')); }
  function setBusy(value, message = '') { state.loading = value; state.message = message; if (value) state.error = ''; rerender(); }
  function fail(error, fallback) { state.loading = false; state.message = ''; state.error = error?.message || fallback; rerender(); }
  function hasPermission(name) { return (state.bootstrap?.permissions || []).includes(name); }
  function selectedOption() {
    return state.availability?.options?.find(item => String(item.inventoryId) === String(state.draft.parking.inventoryId)) || null;
  }
  function selectedPosition() {
    return selectedOption()?.positions?.find(item => String(item.id) === String(state.draft.parking.selectedSpotId)) || null;
  }
  function applyPreselectedSpace() {
    const space = state.preselectedSpace;
    if (!space) return false;
    const positionOption = state.availability?.options?.find(option => (option.positions || []).some(position => String(position.id) === String(space.id)));
    if (positionOption) {
      state.draft.parking.inventoryId = String(positionOption.inventoryId);
      state.draft.parking.selectedSpotId = String(space.id);
      state.message = `Space ${space.number || ''} is open for these dates and has been selected.`;
      return true;
    }
    if (state.draft.parking.duration === 'MONTHLY') {
      state.preselectedSpace = null;
      state.message = `Lot ${space.number || ''} is no longer eligible for these dates. Choose another available position.`;
    }
    return false;
  }
  function standardPrice() {
    const option = selectedOption();
    return Number(state.draft.parking.duration === 'MONTHLY' ? selectedPosition()?.standardPriceCents : option?.standardPriceCents || 0);
  }
  function finalPrice() { return state.draft.price.override ? Number(state.draft.price.finalPriceCents || 0) : standardPrice(); }
  function parkingTerm(value) { return ({ DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly' }[value] || 'Parking'); }
  function openEndedTerm(value) { return ['WEEKLY', 'MONTHLY'].includes(String(value || '').toUpperCase()); }
  function rateSuffix(value) { return value === 'WEEKLY' ? '/week' : value === 'MONTHLY' ? '/month' : '/day'; }

  async function initialize(user) {
    if (!user || state.loading) return;
    if (state.userId === user.id && state.bootstrap) return;
    state.userId = user.id; state.loading = true; state.error = ''; rerender();
    try {
      state.bootstrap = await api.reservationDeskBootstrap();
      const preselectedSpace = state.preselectedSpace; resetDraft({ keepPreselectedSpace: true });
      if (preselectedSpace) applySpacePrefill(preselectedSpace);
      if (state.pendingReservationId) {
        const reservationId = state.pendingReservationId;
        state.pendingReservationId = '';
        await openReservation(reservationId);
      }
    } catch (error) { state.error = error.message || 'Reservation Desk could not be loaded.'; }
    finally { state.loading = false; rerender(); }
  }

  function progress() {
    const labels = ['Customer & Vehicle', 'Parking', reviewLabel()];
    const currentStep = state.detail ? 3 : state.step;
    return `<ol class="desk-progress" aria-label="Reservation progress">${labels.map((label, index) => {
      const step = index + 1; const status = step === currentStep ? 'is-current' : step < currentStep ? 'is-complete' : '';
      return `<li class="${status}"${step === currentStep ? ' aria-current="step"' : ''}><span>${String(step).padStart(2, '0')}</span>${label}</li>`;
    }).join('')}</ol>`;
  }

  function field(name, label, value, attributes = '') {
    return `<label><span>${escapeHtml(label)}</span><input name="${escapeHtml(name)}" value="${escapeHtml(value || '')}" ${attributes}></label>`;
  }

  function customerStep() {
    const customer = state.draft.customer; const vehicle = state.draft.vehicle; const vehicles = state.selectedCustomer?.vehicles || [];
    return `<section class="desk-sheet"><div class="desk-step-heading"><p>STEP 01</p><h3>Customer &amp; Vehicle</h3><span>Find or create the customer, then record the vehicle in one step.</span></div>
      <form method="post" id="deskCustomerSearch" class="desk-search"><label><span>Search customers</span><input name="query" type="search" placeholder="Name, phone, email, plate, unit, DOT or MC" autocomplete="off"></label><button class="btn ghost" type="submit">Search</button></form>
      ${state.selectedCustomer ? `<div class="desk-selected-record"><div><small>EXISTING CUSTOMER</small><strong>${escapeHtml(state.selectedCustomer.displayName)}</strong><span>${escapeHtml([state.selectedCustomer.companyName, state.selectedCustomer.phone, state.selectedCustomer.email].filter(Boolean).join(' · '))}</span></div><button class="btn ghost compact" type="button" data-clear-desk-customer>Use someone else</button></div>` : ''}
      ${state.customerResults.length ? `<div class="desk-results">${state.customerResults.map(customerItem => `<button type="button" data-select-desk-customer="${escapeHtml(customerItem.publicId)}"><strong>${escapeHtml(customerItem.displayName)}</strong><span>${escapeHtml([customerItem.companyName, customerItem.phone, customerItem.email].filter(Boolean).join(' · '))}</span></button>`).join('')}</div>` : ''}
      <form method="post" id="deskCustomerVehicleForm" class="desk-form-grid">
        ${field('firstName', 'First name', customer.firstName, 'required maxlength="80"')}${field('lastName', 'Last name', customer.lastName, 'required maxlength="80"')}
        ${field('mobilePhone', 'Phone', customer.mobilePhone, 'required type="tel"')}${field('email', 'Email', customer.email, 'required type="email"')}
        <details class="desk-span"><summary>Carrier details (optional)</summary><div class="desk-form-grid">${field('companyName', 'Company / Carrier', customer.companyName, 'maxlength="160"')}${field('usdotNumber', 'USDOT', customer.usdotNumber, 'inputmode="numeric" maxlength="12"')}${field('mcNumber', 'MC number', customer.mcNumber, 'inputmode="numeric" maxlength="12"')}</div></details>
        <div class="desk-span desk-subheading"><p>VEHICLE</p><span>Select a saved vehicle or enter one below.</span></div>
        ${vehicles.length ? `<div class="desk-choice-grid desk-span">${vehicles.map(item => `<button type="button" class="desk-choice ${vehicle.existingPublicId === item.publicId ? 'is-selected' : ''}" data-select-desk-vehicle="${escapeHtml(item.publicId)}"><small>SAVED VEHICLE</small><strong>Unit ${escapeHtml(item.unitNumber || '—')}</strong><span>${escapeHtml([item.licensePlate, item.licensePlateState].filter(Boolean).join(' · '))}</span></button>`).join('')}</div>` : ''}
        ${field('unitNumber', 'Unit number', vehicle.unitNumber, 'required maxlength="80"')}${field('licensePlate', 'License plate', vehicle.licensePlate, 'required maxlength="30"')}
        ${field('licensePlateState', 'Plate state', vehicle.licensePlateState, 'required maxlength="40"')}${field('trailerNumber', 'Trailer number', vehicle.trailerNumber, 'maxlength="80"')}
        <div class="desk-form-actions"><span>New customers are saved immediately. Exact phone/email matches are reused; ambiguous records are never merged.</span><button class="btn primary" type="submit">Continue to Parking →</button></div>
      </form></section>`;
  }

  function vehicleStep() {
    const vehicle = state.draft.vehicle; const vehicles = state.selectedCustomer?.vehicles || [];
    return `<section class="desk-sheet"><div class="desk-step-heading"><p>STEP 02</p><h3>Vehicle</h3><span>Select a saved truck or enter the vehicle standing at the counter.</span></div>
      ${vehicles.length ? `<div class="desk-choice-grid">${vehicles.map(item => `<button type="button" class="desk-choice ${vehicle.existingPublicId === item.publicId ? 'is-selected' : ''}" data-select-desk-vehicle="${escapeHtml(item.publicId)}"><small>SAVED VEHICLE</small><strong>Unit ${escapeHtml(item.unitNumber || '—')}</strong><span>${escapeHtml([item.licensePlate, item.licensePlateState].filter(Boolean).join(' · '))}</span></button>`).join('')}</div>` : '<p class="desk-inline-note">No saved vehicle is attached to this customer. Add it below.</p>'}
      <form method="post" id="deskVehicleForm" class="desk-form-grid">
        ${field('unitNumber', 'Unit number', vehicle.unitNumber, 'required maxlength="80"')}${field('licensePlate', 'License plate', vehicle.licensePlate, 'required maxlength="30"')}
        ${field('licensePlateState', 'Plate state', vehicle.licensePlateState, 'required maxlength="40"')}${field('trailerNumber', 'Trailer number', vehicle.trailerNumber, 'maxlength="80"')}
        <div class="desk-form-actions"><button class="btn ghost" type="button" data-desk-back>← Customer</button><button class="btn primary" type="submit">Continue to Parking →</button></div>
      </form></section>`;
  }

  function parkingStep() {
    const parking = state.draft.parking; const locations = state.bootstrap?.locations || [];
    const options = state.availability?.options || [];
    const openEnded = openEndedTerm(parking.duration);
    return `<section class="desk-sheet"><div class="desk-step-heading"><p>STEP 02</p><h3>Parking</h3><span>Availability comes from the same protected inventory used by customer booking.</span></div>
      <form method="post" id="deskAvailabilityForm" class="desk-form-grid">
        <label><span>Location</span><select name="locationId" required>${locations.map(item => `<option value="${escapeHtml(item.id)}"${String(item.id) === String(parking.locationId) ? ' selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label>
        <label><span>Parking term</span><select name="duration"><option value="DAILY"${parking.duration === 'DAILY' ? ' selected' : ''}>Daily</option><option value="WEEKLY"${parking.duration === 'WEEKLY' ? ' selected' : ''}>Weekly</option><option value="MONTHLY"${parking.duration === 'MONTHLY' ? ' selected' : ''}>Monthly</option></select></label>
        <label><span>Vehicle / parking type</span><select name="categoryCode"><option value="TRACTOR_TRAILER"${parking.categoryCode === 'TRACTOR_TRAILER' ? ' selected' : ''}>General Truck</option><option value="BOBTAIL"${parking.categoryCode === 'BOBTAIL' ? ' selected' : ''}>Bobtail</option></select></label>
        ${field('arrivalLocal', openEnded ? 'Start date' : 'Arrival', parking.arrivalLocal, 'required type="datetime-local"')}${parking.duration === 'MONTHLY' ? '<p class="desk-inline-note">Open-ended Monthly parking. The first partial month is prorated; $250 is billed on the 1st thereafter.</p>' : parking.duration === 'WEEKLY' ? '<p class="desk-inline-note">$100 every 7 days until parking is ended.</p>' : field('departureLocal', 'Departure', parking.departureLocal, 'required type="datetime-local"')}
        <div class="desk-form-actions"><button class="btn ghost" type="button" data-desk-back>← Customer &amp; Vehicle</button><button class="btn primary" type="submit">Check Availability</button></div>
      </form>
      ${state.availability ? `<div class="desk-availability"><div class="desk-subheading"><p>AVAILABLE PARKING</p><span>${options.filter(item => item.available).length} eligible option${options.filter(item => item.available).length === 1 ? '' : 's'}</span></div>
        <div class="desk-choice-grid">${options.map(option => `<button type="button" class="desk-choice ${String(parking.inventoryId) === String(option.inventoryId) ? 'is-selected' : ''}" data-select-desk-option="${escapeHtml(option.inventoryId)}" ${option.available ? '' : 'disabled'}><small>${option.available ? `${option.remainingCapacity} AVAILABLE` : 'UNAVAILABLE'}</small><strong>${escapeHtml(option.category)}</strong><span>${escapeHtml(option.zone)} · ${option.startingPriceCents == null ? 'Rate unavailable' : `from ${money(option.startingPriceCents)}${rateSuffix(parking.duration)}`}</span></button>`).join('')}</div>
        ${selectedOption() && (selectedOption().positions || []).length ? `<label class="desk-position"><span>${parking.duration === 'MONTHLY' ? 'Space (required for Monthly)' : 'Space'}</span><select id="deskPosition" ${parking.duration === 'MONTHLY' ? 'required' : ''}><option value="">${parking.duration === 'MONTHLY' ? 'Choose an open space' : 'Any open space in the area (no numbered space)'}</option>${(selectedOption().positions || []).map(position => `<option value="${escapeHtml(position.id)}"${String(position.id) === String(parking.selectedSpotId) ? ' selected' : ''}>Space ${escapeHtml(position.label)}</option>`).join('')}</select></label>${parking.duration !== 'MONTHLY' ? '<p class="desk-inline-note">Pick a space so it shows on the Live Lot, or leave it on "Any open space" to sell area capacity.</p>' : ''}` : selectedOption() ? `<p class="desk-inline-note">This ${escapeHtml(parkingTerm(parking.duration))} reservation guarantees capacity inside the eligible parking area; it does not promise a numbered position.</p>` : ''}
        <div class="desk-forward"><button class="btn primary" type="button" data-desk-parking-next ${selectedOption() && (parking.duration !== 'MONTHLY' || selectedPosition()) ? '' : 'disabled'}>Continue to Review →</button></div>
      </div>` : ''}</section>`;
  }

  function priceStep() {
    const standard = standardPrice(); const canOverride = hasPermission('reservation.price_override');
    return `<section class="desk-sheet"><div class="desk-step-heading"><p>STEP 04</p><h3>Price</h3><span>The public rate stays unchanged. An override applies to this reservation only.</span></div>
      <div class="desk-price-hero"><span>Standard calculated price</span><strong>${money(standard)}</strong><small>Authoritative current rate and duration</small></div>
      ${canOverride ? `<form method="post" id="deskPriceForm" class="desk-price-form"><label class="desk-switch"><input name="override" type="checkbox"${state.draft.price.override ? ' checked' : ''}><span>Override price for this reservation</span></label>
        <div class="desk-override-fields"${state.draft.price.override ? '' : ' hidden'}>${field('finalPrice', 'Final reservation price', dollarValue(state.draft.price.finalPriceCents ?? standard), 'inputmode="decimal"')}
          <label><span>Reason</span><select name="reason"><option value="">Choose a reason</option>${['Manager adjustment','Existing customer','Contract rate','Promotional rate','Service recovery','Manual correction','Other'].map(reason => `<option${state.draft.price.reason === reason ? ' selected' : ''}>${reason}</option>`).join('')}</select></label></div>
        <div class="desk-form-actions"><button class="btn ghost" type="button" data-desk-back>← Parking</button><button class="btn primary" type="submit">${payOnSite() ? 'Continue to Review' : 'Continue to Payment'} →</button></div></form>` : `<div class="desk-permission-note"><strong>Standard price will be used.</strong><span>Your role can create reservations but cannot make financial overrides.</span></div><div class="desk-form-actions"><button class="btn ghost" type="button" data-desk-back>← Parking</button><button class="btn primary" type="button" data-desk-review>${payOnSite() ? 'Continue to Review' : 'Continue to Payment'} →</button></div>`}
    </section>`;
  }

  function paymentStep() {
    const option = selectedOption(); const position = selectedPosition(); const customer = state.draft.customer; const vehicle = state.draft.vehicle;
    const standard = standardPrice(); const canOverride = hasPermission('reservation.price_override');
    const rows = [
      ['Customer', `${customer.firstName} ${customer.lastName}`, [customer.companyName, customer.mobilePhone, customer.email].filter(Boolean).join(' · ')],
      ['Vehicle', `Unit ${vehicle.unitNumber}`, `${vehicle.licensePlate} · ${vehicle.licensePlateState}${vehicle.trailerNumber ? ` · Trailer ${vehicle.trailerNumber}` : ''}`],
      ['Parking', `${parkingTerm(state.draft.parking.duration)} Parking`, `${option?.category || ''} · ${position ? `Space ${position.label}` : option?.zone || ''}`],
      ['Dates', dateTime(state.availability?.request?.arrival), state.draft.parking.duration === 'MONTHLY' ? 'Open-ended · next billing on the 1st' : state.draft.parking.duration === 'WEEKLY' ? 'Open-ended · billed every 7 days until parking is ended' : dateTime(state.availability?.request?.departure)],
      ['Price', `${money(finalPrice())}${rateSuffix(state.draft.parking.duration)}`, state.draft.price.override ? `${state.draft.price.reason} · ${money(finalPrice() - standardPrice())} difference from standard` : 'Authoritative current rate; global pricing is unchanged'],
      ['Documents', state.draft.parking.duration === 'MONTHLY' ? 'Insurance optional' : 'Not required', state.draft.parking.duration === 'MONTHLY' ? 'Upload now or later through the protected document workflow' : `No ${parkingTerm(state.draft.parking.duration)} document required`],
      payOnSite()
        ? ['Payment', 'Pay at the office', state.draft.parking.duration === 'MONTHLY' ? 'First month at check-in, then on the 1st of each month. Record it in the customer ledger.' : 'Customer pays when they leave. Record it in the customer ledger.']
        : ['Payment', 'Stripe secure payment link', 'The reservation starts as payment pending; ParkingOps records payment only after Stripe verifies it']
    ];
    return `<section class="desk-sheet desk-review"><div class="desk-step-heading"><p>STEP 03</p><h3>${escapeHtml(reviewLabel())}</h3><span>Confirm the customer, vehicle, parking and price.</span></div>
      ${payOnSite() ? '<div class="desk-permission-note"><strong>Confirmed on save · pay at the office</strong><span>The reservation is confirmed as soon as you complete it. No payment link is sent; record the payment when the customer pays.</span></div>' : '<div class="desk-permission-note"><strong>Stripe secure payment link</strong><span>Create or send the link after this pending reservation is saved. Monthly insurance is optional and can be uploaded later.</span></div>'}
      ${canOverride ? `<form method="post" id="deskPriceForm" class="desk-price-form"><label class="desk-switch"><input name="override" type="checkbox"${state.draft.price.override ? ' checked' : ''}><span>Override this booking price</span></label><div class="desk-override-fields"${state.draft.price.override ? '' : ' hidden'}>${field('finalPrice', 'Final booking price', dollarValue(state.draft.price.finalPriceCents ?? standard), 'inputmode="decimal"')}<label><span>Reason</span><select name="reason"><option value="">Choose a reason</option>${['Manager adjustment','Existing customer','Contract rate','Promotional rate','Service recovery','Manual correction','Other'].map(reason => `<option${state.draft.price.reason === reason ? ' selected' : ''}>${reason}</option>`).join('')}</select></label></div><button class="btn ghost compact" type="submit">Apply price</button></form>` : ''}
      <dl>${rows.map(([label, value, supporting]) => `<div><dt>${escapeHtml(label)}</dt><dd><strong>${escapeHtml(value)}</strong><span>${escapeHtml(supporting)}</span></dd></div>`).join('')}</dl>
      <div class="desk-form-actions"><button class="btn ghost" type="button" data-desk-back>← Parking</button><button class="btn primary" type="button" data-create-desk-reservation>COMPLETE BOOKING</button></div></section>`;
  }

  function detailView() {
    const detail = state.detail; const booking = detail.reservation;
    const openEndedWeekly = booking.product === 'WEEKLY' && !booking.departureAt;
    const onSiteBooking = booking.paymentStatus === 'NOT_REQUIRED';
    const canPrice = hasPermission('reservation.price_override') && ((booking.status === 'PENDING' && booking.paymentStatus === 'DRAFT') || (onSiteBooking && ['PENDING', 'CONFIRMED', 'CHECKED_IN'].includes(booking.status)));
    const canDemo = state.bootstrap.demoPayment?.enabled && hasPermission('reservation.demo_bypass')
      && booking.status === 'PENDING' && booking.paymentStatus === 'DRAFT';
    const canNotify = state.bootstrap.notifications?.emailConfigured || state.bootstrap.notifications?.smsConfigured;
    const insurance = detail.documents?.find(item => ['INSURANCE', 'VEHICLE_CARRIER_INSURANCE'].includes(item.document_type));
    return `<section class="desk-detail"><div class="desk-success"><span aria-hidden="true">✓</span><div><p>BOOKING COMPLETE</p><h2>${escapeHtml(`${booking.firstName} ${booking.lastName}`)}</h2><strong>${escapeHtml(booking.selectedPosition ? `Lot #${booking.selectedPosition}` : booking.area)} · ${escapeHtml(booking.licensePlate)} / Unit ${escapeHtml(booking.unitNumber)}</strong><small>${escapeHtml(booking.reservationNumber)} · ${escapeHtml(booking.status)} · ${escapeHtml(paymentLabel(booking.paymentStatus))}</small></div><button class="btn ghost" type="button" data-new-desk-reservation>New Booking</button></div>
      <div class="desk-detail-grid"><section class="desk-sheet"><div class="desk-step-heading"><p>CUSTOMER &amp; VEHICLE</p><h3>${escapeHtml(`${booking.firstName} ${booking.lastName}`)}</h3><span>${escapeHtml([booking.companyName, booking.phone, booking.email].filter(Boolean).join(' · '))}</span></div>
        <dl class="desk-facts"><div><dt>Unit</dt><dd>${escapeHtml(booking.unitNumber)}</dd></div><div><dt>Plate</dt><dd>${escapeHtml(`${booking.licensePlate} · ${booking.licensePlateState}`)}</dd></div><div><dt>Trailer</dt><dd>${escapeHtml(booking.trailerNumber || '—')}</dd></div><div><dt>Created by</dt><dd>${escapeHtml(booking.createdBy || 'ParkingOps')}</dd></div></dl>
        <button class="btn ghost compact" type="button" data-toggle-desk-edit>${state.editMode ? 'Close edit' : 'Edit allowed fields'}</button>
        ${state.editMode ? editForm(booking) : ''}</section>
        <section class="desk-sheet"><div class="desk-step-heading"><p>PARKING &amp; PRICE</p><h3>${escapeHtml(`${parkingTerm(booking.product)} Parking`)}</h3><span>${escapeHtml(booking.selectedPosition ? `Position ${booking.selectedPosition}` : booking.area)}</span></div>
          <dl class="desk-facts"><div><dt>${booking.product === 'MONTHLY' || openEndedWeekly ? 'Start' : 'Arrival'}</dt><dd>${escapeHtml(dateTime(booking.arrivalAt))}</dd></div>${booking.product === 'MONTHLY' ? `<div><dt>Status</dt><dd>${escapeHtml(booking.monthlyStatus || 'ACTIVE')} · ${booking.nextBillingAt ? `next billing ${escapeHtml(dateTime(booking.nextBillingAt))}` : 'ended'}</dd></div>` : openEndedWeekly ? `<div><dt>Status</dt><dd>${escapeHtml(booking.weeklyStatus || 'Active')}${booking.nextBillingAt ? ` · next billing ${escapeHtml(dateTime(booking.nextBillingAt))}` : ''}</dd></div>` : `<div><dt>Departure</dt><dd>${escapeHtml(dateTime(booking.departureAt))}</dd></div>`}<div><dt>Standard</dt><dd>${money(booking.standardPriceCents)}${rateSuffix(booking.product)}</dd></div><div><dt>Final</dt><dd>${money(booking.finalPriceCents)}${rateSuffix(booking.product)}</dd></div></dl>
          ${booking.product === 'MONTHLY' && booking.monthlyStatus === 'ACTIVE' ? '<button class="btn ghost compact" type="button" data-end-desk-monthly>End Monthly parking</button>' : ''}
          ${booking.overrideReason ? `<div class="desk-audit-callout"><strong>Price override</strong><span>${escapeHtml(booking.overrideReason)} · ${money(booking.overrideDifferenceCents)} difference</span></div>` : ''}
          ${canPrice ? `<button class="btn ghost compact" type="button" data-toggle-desk-price>${state.priceMode ? 'Close price change' : 'Adjust reservation price'}</button>${state.priceMode ? priceOverrideForm(booking) : ''}` : ''}
        </section>
        <section class="desk-sheet"><div class="desk-step-heading"><p>PAYMENT &amp; DOCUMENTS</p><h3>${escapeHtml(paymentLabel(booking.paymentStatus))}</h3><span>${onSiteBooking ? `${money(booking.finalPriceCents)}${rateSuffix(booking.product)} · collected at the office` : 'Financial status remains distinct from reservation status.'}</span></div>
          ${onSiteBooking && booking.customerPublicId ? `<button class="btn primary compact" type="button" data-customer-id="${escapeHtml(booking.customerPublicId)}" data-customer-focus="payment">Record payment</button>` : ''}
          ${canNotify ? '<button class="btn ghost compact" type="button" data-send-desk-notice="CONFIRMATION">Send Reservation Confirmation</button>' : '<button class="btn ghost compact" type="button" disabled>Send Reservation Confirmation</button><p class="desk-inline-note">Customer messaging is not configured. Print or copy the secure details instead.</p>'}
          ${booking.product === 'MONTHLY' ? `<div class="desk-document-status"><strong>Insurance</strong><span>${insurance ? `${escapeHtml(insurance.verification_status)} · ${escapeHtml(insurance.original_filename)}` : 'Missing - upload optional'}</span></div><form method="post" id="deskInsuranceForm" class="desk-upload"><input name="file" type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" required><button class="btn ghost" type="submit">${insurance ? 'Replace insurance' : 'Upload insurance'}</button></form>${state.uploadProgress ? `<progress max="100" value="${state.uploadProgress}"></progress>` : ''}` : ''}
          ${booking.checkoutUrl ? `<div class="desk-payment-link"><a class="btn primary" href="${escapeHtml(booking.checkoutUrl)}" target="_blank" rel="noopener noreferrer">Open Stripe Checkout</a><button class="btn ghost" type="button" data-copy-payment-link="${escapeHtml(booking.checkoutUrl)}">Copy Payment Link</button>${canNotify ? '<button class="btn ghost" type="button" data-send-desk-notice="PAYMENT_LINK">Send Payment Link</button>' : '<button class="btn ghost" type="button" disabled>Send Payment Link</button>'}<small>Expires ${escapeHtml(dateTime(booking.checkoutExpiresAt))}</small></div>` : booking.paymentStatus === 'DRAFT' ? `<button class="btn primary" type="button" data-create-payment-link>Create Secure Payment Link</button>${canDemo ? '<button class="btn ghost" type="button" data-create-demo-link>Create one-time QA Demo Link</button>' : ''}` : ''}
          ${state.demoLink ? `<div class="desk-payment-link"><a class="btn primary" href="${escapeHtml(state.demoLink)}" target="_blank" rel="noopener noreferrer">Open one-time Demo Link</a><button class="btn ghost" type="button" data-copy-payment-link="${escapeHtml(state.demoLink)}">Copy Demo Link</button><small>Short-lived, reservation-bound, and single use.</small></div>` : ''}
          ${booking.paymentStatus === 'DEMO_BYPASSED' ? `<div class="desk-audit-callout"><strong>DEMO / NO PAYMENT</strong><span>Amount ${money(booking.finalPriceCents)} · Financially paid: NO · Not included in revenue</span></div>` : onSiteBooking ? '<p class="desk-inline-note">Payments are recorded in the customer ledger (cash, Clover, card, check). Nothing is charged online.</p>' : '<p class="desk-inline-note">Payment is completed securely through Stripe. ParkingOps never marks unpaid money as paid.</p>'}
        </section>
        <section class="desk-sheet"><div class="desk-step-heading"><p>AUDIT HISTORY</p><h3>Reservation history</h3><span>Material changes and money decisions are append-only.</span></div>
          <ol class="desk-history">${(detail.audit || []).map(item => `<li><strong>${escapeHtml(item.action.replaceAll('_', ' '))}</strong><span>${escapeHtml(item.admin_name || item.admin_username || 'System')} · ${escapeHtml(dateTime(item.created_at))}</span></li>`).join('') || '<li><span>No audit events returned.</span></li>'}</ol>
        </section></div>
      <div class="desk-action-bar"><button class="btn ghost" type="button" data-print-desk>Print / View Reservation</button>${booking.status === 'PENDING' ? '<button class="btn danger" type="button" data-cancel-desk>Cancel Reservation</button>' : ''}</div>
    </section>`;
  }

  function editForm(booking) {
    const datesEditable = booking.paymentStatus === 'DRAFT' || (booking.paymentStatus === 'NOT_REQUIRED' && ['PENDING', 'CONFIRMED'].includes(booking.status));
    const openEnded = booking.product === 'MONTHLY' || (booking.product === 'WEEKLY' && !booking.departureAt);
    return `<form method="post" id="deskEditForm" class="desk-form-grid desk-inline-form">${field('firstName', 'First name', booking.firstName, 'required')}${field('lastName', 'Last name', booking.lastName, 'required')}${field('mobilePhone', 'Phone', booking.phone, 'required')}${field('email', 'Email', booking.email, 'required type="email"')}${field('unitNumber', 'Unit', booking.unitNumber, 'required')}${field('licensePlate', 'Plate', booking.licensePlate, 'required')}${field('licensePlateState', 'State', booking.licensePlateState, 'required')}${field('trailerNumber', 'Trailer', booking.trailerNumber)}${datesEditable ? `${field('arrivalLocal', openEnded ? 'Start date' : 'Arrival', booking.arrivalLocal, 'required type="datetime-local"')}${openEnded ? '' : field('departureLocal', 'Departure', booking.departureLocal, 'required type="datetime-local"')}<p class="desk-inline-note desk-span">Date changes are checked against protected capacity before they are saved.</p>` : ''}<label class="desk-span"><span>Internal notes</span><textarea name="internalNotes">${escapeHtml(booking.internalNotes || '')}</textarea></label><button class="btn primary desk-span" type="submit">Review &amp; Save Changes</button></form>`;
  }

  function priceOverrideForm(booking) {
    return `<form method="post" id="deskOverrideForm" class="desk-form-grid desk-inline-form">${field('finalPrice', 'Final price', dollarValue(booking.finalPriceCents), 'required inputmode="decimal"')}<label><span>Reason</span><select name="reason" required><option value="">Choose a reason</option>${['Manager adjustment','Existing customer','Contract rate','Promotional rate','Service recovery','Manual correction','Other'].map(reason => `<option>${reason}</option>`).join('')}</select></label><button class="btn primary desk-span" type="submit">Confirm Price Override</button></form>`;
  }

  function render() {
    if (!state.draft) state.draft = freshDraft();
    if (!state.bootstrap) return `<section class="desk-page"><div class="desk-page-head"><div><p>TRUCKER HEAVEN</p><h2>NEW BOOKING</h2><span>Customer parking, handled by authorized employees.</span></div></div><div class="desk-sheet"><p>${state.loading ? 'Opening New Booking…' : escapeHtml(state.error || 'New Booking is not available.')}</p></div></section>`;
    const content = state.detail ? detailView() : [customerStep, parkingStep, paymentStep][state.step - 1]();
    return `<section class="desk-page"><div class="desk-page-head"><div><p>TRUCKER HEAVEN · PARKING OPERATIONS</p><h2>NEW BOOKING</h2><span>Customer &amp; Vehicle → Parking → ${escapeHtml(reviewLabel())}</span></div>${state.detail ? '' : '<button class="btn ghost" type="button" data-reset-desk>Reset</button>'}</div>
      ${progress()}${state.error ? `<div class="error" role="alert">${escapeHtml(state.error)}</div>` : ''}${state.message ? `<div class="note" role="status">${escapeHtml(state.message)}</div>` : ''}${content}
      ${state.loading ? '<div class="desk-busy" role="status">Working…</div>' : ''}</section>`;
  }

  function formValues(form, keys) { return Object.fromEntries(keys.map(key => [key, form.elements[key]?.value?.trim?.() || ''])); }
  function setStep(step) { state.step = step; state.error = ''; state.message = ''; rerender(); requestAnimationFrame(() => document.querySelector('.desk-step-heading h3')?.focus?.()); }
  function uploadFile(upload, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); xhr.open(upload.method || 'PUT', upload.url);
      Object.entries(upload.headers || {}).forEach(([name, value]) => xhr.setRequestHeader(name, value));
      xhr.upload.addEventListener('progress', event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); });
      xhr.addEventListener('load', () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Secure upload failed (${xhr.status}).`)));
      xhr.addEventListener('error', () => reject(new Error('Secure upload could not reach document storage.'))); xhr.send(file);
    });
  }

  function bind(user) {
    initialize(user);
    document.querySelector('[data-reset-desk]')?.addEventListener('click', () => { resetDraft(); rerender(); });
    document.querySelector('[data-new-desk-reservation]')?.addEventListener('click', () => { resetDraft(); rerender(); });
    document.querySelectorAll('[data-desk-back]').forEach(button => button.addEventListener('click', () => setStep(Math.max(1, state.step - 1))));
    document.querySelector('#deskCustomerSearch')?.addEventListener('submit', async event => {
      event.preventDefault(); const query = event.currentTarget.elements.query.value.trim(); if (query.length < 2) return;
      setBusy(true, 'Searching customers…');
      try { state.customerResults = (await api.reservationDeskCustomers(query)).customers || []; state.loading = false; state.message = state.customerResults.length ? '' : 'No matching customer found. Create one below.'; rerender(); }
      catch (error) { fail(error, 'Customer search failed.'); }
    });
    document.querySelectorAll('[data-select-desk-customer]').forEach(button => button.addEventListener('click', () => {
      const customer = state.customerResults.find(item => item.publicId === button.dataset.selectDeskCustomer); if (!customer) return;
      state.selectedCustomer = customer; state.draft.customer = { existingPublicId: customer.publicId, firstName: customer.firstName || '', lastName: customer.lastName || '',
        mobilePhone: customer.phone || '', email: customer.email || '', companyName: customer.companyName || '', usdotNumber: customer.usdotNumber || '', mcNumber: customer.mcNumber || '' };
      state.customerResults = []; rerender();
    }));
    document.querySelector('[data-clear-desk-customer]')?.addEventListener('click', () => { state.selectedCustomer = null; state.draft.customer.existingPublicId = ''; rerender(); });
    document.querySelector('#deskCustomerVehicleForm')?.addEventListener('submit', async event => { event.preventDefault(); if (!event.currentTarget.reportValidity()) return;
      state.draft.customer = { ...state.draft.customer, ...formValues(event.currentTarget, ['firstName','lastName','mobilePhone','email','companyName','usdotNumber','mcNumber']) };
      state.draft.vehicle = { ...state.draft.vehicle, ...formValues(event.currentTarget, ['unitNumber','licensePlate','licensePlateState','trailerNumber']) };
      if (state.draft.customer.existingPublicId) return setStep(2);
      setBusy(true, 'Saving the new customer…');
      try {
        const result = await api.createReservationDeskCustomer(state.draft.customer);
        state.selectedCustomer = result.customer;
        state.draft.customer.existingPublicId = result.customer.publicId;
        state.loading = false; state.message = 'Customer saved. Continue with parking.'; state.step = 2; rerender();
      } catch (error) { fail(error, 'Customer could not be saved.'); }
    });
    document.querySelectorAll('[data-select-desk-vehicle]').forEach(button => button.addEventListener('click', () => { const vehicle = state.selectedCustomer?.vehicles?.find(item => item.publicId === button.dataset.selectDeskVehicle); if (!vehicle) return;
      state.draft.vehicle = { ...state.draft.vehicle, existingPublicId: vehicle.publicId, unitNumber: vehicle.unitNumber || '', licensePlate: vehicle.licensePlate || '', licensePlateState: vehicle.licensePlateState || '' }; rerender(); }));
    document.querySelector('#deskAvailabilityForm')?.addEventListener('submit', async event => { event.preventDefault(); if (!event.currentTarget.reportValidity()) return;
      const keys = ['locationId','duration','categoryCode','arrivalLocal']; if (!openEndedTerm(event.currentTarget.elements.duration.value)) keys.push('departureLocal');
      const values = formValues(event.currentTarget, keys); if (openEndedTerm(event.currentTarget.elements.duration.value)) delete values.departureLocal;
      state.draft.parking = { ...state.draft.parking, ...values, inventoryId: '', selectedSpotId: '' };
      setBusy(true, 'Checking protected inventory and current rates…');
      try { state.availability = await api.reservationDeskAvailability(state.draft.parking); state.loading = false; state.message = ''; applyPreselectedSpace(); rerender(); }
      catch (error) { fail(error, 'Availability could not be checked.'); }
    });
    document.querySelectorAll('[data-select-desk-option]').forEach(button => button.addEventListener('click', () => { state.draft.parking.inventoryId = button.dataset.selectDeskOption; state.draft.parking.selectedSpotId = ''; rerender(); }));
    document.querySelector('#deskPosition')?.addEventListener('change', event => { state.draft.parking.selectedSpotId = event.target.value; rerender(); });
    document.querySelector('[data-desk-parking-next]')?.addEventListener('click', () => setStep(3));
    const priceForm = document.querySelector('#deskPriceForm');
    priceForm?.elements.override?.addEventListener('change', event => { state.draft.price.override = event.target.checked; state.draft.price.finalPriceCents = standardPrice(); rerender(); });
    priceForm?.addEventListener('submit', event => { event.preventDefault(); try { const enabled = event.currentTarget.elements.override.checked; const reason = event.currentTarget.elements.reason.value;
      if (enabled && !reason) throw new Error('Choose a reason for the price override.'); state.draft.price = { override: enabled,
        finalPriceCents: enabled ? dollarsToCents(event.currentTarget.elements.finalPrice.value) : standardPrice(), reason: enabled ? reason : '' }; setStep(3); }
      catch (error) { state.error = error.message; rerender(); } });
    document.querySelector('[data-desk-review]')?.addEventListener('click', () => { state.draft.price = { override: false, finalPriceCents: standardPrice(), reason: '' }; setStep(3); });
    document.querySelector('[data-create-desk-reservation]')?.addEventListener('click', async () => { if (state.loading) return;
      state.idempotencyKey ||= `${crypto.randomUUID()}-${crypto.randomUUID()}`; setBusy(true, payOnSite() ? 'Creating the reservation…' : 'Creating the pending reservation…');
      try { state.detail = await api.createDeskReservation(state.draft, state.idempotencyKey); state.loading = false; state.message = state.detail?.reservation?.paymentStatus === 'NOT_REQUIRED' ? `Reservation ${state.detail.reservation.status === 'CONFIRMED' ? 'confirmed' : 'created'}. The customer pays at the office.` : 'Reservation created. No payment has been recorded.'; rerender(); }
      catch (error) { fail(error, 'Reservation could not be created.'); }
    });
    document.querySelector('[data-toggle-desk-edit]')?.addEventListener('click', () => { state.editMode = !state.editMode; rerender(); });
    document.querySelector('[data-toggle-desk-price]')?.addEventListener('click', () => { state.priceMode = !state.priceMode; rerender(); });
    document.querySelector('[data-end-desk-monthly]')?.addEventListener('click', async () => { const booking = state.detail.reservation; const effectiveEndLocal = window.prompt('Effective Monthly end (local date and time):', booking.arrivalLocal); if (!effectiveEndLocal) return; if (!window.confirm(`End Monthly parking effective ${effectiveEndLocal}?`)) return;
      setBusy(true, 'Ending Monthly parking…'); try { state.detail = await api.endDeskMonthlyReservation(booking.id, { confirmed: true, effectiveEndLocal }); state.loading = false; rerender(); } catch (error) { fail(error, 'Monthly parking could not be ended.'); } });
    document.querySelector('#deskEditForm')?.addEventListener('submit', async event => { event.preventDefault(); const booking = state.detail.reservation;
      const keys = ['firstName','lastName','mobilePhone','email','unitNumber','licensePlate','licensePlateState','trailerNumber','internalNotes'];
      if (booking.paymentStatus === 'DRAFT' || (booking.paymentStatus === 'NOT_REQUIRED' && ['PENDING', 'CONFIRMED'].includes(booking.status))) { keys.push('arrivalLocal'); if (booking.departureAt) keys.push('departureLocal'); }
      const values = formValues(event.currentTarget, keys); const current = key => key === 'mobilePhone' ? booking.phone : booking[key];
      const changes = Object.fromEntries(Object.entries(values).filter(([key, value]) => String(current(key) || '') !== value)); if (!Object.keys(changes).length) return;
      const comparison = Object.entries(changes).map(([key, value]) => `${key}: ${current(key) || '—'} → ${value || '—'}`).join('\n');
      if (!window.confirm(`Confirm these reservation changes?\n\n${comparison}`)) return; setBusy(true, 'Saving confirmed changes…');
      try { state.detail = await api.updateDeskReservation(booking.id, { version: booking.version, confirmed: true, changes }); state.loading = false; state.editMode = false; rerender(); }
      catch (error) { fail(error, 'Reservation changes could not be saved.'); }
    });
    document.querySelector('#deskOverrideForm')?.addEventListener('submit', async event => { event.preventDefault(); try { const booking = state.detail.reservation;
      const finalPriceCents = dollarsToCents(event.currentTarget.elements.finalPrice.value); const reason = event.currentTarget.elements.reason.value;
      if (!reason) throw new Error('Choose a reason.'); if (!window.confirm(`Confirm price change?\n\n${money(booking.finalPriceCents)} → ${money(finalPriceCents)}\nReason: ${reason}`)) return;
      setBusy(true, 'Recording the audited price override…'); state.detail = await api.overrideDeskReservationPrice(booking.id, { version: booking.version, finalPriceCents, reason }); state.loading = false; state.priceMode = false; rerender();
    } catch (error) { fail(error, 'Price override could not be saved.'); } });
    document.querySelector('#deskInsuranceForm')?.addEventListener('submit', async event => { event.preventDefault(); const file = event.currentTarget.elements.file.files[0]; if (!file) return;
      setBusy(true, 'Preparing insurance upload…'); try { const booking = state.detail.reservation; const started = await api.startDeskInsuranceUpload(booking.id, { filename: file.name, mimeType: file.type, sizeBytes: file.size });
        await uploadFile(started.upload, file, progressValue => { state.uploadProgress = progressValue; state.message = `Uploading insurance… ${progressValue}%`; rerender(); });
        await api.completeDeskInsuranceUpload(booking.id, { uploadToken: started.uploadToken, documentId: started.document.id }); state.detail = await api.deskReservation(booking.id);
        state.loading = false; state.uploadProgress = 0; state.message = 'Insurance received and verified by secure storage.'; rerender();
      } catch (error) { state.uploadProgress = 0; fail(error, 'Insurance upload failed.'); } });
    document.querySelector('[data-create-payment-link]')?.addEventListener('click', async () => { const booking = state.detail.reservation; setBusy(true, 'Creating secure Stripe Checkout…');
      try { const result = await api.createDeskPaymentLink(booking.id); state.detail = await api.deskReservation(booking.id); state.detail.reservation.checkoutUrl = result.checkout.url; state.loading = false; state.message = 'Secure payment link created. No payment is recorded until Stripe verifies it.'; rerender(); }
      catch (error) { fail(error, 'Payment link could not be created.'); } });
    document.querySelector('[data-create-demo-link]')?.addEventListener('click', async () => { const booking = state.detail.reservation;
      if (!window.confirm('Create a short-lived one-time QA Demo Link for this exact reservation? This will not record payment.')) return;
      setBusy(true, 'Creating one-time demo authorization…');
      try { const result = await api.createDemoPaymentAuthorization(booking.id); state.demoLink = result.demoAuthorization.url;
        state.loading = false; state.message = 'One-time Demo Link created. No payment or Stripe object was created.'; rerender(); }
      catch (error) { fail(error, 'Demo authorization could not be created.'); } });
    document.querySelector('[data-copy-payment-link]')?.addEventListener('click', async event => { try { await navigator.clipboard.writeText(event.currentTarget.dataset.copyPaymentLink); state.message = 'Payment link copied.'; rerender(); } catch (_) { window.prompt('Copy secure payment link:', event.currentTarget.dataset.copyPaymentLink); } });
    document.querySelectorAll('[data-send-desk-notice]').forEach(button => button.addEventListener('click', async () => {
      const booking = state.detail.reservation; const kind = button.dataset.sendDeskNotice;
      const label = kind === 'PAYMENT_LINK' ? 'secure payment link' : 'reservation confirmation';
      if (!window.confirm(`Send the ${label} to ${booking.email || booking.phone}?`)) return;
      setBusy(true, `Queuing ${label}…`);
      try { const result = await api.sendDeskReservationNotice(booking.id, kind); state.loading = false;
        state.message = `${kind === 'PAYMENT_LINK' ? 'Payment link' : 'Reservation confirmation'} queued by ${result.channel === 'SMS' ? 'text message' : 'email'}.`; rerender(); }
      catch (error) { fail(error, 'The customer notice could not be queued.'); }
    }));
    document.querySelector('[data-print-desk]')?.addEventListener('click', () => window.print());
    document.querySelector('[data-cancel-desk]')?.addEventListener('click', async () => { const booking = state.detail.reservation; const reason = window.prompt('Cancellation reason (required):'); if (!reason) return;
      if (!window.confirm(`Cancel ${booking.reservationNumber}? Capacity will be released and the action will be audited.`)) return; setBusy(true, 'Cancelling reservation…');
      try { await api.transitionBooking(booking.id, 'cancel', { version: booking.version, reason, note: 'Cancelled from Reservation Desk' }); state.detail = await api.deskReservation(booking.id); state.loading = false; rerender(); }
      catch (error) { fail(error, 'Reservation could not be cancelled.'); } });
  }

  function clearPrivateState() {
    state.userId = null; state.bootstrap = null; state.customerResults = []; state.selectedCustomer = null;
    state.availability = null; state.detail = null; state.draft = null; state.message = ''; state.error = ''; state.preselectedSpace = null; state.pendingReservationId = '';
  }

  async function openReservation(id) {
    if (!id) return;
    if (!state.bootstrap) { state.pendingReservationId = String(id); return; }
    setBusy(true, 'Opening reservation in the Desk…');
    try { state.detail = await api.deskReservation(id); state.step = 3; state.loading = false; rerender(); }
    catch (error) { fail(error, 'Reservation could not be opened in the Desk.'); }
  }

  function openForSpace(space) {
    state.preselectedSpace = space;
    if (!state.bootstrap) return;
    resetDraft({ keepPreselectedSpace: true }); applySpacePrefill(space); rerender();
  }

  window.ParkingReservationDesk = Object.freeze({ render, bind, clearPrivateState, openForSpace, openReservation });
})();
