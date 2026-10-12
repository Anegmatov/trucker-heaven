/* Trucker Heaven Parking: pure booking helpers shared by the browser app and the Node tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ParkingCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TERMS = Object.freeze({
    DAILY: { label: 'Daily', unit: 'day', plural: 'days' },
    WEEKLY: { label: 'Weekly', unit: 'week', plural: 'weeks' },
    MONTHLY: { label: 'Monthly', unit: 'month', plural: 'months' }
  });
  const MAX_WEEKS = 3; // the API caps a Weekly stay at 27 days
  const MAX_DAILY_DAYS = 27;

  function money(cents, { whole = false } = {}) {
    const value = Number(cents || 0) / 100;
    const digits = whole && Number.isInteger(value) ? 0 : 2;
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  }

  const pad = n => String(n).padStart(2, '0');

  // "Today" and the current time at the lot, as plain local strings.
  function lotNow(timezone, now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(now).map(part => [part.type, part.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  }

  function parseDate(date) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
    return match ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])) : null;
  }
  function formatDate(value) { return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`; }
  function addDays(date, days) {
    const value = parseDate(date);
    if (!value) return '';
    value.setUTCDate(value.getUTCDate() + days);
    return formatDate(value);
  }
  function minutes(time) {
    const match = /^(\d{2}):(\d{2})$/.exec(String(time || ''));
    return match ? (+match[1]) * 60 + (+match[2]) : null;
  }
  // Wall-clock difference in hours between two local date/time pairs (DST is ignored on purpose:
  // it only feeds the on-screen estimate, the server quote is authoritative).
  function hoursBetween(startDate, startTime, endDate, endTime) {
    const a = parseDate(startDate); const b = parseDate(endDate);
    const am = minutes(startTime); const bm = minutes(endTime);
    if (!a || !b || am == null || bm == null) return null;
    return ((b - a) / 86400000) * 24 + (bm - am) / 60;
  }

  // Default start: the next whole hour at the lot, at least 30 minutes away.
  function defaultArrival(timezone, now = new Date()) {
    const local = lotNow(timezone, now);
    let hour = Number(local.time.slice(0, 2)) + 1;
    if (minutes(local.time) % 60 > 30) hour += 1;
    let date = local.date;
    if (hour >= 24) { hour -= 24; date = addDays(date, 1); }
    return { date, time: `${pad(hour)}:00` };
  }

  function departureFor(trip) {
    if (trip.duration === 'WEEKLY') return { date: addDays(trip.arrivalDate, 7 * Math.max(1, Number(trip.weeks) || 1)), time: trip.arrivalTime };
    if (trip.duration === 'DAILY') return { date: trip.departureDate, time: trip.departureTime };
    return null;
  }

  // Turns the search form state into the API trip payload, or returns field errors.
  function buildTrip(form, { timezone, now = new Date() } = {}) {
    const errors = {};
    const duration = form.duration;
    if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(duration)) errors.duration = 'Choose Daily, Weekly or Monthly.';
    if (!['TRACTOR_TRAILER', 'BOBTAIL'].includes(form.categoryCode)) errors.categoryCode = 'Choose your vehicle type.';
    if (!parseDate(form.arrivalDate)) errors.arrivalDate = 'Choose your arrival date.';
    if (minutes(form.arrivalTime) == null) errors.arrivalTime = 'Choose your arrival time.';
    const local = lotNow(timezone, now);
    if (!errors.arrivalDate && !errors.arrivalTime) {
      const ahead = hoursBetween(local.date, local.time, form.arrivalDate, form.arrivalTime);
      if (ahead < 0) errors.arrivalTime = 'Arrival time has already passed. Pick a later time.';
      if (ahead > 24 * 365) errors.arrivalDate = 'Reservations open up to a year ahead.';
    }
    let departure = null;
    if (duration === 'DAILY') {
      departure = departureFor(form);
      if (!parseDate(departure.date)) errors.departureDate = 'Choose your departure date.';
      else if (minutes(departure.time) == null) errors.departureTime = 'Choose your departure time.';
      else if (!errors.arrivalDate && !errors.arrivalTime) {
        const hours = hoursBetween(form.arrivalDate, form.arrivalTime, departure.date, departure.time);
        if (hours <= 0) errors.departureDate = 'Departure must be after arrival.';
        else if (hours > MAX_DAILY_DAYS * 24) errors.departureDate = `Daily parking is up to ${MAX_DAILY_DAYS} days. Choose Weekly or Monthly for longer stays.`;
      }
    }
    if (duration === 'WEEKLY') {
      const weeks = Number(form.weeks);
      if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_WEEKS) errors.weeks = `Choose 1 to ${MAX_WEEKS} weeks.`;
      else departure = departureFor(form);
    }
    if (Object.keys(errors).length) return { errors };
    const trip = { categoryCode: form.categoryCode, duration, arrivalLocal: `${form.arrivalDate}T${form.arrivalTime}` };
    if (departure) trip.departureLocal = `${departure.date}T${departure.time}`;
    return { trip };
  }

  // On-screen estimate before the server quote arrives.
  function estimate(form, rates) {
    const rate = rates?.[form.duration];
    if (rate == null) return null;
    if (form.duration === 'DAILY') {
      const hours = hoursBetween(form.arrivalDate, form.arrivalTime, form.departureDate, form.departureTime);
      if (!(hours > 0)) return null;
      const units = Math.max(1, Math.ceil(hours / 24 - 1e-9));
      return { units, totalCents: units * rate, label: `${units} ${units === 1 ? 'day' : 'days'}` };
    }
    if (form.duration === 'WEEKLY') {
      const units = Math.max(1, Number(form.weeks) || 1);
      return { units, totalCents: units * rate, label: `${units} ${units === 1 ? 'week' : 'weeks'}` };
    }
    return { units: 1, totalCents: rate, label: 'per month', recurring: true };
  }

  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function formatTime(time) {
    const m = minutes(time);
    if (m == null) return '';
    const h = Math.floor(m / 60); const mm = m % 60;
    return `${(h % 12) || 12}:${pad(mm)} ${h < 12 ? 'AM' : 'PM'}`;
  }
  function formatDay(date, { year = false } = {}) {
    const value = parseDate(date);
    if (!value) return '';
    return `${WEEKDAYS[value.getUTCDay()]}, ${MONTHS[value.getUTCMonth()]} ${value.getUTCDate()}${year ? `, ${value.getUTCFullYear()}` : ''}`;
  }
  // "2026-10-16T18:00" -> "Fri, Oct 16 · 6:00 PM"
  function formatLocal(local) {
    const [date, time] = String(local || '').split('T');
    if (!parseDate(date)) return '';
    return time ? `${formatDay(date)} · ${formatTime(time.slice(0, 5))}` : formatDay(date);
  }
  // An instant shown at the lot's time zone.
  function formatInstant(iso, timezone) {
    if (!iso) return '';
    const value = new Date(iso);
    if (Number.isNaN(+value)) return '';
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(value).map(part => [part.type, part.value]));
    return formatLocal(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`);
  }
  function formatInstantDate(iso, timezone) {
    const text = formatInstant(iso, timezone);
    return text.split(' · ')[0];
  }

  function formatPhone(value) {
    const digits = String(value || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : String(value || '');
  }

  // Details form validation. Mirrors the API's rules so most mistakes are caught before submit.
  function validateDetails(values, { monthly = false, bobtail = false } = {}) {
    const errors = {};
    const text = key => String(values[key] || '').trim();
    if (!text('firstName')) errors.firstName = 'Enter your first name.';
    if (!text('lastName')) errors.lastName = 'Enter your last name.';
    const digits = text('mobilePhone').replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) errors.mobilePhone = 'Enter a mobile number we can text.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text('email'))) errors.email = 'Enter a valid email address.';
    if (monthly && !text('companyName')) errors.companyName = 'Company or carrier name is required for Monthly parking.';
    const usdot = text('usdotNumber').replace(/\D/g, '');
    if (text('usdotNumber') && (!usdot || usdot.length > 12)) errors.usdotNumber = 'Enter a valid USDOT number (digits only).';
    if (!text('licensePlate')) errors.licensePlate = 'Enter your plate number.';
    if (!/^[A-Za-z]{2}$/.test(text('licensePlateState'))) errors.licensePlateState = 'Use the 2-letter state code.';
    if (!text('tractorUnitNumber')) errors.tractorUnitNumber = 'Enter your truck or unit number.';
    if (!values.termsAccepted) errors.termsAccepted = 'Please accept the parking terms to continue.';
    if (bobtail && text('trailerNumber')) errors.trailerNumber = 'Bobtail parking is for a tractor without a trailer.';
    return errors;
  }

  // Manage links put the reservation number and access code in the URL fragment, which
  // browsers never send to a server.
  function manageHash(reservationNumber, credential) {
    return `#r=${encodeURIComponent(reservationNumber)}&c=${encodeURIComponent(credential)}`;
  }
  function parseManageHash(hash) {
    const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const reservationNumber = (params.get('r') || '').trim().toUpperCase();
    const credential = (params.get('c') || '').trim();
    return reservationNumber && credential ? { reservationNumber, credential } : null;
  }
  function normalizeReservationNumber(value) {
    return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  }

  const FULL = 'That time is full for this vehicle type. Try different dates or call the office.';
  const TAKEN = 'Someone just took that space. Please pick another one.';
  const REQUOTE = 'Your price check expired. Please check availability again.';
  const NOT_FOUND = 'We could not find a reservation with that number and access code.';
  const FRIENDLY_ERRORS = {
    PARKING_NOT_AVAILABLE: FULL, PARKING_ALLOCATION_UNAVAILABLE: FULL,
    MONTHLY_POSITION_UNAVAILABLE: TAKEN, SPOT_ALREADY_ASSIGNED: TAKEN, SPOT_NOT_ELIGIBLE: TAKEN,
    QUOTE_EXPIRED: REQUOTE, QUOTE_INVALID: REQUOTE, QUOTE_STALE: REQUOTE, QUOTE_ALREADY_USED: REQUOTE, QUOTE_REQUEST_MISMATCH: REQUOTE,
    TERMS_VERSION_STALE: 'The parking terms were just updated. Please review and accept them again.',
    CUSTOMER_IDENTITY_CONFLICT: 'This phone or email is already on file with different details. Call the office and we will sort it out.',
    BOOKING_NOT_FOUND: NOT_FOUND, RESERVATION_NOT_FOUND: NOT_FOUND, RESERVATION_ACCESS_DENIED: NOT_FOUND, NOT_FOUND: NOT_FOUND,
    CANCELLATION_NOT_ELIGIBLE: 'Online cancellation has closed for this reservation. Please call the office.',
    PUBLIC_RATE_LIMITED: 'Too many tries. Please wait a minute and try again.',
    RATE_NOT_CONFIGURED: 'Online booking is not open for this option yet. Please call the office.',
    NETWORK: 'We could not reach the reservation system. Check your connection and try again.'
  };
  const RETRY_QUOTE_CODES = new Set(['QUOTE_EXPIRED', 'QUOTE_INVALID', 'QUOTE_STALE', 'QUOTE_ALREADY_USED', 'TERMS_VERSION_STALE']);
  function friendlyError(error) {
    const code = error?.code;
    return FRIENDLY_ERRORS[code] || error?.message || 'Something went wrong. Please try again or call the office.';
  }

  function statusLabel(status) {
    return ({ CONFIRMED: 'Confirmed', PENDING: 'Waiting for office approval', CHECKED_IN: 'Parked', CHECKED_OUT: 'Completed',
      COMPLETED: 'Completed', CANCELLED: 'Cancelled', NO_SHOW: 'No-show', EXPIRED: 'Expired', PAID: 'Paid', REFUNDED: 'Refunded' })[status] || String(status || '').replace(/_/g, ' ').toLowerCase();
  }

  return {
    TERMS, MAX_WEEKS, MAX_DAILY_DAYS, money, lotNow, addDays, hoursBetween, defaultArrival, departureFor, buildTrip,
    estimate, formatTime, formatDay, formatLocal, formatInstant, formatInstantDate, formatPhone, validateDetails,
    manageHash, parseManageHash, normalizeReservationNumber, friendlyError, statusLabel, RETRY_QUOTE_CODES
  };
});
