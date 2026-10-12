const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const C = require("../rentals-core.js");

const now = new Date("2026-10-07T15:00:00Z"); // Wed 10:00 AM in Mt. Juliet

test("rental days round partial days up, like the server estimate", () => {
  assert.equal(C.rentalDays({ pickupDate: "2026-10-08", pickupTime: "09:00", returnDate: "2026-10-09", returnTime: "09:00" }), 1);
  assert.equal(C.rentalDays({ pickupDate: "2026-10-08", pickupTime: "09:00", returnDate: "2026-10-09", returnTime: "10:00" }), 2);
  assert.equal(C.estimate({ dailyRate: 79, depositAmount: 200 }, { pickupDate: "2026-10-08", pickupTime: "09:00", returnDate: "2026-10-11", returnTime: "09:00" }).total, 237);
});

test("trip validation blocks Sundays, past times, reversed dates and long rentals", () => {
  const ok = { pickupDate: "2026-10-08", pickupTime: "09:00", returnDate: "2026-10-10", returnTime: "09:00" };
  assert.deepEqual(C.validateTrip(ok, now), {});
  assert.ok(C.validateTrip({ ...ok, pickupDate: "2026-10-11" }, now).pickupDate, "Sunday");
  assert.ok(C.validateTrip({ ...ok, pickupDate: "2026-10-07", pickupTime: "08:00" }, now).pickupTime, "past");
  assert.ok(C.validateTrip({ ...ok, returnDate: "2026-10-07" }, now).returnDate, "reversed");
  assert.ok(C.validateTrip({ ...ok, returnDate: "2026-11-20" }, now).returnDate, "too long");
});

test("default trip skips Sunday and the counter is open 8 AM to 6 PM", () => {
  const trip = C.defaultTrip(new Date("2026-10-10T15:00:00Z")); // Saturday
  assert.equal(trip.pickupDate, "2026-10-12");
  assert.equal(C.counterTimes()[0], "08:00");
  assert.equal(C.counterTimes().at(-1), "18:00");
});

test("access codes are 43-character base64url and can be read from a pasted link", () => {
  const token = C.newAccessToken((n) => crypto.randomBytes(n));
  assert.ok(C.validToken(token));
  assert.equal(C.tokenFromInput(`https://rentals.truckerheaven.com/#t=${token}`), token);
  assert.equal(C.tokenFromInput("nope"), "");
});

test("contact validation requires a textable phone and the counter acknowledgement", () => {
  const good = { customerName: "Sam", customerEmail: "sam@example.test", customerPhone: "(615) 555-0142", agree: true };
  assert.deepEqual(C.validateContact(good), {});
  assert.ok(C.validateContact({ ...good, customerPhone: "555" }).customerPhone);
  assert.ok(C.validateContact({ ...good, agree: false }).agree);
});

const fleet = [
  { id: 1, year: 2021, make: "Ford", model: "Transit", category: "Van", seats: 12, transmission: "Automatic", fuelType: "Gasoline", dailyRate: 129, locationName: "Mt. Juliet lot" },
  { id: 2, year: 2024, make: "Toyota", model: "Camry", category: "Sedan", seats: 5, transmission: "Automatic", fuelType: "Hybrid", dailyRate: 69 },
  { id: 3, year: 2019, make: "Ram", model: "1500", category: "Pickup", seats: 5, transmission: "Automatic", fuelType: "Diesel", dailyRate: 99 }
];
const ids = (list) => list.map((v) => v.id);

test("fleet filters match text, category, seats and max rate", () => {
  assert.deepEqual(ids(C.filterFleet(fleet, {})), [1, 2, 3]);
  assert.deepEqual(ids(C.filterFleet(fleet, { q: "ford VAN" })), [1]);
  assert.deepEqual(ids(C.filterFleet(fleet, { q: "hybrid" })), [2]);
  assert.deepEqual(ids(C.filterFleet(fleet, { q: "juliet" })), [1]);
  assert.deepEqual(ids(C.filterFleet(fleet, { category: "Pickup" })), [3]);
  assert.deepEqual(ids(C.filterFleet(fleet, { seats: "6" })), [1]);
  assert.deepEqual(ids(C.filterFleet(fleet, { maxRate: "99" })), [2, 3]);
  assert.deepEqual(ids(C.filterFleet(fleet, { q: "tesla" })), []);
  assert.deepEqual(C.seatOptions(fleet), [5, 12]);
  assert.deepEqual(C.seatOptions(fleet, "7"), [5, 7, 12]);
  assert.equal(C.hasFilters({ q: "", sort: "" }), false);
  assert.equal(C.hasFilters({ sort: "price-asc" }), true);
});

test("fleet sort keeps the server order for Recommended and never mutates the input", () => {
  assert.deepEqual(ids(C.filterFleet(fleet, { sort: "price-asc" })), [2, 3, 1]);
  assert.deepEqual(ids(C.filterFleet(fleet, { sort: "price-desc" })), [1, 3, 2]);
  assert.deepEqual(ids(C.filterFleet(fleet, { sort: "year-desc" })), [2, 1, 3]);
  assert.deepEqual(ids(C.filterFleet(fleet, { sort: "" })), [1, 2, 3]);
  assert.deepEqual(ids(fleet), [1, 2, 3]);
});

test("hash routes carry trip dates and filters, and old links still resolve", () => {
  const trip = { pickupDate: "2026-10-12", pickupTime: "09:00", returnDate: "2026-10-14", returnTime: "17:30" };
  const hash = C.routeHash("/", trip, { q: "ford van", seats: "5", sort: "price-asc", category: "" });
  assert.equal(hash, "#/?pickupAt=2026-10-12T09:00&returnAt=2026-10-14T17:30&q=ford+van&seats=5&sort=price-asc");
  const home = C.parseRoute(hash);
  assert.equal(home.view, "home");
  assert.deepEqual(home.trip, trip);
  assert.deepEqual(home.filters, { q: "ford van", category: "", seats: "5", maxRate: "", sort: "price-asc" });
  const vehicle = C.parseRoute(C.routeHash("/v/7", trip));
  assert.equal(vehicle.view, "vehicle"); assert.equal(vehicle.id, "7"); assert.deepEqual(vehicle.trip, trip);
  const token = "a".repeat(43);
  assert.deepEqual([C.parseRoute(`#t=${token}`).view, C.parseRoute(`#t=${token}`).token], ["reservation", token]);
  assert.equal(C.parseRoute("#find").view, "find");
  assert.equal(C.parseRoute("").view, "home");
  assert.equal(C.parseRoute("#/").hasParams, false);
  assert.equal(C.parseRoute("#/?pickupAt=2026-10-12T03:00&returnAt=2026-10-13T09:00").trip, null, "outside counter hours");
  assert.equal(C.parseRoute("#/?sort=constructor").filters.sort, "");
});

test("office hours come from the counter clock", () => {
  assert.equal(C.OFFICE_HOURS, "Mon–Sat, 8 AM–6 PM");
});
