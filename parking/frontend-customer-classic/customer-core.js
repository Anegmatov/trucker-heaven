(function customerCoreModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ParkingCustomerCore = api;
})(typeof window !== 'undefined' ? window : globalThis, function createCustomerCore() {
  'use strict';

  const CATEGORY_METADATA = Object.freeze({
    BOBTAIL: Object.freeze({ code: 'BOBTAIL', label: 'Bobtail Parking', marker: 'B', description: 'Power unit without a trailer.' }),
    TRACTOR_TRAILER: Object.freeze({ code: 'TRACTOR_TRAILER', label: 'General Truck Parking', marker: 'G', description: 'Tractor-trailer combination or full-size truck.' })
  });
  const PUBLIC_CATEGORY_CODES = Object.freeze(Object.keys(CATEGORY_METADATA));
  const SUPPORTED_CUSTOMER_DURATIONS = Object.freeze(['DAILY', 'WEEKLY', 'MONTHLY']);
  const SEARCH_STATUS = Object.freeze({ IDLE: 'IDLE', LOADING: 'LOADING', SUCCESS_RESULTS: 'SUCCESS_RESULTS', SUCCESS_EMPTY: 'SUCCESS_EMPTY', ERROR: 'ERROR' });
  const QUOTE_STATUS = Object.freeze({ IDLE: 'IDLE', LOADING: 'LOADING', SUCCESS: 'SUCCESS', UNAVAILABLE: 'UNAVAILABLE', ERROR: 'ERROR' });
  const SUBMISSION_STATUS = Object.freeze({ IDLE: 'IDLE', SUBMITTING: 'SUBMITTING', SUCCESS: 'SUCCESS', ERROR: 'ERROR' });
  const ACTIVE_STATUSES = new Set(['PENDING', 'CONFIRMED', 'CHECKED_IN']);
  const TERMINAL_STATUSES = new Set(['CHECKED_OUT', 'COMPLETED', 'CANCELLED', 'REJECTED', 'EXPIRED']);

  function normalizeReservationNumber(value) { return String(value || '').trim().toUpperCase(); }
  function categoryMetadata(code) { return CATEGORY_METADATA[String(code || '').trim().toUpperCase()] || null; }
  function publicParkingLabel(value) {
    const normalized = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (normalized === 'BOBTAIL' || normalized === 'BOBTAIL_PARKING') return CATEGORY_METADATA.BOBTAIL.label;
    if (['TRACTOR_TRAILER', 'TRACTOR_TRAILER_PARKING', 'TRUCK_TRAILER', 'TRUCK_AND_TRAILER', 'GENERAL_TRUCK', 'GENERAL_TRUCK_PARKING', 'GENERAL'].includes(normalized)) return CATEGORY_METADATA.TRACTOR_TRAILER.label;
    return '';
  }
  function filterPublicCategories(categories) {
    if (!Array.isArray(categories)) return [];
    const seen = new Set();
    return categories.filter(item => {
      const code = String(item?.code || '').toUpperCase();
      if (!categoryMetadata(code) || seen.has(code)) return false;
      seen.add(code); return true;
    }).map(item => {
      const offeredDurations = filterSupportedDurations(item.offeredDurations);
      return { ...item, code: String(item.code).toUpperCase(), name: categoryMetadata(item.code).label,
        offeredDurations, startingRateCents: offeredDurations.length ? Math.min(...offeredDurations.map(offer => offer.unitRateCents)) : null,
        pricingAvailable: offeredDurations.length > 0 };
    });
  }

  function supportedDuration(value) {
    const duration = String(value || '').trim().toUpperCase();
    return SUPPORTED_CUSTOMER_DURATIONS.includes(duration) ? duration : null;
  }
  function filterSupportedDurations(values) {
    if (!Array.isArray(values)) return [];
    const seen = new Set();
    return values.filter(item => {
      const duration = supportedDuration(item?.code);
      if (!duration || seen.has(duration) || safeCents(item?.unitRateCents) === null) return false;
      seen.add(duration); return true;
    }).map(item => ({ code: supportedDuration(item.code), unitRateCents: item.unitRateCents }));
  }

  function normalizeLocal(value) {
    const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}` : '';
  }
  function tripFingerprint(trip) {
    const code = categoryMetadata(trip?.categoryCode)?.code || '';
    const arrival = normalizeLocal(trip?.arrivalLocal);
    const departure = normalizeLocal(trip?.departureLocal);
    const duration = supportedDuration(trip?.duration);
    if (duration === 'MONTHLY') return code && arrival ? `${code}|${duration}|${arrival}|OPEN_ENDED` : '';
    return code && arrival && departure && duration ? `${code}|${duration}|${arrival}|${departure}` : '';
  }
  function localParts(value) {
    const normalized = normalizeLocal(value);
    if (!normalized) return null;
    const [date, time] = normalized.split('T');
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
    return { year, month, day, hour, minute };
  }
  function calendarDayDifference(arrivalLocal, departureLocal) {
    const arrival = localParts(arrivalLocal); const departure = localParts(departureLocal);
    if (!arrival || !departure) return NaN;
    return (Date.UTC(departure.year, departure.month - 1, departure.day) - Date.UTC(arrival.year, arrival.month - 1, arrival.day)) / 86400000;
  }
  function localElapsedDays(arrivalLocal, departureLocal) {
    const arrival = localParts(arrivalLocal); const departure = localParts(departureLocal);
    if (!arrival || !departure) return NaN;
    const arrivalStamp = Date.UTC(arrival.year, arrival.month - 1, arrival.day, arrival.hour, arrival.minute);
    const departureStamp = Date.UTC(departure.year, departure.month - 1, departure.day, departure.hour, departure.minute);
    return (departureStamp - arrivalStamp) / 86400000;
  }
  function productIntervalError(duration, arrivalLocal, departureLocal, minimumMonthlyDays = 28, minimumWeeklyDays = 7) {
    if (duration === 'MONTHLY') return normalizeLocal(arrivalLocal) ? '' : 'Enter a valid start date and time.';
    const selected = supportedDuration(duration);
    const days = localElapsedDays(arrivalLocal, departureLocal);
    if (!selected) return 'Choose Daily, Weekly, or Monthly parking.';
    if (!Number.isFinite(days) || days <= 0) return 'Enter a departure after the arrival time.';
    if (selected === 'MONTHLY' && days < minimumMonthlyDays) return `Monthly parking requires a minimum ${minimumMonthlyDays}-day stay.`;
    if (selected === 'WEEKLY' && days < minimumWeeklyDays) return `Weekly parking requires a minimum ${minimumWeeklyDays}-day stay.`;
    return '';
  }
  function addLocalCalendarDays(localValue, days) {
    const parts = localParts(localValue); if (!parts) return '';
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + Number(days || 0), parts.hour, parts.minute));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}T${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  }
  function zonedInputValue(value, timeZone) {
    const date = value instanceof Date ? value : new Date(value);
    if (!timeZone || Number.isNaN(date.getTime())) return '';
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
  }
  function naturalDateText(parts) {
    const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    const zone = values.timeZoneName ? ` ${values.timeZoneName}` : '';
    return `${values.month} ${values.day}, ${values.year} at ${values.hour}:${values.minute} ${values.dayPeriod}${zone}`.replace(/\s+/g, ' ').trim();
  }
  function humanTime(value, timeZone) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Time unavailable';
    try {
      return naturalDateText(new Intl.DateTimeFormat('en-US', {
        ...(timeZone ? { timeZone } : {}), month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
      }).formatToParts(date));
    } catch (_) { return 'Time unavailable'; }
  }
  function humanLocalTime(value, timeZone) {
    const parts = localParts(value); if (!parts) return 'Time unavailable';
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
    const text = naturalDateText(new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
    }).formatToParts(date));
    return timeZone ? `${text} (${timeZone})` : text;
  }

  function safeCents(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
    return value;
  }
  function money(value) {
    const cents = safeCents(value);
    return cents === null ? 'Unavailable' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
  }
  function nonnegativeNumber(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }

  function validateCanonicalLot(response) {
    const lot = response?.lot;
    if (!lot || typeof lot !== 'object' || typeof lot.timezone !== 'string' || !lot.timezone || !Array.isArray(lot.categories)) return null;
    try { new Intl.DateTimeFormat('en-US', { timeZone: lot.timezone }).format(); } catch (_) { return null; }
    const minimumMonthlyDays = Number(lot.bookingPolicy?.minimumMonthlyDays);
    const minimumWeeklyDays = Number(lot.bookingPolicy?.minimumWeeklyDays);
    return { ...lot,
      bookingPolicy: {
        minimumWeeklyDays: Number.isSafeInteger(minimumWeeklyDays) && minimumWeeklyDays > 0 ? minimumWeeklyDays : 7,
        minimumMonthlyDays: Number.isSafeInteger(minimumMonthlyDays) && minimumMonthlyDays > 0 ? minimumMonthlyDays : 28
      },
      categories: filterPublicCategories(lot.categories) };
  }
  function validateAvailabilityResults(response, expectedCode, expectedDuration = null) {
    if (!Array.isArray(response?.results)) return null;
    const expected = categoryMetadata(expectedCode)?.code;
    return response.results.filter(result => categoryMetadata(result?.categoryCode) && (!expected || result.categoryCode === expected)).map(result => {
      const offeredDurations = filterSupportedDurations(result.offeredDurations);
      const requested = supportedDuration(expectedDuration);
      return {
      ...result, offeredDurations,
      categoryCode: String(result.categoryCode).toUpperCase(),
      category: categoryMetadata(result.categoryCode).label,
      available: result.available === true,
      pricingAvailable: result.pricingAvailable === true && offeredDurations.some(item => !requested || item.code === requested),
      numberedSpacesAvailable: nonnegativeNumber(result.numberedSpacesAvailable),
      remainingCapacity: nonnegativeNumber(result.remainingCapacity)
    }; });
  }
  function validateQuote(response, trip, selected) {
    const quote = response?.quote;
    if (!quote || safeCents(quote.totalCents) === null || !response.arrival) return null;
    const duration = supportedDuration(quote.duration);
    if (!duration || (trip?.duration && duration !== supportedDuration(trip.duration))) return null;
    if (duration !== 'MONTHLY' && !response.departure) return null;
    if (response.categoryCode && response.categoryCode !== trip?.categoryCode) return null;
    if (selected?.categoryCode && response.categoryCode && selected.categoryCode !== response.categoryCode) return null;
    if (selected?.parkingAreaId && response.parkingAreaId && selected.parkingAreaId !== response.parkingAreaId) return null;
    if (selected?.assignmentMode && response.assignmentMode && selected.assignmentMode !== response.assignmentMode) return null;
    if (duration === 'MONTHLY') {
      const expectedSpot = Number(selected?.selectedSpotId);
      const quotedSpot = Number(response.selectedMonthlyPosition?.id);
      if (!Number.isSafeInteger(expectedSpot) || expectedSpot <= 0 || quotedSpot !== expectedSpot) return null;
    }
    if (response.arrivalLocal && normalizeLocal(response.arrivalLocal) !== normalizeLocal(trip?.arrivalLocal)) return null;
    if (duration !== 'MONTHLY' && response.departureLocal && normalizeLocal(response.departureLocal) !== normalizeLocal(trip?.departureLocal)) return null;
    return response;
  }
  function validateBooking(booking) {
    if (!booking || typeof booking !== 'object' || !normalizeReservationNumber(booking.reservationNumber)) return null;
    const price = booking.price && typeof booking.price === 'object' ? { ...booking.price, duration: supportedDuration(booking.price.duration) } : booking.price;
    const suppliedMode = String(booking.assignmentMode || '').toUpperCase();
    const assignmentMode = ['ZONE_CAPACITY','CUSTOMER_SELECTED_SPOT','EXACT_SPOT'].includes(suppliedMode)
      ? suppliedMode
      : booking.assignedSpotLabel ? 'EXACT_SPOT' : 'ZONE_CAPACITY';
    const parkingArea = booking.parkingArea && typeof booking.parkingArea === 'object'
      ? { id: booking.parkingArea.id || null, name: publicParkingLabel(booking.parkingArea.name) || publicParkingLabel(booking.category) || 'Parking Area', instructions: String(booking.parkingArea.instructions || '') }
      : { id: null, name: publicParkingLabel(booking.category) || 'Parking Area', instructions: '' };
    return { ...booking, assignmentMode, parkingArea, price, reservationNumber: normalizeReservationNumber(booking.reservationNumber), status: normalizeStatus(booking.status), category: publicParkingLabel(booking.category) || 'Parking type unavailable' };
  }

  function offerKey(result, fingerprint = '') {
    if (!result || !categoryMetadata(result.categoryCode)) return '';
    return [result.offerId || '', result.parkingAreaId || '', result.categoryCode, result.assignmentMode || '', result.ratePlanId || result.ratePlan || '', result.duration || result.pricingBasis || '', stableStringify(result.offeredDurations || []), fingerprint].join('|');
  }
  function quoteExpired(quoteState, now = Date.now()) {
    const value = quoteState?.data?.expiresAt;
    return Boolean(value && Number.isFinite(new Date(value).getTime()) && new Date(value).getTime() <= now);
  }
  function bookingCanContinue(model, now = Date.now()) {
    const fingerprint = tripFingerprint(model?.trip);
    const selected = model?.selected;
    const quote = model?.quote;
    const monthly = supportedDuration(model?.trip?.duration) === 'MONTHLY';
    const selectedSpotMatches = !monthly || (Number.isSafeInteger(Number(model?.selectedMonthlySpot?.id))
      && Number(model.selectedMonthlySpot.id) === Number(quote?.data?.selectedMonthlyPosition?.id));
    return Boolean(fingerprint && selected?.available && selected?.pricingAvailable
      && selected.tripFingerprint === fingerprint && selected.offerKey
      && quote?.status === QUOTE_STATUS.SUCCESS && quote.tripFingerprint === fingerprint
      && quote.offerKey === selected.offerKey && quote.data?.quote && quote.data?.quoteToken
      && selectedSpotMatches && safeCents(quote.data.quote.totalCents) !== null && !quoteExpired(quote, now));
  }

  function normalizeStatus(value) {
    const status = String(value || '').trim().toUpperCase();
    return ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'COMPLETED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(status) ? status : 'UNKNOWN';
  }
  function reservationStatusView(booking) {
    const status = normalizeStatus(booking?.status);
    const assigned = Boolean(booking?.assignedSpotLabel);
    const monthlySelected = booking?.assignmentMode === 'CUSTOMER_SELECTED_SPOT';
    const legacyExact = booking?.assignmentMode === 'EXACT_SPOT' || (!booking?.assignmentMode && assigned);
    const exact = monthlySelected || legacyExact;
    const areaName = String(booking?.parkingArea?.name || booking?.category || 'Parking Area');
    const parkingDuration = supportedDuration(booking?.price?.duration || booking?.parkingProduct);
    const parkingLabel = parkingDuration === 'WEEKLY' ? 'Weekly Parking' : parkingDuration === 'MONTHLY' ? 'Monthly Parking' : 'Daily Parking';
    const common = { status, active: ACTIVE_STATUSES.has(status), exact, monthlySelected, legacyExact, areaName, assignedSpace: assigned ? String(booking.assignedSpotLabel) : 'Assignment pending', icon: 'neutral' };
    const definitions = {
      PENDING: { label: booking?.paymentStatus === 'CHECKOUT_PENDING' ? 'Payment pending' : 'Pending', heading: booking?.paymentStatus === 'CHECKOUT_PENDING' ? 'Payment verification pending' : 'Reservation received', description: booking?.paymentStatus === 'CHECKOUT_PENDING' ? 'This is not yet a valid parking authorization.' : 'Your reservation is awaiting completion.', tone: 'warning', icon: 'pending' },
      CONFIRMED: { label: `${parkingLabel} Confirmed`, heading: `${parkingLabel} Confirmed`, description: monthlySelected
        ? (assigned ? `Space ${booking.assignedSpotLabel} is reserved for you.` : 'Your space will be assigned when you arrive.')
        : legacyExact ? (assigned ? 'Your historical assigned space is ready.' : 'Your reservation is confirmed. Assignment is pending.')
          : `Parking is guaranteed within the highlighted ${areaName} area.`, tone: 'success', icon: 'success' },
      CHECKED_IN: { label: 'Checked in', heading: 'Parking stay active', description: 'Your arrival has been recorded.', tone: 'active', icon: 'active' },
      CHECKED_OUT: { label: 'Checked out', heading: 'Parking stay completed', description: 'Your departure has been recorded.', tone: 'neutral' },
      COMPLETED: { label: 'Completed', heading: 'Reservation completed', description: 'This parking stay is complete.', tone: 'neutral' },
      CANCELLED: { label: 'Cancelled', heading: 'Reservation cancelled', description: exact ? 'This reservation is no longer active and the space has been released.' : 'This reservation is no longer active and its parking-area capacity has been released.', tone: 'danger' },
      REJECTED: { label: 'Rejected', heading: 'Reservation not approved', description: 'This reservation was not approved and is not valid for parking.', tone: 'danger' },
      EXPIRED: { label: 'Expired', heading: 'Reservation expired', description: 'This reservation expired and is not valid for parking.', tone: 'danger' },
      UNKNOWN: { label: 'Status unavailable', heading: 'Reservation status unavailable', description: 'Refresh the page or call the office before relying on this reservation.', tone: 'neutral' }
    };
    const result = { ...common, ...definitions[status] };
    if (booking?.paymentStatus === 'DEMO_BYPASSED' && ['CONFIRMED','CHECKED_IN'].includes(status)) {
      result.label = 'DEMO / NO PAYMENT';
      result.heading = status === 'CHECKED_IN' ? 'Demo parking stay active' : 'Demo reservation active';
      result.description = 'Operational QA reservation. No card was charged and no revenue was recorded.';
    }
    result.financiallyPaid = booking?.paymentStatus === 'PAID' || booking?.financiallyPaid === true;
    const activePass = ['CONFIRMED', 'CHECKED_IN'].includes(status);
    result.passValid = activePass;
    result.mapValid = activePass && Boolean(booking?.map) && (!exact || assigned);
    result.showAssignedSpace = exact && ACTIVE_STATUSES.has(status) && assigned;
    result.showParkingArea = !exact;
    result.assignedSpace = result.showAssignedSpace ? String(booking.assignedSpotLabel) : (status === 'PENDING' || status === 'CONFIRMED' ? 'Assignment pending' : TERMINAL_STATUSES.has(status) ? 'Released / inactive' : 'Unavailable');
    result.canCancel = ['PENDING', 'CONFIRMED'].includes(status) && booking?.actions?.canCancel !== false;
    result.canCheckIn = status === 'CONFIRMED' && (!exact || assigned) && booking?.selfServiceEnabled === true && booking?.actions?.canCheckIn !== false;
    result.canCheckOut = status === 'CHECKED_IN' && (!exact || assigned) && booking?.selfServiceEnabled === true && booking?.actions?.canCheckOut !== false;
    result.pollAssignment = ACTIVE_STATUSES.has(status) && legacyExact && !assigned;
    result.canPrint = ['PENDING', 'CONFIRMED', 'CHECKED_IN'].includes(status);
    result.documentLabel = status === 'PENDING' ? 'Reservation receipt' : activePass ? 'Parking pass' : `${result.label} reservation record`;
    return result;
  }

  function activeRecentEntry(entries, reservationNumber = '', fallbackNumber = '') {
    const explicit = normalizeReservationNumber(reservationNumber);
    const values = Array.isArray(entries) ? entries : [];
    if (explicit) return values.find(item => normalizeReservationNumber(item?.reservationNumber) === explicit) || null;
    const preferred = normalizeReservationNumber(fallbackNumber);
    if (preferred) return values.find(item => normalizeReservationNumber(item?.reservationNumber) === preferred) || values[0] || null;
    return values[0] || null;
  }
  function transitionReservationSession(current, booking, credential = '', contact = '') {
    const incoming = validateBooking(booking);
    if (!incoming) return { booking: null, credential: '', contact: '', changed: Boolean(current?.booking) };
    const previousNumber = normalizeReservationNumber(current?.booking?.reservationNumber);
    const incomingNumber = incoming.reservationNumber;
    const same = Boolean(previousNumber && previousNumber === incomingNumber);
    return {
      booking: incoming,
      credential: credential ? String(credential) : same ? String(current?.credential || '') : '',
      contact: contact ? String(contact) : same ? String(current?.contact || '') : '',
      changed: previousNumber !== incomingNumber
    };
  }
  function createOperationGate() {
    let generation = 0;
    return {
      begin(identity = '') { generation += 1; return { generation, identity: normalizeReservationNumber(identity) }; },
      current(token, identity = token?.identity) { return Boolean(token && token.generation === generation && token.identity === normalizeReservationNumber(identity)); },
      invalidate() { generation += 1; },
      generation: () => generation
    };
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  }
  function payloadFingerprint(payload) { return stableStringify(payload); }
  function randomOperationKey(cryptoObject = typeof crypto !== 'undefined' ? crypto : null) {
    if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
    const bytes = new Uint8Array(16); cryptoObject?.getRandomValues?.(bytes);
    if (!bytes.some(Boolean)) for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  }
  function classifyError(error) {
    if (error?.name === 'AbortError') return 'aborted';
    if (error?.code === 'REQUEST_TIMEOUT') return 'timeout';
    if (!navigatorOnline() || error?.code === 'NETWORK') return 'network';
    if ([401, 403].includes(error?.status)) return 'authorization';
    if (error?.status === 404) return 'not_found';
    if (error?.status === 400 || error?.status === 422) return 'validation';
    if (error?.status === 409) return 'conflict';
    if (error?.status >= 500) return 'server';
    return 'unknown';
  }
  function navigatorOnline() { return typeof navigator === 'undefined' || navigator.onLine !== false; }
  function ambiguousBookingFailure(error) { return ['network', 'timeout', 'server', 'unknown'].includes(classifyError(error)); }

  function center(element) { return { x: Number(element.x) + Number(element.width) / 2, y: Number(element.y) + Number(element.height) / 2 }; }
  function saneElement(element) { return element && [element.x, element.y, element.width, element.height].every(value => Number.isFinite(Number(value))) && Number(element.width) > 0 && Number(element.height) > 0; }
  function resolveEntrance(map) {
    const elements = Array.isArray(map?.elements) ? map.elements : [];
    const byKey = key => key ? elements.find(element => element.elementKey === key && saneElement(element)) : null;
    const routeEntrance = byKey(map?.route?.entranceElementKey);
    if (routeEntrance) return { ...center(routeEntrance), source: 'route' };
    const entrance = elements.find(element => String(element.elementType).toUpperCase() === 'ENTRANCE' && saneElement(element));
    if (entrance) return { ...center(entrance), source: 'element' };
    const spot = label => elements.find(element => String(element.elementType).toUpperCase() === 'PARKING_SPOT' && String(element.label) === label && saneElement(element));
    const one = spot('143'); const two = spot('142');
    if (!one || !two) return null;
    const oneBottom = Number(one.y) + Number(one.height); const twoBottom = Number(two.y) + Number(two.height);
    const gapTop = Math.min(Math.max(Number(one.y), Number(two.y)), Math.max(oneBottom, twoBottom));
    const gapBottom = Math.max(Math.min(Number(one.y), Number(two.y)), Math.min(oneBottom, twoBottom));
    const upperBottom = Math.min(oneBottom, twoBottom); const lowerTop = Math.max(Number(one.y), Number(two.y));
    if (!(lowerTop > upperBottom)) return null;
    return { x: (center(one).x + center(two).x) / 2, y: (upperBottom + lowerTop) / 2, source: 'spaces' };
  }
  function routeElementKeys(map) {
    const route = map?.route || {};
    return new Set([route.entranceElementKey, route.exitElementKey, ...(route.arrivalRouteElementKeys || []), ...(route.exitRouteElementKeys || [])].filter(Boolean));
  }
  function authoritativeRoutePoints(map) {
    return map?.route?.validated && Array.isArray(map.route.points) && map.route.points.length > 1 && map.route.points.every(point => Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))) ? map.route.points : [];
  }
  function nextMapZoom(current, action) {
    const zoom = Number.isFinite(Number(current)) ? Number(current) : 1;
    if (action === 'fit') return 1;
    return Math.min(2.4, Math.max(1, Math.round((zoom + (action === 'in' ? .2 : -.2)) * 10) / 10));
  }
  function mapKeyboardAction(key, zoom) {
    if (key === '+' || key === '=') return { zoom: 'in' };
    if (key === '-') return { zoom: 'out' };
    if (key === '0' || key === 'Home') return { zoom: 'fit' };
    if (Number(zoom) > 1 && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return { pan: key };
    return null;
  }
  function canStartMapPan({ zoom, button, fromControl }) { return Number(zoom) > 1 && Number(button) === 0 && !fromControl; }
  function mutationBooking(response, refreshed) { return validateBooking(response?.booking) || validateBooking(refreshed); }

  return {
    CATEGORY_METADATA, PUBLIC_CATEGORY_CODES, SUPPORTED_CUSTOMER_DURATIONS, SEARCH_STATUS, QUOTE_STATUS, SUBMISSION_STATUS,
    normalizeReservationNumber, categoryMetadata, publicParkingLabel, filterPublicCategories, supportedDuration, filterSupportedDurations, normalizeLocal, tripFingerprint,
    calendarDayDifference, localElapsedDays, productIntervalError, addLocalCalendarDays, zonedInputValue, humanTime, humanLocalTime,
    safeCents, money, validateCanonicalLot, validateAvailabilityResults, validateQuote, validateBooking,
    offerKey, quoteExpired, bookingCanContinue, normalizeStatus, reservationStatusView,
    activeRecentEntry, transitionReservationSession, createOperationGate, stableStringify, payloadFingerprint,
    randomOperationKey, classifyError, ambiguousBookingFailure, resolveEntrance, routeElementKeys, authoritativeRoutePoints,
    nextMapZoom, mapKeyboardAction, canStartMapPan, mutationBooking
  };
});
