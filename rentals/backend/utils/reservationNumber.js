// Customer-facing reservation number, e.g. R-0001. Short enough to read over the phone;
// derived from the database id so staff can match it instantly.
const REQUEST_NUMBER_PREFIX = "R";
const REQUEST_NUMBER_WIDTH = 4;

function formatReservationRequestNumber(reservationId) {
  const id = Number(reservationId);
  if (!Number.isSafeInteger(id) || id <= 0) return "";
  return `${REQUEST_NUMBER_PREFIX}-${String(id).padStart(REQUEST_NUMBER_WIDTH, "0")}`;
}

module.exports = {
  REQUEST_NUMBER_PREFIX,
  REQUEST_NUMBER_WIDTH,
  formatReservationRequestNumber
};
