(function lifecycleModule(root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./customer-core.js') : root.ParkingCustomerCore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ParkingLifecycle = api;
})(typeof window !== 'undefined' ? window : globalThis, function createLifecycle(core) {
  'use strict';

  const LEGACY_RECENT_STORAGE_KEY = 'thParking.recentReservations.v1';
  const SESSION_STORAGE_KEY = 'thParking.sessionReservations.v2';
  const REMEMBERED_STORAGE_KEY = 'thParking.rememberedReservations.v2';
  const ACTIVE_RESERVATION_KEY = 'thParking.activeReservation.v2';
  const ROUTES = Object.freeze(['parking', 'offers', 'review', 'confirmation', 'pass', 'map', 'reservations', 'lookup', 'my-parking', 'upload-documents', 'demo-payment']);
  const MAX_RECENT = 5;
  const ACTIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
  const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const TERMINAL = new Set(['CHECKED_OUT', 'COMPLETED', 'CANCELLED', 'REJECTED', 'EXPIRED']);

  function normalizeRoute(hash) {
    const route = String(hash || '').replace(/^#/, '').split(/[?&]/, 1)[0].toLowerCase();
    return ROUTES.includes(route) ? route : 'parking';
  }
  function maskedContact(value) {
    const contact = String(value || '').trim();
    if (!contact) return '';
    if (contact.includes('@')) { const [name, domain] = contact.split('@'); return `${name.slice(0, 1) || '*'}***@${domain || '***'}`; }
    const digits = contact.replace(/\D/g, '');
    return digits.length >= 4 ? `••• ••• ${digits.slice(-4)}` : 'Saved contact';
  }
  function validInstant(value) {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
  }
  function cleanEntry(value, now = Date.now(), source = value?.source || 'session') {
    if (!value || typeof value !== 'object') return null;
    const reservationNumber = core.normalizeReservationNumber(value.reservationNumber);
    const lookupCredential = String(value.lookupCredential || '');
    if (!reservationNumber || !lookupCredential) return null;
    const updatedAt = validInstant(value.updatedAt) || new Date(now).toISOString();
    const departure = validInstant(value.departure);
    const updatedMs = new Date(updatedAt).getTime();
    const status = core.normalizeStatus(value.status);
    const terminalBoundary = Math.max(updatedMs, departure ? new Date(departure).getTime() : 0);
    if (TERMINAL.has(status) && terminalBoundary < now - TERMINAL_RETENTION_MS) return null;
    if (!TERMINAL.has(status) && updatedMs < now - ACTIVE_RETENTION_MS) return null;
    return {
      reservationNumber, lookupCredential,
      maskedContact: String(value.maskedContact || ''),
      arrival: validInstant(value.arrival), departure,
      timezone: String(value.timezone || ''),
      parkingType: core.publicParkingLabel(value.parkingType),
      assignmentMode: value.assignmentMode === 'EXACT_SPOT' || (!value.assignmentMode && value.assignedSpace) ? 'EXACT_SPOT' : 'ZONE_CAPACITY',
      parkingArea: core.publicParkingLabel(value.parkingArea) || core.publicParkingLabel(value.parkingType),
      parkingPeriod: core.supportedDuration(value.parkingPeriod),
      status,
      assignedSpace: String(value.assignedSpace || ''),
      updatedAt,
      remembered: source === 'remembered' || value.remembered === true,
      source: source === 'remembered' || value.remembered === true ? 'remembered' : 'session'
    };
  }
  function sanitizeRecent(values, now = Date.now(), source) {
    if (!Array.isArray(values)) return [];
    const byNumber = new Map();
    for (const raw of values) {
      const entry = cleanEntry(raw, now, source || raw?.source);
      if (!entry) continue;
      const existing = byNumber.get(entry.reservationNumber);
      if (!existing || new Date(entry.updatedAt) > new Date(existing.updatedAt)) byNumber.set(entry.reservationNumber, entry);
    }
    return [...byNumber.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, MAX_RECENT);
  }
  function mergeStores(sessionEntries, rememberedEntries, now = Date.now()) {
    const remembered = sanitizeRecent(rememberedEntries, now, 'remembered'); const rememberedNumbers = new Set(remembered.map(item => item.reservationNumber));
    const session = sanitizeRecent(sessionEntries, now, 'session').filter(item => !rememberedNumbers.has(item.reservationNumber));
    return sanitizeRecent([...remembered, ...session], now);
  }
  function entryFromBooking(booking, lookupCredential, contact = '', now = Date.now(), source = 'session') {
    return cleanEntry({
      reservationNumber: booking?.reservationNumber, lookupCredential,
      maskedContact: contact.includes?.('***') || contact.includes?.('•••') ? contact : maskedContact(contact),
      arrival: booking?.arrival, departure: booking?.departure, timezone: booking?.timezone,
      parkingType: booking?.category, parkingPeriod: booking?.price?.duration,
      assignmentMode: booking?.assignmentMode, parkingArea: booking?.parkingArea?.name,
      status: booking?.status, assignedSpace: booking?.assignedSpotLabel,
      updatedAt: new Date(now).toISOString(), remembered: source === 'remembered', source
    }, now, source);
  }
  function upsertRecent(values, next, now = Date.now(), source = next?.source) {
    const current = sanitizeRecent(values, now, source);
    const number = core.normalizeReservationNumber(next?.reservationNumber);
    const existing = current.find(item => item.reservationNumber === number);
    const sameCredential = next?.lookupCredential || existing?.lookupCredential || '';
    const merged = cleanEntry({ ...existing, ...next, lookupCredential: sameCredential }, now, source || next?.source || existing?.source);
    return sanitizeRecent(merged ? [merged, ...current.filter(item => item.reservationNumber !== merged.reservationNumber)] : current, now, source);
  }
  function removeRecent(values, reservationNumber, now = Date.now()) {
    const target = core.normalizeReservationNumber(reservationNumber);
    return sanitizeRecent(values, now).filter(item => item.reservationNumber !== target);
  }
  function shouldPollAssignment(booking) { return core.reservationStatusView(booking).pollAssignment; }

  function createAssignmentPoller({
    fetchBooking, isActive = () => true, matchesIdentity = () => true,
    onBooking = () => {}, onCheck = () => {}, onError = () => {}, onStop = () => {},
    intervalMs = 5000, maxDurationMs = 60000, now = () => Date.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay), clearTimer = timer => clearTimeout(timer)
  }) {
    let timer = null; let startedAt = null; let running = false; let checking = false; let generation = 0; let controller = null;
    function valid(run) { return running && run === generation && isActive() && matchesIdentity(); }
    function stop(reason = 'stopped') {
      const wasActive = running || checking || timer !== null;
      generation += 1; running = false; checking = false;
      if (timer !== null) clearTimer(timer); timer = null;
      controller?.abort(); controller = null;
      if (wasActive) onStop(reason);
    }
    function schedule(run) {
      if (!valid(run)) return running ? stop('inactive') : undefined;
      const remaining = maxDurationMs - (now() - startedAt);
      if (remaining <= 0) return stop('timeout');
      timer = setTimer(() => tick(run), Math.min(intervalMs, remaining));
    }
    async function tick(run = generation) {
      timer = null;
      if (!valid(run)) return running ? stop('inactive') : undefined;
      if (checking) return;
      if (now() - startedAt >= maxDurationMs) return stop('timeout');
      checking = true; controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      try {
        const booking = await fetchBooking(controller?.signal);
        if (!valid(run)) { if (running) stop('inactive'); return; }
        onCheck(now());
        if (!valid(run)) { if (running) stop('inactive'); return; }
        onBooking(booking);
        if (!valid(run)) { if (running) stop('inactive'); return; }
        if (!shouldPollAssignment(booking)) return stop(booking?.assignedSpotLabel ? 'assigned' : 'terminal');
      } catch (error) {
        if (!valid(run)) { if (running) stop('inactive'); return; }
        onCheck(now());
        if (error?.name !== 'AbortError' && valid(run)) onError(error);
      } finally {
        if (run === generation) { checking = false; controller = null; }
      }
      if (valid(run)) schedule(run);
    }
    function start() {
      if (running) return false;
      generation += 1; const run = generation; running = true; checking = false; startedAt = now(); schedule(run); return true;
    }
    return { start, stop, checkNow: () => tick(generation), isRunning: () => running, startedAt: () => startedAt };
  }

  return {
    LEGACY_RECENT_STORAGE_KEY, SESSION_STORAGE_KEY, REMEMBERED_STORAGE_KEY, ACTIVE_RESERVATION_KEY,
    ROUTES, MAX_RECENT, normalizeRoute, maskedContact, cleanEntry, sanitizeRecent, mergeStores,
    entryFromBooking, upsertRecent, removeRecent, shouldPollAssignment, createAssignmentPoller,
    activeRecentEntry: core.activeRecentEntry
  };
});
