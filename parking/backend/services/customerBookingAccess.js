const bcrypt = require('bcrypt');
const { apiError } = require('../utils');

async function authorizedBooking(client, publicToken, credential, { lock = false } = {}) {
  const rawToken = String(publicToken || '').trim();
  const rawCredential = String(credential || '');
  if (!rawToken || !rawCredential) throw apiError('RESERVATION_ACCESS_DENIED', 'Reservation access credentials are required', 401);
  const result = await client.query(`SELECT * FROM parking_bookings WHERE public_token=$1${lock ? ' FOR UPDATE' : ''}`, [rawToken]);
  const booking = result.rows[0];
  if (!booking || !(await bcrypt.compare(rawCredential, booking.lookup_credential_hash))) {
    throw apiError('RESERVATION_ACCESS_DENIED', 'Reservation access credentials are invalid', 403);
  }
  return booking;
}

module.exports = { authorizedBooking };
