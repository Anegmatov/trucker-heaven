const crypto = require('crypto');
const { DateTime, IANAZone } = require('luxon');

function apiError(code, message, status = 400, details) {
  const error = new Error(message); error.code = code; error.status = status; error.details = details; return error;
}
function safeLog(event, error) { console.error(JSON.stringify({ event, message: error?.message || 'unknown error' })); }
function token(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function digest(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
// Short and easy to read out: TH- plus 6 characters, leaving out look-alikes (0/O, 1/I/L).
// 31^6 is about 887 million codes, and the database rejects a duplicate anyway.
const RESERVATION_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function reservationNumber() {
  let code = '';
  for (const byte of crypto.randomBytes(6)) code += RESERVATION_ALPHABET[byte % RESERVATION_ALPHABET.length];
  return `TH-${code}`;
}
function cleanText(value, max, field, required = false) {
  const result = String(value || '').trim();
  if (required && !result) throw apiError('VALIDATION_ERROR', `${field} is required`);
  if (result.length > max) throw apiError('VALIDATION_ERROR', `${field} is too long`);
  return result || null;
}
function email(value) { const result = cleanText(value, 254, 'Email', true).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw apiError('VALIDATION_ERROR', 'Enter a valid email address'); return result; }
function phone(value) { const digits = String(value || '').replace(/\D/g, ''); if (digits.length < 10 || digits.length > 15) throw apiError('VALIDATION_ERROR', 'Enter a valid mobile phone number'); return `+${digits.length === 10 ? `1${digits}` : digits}`; }
function interval(arrival, departure) { const start = new Date(arrival); const end = new Date(departure); if (Number.isNaN(+start) || Number.isNaN(+end) || end <= start) throw apiError('INVALID_BOOKING_INTERVAL', 'Departure must be after arrival'); return { start: start.toISOString(), end: end.toISOString() }; }
function locationInterval(arrivalLocal, departureLocal, timezone, { allowOpenEnded = false } = {}) {
  if (!IANAZone.isValidZone(timezone)) throw apiError('LOCATION_TIMEZONE_INVALID', 'The parking location timezone is invalid', 409);
  const parse = (value, field) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(value || ''))) throw apiError('INVALID_BOOKING_INTERVAL', `${field} must be a local date and time`);
    const parsed = DateTime.fromISO(value, { zone: timezone, setZone: true });
    if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm") !== value) throw apiError('NONEXISTENT_LOCAL_TIME', `${field} does not exist in ${timezone}`, 422);
    if (parsed.getPossibleOffsets().length > 1) throw apiError('AMBIGUOUS_LOCAL_TIME', `${field} is ambiguous in ${timezone}; choose a different time`, 422);
    return parsed;
  };
  const start = parse(arrivalLocal, 'Arrival');
  if (allowOpenEnded && !String(departureLocal || '').trim()) {
    return { start: start.toUTC().toISO(), end: null, timezone, arrivalLocal: start.toFormat("yyyy-MM-dd'T'HH:mm"), departureLocal: null };
  }
  const end = parse(departureLocal, 'Departure');
  if (end <= start) throw apiError('INVALID_BOOKING_INTERVAL', 'Departure must be after arrival');
  return { start: start.toUTC().toISO(), end: end.toUTC().toISO(), timezone, arrivalLocal: start.toFormat("yyyy-MM-dd'T'HH:mm"), departureLocal: end.toFormat("yyyy-MM-dd'T'HH:mm") };
}
function cents(value, name) { const n = Number(value); if (!Number.isInteger(n)) throw apiError('VALIDATION_ERROR', `${name} must be whole cents`); return n; }
module.exports = { apiError, safeLog, token, digest, reservationNumber, cleanText, email, phone, interval, locationInterval, cents };
