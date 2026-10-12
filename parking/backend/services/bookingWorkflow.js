const { apiError } = require('../utils');
const TRANSITIONS = Object.freeze({
  PENDING: ['CONFIRMED', 'CANCELLED', 'EXPIRED'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['CHECKED_OUT'], CHECKED_OUT: ['COMPLETED'],
  COMPLETED: [], CANCELLED: [], NO_SHOW: [], EXPIRED: []
});
// Payment attempts never reserve inventory. Only finalized reservations can
// consume capacity or an exact numbered space.
const OCCUPYING = new Set(['CONFIRMED', 'CHECKED_IN']);
const pendingExpiryMinutes = Number(process.env.PARKING_PENDING_BOOKING_EXPIRY_MINUTES || 30);
if (!Number.isInteger(pendingExpiryMinutes) || pendingExpiryMinutes < 1 || pendingExpiryMinutes > 10080) {
  throw new Error('PENDING_BOOKING_EXPIRY_MINUTES must be a whole number between 1 and 10080');
}
function assertTransition(from, to) { if (!TRANSITIONS[from]?.includes(to)) throw apiError('BOOKING_TRANSITION_NOT_ALLOWED', `Cannot move ${from} to ${to}`, 409); }
function blocksCapacity(status) { return OCCUPYING.has(status); }
function capacityBlockingStatuses() { return [...OCCUPYING]; }
function pendingExpiryAt() { return new Date(Date.now() + pendingExpiryMinutes * 60 * 1000).toISOString(); }
// The caller owns the transaction. Matching history is inserted before the
// deferred database integrity trigger evaluates the status update at commit.
async function expirePendingBookings(client) {
  const expired = await client.query(`SELECT id, version FROM parking_bookings
    WHERE status='PENDING' AND pending_expires_at IS NOT NULL AND pending_expires_at<=now()
    FOR UPDATE SKIP LOCKED`);
  for (const booking of expired.rows) {
    await client.query(`UPDATE parking_bookings
      SET status='EXPIRED', pending_expires_at=NULL, version=version+1, updated_at=now()
      WHERE id=$1 AND version=$2`, [booking.id, booking.version]);
    await client.query(`INSERT INTO parking_booking_status_history
      (booking_id,previous_status,new_status,actor_type,reason,version)
      VALUES($1,'PENDING','EXPIRED','SYSTEM','Pending approval expired',$2)`, [booking.id, Number(booking.version) + 1]);
    await client.query(`UPDATE reservation_spot_assignments
      SET released_at=COALESCE(released_at,now()),release_reason=COALESCE(release_reason,'Pending approval expired')
      WHERE booking_id=$1 AND released_at IS NULL`, [booking.id]);
    await client.query('UPDATE parking_bookings SET assigned_zone_id=NULL,assigned_spot_label=NULL WHERE id=$1', [booking.id]);
  }
  return expired.rowCount;
}
module.exports = { TRANSITIONS, assertTransition, blocksCapacity, capacityBlockingStatuses, pendingExpiryAt, expirePendingBookings };
