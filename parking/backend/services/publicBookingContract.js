const { digest } = require('../utils');

const SUPPORTED_PUBLIC_CATEGORY_CODES = Object.freeze(['BOBTAIL', 'TRACTOR_TRAILER']);

function assertPublicCategory(code) {
  if (!SUPPORTED_PUBLIC_CATEGORY_CODES.includes(code)) {
    const error = new Error('Choose a supported parking category');
    error.code = 'UNSUPPORTED_PUBLIC_CATEGORY';
    error.status = 422;
    throw error;
  }
  return code;
}

function publicCategoryName(code, fallback = '') {
  if (code === 'BOBTAIL') return 'Bobtail';
  if (code === 'TRACTOR_TRAILER') return 'General Truck Parking';
  return fallback;
}

function cleanLines(values) {
  return values.map(value => String(value || '').trim()).filter(Boolean);
}

function publicTerms(location) {
  const parkingContent = cleanLines([location?.payment_instructions, location?.arrival_instructions]);
  const cutoffHours = Number(location?.cancellation_cutoff_hours);
  const cancellationContent = Number.isFinite(cutoffHours) && cutoffHours >= 0
    ? [`Online cancellation is available until ${cutoffHours} hours before the scheduled arrival time.`]
    : [];
  const source = { parkingContent, cancellationContent, cutoffHours: Number.isFinite(cutoffHours) ? cutoffHours : null };
  const available = parkingContent.length > 0 && cancellationContent.length > 0;
  return {
    available,
    version: available ? digest(JSON.stringify(source)).slice(0, 16) : null,
    parking: { title: 'Parking Terms', content: parkingContent },
    cancellation: { title: 'Cancellation Policy', content: cancellationContent }
  };
}

function bookingActions(row, nowValue = Date.now()) {
  const now = Number(nowValue);
  const arrival = new Date(row?.arrival_at).getTime();
  // Open-ended Monthly parking has no departure yet.
  const departure = row?.departure_at ? new Date(row.departure_at).getTime() : Infinity;
  const cutoff = arrival - Number(row?.cancellation_cutoff_hours || 0) * 3600000;
  const opensAt = arrival - Number(row?.check_in_early_minutes || 0) * 60000;
  const closesAt = Math.min(departure, arrival + Number(row?.check_in_late_minutes || 0) * 60000);
  const status = String(row?.status || '').toUpperCase();
  const hasAssignment = Boolean(row?.parking_spot_id || row?.assignment_public_label || row?.assigned_spot_label);
  const assignmentMode = String(row?.assignment_mode_snapshot || row?.assignmentMode || '').toUpperCase();
  const selectedSpotMode = assignmentMode === 'CUSTOMER_SELECTED_SPOT' || assignmentMode === 'EXACT_SPOT';
  const hasParkingArea = Boolean(row?.inventory_id || row?.parkingArea?.id);
  const hasParkingAuthorization = selectedSpotMode ? hasAssignment : hasParkingArea;
  const selfService = Boolean(row?.self_service_enabled);
  const recurringMonthly = String(row?.parking_product || '').toUpperCase() === 'MONTHLY'
    && Boolean(row?.stripe_subscription_id || row?.stripe_customer_id);
  const canCancel = !recurringMonthly && ['PENDING', 'CONFIRMED'].includes(status) && Number.isFinite(cutoff) && now < cutoff;
  const canCheckIn = status === 'CONFIRMED' && hasParkingAuthorization && selfService && now >= opensAt && now <= closesAt;
  const canCheckOut = status === 'CHECKED_IN' && hasParkingAuthorization && selfService;
  let reason = '';
  if (!selfService) reason = 'Online arrival and departure actions are not enabled for this location.';
  else if (status === 'CONFIRMED' && now < opensAt) reason = 'Customer check-in is not open yet.';
  else if (status === 'CONFIRMED' && now > closesAt) reason = 'The customer check-in window has closed.';
  else if (recurringMonthly && ['PENDING', 'CONFIRMED'].includes(status)) reason = 'Manage recurring Monthly cancellation through secure billing.';
  else if (!canCancel && ['PENDING', 'CONFIRMED'].includes(status) && now >= cutoff) reason = 'The online cancellation cutoff has passed.';
  else if (!hasParkingAuthorization && ['PENDING', 'CONFIRMED'].includes(status)) reason = selectedSpotMode
    ? 'Your parking space must be assigned before you can check in.'
    : 'A permitted parking area is required before customer check-in.';
  else if (!canCancel && !canCheckIn && !canCheckOut) reason = `No customer action is currently available for a ${status.toLowerCase().replaceAll('_', ' ')} reservation.`;
  return {
    canCancel, canCheckIn, canCheckOut, reason,
    cutoff: Number.isFinite(cutoff) ? new Date(cutoff).toISOString() : null,
    opensAt: Number.isFinite(opensAt) ? new Date(opensAt).toISOString() : null
  };
}

module.exports = {
  SUPPORTED_PUBLIC_CATEGORY_CODES,
  assertPublicCategory,
  publicCategoryName,
  publicTerms,
  bookingActions
};
