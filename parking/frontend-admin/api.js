(() => {
  'use strict';

  const config = window.PARKING_ADMIN_CONFIG;
  let csrfToken = '';
  let unauthorizedHandler = null;
  let unauthorizedNotified = false;
  const pendingMutations = new Set();

  class ParkingApiError extends Error {
    constructor(message, { code = 'REQUEST_FAILED', status = 0, details = null } = {}) {
      super(message);
      this.name = 'ParkingApiError';
      this.code = code;
      this.status = status;
      this.details = details;
    }
  }

  async function request(path, options = {}) {
    if (!config?.valid) throw new ParkingApiError(config?.error || 'ParkingOps is not configured.', { code: 'CONFIGURATION_ERROR' });
    const method = String(options.method || 'GET').toUpperCase();
    const mutation = !['GET', 'HEAD'].includes(method);
    const headers = { Accept: 'application/json', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(mutation && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...(options.headers || {}) };
    let response;
    let timedOut = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, Number(options.timeoutMs || 20000));
    const externalSignal = options.signal;
    const abortFromCaller = () => controller.abort();
    externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
    try {
      response = await fetch(`${config.apiBase}${path}`, { credentials: 'include', ...options, method, headers, signal: controller.signal });
    } catch (error) {
      if (error?.name === 'AbortError' && timedOut) throw new ParkingApiError('The ParkingOps API request timed out. Try again.', { code: 'REQUEST_TIMEOUT' });
      if (error?.name === 'AbortError') throw error;
      throw new ParkingApiError('The ParkingOps API could not be reached. Check the network connection and try again.', { code: 'NETWORK_ERROR' });
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortFromCaller);
    }
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); }
      catch (_) { payload = { error: { message: text.slice(0, 300) } }; }
    }
    if (!response.ok) {
      const apiError = payload?.error || {};
      const error = new ParkingApiError(apiError.message || `Request failed with status ${response.status}.`, {
        code: apiError.code || 'REQUEST_FAILED', status: response.status, details: apiError.details || null
      });
      if (response.status === 401 && options.sessionRequest !== true && !unauthorizedNotified) {
        unauthorizedNotified = true;
        unauthorizedHandler?.(error);
      }
      throw error;
    }
    if (options.sessionRequest === true) unauthorizedNotified = false;
    return payload;
  }

  async function ensureCsrf() {
    if (!csrfToken) csrfToken = (await request('/admin/auth/csrf')).csrfToken;
    return csrfToken;
  }

  async function mutate(key, path, options = {}) {
    if (pendingMutations.has(key)) throw new ParkingApiError('This operation is already in progress.', { code: 'DUPLICATE_OPERATION' });
    pendingMutations.add(key);
    try {
      await ensureCsrf();
      return await request(path, { ...options, method: options.method || 'POST' });
    } finally {
      pendingMutations.delete(key);
    }
  }

  const encodeQuery = params => {
    const query = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') query.set(key, value); });
    return query.size ? `?${query}` : '';
  };

  window.ParkingAdminApi = Object.freeze({
    ParkingApiError,
    configureUnauthorized(handler) { unauthorizedHandler = typeof handler === 'function' ? handler : null; },
    clearSession() { csrfToken = ''; },
    session() { return request('/admin/auth/session', { sessionRequest: true }); },
    async login(username, password) {
      const result = await request('/admin/auth/login', { method: 'POST', body: JSON.stringify({ username, password }), sessionRequest: true });
      csrfToken = result.csrfToken || '';
      unauthorizedNotified = false;
      return result;
    },
    async logout() { try { return await mutate('logout', '/admin/auth/logout'); } finally { csrfToken = ''; } },
    dashboard(params) { return request(`/admin/parking/v1/dashboard${encodeQuery(params)}`); },
    summary() { return request('/admin/parking/v1/summary'); },
    liveLot() { return request('/admin/parking/v1/canonical-live-lot/snapshot'); },
    reservationDeskBootstrap() { return request('/admin/parking/v1/reservation-desk/bootstrap'); },
    reservationDeskCustomers(query) { return request(`/admin/parking/v1/reservation-desk/customers${encodeQuery({ q: query })}`); },
    createReservationDeskCustomer(body) { return mutate('reservation-desk-customer', '/admin/parking/v1/reservation-desk/customers', { body: JSON.stringify(body) }); },
    reservationDeskAvailability(body) { return mutate('reservation-desk-availability', '/admin/parking/v1/reservation-desk/availability', { body: JSON.stringify(body) }); },
    createDeskReservation(body, idempotencyKey) { return mutate('reservation-desk-create', '/admin/parking/v1/reservation-desk/reservations', {
      body: JSON.stringify(body), headers: { 'Idempotency-Key': idempotencyKey }
    }); },
    deskReservation(id) { return request(`/admin/parking/v1/reservation-desk/reservations/${encodeURIComponent(id)}`); },
    overrideDeskReservationPrice(id, body) { return mutate(`reservation-desk-price-${id}`, `/admin/parking/v1/reservation-desk/reservations/${encodeURIComponent(id)}/price-override`, { body: JSON.stringify(body) }); },
    updateDeskReservation(id, body) { return mutate(`reservation-desk-update-${id}`, `/admin/parking/v1/reservation-desk/reservations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }); },
    endDeskMonthlyReservation(id, body) { return mutate(`reservation-desk-end-monthly-${id}`, `/admin/parking/v1/reservation-desk/reservations/${encodeURIComponent(id)}/end-monthly`, { body: JSON.stringify(body) }); },
    startDeskInsuranceUpload(id, body) { return mutate(`reservation-desk-document-${id}`, `/admin/parking/v1/reservation-desk/reservations/${encodeURIComponent(id)}/documents/insurance/upload`, { body: JSON.stringify(body) }); },
    completeDeskInsuranceUpload(id, body) { return mutate(`reservation-desk-document-complete-${id}`, `/admin/parking/v1/reservation-desk/reservations/${encodeURIComponent(id)}/documents/complete`, { body: JSON.stringify(body) }); },
    createDeskPaymentLink(id) { return mutate(`reservation-desk-payment-${id}`, `/admin/parking/v1/reservation-desk/reservations/${encodeURIComponent(id)}/payment-link`, { body: '{}' }); },
    createDemoPaymentAuthorization(id) { return mutate(`reservation-desk-demo-${id}`, `/admin/parking/v1/reservation-desk/reservations/${encodeURIComponent(id)}/demo-payment-authorization`, { body: '{}' }); },
    revokeUnusedDemoPaymentAuthorizations() { return mutate('reservation-desk-demo-revoke', '/admin/parking/v1/reservation-desk/demo-payment-authorizations/revoke-unused', { body: '{}' }); },
    sendDeskReservationNotice(id, kind) { return mutate(`reservation-desk-notice-${id}`, `/admin/parking/v1/reservation-desk/reservations/${encodeURIComponent(id)}/notification`, { body: JSON.stringify({ kind }) }); },
    bookings(params) { return request(`/admin/parking/v1/bookings${encodeQuery(params)}`); },
    customers(params) { return request(`/admin/parking/v1/customers${encodeQuery(params)}`); },
    documents(params) { return request(`/admin/parking/v1/documents${encodeQuery(params)}`); },
    customer(publicId) { return request(`/admin/parking/v1/customers/${encodeURIComponent(publicId)}`); },
    customerMatrix(year) { return request(`/admin/parking/v1/customers/payment-matrix${encodeQuery({ year })}`); },
    customerExportUrl() { return `${config.apiBase}/admin/parking/v1/customers/export.csv`; },
    recordCustomerPayment(publicId, body) { return mutate(`customer-payment-${publicId}`, `/admin/parking/v1/customers/${encodeURIComponent(publicId)}/payments`, { body: JSON.stringify(body) }); },
    correctCustomerPayment(paymentId, body) { return mutate(`customer-payment-correction-${paymentId}`, `/admin/parking/v1/payments/${encodeURIComponent(paymentId)}/corrections`, { body: JSON.stringify(body) }); },
    addCustomerNote(publicId, body) { return mutate(`customer-note-${publicId}`, `/admin/parking/v1/customers/${encodeURIComponent(publicId)}/notes`, { body: JSON.stringify(body) }); },
    resolveCustomerNote(noteId) { return mutate(`customer-note-resolve-${noteId}`, `/admin/parking/v1/customer-notes/${encodeURIComponent(noteId)}/resolve`, { method: 'PATCH', body: '{}' }); },
    updateCustomerStatus(publicId, body) { return mutate(`customer-status-${publicId}`, `/admin/parking/v1/customers/${encodeURIComponent(publicId)}/status`, { method: 'PATCH', body: JSON.stringify(body) }); },
    calendar(params) { return request(`/admin/parking/v1/calendar${encodeQuery(params)}`); },
    booking(id) { return request(`/admin/parking/v1/bookings/${encodeURIComponent(id)}`); },
    unplacedBookings() { return request('/admin/parking/v1/unplaced-bookings'); },
    placeBooking(id, body) { return mutate(`booking-place-${id}`, `/admin/parking/v1/bookings/${encodeURIComponent(id)}/place`, { body: JSON.stringify(body) }); },
    updateBooking(id, body) { return mutate(`booking-update-${id}`, `/admin/parking/v1/bookings/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }); },
    recoverCustomer(publicId, body) { return mutate(`customer-recovery-${publicId}`, `/admin/parking/v1/customer-accounts/${encodeURIComponent(publicId)}/recovery`, { method: 'PATCH', body: JSON.stringify(body) }); },
    spaceDetail(id) { return request(`/admin/parking/v1/spaces/${encodeURIComponent(id)}/operational-detail`); },
    editSpace(id, body) { return mutate(`space-config-${id}`, `/admin/parking/v1/spaces/${encodeURIComponent(id)}/configuration`, { method: 'PATCH', body: JSON.stringify(body) }); },
    previewBulkSpaces(body) { return mutate('space-bulk-preview', '/admin/parking/v1/spaces/bulk-preview', { body: JSON.stringify(body) }); },
    editBulkSpaces(body) { return mutate('space-bulk-edit', '/admin/parking/v1/spaces/bulk-configuration', { method: 'PATCH', body: JSON.stringify(body) }); },
    reviewLayout(id) { return request(`/admin/parking/v1/layouts/${encodeURIComponent(id)}/review`); },
    publishLayout(id, body) { return mutate(`layout-publish-${id}`, `/admin/parking/v1/layouts/${encodeURIComponent(id)}/publish`, { body: JSON.stringify(body) }); },
    rollbackLayout(locationId, body) { return mutate(`layout-rollback-${locationId}`, `/admin/parking/v1/locations/${encodeURIComponent(locationId)}/rollback-layout`, { body: JSON.stringify(body) }); },
    transitionBooking(id, action, body) { return mutate(`booking-${id}`, `/admin/parking/v1/bookings/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, { body: JSON.stringify(body) }); },
    spotAlternatives(id) { return request(`/admin/parking/v1/bookings/${encodeURIComponent(id)}/spot-alternatives`); },
    reassignSpot(id, body) { return mutate(`booking-${id}`, `/admin/parking/v1/bookings/${encodeURIComponent(id)}/reassign-spot`, { body: JSON.stringify(body) }); },
    addBookingNote(id, body) { return mutate(`booking-note-${id}`, `/admin/parking/v1/bookings/${encodeURIComponent(id)}/notes`, { body: JSON.stringify(body) }); },
    documentAccess(id, disposition) { return mutate(`document-access-${id}-${disposition}`, `/admin/parking/v1/documents/${encodeURIComponent(id)}/access`, { body: JSON.stringify({ disposition }) }); },
    customerDocumentAccess(customerId, id, disposition) { return mutate(`customer-document-access-${customerId}-${id}-${disposition}`, `/admin/parking/v1/customers/${encodeURIComponent(customerId)}/documents/${encodeURIComponent(id)}/access`, { body: JSON.stringify({ disposition }) }); },
    protectedDocumentUrl(path) {
      const url = new URL(String(path || ''), config.apiBase);
      const api = new URL(config.apiBase);
      if (url.origin !== api.origin || !url.pathname.startsWith('/api/admin/parking/v1/documents/')) {
        throw new ParkingApiError('The protected document response was invalid.', { code: 'DOCUMENT_ACCESS_INVALID' });
      }
      return url.href;
    },
    reviewDocument(id, body) { return mutate(`document-review-${id}`, `/admin/parking/v1/documents/${encodeURIComponent(id)}/review`, { method: 'PATCH', body: JSON.stringify(body) }); },
    reviewCustomerDocument(customerId, id, body) { return mutate(`customer-document-review-${customerId}-${id}`, `/admin/parking/v1/customers/${encodeURIComponent(customerId)}/documents/${encodeURIComponent(id)}/review`, { method: 'PATCH', body: JSON.stringify(body) }); },
    blockSpace(id, body) { return mutate(`space-${id}`, `/admin/parking/v1/spots/${encodeURIComponent(id)}/block`, { body: JSON.stringify(body) }); },
    unblockSpace(id) { return mutate(`space-${id}`, `/admin/parking/v1/spots/${encodeURIComponent(id)}/unblock`, { body: '{}' }); },
    advanced(path, options = {}) {
      const method = String(options.method || 'GET').toUpperCase();
      if (['GET', 'HEAD'].includes(method)) return request(path, options);
      return mutate(`advanced:${method}:${path}`, path, options);
    },
    isMutationPending(key) { return pendingMutations.has(key); }
  });
})();
