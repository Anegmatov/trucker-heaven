(() => {
  'use strict';

  const config = window.PARKING_CONFIG;
  const core = window.ParkingCustomerCore;
  const lifecycle = window.ParkingLifecycle;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const durationNames = { DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly' };
  const durationName = value => durationNames[core.supportedDuration(value)] || 'Parking period unavailable';
  const assignmentMode = value => String(value?.assignmentMode || '').toUpperCase();
  const exactMode = value => ['EXACT_SPOT','CUSTOMER_SELECTED_SPOT'].includes(assignmentMode(value));
  const monthlySelectedMode = value => assignmentMode(value) === 'CUSTOMER_SELECTED_SPOT';
  const parkingAreaName = value => value?.parkingArea?.name || value?.category || core.categoryMetadata(value?.categoryCode)?.label || 'Parking Area';
  const state = {
    canonicalLot: null, canonicalStatus: 'LOADING', canonicalError: '', supportPhone: config.supportPhone, supportPhoneDisplay: config.supportPhoneDisplay,
    selectedCategoryCode: '', selectedDuration: '', trip: null, availability: [], selected: null,
    search: { status: core.SEARCH_STATUS.IDLE, fingerprint: '', error: '' },
    quote: { status: core.QUOTE_STATUS.IDLE, tripFingerprint: '', offerKey: '', data: null, error: '' },
    monthly: { status: 'IDLE', layout: null, positions: [], error: '' }, selectedMonthlySpot: null,
    submission: { status: core.SUBMISSION_STATUS.IDLE, error: '' },
    availabilityController: null, quoteController: null, quoteExpiryTimer: null, holdCountdownTimer: null, bookingKey: null,
    currentRoute: 'parking', currentStep: 1, initialized: false, routeRenderId: 0,
    activeBooking: null, activeCredential: '', activeContact: '', bookingRecovery: '', bookingCached: false,
    sessionEntries: [], rememberedEntries: [], recentReservations: [], refreshStates: new Map(),
    assignmentPoller: null, pollingExhausted: false, lastCheckedAt: null, pollingMessage: '', confirmationSignature: '', confirmationActionSignature: '',
    mapZoom: 1, dialogTrigger: null, mutationPending: false, paymentReturnRunning: false,
    reservationGate: core.createOperationGate(), searchGeneration: 0, paymentConfiguration: null,
    accountStatus: 'UNKNOWN', accountData: null, accountCsrf: '', accountGrantDocumentType: null, accountIdentity: null,
    accountTab: 'current', accountMessage: '',
    demoPayment: { token: '', authorization: null, loading: false, completed: false, error: '' },
    documentUpload: { type: '', reservationNumber: '', file: null, progress: 0, status: 'IDLE', message: '', successType: '' }
  };

  function setMessage(element, message = '', error = false) {
    if (!element) return;
    element.textContent = message;
    element.className = `message${error ? ' error' : ''}`;
    if (error) element.setAttribute('role', 'alert'); else element.removeAttribute('role');
  }
  function phoneValues(raw = state.supportPhone) {
    const phone = String(raw || '').trim(); const href = phone.replace(/[^\d+]/g, '');
    const digits = href.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    const display = digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : (phone || 'Parking support');
    return { href: href ? `tel:${href}` : '', display };
  }
  function publicPhone(booking) { return phoneValues(booking?.supportPhone || state.supportPhone).display; }
  function supportHref(booking) { return phoneValues(booking?.supportPhone || state.supportPhone).href; }
  function supportLink(className = 'text-link', label = 'Call parking support') {
    const href = supportHref(); return href ? `<a class="${className}" href="${escapeHtml(href)}">${escapeHtml(label)} ${escapeHtml(publicPhone())}</a>` : '<span>Parking support contact is unavailable.</span>';
  }
  function updateSupportLinks() {
    ['#supportPhoneLink', '#mobileSupportLink', '#heroSupportLink', '#footerSupportLink'].forEach(selector => {
      const link = $(selector); if (!link) return;
      const values = phoneValues(); link.href = values.href; link.hidden = !values.href;
      link.textContent = selector === '#heroSupportLink' ? `Call office ${values.display}` : selector === '#footerSupportLink' ? `Parking support ${values.display}` : selector === '#supportPhoneLink' || selector === '#mobileSupportLink' ? 'Call Now' : 'Contact';
    });
    ['#parentSiteLink', '#mobileParentLink', '#footerParentLink'].forEach(selector => { const link = $(selector); if (link) { link.href = config.parentSiteUrl || '#'; link.hidden = !config.parentSiteUrl; } });
    // Main-site header: links to the big Trucker Heaven website pages.
    $$('[data-parent-page]').forEach(link => { link.href = parentPageUrl(link.dataset.parentPage); });
  }
  function parentPageUrl(page) {
    if (!config.parentSiteUrl) return '#';
    try { return new URL(page, config.parentSiteUrl.replace(/\/?$/, '/')).href; } catch (_) { return '#'; }
  }
  function setupMainSiteHeader() {
    const year = $('#footerYear'); if (year) year.textContent = String(new Date().getFullYear());
    const toggle = $('[data-th-menu-toggle]'); const panel = $('[data-th-mobile-panel]');
    const closeMenu = () => { document.body.classList.remove('th-menu-open'); toggle?.setAttribute('aria-expanded', 'false'); if (panel && 'hidden' in panel) panel.hidden = true; };
    const syncPanel = () => { if (panel && 'hidden' in panel) panel.hidden = !document.body.classList.contains('th-menu-open'); };
    toggle?.addEventListener('click', () => { const open = !document.body.classList.contains('th-menu-open'); document.body.classList.toggle('th-menu-open', open); toggle.setAttribute('aria-expanded', String(open)); syncPanel(); });
    panel?.addEventListener('click', event => { if (event.target === panel || event.target.closest('a')) closeMenu(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
    $('#thServiceSelect')?.addEventListener('change', event => {
      const value = event.target.value; if (!value) return;
      event.target.value = '';
      if (value.startsWith('#')) { navigate(value.slice(1)); return; }
      const href = parentPageUrl(value); if (href !== '#') window.location.href = href;
    });
  }

  function requestErrorMessage(kind, context = 'request') {
    const messages = {
      timeout: `The parking service took too long to complete this ${context}. Please try again.`,
      network: 'Unable to reach the parking service. Check your connection and try again.',
      authorization: 'The secure lookup details are no longer valid.',
      not_found: 'The reservation could not be found with those secure details.',
      conflict: context === 'quote' ? 'This quote is no longer valid. Request a current price.' : 'The reservation changed. Refresh and try again.',
      validation: 'Review the information entered and try again.', server: 'The parking service is temporarily unavailable. Please try again.',
      unknown: 'The request could not be completed. Please try again.'
    };
    return messages[kind] || messages.unknown;
  }
  async function request(path, options = {}) {
    if (!config.apiBase) { const error = new Error('Customer API configuration is unavailable for this host.'); error.code = 'CONFIGURATION'; throw error; }
    const controller = new AbortController(); const timeoutMs = options.timeoutMs || (options.method && options.method !== 'GET' ? 15000 : 15000);
    let timedOut = false; let timer;
    const abortFromCaller = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) controller.abort(options.signal.reason); else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetch(`${config.apiBase}${path}`, {
        ...options, signal: controller.signal, credentials: 'include',
        headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { const error = new Error(data.error?.message || 'Parking request failed.'); error.code = data.error?.code; error.status = response.status; error.publicMessage = data.error?.message; throw error; }
      return data;
    } catch (error) {
      if (timedOut) { const timeout = new Error('Request timed out.'); timeout.code = 'REQUEST_TIMEOUT'; throw timeout; }
      if (error?.name === 'AbortError') throw error;
      if (!error?.status && !error?.code) error.code = 'NETWORK';
      throw error;
    } finally { window.clearTimeout(timer); options.signal?.removeEventListener('abort', abortFromCaller); }
  }

  async function accountRequest(path, options = {}) {
    if (!config.accountApiBase) { const error = new Error('My Parking is unavailable for this host.'); error.code = 'CONFIGURATION'; throw error; }
    const response = await fetch(`${config.accountApiBase}${path}`, {
      ...options,
      credentials: 'include',
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
    });
    const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error?.message || 'My Parking request failed.');
      error.code = data.error?.code; error.status = response.status; error.publicMessage = data.error?.message;
      throw error;
    }
    return data;
  }

  async function lookupMutation(path, options = {}) {
    if (!state.accountCsrf) { const error = new Error('Your parking lookup has expired. Enter your reservation information again.'); error.status = 401; throw error; }
    return accountRequest(`/lookup${path}`, { ...options, headers: { ...(options.headers || {}), 'X-CSRF-Token': state.accountCsrf } });
  }

  async function loadPaymentConfiguration() {
    const paymentConfiguration = await request('/payments/configuration');
    state.paymentConfiguration = paymentConfiguration;
    return paymentConfiguration;
  }

  function assertPaymentConfiguration(paymentConfiguration) {
    if (!paymentConfiguration?.checkoutConfigured) {
      const error = new Error('Secure online checkout is temporarily unavailable. No card information was collected and no payment was processed.');
      error.code = 'PAYMENTS_NOT_CONFIGURED';
      throw error;
    }
  }

  function paymentSetupErrorMessage(error) {
    if (error?.code === 'DOCUMENT_STORAGE_NOT_CONFIGURED') {
      return 'Secure document upload is temporarily unavailable. Remove the optional document and continue to payment, or upload it later.';
    }
    if (['PAYMENTS_NOT_CONFIGURED', 'STRIPE_WEBHOOK_NOT_CONFIGURED', 'PAYMENT_RETURN_URL_NOT_CONFIGURED'].includes(error?.code)) {
      return 'Secure online checkout is temporarily unavailable. No card information was collected and no payment was processed.';
    }
    if (['QUOTE_EXPIRED', 'PAYMENT_HOLD_EXPIRED'].includes(error?.code)) {
      return 'The current price or parking hold expired before checkout. No payment was processed; choose current availability and try again.';
    }
    if (['NETWORK', 'REQUEST_TIMEOUT'].includes(error?.code)) {
      return 'Secure checkout could not be reached. No card information was collected and no parking payment was confirmed. Please try again.';
    }
    return error?.publicMessage || requestErrorMessage(core.classifyError(error), 'payment setup');
  }

  function readJson(storage, key) { try { return JSON.parse(storage.getItem(key) || '[]'); } catch (_) { return []; } }
  function writeJson(storage, key, value) { try { storage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; } }
  function refreshCombinedEntries() {
    state.sessionEntries = lifecycle.sanitizeRecent(state.sessionEntries, Date.now(), 'session');
    state.rememberedEntries = lifecycle.sanitizeRecent(state.rememberedEntries, Date.now(), 'remembered');
    state.recentReservations = lifecycle.mergeStores(state.sessionEntries, state.rememberedEntries);
    writeJson(window.sessionStorage, lifecycle.SESSION_STORAGE_KEY, state.sessionEntries);
    writeJson(window.localStorage, lifecycle.REMEMBERED_STORAGE_KEY, state.rememberedEntries);
    updateReturningCustomerActions(); return state.recentReservations;
  }
  function loadRecentReservations() {
    state.sessionEntries = lifecycle.sanitizeRecent(readJson(window.sessionStorage, lifecycle.SESSION_STORAGE_KEY), Date.now(), 'session');
    state.rememberedEntries = lifecycle.sanitizeRecent(readJson(window.localStorage, lifecycle.REMEMBERED_STORAGE_KEY), Date.now(), 'remembered');
    const legacy = lifecycle.sanitizeRecent(readJson(window.localStorage, lifecycle.LEGACY_RECENT_STORAGE_KEY), Date.now(), 'remembered');
    if (legacy.length) state.rememberedEntries = lifecycle.sanitizeRecent([...legacy, ...state.rememberedEntries], Date.now(), 'remembered');
    try { window.localStorage.removeItem(lifecycle.LEGACY_RECENT_STORAGE_KEY); window.localStorage.removeItem('trucker-heaven-parking.confirmation.v1'); } catch (_) { /* Storage can be restricted. */ }
    return refreshCombinedEntries();
  }
  function activeRecentEntry(reservationNumber = '') {
    let active = ''; try { active = window.sessionStorage.getItem(lifecycle.ACTIVE_RESERVATION_KEY) || ''; } catch (_) { active = ''; }
    return lifecycle.activeRecentEntry(state.recentReservations, reservationNumber, active);
  }
  function persistActiveReservation({ remember = null } = {}) {
    const booking = state.activeBooking; const credential = state.activeCredential;
    if (!booking?.reservationNumber || !credential) return false;
    const current = activeRecentEntry(booking.reservationNumber);
    const persistent = remember === null ? current?.source === 'remembered' : remember;
    const source = persistent ? 'remembered' : 'session';
    const entry = lifecycle.entryFromBooking(booking, credential, state.activeContact || current?.maskedContact || '', Date.now(), source);
    if (!entry) return false;
    if (persistent) {
      state.sessionEntries = lifecycle.removeRecent(state.sessionEntries, entry.reservationNumber);
      state.rememberedEntries = lifecycle.upsertRecent(state.rememberedEntries, entry, Date.now(), 'remembered');
    } else {
      state.rememberedEntries = lifecycle.removeRecent(state.rememberedEntries, entry.reservationNumber);
      state.sessionEntries = lifecycle.upsertRecent(state.sessionEntries, entry, Date.now(), 'session');
    }
    try { window.sessionStorage.setItem(lifecycle.ACTIVE_RESERVATION_KEY, entry.reservationNumber); } catch (_) { /* Active state remains in memory. */ }
    refreshCombinedEntries(); return true;
  }
  function removeRecentReservation(number) {
    const target = core.normalizeReservationNumber(number);
    state.sessionEntries = lifecycle.removeRecent(state.sessionEntries, target);
    state.rememberedEntries = lifecycle.removeRecent(state.rememberedEntries, target);
    if (state.activeBooking?.reservationNumber === target) {
      stopAssignmentPolling('removed'); state.activeBooking = null; state.activeCredential = ''; state.activeContact = ''; state.reservationGate.invalidate();
      try { window.sessionStorage.removeItem(lifecycle.ACTIVE_RESERVATION_KEY); } catch (_) { /* Ignore storage restrictions. */ }
    }
    refreshCombinedEntries();
  }
  function updateReturningCustomerActions() {
    const button = $('#continueRecentReservation'); if (!button) return;
    button.hidden = state.recentReservations.length === 0;
    if (!button.hidden) button.textContent = `Continue ${state.recentReservations[0].reservationNumber}`;
  }
  function updateActiveBooking(booking, credential = '', contact = '', { persist = true } = {}) {
    const transition = core.transitionReservationSession({ booking: state.activeBooking, credential: state.activeCredential, contact: state.activeContact }, booking, credential, contact);
    if (!transition.booking) return false;
    if (transition.changed) { stopAssignmentPolling('reservation-changed'); state.pollingExhausted = false; state.lastCheckedAt = null; state.pollingMessage = ''; state.confirmationSignature = ''; state.confirmationActionSignature = ''; }
    state.activeBooking = transition.booking; state.activeCredential = transition.credential; state.activeContact = transition.contact; state.bookingCached = false;
    if (persist && transition.credential) persistActiveReservation();
    return true;
  }
  async function fetchReservation(entry, signal) {
    if (!entry?.reservationNumber || !entry?.lookupCredential) throw new Error('Secure lookup details are not available.');
    const response = await request('/bookings/lookup', { method: 'POST', body: JSON.stringify({ reservationNumber: entry.reservationNumber, lookupCredential: entry.lookupCredential }), signal });
    const booking = core.validateBooking(response.booking); if (!booking) throw new Error('The parking service returned an invalid reservation.');
    if (booking.reservationNumber !== core.normalizeReservationNumber(entry.reservationNumber)) throw new Error('The parking service returned a different reservation.');
    return booking;
  }

  function accountDate(value, options = {}) {
    if (!value) return 'Not available';
    const date = new Date(value); if (Number.isNaN(date.getTime())) return 'Not available';
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...options }).format(date);
  }
  function accountStatusLabel(value) { return value === 'DEMO_BYPASSED' ? 'DEMO / NO PAYMENT' : String(value || 'Pending').replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, letter => letter.toUpperCase()); }
  function safeDocumentStatus(value) {
    const status = String(value || '').toUpperCase();
    if (status === 'REPLACEMENT_REQUESTED') return 'Replacement requested';
    if (status === 'RECEIVED') return 'Received';
    return 'Missing';
  }
  function accountOwedLine(item) {
    const owed = item.owed; const monthly = item.parkingProduct === 'MONTHLY';
    if (!owed) return '';
    if (['CANCELLED','EXPIRED','NO_SHOW'].includes(item.status)) return '';
    if (owed.balanceCents > 0) {
      const when = owed.dueDate ? accountDate(owed.dueDate) : '';
      const label = monthly ? (owed.overdue ? `Overdue since ${when}` : `Due ${when} at the office`) : 'Pay at the office when you leave';
      return `<div class="portal-owed${owed.overdue ? ' is-overdue' : ''}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(core.money(owed.balanceCents))}</strong></div>`;
    }
    if (owed.paidCents > 0) return `<div class="portal-owed is-paid"><span>Paid${monthly ? ' · next payment on the 1st' : ''}</span><strong>${escapeHtml(core.money(owed.paidCents))}</strong></div>`;
    return '';
  }
  function accountReservationCard(item) {
    const monthly = item.parkingProduct === 'MONTHLY';
    const title = `${durationName(item.parkingProduct)} Parking · ${item.vehicle?.classification === 'Bobtail' ? 'Bobtail' : 'Truck & trailer'}`;
    const place = item.space ? `Space ${item.space}` : (item.parkingArea || 'Parking Area');
    const uploadLink = type => ['CONFIRMED','CHECKED_IN'].includes(item.status) || new Date(item.startsAt).getTime() > Date.now()
      ? ` <button type="button" class="text-button" data-upload-for="${escapeHtml(item.reservationNumber)}" data-upload-type="${type}">${safeDocumentStatus(item.documents?.[type]?.status) === 'Missing' ? 'Upload' : 'Replace'}</button>` : '';
    return `<article class="portal-parking-card LiquidGlass GlassOffer ${monthly ? 'is-monthly' : 'is-daily'}">
      <div class="portal-card-heading"><div><p class="card-kicker">${escapeHtml(title)}</p><h3>${escapeHtml(place)}</h3></div><span class="portal-status">${escapeHtml(accountStatusLabel(['PAID','NOT_REQUIRED'].includes(item.paymentStatus) ? item.status : item.paymentStatus))}</span></div>
      <dl class="portal-facts"><div><dt>Dates</dt><dd>${escapeHtml(accountDate(item.startsAt))} &ndash; ${escapeHtml(monthly && !item.endsAt ? 'Ongoing (due on the 1st)' : accountDate(item.endsAt))}</dd></div><div><dt>Vehicle</dt><dd>${escapeHtml(item.vehicle?.unitNumber || 'Unit not listed')} &middot; ${escapeHtml(item.vehicle?.licensePlate || 'Plate not listed')}</dd></div><div><dt>Reservation</dt><dd>${escapeHtml(item.reservationNumber)}</dd></div><div><dt>Driver License</dt><dd>${escapeHtml(safeDocumentStatus(item.documents?.DRIVER_LICENSE?.status))}${uploadLink('DRIVER_LICENSE')}</dd></div><div><dt>Insurance</dt><dd>${escapeHtml(safeDocumentStatus(item.documents?.INSURANCE?.status))}${uploadLink('INSURANCE')}</dd></div></dl>
      ${accountOwedLine(item)}
    </article>`;
  }
  function accountEmpty(title, message) { return `<div class="portal-empty"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p></div>`; }
  function renderAccountLogin() {
    return `<div class="my-parking-auth"><section class="panel LiquidGlass GlassPanel portal-login-card"><p class="eyebrow">YOUR PARKING PASS</p><h1 id="myParkingTitle">My Parking</h1><p>Enter the information used for your reservation.</p>
      <form id="accountLoginForm" class="portal-auth-form GlassInput"><label>Email<input name="email" type="email" autocomplete="email" required value="${escapeHtml(state.accountIdentity?.email || '')}"></label><label>Mobile phone<input name="phone" type="tel" autocomplete="tel" required value="${escapeHtml(state.accountIdentity?.phone || '')}"></label><button class="button GlassButton primary-action" type="submit">Find my parking</button></form>
      <p class="privacy-note">Use the email and phone you booked with. Booked at the office without an email? Call ${escapeHtml(publicPhone())} and we'll add it.</p><p id="accountAuthMessage" class="message" aria-live="polite">${escapeHtml(state.accountMessage)}</p>
    </section></div>`;
  }
  function accountPayments() {
    const rows = state.accountData?.payments || [];
    return rows.length ? `<div class="portal-list">${rows.map(payment => `<article class="portal-list-row"><div><strong>${escapeHtml(`${durationName(payment.parkingProduct)} Parking`)}</strong><span>${escapeHtml(payment.reservationNumber)} · ${escapeHtml(accountDate(payment.paidAt || payment.createdAt))}</span></div><div><strong>${escapeHtml(core.money(payment.amountCents))}</strong><span>${escapeHtml(accountStatusLabel(payment.status))}</span></div></article>`).join('')}</div>` : accountEmpty('No payments yet', 'Safe parking payment statuses will appear here.');
  }
  function accountDocuments() {
    const reservations = state.accountData?.reservations || {};
    const rows = [...(reservations.current || []), ...(reservations.upcoming || []), ...(reservations.past || [])]
      .flatMap(item => ['DRIVER_LICENSE','INSURANCE'].map(type => ({ reservationNumber: item.reservationNumber, type, status: item.documents?.[type]?.status })));
    const list = rows.length ? `<div class="portal-list">${rows.map(document => `<article class="portal-list-row"><div><strong>${escapeHtml(document.type === 'DRIVER_LICENSE' ? 'Driver License' : 'Insurance')}</strong><span>${escapeHtml(document.reservationNumber)}</span></div><div><span class="safe-document-status${document.status === 'REPLACEMENT_REQUESTED' ? ' replacement' : ''}">${escapeHtml(safeDocumentStatus(document.status))}</span></div></article>`).join('')}</div>` : accountEmpty('No document statuses', 'Document status appears with an eligible parking reservation.');
    return `${list}<div class="portal-form-actions"><a class="button secondary-button" href="#upload-documents" data-route="upload-documents">Upload or replace a document</a></div><p class="privacy-note">For your protection, uploaded files cannot be viewed or downloaded from My Parking.</p>`;
  }
  function renderAccountPortal() {
    const data = state.accountData;
    const tabs = [['current','Current'],['upcoming','Upcoming'],['past','Past'],['payments','Payments'],['documents','Documents']];
    let body = '';
    if (state.accountTab === 'current') {
      const items = data?.reservations?.current || [];
      body = items.length ? `<div class="current-parking-list">${items.map(accountReservationCard).join('')}</div>` : accountEmpty('No current parking', 'Verified paid or confirmed in-person parking that is active now will appear here.');
    } else if (state.accountTab === 'upcoming') { const items = data?.reservations?.upcoming || []; body = items.length ? `<div class="current-parking-list">${items.map(accountReservationCard).join('')}</div>` : accountEmpty('No upcoming parking', 'Future paid or pending reservations will appear here.'); }
    else if (state.accountTab === 'past') { const items = data?.reservations?.past || []; body = items.length ? `<div class="current-parking-list compact">${items.map(accountReservationCard).join('')}</div>` : accountEmpty('No past parking', 'Completed, expired, and cancelled parking will appear here.'); }
    else if (state.accountTab === 'payments') body = accountPayments();
    else body = accountDocuments();
    return `<div class="my-parking-shell"><div class="view-page-head portal-head"><div><p class="eyebrow">TRUCKER HEAVEN PARKING</p><h1 id="myParkingTitle">My Parking</h1><p>Your reservations, passes and receipts.</p></div><div class="portal-head-actions"><a class="text-link" href="#parking" data-route="parking">Find Parking</a><button class="text-button" type="button" data-account-logout>Sign out</button></div></div><nav class="portal-tabs" aria-label="My Parking sections">${tabs.map(([key,label]) => `<button type="button" data-account-tab="${key}"${state.accountTab === key ? ' aria-current="page"' : ''}>${escapeHtml(label)}</button>`).join('')}</nav><section class="portal-section" aria-live="polite">${state.accountMessage ? `<p class="message" role="status">${escapeHtml(state.accountMessage)}</p>` : ''}<div class="portal-section-heading"><p class="card-kicker">${escapeHtml(tabs.find(([key]) => key === state.accountTab)?.[1] || 'My Parking')}</p><h2>${escapeHtml(state.accountTab === 'current' ? 'Current parking' : tabs.find(([key]) => key === state.accountTab)?.[1] || 'My Parking')}</h2></div>${body}</section></div>`;
  }
  function renderMyParking() {
    const content = $('#myParkingContent'); if (!content) return;
    if (state.accountStatus === 'LOADING') content.innerHTML = '<div class="portal-loading" role="status">Loading My Parking…</div>';
    else if (state.accountStatus === 'AUTHENTICATED') content.innerHTML = renderAccountPortal();
    else content.innerHTML = renderAccountLogin();
  }
  function documentTypeName(type = state.documentUpload.type) { return type === 'DRIVER_LICENSE' ? 'Driver License' : 'Insurance'; }
  function renderDocumentIdentity() {
    return `<section class="panel LiquidGlass GlassPanel document-upload-card"><p class="eyebrow">FIND YOUR RESERVATION</p><h2>Continue to upload ${escapeHtml(documentTypeName())}</h2><p>Enter the email and phone you booked with.</p><form id="documentAccessForm" class="portal-auth-form GlassInput"><label>Email<input name="email" type="email" autocomplete="email" required value="${escapeHtml(state.accountIdentity?.email || '')}"></label><label>Mobile phone<input name="phone" type="tel" autocomplete="tel" required value="${escapeHtml(state.accountIdentity?.phone || '')}"></label><button class="button GlassButton primary-action" type="submit">Continue to upload</button></form><p class="message" aria-live="polite">${escapeHtml(state.accountMessage)}</p></section>`;
  }
  function renderUploadDocuments() {
    const content = $('#uploadDocumentsContent'); if (!content) return;
    const uploadState = state.documentUpload;
    if (uploadState.status === 'SUCCESS') {
      content.innerHTML = `<div class="upload-documents-shell"><section class="panel LiquidGlass GlassPanel document-success"><p class="eyebrow">DOCUMENT RECEIVED</p><h1 id="uploadDocumentsTitle">Document received</h1><p>${escapeHtml(documentTypeName(uploadState.successType))} uploaded successfully.</p><p class="privacy-note">The actual file is not displayed here or in My Parking.</p><div class="lifecycle-actions"><button type="button" class="button GlassButton" data-upload-another>Upload another document</button><a class="button GlassButton secondary-button" href="#parking" data-route="parking">Return to Parking</a><a class="text-link" href="#my-parking" data-route="my-parking">Go to My Parking</a></div></section></div>`;
      return;
    }
    const typeChoices = `<section class="panel LiquidGlass GlassPanel document-upload-card"><p class="eyebrow">UPLOAD DOCUMENTS</p><h1 id="uploadDocumentsTitle">What would you like to upload?</h1><div class="document-type-choices"><button type="button" class="document-type-choice GlassOffer" data-document-type-choice="DRIVER_LICENSE" aria-pressed="${uploadState.type === 'DRIVER_LICENSE'}">Driver License</button><button type="button" class="document-type-choice GlassOffer" data-document-type-choice="INSURANCE" aria-pressed="${uploadState.type === 'INSURANCE'}">Insurance</button></div></section>`;
    let next = '';
    if (uploadState.type) {
      if (state.accountStatus === 'LOADING') next = '<div class="portal-loading" role="status">Checking secure access…</div>';
      else if (state.accountStatus !== 'AUTHENTICATED' || state.accountGrantDocumentType !== uploadState.type) next = renderDocumentIdentity();
      else {
        const reservation = state.accountData?.uploadReservation;
        if (!reservation) next = accountEmpty('No eligible parking record', 'An eligible paid or confirmed parking reservation is required before documents can be attached.');
        else {
          const selected = uploadState.file;
          const progress = Math.max(0, Math.min(100, Number(uploadState.progress || 0)));
          const replacing = safeDocumentStatus(reservation.documents?.[uploadState.type]?.status) !== 'Missing';
          const stays = [...(state.accountData?.reservations?.current || []), ...(state.accountData?.reservations?.upcoming || [])];
          const stayLabel = item => `${item.space ? `Space ${item.space} · ` : ''}${durationName(item.parkingProduct)} · ${accountDate(item.startsAt)} · ${item.reservationNumber}`;
          const staySelect = stays.length > 1
            ? `<label class="full">This document is for<select id="uploadReservationSelect">${stays.map(item => `<option value="${escapeHtml(item.reservationNumber)}"${item.reservationNumber === reservation.reservationNumber ? ' selected' : ''}>${escapeHtml(stayLabel(item))}</option>`).join('')}</select></label>`
            : `<dl class="portal-facts"><div><dt>For</dt><dd>${escapeHtml(stayLabel(reservation))}</dd></div></dl>`;
          next = `<form id="standaloneDocumentUploadForm" class="panel LiquidGlass GlassPanel GlassInput document-upload-card"><p class="eyebrow">${escapeHtml(documentTypeName())}</p><h2>Choose how to upload</h2>${staySelect}${replacing ? `<p class="privacy-note">A ${escapeHtml(documentTypeName())} has already been received. This upload will replace it.</p>` : ''}<div class="document-source-buttons"><label class="button GlassButton secondary-button">Take Photo<input class="standalone-document-input" type="file" accept="image/jpeg,image/png" capture="environment"></label><label class="button GlassButton secondary-button">Choose File<input class="standalone-document-input" type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"></label></div><p class="selected-file">${selected ? `${escapeHtml(selected.name)} · ${escapeHtml(selected.type || 'file')}` : 'No file selected.'}</p><p class="privacy-note">PDF, JPG/JPEG, or PNG; 15 MB maximum.</p>${uploadState.status === 'UPLOADING' ? `<div class="upload-progress" role="status"><label for="documentUploadProgress">Uploading ${escapeHtml(documentTypeName())}: ${progress}%</label><progress id="documentUploadProgress" max="100" value="${progress}"></progress></div>` : ''}<button class="button GlassButton primary-action" type="submit" ${selected && uploadState.status !== 'UPLOADING' ? '' : 'disabled'}>${selected ? `${replacing ? 'Replace' : 'Upload'} ${escapeHtml(documentTypeName())}` : 'Choose a file to continue'}</button><p class="message${uploadState.status === 'ERROR' ? ' error' : ''}" aria-live="polite">${escapeHtml(uploadState.message)}</p></form>`;
        }
      }
    }
    content.innerHTML = `<div class="upload-documents-shell">${typeChoices}${next}</div>`;
  }
  function uploadFileWithProgress(upload, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(upload.method || 'PUT', upload.url, true);
      Object.entries(upload.headers || {}).forEach(([name,value]) => xhr.setRequestHeader(name, value));
      xhr.upload.addEventListener('progress', event => { if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100)); });
      xhr.addEventListener('load', () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('The secure upload could not be completed.')));
      xhr.addEventListener('error', () => reject(new Error('The secure upload was interrupted. Check your connection and try again.')));
      xhr.addEventListener('abort', () => reject(new Error('The upload was cancelled.')));
      xhr.send(file);
    });
  }
  function clientDocument(file, label) {
    const extension = file?.name?.toLowerCase().match(/(\.pdf|\.jpe?g|\.png)$/)?.[1] || '';
    const allowed = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
    const mimeType = file?.type || allowed[extension];
    if (!file?.size || !allowed[extension] || allowed[extension] !== mimeType) throw new Error(`Choose a PDF, JPG/JPEG, or PNG ${label.toLowerCase()} file.`);
    if (file.size > 15728640) throw new Error(`${label} files must be no larger than 15 MB.`);
    return { mimeType };
  }
  async function submitStandaloneDocument(form) {
    const file = state.documentUpload.file;
    try {
      const validated = clientDocument(file, documentTypeName());
      state.documentUpload.status = 'UPLOADING'; state.documentUpload.progress = 0; state.documentUpload.message = 'Preparing secure upload…'; renderUploadDocuments();
      const started = await lookupMutation(`/documents/${encodeURIComponent(state.documentUpload.type)}/upload`, { method: 'POST', body: JSON.stringify({ filename: file.name, mimeType: validated.mimeType, sizeBytes: file.size }) });
      await uploadFileWithProgress(started.upload, file, progress => { state.documentUpload.progress = progress; state.documentUpload.message = 'Uploading securely…'; renderUploadDocuments(); });
      state.documentUpload.message = 'Verifying document…'; renderUploadDocuments();
      await lookupMutation('/documents/complete', { method: 'POST', body: JSON.stringify({ uploadToken: started.upload.token }) });
      const successType = state.documentUpload.type;
      await loadAccountOverview();
      state.documentUpload = { type: '', reservationNumber: '', file: null, progress: 100, status: 'SUCCESS', message: '', successType };
      renderUploadDocuments();
    } catch (error) {
      state.documentUpload.status = 'ERROR'; state.documentUpload.message = error.publicMessage || error.message || 'The document could not be uploaded.';
      renderUploadDocuments();
    }
  }
  function renderAccountSurface() {
    if (state.currentRoute === 'upload-documents') renderUploadDocuments();
    else renderMyParking();
  }
  async function loadAccountOverview() {
    state.accountStatus = 'LOADING'; renderAccountSurface();
    try {
      const response = await accountRequest('/lookup/summary');
      state.accountData = response.summary; state.accountCsrf = response.csrfToken || '';
      state.accountGrantDocumentType = response.documentType || null; state.accountStatus = 'AUTHENTICATED'; state.accountMessage = '';
    } catch (error) {
      if ([401,403,404].includes(error.status)) { state.accountStatus = 'SIGNED_OUT'; state.accountData = null; state.accountCsrf = ''; state.accountGrantDocumentType = null; }
      else { state.accountStatus = 'SIGNED_OUT'; state.accountMessage = error.publicMessage || 'My Parking is temporarily unavailable.'; }
    }
    renderAccountSurface();
  }
  function prefillBookingFromAccount() {
    // The low-sensitivity lookup deliberately does not expose customer contact data.
  }
  async function accountLookup(details) {
    const response = await accountRequest('/lookup', { method: 'POST', body: JSON.stringify(details) });
    state.accountIdentity = { email: details.email, phone: details.phone };
    state.accountData = response.summary; state.accountCsrf = response.csrfToken || '';
    state.accountGrantDocumentType = response.documentType || null; state.accountStatus = 'AUTHENTICATED'; state.accountMessage = '';
  }
  async function submitAccountLogin(form) {
    const button = form.querySelector('button'); button.disabled = true; state.accountMessage = '';
    try {
      const details = Object.fromEntries(new FormData(form));
      if (state.currentRoute === 'upload-documents') { details.documentType = state.documentUpload.type; if (state.documentUpload.reservationNumber) details.reservationNumber = state.documentUpload.reservationNumber; }
      await accountLookup(details);
    } catch (error) {
      state.accountStatus = 'SIGNED_OUT'; state.accountData = null; state.accountCsrf = ''; state.accountGrantDocumentType = null;
      state.accountMessage = error.publicMessage || 'We could not find a matching parking record.';
    }
    renderAccountSurface();
  }
  // From a My Parking card: start an upload for one specific stay. Re-uses the email + phone already entered.
  async function startUploadFor(reservationNumber, type) {
    state.documentUpload = { type, reservationNumber, file: null, progress: 0, status: 'IDLE', message: '', successType: '' };
    if (state.accountIdentity) {
      state.accountStatus = 'LOADING'; navigate('upload-documents');
      try { await accountLookup({ ...state.accountIdentity, documentType: type, reservationNumber }); }
      catch (error) { state.accountStatus = 'SIGNED_OUT'; state.accountMessage = error.publicMessage || 'We could not find that reservation.'; }
      renderUploadDocuments();
    } else navigate('upload-documents');
  }
  async function accountLogout() {
    try { await lookupMutation('/logout', { method: 'POST' }); } catch (_) { /* Local sign-out still clears lookup state. */ }
    state.accountStatus = 'SIGNED_OUT'; state.accountData = null; state.accountCsrf = ''; state.accountGrantDocumentType = null; state.accountMessage = 'You are signed out.'; renderAccountSurface();
  }
  function onDocumentSubmit(event) {
    const form = event.target;
    if (form.matches('#accountLoginForm, #documentAccessForm')) { event.preventDefault(); submitAccountLogin(form); }
    else if (form.matches('#standaloneDocumentUploadForm')) { event.preventDefault(); submitStandaloneDocument(form); }
  }

  function currentFormTrip() {
    const monthly = state.selectedDuration === 'MONTHLY';
    const trip = { categoryCode: $('#category')?.value || '', arrivalLocal: `${$('#arrivalDate')?.value || ''}T${$('#arrivalTime')?.value || ''}`, ...(monthly ? {} : { departureLocal: `${$('#departureDate')?.value || ''}T${$('#departureTime')?.value || ''}` }) };
    return { ...trip, duration: state.selectedDuration };
  }
  function currentFormFingerprint() { return core.tripFingerprint(currentFormTrip()); }
  function categoryFor(code = state.selectedCategoryCode) { return core.categoryMetadata(code) && state.canonicalLot?.categories?.find(category => category.code === code) || null; }
  function setDateTimeValue(prefix, value) { const [date, time] = String(value || '').split('T'); if ($(`#${prefix}Date`)) $(`#${prefix}Date`).value = date || ''; if ($(`#${prefix}Time`)) $(`#${prefix}Time`).value = time || ''; }
  function initializeLotDefaults() {
    if (!state.canonicalLot?.timezone || $('#arrivalDate').value) return;
    const arrival = core.zonedInputValue(new Date(Date.now() + 3600000), state.canonicalLot.timezone);
    setDateTimeValue('arrival', arrival); setDateTimeValue('departure', core.addLocalCalendarDays(arrival, 1));
  }
  function syncMonthlyDateFields() {
    const monthly = state.selectedDuration === 'MONTHLY';
    ['#departureDateField', '#departureTimeField'].forEach(selector => { const field = $(selector); if (field) field.hidden = monthly; });
    ['#departureDate', '#departureTime'].forEach(selector => { const field = $(selector); if (field) field.required = !monthly; });
  }
  function minimumMonthlyDays() { return state.canonicalLot?.bookingPolicy?.minimumMonthlyDays || 28; }
  function minimumWeeklyDays() { return state.canonicalLot?.bookingPolicy?.minimumWeeklyDays || 7; }
  function invalidateSearchState({ announce = false } = {}) {
    state.searchGeneration += 1; state.availabilityController?.abort(); state.quoteController?.abort(); state.availabilityController = null; state.quoteController = null;
    if (state.quoteExpiryTimer) window.clearTimeout(state.quoteExpiryTimer); state.quoteExpiryTimer = null;
    if (state.holdCountdownTimer) window.clearInterval(state.holdCountdownTimer); state.holdCountdownTimer = null;
    state.trip = null; state.availability = []; state.selected = null; state.selectedMonthlySpot = null;
    state.monthly = { status: 'IDLE', layout: null, positions: [], error: '' };
    state.search = { status: core.SEARCH_STATUS.IDLE, fingerprint: '', error: '' };
    state.quote = { status: core.QUOTE_STATUS.IDLE, tripFingerprint: '', offerKey: '', data: null, error: '' }; state.bookingKey = null; state.quotePrefetch = null;
    $('#availabilityCards').innerHTML = ''; $('#parkingInformation').innerHTML = ''; $('#quoteSummary').innerHTML = ''; $('#selectedParkingSummary').innerHTML = '';
    $('#continueDriver').disabled = true; setMessage($('#availabilityMessage'));
    if (announce) setMessage($('#searchMessage'), 'Search results and pricing were cleared because the trip changed. Check availability again.');
  }

  function setStep(step, { focus = true } = {}) {
    state.currentStep = step; document.body.dataset.flowStep = String(step);
    const panels = { 1: '#tripStep', 2: '#parkingStep', 3: '#driverStep', 4: '#paymentStep', 5: '#confirmation' };
    Object.entries(panels).forEach(([key, selector]) => { const element = $(selector); if (element) element.hidden = Number(key) !== step; });
    $$('[data-progress]').forEach(item => { const value = Number(item.dataset.progress); item.classList.toggle('is-current', value === step); item.classList.toggle('is-complete', value < step); });
    if (focus) focusRouteHeading($(panels[step]));
  }
  const routeViews = ['#tripStep', '#parkingStep', '#driverStep', '#paymentStep', '#confirmation', '#passView', '#mapView', '#reservationsView', '#managementView', '#lookupView', '#myParkingView', '#uploadDocumentsView'];
  function hideAllRouteViews() { routeViews.forEach(selector => { const element = $(selector); if (element) element.hidden = true; }); }
  function focusRouteHeading(container) { const heading = container?.querySelector('h1, h2, h3'); if (heading && !container.hidden) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); } }
  function navigate(route, { replace = false, view = '', reservationNumber = '' } = {}) {
    const safe = lifecycle.normalizeRoute(`#${route}`); const historyState = { route: safe, ...(view ? { view } : {}), ...(reservationNumber ? { reservationNumber: core.normalizeReservationNumber(reservationNumber) } : {}) };
    window.history[replace ? 'replaceState' : 'pushState'](historyState, '', `#${safe}`); renderCurrentRoute();
  }

  async function ensureActiveBooking(reservationNumber, renderId, route) {
    const expected = core.normalizeReservationNumber(reservationNumber || state.activeBooking?.reservationNumber || activeRecentEntry()?.reservationNumber);
    if (!expected) return null;
    if (state.activeBooking?.reservationNumber === expected && !state.bookingCached) return state.activeBooking;
    const entry = activeRecentEntry(expected); if (!entry) return null;
    const token = state.reservationGate.begin(expected);
    try {
      const booking = await fetchReservation(entry);
      if (!state.reservationGate.current(token, expected) || renderId !== state.routeRenderId || route !== lifecycle.normalizeRoute(window.location.hash)) return null;
      updateActiveBooking(booking, entry.lookupCredential, entry.maskedContact); return booking;
    } catch (error) {
      if (state.activeBooking?.reservationNumber === expected) { state.bookingCached = true; return state.activeBooking; }
      return null;
    }
  }
  // The confirmation text/email links here: #r=TH-XXXXXX&c=<credential>. Open that reservation directly.
  async function openReservationLink(rawRoute) {
    const params = new URLSearchParams(rawRoute);
    const reservationNumber = core.normalizeReservationNumber(params.get('r') || '');
    const credential = String(params.get('c') || '');
    if (!reservationNumber || !credential) return navigate('my-parking', { replace: true });
    try {
      const booking = await fetchReservation({ reservationNumber, lookupCredential: credential });
      updateActiveBooking(booking, credential, '', { persist: true });
      navigate('confirmation', { replace: true, reservationNumber: booking.reservationNumber });
    } catch (_) {
      state.accountMessage = 'That link has expired or was already used. Enter your email and phone to find your parking.';
      navigate('my-parking', { replace: true });
    }
  }
  async function renderCurrentRoute() {
    const rawRoute = window.location.hash.slice(1);
    if (/^r=/.test(rawRoute)) return openReservationLink(rawRoute);
    if (rawRoute.startsWith('demo-payment')) {
      state.currentRoute = 'demo-payment'; hideAllRouteViews(); $('#paymentStep').hidden = false;
      $$('[data-booking-chrome]').forEach(element => { element.hidden = true; });
      setStep(4, { focus: false }); await renderDemoPayment(rawRoute); return;
    }
    if (rawRoute.startsWith('payment-return') || rawRoute.startsWith('checkout-cancelled')) {
      state.currentRoute = 'payment'; hideAllRouteViews(); $('#paymentStep').hidden = false;
      $$('[data-booking-chrome]').forEach(element => { element.hidden = false; });
      setStep(4, { focus: false }); handlePaymentReturn(rawRoute.startsWith('checkout-cancelled'));
      return;
    }
    const renderId = ++state.routeRenderId; const route = lifecycle.normalizeRoute(window.location.hash); const routeState = window.history.state || {};
    state.currentRoute = route; if (route !== 'confirmation') stopAssignmentPolling('navigated');
    hideAllRouteViews(); $$('[data-booking-chrome]').forEach(element => { element.hidden = !['parking', 'offers', 'review', 'confirmation'].includes(route); });
    $$('.desktop-nav [data-route], .mobile-nav [data-route], .th-chrome [data-route]').forEach(link => { if (link.dataset.route === route) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
    $('.mobile-nav')?.removeAttribute('open'); document.body.classList.remove('th-menu-open'); $('[data-th-menu-toggle]')?.setAttribute('aria-expanded', 'false');
    if (route === 'parking') { $('#tripStep').hidden = false; setStep(1, { focus: false }); focusRouteHeading($('#tripStep')); return; }
    if (route === 'offers') {
      if (![core.SEARCH_STATUS.LOADING, core.SEARCH_STATUS.SUCCESS_RESULTS, core.SEARCH_STATUS.SUCCESS_EMPTY, core.SEARCH_STATUS.ERROR].includes(state.search.status)) return navigate('parking', { replace: true });
      $('#parkingStep').hidden = false; setStep(2, { focus: false }); renderOffers(); focusRouteHeading($('#parkingStep')); return;
    }
    if (route === 'review') {
      if (!core.bookingCanContinue(state)) return navigate(state.search.status !== core.SEARCH_STATUS.IDLE ? 'offers' : 'parking', { replace: true });
      $('#driverStep').hidden = false; setStep(3, { focus: false }); prefillBookingFromAccount(); renderSelectedParking(); focusRouteHeading($('#driverStep')); return;
    }
    if (route === 'my-parking') {
      $('#myParkingView').hidden = false;
      if (state.accountStatus === 'UNKNOWN') await loadAccountOverview(); else renderMyParking();
      focusRouteHeading($('#myParkingView')); return;
    }
    if (route === 'upload-documents') {
      $('#uploadDocumentsView').hidden = false;
      if (state.accountStatus === 'UNKNOWN') await loadAccountOverview(); else renderUploadDocuments();
      focusRouteHeading($('#uploadDocumentsView')); return;
    }
    if (route === 'lookup') { $('#lookupView').hidden = false; focusRouteHeading($('#lookupView')); return; }
    if (route === 'reservations' && routeState.view !== 'management') { $('#reservationsView').hidden = false; renderRecentReservations(); focusRouteHeading($('#reservationsView')); return; }
    const target = core.normalizeReservationNumber(routeState.reservationNumber || state.activeBooking?.reservationNumber || '');
    const container = route === 'confirmation' ? $('#confirmation') : route === 'pass' ? $('#passView') : route === 'map' ? $('#mapView') : $('#managementView');
    container.hidden = false; container.querySelector(':scope > div')?.replaceChildren();
    const booking = await ensureActiveBooking(target, renderId, route);
    if (renderId !== state.routeRenderId || route !== lifecycle.normalizeRoute(window.location.hash)) return;
    if (!booking) return navigate(route === 'confirmation' ? 'lookup' : 'lookup', { replace: true });
    if (routeState.reservationNumber && booking.reservationNumber !== core.normalizeReservationNumber(routeState.reservationNumber)) return navigate('lookup', { replace: true });
    if (route === 'confirmation') { setStep(5, { focus: false }); renderConfirmationView(); focusRouteHeading($('#confirmation')); startAssignmentPolling(); return; }
    if (route === 'pass') { renderDedicatedPass(); focusRouteHeading($('#passView')); return; }
    if (route === 'map') { if (!core.reservationStatusView(booking).mapValid) return navigate('pass', { replace: true }); renderDedicatedMap(); focusRouteHeading($('#mapView')); return; }
    if (route === 'reservations') { renderManagementView(); focusRouteHeading($('#managementView')); return; }
    navigate('parking', { replace: true });
  }

  function renderCanonicalLot() {
    const lot = state.canonicalLot; const choices = lot?.categories || [];
    $('#category').value = state.selectedCategoryCode;
    const renderedChoices = choices.map(category => {
      const meta = core.categoryMetadata(category.code); if (!meta) return '';
      const selected = state.selectedCategoryCode === category.code;
      const durations = core.filterSupportedDurations(category.offeredDurations).map(item => `<span>${escapeHtml(durationName(item.code))} · ${escapeHtml(core.money(item.unitRateCents))}</span>`).join('') || '<span>Online pricing unavailable</span>';
      const rate = core.safeCents(category.startingRateCents) === null ? '' : `<strong>From ${escapeHtml(core.money(category.startingRateCents))}</strong>`;
      return `<button type="button" class="parking-type-card${selected ? ' is-selected' : ''} ${category.code === 'BOBTAIL' ? 'is-bobtail' : 'is-general'}" data-parking-type="${category.code}" aria-pressed="${selected}"><span class="parking-type-marker" aria-hidden="true">${meta.marker}</span><span class="parking-type-copy"><span class="card-kicker">${escapeHtml(meta.label)}</span><strong>${escapeHtml(meta.label)}</strong><span>${escapeHtml(meta.description)}</span></span><span class="parking-type-rate">${rate}<small>${rate ? 'Starting rate' : 'Check dates for price'}</small></span></button>`;
    }).join('');
    $('#parkingTypeChoices').innerHTML = renderedChoices || (state.canonicalStatus === 'LOADING'
      ? '<div class="loading-state" role="status">Loading customer parking types…</div>'
      : `<div class="empty-state"><strong>New parking search is temporarily unavailable.</strong><p>Reservation lookup and management are still available.</p><div class="card-actions">${config.configured ? '<button type="button" class="button secondary-button" data-retry-lot>Retry parking details</button>' : ''}${supportLink()}</div></div>`);
    $('#lotTimezone').textContent = lot ? `Times are entered in ${lot.timezone}.` : state.canonicalStatus === 'LOADING' ? 'Loading parking details…' : 'New parking search unavailable';
    $('#selectedTypeChip').textContent = categoryFor()?.name || 'Choose a parking type';
    const name = lot?.name || 'Trucker Heaven Parking'; const address = lot?.address || 'Address temporarily unavailable';
    ['#searchLocationName', '#propertyLocationName'].forEach(selector => { if ($(selector)) $(selector).textContent = name; });
    ['#searchLocationAddress', '#propertyLocationAddress'].forEach(selector => { if ($(selector)) $(selector).textContent = address; });
    const directions = $('#propertyDirectionsLink'); if (lot?.roadDirectionsUrl) { directions.href = lot.roadDirectionsUrl; directions.hidden = false; } else directions.hidden = true;
    const monthlyProduct = (state.trip?.duration || state.selectedDuration) === 'MONTHLY';
    const selectedPeriod = durationName(state.trip?.duration || state.selectedDuration);
    const assignmentCopy = monthlyProduct
      ? '<span aria-hidden="true">✓</span><div><strong>You pick your space on the lot map.</strong><p>Your space is yours month to month. Pay at the office; the first month is prorated, then it is due on the 1st.</p></div>'
      : `<span aria-hidden="true">✓</span><div><strong>Park anywhere in the ${escapeHtml(selectedPeriod)} area.</strong><p>Confirmed right away. Pay at the Trucker Heaven office when you leave.</p></div>`;
    if ($('#searchAssignmentNote')) $('#searchAssignmentNote').innerHTML = assignmentCopy;
    if ($('#offerAssignmentNote')) $('#offerAssignmentNote').innerHTML = monthlyProduct
      ? '<span aria-hidden="true">✓</span><div><strong>Pick your Monthly space</strong><p>Green spaces on the map are open for your dates. Tap one to hold it while you finish.</p></div>'
      : `<span aria-hidden="true">✓</span><div><strong>Your ${escapeHtml(selectedPeriod)} parking area</strong><p>The highlighted spaces are where you can park. No need to pick one now.</p></div>`;
    const searchButton = $('#searchForm [type="submit"]'); if (searchButton) searchButton.disabled = !lot;
    const phoneRow = $('#propertyPhoneRow'); const phoneLink = $('#propertyPhoneLink');
    if (supportHref()) { phoneRow.hidden = false; phoneLink.href = supportHref(); phoneLink.textContent = publicPhone(); } else phoneRow.hidden = true;
    renderDurationOptions();
  }
  function chooseParkingType(code) {
    const category = categoryFor(code); if (!category) return;
    if (state.selectedCategoryCode !== code) invalidateSearchState();
    state.selectedCategoryCode = code; $('#category').value = code;
    const offered = core.filterSupportedDurations(category.offeredDurations).map(item => item.code);
    if (!offered.includes(state.selectedDuration)) state.selectedDuration = offered.includes('DAILY') ? 'DAILY' : (offered[0] || '');
    let adjusted = false;
    const trip = currentFormTrip();
    if (state.selectedDuration === 'WEEKLY' && core.localElapsedDays(trip.arrivalLocal, trip.departureLocal) < minimumWeeklyDays()) {
      setDateTimeValue('departure', core.addLocalCalendarDays(trip.arrivalLocal, minimumWeeklyDays())); adjusted = true;
    }
    renderCanonicalLot();
    if (adjusted) setMessage($('#searchMessage'), `${durationName(state.selectedDuration)} parking requires its minimum stay. Departure was moved to the earliest valid date.`);
    $('#durationOptions button')?.focus();
  }
  function renderDurationOptions() {
    const category = categoryFor(); const offers = core.filterSupportedDurations(category?.offeredDurations);
    if (!category) { $('#durationOptions').innerHTML = '<p class="muted">Select a parking type to see its offered periods.</p>'; return; }
    if (!offers.length) { $('#durationOptions').innerHTML = '<p class="message error">No supported booking product is currently available for this parking type.</p>'; return; }
    const controls = offers.map(offer => `<button type="button" class="duration-option${offer.code === state.selectedDuration ? ' is-selected' : ''}" data-duration="${escapeHtml(offer.code)}" aria-pressed="${offer.code === state.selectedDuration}"><strong>${escapeHtml(durationName(offer.code))}</strong><span>${escapeHtml(core.money(offer.unitRateCents))} rate</span></button>`).join('');
    syncMonthlyDateFields();
    const monthlyOffer = offers.find(offer => offer.code === 'MONTHLY');
    const monthlyNote = !monthlyOffer
      ? '<p class="duration-note">Monthly parking is not configured for this parking type.</p>'
      : state.selectedDuration === 'MONTHLY' ? `<p class="duration-note">${escapeHtml(core.money(monthlyOffer.unitRateCents))}/month. Your first month is prorated when you start after the 1st; then ${escapeHtml(core.money(monthlyOffer.unitRateCents))} is due on the 1st of each month.</p>` : '';
    const weeklyNote = state.selectedDuration === 'WEEKLY' ? `<p class="duration-note">Weekly parking requires a minimum ${minimumWeeklyDays()}-day stay.</p>` : '';
    $('#durationOptions').innerHTML = `${controls}${weeklyNote}${monthlyNote}`;
  }
  function setDuration(duration) {
    duration = core.supportedDuration(duration);
    if (!duration || !core.filterSupportedDurations(categoryFor()?.offeredDurations).some(offer => offer.code === duration)) return;
    const hadSearch = state.search.status !== core.SEARCH_STATUS.IDLE; state.selectedDuration = duration;
    const trip = currentFormTrip(); let adjusted = false;
    if (duration === 'WEEKLY' && core.normalizeLocal(trip.arrivalLocal)
      && core.localElapsedDays(trip.arrivalLocal, trip.departureLocal) < minimumWeeklyDays()) {
      setDateTimeValue('departure', core.addLocalCalendarDays(trip.arrivalLocal, minimumWeeklyDays())); adjusted = true;
    }
    invalidateSearchState(); renderCanonicalLot();
    if (adjusted) setMessage($('#searchMessage'), `${durationName(duration)} parking requires its minimum stay. Departure was moved to the earliest valid date.`);
    else if (hadSearch) setMessage($('#searchMessage'), 'Search results and pricing were cleared because the parking product changed. Check availability again.');
  }

  function selectOffer(result, fingerprint = state.search.fingerprint) {
    if (!result || result.categoryCode !== state.trip?.categoryCode) return;
    const key = core.offerKey(result, fingerprint); state.selected = { ...result, tripFingerprint: fingerprint, offerKey: key }; state.bookingKey = null;
    const monthly = state.trip?.duration === 'MONTHLY'; // only Monthly picks a space; Daily/Weekly book the area
    state.quote = result.available && result.pricingAvailable
      ? { status: monthly ? core.QUOTE_STATUS.IDLE : core.QUOTE_STATUS.LOADING, tripFingerprint: fingerprint, offerKey: key, data: null, error: '' }
      : { status: result.available ? core.QUOTE_STATUS.UNAVAILABLE : core.QUOTE_STATUS.IDLE, tripFingerprint: fingerprint, offerKey: key, data: null, error: result.available ? 'Positions may be available, but online pricing is unavailable.' : '' };
    renderOffers();
    if (result.available && result.pricingAvailable && !monthly) fetchQuote(state.selected);
  }
  async function fetchQuote(selected = state.selected) {
    if (!selected || !state.trip) return; state.quoteController?.abort(); const controller = new AbortController(); state.quoteController = controller;
    if (state.trip.duration === 'MONTHLY' && !state.selectedMonthlySpot) return;
    const fingerprint = state.search.fingerprint; const key = selected.offerKey;
    state.quote = { status: core.QUOTE_STATUS.LOADING, tripFingerprint: fingerprint, offerKey: key, data: null, error: '' }; renderOffers();
    try {
      const prefetch = !state.selectedMonthlySpot && state.quotePrefetch?.fingerprint === fingerprint ? state.quotePrefetch : null;
      state.quotePrefetch = null;
      const response = prefetch
        ? await prefetch.promise.then(value => { if (value && value.__error) throw value.__error; return value; })
        : await request('/quotes', {
          method: 'POST',
          body: JSON.stringify({ ...state.trip, ...(state.selectedMonthlySpot ? { selectedSpotId: state.selectedMonthlySpot.id } : {}) }),
          signal: controller.signal
        });
      if (controller !== state.quoteController || fingerprint !== currentFormFingerprint() || fingerprint !== state.search.fingerprint || key !== state.selected?.offerKey) return;
      const quote = core.validateQuote(response, state.trip, selected);
      if (!quote) throw new Error('Invalid customer quote response.');
      state.quote = { status: core.QUOTE_STATUS.SUCCESS, tripFingerprint: fingerprint, offerKey: key, data: quote, error: '' }; scheduleQuoteExpiration(quote, fingerprint, key);
    } catch (error) {
      if (error.name === 'AbortError' || controller !== state.quoteController) return;
      state.quote = { status: core.QUOTE_STATUS.ERROR, tripFingerprint: fingerprint, offerKey: key, data: null, error: requestErrorMessage(core.classifyError(error), 'quote') };
    } finally { if (state.quoteController === controller) state.quoteController = null; renderOffers(); }
  }
  function scheduleQuoteExpiration(quote, fingerprint, key) {
    if (state.quoteExpiryTimer) window.clearTimeout(state.quoteExpiryTimer); state.quoteExpiryTimer = null;
    if (state.holdCountdownTimer) window.clearInterval(state.holdCountdownTimer); state.holdCountdownTimer = null;
    const expires = new Date(quote?.expiresAt).getTime(); if (!Number.isFinite(expires)) return;
    const delay = expires - Date.now();
    if (delay <= 0) return expireQuote(fingerprint, key);
    state.quoteExpiryTimer = window.setTimeout(() => expireQuote(fingerprint, key), Math.min(delay + 25, 2147483647));
    if (quote?.hold) {
      updateHoldCountdown();
      state.holdCountdownTimer = window.setInterval(updateHoldCountdown, 1000);
    }
  }
  function holdCountdownText() {
    const expires = new Date(state.quote.data?.hold?.expiresAt || state.quote.data?.expiresAt).getTime();
    const seconds = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function updateHoldCountdown() {
    $$('[data-hold-countdown]').forEach(element => { element.textContent = `Space ${state.selectedMonthlySpot?.label || ''} held for you — ${holdCountdownText()}`; });
  }
  function expireQuote(fingerprint, key) {
    if (state.quote.status !== core.QUOTE_STATUS.SUCCESS || state.quote.tripFingerprint !== fingerprint || state.quote.offerKey !== key) return;
    state.quote = { status: core.QUOTE_STATUS.ERROR, tripFingerprint: fingerprint, offerKey: key, data: null, error: true ? 'This space is no longer being held. Please choose an available space again.' : 'This price quote expired. Retry to request a current authoritative total.' }; state.bookingKey = null; $('#selectedParkingSummary').innerHTML = '';
    if (state.currentRoute === 'review') navigate('offers', { replace: true }); else renderOffers();
  }
  function renderSearchOverview() {
    if (!state.trip) return;
    const lot = state.canonicalLot; const quote = state.quote.data;
    const arrival = quote?.arrival ? core.humanTime(quote.arrival, quote.timezone || lot?.timezone) : core.humanLocalTime(state.trip.arrivalLocal, lot?.timezone);
    const monthly = state.trip.duration === 'MONTHLY'; const departure = quote?.departure ? core.humanTime(quote.departure, quote.timezone || lot?.timezone) : core.humanLocalTime(state.trip.departureLocal, lot?.timezone);
    $('#searchOverview').innerHTML = `<dl><div><dt>Location</dt><dd>${escapeHtml(lot?.name || 'Trucker Heaven Parking')}<small>${escapeHtml(lot?.address || '')}</small></dd></div><div><dt>Parking type</dt><dd>${escapeHtml(core.categoryMetadata(state.trip.categoryCode)?.label || 'Unavailable')}</dd></div><div><dt>Start</dt><dd>${escapeHtml(arrival)}</dd></div>${monthly ? '<div><dt>Monthly parking</dt><dd>Open-ended · billed on the 1st</dd></div>' : `<div><dt>Departure</dt><dd>${escapeHtml(departure)}</dd></div>`}<div><dt>Parking period</dt><dd>${escapeHtml(durationName(quote?.quote?.duration || state.trip.duration))}</dd></div></dl>`;
    $('#offerAssignmentNote').innerHTML = monthly
      ? '<span aria-hidden="true">✓</span><div><strong>Pick your Monthly space</strong><p>Green spaces on the map are open for your dates. Tap one to hold it while you finish.</p></div>'
      : `<span aria-hidden="true">✓</span><div><strong>Your ${escapeHtml(durationName(state.trip.duration))} parking area</strong><p>The highlighted spaces are where you can park. No need to pick one now.</p></div>`;
  }
  function offerCount(result) { return result.assignmentMode === 'EXACT_SPOT' ? result.numberedSpacesAvailable : result.remainingCapacity; }
  function renderAvailability() {
    const container = $('#availabilityCards');
    if (state.search.status === core.SEARCH_STATUS.LOADING) { container.innerHTML = '<div class="loading-state" role="status">Checking availability…</div>'; return; }
    if (state.search.status === core.SEARCH_STATUS.ERROR) { container.innerHTML = `<div class="empty-state error-state"><h3>Availability could not be retrieved</h3><p>${escapeHtml(state.search.error)}</p><div class="card-actions"><button class="button" type="button" data-retry-search>Retry search</button><button class="button secondary-button" type="button" data-edit-search>Edit search</button></div></div>`; return; }
    if (!state.availability.length) { container.innerHTML = `<div class="empty-state"><h3>No compatible parking for these trip details</h3><p>No ${escapeHtml(core.categoryMetadata(state.trip?.categoryCode)?.label || 'public parking')} offer was returned. We will not substitute another parking type.</p><div class="card-actions"><button class="button secondary-button" type="button" data-edit-search>Edit search</button>${supportLink('text-link')}</div></div>`; return; }
    container.innerHTML = state.availability.map(result => {
      const key = core.offerKey(result, state.search.fingerprint); const selected = key === state.selected?.offerKey; const count = offerCount(result);
      const status = !result.available ? 'Unavailable for these times' : !result.pricingAvailable ? 'Online pricing unavailable' : selected && state.quote.status === core.QUOTE_STATUS.LOADING ? 'Retrieving current price…' : selected && state.quote.status === core.QUOTE_STATUS.SUCCESS ? `Total ${core.money(state.quote.data.quote.totalCents)}` : 'Current price available after selection';
      const area = !exactMode(result); const monthly = monthlySelectedMode(result);
      const availabilityText = count === null ? (result.available ? 'Capacity confirmed' : 'No capacity available')
        : area ? `${escapeHtml(count)} parking ${count === 1 ? 'space' : 'spaces'} remaining in this area`
          : `${escapeHtml(count)} compatible ${count === 1 ? 'space' : 'spaces'}`;
      return `<article class="availability-card LiquidGlass GlassOffer${selected ? ' is-selected' : ''}${result.available ? '' : ' is-unavailable'}"><div class="offer-symbol" aria-hidden="true">${core.categoryMetadata(result.categoryCode).marker}</div><div class="offer-copy"><p class="card-kicker">${result.available ? 'AVAILABLE PARKING' : 'UNAVAILABLE'}</p><h3>${escapeHtml(parkingAreaName(result))}</h3><p>${area ? `Park anywhere in the highlighted ${escapeHtml(parkingAreaName(result))} area.` : monthly ? 'Pick an open space on the lot map below.' : 'This parking option is unavailable.'}</p><span class="capacity">${availabilityText}</span></div><div class="card-choice"><span>${escapeHtml(status)}</span>${selected && state.quote.status === core.QUOTE_STATUS.SUCCESS ? `<strong class="price">${escapeHtml(core.money(state.quote.data.quote.totalCents))}</strong><small>reservation total</small>` : ''}${state.availability.length > 1 && result.available && result.pricingAvailable ? `<button type="button" class="button GlassButton small-button" data-select-offer="${escapeHtml(key)}">${selected ? 'Selected' : 'Select offer'}</button>` : ''}</div></article>`;
    }).join('');
  }
  function quoteDetails(data) {
    const q = data?.quote || data; if (!q) return '';
    const units = Number(q.units || 0); const unit = Number(q.unitRateCents || 0);
    const breakdown = q.duration === 'MONTHLY'
      ? `<div><dt>Monthly rate</dt><dd>${escapeHtml(core.money(q.recurringUnitRateCents || unit))} / month</dd></div><div><dt>First month (prorated)</dt><dd>${escapeHtml(core.money(q.totalCents))}</dd></div>`
      : `<div><dt>${escapeHtml(durationName(q.duration))} rate</dt><dd>${units > 0 ? `${units} × ` : ''}${escapeHtml(core.money(unit))}</dd></div><div><dt>Total</dt><dd>${escapeHtml(core.money(q.totalCents))}</dd></div>`;
    return `<dl class="quote-lines">${breakdown}</dl>`;
  }
  function renderQuoteSummary() {
    const container = $('#quoteSummary'); const quote = state.quote;
    if (!state.selected || quote.status === core.QUOTE_STATUS.IDLE) { container.innerHTML = ''; return; }
    if (quote.status === core.QUOTE_STATUS.LOADING) { container.innerHTML = '<section class="loading-state" role="status"><h4>Retrieving current price…</h4><p>Your total will appear here.</p></section>'; return; }
    if (quote.status === core.QUOTE_STATUS.SUCCESS) { container.innerHTML = `<section><p class="card-kicker">${state.trip?.duration === 'MONTHLY' ? 'FIRST MONTH' : 'RESERVATION TOTAL'}</p><h4>${escapeHtml(core.categoryMetadata(state.selected.categoryCode).label)}</h4>${quote.data.selectedMonthlyPosition ? `<p><strong>Your space: ${escapeHtml(quote.data.selectedMonthlyPosition.label)}</strong><br><small>${escapeHtml(quote.data.hold?.message || '')}</small></p>` : ''}${quoteDetails(quote.data)}<p>${state.trip?.duration === 'MONTHLY' ? 'Pay at the office. Then the full monthly rate is due on the 1st of each month.' : 'No card needed online. Pay at the Trucker Heaven office when you leave.'}</p></section>`; return; }
    const unavailable = quote.status === core.QUOTE_STATUS.UNAVAILABLE;
    container.innerHTML = `<section class="quote-unavailable ${unavailable ? '' : 'quote-error'}"><p class="card-kicker">${unavailable ? 'ONLINE PRICING UNAVAILABLE' : 'PRICE RETRIEVAL FAILED'}</p><h4>${unavailable ? 'Spaces may be available' : 'The current price could not be retrieved'}</h4><p>${escapeHtml(quote.error)}</p><div class="card-actions">${unavailable ? '' : '<button class="button" type="button" data-retry-quote>Retry quote</button>'}<button class="button secondary-button" type="button" data-edit-search>Edit search</button></div></section>`;
  }
  const monthlyStateLabels = {
    AVAILABLE: 'Available',
    SELECTED: 'Selected',
    TEMPORARILY_HELD: 'Temporarily held',
    RESERVED: 'Reserved',
    OCCUPIED: 'Occupied',
    BLOCKED: 'Blocked',
    NOT_MONTHLY_ELIGIBLE: 'Not monthly eligible',
    INTERNAL_SHOP_COMPANY: 'Internal / shop / company',
    UNAVAILABLE: 'Unavailable'
  };
  function monthlyMapElement(element) {
    const values = [element?.x, element?.y, element?.width, element?.height].map(Number);
    if (!values.every(Number.isFinite)) return '';
    const style = `left:${values[0]}%;top:${values[1]}%;width:${values[2]}%;height:${values[3]}%;transform:rotate(${Number(element.rotation || 0)}deg);z-index:${Number(element.layerOrder || 0)}`;
    if (String(element.elementType || '').toUpperCase() !== 'PARKING_SPOT') {
      const presentation = mapPresentation(element, { assignmentMode: 'ZONE_CAPACITY' });
      return presentation ? `<div class="map-element map-${presentation.kind} is-customer-quiet" style="${style}">${presentation.label ? `<span>${escapeHtml(presentation.label)}</span>` : ''}</div>` : '';
    }
    const spot = element.space || {}; const selected = Number(state.selectedMonthlySpot?.id) === Number(spot.id);
    const stateName = selected ? 'SELECTED' : String(spot.selectionState || 'NOT_MONTHLY_ELIGIBLE');
    const label = monthlyStateLabels[stateName] || monthlyStateLabels.UNAVAILABLE;
    const number = spot.monthlyEligible ? String(spot.number || '') : '';
    const classes = `map-element map-space monthly-position state-${stateName.toLowerCase().replaceAll('_','-')}${selected ? ' is-selected-monthly' : ''}`;
    if (spot.selectable || selected) {
      const accessible = selected ? `✓ Space ${number} selected` : `Space ${number} — Available`;
      return `<button type="button" class="${classes}" style="${style}" data-monthly-spot="${escapeHtml(spot.id)}" aria-pressed="${selected}" aria-label="${escapeHtml(accessible)}" title="${escapeHtml(accessible)}"><span>${selected ? '✓ ' : ''}${escapeHtml(number)}</span></button>`;
    }
    return `<div class="${classes}" style="${style}" aria-label="${escapeHtml(number ? `Position ${number}. ${label}` : label)}"><span>${escapeHtml(number)}</span></div>`;
  }
  // Draws the real lot (traced from the lot diagram) and marks each numbered space by its state.
  function lotPlanSvg(elements) {
    const pick = state.trip?.duration === 'MONTHLY';
    const states = new Map(); const ids = new Map();
    for (const element of elements) {
      const spot = element?.space; if (!spot?.number) continue;
      const number = String(spot.number); const selection = String(spot.selectionState || '');
      ids.set(number, spot.id);
      if (!pick) { states.set(number, spot.available ? 'area' : 'off'); continue; }
      states.set(number, spot.selectable ? 'open' : /HELD|RESERVED|OCCUPIED|UNAVAILABLE/.test(selection) ? 'taken' : 'off');
    }
    const selected = pick && state.selectedMonthlySpot ? String(state.selectedMonthlySpot.label) : null;
    const svg = window.LotPlan.render(window.LotPlanData, { states, selected, interactive: pick, title: pick ? 'Lot map. Green spaces are open for your dates; tap one to pick it.' : 'Lot map. The highlighted spaces are the area you can park in.' });
    if (!pick) return svg;
    return svg.replace(/<g class="sp is-(open)" data-space="([^"]+)"/g, (match, kind, number) => ids.has(number) ? `${match} data-monthly-spot="${escapeHtml(ids.get(number))}"` : match);
  }
  function renderMonthlySelector() {
    if (!state.trip) return '';
    if (state.monthly.status === 'LOADING') return '<section class="monthly-selector"><p class="loading-state" role="status">Loading open spaces…</p></section>';
    if (state.monthly.status === 'ERROR' || !state.monthly.layout) return `<section class="monthly-selector"><p class="message error">${escapeHtml(state.monthly.error || 'The lot map is unavailable right now.')}</p></section>`;
    const map = state.monthly.layout; const elements = Array.isArray(map.elements) ? map.elements : [];
    const selected = state.selectedMonthlySpot; const held = state.quote.status === core.QUOTE_STATUS.SUCCESS && state.quote.data?.hold;
    const holdText = held ? `Held until ${core.humanTime(state.quote.data.hold.expiresAt, state.canonicalLot?.timezone)}.` : '';
    const term = durationName(state.trip.duration); const pick = state.trip.duration === 'MONTHLY';
    const openCount = elements.filter(element => pick ? element?.space?.selectable : element?.space?.available).length;
    const headline = pick ? `<h3 id="monthlySelectorTitle">Pick your space</h3><p><strong>${openCount} green ${openCount === 1 ? 'space is' : 'spaces are'} open for your dates. Tap one.</strong></p>`
      : `<h3 id="monthlySelectorTitle">Where you can park</h3><p><strong>The highlighted spaces are the ${escapeHtml(term)} area for your truck. Park in any open one when you arrive.</strong></p>`;
    return `<section class="monthly-selector" aria-labelledby="monthlySelectorTitle"><div class="monthly-selector-head"><div><p class="card-kicker">${escapeHtml(term.toUpperCase())} PARKING</p>${headline}<p>The whole lot is drawn so you can see where you'll be. The Entrance / Exit is on Eastgate Blvd.</p></div>${selected ? `<div class="selected-monthly-position"><span>Your space</span><strong>✓ Space ${escapeHtml(selected.label)}</strong><small>${escapeHtml(holdText || 'Holding it for you…')}</small>${held ? `<span class="hold-countdown" data-hold-countdown>Space ${escapeHtml(selected.label)} held for you — ${holdCountdownText()}</span>` : ''}<button type="button" class="text-button" data-change-monthly>Pick a different space</button></div>` : ''}</div><div class="map-stage monthly-map-stage" data-map-stage tabindex="0" aria-label="Monthly parking position selector. Use plus and minus to zoom, and Fit lot to restore the whole property."><div class="map-controls" aria-label="Map controls"><button type="button" data-map-zoom="in" aria-label="Zoom in">+</button><button type="button" data-map-zoom="out" aria-label="Zoom out">−</button><button type="button" data-map-zoom="fit" aria-label="Fit entire lot">Fit lot</button></div><div class="plan-canvas" style="height:${Math.round(100 * state.mapZoom)}%">${lotPlanSvg(elements)}</div></div><div class="map-area-label">${escapeHtml(parkingAreaName(state.selected))}</div><div class="plan-legend">${pick ? '<span><i class="sw is-open"></i>Open</span><span><i class="sw is-mine"></i>Your pick</span><span><i class="sw is-taken"></i>Taken or held</span>' : '<span><i class="sw is-area"></i>Your parking area</span>'}<span><i class="sw is-off"></i>Not for this booking</span></div></section>`;
  }
  async function releaseMonthlyQuote() {
    const quoteToken = state.quote.data?.quoteToken;
    if (!quoteToken) return;
    try { await request('/quotes/release', { method: 'POST', body: JSON.stringify({ quoteToken }) }); } catch (_) {}
  }
  async function chooseMonthlySpot(id) {
    const element = state.monthly.layout?.elements?.find(item => Number(item.space?.id) === Number(id));
    if (!element?.space?.selectable) return;
    await releaseMonthlyQuote();
    state.selectedMonthlySpot = { id: Number(element.space.id), label: String(element.space.number) };
    state.selected = { ...state.selected, selectedSpotId: Number(element.space.id) };
    state.quote = { status: core.QUOTE_STATUS.LOADING, tripFingerprint: state.search.fingerprint, offerKey: state.selected.offerKey, data: null, error: '' };
    renderOffers(); fetchQuote(state.selected);
  }
  async function changeMonthlySpot() {
    await releaseMonthlyQuote();
    state.selectedMonthlySpot = null;
    if (state.selected) { const { selectedSpotId: _selectedSpotId, ...selected } = state.selected; state.selected = selected; }
    state.quote = { status: core.QUOTE_STATUS.IDLE, tripFingerprint: state.search.fingerprint, offerKey: state.selected?.offerKey || '', data: null, error: '' };
    state.bookingKey = null; renderOffers();
  }

  function renderParkingInformation() {
    if (!state.selected) { $('#parkingInformation').innerHTML = ''; return; }
    const count = offerCount(state.selected);
    const area = !exactMode(state.selected); const monthly = monthlySelectedMode(state.selected);
    const availabilityUnit = area ? `capacity unit${count === 1 ? '' : 's'}`
      : monthly ? `open space${count === 1 ? '' : 's'}` : `compatible space${count === 1 ? '' : 's'}`;
    const term = durationName(state.trip?.duration);
    $('#parkingInformation').innerHTML = `${renderMonthlySelector()}<article class="information-card LiquidGlass how-it-works"><span class="information-icon" aria-hidden="true">✓</span><div><h4>${area ? 'Your parking area' : 'Your space is yours'}</h4><p>${area ? 'Your reservation guarantees a space inside the highlighted area. Park in any open one; the office can direct you.' : state.trip?.duration === 'MONTHLY' ? 'Park only in the space you picked. It stays yours month to month until you tell the office you are leaving.' : `Park only in the space you picked for your ${escapeHtml(term)} stay.`}</p></div></article><article class="information-card LiquidGlass availability-status-card"><h4>${count === null ? 'Availability confirmed' : `${escapeHtml(count)} spaces open`}</h4><p>We check the space again the moment you confirm.</p></article>`;
  }
  function renderOffers() {
    if (!$('#parkingStep') || state.currentRoute !== 'offers') return;
    renderSearchOverview(); renderAvailability(); renderQuoteSummary(); renderParkingInformation();
    const canContinue = core.bookingCanContinue(state); $('#continueDriver').disabled = !canContinue;
    $('#parkingSummary').textContent = state.search.status === core.SEARCH_STATUS.LOADING ? 'Checking your dates…' : state.search.status === core.SEARCH_STATUS.SUCCESS_EMPTY ? 'No parking is available for these dates.' : state.search.status === core.SEARCH_STATUS.ERROR ? 'Your search could not be completed.' : state.trip?.duration === 'MONTHLY' ? 'Tap a green space on the lot map.' : 'Your parking area is highlighted on the lot map.';
    const pick = state.trip?.duration === 'MONTHLY';
    if ($('#parkingTitle')) $('#parkingTitle').textContent = pick ? 'Pick your space' : 'Where you can park';
    const waitingForMonthlySpot = pick && !state.selectedMonthlySpot;
    const readyMessage = pick ? `Space ${state.selectedMonthlySpot?.label || ''} is held for you. Continue to enter your details.` : `Your ${durationName(state.trip?.duration)} parking is available. Continue to enter your details.`;
    setMessage($('#availabilityMessage'), canContinue ? readyMessage
      : waitingForMonthlySpot ? 'Tap a green space on the map to continue.'
        : 'Getting your price…', false);
  }
  async function checkAvailability(event) {
    event?.preventDefault(); if (!state.canonicalLot) return setMessage($('#searchMessage'), `New parking search is unavailable. ${config.configured ? 'Retry parking details or use reservation lookup.' : 'Customer API configuration is missing for this host.'}`, true);
    const trip = currentFormTrip(); const fingerprint = core.tripFingerprint(trip);
    if (!core.categoryMetadata(trip.categoryCode)) return setMessage($('#searchMessage'), 'Choose Bobtail Parking or General Truck Parking.', true);
    if (!core.supportedDuration(trip.duration)) return setMessage($('#searchMessage'), 'Choose Daily, Weekly, or Monthly parking.', true);
    if (!core.filterSupportedDurations(categoryFor()?.offeredDurations).some(offer => offer.code === trip.duration)) return setMessage($('#searchMessage'), `${durationName(trip.duration)} parking is not configured for this parking type.`, true);
    const intervalError = core.productIntervalError(trip.duration, trip.arrivalLocal, trip.departureLocal, minimumMonthlyDays(), minimumWeeklyDays());
    if (!fingerprint || intervalError) return setMessage($('#searchMessage'), intervalError || 'Review the trip details and try again.', true);
    invalidateSearchState(); state.trip = trip; state.search = { status: core.SEARCH_STATUS.LOADING, fingerprint, error: '' };
    state.monthly = { status: 'LOADING', layout: null, positions: [], error: '' };
    const generation = ++state.searchGeneration; const controller = new AbortController(); state.availabilityController = controller;
    setMessage($('#searchMessage')); navigate('offers');
    // Daily / Weekly need no space choice, so ask for the price at the same time as availability
    // instead of after it — the Continue button is then ready as soon as the map shows.
    state.quotePrefetch = trip.duration === 'MONTHLY' ? null
      : { fingerprint, promise: request('/quotes', { method: 'POST', body: JSON.stringify(trip), signal: controller.signal }).catch(error => ({ __error: error })) };
    try {
      const response = await request('/availability', { method: 'POST', body: JSON.stringify(trip), signal: controller.signal });
      if (generation !== state.searchGeneration || controller !== state.availabilityController || fingerprint !== currentFormFingerprint()) return;
      const results = core.validateAvailabilityResults(response, trip.categoryCode, trip.duration); if (results === null) throw new Error('Invalid availability response.');
      if (trip.duration === 'MONTHLY') {
        const monthly = await request('/monthly-positions', { method: 'POST', body: JSON.stringify(trip), signal: controller.signal });
        if (generation !== state.searchGeneration || controller !== state.availabilityController || fingerprint !== currentFormFingerprint()) return;
        if (monthly?.assignmentMode !== 'CUSTOMER_SELECTED_SPOT' || !monthly.layout || !Array.isArray(monthly.positions)) {
          throw new Error('Invalid monthly parking-position response.');
        }
        state.monthly = { status: 'SUCCESS', layout: monthly.layout, positions: monthly.positions, error: '' };
      } else {
        // Daily / Weekly: the lot map just shows the area they can park in.
        state.monthly = { status: 'SUCCESS', layout: response.layout || { elements: [] }, positions: [], error: '' };
      }
      state.availability = results; state.search.status = results.length ? core.SEARCH_STATUS.SUCCESS_RESULTS : core.SEARCH_STATUS.SUCCESS_EMPTY;
      const compatible = results.filter(result => result.available);
      if (compatible.length === 1) selectOffer(compatible[0], fingerprint); else { state.selected = null; state.quote.status = core.QUOTE_STATUS.IDLE; renderOffers(); }
    } catch (error) {
      if (error.name === 'AbortError' || generation !== state.searchGeneration) return;
      const message = requestErrorMessage(core.classifyError(error), 'search');
      state.search = { status: core.SEARCH_STATUS.ERROR, fingerprint, error: message }; state.availability = [];
      state.monthly = { status: 'ERROR', layout: null, positions: [], error: message };
      renderOffers();
    } finally { if (state.availabilityController === controller) state.availabilityController = null; }
  }

  function renderSelectedParking() {
    if (!core.bookingCanContinue(state)) { $('#selectedParkingSummary').innerHTML = ''; return; }
    const quote = state.quote.data; const meta = core.categoryMetadata(state.selected.categoryCode);
    const area = !exactMode(state.selected); const picked = monthlySelectedMode(state.selected);
    const monthly = (quote.quote?.duration || state.trip?.duration) === 'MONTHLY'; const term = durationName(quote.quote?.duration || state.trip?.duration);
    const company = $('#bookingForm [name="companyName"]'); if (company) company.required = monthly;
    if ($('#companyOptional')) $('#companyOptional').hidden = monthly;
    if ($('#usdotField')) $('#usdotField').hidden = !monthly;
    if ($('#monthlyVerification')) $('#monthlyVerification').hidden = !monthly;
    if ($('#insuranceDocument')) $('#insuranceDocument').required = false;
    const space = state.selectedMonthlySpot?.label || '';
    $('#parkingTermsText').textContent = area
      ? 'I accept the parking terms and understand this reservation guarantees parking within the highlighted area, not a particular numbered stall.'
      : `I accept the parking terms and will park only in space ${space} during my ${term} stay.`;
    const monthlyRate = core.money(quote.quote.recurringUnitRateCents);
    const whenRows = monthly
      ? `<div><dt>Starts</dt><dd>${escapeHtml(core.humanTime(quote.arrival, quote.timezone))}</dd></div><div><dt>Billing</dt><dd>${escapeHtml(monthlyRate)} on the 1st of each month · first month prorated · no end date</dd></div>`
      : `<div><dt>Arrive</dt><dd>${escapeHtml(core.humanTime(quote.arrival, quote.timezone))}</dd></div><div><dt>Leave by</dt><dd>${escapeHtml(core.humanTime(quote.departure, quote.timezone))}</dd></div>`;
    $('#selectedParkingSummary').innerHTML = `<div class="summary-heading"><p class="card-kicker">YOUR RESERVATION</p><h2>${escapeHtml(state.canonicalLot?.name || 'Trucker Heaven Parking')}</h2><p>${escapeHtml(state.canonicalLot?.address || '')}</p></div><dl class="review-facts"><div><dt>Parking</dt><dd>${escapeHtml(term)} · ${escapeHtml(parkingAreaName(state.selected) || meta.label)}</dd></div>${picked ? `<div><dt>Your space</dt><dd>${escapeHtml(space || 'Pick a space')}</dd></div>` : ''}${whenRows}</dl>${quoteDetails(quote)}<div class="summary-assignment-note"><strong>${area ? 'Your Parking Area' : monthly ? 'Pay at the office' : 'Pay when you leave'}</strong><p>${area ? `Choose any physically available position inside ${escapeHtml(parkingAreaName(state.selected))}.` : monthly ? `Space ${escapeHtml(space)} stays yours month to month. Pay the first month at the office, then ${escapeHtml(monthlyRate)} on the 1st.` : `Space ${escapeHtml(space)} is yours for the stay. Pay ${escapeHtml(core.money(quote.quote.totalCents))} at the Trucker Heaven office when you leave.`}</p></div>`;
  }
  function bookingPayload(form) {
    const data = new FormData(form); data.delete('insuranceDocument');
    const values = Object.fromEntries(data);
    return { ...state.trip, ...values, ...(state.selectedMonthlySpot ? { selectedSpotId: state.selectedMonthlySpot.id } : {}), quoteToken: state.quote.data?.quoteToken, termsVersion: state.quote.data?.terms?.version || state.quote.data?.quote?.termsVersion, termsAccepted: form.termsAccepted.checked, cancellationTermsAccepted: form.cancellationTermsAccepted.checked };
  }
  const PAYMENT_ATTEMPT_KEY = 'parkingops.payment-attempt.v1';
  function storePaymentAttempt(value) { try { window.sessionStorage.setItem(PAYMENT_ATTEMPT_KEY, JSON.stringify(value)); } catch (_) { /* Secure lookup remains available. */ } }
  function storedPaymentAttempt() { try { return JSON.parse(window.sessionStorage.getItem(PAYMENT_ATTEMPT_KEY) || 'null'); } catch (_) { return null; } }
  async function uploadMonthlyInsurance(attempt, file) {
    if (!(file instanceof File) || !file.size) throw new Error('Choose an Insurance document.');
    const validated = clientDocument(file, 'Insurance');
    setMessage($('#bookingMessage'), 'Preparing insurance upload…');
    const started = await request(`/bookings/${encodeURIComponent(attempt.publicToken)}/documents/insurance/upload`, {
      method: 'POST', body: JSON.stringify({ lookupCredential: attempt.lookupCredential, filename: file.name, mimeType: validated.mimeType, sizeBytes: file.size })
    });
    await uploadFileWithProgress(started.upload, file, progress => setMessage($('#bookingMessage'), `Uploading Insurance securely… ${progress}%`));
    setMessage($('#bookingMessage'), 'Verifying the uploaded insurance document…');
    await request(`/bookings/${encodeURIComponent(attempt.publicToken)}/documents/complete`, {
      method: 'POST', body: JSON.stringify({ lookupCredential: attempt.lookupCredential, uploadToken: started.upload.token })
    });
  }
  function paymentPanel({ title, message, error = false, pending = false } = {}) {
    $('#paymentStep').innerHTML = `<section class="panel LiquidGlass GlassPanel payment-verification${error ? ' is-error' : ''}"><span class="confirmation-mark" aria-hidden="true">${error ? '!' : pending ? '…' : '✓'}</span><p class="card-kicker">SECURE PAYMENT</p><h2>${escapeHtml(title || 'Verifying payment')}</h2><p>${escapeHtml(message || 'ParkingOps is waiting for the verified Stripe payment event.')}</p>${pending ? '<p class="payment-wait"><strong>Do not close this page.</strong> This page cannot confirm parking until the server records the verified payment.</p>' : ''}${error ? '<div class="lifecycle-actions"><a class="button GlassButton secondary-button" href="#parking" data-route="parking">Start again</a><a class="text-link" href="#lookup" data-route="lookup">Secure reservation lookup</a></div>' : ''}</section>`;
    focusRouteHeading($('#paymentStep'));
  }
  function demoTokenFromRoute(rawRoute) {
    const query = String(rawRoute || '').split('?')[1] || '';
    const value = new URLSearchParams(query).get('token') || '';
    return value.length >= 32 && value.length <= 200 ? value : '';
  }
  function demoPaymentPanel() {
    const demo = state.demoPayment; const authorization = demo.authorization;
    if (demo.loading) return paymentPanel({ title: 'Validating QA authorization', message: 'The server is checking this short-lived one-time Demo session.', pending: true });
    if (demo.error) return paymentPanel({ title: 'Demo authorization unavailable', message: demo.error, error: true });
    if (demo.completed) {
      $('#paymentStep').innerHTML = `<section class="panel LiquidGlass GlassPanel payment-verification"><span class="confirmation-mark" aria-hidden="true">✓</span><p class="card-kicker">QA / DEMO SESSION ONLY</p><h2>Demo reservation confirmed</h2><p>This operational QA reservation is active. No card was charged and no payment or revenue was recorded.</p><dl class="review-facts"><div><dt>Reservation</dt><dd>${escapeHtml(authorization.reservationNumber)}</dd></div><div><dt>Payment</dt><dd>DEMO / NO PAYMENT</dd></div><div><dt>Amount</dt><dd>${escapeHtml(core.money(authorization.price.amountCents))}</dd></div><div><dt>Financially paid</dt><dd>NO</dd></div></dl><div class="lifecycle-actions"><a class="button GlassButton primary-action" href="#my-parking" data-route="my-parking">Open My Parking</a><a class="text-link" href="#upload-documents" data-route="upload-documents">Upload documents later</a></div></section>`;
      focusRouteHeading($('#paymentStep')); return;
    }
    $('#paymentStep').innerHTML = `<section class="panel LiquidGlass GlassPanel payment-verification"><p class="card-kicker">QA / DEMO SESSION ONLY</p><h2>Complete Demo Reservation</h2><p>This one-time server authorization is bound to reservation ${escapeHtml(authorization.reservationNumber)}. It activates parking for operational QA without creating a Stripe object or recording revenue.</p><dl class="review-facts"><div><dt>Parking</dt><dd>${escapeHtml(durationName(authorization.parkingProduct))}</dd></div>${authorization.selectedPosition ? `<div><dt>Selected position</dt><dd>${escapeHtml(authorization.selectedPosition)}</dd></div>` : ''}<div><dt>Amount</dt><dd>${escapeHtml(core.money(authorization.price.amountCents))}</dd></div><div><dt>Financially paid</dt><dd>NO</dd></div></dl><button class="button GlassButton primary-action" type="button" data-complete-demo>Complete Demo Reservation</button><p class="privacy-note">The authorization expires ${escapeHtml(core.humanTime(authorization.expiresAt))} and can be used only once.</p></section>`;
    focusRouteHeading($('#paymentStep'));
  }
  async function renderDemoPayment(rawRoute) {
    const routeToken = demoTokenFromRoute(rawRoute);
    if (!routeToken && state.demoPayment.completed) return demoPaymentPanel();
    if (!routeToken) {
      state.demoPayment = { token: '', authorization: null, loading: false, completed: false, error: 'A valid one-time Demo authorization is required.' };
      return demoPaymentPanel();
    }
    if (state.demoPayment.token === routeToken && (state.demoPayment.authorization || state.demoPayment.loading || state.demoPayment.error)) return demoPaymentPanel();
    state.demoPayment = { token: routeToken, authorization: null, loading: true, completed: false, error: '' }; demoPaymentPanel();
    try {
      const result = await request('/payments/demo/authorization', { method: 'POST', body: JSON.stringify({ token: routeToken }) });
      state.demoPayment.authorization = result.demoAuthorization; state.demoPayment.loading = false;
    } catch (error) {
      state.demoPayment.loading = false; state.demoPayment.error = error.publicMessage || 'This Demo authorization is invalid, expired, used, or disabled.';
    }
    demoPaymentPanel();
  }
  async function completeDemoPayment(button) {
    if (state.demoPayment.loading || state.demoPayment.completed || !state.demoPayment.token) return;
    button.disabled = true; state.demoPayment.loading = true; demoPaymentPanel();
    try {
      const result = await request('/payments/demo/confirm', { method: 'POST', timeoutMs: 25000,
        body: JSON.stringify({ token: state.demoPayment.token }) });
      state.demoPayment.authorization = result.reservation; state.demoPayment.completed = true;
      state.demoPayment.token = ''; state.demoPayment.error = '';
      window.history.replaceState({ route: 'demo-payment' }, '', '#demo-payment');
    } catch (error) {
      state.demoPayment.error = error.publicMessage || 'The Demo reservation could not be completed.';
    } finally { state.demoPayment.loading = false; demoPaymentPanel(); }
  }
  function wait(milliseconds) { return new Promise(resolve => window.setTimeout(resolve, milliseconds)); }
  async function handlePaymentReturn(cancelled = false) {
    if (state.paymentReturnRunning) return;
    const attempt = storedPaymentAttempt();
    if (!attempt?.publicToken || !attempt.lookupCredential || !attempt.reservationNumber) {
      paymentPanel({ title: 'Secure lookup required', message: 'This browser does not have the protected payment-return details. Use your reservation reference and secure lookup credential.', error: true });
      return;
    }
    if (cancelled) {
      paymentPanel({ title: 'Checkout canceled', message: 'No paid parking reservation was confirmed. Any temporary Monthly space hold will be released or expire; ParkingOps did not silently choose another space.', error: true });
      return;
    }
    state.paymentReturnRunning = true; paymentPanel({ pending: true });
    try {
      for (let check = 0; check < 30; check += 1) {
        const response = await request('/payments/status', { method: 'POST', body: JSON.stringify({ publicToken: attempt.publicToken, lookupCredential: attempt.lookupCredential }) });
        if (response.booking?.confirmed === true && response.booking?.paymentStatus === 'PAID') {
          const booking = await fetchReservation({ reservationNumber: attempt.reservationNumber, lookupCredential: attempt.lookupCredential });
          updateActiveBooking(booking, attempt.lookupCredential, attempt.contact || '', { persist: true });
          try { window.sessionStorage.removeItem(PAYMENT_ATTEMPT_KEY); } catch (_) {}
          state.paymentReturnRunning = false;
          navigate('confirmation', { replace: true, reservationNumber: booking.reservationNumber });
          return;
        }
        if (['FAILED', 'EXPIRED', 'CANCELLED'].includes(response.booking?.paymentStatus)) {
          paymentPanel({ title: 'Payment was not completed', message: 'This attempt is not a valid parking authorization. Choose current availability and start again.', error: true });
          return;
        }
        await wait(2000);
      }
      paymentPanel({ title: 'Payment verification is still pending', message: 'ParkingOps has not received a final verified Stripe event yet. Your browser arriving here is not treated as proof of payment. Use secure lookup or contact parking support.', error: true });
    } catch (error) {
      paymentPanel({ title: 'Payment status could not be verified', message: error.publicMessage || requestErrorMessage(core.classifyError(error), 'payment verification'), error: true });
    } finally { state.paymentReturnRunning = false; }
  }
  async function reserveParking(event) {
    event.preventDefault(); if (!core.bookingCanContinue(state) || !state.trip) return setMessage($('#bookingMessage'), 'Request a valid current quote before continuing.', true);
    if (state.submission.status === core.SUBMISSION_STATUS.SUBMITTING) return;
    const form = event.currentTarget; const payload = bookingPayload(form); const fingerprint = core.payloadFingerprint({ trip: state.search.fingerprint, offerKey: state.selected.offerKey, ...payload });
    if (!state.bookingKey || state.bookingKey.fingerprint !== fingerprint) state.bookingKey = { attemptKey: core.randomOperationKey(), checkoutKey: core.randomOperationKey(), fingerprint };
    state.submission = { status: core.SUBMISSION_STATUS.SUBMITTING, error: '' }; const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
    try {
      // No online payment: the booking is confirmed now and paid at the Trucker Heaven office.
      setMessage($('#bookingMessage'), 'Confirming your parking…');
      let response;
      try {
        response = await request('/bookings', { method: 'POST', timeoutMs: 25000, headers: { 'Idempotency-Key': state.bookingKey.attemptKey }, body: JSON.stringify(payload) });
      } catch (error) {
        if (!core.ambiguousBookingFailure(error)) throw error;
        response = await request('/bookings', { method: 'POST', timeoutMs: 25000, headers: { 'Idempotency-Key': state.bookingKey.attemptKey }, body: JSON.stringify(payload) });
      }
      const created = response.booking;
      if (!created?.reservationNumber || !created.lookupCredential) throw new Error('Invalid booking response.');
      const insuranceFile = $('#insuranceCamera')?.files?.[0] || $('#insuranceDocument')?.files?.[0];
      if (insuranceFile && created.publicToken) {
        try { await uploadMonthlyInsurance(created, insuranceFile); } catch (_) { /* the booking stands; insurance can be uploaded later */ }
      }
      const booking = await fetchReservation({ reservationNumber: created.reservationNumber, lookupCredential: created.lookupCredential });
      updateActiveBooking(booking, created.lookupCredential, payload.email || payload.mobilePhone || '', { persist: true });
      state.submission = { status: core.SUBMISSION_STATUS.SUCCESS, error: '' }; state.bookingKey = null;
      setMessage($('#bookingMessage'), '');
      navigate('confirmation', { reservationNumber: booking.reservationNumber });
    } catch (error) {
      if (['MONTHLY_POSITION_UNAVAILABLE','QUOTED_SPACE_UNAVAILABLE'].includes(error?.code)) {
        state.submission = { status: core.SUBMISSION_STATUS.ERROR, error: 'That space was just taken. Pick another open space.' };
        await changeMonthlySpot(); navigate('offers'); setMessage($('#availabilityMessage'), state.submission.error, true); return;
      }
      if (!core.ambiguousBookingFailure(error)) state.bookingKey = null;
      const controlled = error?.publicMessage || 'We could not confirm the booking. Please try again or call the office.';
      state.submission = { status: core.SUBMISSION_STATUS.ERROR, error: controlled };
      setMessage($('#bookingMessage'), state.submission.error, true);
    } finally { submit.disabled = false; if (state.submission.status === core.SUBMISSION_STATUS.SUBMITTING) state.submission.status = core.SUBMISSION_STATUS.IDLE; }
  }

  function bookingIsMonthly(booking) { return (booking?.price?.duration || booking?.parkingProduct) === 'MONTHLY'; }
  function statusWord(status) { return ({ CONFIRMED: 'Confirmed', CHECKED_IN: 'Parked', CHECKED_OUT: 'Checked out', COMPLETED: 'Completed', CANCELLED: 'Cancelled', NO_SHOW: 'No-show', EXPIRED: 'Expired', PENDING: 'Waiting for the office' })[status] || String(status || '').toLowerCase(); }
  function paymentLine(booking) {
    const monthly = bookingIsMonthly(booking); const total = booking.price?.totalCents;
    if (['CANCELLED','EXPIRED','NO_SHOW'].includes(booking.status)) return 'Nothing to pay';
    if (booking.paymentStatus === 'PAID') return 'Paid';
    if (monthly) return `${total != null ? `${core.money(total)} for the first month, then ${core.money(booking.price?.recurringUnitRateCents || booking.price?.unitRateCents || 0)} on the 1st` : 'Due on the 1st'} · at the office`;
    return `${total != null ? `${core.money(total)} ` : ''}at the office when you leave`;
  }
  function reservationFacts(booking) {
    const monthly = bookingIsMonthly(booking); const picked = monthlySelectedMode(booking);
    return `<section class="reservation-facts"><div><span>Reservation</span><strong>${escapeHtml(booking.reservationNumber)}</strong><small>${escapeHtml(statusWord(booking.status))}</small></div><div><span>${picked ? 'Your space' : 'Parking area'}</span><strong>${escapeHtml(picked ? (booking.assignedSpotLabel ? `Space ${booking.assignedSpotLabel}` : 'Assigned at check-in') : parkingAreaName(booking))}</strong><small>${escapeHtml(durationName(booking.price?.duration))} · ${escapeHtml(booking.category || 'Parking')}</small></div><div><span>${monthly ? 'Starts' : 'Arrive'}</span><strong>${escapeHtml(core.humanTime(booking.arrival, booking.timezone))}</strong></div>${monthly ? '<div><span>Ends</span><strong>No end date</strong><small>Tell the office when you leave</small></div>' : `<div><span>Leave by</span><strong>${escapeHtml(core.humanTime(booking.departure, booking.timezone))}</strong></div>`}<div><span>Pay</span><strong>${escapeHtml(paymentLine(booking))}</strong>${booking.paidThrough ? `<small>Paid through ${escapeHtml(core.humanTime(booking.paidThrough, booking.timezone))}</small>` : ''}</div><div><span>Truck</span><strong>${escapeHtml(booking.tractorUnitNumber || 'Not available')}</strong><small>${escapeHtml([booking.licensePlate, booking.licensePlateState, booking.trailerNumber && `Trailer ${booking.trailerNumber}`].filter(Boolean).join(' · '))}</small></div>${booking.companyName ? `<div><span>Company / Carrier</span><strong>${escapeHtml(booking.companyName)}</strong></div>` : ''}</section>`;
  }
  function parkingAuthorizationCard(booking, view) {
    if (!view.exact) return `<div class="assigned-space-card parking-area-card${view.active ? '' : ' is-pending'}"><span>YOUR PARKING AREA</span><strong>${escapeHtml(view.areaName)}</strong><small>${escapeHtml(view.active ? 'Park anywhere available inside the highlighted area' : 'Not active')}</small></div>`;
    return `<div class="assigned-space-card${view.showAssignedSpace ? '' : ' is-pending'}"><span>YOUR SPACE</span><strong>${escapeHtml(view.assignedSpace)}</strong><small>${escapeHtml(view.active ? (view.showAssignedSpace ? 'Park only in this space' : 'Assigned at check-in') : 'Not active')}</small></div>`;
  }
  function propertyDirectionsLink(booking, className = 'button secondary-button') { return booking?.roadDirectionsUrl ? `<a class="${className}" href="${escapeHtml(booking.roadDirectionsUrl)}" target="_blank" rel="noopener">Get Directions to Property</a>` : ''; }
  function recoveryDetails(booking) {
    if (!state.activeCredential) return state.bookingRecovery ? `<div class="message error" role="alert">${escapeHtml(state.bookingRecovery)} ${supportLink('text-link')}</div>` : '';
    return `<p class="privacy-note">To find this reservation later, open <a href="#my-parking" data-route="my-parking">My Parking</a> and enter the email and phone you booked with, or use the link in your confirmation message.</p>`;
  }
  function rememberControl(booking) {
    if (!state.activeCredential) return '';
    const remembered = activeRecentEntry(booking.reservationNumber)?.source === 'remembered';
    return `<div class="remember-control"><label class="check"><input type="checkbox" data-remember-reservation ${remembered ? 'checked' : ''}><span>Keep this reservation open on this phone</span></label><p>Skip the sign-in next time you open the site here. Leave this off on a shared device.</p></div>`;
  }
  function statusBanner(booking) {
    const view = core.reservationStatusView(booking); const mark = view.icon === 'success' ? '✓' : view.icon === 'pending' ? '…' : view.icon === 'active' ? '●' : '—';
    return `<section class="confirmation-banner status-${view.tone}"><div class="confirmation-title"><span class="confirmation-mark" aria-hidden="true">${mark}</span><div><p class="card-kicker">${escapeHtml(view.documentLabel)}</p><h2>${escapeHtml(view.heading)}</h2><p>${escapeHtml(view.description)} Confirmation ${escapeHtml(booking.reservationNumber)}.</p></div></div>${parkingAuthorizationCard(booking, view)}</section>`;
  }
  function bookingActions(booking, { confirmation = false } = {}) {
    const view = core.reservationStatusView(booking); const actions = [];
    if (view.mapValid) actions.push(`<a class="button" href="#map" data-route="map">${view.exact ? 'Where to park' : 'View Highlighted Parking Area'}</a>`);
    actions.push('<button type="button" class="button secondary-button" data-open-management>Manage Reservation</button>');
    if (booking.manageBillingAvailable) actions.push('<button type="button" class="button secondary-button" data-manage-billing>Manage Billing</button>');
    if (booking.roadDirectionsUrl) actions.push(propertyDirectionsLink(booking));
    if (view.canPrint) actions.push('<button type="button" class="button secondary-button" data-print-pass>Print / Save</button>');
    if (view.pollAssignment && state.activeCredential) actions.push('<button type="button" class="button secondary-button" data-check-assignment>Check assignment</button>');
    if (!confirmation) {
      if (view.canCheckIn) actions.push('<button type="button" class="button self-service-button" data-self-action="check-in">I Have Arrived</button>');
      if (view.canCheckOut) actions.push('<button type="button" class="button self-service-button" data-self-action="check-out">I Have Left the Lot</button>');
      if (view.canCancel) actions.push('<button type="button" class="button danger-button" data-cancel-pass>Cancel Reservation</button>');
    }
    actions.push('<a class="button secondary-button" href="#parking" data-route="parking">Back to Parking</a>');
    return actions.join('');
  }
  function pollingStatusHtml(booking) {
    const view = core.reservationStatusView(booking); const checked = state.lastCheckedAt ? core.humanTime(state.lastCheckedAt, booking.timezone) : 'Not checked yet';
    return `<div>${statusBanner(booking)}</div>${view.pollAssignment ? `<section class="pending-assignment"><strong>Assignment pending</strong><p>We will update this status without replacing the page or moving keyboard focus.</p><small>Last checked: ${escapeHtml(checked)}${state.pollingMessage ? ` · ${escapeHtml(state.pollingMessage)}` : ''}</small></section>` : ''}${state.bookingCached ? '<p class="cached-state">Could not refresh current status. Showing saved last-known information.</p>' : ''}`;
  }
  function updateConfirmationDynamic(force = false) {
    const booking = state.activeBooking; if (!booking || state.currentRoute !== 'confirmation') return;
    const signature = core.stableStringify({ status: booking.status, mode: booking.assignmentMode, area: booking.parkingArea?.name, assigned: booking.assignedSpotLabel, map: Boolean(booking.map), poll: state.pollingMessage, checked: state.lastCheckedAt?.toISOString(), cached: state.bookingCached });
    if (!force && signature === state.confirmationSignature) return; state.confirmationSignature = signature;
    const status = $('#confirmationStatusRegion'); const actions = $('#confirmationActions');
    if (status) status.innerHTML = pollingStatusHtml(booking);
    const actionSignature = core.stableStringify({ status: booking.status, mode: booking.assignmentMode, area: booking.parkingArea?.name, assigned: booking.assignedSpotLabel, map: Boolean(booking.map), credential: Boolean(state.activeCredential) });
    if (actions && (force || actionSignature !== state.confirmationActionSignature)) { actions.innerHTML = bookingActions(booking, { confirmation: true }); state.confirmationActionSignature = actionSignature; }
  }
  function bookingLotSvg(booking) {
    const elements = Array.isArray(booking?.map?.elements) ? booking.map.elements : [];
    if (!elements.length || !window.LotPlan || !window.LotPlanData) return '';
    const exact = exactMode(booking); const states = new Map(); let mine = null;
    for (const element of elements) {
      const number = element?.space?.number; if (!number) continue;
      if (exact) { if (element.assigned) mine = String(number); states.set(String(number), 'off'); }
      else {
        // The inventory covers every truck space; only the ones eligible for this term are the area.
        const eligible = booking.price?.duration === 'MONTHLY' ? element.space.monthlyEligible !== false : element.space.dailyEligible !== false;
        states.set(String(number), element.permitted && eligible ? 'area' : 'off');
      }
    }
    if (exact && !mine) return '';
    return window.LotPlan.render(window.LotPlanData, {
      states, selected: mine, interactive: false,
      title: exact ? `Lot map. Space ${mine} is yours.` : 'Lot map. The highlighted spaces are the area you can park in.'
    });
  }
  function confirmationLot(booking) {
    const view = core.reservationStatusView(booking); if (!view.mapValid) return '';
    const svg = bookingLotSvg(booking); if (!svg) return '';
    const exact = exactMode(booking); const name = parkingAreaName(booking);
    const heading = exact ? `Your space: ${escapeHtml(booking.assignedSpotLabel)}` : `Where to park: ${escapeHtml(name)}`;
    const copy = exact ? `Park only in space ${escapeHtml(booking.assignedSpotLabel)}. The Entrance / Exit is on Eastgate Blvd.` : 'Park in any open space inside the highlighted area. The Entrance / Exit is on Eastgate Blvd.';
    const legend = exact ? '<span><i class="sw is-mine"></i>Your space</span>' : '<span><i class="sw is-area"></i>Your parking area</span>';
    return `<section class="monthly-selector confirmation-lot" aria-label="Lot map"><div class="monthly-selector-head"><div><p class="card-kicker">INSIDE THE LOT</p><h3>${heading}</h3><p>${copy}</p></div></div><div class="map-stage monthly-map-stage" data-map-stage tabindex="0" aria-label="Lot map. Use plus and minus to zoom, and Fit lot to restore the whole property."><div class="map-controls" aria-label="Map controls"><button type="button" data-map-zoom="in" aria-label="Zoom in">+</button><button type="button" data-map-zoom="out" aria-label="Zoom out">−</button><button type="button" data-map-zoom="fit" aria-label="Fit entire lot">Fit lot</button></div><div class="plan-canvas" style="height:${Math.round(100 * state.mapZoom)}%">${svg}</div></div><div class="plan-legend">${legend}<span><i class="sw is-off"></i>Not for this booking</span></div></section>`;
  }
  function renderConfirmationView() {
    const booking = state.activeBooking; if (!booking) return; state.confirmationSignature = ''; state.confirmationActionSignature = '';
    const verified = booking.authoritative === true && ['PAID','NOT_REQUIRED'].includes(String(booking.paymentStatus || 'NOT_REQUIRED'));
    const saved = verified
      ? `<section class="reservation-saved" role="status"><p class="card-kicker">${`${durationName(booking.price?.duration).toUpperCase()} PARKING CONFIRMED`}</p><h2>${booking.assignedSpotLabel ? `SPACE ${escapeHtml(booking.assignedSpotLabel)} IS YOURS.` : 'YOU’RE BOOKED.'}</h2><p>${escapeHtml(paymentLine(booking))}. Nothing to pay online.</p></section>`
      : '<section class="reservation-saved is-checking" role="status"><p class="card-kicker">CHECKING RESERVATION STATUS…</p><p>We’re confirming your reservation.</p></section>';
    $('#confirmation').innerHTML = `<div class="panel LiquidGlass GlassPanel confirmation-view">${saved}<div id="confirmationStatusRegion" class="confirmation-live" role="status" aria-live="polite"></div>${reservationFacts(booking)}${confirmationLot(booking)}${recoveryDetails(booking)}${rememberControl(booking)}<div id="confirmationActions" class="pass-actions confirmation-actions"></div></div>`;
    updateConfirmationDynamic(true);
  }
  function passDocument(booking) {
    const view = core.reservationStatusView(booking); const activeClass = view.passValid ? 'active-pass' : 'inactive-pass';
    const authorization = view.exact
      ? `<div><dt>Your space</dt><dd>${escapeHtml(view.assignedSpace)}</dd></div>`
      : `<div><dt>Parking area</dt><dd>${escapeHtml(view.areaName)}</dd></div>`;
    const arrival = view.mapValid
      ? `<section class="arrival-callout"><strong>${view.exact ? `Park in space ${escapeHtml(booking.assignedSpotLabel)}` : `Your Parking Area: ${escapeHtml(view.areaName)}`}</strong><p>${view.exact ? (`Park only in space ${escapeHtml(booking.assignedSpotLabel)}. The Entrance / Exit is on Eastgate Blvd.`) : 'Park in any available parking position inside the highlighted area.'}</p></section>`
      : `<section class="pending-assignment"><strong>${escapeHtml(view.active ? (view.exact ? view.assignedSpace : view.areaName) : 'Not an active parking authorization')}</strong><p>${escapeHtml(view.description)}</p></section>`;
    return `<article class="digital-pass printable-pass ${activeClass} status-${view.tone}"><div class="pass-status"><span>${escapeHtml(view.label)}</span><strong>Confirmation ${escapeHtml(booking.reservationNumber)}</strong></div>${statusBanner(booking)}${reservationFacts(booking)}${arrival}${confirmationLot(booking)}<div class="pass-details"><section><h3>Reservation details</h3><dl><div><dt>Status</dt><dd>${escapeHtml(view.label)}</dd></div>${authorization}<div><dt>Parking period</dt><dd>${escapeHtml(durationName(booking.price?.duration))}</dd></div></dl></section></div></article>`;
  }
  function renderDedicatedPass() {
    const booking = state.activeBooking; const view = core.reservationStatusView(booking); if (!booking) return;
    $('#passContent').innerHTML = `<div class="view-page-head"><div><p class="eyebrow">${escapeHtml(view.documentLabel)}</p><h1 id="passViewTitle">${escapeHtml(view.heading)}</h1></div><a class="text-link" href="#parking" data-route="parking">Back to Parking</a></div>${passDocument(booking)}<div class="pass-actions">${bookingActions(booking)}</div>`;
  }
  function renderManagementView() {
    const booking = state.activeBooking; const view = core.reservationStatusView(booking); if (!booking) return;
    $('#managementContent').innerHTML = `<div class="view-page-head"><div><p class="eyebrow">MY RESERVATION</p><h1 id="managementTitle">Reservation ${escapeHtml(booking.reservationNumber)}</h1></div><a class="text-link" href="#parking" data-route="parking">Back to Parking</a></div><section class="panel LiquidGlass GlassPanel management-card status-${view.tone}"><div class="management-status"><span>${escapeHtml(view.label)}</span><div><small>${view.exact ? 'Your space' : 'Parking area'}</small><strong>${escapeHtml(view.exact ? view.assignedSpace : view.areaName)}</strong></div></div>${state.bookingCached ? '<p class="cached-state">Could not refresh current status. Showing saved information.</p>' : ''}${reservationFacts(booking)}<div class="pass-details"><section><h3>Reservation status</h3><p>${escapeHtml(view.description)}</p>${view.exact ? `<p>Park only in space ${escapeHtml(booking.assignedSpotLabel || '')}.</p>` : '<p>Park in any available parking position inside the highlighted area.</p>'}</section><section><h3>Price</h3>${booking.price ? quoteDetails(booking.price) : '<p>Price information is unavailable.</p>'}</section></div>${rememberControl(booking)}<div class="pass-actions">${bookingActions(booking)}<button type="button" class="text-button remove-device-action" data-remove-active>Remove from this device</button></div></section>`;
  }

  function mapPresentation(element, booking) {
    const type = String(element?.elementType || '').toUpperCase();
    if (type === 'PARKING_SPOT') return {
      label: exactMode(booking) && element.space?.publicBookable === true ? String(element.label || '') : '',
      kind: 'space',
      quiet: element.space?.publicBookable !== true
    };
    if (type === 'LABEL' || type === 'PARKING_ZONE') return { label: String(element.label || element.zone?.name || ''), kind: type === 'LABEL' ? 'label' : 'area' };
    if (type === 'DRIVE_LANE') return { label: '', kind: 'lane', quiet: true };
    if (type === 'ENTRANCE') return { label: '', kind: 'entrance', quiet: true };
    if (['PROPERTY_BOUNDARY', 'ISLAND', 'BARRIER', 'BUILDING', 'OFFICE', 'CHECK_IN', 'RESTRICTED_AREA'].includes(type)) return { label: '', kind: type === 'PROPERTY_BOUNDARY' ? 'boundary' : type === 'ISLAND' || type === 'BARRIER' ? 'island' : 'building', quiet: true };
    return null;
  }
  function mapElementClass(element, booking, presentation) {
    const route = core.routeElementKeys(booking?.map); const assigned = exactMode(booking) && element.assigned && core.reservationStatusView(booking).mapValid;
    const category = element.inventory?.categoryCode === 'BOBTAIL' ? ' is-bobtail-space' : element.inventory?.categoryCode === 'TRACTOR_TRAILER' ? ' is-general-space' : '';
    const areaState = !exactMode(booking) && element.space ? (element.permitted ? ' is-permitted-area' : ' is-outside-area') : '';
    return `map-element map-${presentation.kind}${assigned ? ' is-assigned' : ''}${route.has(element.elementKey) ? ' is-route' : ''}${element.space && exactMode(booking) && !assigned ? ' is-confirmation-muted' : ''}${areaState}${presentation.quiet ? ' is-customer-quiet' : ''}${category}`;
  }
  function renderMapElement(element, booking) {
    const presentation = mapPresentation(element, booking); if (!presentation) return '';
    const values = [element.x, element.y, element.width, element.height].map(Number); if (!values.every(Number.isFinite)) return '';
    return `<div class="${mapElementClass(element, booking, presentation)}" style="left:${values[0]}%;top:${values[1]}%;width:${values[2]}%;height:${values[3]}%;transform:rotate(${Number(element.rotation || 0)}deg);z-index:${Number(element.layerOrder || 0)}">${presentation.label ? `<span>${escapeHtml(presentation.label)}</span>` : ''}</div>`;
  }
  function authoritativeRouteSvg(map) {
    const points = core.authoritativeRoutePoints(map); if (!points.length) return '';
    return `<svg class="customer-navigation-route" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points.map(point => `${Number(point.x)},${Number(point.y)}`).join(' ')}"/></svg>`;
  }
  function entranceMarker(map) {
    const entrance = core.resolveEntrance(map); if (!entrance) return '';
    return `<div class="customer-entrance-marker" style="left:${entrance.x}%;top:${entrance.y}%"><span aria-hidden="true">↕</span><strong>Entrance / Exit</strong></div>`;
  }
  function renderMap(map, booking) {
    const elements = Array.isArray(map?.elements) ? map.elements : []; if (!elements.length) return '<p class="empty-state">The current customer-safe map is unavailable. Follow written directions or contact parking support.</p>';
    const entrance = core.resolveEntrance(map); const line = core.authoritativeRoutePoints(map).length > 1;
    const suppliedAspect = typeof map.aspectRatio === 'number' ? map.aspectRatio : Number(map.aspectRatio?.width) / Number(map.aspectRatio?.height);
    const aspectStyle = Number.isFinite(suppliedAspect) && suppliedAspect > 0 ? `;--map-aspect:${suppliedAspect}` : '';
    const area = !exactMode(booking); const highlighted = area ? parkingAreaName(booking) : `assigned Space ${booking.assignedSpotLabel}`;
    return `<div class="map-stage" data-map-stage tabindex="0" aria-label="Interactive parking map. Use plus and minus to zoom, Home or zero to fit, and arrow keys to pan when zoomed."><div class="map-controls" aria-label="Map controls"><button type="button" data-map-zoom="in" aria-label="Zoom in">+</button><button type="button" data-map-zoom="out" aria-label="Zoom out">−</button><button type="button" data-map-zoom="fit" aria-label="Fit entire lot">Fit entire lot</button></div><div class="map-canvas" style="--map-scale:${state.mapZoom}${aspectStyle}"><div class="lot-map customer-map${state.mapZoom > 1 ? ' is-detail-zoom' : ''}" role="img" aria-label="Customer-safe lot map highlighting ${escapeHtml(highlighted)}">${elements.map(element => renderMapElement(element, booking)).join('')}${authoritativeRouteSvg(map)}${entranceMarker(map)}<div class="map-area-label">${escapeHtml(area ? parkingAreaName(booking) : `Selected position ${booking.assignedSpotLabel}`)}</div></div></div></div><div class="map-legend"><span class="${area ? 'legend-permitted' : 'legend-assigned'}">${area ? 'Highlighted permitted parking area' : monthlySelectedMode(booking) ? 'Selected monthly position' : 'Historical assigned space'}</span><span class="legend-route">${line ? 'Marked circulation route' : 'Entrance / Exit and permitted area'}</span><span class="legend-map-info">${entrance ? 'Entrance / Exit shown on map' : 'Entrance / Exit location unavailable on map; follow written directions'}</span><span>${area ? 'Park in any physically available position inside the highlighted area.' : monthlySelectedMode(booking) ? 'Park only in the selected monthly position during the reservation period.' : 'Fit shows the full property. Zoom in to view nearby public stall numbers.'}</span></div>${entrance ? '' : '<p class="message error">The map response does not contain enough safe geometry to place the shared Entrance / Exit marker.</p>'}`;
  }
  function renderDedicatedMap() {
    const booking = state.activeBooking; if (!core.reservationStatusView(booking).mapValid) return;
    const area = !exactMode(booking); const monthly = monthlySelectedMode(booking); const name = parkingAreaName(booking);
    $('#mapContent').innerHTML = `<div class="view-page-head"><div><p class="eyebrow">INSIDE THE LOT</p><h1 id="mapViewTitle">${area ? `Your Parking Area: ${escapeHtml(name)}` : `Your space: ${escapeHtml(booking.assignedSpotLabel)}`}</h1><p>${area ? 'The permitted area is highlighted while the complete property remains visible.' : 'Come in through the Entrance / Exit on Eastgate Blvd and follow the route to your space.'}</p></div><a class="text-link" href="#parking" data-route="parking">Back to Parking</a></div><section class="panel LiquidGlass GlassPanel dedicated-map"><div class="assigned-navigation-card"><span>${area ? 'YOUR PARKING AREA' : 'YOUR SPACE'}</span><strong>${area ? escapeHtml(name) : `Position ${escapeHtml(booking.assignedSpotLabel)}`}</strong><p>${area ? 'Park in any available parking position inside the highlighted area.' : `Park only in space ${escapeHtml(booking.assignedSpotLabel || '')}.`}</p></div>${renderMap(booking.map, booking)}<div class="written-directions"><div><p class="card-kicker">FROM THE ENTRANCE</p><p>${escapeHtml(booking.arrivalDirections || (area ? `Follow signs toward ${name} and use any physically available position inside the highlighted area.` : `Follow the highlighted route to Position ${booking.assignedSpotLabel}.`))}</p></div><div><p class="card-kicker">TO THE PROPERTY</p><p>External maps guide you to the property.</p>${propertyDirectionsLink(booking, 'text-link')}</div></div></section><div class="lifecycle-actions"><a class="button GlassButton secondary-button" href="#pass" data-route="pass">View reservation document</a><button class="button GlassButton secondary-button" data-open-management>Manage Reservation</button></div>`;
    applyMapZoom();
  }
  function applyMapZoom() {
    $$('.customer-map').forEach(map => map.classList.toggle('is-detail-zoom', state.mapZoom > 1));
    $$('.map-canvas').forEach(canvas => canvas.style.setProperty('--map-scale', state.mapZoom));
    $$('.plan-canvas').forEach(canvas => { canvas.style.height = `${Math.round(100 * state.mapZoom)}%`; });
    $$('[data-map-stage]').forEach(stage => stage.classList.toggle('is-zoomed', state.mapZoom > 1));
    $$('[data-map-zoom="out"]').forEach(button => { button.disabled = state.mapZoom <= 1; });
  }
  function changeMapZoom(action, stage) {
    state.mapZoom = core.nextMapZoom(state.mapZoom, action);
    applyMapZoom(); if (action === 'fit') { const target = stage || $('[data-map-stage]'); if (target) { target.scrollLeft = 0; target.scrollTop = 0; } }
  }

  function recentCard(entry) {
    const view = core.reservationStatusView({ status: entry.status, assignmentMode: entry.assignmentMode, assignedSpotLabel: entry.assignedSpace, parkingArea: { name: entry.parkingArea || entry.parkingType } }); const refresh = state.refreshStates.get(entry.reservationNumber);
    const refreshText = refresh?.state === 'ok' ? 'Updated just now' : refresh?.state === 'authorization' ? 'Sign-in details no longer valid; showing saved information' : refresh?.state === 'missing' ? 'Reservation no longer available; showing saved information' : refresh?.state === 'error' ? 'Could not refresh; showing saved information' : 'Cached last-known information';
    return `<article class="panel recent-reservation-card status-${view.tone}" data-recent-card="${escapeHtml(entry.reservationNumber)}"><div><span class="status-chip">${escapeHtml(view.label)}</span><h2>${escapeHtml(entry.reservationNumber)}</h2><p>${escapeHtml(entry.parkingType || 'Parking reservation')} · ${escapeHtml(durationName(entry.parkingPeriod))}</p></div><dl><div><dt>Arrival</dt><dd>${entry.arrival ? escapeHtml(core.humanTime(entry.arrival, entry.timezone)) : 'Unavailable'}</dd></div><div><dt>Departure</dt><dd>${entry.departure ? escapeHtml(core.humanTime(entry.departure, entry.timezone)) : 'Unavailable'}</dd></div><div><dt>${view.exact ? 'Assigned space' : 'Parking area'}</dt><dd>${escapeHtml(view.exact ? view.assignedSpace : view.areaName)}</dd></div><div><dt>Storage</dt><dd>${entry.source === 'remembered' ? 'Remembered on this device' : 'Current browser session'}</dd></div></dl><p class="refresh-state">${escapeHtml(refreshText)}</p><div class="card-actions"><button type="button" class="button" data-view-recent="${escapeHtml(entry.reservationNumber)}">View Reservation</button><button type="button" class="text-button" data-refresh-recent="${escapeHtml(entry.reservationNumber)}">Refresh</button><button type="button" class="text-button" data-remove-recent="${escapeHtml(entry.reservationNumber)}">Remove</button></div></article>`;
  }
  function renderRecentReservations({ refresh = true } = {}) {
    refreshCombinedEntries();
    $('#reservationsContent').innerHTML = `<div class="view-page-head"><div><p class="eyebrow">MY RESERVATION</p><h1 id="reservationsTitle">Recent reservations</h1><p>Current-session, remembered, and cached states are labeled separately.</p></div><a class="text-link" href="#parking" data-route="parking">Find Parking</a></div>${state.recentReservations.length ? `<div class="recent-reservation-list">${state.recentReservations.map(recentCard).join('')}</div>` : `<div class="empty-state"><h2>No reservation is saved in this browser</h2><p>Use the secure lookup form to reopen one.</p></div>`}<section class="shared-device-notice"><strong>Using a shared device?</strong><p>Only explicitly remembered reservations persist after this browser session. Remove saved credentials when finished.</p></section><div class="lifecycle-actions"><a class="button" href="#lookup" data-route="lookup">Look up a reservation</a><a class="button secondary-button" href="#parking" data-route="parking">Find Parking</a>${state.recentReservations.length ? '<button type="button" class="button danger-button" data-clear-recent>Clear all from this device</button>' : ''}</div>`;
    if (refresh && state.recentReservations.length) refreshRecentReservations(state.recentReservations);
  }
  async function refreshRecentReservation(entry) {
    try {
      const booking = await fetchReservation(entry); const source = entry.source === 'remembered' ? 'remembered' : 'session';
      const updated = lifecycle.entryFromBooking(booking, entry.lookupCredential, entry.maskedContact, Date.now(), source);
      if (source === 'remembered') state.rememberedEntries = lifecycle.upsertRecent(state.rememberedEntries, updated, Date.now(), source); else state.sessionEntries = lifecycle.upsertRecent(state.sessionEntries, updated, Date.now(), source);
      state.refreshStates.set(entry.reservationNumber, { state: 'ok' });
    } catch (error) {
      const kind = core.classifyError(error); state.refreshStates.set(entry.reservationNumber, { state: kind === 'authorization' ? 'authorization' : kind === 'not_found' ? 'missing' : 'error' });
    }
  }
  async function refreshRecentReservations(entries) {
    await Promise.all(entries.map(entry => refreshRecentReservation(entry)));
    refreshCombinedEntries(); if (state.currentRoute === 'reservations' && window.history.state?.view !== 'management') renderRecentReservations({ refresh: false });
  }
  async function openRecentReservation(number, button) {
    const entry = activeRecentEntry(number); if (!entry) return; const expected = entry.reservationNumber; const startRoute = state.currentRoute; const token = state.reservationGate.begin(expected);
    if (button) { button.disabled = true; button.textContent = 'Opening…'; }
    try {
      const booking = await fetchReservation(entry); if (!state.reservationGate.current(token, expected) || state.currentRoute !== startRoute) return;
      updateActiveBooking(booking, entry.lookupCredential, entry.maskedContact); navigate('reservations', { view: 'management', reservationNumber: expected });
    } catch (error) { if (state.currentRoute === startRoute && button) { button.disabled = false; button.textContent = requestErrorMessage(core.classifyError(error), 'lookup'); } }
  }
  async function findReservation(event) {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); values.reservationNumber = core.normalizeReservationNumber(values.reservationNumber);
    const token = state.reservationGate.begin(values.reservationNumber); const submit = event.currentTarget.querySelector('[type="submit"]'); submit.disabled = true;
    $('#lookupResult').innerHTML = '<p class="message" role="status">Finding your reservation…</p>';
    try {
      const booking = await fetchReservation(values); if (!state.reservationGate.current(token, values.reservationNumber) || state.currentRoute !== 'lookup') return;
      updateActiveBooking(booking, values.lookupCredential, ''); $('#lookupResult').innerHTML = ''; navigate('reservations', { view: 'management', reservationNumber: booking.reservationNumber });
    } catch (error) {
      if (!state.reservationGate.current(token, values.reservationNumber) || state.currentRoute !== 'lookup') return;
      $('#lookupResult').innerHTML = `<p class="message error" role="alert">${escapeHtml(requestErrorMessage(core.classifyError(error), 'lookup'))}</p>`;
    } finally { submit.disabled = false; }
  }

  function stopAssignmentPolling(reason = 'stopped') { const poller = state.assignmentPoller; state.assignmentPoller = null; poller?.stop(reason); }
  function startAssignmentPolling() {
    const booking = state.activeBooking; const number = booking?.reservationNumber; const entry = activeRecentEntry(number);
    if (!entry || state.pollingExhausted || !lifecycle.shouldPollAssignment(booking) || state.currentRoute !== 'confirmation' || document.hidden) return stopAssignmentPolling('inactive');
    if (state.assignmentPoller?.isRunning()) return;
    state.pollingMessage = 'Automatic checks active'; updateConfirmationDynamic();
    state.assignmentPoller = lifecycle.createAssignmentPoller({
      fetchBooking: signal => fetchReservation(entry, signal),
      isActive: () => state.currentRoute === 'confirmation' && !document.hidden,
      matchesIdentity: () => state.activeBooking?.reservationNumber === number,
      onBooking: refreshed => { if (state.activeBooking?.reservationNumber !== number) return; updateActiveBooking(refreshed, entry.lookupCredential, entry.maskedContact); updateConfirmationDynamic(); },
      onCheck: time => { state.lastCheckedAt = new Date(time); updateConfirmationDynamic(); },
      onError: () => { state.pollingMessage = 'Could not refresh current status'; updateConfirmationDynamic(); },
      onStop: reason => { if (state.activeBooking?.reservationNumber !== number) return; if (reason === 'timeout') { state.pollingExhausted = true; state.pollingMessage = 'Automatic checks paused; manual refresh remains available'; updateConfirmationDynamic(); } else if (reason === 'assigned') { state.pollingMessage = 'Assigned space received'; updateConfirmationDynamic(); } }
    });
    state.assignmentPoller.start();
  }
  async function checkAssignmentStatus() {
    const number = state.activeBooking?.reservationNumber; const entry = activeRecentEntry(number); const startRoute = state.currentRoute; if (!entry) return navigate('lookup');
    const token = state.reservationGate.begin(number); state.pollingMessage = 'Checking now…'; updateConfirmationDynamic();
    try {
      const booking = await fetchReservation(entry); if (!state.reservationGate.current(token, number) || state.activeBooking?.reservationNumber !== number || state.currentRoute !== startRoute) return;
      updateActiveBooking(booking, entry.lookupCredential, entry.maskedContact); state.lastCheckedAt = new Date(); state.pollingMessage = booking.assignedSpotLabel ? `Space ${booking.assignedSpotLabel} assigned` : 'Assignment is still pending';
      if (state.currentRoute === 'confirmation') { updateConfirmationDynamic(); startAssignmentPolling(); } else renderCurrentRoute();
    } catch (error) { if (state.reservationGate.current(token, number) && state.currentRoute === startRoute) { state.pollingMessage = requestErrorMessage(core.classifyError(error), 'refresh'); updateConfirmationDynamic(); } }
  }

  function showDialog(dialog, trigger) { state.dialogTrigger = trigger || document.activeElement; dialog.showModal(); }
  function restoreDialogFocus() { const trigger = state.dialogTrigger; state.dialogTrigger = null; if (trigger && document.contains(trigger) && !trigger.hidden) trigger.focus(); }
  function closeDialog(dialog) { if (dialog?.open) dialog.close(); }
  function openCancellation(trigger) {
    const booking = state.activeBooking; if (!state.activeCredential || !core.reservationStatusView(booking).canCancel) return;
    const policy = Number.isFinite(Number(booking.cancellationCutoffHours)) ? ` Cancellation is subject to the current ${Number(booking.cancellationCutoffHours)}-hour cutoff.` : ' Cancellation is subject to the current policy cutoff.';
    $('#cancelContent').innerHTML = `<p>This will cancel the reservation and release ${exactMode(booking) ? 'the assigned space' : `one capacity unit in ${escapeHtml(parkingAreaName(booking))}`}.${escapeHtml(policy)}</p>${booking.cancellationPolicyText ? `<p>${escapeHtml(booking.cancellationPolicyText)}</p>` : ''}<p>No refund promise is being made here; contact parking support for policy questions.</p><div class="dialog-actions"><button type="button" class="button secondary-button" data-close-cancel>Keep reservation</button><button type="button" class="button danger-button" data-confirm-cancel>Cancel reservation</button></div><p id="cancelMessage" class="message" aria-live="polite"></p>`;
    showDialog($('#cancelDialog'), trigger);
  }
  function openSelfService(action, trigger) {
    const booking = state.activeBooking; const view = core.reservationStatusView(booking); if (!state.activeCredential || (action === 'check-in' ? !view.canCheckIn : !view.canCheckOut)) return;
    $('#selfServiceTitle').textContent = action === 'check-in' ? 'Confirm Your Arrival' : 'Confirm Departure';
    const area = !exactMode(booking); const name = parkingAreaName(booking);
    $('#selfServiceContent').innerHTML = `<p>${action === 'check-in' ? (area ? `Confirm that you have arrived and are parked in an available position inside ${escapeHtml(name)}.` : `Confirm that your vehicle is parked in Space ${escapeHtml(booking.assignedSpotLabel)}.`) : (area ? `Confirm your vehicle has completely left ${escapeHtml(name)}. The reserved capacity unit will be released.` : `Confirm your vehicle has completely left. Space ${escapeHtml(booking.assignedSpotLabel)} will be released.`)}</p><div class="dialog-actions"><button type="button" class="button secondary-button" data-close-self-service>Go back</button><button type="button" class="button" data-confirm-self="${action}">Confirm</button></div><p id="selfServiceMessage" class="message" aria-live="polite"></p>`;
    showDialog($('#selfServiceDialog'), trigger);
  }
  async function authoritativeMutation(action, messageElement, button) {
    if (state.mutationPending) return; const booking = state.activeBooking; const number = booking?.reservationNumber; const credential = state.activeCredential;
    if (!booking?.publicToken || !number || !credential) return navigate('lookup');
    state.mutationPending = true; button.disabled = true; const token = state.reservationGate.begin(number);
    try {
      const path = action === 'cancel' ? 'cancel' : action; const response = await request(`/bookings/${encodeURIComponent(booking.publicToken)}/${path}`, { method: 'POST', timeoutMs: 25000, headers: { 'Idempotency-Key': core.randomOperationKey() }, body: JSON.stringify({ lookupCredential: credential, ...(action === 'cancel' ? { reason: 'Customer cancellation' } : {}) }) });
      let updated = core.mutationBooking(response, null);
      if (!updated) updated = core.mutationBooking(null, await fetchReservation({ reservationNumber: number, lookupCredential: credential }));
      if (!updated) throw new Error('The updated reservation could not be verified.');
      if (!state.reservationGate.current(token, number) || updated.reservationNumber !== number) return;
      updateActiveBooking(updated, credential); closeDialog(action === 'cancel' ? $('#cancelDialog') : $('#selfServiceDialog')); renderCurrentRoute();
    } catch (error) { setMessage(messageElement, requestErrorMessage(core.classifyError(error), action), true); button.disabled = false; }
    finally { state.mutationPending = false; }
  }
  async function manageBilling(button) {
    const booking = state.activeBooking; const credential = state.activeCredential;
    if (!booking?.publicToken || !credential || !booking.manageBillingAvailable) return;
    button.disabled = true; const previous = button.textContent; button.textContent = 'Opening billing…';
    try {
      const response = await request('/payments/stripe/portal-sessions', {
        method: 'POST', body: JSON.stringify({ publicToken: booking.publicToken, lookupCredential: credential })
      });
      if (!response.portal?.url) throw new Error('Billing Portal is unavailable.');
      window.location.assign(response.portal.url);
    } catch (error) {
      button.disabled = false; button.textContent = error.publicMessage || previous;
    }
  }
  function printPass() {
    if (!state.activeBooking || !core.reservationStatusView(state.activeBooking).canPrint) return;
    $('#printPassPortal')?.remove(); const portal = document.createElement('div'); portal.id = 'printPassPortal'; portal.className = 'print-pass-portal'; portal.innerHTML = passDocument(state.activeBooking); document.body.append(portal);
    const cleanup = () => { portal.remove(); window.removeEventListener('afterprint', cleanup); }; window.addEventListener('afterprint', cleanup); window.print(); window.setTimeout(cleanup, 60000);
  }
  async function copyText(value, button) { try { await navigator.clipboard.writeText(value); button.textContent = 'Copied'; } catch (_) { window.prompt('Copy this value:', value); } }

  function resetBookingFlow() {
    invalidateSearchState(); state.selectedCategoryCode = ''; state.selectedDuration = ''; $('#category').value = ''; $('#bookingForm').reset();
    if (state.canonicalLot) { const arrival = core.zonedInputValue(new Date(Date.now() + 3600000), state.canonicalLot.timezone); setDateTimeValue('arrival', arrival); setDateTimeValue('departure', core.addLocalCalendarDays(arrival, 1)); renderCanonicalLot(); }
    navigate('parking');
  }
  function editSearch() { navigate('parking'); setMessage($('#searchMessage'), 'Adjust the parking type or times, then check availability again.'); }
  function onDocumentClick(event) {
    const target = event.target.closest('a, button, input, [data-monthly-spot]'); if (!target) return;
    if (target.matches('[data-route]')) { event.preventDefault(); navigate(target.dataset.route, { view: target.dataset.route === 'reservations' ? 'list' : '', reservationNumber: ['pass', 'map'].includes(target.dataset.route) ? state.activeBooking?.reservationNumber : '' }); return; }
    if (target.dataset.accountTab) { state.accountTab = target.dataset.accountTab; state.accountMessage = ''; return renderMyParking(); }
    if (target.matches('[data-account-logout]')) return accountLogout();
    if (target.dataset.uploadFor) return startUploadFor(target.dataset.uploadFor, target.dataset.uploadType);
    if (target.dataset.documentTypeChoice) {
      state.accountMessage = '';
      const type = target.dataset.documentTypeChoice;
      // Already signed in: switch the document type without asking for email + phone again.
      if (state.accountIdentity && state.accountStatus === 'AUTHENTICATED' && state.accountGrantDocumentType !== type) {
        return startUploadFor(state.accountData?.uploadReservation?.reservationNumber || state.documentUpload.reservationNumber || '', type);
      }
      state.documentUpload = { type, reservationNumber: '', file: null, progress: 0, status: 'IDLE', message: '', successType: '' }; return renderUploadDocuments();
    }
    if (target.matches('[data-upload-another]')) { state.documentUpload = { type: '', reservationNumber: '', file: null, progress: 0, status: 'IDLE', message: '', successType: '' }; return renderUploadDocuments(); }
    if (target.dataset.parkingType) return chooseParkingType(target.dataset.parkingType);
    if (target.dataset.duration) return setDuration(target.dataset.duration);
    if (target.dataset.selectOffer) { const result = state.availability.find(item => core.offerKey(item, state.search.fingerprint) === target.dataset.selectOffer); return selectOffer(result); }
    if (target.dataset.monthlySpot) return chooseMonthlySpot(target.dataset.monthlySpot);
    if (target.matches('[data-change-monthly]')) return changeMonthlySpot();
    if (target.matches('[data-retry-search]')) return checkAvailability();
    if (target.matches('[data-retry-lot]')) return loadCanonicalLot();
    if (target.matches('[data-retry-quote]')) return fetchQuote();
    if (target.matches('[data-edit-search]')) return editSearch();
    if (target.matches('[data-copy]')) return copyText(target.dataset.copy, target);
    if (target.matches('[data-print-pass]')) return printPass();
    if (target.matches('[data-check-assignment]')) return checkAssignmentStatus();
    if (target.matches('[data-open-management]')) return navigate('reservations', { view: 'management', reservationNumber: state.activeBooking?.reservationNumber });
    if (target.matches('[data-manage-billing]')) return manageBilling(target);
    if (target.matches('[data-complete-demo]')) return completeDemoPayment(target);
    if (target.dataset.viewRecent) return openRecentReservation(target.dataset.viewRecent, target);
    if (target.dataset.refreshRecent) return refreshRecentReservation(activeRecentEntry(target.dataset.refreshRecent)).then(() => { refreshCombinedEntries(); renderRecentReservations({ refresh: false }); });
    if (target.dataset.removeRecent) { removeRecentReservation(target.dataset.removeRecent); return renderRecentReservations({ refresh: false }); }
    if (target.matches('[data-remove-active]')) { removeRecentReservation(state.activeBooking?.reservationNumber); return navigate('reservations', { view: 'list' }); }
    if (target.matches('[data-clear-recent]')) { if (window.confirm('Remove all reservation credentials from this browser?')) { state.sessionEntries = []; state.rememberedEntries = []; refreshCombinedEntries(); renderRecentReservations({ refresh: false }); } return; }
    if (target.matches('[data-cancel-pass]')) return openCancellation(target);
    if (target.dataset.selfAction) return openSelfService(target.dataset.selfAction, target);
    if (target.matches('[data-close-cancel]')) return closeDialog($('#cancelDialog'));
    if (target.matches('[data-close-self-service]')) return closeDialog($('#selfServiceDialog'));
    if (target.matches('[data-confirm-cancel]')) return authoritativeMutation('cancel', $('#cancelMessage'), target);
    if (target.dataset.confirmSelf) return authoritativeMutation(target.dataset.confirmSelf, $('#selfServiceMessage'), target);
    if (target.matches('[data-map-zoom]')) return changeMapZoom(target.dataset.mapZoom, target.closest('[data-map-stage]'));
  }
  function onDocumentChange(event) {
    if (event.target.matches('[data-remember-reservation]')) { persistActiveReservation({ remember: event.target.checked }); renderCurrentRoute(); }
    if (event.target.matches('#uploadReservationSelect')) return startUploadFor(event.target.value, state.documentUpload.type);
    if (event.target.matches('.standalone-document-input')) {
      const file = event.target.files?.[0] || null;
      state.documentUpload.file = file; state.documentUpload.status = 'IDLE'; state.documentUpload.message = '';
      renderUploadDocuments();
    }
    if (event.target.matches('#insuranceCamera, #insuranceDocument')) {
      const other = event.target.id === 'insuranceCamera' ? $('#insuranceDocument') : $('#insuranceCamera');
      if (event.target.files?.length && other) other.value = '';
      const file = event.target.files?.[0];
      if ($('#insuranceSelectedFile')) $('#insuranceSelectedFile').textContent = file ? `${file.name} · ${file.type || 'file'}` : 'No file selected.';
    }
  }
  function onDocumentInput(event) {
    if (event.target.matches('#arrivalDate, #arrivalTime, #departureDate, #departureTime')) { const had = state.search.status !== core.SEARCH_STATUS.IDLE; invalidateSearchState({ announce: had }); renderDurationOptions(); }
  }
  function bindMapPointerAndKeyboard() {
    document.addEventListener('pointerdown', event => {
      const stage = event.target.closest('[data-map-stage]'); if (!stage || !core.canStartMapPan({ zoom: state.mapZoom, button: event.button, fromControl: Boolean(event.target.closest('.map-controls, [data-monthly-spot]')) })) return;
      const origin = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop, pointerId: event.pointerId }; stage._panOrigin = origin; stage.classList.add('is-panning'); stage.setPointerCapture(event.pointerId);
    });
    document.addEventListener('pointermove', event => { const stage = event.target.closest('[data-map-stage]'); const origin = stage?._panOrigin; if (!origin) return; stage.scrollLeft = origin.left - (event.clientX - origin.x); stage.scrollTop = origin.top - (event.clientY - origin.y); });
    const stop = event => { const stage = event.target.closest('[data-map-stage]'); if (!stage?._panOrigin) return; stage._panOrigin = null; stage.classList.remove('is-panning'); if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId); };
    document.addEventListener('pointerup', stop); document.addEventListener('pointercancel', stop);
    document.addEventListener('keydown', event => {
      const stage = event.target.closest('[data-map-stage]'); if (!stage) return;
      const action = core.mapKeyboardAction(event.key, state.mapZoom); if (!action) return; event.preventDefault();
      if (action.zoom) changeMapZoom(action.zoom, stage);
      else { const amount = 44; if (action.pan === 'ArrowLeft') stage.scrollLeft -= amount; if (action.pan === 'ArrowRight') stage.scrollLeft += amount; if (action.pan === 'ArrowUp') stage.scrollTop -= amount; if (action.pan === 'ArrowDown') stage.scrollTop += amount; }
    });
  }
  async function loadCanonicalLot() {
    if (!config.configured) { state.canonicalStatus = 'ERROR'; state.canonicalError = 'Customer API configuration is missing for this host.'; renderCanonicalLot(); setMessage($('#searchMessage'), state.canonicalError, true); return; }
    state.canonicalStatus = 'LOADING'; renderCanonicalLot();
    try {
      const response = await request('/canonical-lot'); const lot = core.validateCanonicalLot(response); if (!lot) throw new Error('Invalid canonical lot response.');
      state.canonicalLot = lot; state.canonicalStatus = 'SUCCESS'; if (lot.phone) { const values = phoneValues(lot.phone); state.supportPhone = values.href.replace(/^tel:/, ''); state.supportPhoneDisplay = values.display; updateSupportLinks(); }
      initializeLotDefaults(); renderCanonicalLot(); setMessage($('#searchMessage'));
    } catch (error) { state.canonicalStatus = 'ERROR'; state.canonicalError = requestErrorMessage(core.classifyError(error), 'parking details'); renderCanonicalLot(); setMessage($('#searchMessage'), `New parking search is temporarily unavailable. Reservation lookup still works. ${state.canonicalError}`, true); }
  }
  function initialize() {
    updateSupportLinks(); setupMainSiteHeader(); loadRecentReservations(); renderCanonicalLot(); setStep(1, { focus: false });
    document.addEventListener('click', onDocumentClick); document.addEventListener('submit', onDocumentSubmit); document.addEventListener('change', onDocumentChange); document.addEventListener('input', onDocumentInput); bindMapPointerAndKeyboard();
    $('#cancelDialog')?.addEventListener('close', restoreDialogFocus); $('#selfServiceDialog')?.addEventListener('close', restoreDialogFocus);
    $('#searchForm')?.addEventListener('submit', checkAvailability); $('#bookingForm')?.addEventListener('submit', reserveParking); $('#lookupForm')?.addEventListener('submit', findReservation);
    $('#continueDriver')?.addEventListener('click', () => { if (core.bookingCanContinue(state)) navigate('review'); });
    $$('[data-back-step]').forEach(button => button.addEventListener('click', () => navigate(Number(button.dataset.backStep) === 1 ? 'parking' : 'offers')));
    $('#continueRecentReservation')?.addEventListener('click', event => openRecentReservation(state.recentReservations[0]?.reservationNumber, event.currentTarget));
    window.addEventListener('popstate', renderCurrentRoute);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopAssignmentPolling('hidden'); else if (state.currentRoute === 'confirmation') startAssignmentPolling(); });
    state.initialized = true; const initialRoute = window.location.hash.slice(1);
    if (initialRoute.startsWith('r=') || initialRoute.startsWith('payment-return') || initialRoute.startsWith('checkout-cancelled') || initialRoute.startsWith('demo-payment')) renderCurrentRoute();
    else if (!window.location.hash || !lifecycle.ROUTES.includes(initialRoute)) navigate('parking', { replace: true }); else renderCurrentRoute();
    loadCanonicalLot();
    loadPaymentConfiguration().catch(() => { state.paymentConfiguration = null; });
    if (!['my-parking','upload-documents'].some(route => initialRoute.startsWith(route))) loadAccountOverview().catch(() => { state.accountStatus = 'SIGNED_OUT'; });
  }

  initialize();
})();
