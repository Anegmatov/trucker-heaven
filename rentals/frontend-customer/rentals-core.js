/* Trucker Heaven Rentals: pure helpers shared by the browser app and the Node tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RentalsCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TIME_ZONE = "America/Chicago";
  const MAX_DAYS = 30;
  const OPEN_HOUR = 8;
  const CLOSE_HOUR = 18;
  const pad = (n) => String(n).padStart(2, "0");
  const hourLabel = (h) => `${(h % 12) || 12} ${h < 12 ? "AM" : "PM"}`;
  const OFFICE_HOURS = `Mon–Sat, ${hourLabel(OPEN_HOUR)}–${hourLabel(CLOSE_HOUR)}`;

  function money(value, { cents = false, whole = false } = {}) {
    const dollars = cents ? Number(value || 0) / 100 : Number(value || 0);
    const digits = whole && Number.isInteger(dollars) ? 0 : 2;
    return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  }

  function lotNow(now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(now).map((part) => [part.type, part.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  }
  function parseDate(date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  }
  function addDays(date, days) {
    const value = parseDate(date);
    if (!value) return "";
    value.setUTCDate(value.getUTCDate() + days);
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  const minutes = (time) => { const m = /^(\d{2}):(\d{2})$/.exec(String(time || "")); return m ? +m[1] * 60 + +m[2] : null; };
  function hoursBetween(aDate, aTime, bDate, bTime) {
    const a = parseDate(aDate); const b = parseDate(bDate); const am = minutes(aTime); const bm = minutes(bTime);
    if (!a || !b || am == null || bm == null) return null;
    return ((b - a) / 86400000) * 24 + (bm - am) / 60;
  }
  const isSunday = (date) => parseDate(date)?.getUTCDay() === 0;

  // Counter times: every 30 minutes while the office is open.
  function counterTimes() {
    const times = [];
    for (let m = OPEN_HOUR * 60; m <= CLOSE_HOUR * 60; m += 30) times.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
    return times;
  }

  // Default trip: next open day at 9:00 AM, back the next open day.
  function defaultTrip(now = new Date()) {
    const local = lotNow(now);
    let date = minutes(local.time) < OPEN_HOUR * 60 ? local.date : addDays(local.date, 1);
    if (isSunday(date)) date = addDays(date, 1);
    let back = addDays(date, 1);
    if (isSunday(back)) back = addDays(back, 1);
    return { pickupDate: date, pickupTime: "09:00", returnDate: back, returnTime: "09:00" };
  }

  function rentalDays(trip) {
    const hours = hoursBetween(trip.pickupDate, trip.pickupTime, trip.returnDate, trip.returnTime);
    return hours > 0 ? Math.max(1, Math.ceil(hours / 24 - 1e-9)) : 0;
  }

  function validateTrip(trip, now = new Date()) {
    const errors = {};
    if (!parseDate(trip.pickupDate)) errors.pickupDate = "Choose a pickup date.";
    else if (isSunday(trip.pickupDate)) errors.pickupDate = "The office is closed on Sundays. Choose another pickup day.";
    if (minutes(trip.pickupTime) == null) errors.pickupTime = "Choose a pickup time.";
    if (!parseDate(trip.returnDate)) errors.returnDate = "Choose a return date.";
    else if (isSunday(trip.returnDate)) errors.returnDate = "The office is closed on Sundays. Choose another return day.";
    if (minutes(trip.returnTime) == null) errors.returnTime = "Choose a return time.";
    if (Object.keys(errors).length) return errors;
    const local = lotNow(now);
    if (hoursBetween(local.date, local.time, trip.pickupDate, trip.pickupTime) < 0) errors.pickupTime = "That pickup time has passed. Choose a later time.";
    const hours = hoursBetween(trip.pickupDate, trip.pickupTime, trip.returnDate, trip.returnTime);
    if (hours <= 0) errors.returnDate = "Return must be after pickup.";
    else if (hours > MAX_DAYS * 24) errors.returnDate = `Rentals are up to ${MAX_DAYS} days. Call us for longer rentals.`;
    return errors;
  }

  const tripQuery = (trip) => `pickupAt=${encodeURIComponent(`${trip.pickupDate}T${trip.pickupTime}`)}&returnAt=${encodeURIComponent(`${trip.returnDate}T${trip.returnTime}`)}`;

  // Fleet refinement: free text, category, minimum seats, maximum daily rate and sort, all client-side.
  const SORTS = Object.freeze({ "": "Recommended", "price-asc": "Price: low to high", "price-desc": "Price: high to low", "year-desc": "Newest" });
  const FILTER_KEYS = ["q", "category", "seats", "maxRate", "sort"];
  const hasFilters = (filters) => FILTER_KEYS.some((key) => filters[key]);
  function filterFleet(vehicles, filters = {}) {
    const words = String(filters.q || "").toLowerCase().split(/\s+/).filter(Boolean);
    const seats = Number(filters.seats) || 0;
    const maxRate = Number(filters.maxRate) || 0;
    const list = vehicles.filter((v) => {
      const text = [v.year, v.make, v.model, v.category, v.transmission, v.fuelType, v.locationName].join(" ").toLowerCase();
      return words.every((word) => text.includes(word)) && (!filters.category || v.category === filters.category)
        && Number(v.seats || 0) >= seats && (!maxRate || Number(v.dailyRate || 0) <= maxRate);
    });
    const by = { "price-asc": (a, b) => a.dailyRate - b.dailyRate, "price-desc": (a, b) => b.dailyRate - a.dailyRate, "year-desc": (a, b) => b.year - a.year }[filters.sort];
    return by ? list.sort(by) : list;
  }
  // Seat choices ("N+ seats") from the fleet, keeping a choice that came from a shared link.
  const seatOptions = (vehicles, selected) => [...new Set([...vehicles.map((v) => Number(v.seats)), Number(selected)].filter((n) => n > 0))].sort((a, b) => a - b);

  // Hash routes: #/?q=…&category=…, #/v/ID?pickupAt=…&returnAt=…, #/v/ID/details?pickupAt=…,
  // #t=TOKEN (private link from the confirmation text, or a lookup grant), #find.
  const stamp = (value) => /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(String(value || ""));
  function parseRoute(hash) {
    const [path, query = ""] = String(hash || "").replace(/^#/, "").split("?");
    const params = new URLSearchParams(query);
    const tokenMatch = /^t=(.+)$/.exec(path);
    const token = tokenMatch && validToken(tokenMatch[1]) ? tokenMatch[1] : undefined;
    const vehicleMatch = /^\/v\/(\d+)(\/details)?$/.exec(path);
    const id = vehicleMatch?.[1];
    const details = Boolean(vehicleMatch?.[2]);
    const pickup = stamp(params.get("pickupAt")); const back = stamp(params.get("returnAt"));
    const times = counterTimes();
    const trip = pickup && back && times.includes(pickup[2]) && times.includes(back[2])
      ? { pickupDate: pickup[1], pickupTime: pickup[2], returnDate: back[1], returnTime: back[2] } : null;
    const filters = Object.fromEntries(FILTER_KEYS.map((key) => [key, (params.get(key) || "").trim()]));
    if (!Object.hasOwn(SORTS, filters.sort)) filters.sort = "";
    return { view: token ? "reservation" : id ? (details ? "details" : "vehicle") : path === "find" ? "find" : "home", token, id, trip, filters, hasParams: [...params.keys()].length > 0 };
  }
  function routeHash(path, trip, filters = {}) {
    const params = new URLSearchParams();
    if (trip) { params.set("pickupAt", `${trip.pickupDate}T${trip.pickupTime}`); params.set("returnAt", `${trip.returnDate}T${trip.returnTime}`); }
    FILTER_KEYS.forEach((key) => { if (filters[key]) params.set(key, filters[key]); });
    const query = params.toString().replace(/%3A/g, ":");
    return `#${path}${query ? `?${query}` : ""}`;
  }

  function estimate(vehicle, trip) {
    const days = rentalDays(trip);
    const rate = Number(vehicle?.dailyRate || 0);
    return { days, rate, total: days * rate, deposit: Number(vehicle?.depositAmount || 0) };
  }

  function validateContact(values) {
    const errors = {};
    const text = (key) => String(values[key] || "").trim();
    if (!text("customerName") || text("customerName").length > 160) errors.customerName = "Enter your full name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text("customerEmail"))) errors.customerEmail = "Enter a valid email address.";
    const digits = text("customerPhone").replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15 || !/^\+?[\d\s().-]+$/.test(text("customerPhone"))) errors.customerPhone = "Enter a mobile number we can text.";
    if (text("notes").length > 1000) errors.notes = "Keep notes under 1,000 characters.";
    if (!values.agree) errors.agree = "Please confirm you'll bring your license and insurance.";
    return errors;
  }

  // 32 random bytes, base64url: the private code that unlocks the reservation page.
  function newAccessToken(randomBytes) {
    const bytes = randomBytes(32);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const b64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64");
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  // A private access token (43 base64url chars) or a short-lived lookup grant (g.ID.EXPIRY.SIGNATURE).
  const validToken = (value) => /^[A-Za-z0-9_-]{43}$/.test(String(value || "")) || /^g\.\d{1,12}\.\d{1,12}\.[A-Za-z0-9_-]{32}$/.test(String(value || ""));
  const isGrant = (value) => /^g\./.test(String(value || ""));
  function tokenFromInput(value) {
    const text = String(value || "").trim();
    const fromLink = /[#&]t=([A-Za-z0-9_.-]+)/.exec(text);
    if (fromLink && validToken(fromLink[1])) return fromLink[1];
    return validToken(text) ? text : "";
  }
  function validateLookup(values) {
    const errors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(values.email || "").trim())) errors.email = "Enter the email address you reserved with.";
    const digits = String(values.phone || "").replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) errors.phone = "Enter the mobile number you reserved with.";
    return errors;
  }

  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function formatTime(time) {
    const m = minutes(time); if (m == null) return "";
    const h = Math.floor(m / 60);
    return `${(h % 12) || 12}:${pad(m % 60)} ${h < 12 ? "AM" : "PM"}`;
  }
  function formatDay(date) {
    const value = parseDate(date); if (!value) return "";
    return `${WEEKDAYS[value.getUTCDay()]}, ${MONTHS[value.getUTCMonth()]} ${value.getUTCDate()}`;
  }
  function formatInstant(iso) {
    if (!iso) return "";
    const value = new Date(iso); if (Number.isNaN(+value)) return "";
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(value).map((part) => [part.type, part.value]));
    return `${formatDay(`${parts.year}-${parts.month}-${parts.day}`)} · ${formatTime(`${parts.hour}:${parts.minute}`)}`;
  }

  function statusText(status) {
    return ({
      PENDING_REQUEST: { title: "Request received", body: "We're checking the vehicle and will text you once it's confirmed." },
      CONFIRMED: { title: "Confirmed", body: "Your vehicle is reserved. See you at pickup." },
      READY_FOR_PICKUP: { title: "Ready for pickup", body: "Your vehicle is ready. Come to the counter at your pickup time." },
      CHECKED_OUT: { title: "On the road", body: "Return the vehicle to the counter by your return time." },
      RETURNED_PENDING_INSPECTION: { title: "Returned", body: "Thanks! We're checking the vehicle in." },
      COMPLETED: { title: "Rental complete", body: "Thanks for renting with Trucker Heaven." },
      DECLINED: { title: "Not available", body: "Sorry, that vehicle isn't available for those dates. Call us and we'll find another option." },
      CANCELLED: { title: "Cancelled", body: "This reservation was cancelled. Nothing was charged." },
      NO_SHOW: { title: "Missed pickup", body: "We didn't see you at pickup. Call us if you still need a vehicle." }
    })[status] || { title: String(status || "").replace(/_/g, " ").toLowerCase(), body: "" };
  }

  // Server validation codes -> the form field to highlight.
  const FIELD_FOR_CODE = Object.freeze({
    INVALID_CUSTOMER_NAME: "customerName", INVALID_EMAIL: "customerEmail", INVALID_PHONE: "customerPhone",
    INVALID_NOTES: "notes", PICKUP_IN_PAST: "pickupTime", INVALID_PICKUP_TIME: "pickupDate", INVALID_RETURN_TIME: "returnDate",
    RENTAL_DURATION_EXCEEDED: "returnDate"
  });
  const fieldForError = (error) => FIELD_FOR_CODE[error?.code] || null;

  return {
    fieldForError,
    TIME_ZONE, MAX_DAYS, OFFICE_HOURS, SORTS, money, lotNow, addDays, hoursBetween, isSunday, counterTimes, defaultTrip, rentalDays,
    validateTrip, tripQuery, hasFilters, filterFleet, seatOptions, parseRoute, routeHash, estimate, validateContact, validateLookup, newAccessToken, validToken, isGrant, tokenFromInput,
    formatTime, formatDay, formatInstant, statusText
  };
});
