(() => {
  'use strict';

  const app = document.querySelector('#app');
  const api = window.ParkingAdminApi;
  const config = window.PARKING_ADMIN_CONFIG;
  const PARKING_SCREENS = ['Overview', 'Live Lot', 'Reservations', 'Reservation Desk', 'Customers'];
  const OWNER_SCREENS = ['Lot Setup', 'Team', 'Business Settings'];
  const VISIBLE_OPERATIONS_SCREENS = ['Overview', 'Live Lot', 'Reservations', 'Customers', 'Summary'];
  const VISIBLE_MANAGEMENT_SCREENS = ['Lot Setup', 'Business Settings', 'Team'];
  const availableScreens = () => [...PARKING_SCREENS, 'Summary', ...(state.user?.role === 'OWNER' ? [...OWNER_SCREENS, 'Advanced Map Tools'] : []), 'Settings'];
  const TRANSITIONS = Object.freeze({
    PENDING: [['confirm', 'Confirm'], ['cancel', 'Cancel']],
    CONFIRMED: [['check-in', 'Check In'], ['cancel', 'Cancel'], ['no-show', 'No Show']],
    CHECKED_IN: [['check-out', 'Check Out']],
    CHECKED_OUT: [['complete', 'Complete']]
  });

  const emptyPrivateData = () => ({
    dashboard: null,
    summary: null,
    liveLot: null,
    bookings: [],
    bookingsPagination: { limit: 50, hasMore: false, nextCursor: null },
    bookingCursor: '',
    bookingCursorHistory: [],
    bookingDetail: null,
    bookingAlternatives: null,
    selectedBookingId: '',
    selectedSpaceId: '',
    spaceDetail: null,
    customers: null,
    overdueCustomers: null,
    documentsPendingReview: [],
    customerDetail: null,
    selectedCustomerId: '',
    customerMatrix: null,
    customerCursor: '',
    customerCursorHistory: [],
    calendar: null,
    calendarCursor: '',
    calendarCursorHistory: []
  });
  const state = {
    user: null,
    screen: 'Overview',
    loading: false,
    error: '',
    sessionMessage: '',
    advancedView: 'lot-setup',
    search: '',
    status: '',
    customerSearch: '',
    customerFilters: { status: '', payment: '', parking: '', reservationType: '', documents: '' },
    customerFocusPayment: '',
    customerMode: 'list',
    customerMatrixYear: new Date().getUTCFullYear(),
    calendarDate: '',
    lotSearch: '',
    lotFilters: { bookingTerm: '', vehicleType: '', operationalStatus: '', accessType: '' },
    bulkMode: false,
    selectedSpaceIds: new Set(),
    publishReview: null,
    publishReviewOpen: false,
    bulkPreview: null,
    liveLotMove: null,
    liveLotEdit: null,
    placeError: '',
    lastUpdatedAt: null,
    privateData: emptyPrivateData()
  };

  window.__PARKING_ADMIN_ERROR_COUNT = 0;
  window.__PARKING_ADMIN_ERRORS = [];
  window.addEventListener('error', event => {
    window.__PARKING_ADMIN_ERROR_COUNT += 1;
    window.__PARKING_ADMIN_ERRORS.push(String(event.error?.stack || event.message || 'Unknown browser error'));
  });
  window.addEventListener('unhandledrejection', event => {
    window.__PARKING_ADMIN_ERROR_COUNT += 1;
    window.__PARKING_ADMIN_ERRORS.push(String(event.reason?.stack || event.reason || 'Unhandled promise rejection'));
  });
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (state.liveLotMove) {
      state.liveLotMove = null;
      render();
      return;
    }
    if (state.bulkPreview) {
      state.bulkPreview = null;
      render();
      return;
    }
    if (state.publishReviewOpen) {
      state.publishReviewOpen = false;
      render();
      return;
    }
    if (state.privateData.spaceDetail) {
      state.privateData.selectedSpaceId = '';
      state.privateData.spaceDetail = null;
      render();
    }
  });

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[character]);
  const display = value => value === null || value === undefined || value === '' ? '—' : String(value);
  const employeeLabel = value => {
    const status = String(value || '').toUpperCase();
    const labels = {
      CHECKED_IN: 'Active', CHECKED_OUT: 'Checked Out', PENDING_REVIEW: 'Pending Review',
      PAID_ALLOCATION_REVIEW: 'Allocation Review', NOT_REQUIRED: 'Pay on Site',
      NOT_DUE: 'Not Due', DEMO_BYPASSED: 'Demo Payment', LEGACY_EXCEL_IMPORT: 'Imported record'
    };
    return labels[status] || display(value).replaceAll('_', ' ');
  };
  const paymentDisplay = value => employeeLabel(value);
  const formatDateTime = value => {
    if (!value) return '—';
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat([], {
      dateStyle: 'medium', timeStyle: 'short'
    }).format(date);
  };
  const formatDate = value => {
    if (!value) return '—';
    const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat([], { dateStyle: 'medium' }).format(date);
  };
  const money = cents => {
    const amount = Number(cents);
    return Number.isSafeInteger(amount) ? new Intl.NumberFormat([], { style: 'currency', currency: 'USD' }).format(amount / 100) : '$0.00';
  };
  const formatBytes = value => {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };
  const bookingTotal = booking => {
    const amount = Number(booking?.snapshot?.totalCents);
    return Number.isSafeInteger(amount) ? amount : 0;
  };
  const fullName = booking => [booking?.first_name, booking?.last_name].filter(Boolean).join(' ') || '—';
  const assignmentPresentation = booking => {
    const mode = booking?.assignment_mode_snapshot || booking?.assignmentMode;
    if (mode === 'ZONE_CAPACITY') return {
      area: true, monthly: false, model: 'Area parking',
      compact: `${booking?.category_name || booking?.parkingArea || 'Parking Area'} · no exact position`,
      guidance: 'Area capacity commitment. No numbered position is assigned.'
    };
    if (mode === 'CUSTOMER_SELECTED_SPOT') return {
      area: false, monthly: true, model: 'Numbered space picked by the customer',
      compact: booking?.assigned_spot_label || booking?.assignedSpace ? `Position ${booking.assigned_spot_label || booking.assignedSpace}` : 'Selected position unavailable',
      guidance: 'The customer selected this monthly-eligible position for the reservation interval.'
    };
    return {
      area: false, monthly: false, model: 'Historical automatic exact position',
      compact: booking?.assigned_spot_label || booking?.assignedSpace ? `Position ${booking.assigned_spot_label || booking.assignedSpace}` : 'Historical assignment unavailable',
      guidance: 'Legacy compatibility record; this is not a selectable customer product.'
    };
  };
  const statusClass = value => String(value || '').toLowerCase().replaceAll('_', '');
  const allocationClass = space => window.ParkingAdminCore.allocationClass(space);
  const allocationLabel = space => window.ParkingAdminCore.allocationLabel(space);
  const documentTypeLabel = value => String(value || '').toUpperCase() === 'DRIVER_LICENSE' ? 'Driver License' : 'Insurance';
  const documentStatusLabel = value => {
    const status = String(value || '').toUpperCase();
    if (!status) return 'Missing';
    if (status === 'PENDING_REVIEW') return 'Uploaded / Pending Review';
    if (status === 'APPROVED') return 'Approved';
    if (status === 'REPLACEMENT_REQUESTED') return 'Replacement Requested';
    if (status === 'REJECTED') return 'Rejected';
    return employeeLabel(value);
  };
  const currentSummary = () => state.privateData.dashboard?.summary || {};
  const dateInZone = (zone, instant = new Date()) => {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(instant);
      const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
      return `${values.year}-${values.month}-${values.day}`;
    } catch (_) { return instant.toISOString().slice(0, 10); }
  };

  function clearPrivateState({ keepUser = false } = {}) {
    window.ParkingAdvancedAdmin?.clearPrivateState?.();
    window.ParkingReservationDesk?.clearPrivateState?.();
    state.privateData = emptyPrivateData();
    state.search = '';
    state.status = '';
    state.customerSearch = '';
    state.customerFilters = { status: '', payment: '', parking: '', reservationType: '', documents: '' };
    state.customerFocusPayment = '';
    state.customerMode = 'list';
    state.calendarDate = '';
    if (!keepUser) state.user = null;
  }

  function handleUnauthorized() {
    api?.clearSession();
    clearPrivateState();
    state.loading = false;
    state.error = '';
    state.sessionMessage = 'Your session expired. Sign in to continue.';
    render();
  }

  async function loadAuthoritativeData({ quiet = false } = {}) {
    if (!api || !state.user) return;
    if (!quiet) state.loading = true;
    state.error = '';
    render();
    try {
      const [dashboard, liveLot, bookingResult, overdueCustomerResult, documentResult] = await Promise.all([
        api.dashboard(),
        api.liveLot(),
        api.bookings(),
        api.customers({ payment: 'OVERDUE', limit: 100 }),
        api.documents({ status: 'PENDING_REVIEW' })
      ]);
      state.privateData.dashboard = dashboard;
      state.privateData.liveLot = liveLot;
      await loadUnplaced();
      state.lastUpdatedAt = new Date();
      if (!state.calendarDate) state.calendarDate = dateInZone(liveLot?.location?.timezone);
      state.privateData.bookings = Array.isArray(bookingResult?.bookings) ? bookingResult.bookings : [];
      state.privateData.bookingsPagination = bookingResult?.pagination || state.privateData.bookingsPagination;
      state.privateData.overdueCustomers = overdueCustomerResult;
      state.privateData.documentsPendingReview = documentResult?.documents || [];
    } catch (error) {
      if (error?.status !== 401) {
        clearPrivateState({ keepUser: true });
        state.error = error?.message || 'ParkingOps data could not be loaded.';
      }
    } finally {
      state.loading = false;
      render();
    }
  }

  async function loadBookingsFromServer() {
    if (!state.user) return;
    state.loading = true;
    state.error = '';
    render();
    try {
      const result = await api.bookings({ q: state.search, status: state.status, cursor: state.privateData.bookingCursor, limit: 50 });
      state.privateData.bookings = Array.isArray(result?.bookings) ? result.bookings : [];
      state.privateData.bookingsPagination = result?.pagination || { limit: 50, hasMore: false, nextCursor: null };
      state.privateData.bookingDetail = null;
      state.privateData.selectedBookingId = '';
    } catch (error) {
      if (error?.status !== 401) {
        state.privateData.bookings = [];
        state.error = error?.message || 'Reservations could not be loaded.';
      }
    } finally {
      state.loading = false;
      render();
    }
  }

  async function loadBookingDetail(id) {
    state.privateData.selectedBookingId = String(id || '');
    state.privateData.bookingDetail = null;
    state.privateData.bookingAlternatives = null;
    state.loading = true;
    state.error = '';
    render();
    try {
      state.privateData.bookingDetail = await api.booking(id);
    } catch (error) {
      if (error?.status !== 401) state.error = error?.message || 'Reservation details could not be loaded.';
    } finally {
      state.loading = false;
      render();
    }
  }

  async function loadSpaceDetail(id) {
    state.privateData.selectedSpaceId = String(id || '');
    state.privateData.spaceDetail = null;
    state.error = '';
    render();
    try {
      state.privateData.spaceDetail = await api.spaceDetail(id);
    } catch (error) {
      if (error?.status !== 401) state.error = error?.message || 'Space details could not be loaded.';
    } finally { render(); }
  }

  function openDeskForSpace(space) {
    state.screen = 'Reservation Desk';
    state.error = '';
    render();
    window.ParkingReservationDesk?.openForSpace?.(space);
  }

  function openDeskReservation(id) {
    state.screen = 'Reservation Desk';
    state.error = '';
    render();
    window.ParkingReservationDesk?.openReservation?.(id);
  }

  async function loadCustomers() {
    state.loading = true; state.error = ''; render();
    try {
      state.privateData.customers = await api.customers({ q: state.customerSearch,
        ...state.customerFilters, cursor: state.privateData.customerCursor, limit: 50 });
    } catch (error) {
      if (error?.status !== 401) { state.privateData.customers = null; state.error = error?.message || 'Customers could not be loaded.'; }
    } finally {
      state.loading = false; render();
      if (state.customerFocusPayment === 'OVERDUE') {
        requestAnimationFrame(() => {
          const first = document.querySelector('.customer-table .clickable-row');
          if (first) { first.classList.add('is-focused-result'); first.tabIndex = -1; first.focus({ preventScroll: false }); }
        });
        state.customerFocusPayment = '';
      }
    }
  }

  async function loadSummary() {
    state.loading = true; state.error = ''; render();
    try { state.privateData.summary = await api.summary(); }
    catch (error) {
      if (error?.status !== 401) { state.privateData.summary = null; state.error = error?.message || 'Summary could not be loaded.'; }
    } finally { state.loading = false; render(); }
  }

  function nextLocalDate(date) {
    const [year, month, day] = String(date).split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    return next.toISOString().slice(0, 10);
  }

  async function loadCalendar() {
    state.loading = true; state.error = ''; render();
    try {
      state.privateData.calendar = await api.calendar({ startDate: state.calendarDate, endDate: nextLocalDate(state.calendarDate),
        locationId: state.privateData.liveLot?.location?.id, cursor: state.privateData.calendarCursor, limit: 100 });
    } catch (error) {
      if (error?.status !== 401) { state.privateData.calendar = null; state.error = error?.message || 'Calendar could not be loaded.'; }
    } finally { state.loading = false; render(); }
  }

  function logo() {
    return `<a class="logo-row logo-home-link" href="${escapeHtml(config?.parentSiteUrl || '#')}" target="_blank" rel="noopener noreferrer">
      <img class="logo-img" src="assets/trucker-heaven-logo-nav.png" alt="Trucker Heaven">
    </a>`;
  }

  function renderLogin() {
    const configurationError = !config?.valid ? config?.error || 'ParkingOps runtime configuration is invalid.' : '';
    app.innerHTML = `<div class="login-page"><form method="post" class="login-card" id="loginForm">
      ${logo()}
      <h1>Operations Login</h1>
      <p class="muted">Sign in with a ParkingOps Owner or Staff account.</p>
      <label class="field"><span>Username</span><input id="loginUser" autocomplete="username" required></label>
      <label class="field"><span>Password</span><input id="loginPass" type="password" autocomplete="current-password" required></label>
      <button class="btn primary" type="submit" ${configurationError ? 'disabled' : ''}>Sign In</button>
      <div class="note">Authentication, authorization, and session expiry are enforced by the ParkingOps backend.</div>
      <div id="loginError">${[configurationError, state.sessionMessage, state.error].filter(Boolean).map(message => `<div class="error">${escapeHtml(message)}</div>`).join('')}</div>
    </form></div>`;
    document.querySelector('#loginForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      const button = event.currentTarget.querySelector('button[type="submit"]');
      const username = document.querySelector('#loginUser').value.trim();
      const password = document.querySelector('#loginPass').value;
      button.disabled = true;
      document.querySelector('#loginError').innerHTML = '<div class="note">Signing in…</div>';
      try {
        const result = await api.login(username, password);
        clearPrivateState();
        state.user = result.user;
        state.sessionMessage = '';
        await loadAuthoritativeData({ quiet: true });
      } catch (error) {
        state.error = error?.message || 'Sign in failed.';
        render();
      }
    });
  }

  function statTile(label, value, screen, tone = 'neutral') {
    return `<button class="stat-tile tone-${escapeHtml(tone)}" data-nav="${escapeHtml(screen)}"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></button>`;
  }

  function renderShell() {
    const advancedRoot = document.querySelector('#advancedAdminRoot');
    if (advancedRoot && advancedRoot.parentElement !== document.body) document.body.append(advancedRoot);
    window.ParkingAdvancedAdmin?.deactivate?.();
    const facilityName = state.privateData.liveLot?.location?.name || 'Trucker Heaven Parking';
    const renderNavigationGroup = (label, screens) => `<section class="nav-group" aria-label="${escapeHtml(label)}"><p class="nav-group-label">${escapeHtml(label)}</p>${screens.filter(screen => availableScreens().includes(screen)).map(screen => `<button class="nav-btn ${state.screen === screen ? 'active' : ''}" data-nav="${escapeHtml(screen)}" ${state.screen === screen ? 'aria-current="page"' : ''}>${escapeHtml(screen)}</button>`).join('')}</section>`;
    app.innerHTML = `<div class="app"><div class="app-shell">
      <header class="topbar">
        <div class="topbar-main">
          <div class="logo-row">${logo()}<div class="title-block"><span class="product-label">PARKINGOPS</span><h1>${escapeHtml(facilityName)}</h1><p>Mt. Juliet, Tennessee</p></div></div>
          <div class="user-box"><button class="btn primary small" data-nav="Reservation Desk">New Booking</button><a class="btn ghost small" href="${escapeHtml(config.customerAppUrl)}" target="_blank" rel="noopener noreferrer">Open Customer Booking</a><span class="user-badge">${escapeHtml(state.user.displayName || state.user.username)} · ${escapeHtml(state.user.role)}</span><button class="btn ghost small" data-logout>Sign Out</button></div>
        </div>
      </header>
      <div class="layout">
        <aside class="sidebar" aria-label="ParkingOps navigation">
          <div class="sidebar-context"><strong>Parking Lot</strong><small>Trucker Heaven Parking</small></div>
          ${renderNavigationGroup('Operations', VISIBLE_OPERATIONS_SCREENS)}
          ${renderNavigationGroup('Management', state.user?.role === 'OWNER' ? VISIBLE_MANAGEMENT_SCREENS : [])}
        </aside>
        <main class="main" id="mainContent">
          ${state.error ? `<div class="error" role="alert">${escapeHtml(state.error)}</div>` : ''}
          ${state.loading ? '<div class="note" role="status">Updating parking information…</div>' : ''}
          ${renderMain()}
        </main>
      </div>
    </div></div>`;
    bindEvents();
    mountAdvancedScreen();
  }

  function sectionHeader(title, description, action = '') {
    return `<div class="section-head"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div>${action}</div>`;
  }

  function renderDashboard() {
    const dashboard = state.privateData.dashboard;
    if (!dashboard) return emptyServerPanel('Overview');
    const summary = dashboard.summary || {};
    const overdueCustomers = state.privateData.overdueCustomers?.customers || [];
    const documents = state.privateData.documentsPendingReview || [];
    const documentByCustomerAndType = new Map();
    documents.forEach(document => {
      const key = [document.customerPublicId || document.customer || document.companyName || 'customer', document.type || 'DOCUMENT'].join('|');
      if (!documentByCustomerAndType.has(key)) documentByCustomerAndType.set(key, document);
    });
    const actionableDocuments = [...documentByCustomerAndType.values()];
    const attentionByBooking = new Map();
    (dashboard.attentionRequired || []).filter(row => ['OVERDUE', 'PAID_ALLOCATION_REVIEW'].includes(row.attention_type)).forEach(row => attentionByBooking.set(String(row.id), row));
    (dashboard.currentCustomers || []).filter(row => !row.assigned_spot_id && !row.assigned_spot_label).forEach(row => {
      attentionByBooking.set(String(row.id), { ...row, attention_type: 'MISSING_SPACE' });
    });
    const parkingAttention = [...attentionByBooking.values()];
    const activeByProduct = (product) => (dashboard.currentCustomers || []).filter(row => row.parking_product === product).length;
    const parkingSummary = [
      ['Occupied', summary.checked_in],
      ['Available', summary.available_spaces],
      ['Daily Active', activeByProduct('DAILY')],
      ['Weekly Active', activeByProduct('WEEKLY')],
      ['Monthly Active', activeByProduct('MONTHLY')]
    ];
    const overviewBadge = (count, activeClass) => `<span class="badge ${count ? activeClass : 'paid'}">${escapeHtml(count)}</span>`;
    const customerRecord = (customer) => {
      const parking = (customer.currentParkings || []).map(item => [item.spot && `Lot #${item.spot}`, item.parkingProduct].filter(Boolean).join(' · ')).filter(Boolean).join(', ');
      return `<div class="calendar-event"><b>${escapeHtml(customer.displayName || 'Customer')}</b><span>${escapeHtml([customer.companyName, parking || 'Current parking unavailable'].filter(Boolean).join(' · '))}</span><em>${escapeHtml(money(Number(customer.payment?.balanceCents || 0)))} overdue</em><div class="row-actions"><button type="button" class="btn ghost compact" data-customer-id="${escapeHtml(customer.publicId)}">Open Customer</button></div></div>`;
    };
    const documentRecord = (document) => `<button type="button" class="calendar-event clickable-row" data-customer-id="${escapeHtml(document.customerPublicId)}" data-customer-focus="documents">${escapeHtml(document.customer || document.companyName || 'Customer')} — ${escapeHtml(documentTypeLabel(document.type))} review</button>`;
    const attentionRecord = (item) => {
      const type = item.attention_type === 'PAID_ALLOCATION_REVIEW' ? 'Paid — allocation review required'
        : item.attention_type === 'OVERDUE' ? 'Active parking past departure'
          : 'Active parking has no numbered space';
      const target = item.attention_type === 'PAID_ALLOCATION_REVIEW' && item.assigned_spot_id
        ? `data-open-space-id="${escapeHtml(item.assigned_spot_id)}" data-lot-number="${escapeHtml(item.assigned_spot_label || '')}"`
        : item.customer_public_id ? `data-customer-id="${escapeHtml(item.customer_public_id)}"` : '';
      const action = target ? `<div class="row-actions"><button type="button" class="btn ghost compact" ${target}>${item.attention_type === 'PAID_ALLOCATION_REVIEW' ? 'Open Live Lot' : 'Open Customer'}</button></div>` : '';
      return `<div class="calendar-event"><b>${escapeHtml(item.customer_name || item.reservation_number || 'Parking exception')}</b><span>${escapeHtml([type, item.assigned_spot_label && `Lot #${item.assigned_spot_label}`].filter(Boolean).join(' · '))}</span><em>${escapeHtml(item.reservation_number || 'Current operational parking')}</em>${action}</div>`;
    };
    return `${sectionHeader('Overview', 'What requires action right now?', '<button class="btn ghost compact" data-refresh>Refresh</button>')}
      <section class="overview-section" aria-labelledby="overdueHeading"><div class="overview-section-head"><h3 id="overdueHeading">Overdue Payments ${overviewBadge(overdueCustomers.length, 'pastdue')}</h3><p><button type="button" class="btn ghost compact" data-overdue-customers>View Overdue</button></p></div><div class="panel"><div class="panel-body">${overdueCustomers.length ? overdueCustomers.map(customerRecord).join('') : '<p class="muted">No overdue payments.</p>'}</div></div></section>
      <section class="overview-section" aria-labelledby="documentsHeading"><div class="overview-section-head"><h3 id="documentsHeading">Documents to Review ${overviewBadge(actionableDocuments.length, 'reserved')}</h3></div><div class="panel"><div class="panel-body">${actionableDocuments.length ? actionableDocuments.map(documentRecord).join('') : '<p class="muted">No documents require review.</p>'}</div></div></section>
      <section class="overview-section" aria-labelledby="parkingAttentionHeading"><div class="overview-section-head"><h3 id="parkingAttentionHeading">Parking Attention ${overviewBadge(parkingAttention.length, 'pastdue')}</h3><p>Only current operational exceptions.</p></div><div class="panel"><div class="panel-body">${parkingAttention.length ? parkingAttention.map(attentionRecord).join('') : '<p class="muted">No parking issues requiring attention.</p>'}</div></div></section>
      <section class="overview-section" aria-labelledby="parkingSummaryHeading"><div class="overview-section-head"><h3 id="parkingSummaryHeading">Parking Summary</h3><p>Current operational counts.</p></div><div class="operations-strip overview-today-strip" aria-label="Parking summary">${parkingSummary.map(([label, value]) => `<div class="dashboard-kpi"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? 0)}</strong></div>`).join('')}</div></section>`;
  }

  function renderSummary() {
    const payload = state.privateData.summary;
    if (!payload) return `${sectionHeader('Summary', 'Read-only ParkingOps business summary.', '<button class="btn primary" data-refresh-summary>Retry</button>')}<div class="panel"><div class="panel-body"><p class="muted">Summary data is loading from ParkingOps.</p></div></div>`;
    const parking = payload.parking || {};
    const mix = payload.parkingMix || {};
    const payments = payload.payments || {};
    const months = payments.byMonth || [];
    const products = payments.byProduct || [];
    const monthMaximum = Math.max(1, ...months.map(item => Number(item.paidCents || 0)));
    const productMaximum = Math.max(1, ...products.map(item => Number(item.paidCents || 0)));
    const bar = (label, value, maximum) => `<div class="summary-bar-row"><span>${escapeHtml(label)}</span><div class="summary-bar-track"><i style="--summary-bar:${Math.max(0, Math.round(Number(value || 0) / maximum * 100))}%"></i></div><strong>${escapeHtml(money(Number(value || 0)))}</strong></div>`;
    const monthLabel = value => new Intl.DateTimeFormat([], { month: 'short' }).format(new Date(`${value}-15T12:00:00`));
    const kpi = (label, value, detail, tone = '') => `<article class="summary-kpi ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</article>`;
    const activeTotal = Number(mix.daily || 0) + Number(mix.weekly || 0) + Number(mix.monthly || 0);
    const bullets = [
      `${parking.occupied || 0} of ${parking.totalCustomerSpaces || 0} customer spaces are occupied; ${parking.available || 0} are available now.`,
      `${money(Number(payments.paidThisMonthCents || 0))} is recorded as paid this month.`,
      `${money(Number(payments.outstandingCents || 0))} is outstanding, including ${money(Number(payments.overdueCents || 0))} overdue.`,
      `${activeTotal} active parking records: ${mix.daily || 0} daily, ${mix.weekly || 0} weekly, and ${mix.monthly || 0} monthly.`,
      `${mix.upcomingReserved || 0} paid upcoming reservation${Number(mix.upcomingReserved || 0) === 1 ? '' : 's'} are scheduled.`
    ];
    return `${sectionHeader('Summary', `Read-only ParkingOps business summary · ${payload.year}.`, '<button class="btn ghost compact" data-refresh-summary>Refresh</button>')}
      <section class="summary-kpi-grid" aria-label="Parking and payment key metrics">
        ${kpi('Total Customer Spaces', parking.totalCustomerSpaces || 0, 'Published customer spaces')}
        ${kpi('Available Now', parking.available || 0, 'Matches Live Lot', 'is-success')}
        ${kpi('Occupied', parking.occupied || 0, 'Matches Live Lot', 'is-active')}
        ${kpi('Reserved', parking.reserved || 0, 'Matches Live Lot', 'is-warning')}
        ${kpi('Paid This Month', money(Number(payments.paidThisMonthCents || 0)), 'Recorded payments', 'is-success')}
        ${kpi('Paid YTD', money(Number(payments.paidYtdCents || 0)), `${payload.year} recorded payments`, 'is-value')}
        ${kpi('Outstanding', money(Number(payments.outstandingCents || 0)), `${money(Number(payments.overdueCents || 0))} overdue`, 'is-critical')}
      </section>
      <div class="summary-two-column">
        <section class="panel"><div class="panel-head">Parking Mix</div><div class="panel-body"><div class="summary-mix-row">${[['Daily Active',mix.daily],['Weekly Active',mix.weekly],['Monthly Active',mix.monthly],['Upcoming / Reserved',mix.upcomingReserved]].map(([label,value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || 0)}</strong></div>`).join('')}</div></div></section>
        <section class="panel"><div class="panel-head">Executive Summary</div><div class="panel-body"><ul class="summary-bullets">${bullets.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div></section>
      </div>
      <div class="summary-chart-grid">
        <section class="panel"><div class="panel-head">Payments by Month</div><div class="panel-body summary-chart" aria-label="Payments by month for ${escapeHtml(payload.year)}">${months.map(item => bar(monthLabel(item.month), item.paidCents, monthMaximum)).join('')}</div></section>
        <section class="panel"><div class="panel-head">Revenue by Parking Type</div><div class="panel-body summary-chart" aria-label="Revenue by parking type for ${escapeHtml(payload.year)}">${products.length ? products.map(item => bar(employeeLabel(item.product), item.paidCents, productMaximum)).join('') : '<p class="muted">No recorded payments this year.</p>'}</div></section>
      </div>`;
  }

  function reservationSummaryPanel(title, rows = [], dateField) {
    return `<div class="panel"><div class="panel-head">${escapeHtml(title)}</div><div class="panel-body">${rows.length ? rows.map(row => `<button class="calendar-event clickable-row customer-first-event" data-booking-id="${escapeHtml(row.id)}"><b>${escapeHtml(display(row.customer_name))}</b><span>${escapeHtml([row.attention_type === 'PAID_ALLOCATION_REVIEW' && 'Paid — allocation review required', row.assigned_spot_label && `Lot #${row.assigned_spot_label}`, [row.license_plate_state,row.license_plate].filter(Boolean).join(' '), row.tractor_unit_number && `Unit ${row.tractor_unit_number}`].filter(Boolean).join(' · ') || employeeLabel(row.status || row.attention_type))}</span><em>${escapeHtml(formatDateTime(row[dateField]))} · ${escapeHtml(display(row.reservation_number))}</em></button>`).join('') : '<p class="muted">No records returned.</p>'}</div></div>`;
  }

  function emptyServerPanel(name) {
    return `${sectionHeader(name, 'This screen requires an authoritative response from ParkingOps.', '<button class="btn primary" data-refresh>Retry</button>')}<div class="panel"><div class="panel-body"><p class="muted">No server data is loaded. No static fallback is available.</p></div></div>`;
  }

  function lotMatches(space) {
    const query = state.lotSearch.trim().toLowerCase();
    const filters = state.lotFilters;
    return (!query || String(space.number).toLowerCase().includes(query))
      && (!filters.bookingTerm || space.bookingTerm === filters.bookingTerm)
      && (!filters.vehicleType || space.vehicleType === filters.vehicleType)
      && (!filters.operationalStatus || space.operationalStatus === filters.operationalStatus)
      && (!filters.accessType || (filters.accessType === 'INTERNAL'
        ? space.parkingPurpose !== 'CUSTOMER' : space.accessType === filters.accessType));
  }

  function liveUpdateText() {
    if (!state.lastUpdatedAt) return 'Not updated yet';
    const seconds = Math.max(0,Math.floor((Date.now()-state.lastUpdatedAt.getTime())/1000));
    if (seconds < 45) return 'Updated just now';
    const minutes = Math.floor(seconds/60);
    return `Updated ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }

  function renderSpaceDetails(space, { setup = false } = {}) {
    if (!space) return `<aside class="space-details-drawer empty"><h3>Space Details</h3><p>Select a numbered space on the map to view reservations and settings.</p></aside>`;
    const detail = state.privateData.spaceDetail;
    if (!detail || String(detail.id) !== String(space.id)) return `<aside class="space-details-drawer"><h3>Space ${escapeHtml(space.number)}</h3><p class="muted">Loading space details…</p></aside>`;
    const draft = detail.draftConfiguration || {};
    const value = (draftValue,publishedValue) => draftValue === undefined || draftValue === null ? publishedValue : draftValue;
    const access = value(draft.access,space.accessType || space.parkingPurpose || 'INTERNAL');
    const booking = value(draft.bookingTerm,space.bookingTerm || (Number(space.number)>=110 && Number(space.number)<=148 ? 'DAILY' : 'MONTHLY'));
    const vehicle = value(draft.vehicleType,space.vehicleType || 'GENERAL');
    const control = value(draft.controlState,space.active ? 'ACTIVE' : 'INACTIVE');
    const edit = setup && state.user.role === 'OWNER';
    const reservation = item => item ? `<button type="button" class="reservation-link" data-booking-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.reservationNumber)}</strong><span>${escapeHtml(employeeLabel(item.status))} · ${escapeHtml(formatDateTime(item.startsAt))}</span></button>` : '<p class="empty-inline">None</p>';
    if (!setup) {
      const customer = detail.currentCustomer;
      const currentReservation = detail.currentReservation;
      const currentVehicle = detail.currentVehicle;
      const isCustomerSpace = access === 'CUSTOMER';
      const isAvailable = space.operationalStatus === 'AVAILABLE';
      const isPublicBookingEligible = window.ParkingAdminCore.publiclyBookableAvailable(space);
      const configuredRateCents = booking === 'MONTHLY' ? space.ratePlan?.monthlyRateCents : space.ratePlan?.dailyRateCents;
      const rateCents = customer?.rateCents ?? currentReservation?.rateCents ?? configuredRateCents ?? null;
      const payment = customer?.payment || {};
      const futureReserved = currentReservation?.status === 'CONFIRMED' && ['PAID','NOT_REQUIRED','DEMO_BYPASSED'].includes(currentReservation?.paymentStatus)
        && currentReservation?.startsAt && new Date(currentReservation.startsAt) > new Date(detail.evaluatedAt);
      const identity = [customer?.usdotNumber && `DOT ${customer.usdotNumber}`, customer?.mcNumber && `MC ${customer.mcNumber}`].filter(Boolean).join(' · ');
      const activity = detail.recentActivity?.length
        ? detail.recentActivity.slice(0,6).map(item => `<div class="activity-line"><strong>${escapeHtml(employeeLabel(item.action))}</strong><span>${escapeHtml(item.user)} · ${escapeHtml(formatDateTime(item.createdAt))}</span></div>`).join('')
        : detail.recentHistory?.length
          ? detail.recentHistory.slice(0,6).map(item => `<div class="activity-line"><strong>${escapeHtml(employeeLabel(item.status))}</strong><span>${escapeHtml(formatDateTime(item.assignedAt))}</span></div>`).join('')
          : '<p class="empty-inline">No recent activity</p>';
      return `<aside class="space-details-drawer customer-first-drawer" aria-labelledby="spaceDetailsHeading">
        <div class="drawer-heading"><div><p class="eyebrow">LOT #</p><h3 id="spaceDetailsHeading">${escapeHtml(space.number)}</h3></div><button class="icon-button" type="button" data-close-space aria-label="Close space details">×</button></div>
        <div class="effective-status"><span>Current status</span><strong class="status-badge ${statusClass(space.operationalStatus)}">${escapeHtml(employeeLabel(space.operationalStatus))}</strong></div>
        ${futureReserved ? `<div class="note"><strong>RESERVED</strong><span> Starts ${escapeHtml(formatDateTime(currentReservation.startsAt))}</span></div>` : ''}
        <section class="drawer-section drawer-space-section"><h4>Space</h4><dl class="drawer-facts"><div><dt>Lot #</dt><dd>${escapeHtml(space.number)}</dd></div><div><dt>Use</dt><dd>${escapeHtml(isCustomerSpace ? 'Customer parking' : space.parkingUseLabel || access)}</dd></div></dl></section>
        ${isCustomerSpace && customer && currentReservation ? `<section class="drawer-section drawer-customer-section"><h4>Customer</h4>${customer.publicId ? `<button type="button" class="customer-primary-name" data-customer-id="${escapeHtml(customer.publicId)}">${escapeHtml(customer.name || customer.company || 'Customer')}</button>` : `<strong class="customer-primary-name">${escapeHtml(customer.name || customer.company || 'Customer')}</strong>`}${customer.company && customer.company !== customer.name ? `<span class="customer-company">${escapeHtml(customer.company)}</span>` : ''}<dl class="drawer-facts stacked"><div><dt>Phone</dt><dd>${escapeHtml(display(customer.phone))}</dd></div>${customer.email ? `<div><dt>Email</dt><dd class="wrap-value">${escapeHtml(customer.email)}</dd></div>` : ''}${identity ? `<div><dt>DOT / MC</dt><dd>${escapeHtml(identity)}</dd></div>` : ''}</dl>${customer.publicId ? `<button type="button" class="btn primary full open-customer-cta" data-customer-id="${escapeHtml(customer.publicId)}">Open Customer</button>` : '<p class="empty-inline">No canonical customer profile is linked.</p>'}</section>` : isAvailable && isCustomerSpace ? '<section class="drawer-section"><h4>Customer</h4><p class="empty-inline">No customer is assigned.</p></section>' : ''}
        ${currentVehicle ? `<section class="drawer-section"><h4>Vehicle</h4><dl class="drawer-facts"><div><dt>Plate</dt><dd>${escapeHtml([currentVehicle.licensePlateState,currentVehicle.licensePlate].filter(Boolean).join(' ') || '—')}</dd></div><div><dt>Unit #</dt><dd>${escapeHtml(display(currentVehicle.unitNumber))}</dd></div></dl></section>` : ''}
        <section class="drawer-section"><h4>Parking</h4><dl class="drawer-facts"><div><dt>Parking type</dt><dd>${escapeHtml(allocationLabel(space))}</dd></div><div><dt>Rental type</dt><dd>${escapeHtml(booking === 'DAILY' ? 'Daily' : 'Monthly')}</dd></div><div><dt>Vehicle type</dt><dd>${escapeHtml(vehicle === 'BOBTAIL' ? 'Bobtail' : 'General Truck Parking')}</dd></div>${futureReserved ? `<div><dt>Start date</dt><dd>${escapeHtml(formatDateTime(currentReservation.startsAt))}</dd></div>` : ''}${rateCents !== null ? `<div><dt>Rate</dt><dd>${escapeHtml(money(rateCents))}${booking === 'MONTHLY' ? '/month' : '/day'}</dd></div>` : ''}</dl>${isAvailable && isPublicBookingEligible ? `<button type="button" class="btn primary full" data-desk-space-id="${escapeHtml(space.id)}" data-desk-space-number="${escapeHtml(space.number)}" data-desk-space-term="${escapeHtml(booking)}" data-desk-space-vehicle="${escapeHtml(vehicle)}">New Booking</button>${renderPlaceDriver(space, vehicle)}` : !isCustomerSpace ? '<p class="internal-space-note">Company / shop / internal space. Not available for public booking.</p>' : isAvailable ? '<p class="internal-space-note">Available for operations, but its published product or rate is not eligible for public booking.</p>' : ''}</section>
        ${isCustomerSpace && currentReservation ? `<section class="drawer-section"><h4>Payment &amp; Operations</h4><dl class="drawer-facts"><div><dt>Payment</dt><dd><span class="badge ${statusClass(currentReservation.paymentStatus || payment.status || 'NOT_DUE')}">${escapeHtml(employeeLabel(currentReservation.paymentStatus || payment.status || 'NOT_DUE'))}</span></dd></div><div><dt>Balance</dt><dd>${payment.balanceCents == null ? '—' : escapeHtml(money(payment.balanceCents))}</dd></div></dl><div class="row-actions">${customer?.publicId ? `<button type="button" class="btn primary compact" data-customer-id="${escapeHtml(customer.publicId)}">Open Customer</button><button type="button" class="btn ghost compact" data-customer-id="${escapeHtml(customer.publicId)}" data-customer-focus="payment">Payment</button>` : ''}${detail.actions?.canMove ? `<button type="button" class="btn ghost compact" data-live-lot-move="${escapeHtml(currentReservation.id)}">Move Customer</button>` : ''}${currentReservation.status === 'CONFIRMED' ? `<button type="button" class="btn primary compact" data-live-lot-checkin="${escapeHtml(currentReservation.id)}">Check In</button>` : ''}${currentReservation.status === 'CHECKED_IN' ? `<button type="button" class="btn red compact" data-live-lot-end="${escapeHtml(currentReservation.id)}">End Parking</button>` : ''}<button type="button" class="btn ghost compact" data-live-lot-edit="${escapeHtml(currentReservation.id)}">${state.liveLotEdit?.bookingId === String(currentReservation.id) ? 'Close Edit' : 'Edit Details'}</button>${currentReservation.status === 'CONFIRMED' ? `<button type="button" class="btn ghost compact" data-live-lot-noshow="${escapeHtml(currentReservation.id)}">No-Show</button><button type="button" class="btn red compact" data-live-lot-cancel="${escapeHtml(currentReservation.id)}">Cancel Reservation</button>` : ''}</div>${renderLiveLotEdit(currentReservation)}</section>` : ''}
        ${detail.actions?.canBlock ? `<form method="post" id="blockSpaceForm" class="block-space-form"><label>Maintenance / Closure Reason<input id="blockSpaceReason" maxlength="300" required placeholder="Required reason"></label><button class="btn danger" type="submit">Mark Unavailable</button></form>` : ''}
        ${detail.actions?.canUnblock ? '<button class="btn secondary full" type="button" data-unblock-space>Return to Available</button>' : ''}
        <section class="drawer-section"><h4>Recent Activity</h4>${activity}</section>
        ${detail.nextReservation ? `<section class="drawer-section"><h4>Next reservation</h4>${reservation(detail.nextReservation)}</section>` : ''}
      </aside>`;
    }
    return `<aside class="space-details-drawer" aria-labelledby="spaceDetailsHeading">
      <div class="drawer-heading"><div><p class="eyebrow">SPACE DETAILS</p><h3 id="spaceDetailsHeading">Space ${escapeHtml(space.number)}</h3></div><button class="icon-button" type="button" data-close-space aria-label="Close space details">×</button></div>
      <div class="effective-status"><span>Current status</span><strong class="status-badge ${statusClass(space.operationalStatus)}">${escapeHtml(employeeLabel(space.operationalStatus))}</strong></div>
      ${detail.configurationConflicts?.length ? `<div class="inline-alert error"><strong>Reservation review needed</strong><span>${escapeHtml(detail.configurationConflicts[0].code.replaceAll('_',' '))}</span></div>` : ''}
      ${edit ? `<form method="post" id="spaceConfigurationForm" class="space-settings-form">
        <input type="hidden" name="layoutVersion" value="${escapeHtml(draft.layoutVersion || '')}"><input type="hidden" name="elementVersion" value="${escapeHtml(draft.elementVersion || '')}">
        <label>Space Number<input name="spaceNumber" inputmode="numeric" pattern="[1-9][0-9]{0,3}" value="${escapeHtml(value(draft.spaceNumber,space.number))}" required></label>
        <label>Vehicle Type<select name="vehicleType"><option value="GENERAL" ${vehicle==='GENERAL'?'selected':''}>General Truck</option><option value="BOBTAIL" ${vehicle==='BOBTAIL'?'selected':''}>Bobtail</option></select></label>
        <label>Rental Type<select name="bookingTerm" ${access!=='CUSTOMER'?'disabled':''}><option value="DAILY" ${booking==='DAILY'?'selected':''}>Daily</option><option value="MONTHLY" ${booking==='MONTHLY'?'selected':''}>Monthly</option></select><small>Spaces 110–148 are Daily; other customer spaces are Monthly.</small></label>
        <label>Use<select name="access"><option value="CUSTOMER" ${access==='CUSTOMER'?'selected':''}>Customer Parking</option><option value="SHOP" ${access==='SHOP'?'selected':''}>Shop</option><option value="COMPANY" ${access==='COMPANY'?'selected':''}>Company</option><option value="INTERNAL" ${access==='INTERNAL'||access==='UNRESOLVED'?'selected':''}>Internal</option></select></label>
        <label>Availability<select name="controlState"><option value="ACTIVE" ${control==='ACTIVE'?'selected':''}>Available for Use</option><option value="INACTIVE" ${control==='INACTIVE'?'selected':''}>Unavailable / Closed</option></select><small>Use the maintenance control below for a temporary closure.</small></label>
        <label>Internal Notes<textarea name="internalNotes" maxlength="1000">${escapeHtml(value(draft.internalNotes,''))}</textarea></label>
        <label>Change Reason <span class="optional">Optional</span><input name="changeReason" maxlength="300" placeholder="Why is this changing?"></label>
        <div class="drawer-actions"><button class="btn ghost" type="button" data-cancel-space>Cancel</button><button class="btn primary" type="submit">Save Changes</button></div>
      </form>` : `<dl class="space-readonly"><div><dt>Number</dt><dd>${escapeHtml(space.number)}</dd></div><div><dt>Vehicle</dt><dd>${escapeHtml(vehicle==='BOBTAIL'?'Bobtail':'General Truck')}</dd></div><div><dt>Rental Type</dt><dd>${escapeHtml(booking==='DAILY'?'Daily':'Monthly')}</dd></div><div><dt>Use</dt><dd>${escapeHtml(access)}</dd></div></dl>`}
      ${detail.actions?.canBlock ? `<form method="post" id="blockSpaceForm" class="block-space-form"><label>Maintenance / Closure Reason<input id="blockSpaceReason" maxlength="300" required placeholder="Required reason"></label><button class="btn danger" type="submit">Mark Unavailable</button></form>` : ''}
      ${detail.actions?.canUnblock ? '<button class="btn secondary full" type="button" data-unblock-space>Return to Available</button>' : ''}
      <section class="drawer-section"><h4>Current reservation</h4>${reservation(detail.currentReservation)}</section>
      <section class="drawer-section"><h4>Next reservation</h4>${reservation(detail.nextReservation)}</section>
      <section class="drawer-section"><h4>Recent activity</h4>${detail.recentActivity?.length ? detail.recentActivity.slice(0,6).map(item => `<div class="activity-line"><strong>${escapeHtml(employeeLabel(item.action))}</strong><span>${escapeHtml(item.user)} · ${escapeHtml(formatDateTime(item.createdAt))}</span></div>`).join('') : '<p class="empty-inline">No recent changes</p>'}</section>
      ${draft.lastModifiedAt ? `<p class="last-modified">Last modified ${escapeHtml(formatDateTime(draft.lastModifiedAt))}${draft.lastModifiedBy ? ` by ${escapeHtml(draft.lastModifiedBy)}` : ''}</p>` : ''}
    </aside>`;
  }

  function renderPublishReview() {
    const review = state.publishReview;
    if (!review || !state.publishReviewOpen) return '';
    const changes = review.changes || [];
    const errors = review.validation?.errors || [];
    return `<dialog class="simple-review-dialog" id="parkingPublishReview" open aria-labelledby="publishReviewHeading">
      <div class="review-heading"><div><p class="eyebrow">REVIEW CHANGES</p><h3 id="publishReviewHeading">${escapeHtml(review.summary?.spacesChanged || 0)} space${Number(review.summary?.spacesChanged)===1?'':'s'} ready to publish</h3></div><button class="icon-button" data-close-publish-review aria-label="Close review">×</button></div>
      <div class="review-capacity"><div><span>Daily capacity</span><strong>${escapeHtml(review.summary?.dailyCapacity?.before || 0)} → ${escapeHtml(review.summary?.dailyCapacity?.after || 0)}</strong></div><div><span>Monthly capacity</span><strong>${escapeHtml(review.summary?.monthlyCapacity?.before || 0)} → ${escapeHtml(review.summary?.monthlyCapacity?.after || 0)}</strong></div></div>
      ${errors.length ? `<div class="inline-alert error"><strong>${errors.length} issue${errors.length===1?'':'s'} must be resolved</strong>${errors.map(item=>`<span>${escapeHtml(item.message)}</span>`).join('')}</div>` : ''}
      <div class="review-change-list">${changes.length ? changes.slice(0,50).map(item => `<div><strong>Space ${escapeHtml(item.before.number)}${item.before.number!==item.after.number?` → ${escapeHtml(item.after.number)}`:''}</strong><span>${escapeHtml(item.before.bookingTerm||item.before.access)} → ${escapeHtml(item.after.bookingTerm||item.after.access)} · ${escapeHtml(item.after.vehicleType==='BOBTAIL'?'Bobtail':'General Truck')}</span></div>`).join('') : '<p>No customer-facing space changes are pending.</p>'}</div>
      <details><summary>Validation details</summary><p>${review.validation?.ready ? 'All required checks passed.' : 'Only the issues shown above block publication.'}</p></details>
      <div class="dialog-actions"><button class="btn ghost" data-close-publish-review>Cancel</button><button class="btn primary" data-publish-layout data-layout-id="${escapeHtml(review.layout?.id || '')}" data-layout-version="${escapeHtml(review.layout?.version || '')}" ${!review.validation?.ready || !changes.length?'disabled':''}>Publish Changes</button></div>
    </dialog>`;
  }

  function renderBulkPreview() {
    const preview = state.bulkPreview;
    if (!preview) return '';
    const items = preview.items || [];
    return `<dialog class="simple-review-dialog" id="bulkSpacePreview" open aria-labelledby="bulkPreviewHeading"><div class="review-heading"><div><p class="eyebrow">BULK EDIT PREVIEW</p><h3 id="bulkPreviewHeading">${items.length} spaces selected</h3></div><button class="icon-button" data-close-bulk-preview aria-label="Close preview">×</button></div><div class="review-change-list">${items.map(item=>`<div><strong>Space ${escapeHtml(item.before.spaceNumber)}</strong><span>${escapeHtml(item.before.bookingTerm||item.before.access)} → ${escapeHtml(item.after.bookingTerm||item.after.access)} · ${escapeHtml(item.after.vehicleType==='BOBTAIL'?'Bobtail':'General Truck')}</span></div>`).join('')}</div>${preview.review?.validation?.errors?.length?`<div class="inline-alert error"><strong>Conflicts</strong>${preview.review.validation.errors.map(item=>`<span>${escapeHtml(item.message)}</span>`).join('')}</div>`:'<div class="inline-alert success"><strong>No blocking conflicts found</strong></div>'}<div class="dialog-actions"><button class="btn ghost" data-close-bulk-preview>Cancel</button><button class="btn primary" data-apply-bulk ${preview.review?.validation?.errors?.length?'disabled':''}>Apply to Draft</button></div></dialog>`;
  }

  function renderParkingLot({ setup = false } = {}) {
    const lot = state.privateData.liveLot;
    const pageName = setup ? 'Lot Setup' : 'Live Lot';
    if (!lot) return emptyServerPanel(pageName);
    const spaces = Array.isArray(lot.spaces) ? lot.spaces : [];
    const matching = spaces.filter(lotMatches);
    const matchingIds = new Set(matching.map(space=>String(space.id)));
    const byId = new Map(spaces.map(space => [String(space.id), space]));
    const moveDestinationIds = new Set((state.liveLotMove?.alternatives || []).map(item => String(item.id)));
    const elements = Array.isArray(lot.layout?.elements) ? lot.layout.elements : [];
    let accessRendered = false;
    const map = elements.map(element => {
      const style = `left:${Number(element.x)}%;top:${Number(element.y)}%;width:${Number(element.width)}%;height:${Number(element.height)}%;z-index:${Number(element.zOrder || 1)};transform:rotate(${Number(element.rotation || 0)}deg)`;
      if (!element.spaceId) {
        if (['ENTRANCE','EXIT'].includes(element.type)) {
          if (accessRendered) return '';
          accessRendered = true;
          return `<div class="operational-map-context shared-access-point" style="${style}" aria-label="Entrance / Exit"><span>Entrance / Exit</span></div>`;
        }
        const showContextLabel = ['BUILDING','LABEL'].includes(String(element.type || '').toUpperCase());
        return `<div class="operational-map-context type-${statusClass(element.type)}" style="${style}" aria-hidden="true">${showContextLabel ? `<span>${escapeHtml(display(element.label))}</span>` : ''}</div>`;
      }
      const space = byId.get(String(element.spaceId));
      if (!space) return '';
      const selected = String(space.id) === state.privateData.selectedSpaceId;
      const bulkSelected = state.selectedSpaceIds.has(String(space.id));
      const visible = matchingIds.has(String(space.id));
      const moveDestination = state.liveLotMove && moveDestinationIds.has(String(space.id));
      const moveUnavailable = state.liveLotMove && !moveDestination;
      const moveLabel = moveDestination ? ', compatible destination' : moveUnavailable ? ', not a compatible destination' : '';
      return `<button class="operational-map-space ${allocationClass(space)} ${statusClass(space.operationalStatus)} purpose-${statusClass(space.parkingPurpose)} term-${statusClass(space.bookingTerm)} ${selected ? 'selected' : ''} ${bulkSelected?'bulk-selected':''} ${visible?'':'filtered-out'} ${moveDestination ? 'move-destination' : ''} ${moveUnavailable ? 'move-unavailable' : ''}" style="${style}" data-space-id="${escapeHtml(space.id)}" aria-pressed="${selected||bulkSelected}" aria-label="Lot ${escapeHtml(space.number)}, ${escapeHtml(allocationLabel(space))}, ${employeeLabel(space.operationalStatus)}${moveLabel}" ${moveUnavailable ? 'disabled' : ''}><span>${escapeHtml(space.number)}</span>${space.bookingTerm ? `<b>${space.bookingTerm==='DAILY'?'D':'M'}</b>` : ''}</button>`;
    }).join('');
    const summary = lot.summary || {};
    const selectedSpace = spaces.find(space=>String(space.id)===String(state.privateData.selectedSpaceId));
    const filterButton = (dimension,value,label) => `<button type="button" class="filter-chip ${state.lotFilters[dimension]===value?'active':''}" data-lot-filter="${dimension}" data-lot-filter-value="${value}" aria-pressed="${state.lotFilters[dimension]===value}">${label}</button>`;
    const canConfigure = setup && state.user.role === 'OWNER';
    const pendingCount = canConfigure ? Number(state.publishReview?.summary?.spacesChanged || 0) : 0;
    const customerSpaces = spaces.filter(space => (space.accessType || space.parkingPurpose) === 'CUSTOMER');
    const dailySpaces = customerSpaces.filter(space => space.bookingTerm === 'DAILY').length;
    const monthlySpaces = customerSpaces.filter(space => space.bookingTerm === 'MONTHLY').length;
    const unavailableSpaces = customerSpaces.filter(space => ['BLOCKED','INACTIVE'].includes(space.operationalStatus)).length;
    const availableNow = customerSpaces.filter(space => space.operationalStatus === 'AVAILABLE').length;
    return `<div class="parking-lot-page">
      <div class="parking-page-heading"><div><h2>${pageName}</h2><p>${setup ? 'Click any numbered space to change its number, vehicle type, rental type, or availability.' : 'See what is available, reserved, occupied, or unavailable right now.'}</p></div><div class="heading-actions"><span>${escapeHtml(liveUpdateText())}</span><button class="btn ghost compact" data-refresh>Refresh</button>${setup ? '<button class="btn ghost compact" data-nav="Advanced Map Tools">Advanced Map Tools</button>' : `<a class="btn primary" href="${escapeHtml(config.customerAppUrl)}" target="_blank" rel="noopener noreferrer">Open Customer Booking</a>`}</div></div>
      ${setup ? `<div class="lot-summary" aria-label="Lot setup summary"><div><span>Customer Spaces</span><strong>${escapeHtml(customerSpaces.length)}</strong></div><div><span>Daily Spaces</span><strong>${escapeHtml(dailySpaces)}</strong></div><div><span>Monthly Spaces</span><strong>${escapeHtml(monthlySpaces)}</strong></div>${unavailableSpaces>0?`<div class="warning"><span>Unavailable</span><strong>${escapeHtml(unavailableSpaces)}</strong></div>`:''}</div>` : `<div class="lot-summary" aria-label="Live lot summary"><div><span>Available Now</span><strong>${escapeHtml(availableNow)}</strong></div><div><span>Daily Available</span><strong>${escapeHtml(summary.dailyAvailable||0)}</strong></div><div><span>Monthly Available</span><strong>${escapeHtml(summary.monthlyAvailable||0)}</strong></div>${Number(summary.occupied)>0?`<div><span>Occupied Now</span><strong>${escapeHtml(summary.occupied)}</strong></div>`:''}${Number(summary.blocked)>0?`<div class="warning"><span>Unavailable</span><strong>${escapeHtml(summary.blocked)}</strong></div>`:''}</div>`}
      <div class="lot-filter-bar"><form method="post" id="spaceSearchForm"><label class="sr-only" for="spaceSearch">Search spaces</label><input id="spaceSearch" type="search" inputmode="numeric" value="${escapeHtml(state.lotSearch)}" placeholder="Search space #"><button class="btn ghost compact">Search</button></form><div class="filter-chips"><button type="button" class="filter-chip ${Object.values(state.lotFilters).every(value=>!value)?'active':''}" data-clear-lot-filters>All</button>${filterButton('bookingTerm','DAILY','Daily')}${filterButton('bookingTerm','MONTHLY','Monthly')}${setup?`${filterButton('vehicleType','GENERAL','General')}${filterButton('vehicleType','BOBTAIL','Bobtail')}`:''}${filterButton('operationalStatus','AVAILABLE','Available')}${setup?'':`${filterButton('operationalStatus','RESERVED','Reserved')}${filterButton('operationalStatus','OCCUPIED','Occupied')}`}${filterButton('operationalStatus','BLOCKED','Unavailable')}${setup?filterButton('accessType','INTERNAL','Internal'):''}<button type="button" class="filter-chip" data-clear-lot-filters>Clear</button></div>${canConfigure?`<button class="btn ghost compact" type="button" data-toggle-bulk aria-pressed="${state.bulkMode}">${state.bulkMode?'Done Selecting':'Select Multiple'}</button>`:''}</div>
      ${canConfigure && state.bulkMode ? `<div class="bulk-toolbar"><strong>${state.selectedSpaceIds.size} selected</strong><button class="btn ghost compact" data-select-daily-range>Select spaces 110–148</button><button class="btn ghost compact" data-select-term="DAILY">Select all Daily</button><button class="btn ghost compact" data-select-term="MONTHLY">Select all Monthly</button><button class="btn ghost compact" data-select-visible>Select visible</button><button class="btn ghost compact" data-clear-selection>Clear</button><label>Apply<select id="bulkAction"><option value="">Choose change</option><option value="term:DAILY">Set to Daily</option><option value="term:MONTHLY">Set to Monthly</option><option value="vehicle:GENERAL">Set to General</option><option value="vehicle:BOBTAIL">Set to Bobtail</option><option value="access:CUSTOMER">Use: Customer Parking</option><option value="access:SHOP">Use: Shop</option><option value="access:COMPANY">Use: Company</option><option value="access:INTERNAL">Use: Internal</option><option value="control:ACTIVE">Make Available</option><option value="control:INACTIVE">Make Unavailable</option></select></label><button class="btn primary compact" data-preview-bulk ${state.selectedSpaceIds.size?'':'disabled'}>Preview</button></div>` : ''}
      ${state.liveLotMove ? `<div class="note"><b>Move Customer:</b> choose one of the ${escapeHtml(moveDestinationIds.size)} compatible available destination space${moveDestinationIds.size === 1 ? '' : 's'} on the map. <button type="button" class="btn ghost compact" data-cancel-live-lot-move>Cancel move</button></div>` : ''}
      ${matching.length ? '' : '<div class="empty-state">No spaces match these filters. Clear filters to see the full parking lot.</div>'}
      <div class="parking-lot-workspace"><section class="parking-map-card" aria-label="Interactive parking map"><div class="map-legend-groups"><div class="allocation-legend"><strong>Official Allocation</strong><span class="monthly-bobtail">Monthly Bobtail</span><span class="monthly-truck-trailer">Monthly Truck &amp; Trailer</span><span class="car-hauler">Car Hauler</span><span class="daily">Daily</span><span class="shop">Shop</span><span class="company">Company</span></div><div class="status-legend"><strong>Status Marker</strong><span class="available">Available</span><span class="reserved">Reserved</span><span class="occupied">Occupied</span><span class="blocked">Unavailable</span><span class="inactive">Closed</span></div></div><div class="operational-map-stage" data-published-layout-id="${escapeHtml(lot.location?.publishedLayoutId || '')}" aria-label="Parking Lot map. Select a numbered space to view details.">${map || '<p class="muted">No published map is available.</p>'}<div class="daily-parking-annotation"><strong>Daily Parking</strong><span>Spaces 110–148</span></div></div></section>${renderSpaceDetails(selectedSpace,{ setup })}</div>
      <details class="lot-list-fallback"><summary>View accessible space list (${matching.length})</summary><div class="space-table-wrap"><table><thead><tr><th>Space</th><th>Vehicle Type</th><th>Rental Type</th><th>Use</th><th>Current Status</th><th>Current Reservation</th><th>Next Reservation</th><th>Actions</th></tr></thead><tbody>${matching.map(space=>`<tr><td>${escapeHtml(space.number)}</td><td>${escapeHtml(space.vehicleType==='BOBTAIL'?'Bobtail':'General Truck')}</td><td>${escapeHtml(space.bookingTerm||'—')}</td><td>${escapeHtml(space.accessType||space.parkingPurpose)}</td><td>${escapeHtml(space.operationalStatus)}</td><td>${escapeHtml(space.currentReservation?.reservationNumber||'None')}</td><td>${escapeHtml(space.nextReservation?.reservationNumber||'None')}</td><td><button class="btn ghost compact" data-space-id="${escapeHtml(space.id)}">View</button></td></tr>`).join('')}</tbody></table></div></details>
      ${pendingCount ? `<div class="pending-publish-bar"><strong>${pendingCount} customer-facing change${pendingCount===1?'':'s'} ready to publish</strong><button class="btn primary" data-review-pending data-layout-id="${escapeHtml(state.publishReview.layout?.id||'')}">Review Changes</button></div>` : ''}
      ${canConfigure ? `${renderPublishReview()}${renderBulkPreview()}` : ''}
    </div>`;
  }

  function renderLiveLot() { return renderParkingLot({ setup: false }); }

  function renderLotSetup() { return renderParkingLot({ setup: true }); }

  function reservationSearch() {
    return `<form method="post" id="reservationSearch" class="panel"><div class="panel-head green">Server Search</div><div class="panel-body"><div class="grid-2">
      <label class="field"><span>Search</span><input id="reservationQuery" value="${escapeHtml(state.search)}" placeholder="Reservation, customer, company, phone, unit, or plate"></label>
      <label class="field"><span>Status</span><select id="reservationStatus"><option value="">All statuses</option>${['PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED'].map(status => `<option value="${status}" ${state.status === status ? 'selected' : ''}>${employeeLabel(status)}</option>`).join('')}</select></label>
      </div><div class="row-actions"><button class="btn primary" type="submit">Query ParkingOps</button><button class="btn ghost" type="button" data-clear-search>Clear</button></div></div></form>`;
  }

  function renderReservations() {
    const bookings = state.privateData.bookings;
    const pagination = state.privateData.bookingsPagination || {};
    const page = state.privateData.bookingCursorHistory.length + 1;
    return `${sectionHeader('Reservations', 'Reservation records and actions are loaded from and written to ParkingOps.', '<div class="heading-actions"><button class="btn primary" data-nav="Reservation Desk">New Reservation</button><button class="btn ghost" data-refresh>Refresh All</button></div>')}
      ${reservationSearch()}
      <div class="panel"><div class="panel-head">Reservations · page ${page} (${bookings.length} rows)</div><div class="panel-body">${bookings.length ? `<div class="table-wrap reservation-table-wrap"><table class="data-table reservation-table"><thead><tr><th>Lot #</th><th>Customer</th><th>Plate / Unit</th><th>Type</th><th>Dates</th><th>Payment</th><th>Status</th></tr></thead><tbody>${bookings.map(booking => { const customerName = booking.customer_display_name || fullName(booking); const companyName = booking.customer_account_company_name || booking.company_name; const openWeekly = booking.parking_product === 'WEEKLY' && !booking.departure_at; return `<tr class="clickable-row" data-booking-id="${escapeHtml(booking.id)}"><td>${booking.assigned_spot_id ? `<button type="button" class="lot-link" data-open-space-id="${escapeHtml(booking.assigned_spot_id)}" data-lot-number="${escapeHtml(booking.assigned_spot_label)}">${escapeHtml(booking.assigned_spot_label)}</button>` : `<b>${escapeHtml(display(booking.assigned_spot_label))}</b>`}</td><td>${booking.customer_public_id ? `<button type="button" class="customer-link table-customer-link" data-customer-id="${escapeHtml(booking.customer_public_id)}">${escapeHtml(customerName)}</button>` : `<b>${escapeHtml(customerName)}</b>`}${companyName && companyName !== customerName ? `<small>${escapeHtml(companyName)}</small>` : ''}</td><td><b>${escapeHtml([booking.license_plate_state,booking.license_plate].filter(Boolean).join(' ') || '—')}</b><small>Unit ${escapeHtml(display(booking.tractor_unit_number))}</small></td><td><b>${escapeHtml(display(booking.parking_product).replaceAll('_',' '))}</b><small>${escapeHtml(assignmentPresentation(booking).model)}</small></td><td><b>${escapeHtml(openWeekly ? `Start ${formatDate(booking.arrival_at)}` : formatDate(booking.arrival_at))}</b><small>${openWeekly ? 'Open-ended · $100/week' : `to ${escapeHtml(formatDate(booking.departure_at))}`}</small></td><td><span class="badge ${statusClass(booking.payment_status)}">${escapeHtml(paymentDisplay(booking.payment_status))}</span><small>${escapeHtml(money(bookingTotal(booking)))}</small></td><td><span class="badge ${statusClass(booking.status)}">${escapeHtml(display(booking.status))}</span><small>${escapeHtml(display(booking.reservation_number))}</small></td></tr>`; }).join('')}</tbody></table></div>` : '<p class="muted">No reservations were returned for this server query.</p>'}<div class="pagination"><button class="btn ghost" data-bookings-previous ${state.privateData.bookingCursorHistory.length ? '' : 'disabled'}>Previous</button><span>Bounded server page · ${escapeHtml(pagination.limit || 50)} maximum</span><button class="btn ghost" data-bookings-next data-next-cursor="${escapeHtml(pagination.nextCursor || '')}" ${pagination.hasMore ? '' : 'disabled'}>Next</button></div></div></div>
      ${renderBookingDetail()}`;
  }

  async function loadCustomerDetail(publicId, focusSection = '') {
    state.privateData.selectedCustomerId = String(publicId || '');
    state.privateData.customerDetail = null;
    state.loading = true; state.error = ''; render();
    try { state.privateData.customerDetail = await api.customer(publicId); }
    catch (error) { if (error?.status !== 401) state.error = error?.message || 'Customer details could not be loaded.'; }
    finally {
      state.loading = false;
      render();
      const focusId = focusSection === 'documents' ? 'customerDocuments' : focusSection === 'payment' ? 'customerPayments' : '';
      if (focusId) requestAnimationFrame(() => document.querySelector(`#${focusId}`)?.focus({ preventScroll: true }) || document.querySelector(`#${focusId}`)?.scrollIntoView({ block: 'start' }));
    }
  }

  async function loadCustomerMatrix() {
    state.loading = true; state.error = ''; render();
    try { state.privateData.customerMatrix = await api.customerMatrix(state.customerMatrixYear); }
    catch (error) { if (error?.status !== 401) state.error = error?.message || 'Payment Matrix could not be loaded.'; }
    finally { state.loading = false; render(); }
  }

  function renderDocumentActions(document, type, customerId = '') {
    const scope = customerId ? ` data-document-customer="${escapeHtml(customerId)}"` : '';
    return `<div class="row-actions"><button class="btn ghost" data-document-access="${escapeHtml(document.public_id)}" data-document-disposition="INLINE"${scope}>View</button><button class="btn ghost" data-document-access="${escapeHtml(document.public_id)}" data-document-disposition="ATTACHMENT"${scope}>Download</button>${document.verification_status !== 'APPROVED' ? `<button class="btn primary" data-document-review="${escapeHtml(document.public_id)}" data-document-type="${escapeHtml(type)}" data-review-status="APPROVED"${scope}>Approve</button>` : ''}${document.verification_status !== 'REJECTED' ? `<button class="btn red" data-document-review="${escapeHtml(document.public_id)}" data-document-type="${escapeHtml(type)}" data-review-status="REJECTED"${scope}>Reject</button>` : ''}${document.verification_status !== 'REPLACEMENT_REQUESTED' ? `<button class="btn red" data-document-review="${escapeHtml(document.public_id)}" data-document-type="${escapeHtml(type)}" data-review-status="REPLACEMENT_REQUESTED"${scope}>Request Replacement</button>` : ''}</div>`;
  }

  function renderBookingDocuments(detail) {
    const rows = Array.isArray(detail.documents) ? detail.documents : [];
    const cards = ['DRIVER_LICENSE','INSURANCE'].map(type => {
      const document = rows.find(item => item.document_type === type);
      if (!document) return `<article class="calendar-event document-review-card"><b>${documentTypeLabel(type)}</b><span>Missing</span><em>No document received</em></article>`;
      const status = documentStatusLabel(document.verification_status);
      return `<article class="calendar-event document-review-card"><b>${escapeHtml(documentTypeLabel(type))} — ${escapeHtml(status)}</b><span>${escapeHtml(document.original_filename)} · revision ${escapeHtml(document.revision)} · ${escapeHtml(display(document.declared_mime_type))}</span><em>Uploaded ${escapeHtml(formatDateTime(document.uploaded_at))}</em>${renderDocumentActions(document, type)}</article>`;
    }).join('');
    return `<div class="panel"><div class="panel-head">Documents</div><div class="panel-body"><div class="document-review-grid">${cards}</div></div></div>`;
  }

  function renderCustomerAccount(account) {
    if (!account) return '<div class="note"><b>My Parking account:</b> This reservation is not linked to a customer account. Historical access remains protected by the original lookup credential and verified-contact claim flow.</div>';
    const reservations = Array.isArray(account.reservations) ? account.reservations : [];
    const vehicles = Array.isArray(account.vehicles) ? account.vehicles : [];
    const documents = Array.isArray(account.documents) ? account.documents : [];
    return `<div class="panel customer-account-summary"><div class="panel-head green">My Parking Customer Account</div><div class="panel-body">
      <div class="row-actions"><button class="btn ghost compact" data-customer-id="${escapeHtml(account.publicId)}">Open Customer Workspace</button></div>
      <div class="grid-4">
        <div class="snapshot-item"><span>Customer</span><b>${escapeHtml(`${account.firstName} ${account.lastName}`)}</b><small>${escapeHtml(account.status)}</small></div>
        <div class="snapshot-item"><span>Phone</span><b>${escapeHtml(display(account.phone))}</b><small>${account.phoneVerified ? 'Verified' : 'Not verified'}</small></div>
        <div class="snapshot-item"><span>Email</span><b>${escapeHtml(display(account.email))}</b><small>${account.emailVerified ? 'Verified' : 'Not verified'}</small></div>
        <div class="snapshot-item"><span>Linked activity</span><b>${escapeHtml(account.reservationCount)} reservations</b><small>${escapeHtml(account.vehicleCount)} vehicles · ${escapeHtml(account.paidPaymentCount)} paid payments</small></div>
      </div>
      ${account.openConflictCount ? `<div class="error">${escapeHtml(account.openConflictCount)} open identity-recovery conflict${Number(account.openConflictCount) === 1 ? '' : 's'}. Accounts were not automatically merged.</div>` : ''}
      <div class="grid-2"><div><h4>Recent linked parking</h4>${reservations.length ? reservations.map(item => `<div class="calendar-event"><b>${escapeHtml(item.reservationNumber)}</b><span>${escapeHtml(display(item.product))} · ${escapeHtml(display(item.status))} · ${escapeHtml(display(item.paymentStatus))}${item.space ? ` · Position ${escapeHtml(item.space)}` : ''}</span><em>${item.product === 'WEEKLY' && !item.departureAt ? `Start ${escapeHtml(formatDateTime(item.arrivalAt))} · $100/week` : `${escapeHtml(formatDateTime(item.arrivalAt))} – ${escapeHtml(formatDateTime(item.departureAt))}`}</em></div>`).join('') : '<p class="muted">No linked parking.</p>'}</div>
      <div><h4>Vehicles and documents</h4>${vehicles.length ? vehicles.map(item => `<div class="calendar-event"><b>${escapeHtml(item.unitNumber)}</b><span>${escapeHtml(item.licensePlate)} · ${escapeHtml(item.licensePlateState)} · ${escapeHtml(item.classification)}</span></div>`).join('') : '<p class="muted">No active vehicles.</p>'}${documents.length ? documents.map(item => `<div class="calendar-event"><b>${escapeHtml(display(item.type))}</b><span>${escapeHtml(display(item.verificationStatus))}${item.expiresAt ? ` · expires ${escapeHtml(formatDate(item.expiresAt))}` : ''}</span></div>`).join('') : '<p class="muted">No account documents.</p>'}</div></div>
      ${state.user?.role === 'OWNER' ? `<form method="post" id="customerRecoveryForm" data-customer-public-id="${escapeHtml(account.publicId)}"><div class="panel-head">Audited account recovery</div><p class="muted">Use only after ownership is verified outside this browser session. Every customer session is revoked. Identifier collisions create a conflict and are never merged.</p><div class="grid-2"><label class="field"><span>Contact to replace</span><select name="contactType"><option value="PHONE">Phone</option><option value="EMAIL">Email</option></select></label><label class="field"><span>New verified phone or email</span><input name="identifier" maxlength="254" required></label><label class="field"><span>Verification reference</span><input name="verificationReference" maxlength="160" required></label><label class="field"><span>Recovery reason</span><textarea name="reason" maxlength="1000" required></textarea></label></div><label class="check"><input name="verifiedOwnership" type="checkbox" required> I verified this customer's ownership outside this browser session.</label><div class="row-actions"><button class="btn red" type="submit">Apply verified recovery</button></div></form>` : ''}
    </div></div>`;
  }

  function renderBookingDetail() {
    const detail = state.privateData.bookingDetail;
    if (!state.privateData.selectedBookingId) return '';
    if (!detail?.booking) return '<div class="panel"><div class="panel-body"><p class="muted">Reservation detail is loading or unavailable.</p></div></div>';
    const booking = detail.booking;
    const openEndedWeekly = booking.parking_product === 'WEEKLY' && !booking.departure_at;
    const presentation = assignmentPresentation(booking);
    const areaMode = presentation.area;
    const actions = (TRANSITIONS[booking.status] || []).filter(([action]) => action !== 'confirm' || ['PAID','NOT_REQUIRED'].includes(booking.payment_status));
    const alternatives = state.privateData.bookingAlternatives;
    const account = detail.customerAccount;
    const customerName = account?.displayName || account?.companyName || [account?.firstName,account?.lastName].filter(Boolean).join(' ') || fullName(booking);
    const customerCompany = account?.companyName || booking.company_name;
    const customerIdentity = [account?.usdotNumber || booking.usdot_number ? `DOT ${account?.usdotNumber || booking.usdot_number}` : '', account?.mcNumber ? `MC ${account.mcNumber}` : ''].filter(Boolean).join(' · ');
    const assignedSpotId = booking.assigned_spot_id || detail.assignments?.find(item => !item.released_at)?.parking_spot_id || '';
    const deskAction = booking.booking_source === 'ADMIN_DESK' ? `<button type="button" class="btn ghost compact" data-open-desk-reservation="${escapeHtml(booking.id)}">Open in Reservation Desk</button>` : '';
    return `<div class="panel"><div class="panel-head blue">Reservation ${escapeHtml(display(booking.reservation_number))}</div><div class="panel-body">
      <div class="row-actions reservation-detail-actions">${account?.publicId ? `<button type="button" class="btn ghost compact" data-customer-id="${escapeHtml(account.publicId)}">Open Customer</button>` : ''}${assignedSpotId ? `<button type="button" class="btn ghost compact" data-open-space-id="${escapeHtml(assignedSpotId)}" data-lot-number="${escapeHtml(booking.assigned_spot_label || '')}">View on Live Lot</button>` : ''}${deskAction}</div>
      <section class="reservation-customer-section" aria-label="Reservation customer"><div class="reservation-customer-heading"><div><span>Customer</span><h3>${escapeHtml(customerName)}</h3>${customerCompany && customerCompany !== customerName ? `<p>${escapeHtml(customerCompany)}</p>` : ''}</div>${account?.publicId ? `<button type="button" class="btn primary" data-customer-id="${escapeHtml(account.publicId)}">Open Customer</button>` : '<span class="badge">Unlinked historical record</span>'}</div><dl class="reservation-customer-facts"><div><dt>Phone</dt><dd>${escapeHtml(display(account?.phone || booking.mobile_phone))}</dd></div><div><dt>Email</dt><dd>${escapeHtml(display(account?.email || booking.email))}</dd></div><div><dt>Plate</dt><dd>${escapeHtml([booking.license_plate_state,booking.license_plate].filter(Boolean).join(' ') || '—')}</dd></div><div><dt>Unit #</dt><dd>${escapeHtml(display(booking.tractor_unit_number))}</dd></div><div><dt>Lot #</dt><dd>${escapeHtml(display(booking.assigned_spot_label))}</dd></div>${customerIdentity ? `<div><dt>DOT / MC</dt><dd>${escapeHtml(customerIdentity)}</dd></div>` : ''}</dl></section>
      <div class="grid-4">
        <div class="snapshot-item"><span>Status</span><b>${escapeHtml(display(booking.status))}</b></div>
        <div class="snapshot-item"><span>Payment / billing</span><b>${escapeHtml(paymentDisplay(booking.payment_status))}</b><small>${escapeHtml(display(booking.subscription_status))}</small></div>
        <div class="snapshot-item"><span>Customer</span><b>${escapeHtml(fullName(booking))}</b></div>
        <div class="snapshot-item"><span>${areaMode ? 'Parking area' : presentation.monthly ? 'Space' : 'Historical position'}</span><b>${escapeHtml(areaMode ? booking.category_name || 'Parking Area' : display(booking.assigned_spot_label))}</b></div>
        <div class="snapshot-item"><span>Total</span><b>${escapeHtml(money(bookingTotal(booking)))}</b></div>
        <div class="snapshot-item"><span>Documents</span><b>${escapeHtml((detail.documents || []).length)} of 2 received</b><small>Driver License and Insurance</small></div>
      </div>
      <div class="grid-2">
        <div><p><b>${openEndedWeekly ? 'Start' : 'Arrival'}:</b> ${escapeHtml(formatDateTime(booking.arrival_at))}${openEndedWeekly ? '<br><b>Rate:</b> $100/week' : `<br><b>Departure:</b> ${escapeHtml(formatDateTime(booking.departure_at))}`}<br><b>Category:</b> ${escapeHtml(display(booking.category_name))}<br><b>Area:</b> ${escapeHtml(display(booking.zone_name))}</p></div>
        <div><p><b>Company / Carrier:</b> ${escapeHtml(display(booking.company_name))}<br><b>Phone:</b> ${escapeHtml(display(booking.mobile_phone))}<br><b>Email:</b> ${escapeHtml(display(booking.email))}<br><b>Unit:</b> ${escapeHtml(display(booking.tractor_unit_number))}<br><b>Plate:</b> ${escapeHtml(display(booking.license_plate))}</p></div>
      </div>
      ${renderCustomerAccount(detail.customerAccount)}
      ${booking.payment_status === 'NOT_REQUIRED' ? `<div class="note pay-on-site-note"><b>Pay at the office:</b> ${escapeHtml(money(bookingTotal(booking)))}${booking.parking_product === 'MONTHLY' ? ' first month, then the monthly rate on the 1st' : ' when the customer leaves'}. Nothing is charged online.${account?.publicId ? `<div class="row-actions"><button type="button" class="btn primary compact" data-customer-id="${escapeHtml(account.publicId)}" data-customer-focus="payment">Record payment</button></div>` : ''}</div>` : ''}
      ${booking.payment_status === 'NOT_REQUIRED' ? '' : `<div class="note"><b>Payment:</b> ${escapeHtml(paymentDisplay(booking.payment_status))}${booking.payment_status === 'DEMO_BYPASSED' ? '<br><b>Financially paid:</b> NO · This QA reservation is excluded from revenue.' : ''}${booking.subscription_status ? ` · Subscription ${escapeHtml(booking.subscription_status)}` : ''}${booking.billing_period_end_at ? `<br><b>Paid through / current period end:</b> ${escapeHtml(formatDateTime(booking.billing_period_end_at))}` : ''}${booking.payment_grace_ends_at ? `<br><b>Payment grace ends:</b> ${escapeHtml(formatDateTime(booking.payment_grace_ends_at))}` : ''}<br><span>Stripe identifiers are retained by ParkingOps but are not used to let operators manufacture a paid state.</span></div>`}
      <div class="note"><b>Parking model: ${escapeHtml(presentation.model)}</b><br>${escapeHtml(presentation.guidance)}${presentation.monthly ? '<br>Monthly eligibility and the complete reservation interval were validated when the assignment was committed.' : ''}</div>
      ${renderBookingDocuments(detail)}
      ${actions.length ? `<label class="field"><span>Required operator reason</span><input id="bookingActionReason" maxlength="500"></label><label class="field"><span>Optional internal note</span><textarea id="bookingActionNote" maxlength="1000"></textarea></label><div class="row-actions">${actions.map(([action, label]) => `<button class="btn ${['cancel', 'no-show'].includes(action) ? 'red' : 'primary'}" data-booking-action="${action}" data-booking-version="${escapeHtml(booking.version)}">${escapeHtml(label)}</button>`).join('')}</div>` : '<div class="note">No status transitions are available for this reservation.</div>'}
      <div class="grid-2 operational-actions">
        ${areaMode ? `<div class="panel"><div class="panel-head">Parking-area commitment</div><div class="panel-body"><p><b>${escapeHtml(booking.category_name || 'Parking Area')}</b></p><p class="muted">No numbered position is assigned. This reservation consumes one area-capacity unit.</p></div></div>` : `<div class="panel"><div class="panel-head">${presentation.monthly ? 'Customer-selected monthly assignment' : 'Historical exact assignment'}</div><div class="panel-body">
          <button class="btn ghost" data-load-alternatives>View eligible alternatives</button>
          ${alternatives ? (alternatives.alternatives?.length ? `<form method="post" id="reassignmentForm"><label class="field"><span>Replacement space</span><select id="replacementSpot" required><option value="">Choose a space</option>${alternatives.alternatives.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.public_label)} · ${escapeHtml(item.area_name)}</option>`).join('')}</select></label><label class="field"><span>Required reassignment reason</span><input id="reassignmentReason" maxlength="500" required></label><button class="btn primary" type="submit">Reassign space</button></form>` : '<p class="muted">No eligible alternatives exist for the full reservation interval.</p>') : '<p class="muted">Alternatives are calculated by the backend on request.</p>'}
        </div></div>`}
        <div class="panel"><div class="panel-head">Standalone internal note</div><div class="panel-body"><form method="post" id="bookingNoteForm"><label class="field"><span>Operational note</span><textarea id="standaloneBookingNote" maxlength="1000" required></textarea></label><button class="btn primary" type="submit">Save note</button></form></div></div>
      </div>
      <div class="panel"><div class="panel-head">Status History</div><div class="panel-body">${(detail.history || []).map(item => `<div class="calendar-event"><b>${escapeHtml(display(item.new_status))}</b><span>${escapeHtml(display(item.reason))}</span><em>${escapeHtml(formatDateTime(item.created_at))}</em></div>`).join('') || '<p class="muted">No history rows returned.</p>'}</div></div>
      <div class="grid-2"><div class="panel"><div class="panel-head">${areaMode ? 'Parking-area commitment' : 'Assignment History'}</div><div class="panel-body">${(detail.assignments || []).map(item => `<div class="calendar-event"><b>Position ${escapeHtml(item.public_label)}</b><span>${escapeHtml(item.release_reason || item.assignment_reason || 'Assigned')}</span><em>${escapeHtml(formatDateTime(item.assigned_at))}${item.released_at ? ` – ${escapeHtml(formatDateTime(item.released_at))}` : ' – current'} · ${escapeHtml(formatDateTime(item.reserved_arrival_at))} to ${escapeHtml(formatDateTime(item.reserved_departure_at))}</em></div>`).join('') || `<p class="muted">${areaMode ? `${escapeHtml(booking.category_name || 'Parking Area')} · no numbered position assigned.` : 'No assignment history.'}</p>`}</div></div><div class="panel"><div class="panel-head">Internal Notes</div><div class="panel-body">${(detail.notes || []).map(item => `<div class="calendar-event"><b>${escapeHtml(item.username || 'ParkingOps')}</b><span>${escapeHtml(item.note)}</span><em>${escapeHtml(formatDateTime(item.created_at))}</em></div>`).join('') || '<p class="muted">No notes.</p>'}</div></div></div>
    </div></div>`;
  }

  function customerPaymentBadge(payment) {
    const status = payment?.status || 'NOT_DUE';
    return `<span class="badge ${statusClass(status)}">${escapeHtml(employeeLabel(status))}</span>`;
  }

  function renderCustomerMatrix() {
    const payload = state.privateData.customerMatrix;
    if (!payload) return emptyServerPanel('Payment Matrix');
    const months = Array.from({ length: 12 }, (_, index) => `${payload.year}-${String(index + 1).padStart(2, '0')}`);
    return `${sectionHeader('Payment Matrix', 'Monthly obligations and recorded payments from the canonical ledger.', '<button class="btn ghost compact" data-customer-list>Customer List</button>')}
      <div class="customer-toolbar panel"><div class="panel-body"><label class="field"><span>Year</span><select id="customerMatrixYear">${Array.from({ length: 5 }, (_, index) => payload.year - 3 + index).map(year => `<option value="${year}"${year === state.customerMatrixYear ? ' selected' : ''}>${year}</option>`).join('')}</select></label><button class="btn ghost" data-refresh-matrix>Refresh</button></div></div>
      <div class="panel"><div class="panel-head">${escapeHtml(payload.year)} Payment Matrix</div><div class="panel-body"><div class="customer-matrix-wrap"><table class="customer-matrix"><thead><tr><th>LOT #</th><th>Customer</th><th>Rate</th>${months.map(month => `<th>${escapeHtml(new Date(`${month}-15T12:00:00Z`).toLocaleString([], { month: 'short' }))}</th>`).join('')}</tr></thead><tbody>${(payload.customers || []).map(customer => {
        const indexed = Object.fromEntries((customer.periods || []).map(period => [period.period, period]));
        return `<tr><th>${escapeHtml((customer.lotNumbers || []).join(', ') || '—')}</th><th><button class="customer-link" data-customer-id="${escapeHtml(customer.publicId)}">${escapeHtml(customer.displayName)}</button></th><td>${escapeHtml(money(Number(customer.rateCents || 0)))}</td>${months.map(month => {
          const period = indexed[month];
          return period ? `<td><button class="matrix-cell state-${statusClass(period.status)}" data-customer-id="${escapeHtml(customer.publicId)}"><b>${escapeHtml(period.status.replaceAll('_', ' '))}</b><span>${period.status === 'LEGACY_DATA_MISSING' ? 'No financial effect' : escapeHtml(money(Number(period.paidCents || 0)))}</span>${Number(period.legacyAnomalyCount || 0) ? '<small>Legacy evidence anomaly excluded</small>' : ''}</button></td>` : '<td><span class="matrix-empty">—</span></td>';
        }).join('')}</tr>`;
      }).join('') || `<tr><td colspan="15" class="muted">No billing periods were recorded for ${escapeHtml(payload.year)}.</td></tr>`}</tbody></table></div></div></div>`;
  }

  function renderCustomerList() {
    const payload = state.privateData.customers;
    if (!payload) return emptyServerPanel('Customers');
    const rows = payload.customers || [];
    const totals = payload.totals || {};
    const pagination = payload.pagination || {};
    const filterButton = (name, value, label) => `<button type="button" class="btn ghost compact${state.customerFilters[name] === value ? ' is-active' : ''}" data-customer-filter="${name}" data-customer-filter-value="${value}">${label}</button>`;
    return `${sectionHeader('Customers', 'Customer directory and operational follow-up.', `<div class="row-actions"><button class="btn ghost compact" data-customer-matrix>Payment Matrix</button><button class="btn ghost compact" data-refresh-customers>Refresh</button></div>`)}
      <form method="post" id="customerSearch" class="panel customer-filter-panel"><div class="panel-body"><label class="field customer-search"><span>Search</span><input id="customerQuery" value="${escapeHtml(state.customerSearch)}" placeholder="Name, phone, email, plate, unit, DOT/MC"></label><div class="customer-filter-group"><span>Customers</span><div>${filterButton('status', '', 'All')}${filterButton('status', 'ACTIVE', 'Active')}${filterButton('status', 'FORMER', 'Former')}</div></div><div class="customer-filter-group"><span>Quick filters</span><div>${filterButton('payment', 'OVERDUE', 'Overdue')}${filterButton('documents', 'REVIEW', 'Documents')}${filterButton('parking', 'UNASSIGNED', 'Unassigned')}${filterButton('parking', 'UPCOMING', 'Upcoming')}</div></div><div class="row-actions"><button class="btn primary">Apply</button><button type="button" class="btn ghost" data-clear-customer-search>Clear</button></div></div></form>
      <div class="panel"><div class="panel-head">Customer page ${state.privateData.customerCursorHistory.length + 1} · ${escapeHtml(totals.customers ?? 0)} matching</div><div class="panel-body">${rows.length ? `<div class="table-wrap customer-table-wrap"><table class="customer-table"><thead><tr><th>CUSTOMER</th><th>PARKING</th><th>VEHICLE</th><th>PAYMENT</th><th>DOCUMENTS</th></tr></thead><tbody>${rows.map(customer => { const parkings = customer.currentParkings?.length ? customer.currentParkings : (customer.currentParking ? [customer.currentParking] : []); const currentParking = parkings[0] || null; const upcomingParking = customer.upcomingParking; const parking = currentParking || upcomingParking; const parkingLabel = parking ? [parking.spot && `Spot ${parking.spot}`, employeeLabel(parking.parkingProduct)].filter(Boolean).join(' · ') : 'No active parking'; const parkingDetail = currentParking ? (currentParking.spot ? 'Current parking' : 'Unassigned') : upcomingParking ? `Reserved · starts ${formatDate(upcomingParking.arrivalAt)}` : 'No active parking'; const vehicleLabel = [parking?.plate, parking?.unitNumber && `Unit ${parking.unitNumber}`].filter(Boolean).join(' · ') || [customer.latestVehicle?.plate, customer.latestVehicle?.unitNumber && `Unit ${customer.latestVehicle.unitNumber}`].filter(Boolean).join(' · ') || '—'; return `<tr class="clickable-row" data-customer-id="${escapeHtml(customer.publicId)}"><td><b>${escapeHtml(customer.displayName)}</b><br><small>${escapeHtml(customer.companyName || '')}</small></td><td><b>${escapeHtml(parkingLabel)}</b><br><small>${escapeHtml(parkingDetail)}</small></td><td>${escapeHtml(vehicleLabel)}</td><td>${customerPaymentBadge(customer.payment)}<br><small>${escapeHtml(Number(customer.payment.balanceCents || 0) > 0 ? `${money(Number(customer.payment.balanceCents))} balance` : customer.payment.period || 'Not due')}</small></td><td><span class="badge ${statusClass(customer.documentsStatus)}">${escapeHtml(employeeLabel(customer.documentsStatus))}</span></td></tr>`; }).join('')}</tbody></table></div>` : '<p class="muted">No customer records matched.</p>'}<div class="pagination"><button class="btn ghost" data-customers-previous ${state.privateData.customerCursorHistory.length ? '' : 'disabled'}>Previous</button><span>${escapeHtml(pagination.limit || 50)} maximum per page</span><button class="btn ghost" data-customers-next data-next-cursor="${escapeHtml(pagination.nextCursor || '')}" ${pagination.hasMore ? '' : 'disabled'}>Next</button></div></div></div>`;
  }

  function renderCustomerDocuments(payload) {
    const customerId = payload.customer?.publicId || '';
    const documents = Array.isArray(payload.documents) ? payload.documents : [];
    const cards = documents.map(document => {
      const type = String(document.document_type || 'INSURANCE').toUpperCase();
      const vehicle = [document.license_plate && `Plate ${document.license_plate}${document.license_plate_state ? ` (${document.license_plate_state})` : ''}`,
        document.tractor_unit_number && `Unit ${document.tractor_unit_number}`].filter(Boolean).join(' · ');
      const review = document.reviewed_at
        ? `Reviewed ${formatDateTime(document.reviewed_at)}${document.reviewed_by ? ` by ${document.reviewed_by}` : ''}`
        : 'Not reviewed yet';
      return `<article class="calendar-event document-review-card"><b>${escapeHtml(documentTypeLabel(type))}</b><span>Status: ${escapeHtml(documentStatusLabel(document.verification_status))}</span><span>${escapeHtml(vehicle || 'Vehicle details not recorded')}</span><em>Uploaded ${escapeHtml(formatDateTime(document.uploaded_at || document.created_at))} · ${escapeHtml(review)}${document.policy_expires_at ? ` · expires ${escapeHtml(formatDate(document.policy_expires_at))}` : ''}</em>${document.review_note ? `<small>Review note: ${escapeHtml(document.review_note)}</small>` : ''}${renderDocumentActions(document, type, customerId)}</article>`;
    }).join('');
    return `<section class="panel" id="customerDocuments" tabindex="-1"><div class="panel-head">Documents</div><div class="panel-body">${cards ? `<div class="document-review-grid">${cards}</div>` : '<p class="muted">No uploaded documents in the secure review workflow.</p>'}</div></section>`;
  }

  function renderCustomerDetail() {
    const payload = state.privateData.customerDetail;
    if (!payload) return emptyServerPanel('Customer');
    const customer = payload.customer;
    const periods = payload.billingPeriods || [];
    const currentMonth = new Date().toISOString().slice(0, 7);
    const currentRows = periods.filter(period => String(period.period_start).slice(0, 7) === currentMonth);
    const currentPeriod = currentRows.length ? (() => {
      const aggregate = currentRows.reduce((result, period) => ({
        amount_due_cents: result.amount_due_cents + Number(period.amount_due_cents || 0),
        paid_cents: result.paid_cents + Number(period.paid_cents || 0),
        balance_cents: result.balance_cents + Number(period.balance_cents || 0),
        credit_cents: result.credit_cents + Number(period.credit_cents || 0)
      }), { amount_due_cents: 0, paid_cents: 0, balance_cents: 0, credit_cents: 0 });
      aggregate.period_start = `${currentMonth}-01`;
      aggregate.status = aggregate.amount_due_cents === 0 ? 'NOT_DUE'
        : aggregate.paid_cents >= aggregate.amount_due_cents ? 'PAID'
          : aggregate.paid_cents > 0 ? 'PARTIAL'
            : currentRows.some(period => period.status === 'OVERDUE') ? 'OVERDUE' : 'DUE';
      return aggregate;
    })() : null;
    const outstandingBalance = periods.reduce((sum, period) => sum + Number(period.balance_cents || 0), 0);
    const payments = payload.payments || [];
    const lifetime = payments.filter(payment => payment.status === 'PAID').reduce((sum, payment) => sum + Number(payment.amount_cents || 0)
      + (payment.adjustments || []).reduce((adjusted, item) => adjusted + Number(item.amountCents || 0), 0), 0);
    const lastPayment = payments.find(payment => payment.status === 'PAID');
    const notes = payload.notes || [];
    const operationalParking = (payload.reservations || []).filter(booking => {
      // A checked-out stay is history even if the driver left before the planned departure.
      if (!['CONFIRMED','CHECKED_IN'].includes(booking.status)) return false;
      const openEndedRecurring = ['WEEKLY','MONTHLY'].includes(booking.parking_product) && !booking.departure_at;
      if (openEndedRecurring) return booking.status === 'CHECKED_IN'
        || (booking.status === 'CONFIRMED' && new Date(booking.arrival_at) > new Date());
      const coveredUntil = booking.parking_product === 'MONTHLY' && booking.billing_period_end_at
        ? booking.billing_period_end_at : booking.departure_at;
      return new Date(coveredUntil) > new Date();
    });
    const currentParking = operationalParking.filter(booking => booking.status === 'CHECKED_IN');
    const upcomingParking = operationalParking.filter(booking => booking.status === 'CONFIRMED');
    const operationalParkingIds = new Set(operationalParking.map(booking => String(booking.id)));
    const hasSentinelDate = value => String(value || '').startsWith('2099-');
    const parkingDateRange = booking => !booking.departure_at || hasSentinelDate(booking.departure_at)
      ? `Start ${formatDate(booking.arrival_at)}` : `${formatDate(booking.arrival_at)} – ${formatDate(booking.departure_at)}`;
    const unitRate = booking => Number(booking.snapshot?.recurringUnitRateCents ?? booking.snapshot?.unitRateCents ?? booking.snapshot?.totalCents ?? 0);
    const parkingRate = booking => `${money(unitRate(booking))}${booking.parking_product === 'WEEKLY' ? '/week' : booking.parking_product === 'MONTHLY' ? '/month' : '/day'}`;
    const canonicalParkingHistory = (payload.reservations || []).filter(booking => !operationalParkingIds.has(String(booking.id))).map(booking => `<button class="calendar-event clickable-row" data-booking-id="${escapeHtml(booking.id)}"><b>${escapeHtml(employeeLabel(booking.parking_product))}${booking.assigned_spot_label ? ` · ${escapeHtml(`Spot ${booking.assigned_spot_label}`)}` : ''}</b><span>${escapeHtml(parkingDateRange(booking))}${booking.snapshot?.totalCents ? ` · ${escapeHtml(money(Number(booking.snapshot.totalCents)))}` : ''}</span></button>`).join('');
    const legacyParkingHistory = (payload.legacyParkingRecords || []).map(record => `<div class="calendar-event"><b>${escapeHtml(employeeLabel(record.parking_type || 'Parking'))}${record.spot_label ? ` · ${escapeHtml(`Spot ${record.spot_label}`)}` : ''}</b><span>${escapeHtml(record.start_date ? formatDate(record.start_date) : 'Historical period')}${record.rate_cents ? ` · ${escapeHtml(money(Number(record.rate_cents)))}` : ''}</span></div>`).join('');
    const primaryParking = currentParking[0] || upcomingParking[0] || null;
    const profileLot = primaryParking?.assigned_spot_label || customer.legacyCurrentSpot || 'Unassigned';
    const profileProduct = primaryParking?.parking_product || (customer.legacyCurrentSpot ? 'MONTHLY' : 'No active parking');
    const profileRate = primaryParking ? unitRate(primaryParking) : Number(customer.legacyRateCents || 0);
    const profilePayment = currentPeriod?.status || primaryParking?.payment_status || 'NOT_DUE';
    const profileVehicle = primaryParking || (payload.vehicles || [])[0] || null;
    const parkingSummary = currentParking.length ? [primaryParking?.assigned_spot_label ? `Spot ${primaryParking.assigned_spot_label}` : 'Unassigned', employeeLabel(profileProduct)].join(' · ')
      : upcomingParking.length ? `Reserved${primaryParking?.assigned_spot_label ? ` · Spot ${primaryParking.assigned_spot_label}` : ''} · starts ${formatDate(primaryParking.arrival_at)}`
        : 'No current parking';
    const activeActions = `<div class="customer-workspace-actions">${primaryParking?.assigned_spot_id ? `<button type="button" class="btn ghost compact" data-open-space-id="${escapeHtml(primaryParking.assigned_spot_id)}" data-lot-number="${escapeHtml(primaryParking.assigned_spot_label || '')}">View on Live Lot</button>` : ''}${currentParking[0]?.assigned_spot_id ? `<button type="button" class="btn ghost compact" data-customer-move="${escapeHtml(currentParking[0].id)}" data-customer-space-id="${escapeHtml(currentParking[0].assigned_spot_id)}" data-lot-number="${escapeHtml(currentParking[0].assigned_spot_label || '')}">Move Parking</button>` : ''}<button type="button" class="btn ghost compact" data-customer-payment>Payment</button>${currentParking[0]?.status === 'CHECKED_IN' ? `<button type="button" class="btn red compact" data-customer-end="${escapeHtml(currentParking[0].id)}">End Parking</button>` : ''}</div>`;
    return `${sectionHeader(customer.displayName, 'Customer workspace', '<button class="btn ghost compact" data-customer-list>Back to Customers</button>')}
      <section class="customer-profile-summary" aria-label="Customer workspace summary"><div class="profile-identity"><span>Customer</span><strong>${escapeHtml(customer.displayName)}</strong><small>${escapeHtml([customer.companyName, customer.phone, customer.email].filter(Boolean).join(' · ') || 'No contact details on file')}</small></div><div><span>Parking</span><strong>${escapeHtml(parkingSummary)}</strong><small>${profileRate ? escapeHtml(money(profileRate)) : ''}</small></div><div><span>Vehicle</span><strong>${escapeHtml(profileVehicle?.license_plate || 'Plate not recorded')}</strong><small>${escapeHtml(profileVehicle?.tractor_unit_number ? `Unit ${profileVehicle.tractor_unit_number}` : 'Unit not recorded')}</small></div><div><span>Payment</span><strong>${customerPaymentBadge({ status: profilePayment })}</strong><small>Balance ${escapeHtml(money(outstandingBalance))}</small></div></section>
      ${activeActions}
      <div class="customer-detail-grid">
        <section class="panel"><div class="panel-head">Customer</div><div class="panel-body"><dl class="detail-list"><div><dt>Name / company</dt><dd>${escapeHtml(customer.displayName)}</dd></div><div><dt>Company</dt><dd>${escapeHtml(display(customer.companyName))}</dd></div><div><dt>Phone</dt><dd>${escapeHtml(display(customer.phone))}</dd></div><div><dt>Email</dt><dd>${escapeHtml(display(customer.email))}</dd></div><div><dt>DOT / MC</dt><dd>${escapeHtml([customer.usdotNumber && `DOT ${customer.usdotNumber}`, customer.mcNumber && `MC ${customer.mcNumber}`].filter(Boolean).join(' · ') || '—')}</dd></div></dl>${state.user.role === 'OWNER' ? `<form method="post" id="customerStatusForm" class="inline-form"><label class="field"><span>Customer status</span><select name="status"><option value="ACTIVE"${customer.lifecycleStatus === 'ACTIVE' ? ' selected' : ''}>Active</option><option value="FORMER"${customer.lifecycleStatus === 'FORMER' ? ' selected' : ''}>Former</option></select></label><label class="field grow"><span>Reason</span><input name="reason" maxlength="1000" required></label><button class="btn ghost">Update</button></form>` : ''}</div></section>
        <section class="panel" id="customerPayments" tabindex="-1"><div class="panel-head green">Payment Summary</div><div class="panel-body"><dl class="payment-summary"><div><dt>Outstanding balance</dt><dd>${escapeHtml(money(outstandingBalance))}</dd></div><div><dt>This month due</dt><dd>${escapeHtml(money(Number(currentPeriod?.amount_due_cents || 0)))}</dd></div><div><dt>This month paid</dt><dd>${escapeHtml(money(Number(currentPeriod?.paid_cents || 0)))}</dd></div><div><dt>Last payment</dt><dd>${escapeHtml(lastPayment ? formatDate(lastPayment.payment_date) : '—')}</dd></div><div><dt>Lifetime recorded</dt><dd>${escapeHtml(money(lifetime))}</dd></div><div><dt>Payment status</dt><dd>${customerPaymentBadge(currentPeriod ? { status: currentPeriod.status } : null)}</dd></div></dl></div></section>
      </div>
      <div class="grid-2"><section class="panel"><div class="panel-head">Current Parking</div><div class="panel-body">${currentParking.map(booking => `<button class="calendar-event clickable-row" data-booking-id="${escapeHtml(booking.id)}"><b>${escapeHtml(booking.assigned_spot_label ? `Spot ${booking.assigned_spot_label}` : 'Unassigned')}</b><span>${escapeHtml(employeeLabel(booking.parking_product))} · Start ${escapeHtml(formatDate(booking.arrival_at))}</span><em>Rate ${escapeHtml(parkingRate(booking))} · ${escapeHtml(employeeLabel(booking.payment_status || 'NOT_DUE'))} · Active</em></button>`).join('') || '<p class="muted">No current parking.</p>'}</div></section>
        <section class="panel"><div class="panel-head">Upcoming Parking</div><div class="panel-body">${upcomingParking.map(booking => `<button class="calendar-event clickable-row" data-booking-id="${escapeHtml(booking.id)}"><b>${escapeHtml(booking.assigned_spot_label ? `Reserved spot ${booking.assigned_spot_label}` : 'Upcoming / Reserved · zone capacity')}</b><span>${escapeHtml(employeeLabel(booking.parking_product))} · starts ${escapeHtml(formatDate(booking.arrival_at))}</span><em>Rate ${escapeHtml(parkingRate(booking))} · ${escapeHtml(employeeLabel(booking.payment_status || 'NOT_DUE'))}</em></button>`).join('') || '<p class="muted">No upcoming parking.</p>'}</div></section></div>
      <section class="panel"><div class="panel-head">Vehicles</div><div class="panel-body">${(payload.vehicles || []).map(vehicle => `<div class="customer-record"><b>${escapeHtml(vehicle.license_plate || 'Plate not recorded')}</b><span>${escapeHtml(vehicle.unit_number ? `Unit ${vehicle.unit_number}` : 'Unit not recorded')} · ${escapeHtml(display(vehicle.vehicle_description))}</span><small>${escapeHtml(vehicle.active ? 'Current vehicle' : 'Past vehicle')}</small></div>`).join('') || '<p class="muted">No safely attributable vehicles.</p>'}</div></section>
      <section class="panel"><div class="panel-head green">Record Payment</div><div class="panel-body"><form method="post" id="customerPaymentForm" class="customer-payment-form">${(() => { const open = periods.filter(item => Number(item.balance_cents) > 0).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date))); return open.length ? `<label class="field"><span>Paying for</span><select name="billingPeriodId">${open.map(item => `<option value="${escapeHtml(item.public_id)}" data-balance="${escapeHtml(item.balance_cents)}">${escapeHtml([item.reservation_number, item.parking_product ? employeeLabel(item.parking_product) : 'Monthly', String(item.period_start).slice(0, 7)].filter(Boolean).join(' · '))} · ${escapeHtml(money(Number(item.balance_cents)))} due</option>`).join('')}<option value="">Another month…</option></select></label>` : ''; })()}<label class="field" data-other-period${periods.some(item => Number(item.balance_cents) > 0) ? ' hidden' : ''}><span>Billing month</span><input name="period" type="month" value="${escapeHtml(String(currentPeriod?.period_start || new Date().toISOString()).slice(0, 7))}"></label><label class="field"><span>Amount</span><input name="amount" type="number" min="0.01" step="0.01" required></label><label class="field"><span>Payment date</span><input name="paymentDate" type="date" value="${new Date().toISOString().slice(0, 10)}" required></label><label class="field"><span>Method</span><select name="method"><option>CASH</option><option>CLOVER</option><option>CARD</option><option>CHECK</option><option>OTHER</option></select></label><label class="field"><span>Reference <small>optional</small></span><input name="reference" maxlength="160"></label><label class="field"><span>Note <small>optional</small></span><input name="note" maxlength="1000"></label><div class="customer-confirm"><strong>Creates an auditable non-Stripe ledger entry.</strong><span>It applies only to this customer and selected billing period.</span></div><button class="btn primary">Record Payment</button></form></div></section>
      <section class="panel"><div class="panel-head">Payment History</div><div class="panel-body">${payments.length ? `<div class="table-wrap"><table><thead><tr><th>Date / period</th><th>Amount</th><th>Source / method</th><th>Status</th><th>Reference</th><th>Corrections</th></tr></thead><tbody>${payments.map(payment => `<tr><td>${escapeHtml(formatDate(payment.payment_date))}<br><small>${escapeHtml(payment.period_start ? String(payment.period_start).slice(0, 7) : 'No monthly period')}${payment.payment_date_precision === 'PERIOD_ONLY' ? ' · period only' : ''}</small></td><td><b>${escapeHtml(money(Number(payment.amount_cents)))}</b></td><td>${escapeHtml(employeeLabel(payment.payment_source))}<br><small>${escapeHtml(employeeLabel(payment.payment_method))}${payment.processor_payment_id ? ` · ${escapeHtml(payment.processor_payment_id)}` : ''}</small></td><td>${escapeHtml(employeeLabel(payment.status))}${payment.legacy_confidence ? `<br><small>${escapeHtml(employeeLabel(payment.legacy_confidence))}</small>` : ''}</td><td>${escapeHtml(display(payment.reference))}<br><small>${escapeHtml(display(payment.note))}</small></td><td>${(payment.adjustments || []).map(item => `<div class="ledger-adjustment"><b>${escapeHtml(money(Number(item.amountCents)))}</b><span>${escapeHtml(employeeLabel(item.type))} · ${escapeHtml(item.reason)}</span></div>`).join('') || '<span class="muted">None</span>'}${state.user.role === 'OWNER' && payment.billing_period_public_id ? `<details><summary>Correct</summary><form method="post" class="paymentCorrectionForm" data-payment-id="${escapeHtml(payment.public_id)}"><label>Type<select name="type"><option value="CORRECTION">Correction</option><option value="REVERSAL">Reversal</option></select></label><label>Signed amount in dollars<input name="amount" type="number" step="0.01" required placeholder="-150.00"></label><label>Reason<input name="reason" maxlength="1000" required></label><button class="btn red compact">Post correction</button></form></details>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No payment history has been recorded.</p>'}</div></section>
      <div class="grid-2"><section class="panel"><div class="panel-head">Parking History</div><div class="panel-body">${canonicalParkingHistory}${legacyParkingHistory}${canonicalParkingHistory || legacyParkingHistory ? '' : '<p class="muted">No parking history.</p>'}</div></section>
        ${renderCustomerDocuments(payload)}</div>
      <section class="panel"><div class="panel-head">Notes / Follow-ups</div><div class="panel-body"><form method="post" id="customerNoteForm" class="customer-note-form"><label class="field grow"><span>Internal note</span><textarea name="note" maxlength="4000" required></textarea></label><label class="field"><span>Follow-up date <small>optional</small></span><input name="followUpDate" type="date"></label><button class="btn primary">Add Note</button></form>${notes.map(note => `<div class="customer-note"><div><b>${escapeHtml(note.created_by || 'ParkingOps')}</b><p>${escapeHtml(note.note)}</p><small>${escapeHtml(formatDateTime(note.created_at))}${note.follow_up_date ? ` · Follow up ${escapeHtml(formatDate(note.follow_up_date))}` : ''}${note.resolved_at ? ` · Resolved ${escapeHtml(formatDateTime(note.resolved_at))}` : ''}</small></div>${note.created_by && !note.resolved_at ? `<button class="btn ghost compact" data-resolve-note="${escapeHtml(note.public_id)}">Resolve</button>` : ''}</div>`).join('') || '<p class="muted">No notes or follow-ups.</p>'}</div></section>`;
  }

  function renderCustomers() {
    if (state.privateData.customerDetail) return renderCustomerDetail();
    if (state.customerMode === 'matrix') return renderCustomerMatrix();
    return renderCustomerList();
  }

  function renderCalendar() {
    const payload = state.privateData.calendar;
    if (!payload) return emptyServerPanel('Calendar');
    const events = payload.events || [];
    return `${sectionHeader('Calendar', `Arrivals and departures in ${payload.timezone}.`, '<button class="btn ghost compact" data-refresh-calendar>Refresh</button>')}
      <div class="panel"><div class="panel-head green">Choose Date</div><div class="panel-body"><label class="field"><span>Date</span><input type="date" id="calendarDate" value="${escapeHtml(state.calendarDate)}"></label></div></div>
      <div class="panel"><div class="panel-head">Reservation Timeline · ${escapeHtml(payload.totalEvents || 0)} events</div><div class="panel-body">${events.map(event => `<button class="calendar-event clickable-row" data-booking-id="${escapeHtml(event.bookingId)}"><b>${escapeHtml(event.type)}</b><span>${escapeHtml(event.reservationNumber)} · ${escapeHtml(event.customerName)} · ${escapeHtml(display(event.companyName))} · ${escapeHtml(assignmentPresentation({ assignmentMode: event.assignmentMode, parkingArea: event.parkingArea, assignedSpace: event.assignedSpace }).compact)}</span><em>${escapeHtml(formatDateTime(event.at))} · local day ${escapeHtml(event.localDate)}</em></button>`).join('') || '<p class="muted">No arrivals or departures on this local date.</p>'}<div class="pagination"><button class="btn ghost" data-calendar-previous ${state.privateData.calendarCursorHistory.length ? '' : 'disabled'}>Previous</button><span>Server-grouped in ${escapeHtml(payload.timezone)}</span><button class="btn ghost" data-calendar-next data-next-cursor="${escapeHtml(payload.pagination?.nextCursor || '')}" ${payload.pagination?.hasMore ? '' : 'disabled'}>Next</button></div></div></div>`;
  }

  function renderActivity() {
    const dashboard = state.privateData.dashboard;
    if (!dashboard) return emptyServerPanel('Activity');
    return `${sectionHeader('Activity', 'Reservation changes and parking activity.', '<button class="btn ghost compact" data-refresh>Refresh</button>')}
      <div class="grid-2">
        <div class="panel"><div class="panel-head green">Recent Status History</div><div class="panel-body">${(dashboard.recentActivity || []).map(item => `<div class="calendar-event"><b>${escapeHtml(display(item.reservation_number))}</b><span>${escapeHtml(display(item.new_status))}</span><em>${escapeHtml(formatDateTime(item.created_at))}</em></div>`).join('') || '<p class="muted">No recent history returned.</p>'}</div></div>
        ${reservationSummaryPanel('Attention Required', dashboard.attentionRequired || [], 'arrival_at')}
      </div>`;
  }

  function renderReports() {
    const dashboard = state.privateData.dashboard;
    if (!dashboard) return emptyServerPanel('Reports');
    const summary = dashboard.summary || {};
    return `${sectionHeader('Reports', 'Live operational totals for the backend reporting period.', '<button class="btn primary" data-refresh>Refresh Reports</button>')}
      <div class="grid-4">
        <div class="report-kpi"><span>Confirmed Reservation Value</span><strong>${escapeHtml(money(Number(summary.booked_value || 0)))}</strong><em>${escapeHtml(formatDateTime(dashboard.period?.from))} – ${escapeHtml(formatDateTime(dashboard.period?.to))}</em></div>
        <div class="report-kpi"><span>Monthly Active</span><strong>${escapeHtml(summary.monthly_active ?? 0)}</strong><em>Backend total</em></div>
        <div class="report-kpi"><span>No Shows</span><strong>${escapeHtml(summary.no_shows ?? 0)}</strong><em>Backend total</em></div>
        <div class="report-kpi"><span>Overdue</span><strong>${escapeHtml(summary.overdue ?? 0)}</strong><em>Backend total</em></div>
      </div>
      <div class="panel"><div class="panel-head">Occupancy Detail</div><div class="panel-body">${(dashboard.occupancy || []).length ? `<div class="table-wrap"><table><thead><tr><th>Location</th><th>Area</th><th>Category</th><th>Capacity</th><th>Checked In</th><th>Available</th><th>Closed</th></tr></thead><tbody>${dashboard.occupancy.map(row => `<tr><td>${escapeHtml(display(row.location))}</td><td>${escapeHtml(display(row.zone))}</td><td>${escapeHtml(display(row.category))}</td><td>${escapeHtml(row.capacity ?? 0)}</td><td>${escapeHtml(row.checked_in ?? 0)}</td><td>${escapeHtml(row.available_capacity ?? 0)}</td><td>${row.closed ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No report rows returned.</p>'}</div></div>`;
  }

  function renderAdvancedScreen(view) {
    if (state.user.role !== 'OWNER') return `${sectionHeader('Restricted', 'Management settings are available to Owners only.')}<div class="error">Your account does not have permission for this page.</div>`;
    return `<div id="advancedMount" data-advanced-view="${escapeHtml(view)}"></div>`;
  }

  function renderSettings() {
    return `${sectionHeader('Settings', 'Application connection and session information.')}
      <div class="grid-2">
        <div class="panel"><div class="panel-head green">System Status</div><div class="panel-body"><p><b>Environment:</b> ${escapeHtml(config.environment)}<br><b>API:</b> Connected through the ParkingOps service<br><b>Signed in as:</b> ${escapeHtml(state.user.username)}</p><button class="btn ghost" data-refresh>Refresh Data</button></div></div>
        <div class="panel"><div class="panel-head">Application Links</div><div class="panel-body"><div class="row-actions"><a class="btn primary" href="${escapeHtml(config.customerAppUrl)}" target="_blank" rel="noopener noreferrer">Customer Parking</a>${state.user.role === 'OWNER' ? '<button class="btn ghost" data-nav="Lot Setup">Lot Setup</button>' : ''}<a class="btn ghost" href="${escapeHtml(config.parentSiteUrl)}" target="_blank" rel="noopener noreferrer">Trucker Heaven</a></div></div></div>
        <div class="panel"><div class="panel-head">Data Storage</div><div class="panel-body"><p>Reservations, spaces, prices, and team accounts are stored in the ParkingOps PostgreSQL database. This browser keeps only the signed-in session and the data currently on screen.</p></div></div>
      </div>`;
  }

  function renderMain() {
    return ({
      Overview: renderDashboard,
      'Live Lot': renderLiveLot,
      Summary: renderSummary,
      Reservations: renderReservations,
      'Reservation Desk': () => window.ParkingReservationDesk?.render(state.user) || emptyServerPanel('Reservation Desk'),
      Customers: renderCustomers,
      Calendar: renderCalendar,
      Activity: renderActivity,
      Reports: renderReports,
      Team: () => renderAdvancedScreen('staff-accounts'),
      'Lot Setup': renderLotSetup,
      'Advanced Map Tools': () => renderAdvancedScreen('lot-setup'),
      'Business Settings': () => renderAdvancedScreen('business-settings'),
      Settings: renderSettings
    }[state.screen] || renderDashboard)();
  }

  function mountAdvancedScreen() {
    const mount = document.querySelector('#advancedMount');
    if (!mount || state.user?.role !== 'OWNER') return;
    const root = document.querySelector('#advancedAdminRoot');
    if (!root) return;
    mount.append(root);
    window.ParkingAdvancedAdmin?.activate?.(state.user, mount.dataset.advancedView);
  }

  async function runMutation(button) {
    const detail = state.privateData.bookingDetail?.booking;
    if (!detail || button.disabled) return;
    const reason = document.querySelector('#bookingActionReason')?.value.trim() || '';
    const note = document.querySelector('#bookingActionNote')?.value.trim() || '';
    if (!reason) {
      state.error = 'Enter an operator reason before changing reservation status.';
      render();
      return;
    }
    button.disabled = true;
    state.error = '';
    try {
      await api.transitionBooking(detail.id, button.dataset.bookingAction, {
        version: Number(button.dataset.bookingVersion), reason, note,
        ...(button.dataset.bookingAction === 'check-in' ? { policyAcknowledged: true } : {})
      });
      await loadAuthoritativeData({ quiet: true });
      state.screen = 'Reservations';
      await loadBookingDetail(detail.id);
    } catch (error) {
      if (error?.status !== 401) {
        state.error = error?.message || 'The reservation action failed.';
        render();
      }
    }
  }

  async function recoverCustomerAccount(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const bookingId = state.privateData.bookingDetail?.booking?.id;
    if (!bookingId || state.user?.role !== 'OWNER') return;
    if (!form.elements.verifiedOwnership.checked) {
      state.error = 'Confirm that customer ownership was verified outside this browser session.';
      render();
      return;
    }
    const payload = {
      contactType: form.elements.contactType.value,
      identifier: form.elements.identifier.value.trim(),
      verificationReference: form.elements.verificationReference.value.trim(),
      reason: form.elements.reason.value.trim(),
      verifiedOwnership: true
    };
    state.loading = true; state.error = ''; render();
    try {
      await api.recoverCustomer(form.dataset.customerPublicId, payload);
      await loadBookingDetail(bookingId);
    } catch (error) {
      if (error?.status !== 401) state.error = error?.message || 'Customer account recovery failed.';
    } finally { state.loading = false; render(); }
  }

  async function refreshOperations(bookingId = null) {
    const liveLot = await api.liveLot();
    await loadUnplaced();
    state.privateData.liveLot = liveLot;
    state.lastUpdatedAt = new Date();
    if (bookingId) state.privateData.bookingDetail = await api.booking(bookingId);
    if (state.privateData.selectedSpaceId) state.privateData.spaceDetail = await api.spaceDetail(state.privateData.selectedSpaceId);
  }

  async function runSpaceAction(action, reason = '') {
    const id = state.privateData.selectedSpaceId;
    if (!id) return;
    state.loading = true; state.error = ''; render();
    try {
      if (action === 'block') await api.blockSpace(id, { reason });
      else await api.unblockSpace(id);
      await refreshOperations();
    } catch (error) {
      if (error?.status !== 401) state.error = error?.message || `Space ${action} failed.`;
    } finally { state.loading = false; render(); }
  }

  async function loadAlternatives() {
    const booking = state.privateData.bookingDetail?.booking;
    if (!booking) return;
    state.loading = true; state.error = ''; render();
    try { state.privateData.bookingAlternatives = await api.spotAlternatives(booking.id); }
    catch (error) { if (error?.status !== 401) state.error = error?.message || 'Alternatives could not be loaded.'; }
    finally { state.loading = false; render(); }
  }

  async function reassignBooking(spotId, reason) {
    const booking = state.privateData.bookingDetail?.booking;
    if (!booking) return;
    state.loading = true; state.error = ''; render();
    try {
      await api.reassignSpot(booking.id, { spotId: Number(spotId), reason, version: Number(booking.version) });
      state.privateData.bookingAlternatives = null;
      await refreshOperations(booking.id);
    } catch (error) { if (error?.status !== 401) state.error = error?.message || 'Reassignment failed. Refresh and try again.'; }
    finally { state.loading = false; render(); }
  }

  // Daily / Weekly drivers book the area, not a space. When one arrives, staff put them on the
  // space they took, right from that space's drawer.
  function renderPlaceDriver(space, vehicle) {
    const wanted = vehicle === 'BOBTAIL' ? 'BOBTAIL' : 'TRACTOR_TRAILER';
    const drivers = (state.privateData.unplaced || []).filter(item => item.category_code === wanted);
    if (!drivers.length) return '';
    const option = item => `<option value="${escapeHtml(item.id)}" data-version="${escapeHtml(item.version)}">${escapeHtml(`${item.customer_name || 'Driver'} · ${employeeLabel(item.parking_product)} · ${item.license_plate || item.tractor_unit_number || item.reservation_number} · ${formatDateTime(item.arrival_at)}`)}</option>`;
    return `<form id="placeDriverForm" class="place-driver-form" data-spot-id="${escapeHtml(space.id)}" data-spot-number="${escapeHtml(space.number)}">
      <label>Place an arriving driver here<select name="bookingId" required><option value="">Choose a Daily / Weekly driver…</option>${drivers.map(option).join('')}</select></label>
      <button class="btn secondary full" type="submit">Place on Space ${escapeHtml(space.number)}</button>
      ${state.placeError ? `<p class="error-text">${escapeHtml(state.placeError)}</p>` : ''}
    </form>`;
  }
  async function loadUnplaced() {
    try { state.privateData.unplaced = (await api.unplacedBookings()).bookings || []; } catch (_) { /* optional list */ }
  }
  async function placeDriver(form) {
    const select = form.querySelector('select[name=bookingId]'); const bookingId = select.value; if (!bookingId) return;
    const version = Number(select.selectedOptions[0]?.dataset.version);
    form.querySelector('button[type=submit]').disabled = true; state.placeError = '';
    try {
      await api.placeBooking(bookingId, { spotId: Number(form.dataset.spotId), version });
      await loadUnplaced(); await refreshOperations();
    } catch (error) { state.placeError = error?.message || 'The driver could not be placed on this space.'; }
    render();
  }

  // Inline edit of the customer's contact and truck details, right in the Live Lot drawer.
  function renderLiveLotEdit(currentReservation) {
    const edit = state.liveLotEdit;
    if (!edit || edit.bookingId !== String(currentReservation.id)) return '';
    if (!edit.booking) return '<p class="muted">Loading details…</p>';
    const b = edit.booking;
    const field = (name, label, value, extra = '') => `<label>${label}<input name="${name}" value="${escapeHtml(value ?? '')}" ${extra}></label>`;
    return `<form id="liveLotEditForm" class="live-lot-edit-form" data-edit-booking="${escapeHtml(b.id)}" data-version="${escapeHtml(b.version)}">
      <div class="form-grid two">${field('first_name', 'First name', b.first_name, 'required maxlength="80"')}${field('last_name', 'Last name', b.last_name, 'required maxlength="80"')}${field('mobile_phone', 'Phone', b.mobile_phone, 'required')}${field('email', 'Email', b.email, 'type="email" required')}${field('company_name', 'Company / Carrier', b.company_name, 'maxlength="120"')}${field('tractor_unit_number', 'Unit #', b.tractor_unit_number, 'required maxlength="80"')}${field('license_plate', 'Plate', b.license_plate, 'required maxlength="30"')}${field('license_plate_state', 'Plate state', b.license_plate_state, 'required maxlength="40"')}${field('trailer_number', 'Trailer #', b.trailer_number, 'maxlength="80"')}</div>
      <label>Staff note<textarea name="operational_notes" rows="2" maxlength="4000">${escapeHtml(b.operational_notes || '')}</textarea></label>
      <div class="row-actions"><button class="btn primary compact" type="submit">Save Details</button><button class="btn ghost compact" type="button" data-live-lot-edit="${escapeHtml(b.id)}">Cancel</button></div>
      ${edit.error ? `<p class="error-text">${escapeHtml(edit.error)}</p>` : ''}
    </form>`;
  }
  async function toggleLiveLotEdit(bookingId) {
    if (state.liveLotEdit?.bookingId === String(bookingId)) { state.liveLotEdit = null; render(); return; }
    state.liveLotEdit = { bookingId: String(bookingId), booking: null, error: '' }; render();
    try { const detail = await api.booking(bookingId); state.liveLotEdit = { bookingId: String(bookingId), booking: detail.booking, error: '' }; }
    catch (error) { state.liveLotEdit = null; state.error = error?.message || 'The reservation could not be loaded.'; }
    render();
  }
  async function saveLiveLotEdit(form) {
    const bookingId = form.dataset.editBooking; const body = { version: Number(form.dataset.version) };
    for (const [key, value] of new FormData(form)) { const text = String(value).trim(); if (key === 'company_name' && !text) body[key] = ''; else body[key] = text; }
    const button = form.querySelector('button[type="submit"]'); button.disabled = true;
    try {
      await api.updateBooking(bookingId, body);
      state.liveLotEdit = null;
      await refreshOperations();
    } catch (error) {
      if (state.liveLotEdit) state.liveLotEdit.error = error?.message || 'The details could not be saved.';
      render();
    }
  }
  // Check in, no-show or cancel straight from the drawer. Cancel and no-show ask for a short reason (the server requires one).
  async function liveLotTransition(bookingId, action) {
    const prompts = { 'check-in': null, 'no-show': 'Reason for marking this reservation a no-show:', cancel: 'Reason for cancelling this reservation:' };
    let reason = action === 'check-in' ? 'Checked in from Live Lot' : '';
    if (prompts[action]) { reason = String(window.prompt(prompts[action], '') || '').trim(); if (!reason) return; }
    state.loading = true; state.error = ''; render();
    try {
      const detail = await api.booking(bookingId);
      const version = Number(detail?.booking?.version);
      if (!Number.isSafeInteger(version)) throw new Error('The parking record is no longer current. Refresh and try again.');
      await api.transitionBooking(bookingId, action, { version, reason, ...(action === 'check-in' ? { policyAcknowledged: true } : {}) });
      await refreshOperations();
    } catch (error) { state.error = error?.message || 'The reservation action failed.'; }
    finally { state.loading = false; render(); }
  }

  async function beginLiveLotMove(bookingId) {
    state.loading = true; state.error = ''; render();
    try {
      const [alternatives, bookingDetail] = await Promise.all([api.spotAlternatives(bookingId), api.booking(bookingId)]);
      const version = Number(bookingDetail?.booking?.version);
      if (!Number.isSafeInteger(version)) throw new Error('The parking record is no longer current. Refresh and try again.');
      const detail = state.privateData.spaceDetail;
      state.liveLotMove = { bookingId, version, sourceId: state.privateData.selectedSpaceId,
        customerName: detail?.currentCustomer?.name || detail?.currentCustomer?.company || 'this customer', alternatives: alternatives.alternatives || [] };
    } catch (error) { state.error = error?.message || 'Compatible spaces could not be loaded.'; }
    finally { state.loading = false; render(); }
  }

  async function endLiveLotParking(bookingId) {
    if (!window.confirm('End this active parking and release its current space?')) return;
    state.loading = true; state.error = ''; render();
    try {
      const detail = await api.booking(bookingId);
      const version = Number(detail?.booking?.version);
      if (!Number.isSafeInteger(version)) throw new Error('The parking record is no longer current. Refresh and try again.');
      await api.transitionBooking(bookingId, 'check-out', { version, reason: 'Ended from Live Lot' });
      await refreshOperations();
    } catch (error) { state.error = error?.message || 'Parking could not be ended.'; }
    finally { state.loading = false; render(); }
  }

  async function openCustomerParkingOnLiveLot(bookingId, spaceId, lotNumber, move = false) {
    if (!spaceId) return;
    state.screen = 'Live Lot';
    state.lotSearch = String(lotNumber || '');
    state.lotFilters = { bookingTerm: '', vehicleType: '', operationalStatus: '', accessType: '' };
    await loadSpaceDetail(spaceId);
    if (move) await beginLiveLotMove(bookingId);
  }

  async function endCustomerParking(bookingId) {
    await endLiveLotParking(bookingId);
    if (state.privateData.selectedCustomerId) await loadCustomerDetail(state.privateData.selectedCustomerId);
  }

  async function saveBookingNote(note) {
    const booking = state.privateData.bookingDetail?.booking;
    if (!booking) return;
    state.loading = true; state.error = ''; render();
    try {
      await api.addBookingNote(booking.id, { note, visibility: 'INTERNAL' });
      state.privateData.bookingDetail = await api.booking(booking.id);
    } catch (error) { if (error?.status !== 401) state.error = error?.message || 'Note could not be saved.'; }
    finally { state.loading = false; render(); }
  }

  async function openPrivateDocument(id, disposition, button, customerId = '') {
    if (!id || button.disabled) return;
    const targetWindow = window.open('about:blank', '_blank');
    if (targetWindow) targetWindow.opener = null;
    button.disabled = true; const previous = button.textContent;
    button.textContent = disposition === 'ATTACHMENT' ? 'Preparing download…' : 'Preparing secure view…';
    try {
      const response = customerId
        ? await api.customerDocumentAccess(customerId, id, disposition)
        : await api.documentAccess(id, disposition);
      if (!response.access?.path) throw new Error('Protected document access was not returned.');
      const url = api.protectedDocumentUrl(response.access.path);
      if (targetWindow) targetWindow.location.replace(url); else window.open(url, '_blank', 'noopener,noreferrer');
      button.textContent = disposition === 'ATTACHMENT' ? 'Download opened' : 'Secure view opened';
    } catch (error) {
      targetWindow?.close();
      state.error = error?.message || 'Private document access failed.'; render();
    } finally { if (document.contains(button)) { button.disabled = false; button.textContent = previous; } }
  }

  async function reviewCustomerDocument(id, type, status, customerId = '') {
    const label = documentTypeLabel(type);
    const promptText = status === 'APPROVED' ? `Optional ${label} review note:`
      : status === 'REJECTED' ? `Why is this ${label} rejected?`
        : `Why is a replacement ${label} needed?`;
    const note = window.prompt(promptText);
    if (note === null || (['REJECTED','REPLACEMENT_REQUESTED'].includes(status) && !note.trim())) return;
    const policyExpiresAt = status === 'APPROVED' && type === 'INSURANCE' ? window.prompt('Policy expiration (YYYY-MM-DD), if available:', '') : '';
    if (policyExpiresAt === null) return;
    state.loading = true; state.error = ''; render();
    try {
      const body = { status, note: note.trim(), policyExpiresAt: policyExpiresAt.trim() || null };
      if (customerId) {
        await api.reviewCustomerDocument(customerId, id, body);
        state.privateData.customerDetail = await api.customer(customerId);
      } else {
        await api.reviewDocument(id, body);
        const bookingId = state.privateData.selectedBookingId;
        if (bookingId) state.privateData.bookingDetail = await api.booking(bookingId);
      }
    } catch (error) { if (error?.status !== 401) state.error = error?.message || 'Document review failed.'; }
    finally { state.loading = false; render(); }
  }

  async function saveSpaceConfiguration(form) {
    const id = state.privateData.selectedSpaceId;
    if (!id || !form) return;
    const values = new FormData(form);
    const access = String(values.get('access') || 'INTERNAL');
    const payload = {
      spaceNumber: values.get('spaceNumber'), vehicleType: values.get('vehicleType'), access,
      bookingTerm: access === 'CUSTOMER' ? (values.get('bookingTerm') || (Number(values.get('spaceNumber'))>=110&&Number(values.get('spaceNumber'))<=148?'DAILY':'MONTHLY')) : undefined,
      controlState: values.get('controlState'), internalNotes: values.get('internalNotes'), changeReason: values.get('changeReason'),
      ...(values.get('layoutVersion') ? { layoutVersion: Number(values.get('layoutVersion')) } : {}),
      ...(values.get('elementVersion') ? { elementVersion: Number(values.get('elementVersion')) } : {})
    };
    state.loading = true; state.error = ''; render();
    try {
      const result = await api.editSpace(id,payload);
      state.publishReview = result.review;
      await refreshOperations();
      await loadSpaceDetail(id);
    } catch (error) {
      if (error?.status !== 401) state.error = error?.message || 'Space changes could not be saved.';
    } finally { state.loading = false; render(); }
  }

  async function reviewPendingChanges(layoutId) {
    if (!layoutId) return;
    state.loading = true; state.error = ''; render();
    try { state.publishReview = await api.reviewLayout(layoutId); state.publishReviewOpen = true; }
    catch (error) { if (error?.status !== 401) state.error = error?.message || 'Pending changes could not be reviewed.'; }
    finally { state.loading = false; render(); }
  }

  async function publishPendingChanges(button) {
    const layoutId = button?.dataset.layoutId;
    const layoutVersion = Number(button?.dataset.layoutVersion);
    if (!layoutId || !layoutVersion || button.disabled) return;
    button.disabled = true;
    try {
      await api.publishLayout(layoutId,{ version: layoutVersion });
      state.publishReview = null; state.publishReviewOpen = false; state.privateData.selectedSpaceId = ''; state.privateData.spaceDetail = null;
      await loadAuthoritativeData({ quiet: true });
    } catch (error) {
      if (error?.status !== 401) state.error = error?.message || 'The parking-lot changes could not be published.';
      render();
    }
  }

  function bulkChanges(action) {
    const [kind,value] = String(action||'').split(':');
    if (kind === 'term') return { bookingTerm:value, access:'CUSTOMER' };
    if (kind === 'vehicle') return { vehicleType:value };
    if (kind === 'access') return { access:value };
    if (kind === 'control') return { controlState:value };
    return null;
  }

  async function previewBulkChanges() {
    const changes = bulkChanges(document.querySelector('#bulkAction')?.value);
    if (!changes) { state.error='Choose a bulk change to preview.'; return render(); }
    state.loading=true; state.error=''; render();
    try {
      const request={ spaceIds:[...state.selectedSpaceIds].map(Number),changes };
      state.bulkPreview={ ...(await api.previewBulkSpaces(request)),request };
    } catch(error) { if(error?.status!==401) state.error=error?.message||'The bulk change could not be previewed.'; }
    finally { state.loading=false; render(); }
  }

  async function applyBulkChanges() {
    const request=state.bulkPreview?.request; if(!request) return;
    state.loading=true; state.error=''; state.bulkPreview=null; render();
    try {
      const result=await api.editBulkSpaces(request); state.publishReview=result.review;
      state.selectedSpaceIds.clear(); state.bulkMode=false; await refreshOperations();
    } catch(error) { if(error?.status!==401) state.error=error?.message||'The bulk change could not be applied.'; }
    finally { state.loading=false; render(); }
  }

  function dollarsToCents(value, label) {
    const text = String(value || '').trim();
    if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`${label} must be a dollar amount with no more than two decimals.`);
    const sign = text.startsWith('-') ? -1 : 1;
    const [whole, fraction = ''] = text.replace('-', '').split('.');
    return sign * (Number(whole) * 100 + Number(fraction.padEnd(2, '0')));
  }

  async function recordCustomerPayment(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const amountCents = dollarsToCents(form.amount.value, 'Payment amount');
      if (amountCents <= 0) throw new Error('Payment amount must be positive.');
      const periodId = form.billingPeriodId?.value || '';
      const periodLabel = periodId ? form.billingPeriodId.selectedOptions[0].textContent.replace(/ · [^·]* due$/, '') : form.period.value;
      if (!periodId && !form.period.value) throw new Error('Choose the month this payment is for.');
      const summary = `${money(amountCents)} by ${form.method.value} on ${formatDate(form.paymentDate.value)} for ${periodLabel}`;
      if (!window.confirm(`Record ${summary} for ${state.privateData.customerDetail.customer.displayName}? This creates an auditable non-Stripe ledger entry.`)) return;
      state.loading = true; state.error = ''; render();
      await api.recordCustomerPayment(state.privateData.selectedCustomerId, {
        ...(periodId ? { billingPeriodId: periodId } : { period: form.period.value }), amountCents, paymentDate: form.paymentDate.value,
        method: form.method.value, reference: form.reference.value.trim(), note: form.note.value.trim()
      });
      state.privateData.customers = null;
      await loadCustomerDetail(state.privateData.selectedCustomerId);
    } catch (error) { state.loading = false; state.error = error.message || 'Payment could not be recorded.'; render(); }
  }

  async function correctCustomerPayment(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const amountCents = dollarsToCents(form.amount.value, 'Correction amount');
      if (!amountCents) throw new Error('Correction amount cannot be zero.');
      if (!window.confirm(`Post a ${form.type.value.toLowerCase()} of ${money(amountCents)}? The original payment remains visible.`)) return;
      state.loading = true; state.error = ''; render();
      await api.correctCustomerPayment(form.dataset.paymentId, {
        amountCents, type: form.type.value, reason: form.reason.value.trim()
      });
      await loadCustomerDetail(state.privateData.selectedCustomerId);
    } catch (error) { state.loading = false; state.error = error.message || 'Payment correction could not be posted.'; render(); }
  }

  async function addCustomerNote(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      state.loading = true; state.error = ''; render();
      await api.addCustomerNote(state.privateData.selectedCustomerId, {
        note: form.note.value.trim(), followUpDate: form.followUpDate.value || null
      });
      await loadCustomerDetail(state.privateData.selectedCustomerId);
    } catch (error) { state.loading = false; state.error = error.message || 'Customer note could not be added.'; render(); }
  }

  async function resolveCustomerNote(noteId) {
    try {
      state.loading = true; state.error = ''; render();
      await api.resolveCustomerNote(noteId);
      await loadCustomerDetail(state.privateData.selectedCustomerId);
    } catch (error) { state.loading = false; state.error = error.message || 'Customer note could not be resolved.'; render(); }
  }

  async function updateCustomerStatus(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      if (!window.confirm(`Change this customer to ${form.status.value}? Financial and parking history will remain available.`)) return;
      state.loading = true; state.error = ''; render();
      await api.updateCustomerStatus(state.privateData.selectedCustomerId, {
        status: form.status.value, reason: form.reason.value.trim()
      });
      state.privateData.customers = null;
      await loadCustomerDetail(state.privateData.selectedCustomerId);
    } catch (error) { state.loading = false; state.error = error.message || 'Customer status could not be updated.'; render(); }
  }

  function bindEvents() {
    if (state.screen === 'Reservation Desk') window.ParkingReservationDesk?.bind(state.user);
    document.querySelector('[data-overdue-customers]')?.addEventListener('click', () => {
      state.screen = 'Customers'; state.customerMode = 'list'; state.customerSearch = '';
      state.customerFilters = { status: '', payment: 'OVERDUE', parking: '', reservationType: '', documents: '' };
      state.customerFocusPayment = 'OVERDUE'; state.privateData.customerDetail = null; state.privateData.selectedCustomerId = '';
      state.privateData.customerCursor = ''; state.privateData.customerCursorHistory = []; state.privateData.customers = null;
      loadCustomers();
    });
    document.querySelectorAll('[data-nav]').forEach(element => element.addEventListener('click', () => {
      const dirtyForm = document.querySelector('#spaceConfigurationForm[data-dirty="true"]');
      if (dirtyForm && !window.confirm('Discard unsaved space changes?')) return;
      state.screen = element.dataset.nav;
      if (state.screen === 'Customers') {
        state.customerMode = 'list';
        state.privateData.customerDetail = null;
        state.privateData.selectedCustomerId = '';
      }
      if (state.screen !== 'Lot Setup') {
        state.bulkMode = false;
        state.selectedSpaceIds.clear();
      }
      state.error = '';
      if (state.screen === 'Customers' && !state.privateData.customers) loadCustomers();
      else if (state.screen === 'Summary' && !state.privateData.summary) loadSummary();
      else if (state.screen === 'Calendar' && !state.privateData.calendar) loadCalendar();
      else render();
    }));
    document.querySelectorAll('button[data-advanced-view]').forEach(element => element.addEventListener('click', () => {
      state.advancedView = element.dataset.advancedView;
      state.screen = state.advancedView === 'business-settings' ? 'Business Settings' : 'Advanced Map Tools';
      render();
    }));
    document.querySelectorAll('[data-refresh]').forEach(element => element.addEventListener('click', () => loadAuthoritativeData()));
    document.querySelector('[data-logout]')?.addEventListener('click', async () => {
      try { await api.logout(); } catch (_) { /* Local private state is cleared even if the network logout fails. */ }
      api.clearSession();
      clearPrivateState();
      state.sessionMessage = 'You have signed out.';
      state.error = '';
      render();
    });
    document.querySelector('#reservationSearch')?.addEventListener('submit', event => {
      event.preventDefault();
      state.search = document.querySelector('#reservationQuery').value.trim();
      state.status = document.querySelector('#reservationStatus').value;
      state.privateData.bookingCursor = '';
      state.privateData.bookingCursorHistory = [];
      loadBookingsFromServer();
    });
    document.querySelector('[data-clear-search]')?.addEventListener('click', () => {
      state.search = '';
      state.status = '';
      state.privateData.bookingCursor = '';
      state.privateData.bookingCursorHistory = [];
      loadBookingsFromServer();
    });
    document.querySelectorAll('[data-booking-id]:not([data-booking-action])').forEach(element => element.addEventListener('click', event => {
      event.stopPropagation();
      state.screen = 'Reservations';
      loadBookingDetail(element.dataset.bookingId);
    }));
    document.querySelectorAll('[data-desk-space-id]').forEach(element => element.addEventListener('click', () => {
      openDeskForSpace({ id: element.dataset.deskSpaceId, number: element.dataset.deskSpaceNumber,
        bookingTerm: element.dataset.deskSpaceTerm, vehicleType: element.dataset.deskSpaceVehicle });
    }));
    document.querySelectorAll('[data-open-desk-reservation]').forEach(element => element.addEventListener('click', () => {
      openDeskReservation(element.dataset.openDeskReservation);
    }));
    document.querySelectorAll('[data-live-lot-move]').forEach(element => element.addEventListener('click', () => beginLiveLotMove(element.dataset.liveLotMove)));
    document.querySelectorAll('[data-live-lot-end]').forEach(element => element.addEventListener('click', () => endLiveLotParking(element.dataset.liveLotEnd)));
    document.querySelectorAll('[data-live-lot-checkin]').forEach(element => element.addEventListener('click', () => liveLotTransition(element.dataset.liveLotCheckin, 'check-in')));
    document.querySelectorAll('[data-live-lot-noshow]').forEach(element => element.addEventListener('click', () => liveLotTransition(element.dataset.liveLotNoshow, 'no-show')));
    document.querySelectorAll('[data-live-lot-cancel]').forEach(element => element.addEventListener('click', () => liveLotTransition(element.dataset.liveLotCancel, 'cancel')));
    document.querySelectorAll('[data-live-lot-edit]').forEach(element => element.addEventListener('click', () => toggleLiveLotEdit(element.dataset.liveLotEdit)));
    document.querySelector('#liveLotEditForm')?.addEventListener('submit', event => { event.preventDefault(); saveLiveLotEdit(event.currentTarget); });
    document.querySelector('#placeDriverForm')?.addEventListener('submit', event => { event.preventDefault(); placeDriver(event.currentTarget); });
    document.querySelector('[data-cancel-live-lot-move]')?.addEventListener('click', () => { state.liveLotMove = null; render(); });
    document.querySelectorAll('[data-open-space-id]').forEach(element => element.addEventListener('click', event => {
      event.stopPropagation();
      const id = String(element.dataset.openSpaceId);
      state.screen = 'Live Lot';
      state.lotSearch = String(element.dataset.lotNumber || '');
      state.lotFilters = { bookingTerm: '', vehicleType: '', operationalStatus: '', accessType: '' };
      loadSpaceDetail(id).then(()=>requestAnimationFrame(()=>document.querySelector(`.operational-map-space[data-space-id="${CSS.escape(id)}"]`)?.focus({preventScroll:true})));
    }));
    document.querySelectorAll('[data-space-id]').forEach(element => element.addEventListener('click', event => {
      const id=String(element.dataset.spaceId);
      if (state.liveLotMove) {
        const destination = state.liveLotMove.alternatives.find(item => String(item.id) === id);
        if (!destination) { state.error = 'Choose one of the compatible available destination spaces.'; render(); return; }
        if (!window.confirm(`Move ${state.liveLotMove.customerName} from the current space to Space ${destination.public_label}?`)) return;
        const move = state.liveLotMove; state.liveLotMove = null; state.loading = true; render();
        api.reassignSpot(move.bookingId, { spotId: Number(destination.id), reason: 'Moved from Live Lot', version: Number(move.version) })
          .then(() => { state.privateData.selectedSpaceId = id; return refreshOperations(); })
          .catch(error => { state.error = error?.message || 'Move could not be completed. Refresh and try again.'; })
          .finally(() => { state.loading = false; render(); });
        return;
      }
      if(state.bulkMode && state.screen === 'Lot Setup'){ if(state.selectedSpaceIds.has(id)) state.selectedSpaceIds.delete(id); else state.selectedSpaceIds.add(id); render(); return; }
      loadSpaceDetail(id).then(()=>requestAnimationFrame(()=>document.querySelector(`.operational-map-space[data-space-id="${CSS.escape(id)}"]`)?.focus({preventScroll:true})));
    }));
    document.querySelectorAll('[data-booking-action]').forEach(element => element.addEventListener('click', () => runMutation(element)));
    document.querySelector('#customerRecoveryForm')?.addEventListener('submit', recoverCustomerAccount);
    document.querySelectorAll('[data-document-access]').forEach(element => element.addEventListener('click', () => openPrivateDocument(element.dataset.documentAccess, element.dataset.documentDisposition, element, element.dataset.documentCustomer)));
    document.querySelectorAll('[data-document-review]').forEach(element => element.addEventListener('click', () => reviewCustomerDocument(element.dataset.documentReview, element.dataset.documentType, element.dataset.reviewStatus, element.dataset.documentCustomer)));
    document.querySelector('#calendarDate')?.addEventListener('change', event => {
      state.calendarDate = event.target.value;
      state.privateData.calendarCursor = '';
      state.privateData.calendarCursorHistory = [];
      loadCalendar();
    });
    document.querySelector('[data-refresh-customers]')?.addEventListener('click', loadCustomers);
    document.querySelector('[data-refresh-summary]')?.addEventListener('click', loadSummary);
    document.querySelector('[data-refresh-calendar]')?.addEventListener('click', loadCalendar);
    document.querySelector('#customerSearch')?.addEventListener('submit', event => {
      event.preventDefault(); state.customerSearch = document.querySelector('#customerQuery').value.trim();
      state.privateData.customerCursor = ''; state.privateData.customerCursorHistory = []; loadCustomers();
    });
    document.querySelectorAll('[data-clear-customer-search]').forEach(button => button.addEventListener('click', () => {
      state.customerSearch = ''; state.customerFilters = { status: '', payment: '', parking: '', reservationType: '', documents: '' };
      state.customerFocusPayment = '';
      state.privateData.customerCursor = ''; state.privateData.customerCursorHistory = []; loadCustomers();
    }));
    document.querySelectorAll('[data-customer-filter]').forEach(button => button.addEventListener('click', () => {
      const name = button.dataset.customerFilter;
      const value = button.dataset.customerFilterValue;
      state.customerFilters[name] = state.customerFilters[name] === value && value ? '' : value;
      state.privateData.customerCursor = ''; state.privateData.customerCursorHistory = []; loadCustomers();
    }));
    document.querySelectorAll('[data-customer-id]').forEach(element => element.addEventListener('click', event => {
      event.stopPropagation();
      state.screen = 'Customers'; loadCustomerDetail(element.dataset.customerId, element.dataset.customerFocus || '');
    }));
    document.querySelector('[data-customer-matrix]')?.addEventListener('click', () => {
      state.customerMode = 'matrix'; state.privateData.customerDetail = null;
      if (!state.privateData.customerMatrix) loadCustomerMatrix(); else render();
    });
    document.querySelectorAll('[data-customer-list]').forEach(element => element.addEventListener('click', () => {
      state.customerMode = 'list'; state.privateData.customerDetail = null; state.privateData.selectedCustomerId = '';
      if (!state.privateData.customers) loadCustomers(); else render();
    }));
    document.querySelector('[data-refresh-matrix]')?.addEventListener('click', loadCustomerMatrix);
    document.querySelector('#customerMatrixYear')?.addEventListener('change', event => {
      state.customerMatrixYear = Number(event.target.value); state.privateData.customerMatrix = null; loadCustomerMatrix();
    });
    document.querySelectorAll('[data-payment-filter]').forEach(element => element.addEventListener('click', () => {
      state.customerFilters.payment = element.dataset.paymentFilter; state.privateData.customerCursor = '';
      state.customerFocusPayment = element.dataset.paymentFilter === 'OVERDUE' ? 'OVERDUE' : '';
      state.privateData.customerCursorHistory = []; loadCustomers();
    }));
    document.querySelector('[data-customer-payment]')?.addEventListener('click', () => {
      document.querySelector('#customerPayments')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.querySelectorAll('[data-customer-move]').forEach(button => button.addEventListener('click', () => {
      openCustomerParkingOnLiveLot(button.dataset.customerMove, button.dataset.customerSpaceId, button.dataset.lotNumber, true);
    }));
    document.querySelectorAll('[data-customer-end]').forEach(button => button.addEventListener('click', () => endCustomerParking(button.dataset.customerEnd)));
    document.querySelector('#customerPaymentForm')?.addEventListener('submit', recordCustomerPayment);
    const paymentForm = document.querySelector('#customerPaymentForm');
    const syncPaymentTarget = () => {
      const select = paymentForm?.billingPeriodId; if (!select) return;
      const option = select.selectedOptions[0];
      paymentForm.querySelector('[data-other-period]').hidden = Boolean(select.value);
      if (select.value && option?.dataset.balance) paymentForm.amount.value = (Number(option.dataset.balance) / 100).toFixed(2);
    };
    paymentForm?.billingPeriodId?.addEventListener('change', syncPaymentTarget);
    syncPaymentTarget();
    document.querySelectorAll('.paymentCorrectionForm').forEach(form => form.addEventListener('submit', correctCustomerPayment));
    document.querySelector('#customerNoteForm')?.addEventListener('submit', addCustomerNote);
    document.querySelectorAll('[data-resolve-note]').forEach(button => button.addEventListener('click', () => resolveCustomerNote(button.dataset.resolveNote)));
    document.querySelector('#customerStatusForm')?.addEventListener('submit', updateCustomerStatus);
    document.querySelector('[data-bookings-next]')?.addEventListener('click', event => {
      const cursor = event.currentTarget.dataset.nextCursor; if (!cursor) return;
      state.privateData.bookingCursorHistory.push(state.privateData.bookingCursor); state.privateData.bookingCursor = cursor; loadBookingsFromServer();
    });
    document.querySelector('[data-bookings-previous]')?.addEventListener('click', () => {
      state.privateData.bookingCursor = state.privateData.bookingCursorHistory.pop() || ''; loadBookingsFromServer();
    });
    document.querySelector('[data-customers-next]')?.addEventListener('click', event => {
      const cursor = event.currentTarget.dataset.nextCursor; if (!cursor) return;
      state.privateData.customerCursorHistory.push(state.privateData.customerCursor); state.privateData.customerCursor = cursor; loadCustomers();
    });
    document.querySelector('[data-customers-previous]')?.addEventListener('click', () => {
      state.privateData.customerCursor = state.privateData.customerCursorHistory.pop() || ''; loadCustomers();
    });
    document.querySelector('[data-calendar-next]')?.addEventListener('click', event => {
      const cursor = event.currentTarget.dataset.nextCursor; if (!cursor) return;
      state.privateData.calendarCursorHistory.push(state.privateData.calendarCursor); state.privateData.calendarCursor = cursor; loadCalendar();
    });
    document.querySelector('[data-calendar-previous]')?.addEventListener('click', () => {
      state.privateData.calendarCursor = state.privateData.calendarCursorHistory.pop() || ''; loadCalendar();
    });
    document.querySelector('#blockSpaceForm')?.addEventListener('submit', event => {
      event.preventDefault(); runSpaceAction('block', document.querySelector('#blockSpaceReason').value.trim());
    });
    document.querySelector('[data-unblock-space]')?.addEventListener('click', () => runSpaceAction('unblock'));
    document.querySelector('[data-close-space]')?.addEventListener('click',()=>{state.privateData.selectedSpaceId='';state.privateData.spaceDetail=null;render();});
    document.querySelector('[data-cancel-space]')?.addEventListener('click',()=>loadSpaceDetail(state.privateData.selectedSpaceId));
    document.querySelector('#spaceConfigurationForm')?.addEventListener('submit',event=>{event.preventDefault();saveSpaceConfiguration(event.currentTarget);});
    document.querySelector('#spaceConfigurationForm')?.addEventListener('input',event=>{event.currentTarget.dataset.dirty='true';});
    document.querySelector('#spaceConfigurationForm [name="access"]')?.addEventListener('change',event=>{const term=event.currentTarget.form.elements.bookingTerm; if(term) term.disabled=event.currentTarget.value!=='CUSTOMER';});
    document.querySelector('#spaceSearchForm')?.addEventListener('submit',event=>{event.preventDefault();state.lotSearch=document.querySelector('#spaceSearch').value.trim();render();const exact=(state.privateData.liveLot?.spaces||[]).find(space=>String(space.number)===state.lotSearch);if(exact&&!(state.bulkMode&&state.screen==='Lot Setup'))loadSpaceDetail(exact.id);});
    document.querySelectorAll('[data-lot-filter]').forEach(button=>button.addEventListener('click',()=>{const key=button.dataset.lotFilter;const value=button.dataset.lotFilterValue;state.lotFilters[key]=state.lotFilters[key]===value?'':value;render();}));
    document.querySelectorAll('[data-clear-lot-filters]').forEach(button=>button.addEventListener('click',()=>{state.lotSearch='';state.lotFilters={bookingTerm:'',vehicleType:'',operationalStatus:'',accessType:''};render();}));
    document.querySelector('[data-toggle-bulk]')?.addEventListener('click',()=>{state.bulkMode=!state.bulkMode;if(!state.bulkMode)state.selectedSpaceIds.clear();render();});
    document.querySelector('[data-select-daily-range]')?.addEventListener('click',()=>{(state.privateData.liveLot?.spaces||[]).filter(space=>Number(space.number)>=110&&Number(space.number)<=148).forEach(space=>state.selectedSpaceIds.add(String(space.id)));render();});
    document.querySelectorAll('[data-select-term]').forEach(button=>button.addEventListener('click',()=>{(state.privateData.liveLot?.spaces||[]).filter(space=>space.bookingTerm===button.dataset.selectTerm).forEach(space=>state.selectedSpaceIds.add(String(space.id)));render();}));
    document.querySelector('[data-select-visible]')?.addEventListener('click',()=>{(state.privateData.liveLot?.spaces||[]).filter(lotMatches).forEach(space=>state.selectedSpaceIds.add(String(space.id)));render();});
    document.querySelector('[data-clear-selection]')?.addEventListener('click',()=>{state.selectedSpaceIds.clear();render();});
    document.querySelector('[data-preview-bulk]')?.addEventListener('click',previewBulkChanges);
    document.querySelectorAll('[data-close-bulk-preview]').forEach(button=>button.addEventListener('click',()=>{state.bulkPreview=null;render();}));
    document.querySelector('[data-apply-bulk]')?.addEventListener('click',applyBulkChanges);
    document.querySelector('[data-review-pending]')?.addEventListener('click',event=>reviewPendingChanges(event.currentTarget.dataset.layoutId));
    document.querySelectorAll('[data-close-publish-review]').forEach(button=>button.addEventListener('click',()=>{state.publishReviewOpen=false;render();}));
    document.querySelector('[data-publish-layout]')?.addEventListener('click',event=>publishPendingChanges(event.currentTarget));
    document.querySelector('[data-load-alternatives]')?.addEventListener('click', loadAlternatives);
    document.querySelector('#reassignmentForm')?.addEventListener('submit', event => {
      event.preventDefault(); reassignBooking(document.querySelector('#replacementSpot').value, document.querySelector('#reassignmentReason').value.trim());
    });
    document.querySelector('#bookingNoteForm')?.addEventListener('submit', event => {
      event.preventDefault(); saveBookingNote(document.querySelector('#standaloneBookingNote').value.trim());
    });
  }

  async function bootstrap() {
    api?.configureUnauthorized(handleUnauthorized);
    if (!api || !config?.valid) {
      render();
      return;
    }
    try {
      const session = await api.session();
      state.user = session.user;
      await loadAuthoritativeData({ quiet: true });
    } catch (error) {
      if (error?.status && error.status !== 401) state.sessionMessage = error.message;
      render();
    }
  }

  function render() {
    if (!state.user) renderLogin();
    else renderShell();
  }

  document.addEventListener('parkingdesk:render', () => {
    if (state.user && state.screen === 'Reservation Desk') render();
  });

  bootstrap();
})();
