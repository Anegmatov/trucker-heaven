/* Trucker Heaven Rentals: customer page. Browse → car → dates → details → confirmed. Pay at the counter. */
(() => {
  "use strict";

  const C = window.RentalsCore;
  const cfg = window.DriveOpsConfig || {};
  const API = (cfg.API_BASE || "").replace(/\/$/, "");
  const PARENT = (cfg.PARENT_SITE_URL || "https://truckerheaven.com").replace(/\/$/, "");
  const PHONE = "+16154705075";
  const PHONE_TEXT = "615-470-5075";
  const ADDRESS = "8037 Eastgate Blvd, Mt. Juliet, TN 37122";
  const DIRECTIONS = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ADDRESS)}`;
  const STORE_SAVED = "th-rentals-reservations";
  const STORE_CONTACT = "th-rentals-contact";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

  const NO_FILTERS = Object.freeze({ q: "", category: "", seats: "", maxRate: "", sort: "" });
  const state = { trip: C.defaultTrip(), datesChosen: false, vehicles: null, fleetKey: "", filters: NO_FILTERS, fleetLoading: null, current: null, token: "", justRequested: false, submitting: false };

  const store = {
    get(key, fallback) { try { const raw = window.localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; } },
    set(key, value) { try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* private mode */ } }
  };
  const saved = () => (store.get(STORE_SAVED, []) || []).filter((item) => C.validToken(item?.t) && !C.isGrant(item.t));
  function saveReservation(token, info) {
    if (C.isGrant(token)) return; // grants expire; only the private link is worth keeping
    const list = saved().filter((item) => item.t !== token);
    list.unshift({ t: token, ...info, saved: Date.now() });
    store.set(STORE_SAVED, list.slice(0, 8));
  }
  const forget = (token) => store.set(STORE_SAVED, saved().filter((item) => item.t !== token));

  // ---------- API ----------
  async function api(path, { method = "GET", body, headers = {} } = {}) {
    if (!API) throw { code: "NOT_CONFIGURED", message: "Online reservations are unavailable right now. Please call the office." };
    let response;
    try {
      response = await fetch(`${API}${path}`, { method, credentials: "omit", cache: "no-store", headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    } catch (_) { throw { code: "NETWORK", message: "We couldn't reach the reservation system. Check your connection and try again." }; }
    let data = {};
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok) throw { code: data.code || `HTTP_${response.status}`, message: data.error || "Something went wrong. Please try again.", status: response.status };
    return data;
  }
  const FRIENDLY = {
    RESERVATION_ACCESS_INVALID: "That link has expired or isn't valid. Find your rental with your email and phone instead.",
    INVALID_RESERVATION_ACCESS: "That link has expired or isn't valid. Find your rental with your email and phone instead.",
    CUSTOMER_CANCELLATION_NOT_ELIGIBLE: "This reservation can't be cancelled online anymore. Please call the office.",
    RESERVATION_STATE_CONFLICT: "This reservation just changed. We loaded the latest details.",
    PICKUP_IN_PAST: "That pickup time has passed. Choose a later time.",
    RENTAL_DURATION_EXCEEDED: `Rentals are up to ${C.MAX_DAYS} days. Call us for longer rentals.`,
    INVALID_PHONE: "Enter a mobile number we can text.",
    INVALID_EMAIL: "Enter a valid email address.",
    INVALID_LOOKUP: "Enter the email address and mobile number you reserved with.",
    INVALID_VEHICLE_ID: "That car link isn't valid. Go back and pick a car from the list."
  };
  const friendly = (error) => FRIENDLY[error?.code] || (error?.status === 404 ? "This car isn't listed anymore. Pick another car from the list." : error?.status === 409 ? "That car was just booked for those dates. Pick different dates or another car." : error?.status === 429 ? "Too many tries. Please wait a few minutes and try again." : error?.message) || "Something went wrong. Please try again.";

  // ---------- helpers ----------
  function toast(message) {
    const el = $("#toast"); el.textContent = message; el.hidden = false; el.classList.add("show");
    clearTimeout(toast.t); toast.t = setTimeout(() => { el.classList.remove("show"); setTimeout(() => { el.hidden = true; }, 250); }, 2200);
  }
  const showError = (el, message) => { el.textContent = message || ""; el.hidden = !message; };
  function setBusy(button, busy, label) {
    if (busy) { button.dataset.label = button.textContent; button.textContent = label; button.disabled = true; button.classList.add("is-busy"); }
    else { if (button.dataset.label) button.textContent = button.dataset.label; button.disabled = false; button.classList.remove("is-busy"); }
  }
  const loading = (text) => `<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span>${esc(text)}</div>`;
  const vehicleName = (v) => [v.year, v.make, v.model].filter(Boolean).join(" ");
  const photoUrl = (url) => { if (!url) return ""; try { return new URL(url, API || window.location.href).href; } catch (_) { return ""; } };
  const miles = (v) => (Number(v.mileage) > 0 ? `${Number(v.mileage).toLocaleString("en-US")} miles` : "");
  const specLine = (v) => [v.seats ? `${v.seats} seats` : "", String(v.transmission || "").toLowerCase(), miles(v), String(v.color || "").toLowerCase()].filter(Boolean).join(" · ");
  const depositLabel = (v) => (Number(v.depositAmount) > 0 ? `${C.money(v.depositAmount, { whole: true })} refundable deposit at pickup` : "No deposit");

  // Until a real photo is uploaded in the staff site, a licensed stock photo of a similar model stands in.
  function stockFor(category) {
    const c = String(category || "").toLowerCase();
    if (c.includes("van")) return "van";
    if (c.includes("pickup") || c.includes("truck")) return "pickup";
    if (c.includes("suv") || c.includes("crossover")) return "suv";
    return "sedan";
  }
  function vehiclePhotos(v) {
    const real = (v.photos || []).map((p) => photoUrl(p.imageUrl)).filter(Boolean);
    const primary = photoUrl(v.primaryPhotoUrl);
    if (primary && !real.includes(primary)) real.unshift(primary);
    return real.length ? { urls: real, stock: false } : { urls: [`./assets/photos/${stockFor(v.category)}.jpg`], stock: true };
  }
  const similarTag = (stock) => (stock ? `<span class="similar">Similar vehicle shown</span>` : "");

  // Dates and filters live in the address so reload, back and shared links keep them.
  const homeHash = () => C.routeHash("/", state.datesChosen ? state.trip : null, state.filters);
  const vehicleHash = (id) => C.routeHash(`/v/${encodeURIComponent(id)}`, state.trip);
  const detailsHash = (id) => C.routeHash(`/v/${encodeURIComponent(id)}/details`, state.trip);
  const keepUrl = (hash) => { if (window.location.hash !== hash) window.history.replaceState(null, "", hash); };
  function fillTimes(select, value) {
    select.innerHTML = C.counterTimes().map((t) => `<option value="${t}"${t === value ? " selected" : ""}>${C.formatTime(t)}</option>`).join("");
  }
  function readTrip(form) {
    return { pickupDate: form.querySelector("[name=pickupDate]").value, pickupTime: form.querySelector("[name=pickupTime]").value,
      returnDate: form.querySelector("[name=returnDate]").value, returnTime: form.querySelector("[name=returnTime]").value };
  }
  function tripLabel(trip) {
    const days = C.rentalDays(trip);
    return `${C.formatDay(trip.pickupDate)} ${C.formatTime(trip.pickupTime)} → ${C.formatDay(trip.returnDate)} ${C.formatTime(trip.returnTime)} · ${days} ${days === 1 ? "day" : "days"}`;
  }

  // ---------- the date widget ----------
  function writeTrip() {
    $("#pickupDate").value = state.trip.pickupDate; $("#returnDate").value = state.trip.returnDate;
    fillTimes($("#pickupTime"), state.trip.pickupTime); fillTimes($("#returnTime"), state.trip.returnTime);
    const today = C.lotNow().date;
    $("#pickupDate").min = today; $("#returnDate").min = state.trip.pickupDate || today;
    $("#searchNote").textContent = state.datesChosen ? tripLabel(state.trip) : `Counter open ${C.OFFICE_HOURS}`;
  }
  function onSearch(event) {
    event.preventDefault();
    const trip = readTrip($("#searchForm"));
    const errors = C.validateTrip(trip);
    const first = Object.entries(errors)[0];
    $$("#searchForm [aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
    if (first) { showError($("#searchError"), first[1]); $(`#${first[0]}`)?.setAttribute("aria-invalid", "true"); return; }
    showError($("#searchError"), "");
    state.trip = trip; state.datesChosen = true;
    writeTrip(); keepUrl(homeHash());
    loadFleet().then(() => $("#cars").scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  // ---------- fleet ----------
  // Without dates: every listed car with its daily rate. With dates: only the cars free then, priced for the trip.
  async function loadFleet() {
    const key = state.datesChosen ? C.tripQuery(state.trip) : "";
    if (state.fleetLoading && state.fleetLoading.key === key) return state.fleetLoading;
    $("#fleet").innerHTML = loading(key ? "Checking what's free for your dates…" : "Loading our cars…");
    const run = (async () => {
      try {
        const { vehicles } = await api(`/api/public/vehicles${key ? `?${key}` : ""}`);
        if (state.fleetLoading !== run) return;
        state.vehicles = vehicles || []; state.fleetKey = key;
        renderFleet();
      } catch (error) {
        if (state.fleetLoading !== run) return;
        $("#fleet").innerHTML = `<div class="empty"><h3>We couldn't load our cars</h3><p>${esc(friendly(error))}</p><div class="btn-row"><button class="btn small" type="button" data-retry-fleet>Try again</button><a class="btn small quiet" href="tel:${PHONE}">Call ${PHONE_TEXT}</a></div></div>`;
      } finally { if (state.fleetLoading === run) state.fleetLoading = null; }
    })();
    run.key = key; state.fleetLoading = run;
    return run;
  }
  function writeFilters() {
    const { filters, vehicles } = state;
    $("#filters").hidden = vehicles.length < 4 && !C.hasFilters(filters);
    $("#fSeats").innerHTML = `<option value="">Any</option>${C.seatOptions(vehicles, filters.seats).map((n) => `<option value="${n}">${n}+ seats</option>`).join("")}`;
    $("#fQuery").value = filters.q; $("#fSeats").value = filters.seats; $("#fMaxRate").value = filters.maxRate; $("#fSort").value = filters.sort;
    $("#clearFilters").disabled = !C.hasFilters(filters);
  }
  function setFilters(filters) {
    state.filters = { ...state.filters, ...filters };
    renderFleet();
    keepUrl(homeHash());
  }
  function renderFleet() {
    const all = state.vehicles || [];
    const categories = [...new Set(all.map((v) => v.category).filter(Boolean))].sort();
    $("#categoryChips").innerHTML = categories.length > 1 ? ["", ...categories].map((c) => `<button type="button" class="chip" data-category="${esc(c)}" aria-pressed="${state.filters.category === c}">${esc(c || "All")}</button>`).join("") : "";
    writeFilters();
    const list = C.filterFleet(all, state.filters);
    const fleet = $("#fleet");
    fleet.classList.toggle("few", list.length > 0 && list.length <= 2);
    const dated = state.datesChosen && state.fleetKey === C.tripQuery(state.trip);
    $("#fleetTitle").textContent = dated ? (all.length === 1 ? "Available for your dates" : `${all.length} available for your dates`) : (all.length === 1 ? "Our car" : "Our cars");
    $("#fleetNote").textContent = dated ? `${tripLabel(state.trip)}. Prices are for the whole rental.` : list.length === all.length ? "Pick a car, then choose your dates." : `${list.length} of ${all.length} match your filters.`;
    if (!all.length) {
      fleet.innerHTML = dated
        ? `<div class="empty"><h3>Nothing free for those dates</h3><p>Try different dates, or call us and we'll find you something.</p><div class="btn-row"><a class="btn small" href="#searchForm">Change dates</a><a class="btn small quiet" href="tel:${PHONE}">Call ${PHONE_TEXT}</a></div></div>`
        : `<div class="empty"><h3>Nothing listed right now</h3><p>Call us and we'll tell you what's on the lot.</p><a class="btn small" href="tel:${PHONE}">Call ${PHONE_TEXT}</a></div>`;
      return;
    }
    if (!list.length) {
      fleet.innerHTML = `<div class="empty"><h3>No cars match your filters</h3><p>${all.length} ${all.length === 1 ? "car is" : "cars are"} listed. Clear the filters to see them.</p><button class="btn small quiet" type="button" data-clear-filters>Clear filters</button></div>`;
      return;
    }
    fleet.innerHTML = list.map((v) => {
      const photos = vehiclePhotos(v);
      const est = dated ? C.estimate(v, state.trip) : null;
      const includes = [v.seats ? `${v.seats} seats` : "", v.transmission || "", v.fuelType || "", Number(v.depositAmount) > 0 ? `${C.money(v.depositAmount, { whole: true })} refundable deposit` : "No deposit"].filter(Boolean);
      return `<a class="vcard" href="${vehicleHash(v.id)}">
        <div class="vcard-img"><span class="type">${esc(v.category || "Car")}</span><img src="${esc(photos.urls[0])}" alt="${esc(vehicleName(v))}" loading="lazy">${similarTag(photos.stock)}</div>
        <div class="vcard-body">
          <h3>${esc(vehicleName(v))}</h3>
          <p class="specs">${esc([String(v.color || ""), miles(v)].filter(Boolean).join(" · "))}</p>
          <div class="includes">${includes.map((i) => `<span>${esc(i)}</span>`).join("")}</div>
          <div class="vcard-price"><b>${C.money(v.dailyRate, { whole: true })} <span>/ day</span></b><span class="est">${est ? `${C.money(est.total, { whole: true })} for ${est.days} ${est.days === 1 ? "day" : "days"}` : "Pay at pickup"}</span></div>
          <span class="btn primary vcard-cta">${dated ? "Reserve for these dates" : "Reserve this car"}</span>
        </div>
      </a>`;
    }).join("");
  }

  // ---------- vehicle: pick your dates ----------
  async function loadVehicle(id) {
    let vehicle = (state.vehicles || []).find((v) => String(v.id) === String(id));
    try { vehicle = (await api(`/api/public/vehicles/${encodeURIComponent(id)}`)).vehicle; }
    catch (error) { if (!vehicle || error.status === 404) throw error; }
    return vehicle;
  }
  // true: free for the trip, false: booked then, null: couldn't tell (the request itself will check).
  async function isFree(id, trip) {
    try { await api(`/api/public/vehicles/${encodeURIComponent(id)}?${C.tripQuery(trip)}`); return true; }
    catch (error) { return error.status === 404 ? false : null; }
  }
  const crumbs = (step, id) => `<div class="crumbs"><a class="back" href="${homeHash()}">‹ All cars</a><span class="sep">|</span>
    <span class="${step > 1 ? "done" : "now"}">${step > 1 ? "✓ " : ""}Car</span><span class="sep">›</span>
    <span class="${step > 2 ? "done" : step === 2 ? "now" : ""}">${step > 2 ? "✓ " : ""}Dates</span><span class="sep">›</span>
    <span class="${step === 3 ? "now" : ""}">Your details</span><span class="sep">›</span><span>Confirmed</span></div>`;

  async function showVehicle(id) {
    const body = $("#vehicleBody");
    body.innerHTML = loading("Loading the car…");
    let vehicle;
    try { vehicle = await loadVehicle(id); }
    catch (error) { body.innerHTML = `<div class="empty" style="margin-top:28px"><h2>Car not found</h2><p>${esc(friendly(error))}</p><a class="btn small" href="${homeHash()}">See all cars</a></div>`; return; }
    const photos = vehiclePhotos(vehicle);
    body.innerHTML = `
      ${crumbs(2, vehicle.id)}
      <div class="vgrid">
          <div class="gallery">
            <div class="gallery-main"><img id="mainPhoto" src="${esc(photos.urls[0])}" alt="${esc(vehicleName(vehicle))}">${similarTag(photos.stock)}</div>
            ${photos.urls.length > 1 ? `<div class="thumbs">${photos.urls.map((p, i) => `<button type="button" data-photo="${esc(p)}" aria-pressed="${i === 0}" aria-label="Photo ${i + 1}"><img src="${esc(p)}" alt="" loading="lazy"></button>`).join("")}</div>` : ""}
          </div>
          <section class="vinfo">
            <p class="kicker">${esc([vehicle.category || "Car", vehicle.color].filter(Boolean).join(" · "))}</p>
            <h1>${esc(vehicleName(vehicle))}</h1>
            <p class="vsub">Pick up at ${esc(vehicle.locationName || "Trucker Heaven")}, ${esc(ADDRESS)}</p>
            <dl class="spec-grid">
              ${[["Seats", vehicle.seats], ["Transmission", vehicle.transmission], ["Fuel", vehicle.fuelType], ["Mileage", miles(vehicle)], ["Deposit", Number(vehicle.depositAmount) > 0 ? `${C.money(vehicle.depositAmount, { whole: true })}, refundable` : "None"], ["Counter hours", C.OFFICE_HOURS]].filter(([, v]) => v).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}
            </dl>
            <div class="bring"><h3>Bring to pickup</h3><ul><li>Valid driver license</li><li>Proof of insurance</li><li>Card or cash for the rental and the refundable deposit</li></ul></div>
          </section>
        <form class="book" id="tripForm" method="post" novalidate>
          <h2>${state.datesChosen ? "Your dates" : "Pick your dates"}</h2>
          <div class="row2"><div class="field"><label for="rqPickupDate">Pickup</label><input id="rqPickupDate" name="pickupDate" type="date" value="${esc(state.trip.pickupDate)}" min="${esc(C.lotNow().date)}"></div><div class="field"><label for="rqPickupTime">Time</label><select id="rqPickupTime" name="pickupTime"></select></div></div>
          <div class="row2"><div class="field"><label for="rqReturnDate">Return</label><input id="rqReturnDate" name="returnDate" type="date" value="${esc(state.trip.returnDate)}" min="${esc(C.lotNow().date)}"></div><div class="field"><label for="rqReturnTime">Time</label><select id="rqReturnTime" name="returnTime"></select></div></div>
          <p class="field-error" id="rqTripError" role="alert" hidden></p>
          <div class="avail checking" id="availability" role="status"></div>
          <div class="notice" id="unavailable" role="status" hidden><b>Not available for these dates</b><p>This car is already booked then. Change the dates, or call us and we'll find you something.</p></div>
          <div class="price" id="priceBox"></div>
          <button class="btn primary block" type="submit" id="continueButton">Continue to your details</button>
          <p class="note">No payment now. We text you to confirm, and you pay when you pick up.<br>Questions? <a href="tel:${PHONE}">Call ${PHONE_TEXT}</a></p>
        </form>
      </div>`;
    fillTimes($("#rqPickupTime"), state.trip.pickupTime); fillTimes($("#rqReturnTime"), state.trip.returnTime);
    const form = $("#tripForm");
    let checked = "";
    const update = async () => {
      const trip = readTrip(form);
      const first = Object.values(C.validateTrip(trip))[0];
      showError($("#rqTripError"), first || "");
      const est = C.estimate(vehicle, trip);
      const deposit = est.deposit ? `<div class="sub"><span>Refundable deposit at pickup</span><span>${C.money(est.deposit, { whole: true })}</span></div>` : "";
      $("#priceBox").innerHTML = first
        ? `<div><span>Daily rate</span><span>${C.money(vehicle.dailyRate, { whole: true })}</span></div>${deposit}`
        : `<div><span>${C.money(vehicle.dailyRate, { whole: true })} × ${est.days} ${est.days === 1 ? "day" : "days"}</span><span>${C.money(est.total, { whole: true })}</span></div>${deposit}<div class="total"><span>Due at the counter</span><b>${C.money(est.total, { whole: true })}</b></div><p class="sub">Estimate. Taxes, fuel or extra miles, if any, are settled at pickup.</p>`;
      const key = first ? "" : C.tripQuery(trip);
      if (key === checked) return;
      checked = key;
      const avail = $("#availability");
      if (!key) { avail.hidden = true; $("#unavailable").hidden = true; $("#continueButton").disabled = true; return; }
      state.trip = trip; state.datesChosen = true; keepUrl(vehicleHash(vehicle.id));
      avail.hidden = false; avail.className = "avail checking"; avail.textContent = "Checking these dates…";
      const free = await isFree(vehicle.id, trip);
      if (key !== checked) return;
      if (free === false) { avail.hidden = true; $("#unavailable").hidden = false; $("#continueButton").disabled = true; return; }
      $("#unavailable").hidden = true; $("#continueButton").disabled = false;
      avail.className = "avail"; avail.innerHTML = `<svg class="ico" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>${free ? "Available for these dates" : "We'll confirm availability by text"}`;
    };
    form.addEventListener("input", update);
    form.addEventListener("change", (event) => {
      if (event.target.name === "pickupDate" && form.querySelector("[name=returnDate]").value <= event.target.value) form.querySelector("[name=returnDate]").value = C.addDays(event.target.value, 1);
      update();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const trip = readTrip(form);
      const errors = C.validateTrip(trip);
      if (Object.keys(errors).length) { showError($("#rqTripError"), Object.values(errors)[0]); return; }
      state.trip = trip; state.datesChosen = true;
      window.location.hash = detailsHash(vehicle.id);
    });
    update();
  }

  // ---------- details: who's renting ----------
  async function showDetails(id) {
    const body = $("#detailsBody");
    body.innerHTML = loading("One moment…");
    let vehicle;
    try { vehicle = await loadVehicle(id); }
    catch (error) { body.innerHTML = `<div class="empty" style="margin-top:28px"><h2>Car not found</h2><p>${esc(friendly(error))}</p><a class="btn small" href="${homeHash()}">See all cars</a></div>`; return; }
    if (Object.keys(C.validateTrip(state.trip)).length) { window.location.replace(vehicleHash(vehicle.id)); return; }
    const contact = store.get(STORE_CONTACT, {}) || {};
    const est = C.estimate(vehicle, state.trip);
    body.innerHTML = `
      ${crumbs(3, vehicle.id)}
      <div class="narrow" style="width:min(100%,760px);margin:0">
        <div class="summary">
          <div><b>${esc(vehicleName(vehicle))}</b><p>${esc(tripLabel(state.trip))}</p></div>
          <a class="edit" href="${vehicleHash(vehicle.id)}">Change</a>
          <div><p>${C.money(vehicle.dailyRate, { whole: true })} × ${est.days} ${est.days === 1 ? "day" : "days"}${est.deposit ? ` + ${C.money(est.deposit, { whole: true })} refundable deposit` : ""}</p></div>
          <div><b>${C.money(est.total, { whole: true })}</b></div>
        </div>
        <form class="panel" id="requestForm" method="post" novalidate>
          <h2>Your details</h2>
          <div class="field"><label for="customerName">Full name</label><input id="customerName" name="customerName" autocomplete="name" maxlength="160" value="${esc(contact.customerName || "")}"></div>
          <div class="field"><label for="customerPhone">Mobile phone</label><input id="customerPhone" name="customerPhone" type="tel" inputmode="tel" autocomplete="tel" maxlength="40" value="${esc(contact.customerPhone || "")}"></div>
          <div class="field"><label for="customerEmail">Email</label><input id="customerEmail" name="customerEmail" type="email" inputmode="email" autocomplete="email" maxlength="160" value="${esc(contact.customerEmail || "")}"></div>
          <div class="field"><label for="notes">Anything we should know? <span class="opt">(optional)</span></label><textarea id="notes" name="notes" rows="2" maxlength="1000" placeholder="Where you're headed, questions…"></textarea></div>
          <label class="check"><input type="checkbox" name="agree" id="agree"> <span>I'll bring my driver license and proof of insurance, and sign the rental agreement at pickup.</span></label>
          <label class="check"><input type="checkbox" name="remember" id="remember" checked> <span>Remember me on this device</span></label>
          <p class="field-error" id="requestError" role="alert" hidden></p>
          <button class="btn primary block" type="submit" id="requestButton">Reserve this car</button>
          <p class="muted small center">No payment now. We text you to confirm, and you pay at the counter.</p>
        </form>
      </div>`;
    const form = $("#requestForm");
    form.addEventListener("submit", (event) => submitRequest(event, vehicle));
    $("#customerName").focus({ preventScroll: true });
  }

  function fieldErrors(form, errors) {
    $$(".field-error[data-for]", form).forEach((el) => el.remove());
    $$("[aria-invalid]", form).forEach((el) => el.removeAttribute("aria-invalid"));
    let first = null;
    for (const [field, message] of Object.entries(errors)) {
      const input = form.querySelector(`[name="${field}"]`);
      if (!input) continue;
      input.setAttribute("aria-invalid", "true");
      const note = document.createElement("p");
      note.className = "field-error"; note.dataset.for = field; note.id = `${field}-err`; note.textContent = message;
      input.setAttribute("aria-describedby", note.id);
      (input.closest(".field") || input.closest(".check")).after(note);
      first = first || input;
    }
    first?.focus();
  }

  async function submitRequest(event, vehicle) {
    event.preventDefault();
    if (state.submitting) return;
    const form = event.currentTarget;
    const trip = state.trip;
    const data = new FormData(form);
    const values = { customerName: data.get("customerName"), customerEmail: data.get("customerEmail"), customerPhone: data.get("customerPhone"), notes: data.get("notes"), agree: data.get("agree") === "on" };
    const errors = C.validateContact(values);
    if (Object.keys(errors).length) { fieldErrors(form, errors); return; }
    fieldErrors(form, {});
    const button = $("#requestButton");
    state.submitting = true; setBusy(button, true, "Sending…"); showError($("#requestError"), "");
    form.dataset.key = form.dataset.key || `rq-${C.newAccessToken((n) => crypto.getRandomValues(new Uint8Array(n))).slice(0, 32)}`;
    form.dataset.token = form.dataset.token || C.newAccessToken((n) => crypto.getRandomValues(new Uint8Array(n)));
    try {
      await api("/api/reservations", {
        method: "POST",
        headers: { "Idempotency-Key": form.dataset.key, "X-Reservation-Access-Token": form.dataset.token },
        body: { vehicleId: vehicle.id, customerName: values.customerName.trim(), customerEmail: values.customerEmail.trim(), customerPhone: values.customerPhone.trim(), notes: String(values.notes || "").trim(), pickupAt: `${trip.pickupDate}T${trip.pickupTime}`, returnAt: `${trip.returnDate}T${trip.returnTime}` }
      });
      if (data.get("remember") === "on") {
        store.set(STORE_CONTACT, { customerName: values.customerName.trim(), customerEmail: values.customerEmail.trim(), customerPhone: values.customerPhone.trim() });
        saveReservation(form.dataset.token, { vehicle: vehicleName(vehicle), pickupAt: `${trip.pickupDate}T${trip.pickupTime}` });
      }
      state.justRequested = true;
      window.location.hash = `#t=${form.dataset.token}`;
    } catch (error) {
      if (error.code === "IDEMPOTENCY_CONFLICT") { delete form.dataset.key; delete form.dataset.token; }
      const field = C.fieldForError(error);
      if (field && form.querySelector(`[name="${field}"]`)) fieldErrors(form, { [field]: friendly(error) });
      else if (["PICKUP_IN_PAST", "INVALID_PICKUP_TIME", "INVALID_RETURN_TIME", "RENTAL_DURATION_EXCEEDED"].includes(error.code) || error.status === 409) showError($("#requestError"), `${friendly(error)} Go back to change your dates.`);
      else showError($("#requestError"), friendly(error));
    } finally { state.submitting = false; setBusy(button, false); }
  }

  // ---------- reservation ----------
  async function showReservation(token) {
    const body = $("#reservationBody");
    body.innerHTML = loading("Loading your reservation…");
    try {
      const { reservation } = await api("/api/public/reservation-access", { headers: { "X-Reservation-Access-Token": token } });
      state.current = reservation; state.token = token;
      renderReservation();
    } catch (error) {
      if (C.isGrant(token) || error.status === 401) forget(token);
      body.innerHTML = `<div class="panel" style="margin-top:28px"><h2>Reservation not found</h2><p class="muted">${esc(friendly(error))}</p><div class="btn-row"><a class="btn small primary" href="#find">Find my rental</a><a class="btn small quiet" href="tel:${PHONE}">Call ${PHONE_TEXT}</a></div></div>`;
    }
  }
  function renderReservation() {
    const r = state.current; const token = state.token;
    const fresh = state.justRequested; state.justRequested = false;
    const info = C.statusText(r.status);
    const p = r.payment || {};
    const live = !["DECLINED", "CANCELLED", "NO_SHOW", "COMPLETED"].includes(r.status);
    const link = `${window.location.origin}${window.location.pathname}#t=${token}`;
    const isSaved = saved().some((item) => item.t === token);
    $("#reservationBody").innerHTML = `
      ${fresh ? `<div class="success"><p class="kicker">Request sent</p><h1>We've got it.</h1><p>We'll text you once it's confirmed, usually within the hour during business hours.</p></div>` : `<h1 class="page-title">Your reservation</h1>`}
      <div class="panel ticket">
        <div class="ticket-top"><div><span class="label">Reservation</span><strong class="resnum">${esc(r.reservationNumber)}</strong></div><span class="status s-${esc(String(r.status).toLowerCase())}">${esc(info.title)}</span></div>
        <p class="status-body">${esc(info.body)}</p>
        <dl class="facts">
          <div><dt>Car</dt><dd>${esc(r.vehicle?.description || "Rental car")}</dd></div>
          <div><dt>Name</dt><dd>${esc(r.customerName || "")}</dd></div>
          <div><dt>Pickup</dt><dd>${esc(C.formatInstant(r.pickupAt))}</dd></div>
          <div><dt>Return</dt><dd>${esc(C.formatInstant(r.returnAt))}</dd></div>
          <div><dt>Where</dt><dd>${esc(r.pickupLocation || "Trucker Heaven, Mt. Juliet")}</dd></div>
        </dl>
        <div class="pay-box"><svg class="ico" aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h3"/></svg><div>
          ${p.status === "PAID" ? `<b>Paid in full.</b> ${C.money(p.paid)} received.` : `<b>Pay at the counter.</b> ${p.paid > 0 ? `${C.money(p.paid)} paid, ${C.money(p.amountDue)} left.` : `Estimated ${C.money(p.total ?? p.amountDue)}`}${p.depositDue > 0 && !["COMPLETED", "CANCELLED", "DECLINED"].includes(r.status) ? ` plus a ${C.money(p.depositDue)} refundable deposit.` : "."}`}
        </div></div>
      </div>
      ${live ? `<div class="panel"><h2>Bring to the counter</h2><ul class="bring-list" style="margin:0;padding-left:20px">${(r.bringToCounter || []).map((item) => `<li>${esc(item)}</li>`).join("")}</ul>
        <div class="btn-row"><a class="btn small" href="${DIRECTIONS}" target="_blank" rel="noopener">Directions</a><a class="btn small quiet" href="tel:${PHONE}">Call ${PHONE_TEXT}</a><button type="button" class="btn small quiet noarrow" data-ics>Add to calendar</button></div></div>` : ""}
      ${C.isGrant(token) ? `<div class="panel"><h2>Next time</h2><p class="muted">Find this reservation again any time with your email and phone, or use the link from your confirmation text.</p><div class="btn-row"><a class="btn small quiet" href="#find">My rental</a><a class="btn small quiet" href="#/">Browse cars</a></div></div>`
        : `<div class="panel"><h2>Keep this page</h2><p class="muted">This page is your private reservation link. Bookmark it or copy the link.</p>
        <div class="btn-row"><button type="button" class="btn small quiet noarrow" data-copy="${esc(link)}">Copy link</button>
        ${isSaved ? `<button type="button" class="btn small quiet noarrow" data-forget>Remove from this device</button>` : `<button type="button" class="btn small quiet noarrow" data-save>Save on this device</button>`}
        <a class="btn small quiet" href="#/">Browse cars</a></div></div>`}
      ${r.cancellationEligible ? `<div class="panel"><h2>Need to cancel?</h2><p class="muted">You can cancel online until pickup. Nothing has been charged.</p>
        <div><button type="button" class="btn small danger noarrow" data-cancel-open>Cancel reservation</button></div>
        <div class="cancel-confirm" hidden><p>Cancel ${esc(r.vehicle?.description || "this rental")}?</p><p class="field-error" id="cancelError" role="alert" hidden></p>
        <div class="btn-row"><button type="button" class="btn small danger noarrow" data-cancel-confirm>Yes, cancel it</button><button type="button" class="btn small quiet noarrow" data-cancel-close>Keep it</button></div></div></div>`
        : live ? `<div class="panel"><h2>Need to cancel or change it?</h2><p class="muted">This rental can't be cancelled online anymore. Call the office to cancel or change it.</p>
        <div class="btn-row"><a class="btn small quiet" href="tel:${PHONE}">Call ${PHONE_TEXT}</a></div></div>` : ""}`;
    $("#main").focus({ preventScroll: true });
  }
  async function cancelReservation(button) {
    setBusy(button, true, "Cancelling…");
    try {
      const { reservation } = await api("/api/public/reservation-access/cancel", { method: "POST", headers: { "X-Reservation-Access-Token": state.token }, body: { expectedStatusVersion: state.current.statusVersion } });
      state.current = reservation; renderReservation(); toast("Reservation cancelled");
    } catch (error) {
      if (error.code === "RESERVATION_STATE_CONFLICT") { await showReservation(state.token); toast(friendly(error)); return; }
      setBusy(button, false); showError($("#cancelError"), friendly(error));
    }
  }
  function icsFor(r) {
    const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const line = (text) => String(text || "").replace(/[\\;,]/g, (ch) => `\\${ch}`);
    return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Trucker Heaven//Rentals//EN", "BEGIN:VEVENT",
      `UID:${r.reservationNumber}@rentals.truckerheaven.com`, `DTSTAMP:${stamp(new Date().toISOString())}`,
      `DTSTART:${stamp(r.pickupAt)}`, `DTEND:${stamp(new Date(new Date(r.pickupAt).getTime() + 1800000).toISOString())}`,
      `SUMMARY:${line(`Pick up rental: ${r.vehicle?.description || "car"}`)}`, `LOCATION:${line(ADDRESS)}`,
      `DESCRIPTION:${line(`Reservation ${r.reservationNumber}. Bring your driver license and insurance. Return by ${C.formatInstant(r.returnAt)}. ${PHONE_TEXT}`)}`,
      "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  }

  // ---------- find: email + phone ----------
  function renderSaved() {
    const list = saved();
    $("#savedCard").hidden = !list.length;
    $("#savedList").innerHTML = list.map((item) => `<li><a href="#t=${esc(item.t)}"><b>${esc(item.vehicle || "Rental")}</b><span>${esc(item.pickupAt ? `Pickup ${C.formatDay(item.pickupAt.slice(0, 10))} ${C.formatTime(item.pickupAt.slice(11, 16))}` : "")}</span></a></li>`).join("");
  }
  async function onFind(event) {
    event.preventDefault();
    const form = $("#findForm");
    const values = { email: $("#findEmail").value, phone: $("#findPhone").value };
    const errors = C.validateLookup(values);
    if (Object.keys(errors).length) { fieldErrors(form, errors); return; }
    fieldErrors(form, {});
    const button = $("#findButton");
    setBusy(button, true, "Looking…"); showError($("#findError"), ""); $("#foundCard").hidden = true;
    try {
      const { reservations } = await api("/api/public/reservation-access/find", { method: "POST", body: { email: values.email.trim(), phone: values.phone.trim() } });
      if (!reservations.length) { showError($("#findError"), "We couldn't find a reservation with that email and phone. Check them, or call us and we'll look it up."); return; }
      if (reservations.length === 1) { window.location.hash = `#t=${reservations[0].accessGrant}`; return; }
      $("#foundList").innerHTML = reservations.map((r) => `<li><a href="#t=${esc(r.accessGrant)}"><b>${esc(r.vehicle?.description || "Rental")}</b><span class="status s-${esc(String(r.status).toLowerCase())}">${esc(C.statusText(r.status).title)}</span><span>Pickup ${esc(C.formatInstant(r.pickupAt))}</span></a></li>`).join("");
      $("#foundCard").hidden = false;
      $("#foundCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (error) { showError($("#findError"), friendly(error)); }
    finally { setBusy(button, false); }
  }

  // ---------- routing ----------
  function route() {
    const r = C.parseRoute(window.location.hash);
    if (r.trip && !Object.keys(C.validateTrip(r.trip)).length) { state.trip = r.trip; state.datesChosen = true; }
    if (r.view === "home" && r.hasParams) state.filters = { ...NO_FILTERS, ...r.filters };
    $$(".view").forEach((el) => { el.hidden = el.dataset.view !== r.view; });
    $("#siteHeader").classList.toggle("is-inner", r.view !== "home");
    closeMenu();
    $$("[data-nav]").forEach((a) => a.classList.toggle("is-active", a.dataset.nav === r.view || (r.view === "reservation" && a.dataset.nav === "find")));
    if (!(r.view === "home" && ["#cars", "#searchForm"].includes(window.location.hash))) window.scrollTo(0, 0);
    if (r.view === "reservation") showReservation(r.token);
    if (r.view === "vehicle") { keepUrl(vehicleHash(r.id)); showVehicle(r.id); }
    if (r.view === "details") { keepUrl(detailsHash(r.id)); showDetails(r.id); }
    if (r.view === "find") { renderSaved(); $("#foundCard").hidden = true; }
    if (r.view === "home") { writeTrip(); keepUrl(homeHash()); const key = state.datesChosen ? C.tripQuery(state.trip) : ""; if (state.vehicles && state.fleetKey === key) renderFleet(); else loadFleet(); }
    document.title = r.view === "home" ? "Car Rentals in Mt. Juliet, TN | Trucker Heaven" : r.view === "find" ? "My rental | Trucker Heaven" : r.view === "reservation" ? "Your reservation | Trucker Heaven" : r.view === "details" ? "Your details | Trucker Heaven" : "Reserve a car | Trucker Heaven";
  }

  // the main site's header: transparent over the hero, solid once you scroll or leave the home view
  function closeMenu() {
    const menu = $("#mobileMenu"), toggle = $("#menuToggle");
    if (!menu || menu.hidden) return;
    menu.hidden = true; toggle.setAttribute("aria-expanded", "false"); $("#siteHeader").classList.remove("is-menu-open");
  }
  function bindHeader() {
    const header = $("#siteHeader"), menu = $("#mobileMenu"), toggle = $("#menuToggle");
    const onScroll = () => header.classList.toggle("is-scrolled", window.scrollY > 12);
    window.addEventListener("scroll", onScroll, { passive: true }); onScroll();
    toggle.addEventListener("click", () => {
      const open = menu.hidden;
      menu.hidden = !open; toggle.setAttribute("aria-expanded", String(open)); header.classList.toggle("is-menu-open", open);
    });
    menu.addEventListener("click", (event) => { if (event.target.closest("a")) closeMenu(); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeMenu(); });
    const year = $("#footerYear"); if (year) year.textContent = String(new Date().getFullYear());
  }

  function bind() {
    bindHeader();
    $$("[data-phone-link]").forEach((a) => { a.href = `tel:${PHONE}`; });
    $$("[data-phone-text]").forEach((el) => { el.textContent = PHONE_TEXT; });
    $$("[data-office-hours]").forEach((el) => { el.textContent = C.OFFICE_HOURS; });
    $$("[data-office-address]").forEach((el) => { el.textContent = ADDRESS; });
    $$("[data-directions]").forEach((a) => { a.href = DIRECTIONS; });
    $$("[data-parent-link]").forEach((a) => { a.href = `${PARENT}${a.dataset.parentLink}`; });
    $("#fSort").innerHTML = Object.entries(C.SORTS).map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join("");
    $("#searchForm").addEventListener("submit", onSearch);
    $("#searchForm").addEventListener("change", (event) => {
      if (event.target.id === "pickupDate" && $("#returnDate").value <= event.target.value) $("#returnDate").value = C.addDays(event.target.value, 1);
      $("#returnDate").min = $("#pickupDate").value;
    });
    $("#findForm").addEventListener("submit", onFind);
    $("#filters").addEventListener("submit", (event) => event.preventDefault());
    $("#filters").addEventListener("input", () => setFilters({ q: $("#fQuery").value, seats: $("#fSeats").value, maxRate: $("#fMaxRate").value, sort: $("#fSort").value }));
    // A photo that fails to load falls back to the stock photo for its type.
    document.addEventListener("error", (event) => {
      const img = event.target;
      if (img instanceof HTMLImageElement && img.closest(".vcard-img, .gallery-main, .thumbs") && !img.dataset.fallback) { img.dataset.fallback = "1"; img.src = "./assets/photos/sedan.jpg"; }
    }, true);
    document.addEventListener("click", (event) => {
      const target = event.target.closest("button, a");
      if (!target) return;
      if (target.dataset.category !== undefined) { setFilters({ category: target.dataset.category }); return; }
      if (target.hasAttribute("data-clear-filters")) { setFilters(NO_FILTERS); return; }
      if (target.hasAttribute("data-retry-fleet")) { loadFleet(); return; }
      if (target.dataset.photo) { const main = $("#mainPhoto"); if (main) main.src = target.dataset.photo; $$(".thumbs button").forEach((b) => b.setAttribute("aria-pressed", String(b === target))); return; }
      if (target.dataset.copy) { navigator.clipboard?.writeText(target.dataset.copy).then(() => toast("Link copied"), () => toast("Press and hold to copy")); return; }
      if (target.hasAttribute("data-save")) { saveReservation(state.token, { vehicle: state.current.vehicle?.description, pickupAt: "" }); renderReservation(); toast("Saved on this device"); return; }
      if (target.hasAttribute("data-forget")) { forget(state.token); renderReservation(); toast("Removed from this device"); return; }
      if (target.hasAttribute("data-ics")) {
        const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([icsFor(state.current)], { type: "text/calendar" }));
        a.download = `${state.current.reservationNumber}.ics`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); return;
      }
      if (target.hasAttribute("data-cancel-open")) { target.hidden = true; $(".cancel-confirm").hidden = false; return; }
      if (target.hasAttribute("data-cancel-close")) { $(".cancel-confirm").hidden = true; $("[data-cancel-open]").hidden = false; return; }
      if (target.hasAttribute("data-cancel-confirm")) cancelReservation(target);
    });
    window.addEventListener("hashchange", () => {
      if (window.location.hash === "#cars" || window.location.hash === "#searchForm") { $(window.location.hash)?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
      route();
    });
  }

  if (!API) { const b = $("#systemBanner"); b.textContent = `Online reservations are unavailable right now. Call ${PHONE_TEXT} to reserve.`; b.hidden = false; }
  bind();
  writeTrip();
  route();
})();
