/* Trucker Heaven Parking: map-first booking. Customers pay at the office; nothing is charged online. */
(() => {
  'use strict';

  const C = window.ParkingCore;
  const Plan = window.LotPlan;
  const PLAN = window.LotPlanData;
  const cfg = window.PARKING_CONFIG || {};
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

  const STORE_RESERVATIONS = 'th-parking-reservations';
  const STORE_DRIVER = 'th-parking-driver';
  const DRIVER_FIELDS = ['firstName', 'lastName', 'mobilePhone', 'email', 'companyName', 'usdotNumber', 'licensePlate', 'licensePlateState', 'tractorUnitNumber', 'trailerNumber'];
  const CATEGORY_NAMES = { TRACTOR_TRAILER: 'Truck & trailer', BOBTAIL: 'Bobtail' };
  const TAKEN_CODES = ['MONTHLY_POSITION_UNAVAILABLE', 'SPOT_ALREADY_ASSIGNED', 'SPOT_NOT_ELIGIBLE', 'PARKING_NOT_AVAILABLE', 'PARKING_ALLOCATION_UNAVAILABLE'];

  const state = {
    lot: null,
    timezone: 'America/Chicago',
    rates: { TRACTOR_TRAILER: { DAILY: 1900, WEEKLY: 10000, MONTHLY: 25000 }, BOBTAIL: { DAILY: 1900, WEEKLY: 10000, MONTHLY: 15000 } },
    form: null,
    trip: null,
    tripError: '',
    spaces: new Map(),      // number -> 'open' | 'taken'
    spotIds: new Map(),     // number -> parkingSpotId
    holdToken: null,        // quote token holding the picked space for 10 minutes
    openCount: 0,
    selected: null,         // picked space number
    quote: null,
    quoteFor: '',
    loadSeq: 0,
    quoteSeq: 0,
    zoom: 1,
    submitting: false,
    current: null,
    justBooked: null
  };

  // ---------- storage (optional) ----------
  const store = {
    get(key, fallback) { try { const raw = window.localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; } },
    set(key, value) { try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* private mode */ } }
  };
  const remembered = () => (store.get(STORE_RESERVATIONS, []) || []).filter(item => item && item.n && item.c);
  function remember(booking, credential) {
    const list = remembered().filter(item => item.n !== booking.reservationNumber);
    list.unshift({ n: booking.reservationNumber, c: credential, arrival: booking.arrival, term: booking.parkingProduct, where: whereToPark(booking), saved: Date.now() });
    store.set(STORE_RESERVATIONS, list.slice(0, 8));
  }
  const forget = number => store.set(STORE_RESERVATIONS, remembered().filter(item => item.n !== number));
  const isRemembered = number => remembered().some(item => item.n === number);

  // ---------- API ----------
  async function api(path, body, { idempotencyKey } = {}) {
    if (!cfg.apiBase) throw { code: 'NOT_CONFIGURED', message: 'Online booking is not available right now. Please call the office.' };
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let response;
    try {
      response = await fetch(`${cfg.apiBase}${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', cache: 'no-store' });
    } catch (_) { throw { code: 'NETWORK' }; }
    let data = {};
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok) { const error = data.error || {}; throw { code: error.code || `HTTP_${response.status}`, message: error.message, status: response.status }; }
    return data;
  }
  const newKey = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  // ---------- small helpers ----------
  function toast(message) {
    const el = $('#toast'); el.textContent = message; el.hidden = false; el.classList.add('show');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => { el.hidden = true; }, 250); }, 2400);
  }
  const showError = (el, message) => { el.textContent = message || ''; el.hidden = !message; };
  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) { button.dataset.label = button.textContent; button.textContent = label; button.disabled = true; button.classList.add('is-busy'); }
    else { if (button.dataset.label) button.textContent = button.dataset.label; button.disabled = false; button.classList.remove('is-busy'); }
  }
  async function copy(text, done) { try { await navigator.clipboard.writeText(text); toast(done || 'Copied'); } catch (_) { toast('Press and hold to copy'); } }
  const phoneHref = () => `tel:${cfg.supportPhone || '+16154705075'}`;
  const phoneText = () => cfg.supportPhoneDisplay || '615-470-5075';
  const directionsUrl = () => state.lot?.roadDirectionsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(state.lot?.address || '8037 Eastgate Blvd, Mt. Juliet, TN 37122')}`;
  const rateFor = (category, duration) => state.rates[category]?.[duration];
  const loadingHtml = text => `<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span>${esc(text)}</div>`;
  const spaceWord = count => `${count} ${count === 1 ? 'space' : 'spaces'}`;
  const account = window.ParkingAccount({ $, esc, C, cfg, toast, setBusy, showError, loadingHtml, phoneHref, phoneText });

  // ---------- lot info ----------
  async function loadLot() {
    try {
      const { lot } = await api('/canonical-lot');
      state.lot = lot;
      state.timezone = lot.timezone || state.timezone;
      for (const category of lot.categories || []) {
        const rates = {};
        for (const offer of category.offeredDurations || []) rates[offer.code] = offer.unitRateCents;
        state.rates[category.code] = rates;
      }
      $('#systemBanner').hidden = true;
      if (lot.address) $$('[data-address-line]').forEach(el => { el.textContent = lot.address; });
      const zone = new Intl.DateTimeFormat('en-US', { timeZone: state.timezone, timeZoneName: 'long' }).formatToParts(new Date()).find(part => part.type === 'timeZoneName')?.value;
      if (zone) $('#timezoneNote').textContent = `Times are lot time (${zone.replace(/ (Standard|Daylight) Time$/, '')}).`;
      $$('[data-directions]').forEach(el => { el.href = directionsUrl(); });
      renderTerms(lot.terms);
      onTripChange();
    } catch (_) {
      const banner = $('#systemBanner');
      banner.innerHTML = `Online booking is unavailable right now. <button type="button" class="link" data-retry-lot>Try again</button> or call the office at <a href="${esc(phoneHref())}">${esc(phoneText())}</a>.`;
      banner.hidden = false;
      renderMap();
    }
  }
  function renderTerms(terms) {
    if (!terms) return;
    const block = section => section ? `<h3>${esc(section.title)}</h3>${(section.content || []).map(line => `<p>${esc(line)}</p>`).join('')}` : '';
    $('#termsText').innerHTML = block(terms.parking) + block(terms.cancellation);
  }

  // ---------- trip controls ----------
  function readTrip() {
    const data = new FormData($('#tripForm'));
    return {
      categoryCode: data.get('categoryCode'), duration: data.get('duration'),
      arrivalDate: data.get('arrivalDate'), arrivalTime: data.get('arrivalTime'),
      departureDate: data.get('departureDate'), departureTime: data.get('departureTime'),
      weeks: Number(data.get('weeks') || 1)
    };
  }
  function setDefaultDates() {
    const start = C.defaultArrival(state.timezone);
    $('#arrivalDate').value = start.date; $('#arrivalTime').value = start.time;
    $('#departureDate').value = C.addDays(start.date, 1); $('#departureTime').value = start.time;
  }
  let tripTimer = null;
  function onTripChange(event) {
    const form = readTrip();
    const today = C.lotNow(state.timezone).date;
    $('#arrivalDate').min = today;
    if (['arrivalDate', 'arrivalTime'].includes(event?.target?.id)) {
      const hours = C.hoursBetween(form.arrivalDate, form.arrivalTime, form.departureDate, form.departureTime);
      if (form.arrivalDate && (hours == null || hours <= 0)) {
        $('#departureDate').value = C.addDays(form.arrivalDate, 1);
        $('#departureTime').value = $('#departureTime').value || form.arrivalTime;
      }
    }
    $('#departureDate').min = form.arrivalDate || today;
    for (const duration of ['DAILY', 'WEEKLY', 'MONTHLY']) {
      $$(`[data-for="${duration}"]`).forEach(el => { el.hidden = form.duration !== duration; });
      const rate = rateFor(form.categoryCode, duration);
      const label = $(`[data-rate="${duration}"]`);
      if (label) label.textContent = rate == null ? '—' : `${C.money(rate, { whole: true })}`;
      const input = $(`input[name="duration"][value="${duration}"]`);
      if (input) input.disabled = rate == null;
    }
    $('#arrivalLabel').textContent = form.duration === 'MONTHLY' ? 'Starting' : 'Arriving';
    const until = C.departureFor({ ...readTrip(), duration: 'WEEKLY' });
    $('#weeklyUntil').textContent = form.duration === 'WEEKLY' && until?.date ? `Until ${C.formatDay(until.date)}` : '';
    clearTimeout(tripTimer);
    tripTimer = setTimeout(loadMap, event?.type === 'input' ? 450 : 120);
  }

  // ---------- map data ----------
  async function loadMap() {
    const form = readTrip();
    const { trip, errors } = C.buildTrip(form, { timezone: state.timezone });
    state.form = form;
    const changedTrip = JSON.stringify(trip || null) !== JSON.stringify(state.trip);
    if (changedTrip) dropPick();
    state.trip = trip || null;
    state.tripError = errors ? Object.values(errors)[0] : '';
    showError($('#tripError'), state.tripError);
    if (!trip || !state.lot) { state.spaces = new Map(); state.openCount = 0; renderAll(); return; }
    const seq = ++state.loadSeq;
    $('#mapLoading').hidden = false;
    try {
      await loadSpaces(trip, seq);
    } catch (error) {
      if (seq !== state.loadSeq) return;
      state.spaces = new Map(); state.openCount = 0;
      state.tripError = C.friendlyError(error);
      showError($('#tripError'), state.tripError);
    } finally {
      if (seq === state.loadSeq) { $('#mapLoading').hidden = true; renderAll(); }
    }
  }

  // Every term picks a numbered space: open ones are green and tappable.
  async function loadSpaces(trip, seq) {
    const sentToken = state.holdToken;
    const response = await api('/positions', { ...trip, quoteToken: sentToken || undefined });
    if (seq !== state.loadSeq) return;
    const spaces = new Map(); const ids = new Map(); let open = 0;
    for (const position of response.positions || []) {
      if (!position.number || !position.eligible) continue;
      spaces.set(String(position.number), position.available ? 'open' : 'taken');
      ids.set(String(position.number), Number(position.parkingSpotId));
      if (position.available) open += 1;
    }
    state.spaces = spaces; state.spotIds = ids; state.openCount = open;
    if (state.selected && spaces.get(state.selected) !== 'open') {
      // An answer asked before we got our hold shows our own space as held: keep the pick.
      if (state.holdToken && state.holdToken !== sentToken) spaces.set(state.selected, 'open');
      else dropPick();
    }
  }

  // Forget the picked space and give up its 10-minute hold so other drivers can take it.
  function dropPick() {
    const token = state.holdToken;
    state.selected = null; state.quote = null; state.quoteFor = ''; state.holdToken = null;
    if (token) api('/quotes/release', { quoteToken: token }).catch(() => {});
  }

  async function quoteSelection() {
    const trip = state.trip; if (!trip) return null;
    if (!state.selected) return null;
    const key = JSON.stringify([trip, state.selected]);
    if (state.quote && state.quoteFor === key && Date.parse(state.quote.expiresAt) - Date.now() > 30000) return state.quote;
    const seq = ++state.quoteSeq;
    // Passing the previous hold lets the server release it in the same step (switching spaces or refreshing).
    const response = await api('/quotes', { ...trip, selectedSpotId: state.spotIds.get(state.selected), previousQuoteToken: state.holdToken || undefined });
    state.holdToken = response.quoteToken;
    if (seq !== state.quoteSeq) return null;
    state.quote = { ...response.quote, token: response.quoteToken, expiresAt: response.expiresAt, terms: response.terms || state.lot?.terms };
    state.quoteFor = key;
    if (response.terms) renderTerms(response.terms);
    return state.quote;
  }

  // ---------- rendering ----------
  function renderAll() { renderMap(); renderLegend(); renderPick(); renderMobileBar(); }

  function renderMap() {
    const canvas = $('#mapCanvas');
    canvas.innerHTML = Plan.render(PLAN, {
      states: state.spaces, selected: state.selected, interactive: true,
      title: 'Lot map. Green spaces are open for your dates; tap one to pick it.'
    });
    applyZoom();
  }
  function renderLegend() {
    const items = [['open', 'Open'], ['mine', 'Your pick'], ['taken', 'Taken'], ['off', 'Not for this booking']];
    $('#legend').innerHTML = items.map(([cls, label]) => `<span><i class="sw is-${cls}"></i>${esc(label)}</span>`).join('');
  }

  function priceLines(quote) {
    if (!quote) return '';
    if (quote.duration === 'MONTHLY') {
      const recurring = quote.recurringUnitRateCents ?? quote.unitRateCents;
      const first = quote.initialProrated ? `First month (${quote.initialOccupiedDays} of ${quote.initialMonthDays} days)` : 'First month';
      return `<dl class="price"><div><dt>${esc(first)}</dt><dd>${C.money(quote.totalCents)}</dd></div><div><dt>Then on the 1st</dt><dd>${C.money(recurring)}/mo</dd></div></dl>`;
    }
    const unit = C.TERMS[quote.duration];
    return `<dl class="price"><div><dt>${quote.units} ${quote.units === 1 ? unit.unit : unit.plural} × ${C.money(quote.unitRateCents)}</dt><dd>${C.money(quote.totalCents)}</dd></div></dl>`;
  }
  const payNote = duration => `<p class="pay-note">${duration === 'MONTHLY' ? 'Pay the first month at the office when you arrive.' : 'Pay at the office when you leave.'} Nothing is charged online.</p>`;

  function renderPick() {
    const el = $('#pick');
    const trip = state.trip;
    if (!trip) { el.innerHTML = `<div class="pick-empty"><p>${esc(state.tripError || 'Choose your dates to see open spaces.')}</p></div>`; return; }
    const monthly = trip.duration === 'MONTHLY';
    if (!state.openCount) {
      el.innerHTML = `<div class="pick-empty"><h3>Full for those dates</h3><p>${esc(CATEGORY_NAMES[trip.categoryCode])} ${esc(C.TERMS[trip.duration].label.toLowerCase())} parking is full. Try other dates or call us.</p><a class="btn ghost block" href="${esc(phoneHref())}">Call ${esc(phoneText())}</a></div>`;
      return;
    }
    if (!state.selected) {
      const keeps = monthly ? 'The space you pick is yours every month.' : 'The space you pick is held for you for your dates.';
      el.innerHTML = `<div class="pick-empty"><span class="count">${state.openCount}</span><h3>Tap a green space</h3><p>${esc(spaceWord(state.openCount))} open for ${esc(C.TERMS[trip.duration].label)} ${esc(CATEGORY_NAMES[trip.categoryCode].toLowerCase())} parking. ${keeps}</p></div>`;
      return;
    }
    const heading = `<p class="kicker">Your space</p><div class="space-no">${esc(state.selected)}</div>`;
    const when = monthly ? `From ${C.formatLocal(trip.arrivalLocal)}` : `${C.formatLocal(trip.arrivalLocal)} → ${C.formatLocal(trip.departureLocal)}`;
    const estimate = C.estimate(state.form, state.rates[trip.categoryCode]);
    const price = state.quote && state.quoteFor ? priceLines(state.quote)
      : estimate ? `<dl class="price"><div><dt>${estimate.recurring ? 'Monthly rate' : esc(estimate.label)}</dt><dd>${C.money(estimate.totalCents)}${estimate.recurring ? '/mo' : ''}</dd></div></dl>` : '';
    el.innerHTML = `<div class="pick-card">${heading}<p class="when">${esc(when)}</p><div id="pickPrice">${price}</div><p class="hold-note" id="holdTimer" aria-live="off"></p>${payNote(trip.duration)}
      <button type="button" class="btn primary block" data-reserve>Reserve space ${esc(state.selected)}</button>
      <button type="button" class="link" data-clear-pick>Pick a different space</button></div>`;
    if (!state.quote || !state.quoteFor) refreshPickPrice();
  }
  // Shows how long the picked space stays held for this driver (10 minutes per price).
  function tickHold() {
    const el = $('#holdTimer');
    if (!el) return;
    const left = state.quote?.expiresAt ? Date.parse(state.quote.expiresAt) - Date.now() : 0;
    el.textContent = !state.quote ? '' : left > 0
      ? `Space ${state.selected} is held for you for ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`
      : 'Your hold ended. Reserve now to hold it again.';
  }
  async function refreshPickPrice() {
    try { const quote = await quoteSelection(); if (quote && $('#pickPrice')) $('#pickPrice').innerHTML = priceLines(quote); tickHold(); }
    catch (error) {
      if (TAKEN_CODES.includes(error.code)) { toast(C.friendlyError(error)); dropPick(); loadMap(); return; }
      if ($('#pickPrice')) $('#pickPrice').innerHTML = `<p class="error">${esc(C.friendlyError(error))}</p>`;
    }
  }
  function renderMobileBar() {
    const bar = $('#mobileBar');
    const trip = state.trip;
    const ready = trip && state.openCount && state.selected;
    bar.hidden = !ready || $('[data-view="book"]').hidden;
    if (!ready) return;
    bar.innerHTML = `<div><b>Space ${esc(state.selected)}</b><span>${esc(CATEGORY_NAMES[trip.categoryCode])} · ${esc(C.TERMS[trip.duration].label)}</span></div><button type="button" class="btn primary" data-reserve>Reserve</button>`;
  }

  function selectSpace(number) {
    if (state.spaces.get(String(number)) !== 'open') return;
    state.selected = String(number); state.quote = null; state.quoteFor = '';
    renderAll();
    if (window.matchMedia('(max-width: 900px)').matches) toast(`Space ${number} picked`);
  }

  // ---------- zoom & pan ----------
  // Zoom 1 shows the whole lot; on wide screens we start zoomed in so the map fills the card.
  function startZoom() {
    const scroller = $('#mapScroll'); const fit = baseWidth();
    return fit ? Math.min(2.4, Math.max(1, (scroller.clientWidth - 16) / fit)) : 1;
  }
  function baseWidth() {
    const scroller = $('#mapScroll');
    const ratio = PLAN.viewBox[2] / PLAN.viewBox[3];
    return Math.min(scroller.clientWidth, scroller.clientHeight * ratio) || scroller.clientWidth;
  }
  function applyZoom(focus) {
    const canvas = $('#mapCanvas'); const scroller = $('#mapScroll');
    const before = { w: canvas.clientWidth || 1, left: scroller.scrollLeft + scroller.clientWidth / 2, top: scroller.scrollTop + scroller.clientHeight / 2 };
    canvas.style.width = `${Math.round(baseWidth() * state.zoom)}px`;
    if (focus) {
      const center = Plan.spaceCenter(PLAN, focus);
      if (center) { scroller.scrollLeft = center.x * canvas.clientWidth - scroller.clientWidth / 2; scroller.scrollTop = center.y * canvas.clientHeight - scroller.clientHeight / 2; }
    } else {
      const scale = canvas.clientWidth / before.w;
      scroller.scrollLeft = before.left * scale - scroller.clientWidth / 2;
      scroller.scrollTop = before.top * scale - scroller.clientHeight / 2;
    }
    $$('[data-zoom]').forEach(button => {
      if (button.dataset.zoom === '-1') button.disabled = state.zoom <= 1;
      if (button.dataset.zoom === '1') button.disabled = state.zoom >= 5;
    });
  }
  function bindPan() {
    const scroller = $('#mapScroll');
    let drag = null;
    scroller.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, left: scroller.scrollLeft, top: scroller.scrollTop, moved: false };
    });
    window.addEventListener('pointermove', event => {
      if (!drag) return;
      const dx = event.clientX - drag.x; const dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; scroller.classList.add('is-dragging'); }
      scroller.scrollLeft = drag.left - dx; scroller.scrollTop = drag.top - dy;
    });
    window.addEventListener('pointerup', () => { if (drag?.moved) scroller.dataset.justDragged = '1'; drag = null; scroller.classList.remove('is-dragging'); setTimeout(() => { delete scroller.dataset.justDragged; }, 0); });
    window.addEventListener('resize', () => applyZoom());
  }

  // ---------- details sheet ----------
  async function openSheet() {
    const trip = state.trip; if (!trip) return;
    const monthly = trip.duration === 'MONTHLY';
    const bobtail = trip.categoryCode === 'BOBTAIL';
    $('#companyOpt').textContent = monthly ? 'required' : 'optional';
    $('#trailerRow').hidden = bobtail;
    if (bobtail) $('#trailerNumber').value = '';
    const saved = store.get(STORE_DRIVER, null);
    if (saved) for (const field of DRIVER_FIELDS) { const input = $(`#${field}`); if (input && !input.value && saved[field]) input.value = saved[field]; }
    $('#sheetTitle').textContent = `Reserve space ${state.selected}`;
    $('#sheetSummary').innerHTML = loadingHtml('Getting your price…');
    showError($('#bookingError'), '');
    $('#sheet').hidden = false;
    document.body.classList.add('sheet-open');
    $('#firstName').focus({ preventScroll: true });
    try {
      const quote = await quoteSelection();
      const when = monthly ? `From ${C.formatLocal(trip.arrivalLocal)} · open-ended` : `${C.formatLocal(trip.arrivalLocal)} → ${C.formatLocal(trip.departureLocal)}`;
      $('#sheetSummary').innerHTML = `<div class="summary-top"><div><b>${esc(CATEGORY_NAMES[trip.categoryCode])} · ${esc(C.TERMS[trip.duration].label)} · Space ${esc(state.selected)}</b><span>${esc(when)}</span></div></div>${priceLines(quote)}${payNote(trip.duration)}`;
    } catch (error) {
      if (TAKEN_CODES.includes(error.code)) { closeSheet(); toast(C.friendlyError(error)); dropPick(); loadMap(); return; }
      $('#sheetSummary').innerHTML = `<p class="error">${esc(C.friendlyError(error))}</p>`;
    }
  }
  function closeSheet() { $('#sheet').hidden = true; document.body.classList.remove('sheet-open'); }

  function readDetails() {
    const data = new FormData($('#bookingForm'));
    const values = {};
    for (const field of [...DRIVER_FIELDS, 'specialInstructions']) values[field] = String(data.get(field) || '').trim();
    values.licensePlate = values.licensePlate.toUpperCase();
    values.licensePlateState = values.licensePlateState.toUpperCase();
    values.termsAccepted = data.get('termsAccepted') === 'on';
    values.remember = data.get('remember') === 'on';
    return values;
  }
  function showFieldErrors(errors) {
    $$('#bookingForm .field-error').forEach(el => el.remove());
    $$('#bookingForm [aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
    let first = null;
    for (const [field, message] of Object.entries(errors)) {
      const input = $(`#${field}`); if (!input) continue;
      input.setAttribute('aria-invalid', 'true');
      const note = document.createElement('p');
      note.className = 'field-error'; note.id = `${field}-error`; note.textContent = message;
      input.setAttribute('aria-describedby', note.id);
      (input.closest('.field') || input.closest('.check')).after(note);
      first = first || input;
    }
    first?.focus();
  }
  async function onBookingSubmit(event) {
    event.preventDefault();
    if (state.submitting || !state.trip) return;
    const trip = state.trip;
    const monthly = trip.duration === 'MONTHLY';
    const values = readDetails();
    const errors = C.validateDetails(values, { monthly, bobtail: trip.categoryCode === 'BOBTAIL' });
    showError($('#bookingError'), '');
    showFieldErrors(errors);
    if (Object.keys(errors).length) return;
    state.submitting = true;
    const button = $('#confirmButton');
    setBusy(button, true, 'Confirming…');
    const key = newKey();
    try {
      let booking;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const quote = await quoteSelection();
        const payload = {
          ...trip,
          ...Object.fromEntries(DRIVER_FIELDS.map(field => [field, values[field]])),
          specialInstructions: values.specialInstructions,
          selectedSpotId: state.spotIds.get(state.selected),
          quoteToken: quote.token,
          termsVersion: quote.termsVersion || quote.terms?.version,
          termsAccepted: true,
          cancellationTermsAccepted: true
        };
        try { booking = (await api('/bookings', payload, { idempotencyKey: attempt ? `${key}-r` : key })).booking; break; }
        catch (error) {
          if (attempt === 0 && C.RETRY_QUOTE_CODES.has(error.code)) { state.quote = null; state.quoteFor = ''; continue; }
          throw error;
        }
      }
      if (values.remember) {
        remember(booking, booking.lookupCredential);
        store.set(STORE_DRIVER, Object.fromEntries(DRIVER_FIELDS.map(field => [field, values[field]])));
      }
      state.current = { booking, credential: booking.lookupCredential };
      state.justBooked = booking.reservationNumber;
      closeSheet();
      $('#termsAccepted').checked = false; $('#specialInstructions').value = '';
      state.selected = null; state.quote = null; state.quoteFor = ''; state.holdToken = null; // the hold became the booking
      window.location.hash = C.manageHash(booking.reservationNumber, booking.lookupCredential);
    } catch (error) {
      if (TAKEN_CODES.includes(error.code)) { closeSheet(); toast(C.friendlyError(error)); dropPick(); loadMap(); }
      else showError($('#bookingError'), C.friendlyError(error));
    } finally { state.submitting = false; setBusy(button, false); }
  }

  // ---------- reservation ----------
  function whereToPark(booking) {
    if (booking.assignedSpotLabel) return `Space ${booking.assignedSpotLabel}`;
    if (booking.selectedMonthlyPosition?.number) return `Space ${booking.selectedMonthlyPosition.number}`;
    return booking.parkingArea?.name ? `${booking.parkingArea.name} area` : 'Ask at the office';
  }
  function icsFor(booking) {
    const stamp = iso => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const end = booking.departure || new Date(new Date(booking.arrival).getTime() + 3600000).toISOString();
    const line = text => String(text || '').replace(/[\\;,]/g, ch => `\\${ch}`).replace(/\n/g, '\\n');
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Trucker Heaven//Parking//EN', 'BEGIN:VEVENT',
      `UID:${booking.reservationNumber}@parking.truckerheaven.com`, `DTSTAMP:${stamp(new Date().toISOString())}`,
      `DTSTART:${stamp(booking.arrival)}`, `DTEND:${stamp(end)}`,
      `SUMMARY:${line(`Trucker Heaven parking ${booking.reservationNumber}`)}`,
      `LOCATION:${line(booking.address || state.lot?.address)}`,
      `DESCRIPTION:${line(`${whereToPark(booking)}. ${booking.paymentInstructions || ''} Office: ${phoneText()}`)}`,
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  }
  function bookingMapStates(booking) {
    const states = new Map();
    const label = booking.assignedSpotLabel || booking.selectedMonthlyPosition?.number;
    if (label) return { states, selected: String(label) };
    const category = booking.category === 'Bobtail' ? 'BOBTAIL' : 'TRACTOR_TRAILER';
    for (const element of booking.map?.elements || []) {
      const space = element.space;
      if (element.elementType !== 'PARKING_SPOT' || !space?.number || element.inventory?.categoryCode !== category) continue;
      if (space.parkingPurpose !== 'CUSTOMER' || !space.publicBookable) continue;
      if (booking.parkingProduct === 'DAILY' && !space.dailyEligible) continue;
      states.set(String(space.number), 'area');
    }
    return { states, selected: null };
  }

  async function showReservation(params) {
    const body = $('#reservationBody');
    const cached = state.current && state.current.booking.reservationNumber === params.reservationNumber && state.current.credential === params.credential;
    if (!cached) {
      body.innerHTML = loadingHtml('Loading your reservation…');
      try {
        const { booking } = await api('/bookings/lookup', { reservationNumber: params.reservationNumber, lookupCredential: params.credential });
        state.current = { booking, credential: params.credential };
      } catch (error) {
        body.innerHTML = `<div class="card"><h2>Reservation not found</h2><p class="muted">${esc(C.friendlyError(error))}</p><div class="btn-row"><a class="btn primary" href="#find">Try again</a><a class="btn ghost" href="${esc(phoneHref())}">Call the office</a></div></div>`;
        return;
      }
    }
    renderReservation();
  }
  function renderReservation() {
    const { booking, credential } = state.current;
    const fresh = state.justBooked === booking.reservationNumber;
    const monthly = booking.parkingProduct === 'MONTHLY';
    const status = booking.status;
    const active = ['CONFIRMED', 'PENDING', 'CHECKED_IN'].includes(status);
    const tz = booking.timezone || state.timezone;
    const price = booking.price || {};
    const link = `${window.location.origin}${window.location.pathname}${C.manageHash(booking.reservationNumber, credential)}`;
    const amount = price.totalCents != null ? C.money(price.totalCents) : '';
    const recurring = price.recurringUnitRateCents ?? (monthly ? price.unitRateCents : null);
    const payLine = monthly
      ? `${amount ? `${amount} for the first month when you arrive. ` : ''}${recurring ? `Then ${C.money(recurring)} on the 1st of each month.` : ''}`
      : `${amount ? `${amount} ` : ''}when you leave.`;
    const vehicle = [booking.licensePlate && `${booking.licensePlate}${booking.licensePlateState ? ` (${booking.licensePlateState})` : ''}`, booking.tractorUnitNumber && `Unit ${booking.tractorUnitNumber}`, booking.trailerNumber && `Trailer ${booking.trailerNumber}`].filter(Boolean).join(' · ');
    const map = bookingMapStates(booking);
    const head = fresh && status === 'CONFIRMED'
      ? `<p class="kicker">Confirmed</p><h1 class="page-title">You're booked.</h1><p class="lead">Your confirmation is on its way by text and email.</p>`
      : fresh && status === 'PENDING'
        ? `<p class="kicker">Request received</p><h1 class="page-title">Almost there.</h1><p class="lead">The office will confirm it shortly and text you.</p>`
        : `<p class="kicker">Reservation</p><h1 class="page-title">${esc(booking.reservationNumber)}</h1>`;
    $('#reservationBody').innerHTML = `
      ${head}
      <div class="res-grid">
        <div class="card ticket">
          <div class="ticket-top"><div><span class="label">Reservation number</span><strong class="resnum">${esc(booking.reservationNumber)}</strong></div><span class="status s-${esc(status.toLowerCase())}">${esc(C.statusLabel(status))}</span></div>
          <div class="where"><span class="label">Where you park</span><strong>${esc(whereToPark(booking))}</strong>${active && booking.arrivalDirections ? `<p class="muted small">${esc(booking.arrivalDirections)}</p>` : ''}</div>
          <dl class="facts">
            <div><dt>Vehicle</dt><dd>${esc(booking.category || '')}</dd></div>
            <div><dt>Parking</dt><dd>${esc(C.TERMS[booking.parkingProduct]?.label || booking.parkingProduct)}</dd></div>
            <div><dt>${monthly ? 'Starts' : 'Arrive'}</dt><dd>${esc(C.formatInstant(booking.arrival, tz))}</dd></div>
            <div><dt>${monthly ? 'Ends' : 'Leave'}</dt><dd>${monthly ? 'Open-ended' : esc(C.formatInstant(booking.departure, tz))}</dd></div>
            ${vehicle ? `<div class="wide"><dt>Truck</dt><dd>${esc(vehicle)}</dd></div>` : ''}
            ${booking.companyName ? `<div class="wide"><dt>Company</dt><dd>${esc(booking.companyName)}</dd></div>` : ''}
          </dl>
          ${active ? `<p class="pay-note"><b>Pay at the office.</b> ${esc(payLine)}</p>` : ''}
          <div class="code-row"><div><span class="label">Access code</span><code>${esc(credential)}</code><small>Keep this to view or cancel online.</small></div><button type="button" class="btn ghost small" data-copy="${esc(credential)}" data-copy-done="Access code copied">Copy</button></div>
          ${booking.actions?.canCheckIn || booking.actions?.canCheckOut ? `<div class="btn-row">${booking.actions.canCheckIn ? '<button type="button" class="btn primary" data-check-in>I\'ve arrived</button>' : ''}${booking.actions.canCheckOut ? '<button type="button" class="btn primary" data-check-out>I\'ve left the lot</button>' : ''}</div>` : ''}
          ${active ? `<div class="btn-row"><a class="btn primary" href="${esc(directionsUrl())}" target="_blank" rel="noopener">Directions</a><a class="btn ghost" href="${esc(phoneHref())}">Call the office</a><button type="button" class="btn ghost" data-ics>Add to calendar</button></div>` : ''}
          <div class="btn-row quiet">
            <button type="button" class="link" data-copy="${esc(link)}" data-copy-done="Link copied">Copy reservation link</button>
            <button type="button" class="link" data-print>Print pass</button>
            ${isRemembered(booking.reservationNumber) ? `<button type="button" class="link" data-forget="${esc(booking.reservationNumber)}">Remove from this device</button>` : '<button type="button" class="link" data-remember>Save on this device</button>'}
            <a class="link" href="#book">Book another</a>
          </div>
          ${booking.actions?.canCancel && active ? `<div class="cancel-box"><button type="button" class="link danger" data-cancel-open>Cancel this reservation</button>
            <div class="cancel-confirm" hidden>${(state.lot?.terms?.cancellation?.content || []).map(line => `<p class="muted small">${esc(line)}</p>`).join('')}<p>${booking.actions?.cutoff ? `Online cancellation closes ${esc(C.formatInstant(booking.actions.cutoff, tz))}.` : ''} Cancel it?</p>
            <select id="cancelReason" aria-label="Reason"><option>Plans changed</option><option>Found parking elsewhere</option><option>Load or route changed</option><option>Other</option></select>
            <p class="error" id="cancelError" role="alert" hidden></p>
            <div class="btn-row"><button type="button" class="btn danger" data-cancel-confirm>Yes, cancel</button><button type="button" class="btn ghost" data-cancel-close>Keep it</button></div></div></div>` : ''}
        </div>
        ${active ? `<div class="stack">
          <div class="card res-map"><span class="label">${map.selected ? `Space ${esc(map.selected)} on the lot` : 'Your parking area'}</span>${Plan.render(PLAN, { states: map.states, selected: map.selected, title: map.selected ? `Lot map showing space ${map.selected}` : 'Lot map with your parking area' })}</div>
          ${['CONFIRMED', 'CHECKED_IN'].includes(status) ? documentsCard() : ''}
        </div>` : ''}
      </div>`;
    $('#main').focus({ preventScroll: true });
    if ($('#docsList')) loadDocumentStatus();
  }

  // ---------- documents on the reservation page ----------
  const DOC_PATHS = { DRIVER_LICENSE: 'driver-license', INSURANCE: 'insurance' };
  function documentsCard() {
    return `<div class="card"><span class="label">Documents</span><p class="muted small">Optional. Add them now to save time at the office.</p>
      <ul class="saved account-list" id="docsList">${Object.entries(account.DOC_TYPES).map(([type, label]) => `<li><div><b>${esc(label)}</b><span data-doc-status="${type}">Checking…</span></div>
        <label class="btn ghost small file-btn">Upload<input type="file" data-doc-upload="${type}" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"></label></li>`).join('')}</ul></div>`;
  }
  async function loadDocumentStatus() {
    const { booking, credential } = state.current;
    try {
      const { documents } = await api(`/bookings/${encodeURIComponent(booking.publicToken)}/documents/status`, { lookupCredential: credential });
      for (const type of Object.keys(DOC_PATHS)) {
        const el = $(`[data-doc-status="${type}"]`);
        if (el) el.textContent = account.docStatus(documents.find(item => item.type === type)?.status);
      }
    } catch (_) { $$('[data-doc-status]').forEach(el => { el.textContent = ''; }); }
  }
  async function uploadReservationDocument(input) {
    const file = input.files?.[0]; const type = input.dataset.docUpload;
    if (!file) return;
    const { booking, credential } = state.current;
    const token = encodeURIComponent(booking.publicToken);
    const statusEl = $(`[data-doc-status="${type}"]`);
    input.disabled = true;
    try {
      await account.sendDocument(file, {
        start: details => api(`/bookings/${token}/documents/${DOC_PATHS[type]}/upload`, { ...details, lookupCredential: credential }),
        complete: uploadToken => api(`/bookings/${token}/documents/complete`, { lookupCredential: credential, uploadToken })
      }, progress => { statusEl.textContent = `Uploading ${progress}%`; });
      toast(`${account.DOC_TYPES[type]} received`);
    } catch (error) { toast(error.message || C.friendlyError(error)); }
    input.disabled = false; input.value = '';
    loadDocumentStatus();
  }
  async function selfService(button, action) {
    const { booking, credential } = state.current;
    setBusy(button, true, 'One moment…');
    try {
      const response = await api(`/bookings/${encodeURIComponent(booking.publicToken)}/${action}`, { lookupCredential: credential });
      state.current = { booking: response.booking, credential }; state.justBooked = null;
      renderReservation(); toast(action === 'check-in' ? 'Checked in. Welcome!' : 'Checked out. Safe travels!');
    } catch (error) { setBusy(button, false); toast(C.friendlyError(error)); }
  }
  async function cancelReservation(button) {
    const { booking, credential } = state.current;
    setBusy(button, true, 'Cancelling…');
    try {
      const response = await api(`/bookings/${encodeURIComponent(booking.publicToken)}/cancel`, { lookupCredential: credential, reason: $('#cancelReason').value });
      state.current = { booking: response.booking, credential }; state.justBooked = null;
      renderReservation(); toast('Reservation cancelled');
    } catch (error) { setBusy(button, false); showError($('#cancelError'), C.friendlyError(error)); }
  }

  // ---------- find ----------
  function renderRemembered() {
    const list = remembered();
    $('#savedCard').hidden = !list.length;
    $('#savedList').innerHTML = list.map(item => `<li><a href="${esc(C.manageHash(item.n, item.c))}"><b>${esc(item.n)}</b><span>${esc([C.TERMS[item.term]?.label, item.arrival ? C.formatInstantDate(item.arrival, state.timezone) : '', item.where].filter(Boolean).join(' · '))}</span></a>
      <span class="status" data-saved-status="${esc(item.n)}" hidden></span><button type="button" class="link" data-forget="${esc(item.n)}" aria-label="Remove ${esc(item.n)} from this device">Remove</button></li>`).join('');
    // Show each saved reservation's current status (cancelled, parked, …).
    for (const item of list) {
      api('/bookings/lookup', { reservationNumber: item.n, lookupCredential: item.c }).then(({ booking }) => {
        const el = $(`[data-saved-status="${CSS.escape(item.n)}"]`);
        if (!el) return;
        el.textContent = C.statusLabel(booking.status); el.className = `status s-${booking.status.toLowerCase()}`; el.hidden = false;
      }).catch(() => {});
    }
  }
  async function onLookupSubmit(event) {
    event.preventDefault();
    const reservationNumber = C.normalizeReservationNumber($('#lookupNumber').value);
    const credential = $('#lookupCode').value.trim();
    if (!reservationNumber || !credential) { showError($('#lookupError'), 'Enter both your reservation number and access code.'); return; }
    showError($('#lookupError'), '');
    const button = $('#lookupForm button[type="submit"]');
    setBusy(button, true, 'Looking…');
    try {
      const { booking } = await api('/bookings/lookup', { reservationNumber, lookupCredential: credential });
      state.current = { booking, credential }; state.justBooked = null;
      $('#lookupForm').reset();
      window.location.hash = C.manageHash(reservationNumber, credential);
    } catch (error) { showError($('#lookupError'), C.friendlyError(error)); }
    finally { setBusy(button, false); }
  }

  // ---------- routing ----------
  function route() {
    const hash = window.location.hash;
    const manage = C.parseManageHash(hash);
    const view = manage ? 'reservation' : ({ '#find': 'find', '#my-parking': 'my-parking', '#upload': 'upload' })[hash] || 'book';
    $$('.view').forEach(el => { el.hidden = el.dataset.view !== view; });
    $$('[data-nav]').forEach(link => link.classList.toggle('is-active', link.dataset.nav === (view === 'book' ? 'book' : 'find')));
    if (view !== 'book') closeSheet();
    if (view === 'find') renderRemembered();
    if (view === 'reservation') showReservation(manage);
    if (view === 'my-parking') account.renderMyParking();
    if (view === 'upload') account.renderUpload();
    if (view === 'book') requestAnimationFrame(() => { if (!state.zoomSet) { state.zoom = startZoom(); state.zoomSet = true; } applyZoom(); $('#mapScroll').scrollTop = 0; });
    renderMobileBar();
    window.scrollTo(0, 0);
    document.title = ({ book: 'Truck Parking in Mt. Juliet, TN', find: 'My reservation', 'my-parking': 'My Parking', upload: 'Upload a document', reservation: 'Your reservation' })[view] + (view === 'book' ? ' | Trucker Heaven' : ' | Trucker Heaven Parking');
  }

  // ---------- events ----------
  function bind() {
    $$('[data-phone-link]').forEach(el => { el.href = phoneHref(); });
    $$('[data-phone-text]').forEach(el => { el.textContent = phoneText(); });
    const parent = cfg.parentSiteUrl || 'https://truckerheaven.com';
    $('#parentSiteLink').href = parent;
    $('#parentSiteLink').textContent = parent.replace(/^https?:\/\//, '').replace(/\/$/, '');

    $('#tripForm').addEventListener('change', onTripChange);
    $('#tripForm').addEventListener('input', event => { if (event.target.type !== 'radio') onTripChange(event); });
    $('#tripForm').addEventListener('submit', event => event.preventDefault());
    $('#bookingForm').addEventListener('submit', onBookingSubmit);
    $('#bookingForm').addEventListener('input', event => {
      if (event.target.getAttribute('aria-invalid')) { event.target.removeAttribute('aria-invalid'); document.getElementById(`${event.target.id}-error`)?.remove(); }
    });
    $('#lookupForm').addEventListener('submit', onLookupSubmit);
    $('#sheet').addEventListener('click', event => { if (event.target.id === 'sheet') closeSheet(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
    bindPan();

    document.addEventListener('click', event => {
      const space = event.target.closest('[data-space]');
      if (space && !$('#mapScroll').dataset.justDragged) { selectSpace(space.dataset.space); return; }
      const target = event.target.closest('button, a');
      if (!target) return;
      if (target.matches('[data-account-tab], [data-account-signout], [data-upload-again]')) { account.onClick(target); return; }
      if (target.hasAttribute('data-reserve')) { openSheet(); return; }
      if (target.hasAttribute('data-close-sheet')) { closeSheet(); return; }
      if (target.hasAttribute('data-clear-pick')) { dropPick(); renderAll(); return; }
      if (target.dataset.zoom !== undefined) {
        const step = Number(target.dataset.zoom);
        state.zoom = step === 0 ? 1 : Math.min(5, Math.max(1, state.zoom * (step > 0 ? 1.5 : 1 / 1.5)));
        applyZoom(step > 0 ? state.selected : null); return;
      }
      if (target.dataset.copy) { copy(target.dataset.copy, target.dataset.copyDone); return; }
      if (target.hasAttribute('data-ics') && state.current) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([icsFor(state.current.booking)], { type: 'text/calendar' }));
        a.download = `${state.current.booking.reservationNumber}.ics`;
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        return;
      }
      if (target.hasAttribute('data-remember') && state.current) { remember(state.current.booking, state.current.credential); renderReservation(); toast('Saved on this device'); return; }
      if (target.dataset.forget) { forget(target.dataset.forget); if (state.current && !$('[data-view="reservation"]').hidden) renderReservation(); else renderRemembered(); toast('Removed from this device'); return; }
      if (target.hasAttribute('data-forget-all')) { store.set(STORE_RESERVATIONS, []); renderRemembered(); toast('Cleared from this device'); return; }
      if (target.hasAttribute('data-print')) { window.print(); return; }
      if (target.hasAttribute('data-retry-lot')) { loadLot(); return; }
      if (target.hasAttribute('data-check-in')) { selfService(target, 'check-in'); return; }
      if (target.hasAttribute('data-check-out')) { selfService(target, 'check-out'); return; }
      if (target.hasAttribute('data-cancel-open')) { target.hidden = true; $('.cancel-confirm').hidden = false; return; }
      if (target.hasAttribute('data-cancel-close')) { $('.cancel-confirm').hidden = true; $('[data-cancel-open]').hidden = false; return; }
      if (target.hasAttribute('data-cancel-confirm')) cancelReservation(target);
    });
    document.addEventListener('submit', account.onSubmit);
    document.addEventListener('change', event => {
      if (event.target.matches('[data-doc-upload]')) uploadReservationDocument(event.target);
      else if (event.target.closest('[data-view="upload"]')) account.onChange(event);
    });
    window.addEventListener('hashchange', route);
  }

  bind();
  setInterval(tickHold, 1000);
  setDefaultDates();
  renderAll();
  route();
  loadLot();
})();
