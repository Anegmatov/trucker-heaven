const DEFAULT_API_BASE = window.DriveOpsAdminConfig?.API_BASE || "https://rentals-api.truckerheaven.com";
const OFFICE_LOCATION = "Trucker Heaven Rentals - Mt. Juliet";
const { accessBadge, canConfigure, canMutate, failureBehavior, reservationActions } = window.AdminWorkflowPolicy;

const state = {
  vehicles: [],
  reservations: [],
  users: [],
  foodOrders: [],
  foodMenu: [],
  currentView: "dashboard",
  apiBase: DEFAULT_API_BASE,
  csrfToken: "",
  user: null,
  vehicleSubmitting: false,
  pendingMutations: new Set(),
  openReservationId: null
};

const views = {
  dashboard: document.querySelector("#dashboardView"),
  fleet: document.querySelector("#fleetView"),
  reservations: document.querySelector("#reservationsView"),
  settings: document.querySelector("#settingsView"),
  employees: document.querySelector("#employeesView"),
  food: document.querySelector("#foodView")
};

const titles = {
  dashboard: ["Rental operations", "Today at a glance"],
  fleet: ["Fleet", "Vehicle inventory"],
  reservations: ["Reservation desk", "Rental requests and handoffs"],
  settings: ["Connection", "Admin settings"],
  employees: ["Employee access", "Employee accounts"],
  food: ["Food desk", "Pay-at-pickup orders"]
};

const vehicleStatuses = ["READY", "MAINTENANCE", "OUT_OF_SERVICE", "RETIRED"];
const reservationStatuses = {
  pending: "PENDING_REQUEST",
  confirmed: "CONFIRMED",
  readyForPickup: "READY_FOR_PICKUP",
  declined: "DECLINED",
  cancelled: "CANCELLED",
  checkedOut: "CHECKED_OUT",
  returnedPendingInspection: "RETURNED_PENDING_INSPECTION",
  completed: "COMPLETED",
  noShow: "NO_SHOW"
};

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function currency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(Number(value || 0));
}

function mileage(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function apiUrl(path) {
  return `${state.apiBase.replace(/\/$/, "")}${path}`;
}

function normalizeReservationStatus(status) {
  const value = String(status || "").trim().toUpperCase();
  const map = {
    PENDING: reservationStatuses.pending,
    PENDING_REQUEST: reservationStatuses.pending,
    APPROVED: reservationStatuses.confirmed,
    RESERVED: reservationStatuses.confirmed,
    CONFIRMED: reservationStatuses.confirmed,
    READY_FOR_PICKUP: reservationStatuses.readyForPickup,
    REJECTED: reservationStatuses.declined,
    DECLINED: reservationStatuses.declined,
    CANCELLED: reservationStatuses.cancelled,
    ACTIVE: reservationStatuses.checkedOut,
    RENTED: reservationStatuses.checkedOut,
    CHECKED_OUT: reservationStatuses.checkedOut,
    RETURNED_PENDING_INSPECTION: reservationStatuses.returnedPendingInspection,
    CLOSED: reservationStatuses.completed,
    COMPLETED: reservationStatuses.completed,
    NO_SHOW: reservationStatuses.noShow
  };

  return map[value] || value || reservationStatuses.pending;
}

function statusClass(status) {
  return String(status || "inactive").toLowerCase().replaceAll("_", "-");
}

function displayStatus(status) {
  return String(status || "Unknown")
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function getVehicleId(vehicle) {
  return vehicle?.id ?? vehicle?.vehicleId ?? vehicle?.VehicleID ?? null;
}

function getVehicleTitle(vehicle) {
  return [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ").trim();
}

function normalizePhoto(photo) {
  if (!photo) return null;
  if (typeof photo === "string") return photo.trim() ? { imageUrl: photo.trim(), isPrimary: false, sortOrder: 9999 } : null;

  const imageUrl = photo.imageUrl || photo.url || photo.photoUrl || photo.primaryPhotoUrl || null;
  if (!imageUrl) return null;

  return {
    ...photo,
    imageUrl,
    isPrimary: Boolean(photo.isPrimary || photo.primary),
    sortOrder: Number.isFinite(Number(photo.sortOrder)) ? Number(photo.sortOrder) : 9999
  };
}

function getVehiclePhotos(vehicle) {
  const results = [];
  const seen = new Set();

  function push(photo) {
    const normalized = normalizePhoto(photo);
    if (!normalized || seen.has(normalized.imageUrl)) return;
    seen.add(normalized.imageUrl);
    results.push(normalized);
  }

  push({ imageUrl: vehicle?.primaryPhotoUrl, isPrimary: true, sortOrder: -1 });
  push({ imageUrl: vehicle?.imageUrl, isPrimary: true, sortOrder: -1 });
  push({ imageUrl: vehicle?.photoUrl, isPrimary: true, sortOrder: -1 });

  if (Array.isArray(vehicle?.photos)) vehicle.photos.forEach(push);
  if (Array.isArray(vehicle?.images)) vehicle.images.forEach(push);

  return results.sort((left, right) => {
    if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
    return left.sortOrder - right.sortOrder;
  });
}

function getPrimaryPhoto(vehicle) {
  const photos = getVehiclePhotos(vehicle);
  return photos.find((photo) => photo.isPrimary) || photos[0] || null;
}

function formatLabel(key) {
  const labels = {
    id: "ID",
    vehicleId: "Vehicle ID",
    vin: "VIN",
    dailyRate: "Daily Rate",
    depositAmount: "Deposit",
    plateNumber: "License Plate",
    fuelType: "Fuel Type",
    locationName: "Location",
    createdAt: "Created At",
    updatedAt: "Updated At",
    smsStatus: "SMS Status",
    smsLog: "SMS Log"
  };

  if (labels[key]) return labels[key];

  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatValue(value, key = "") {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && /(rate|price|deposit|amount)/i.test(key)) return currency(value);
  if (typeof value === "number" && /(mileage|odometer)/i.test(key)) return `${mileage(value)} mi`;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map((item) => (typeof item === "object" ? "" : String(item))).filter(Boolean).join(", ");
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function toast(message, type = "success") {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast show ${type}`;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => {
    element.className = "toast";
  }, 3400);
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (!["GET", "HEAD"].includes(String(options.method || "GET").toUpperCase()) && state.csrfToken) {
    headers["x-csrf-token"] = state.csrfToken;
  }

  const response = await fetch(apiUrl(path), {
    ...options,
    headers,
    credentials: "include"
  });
  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      throw new Error(`API returned an invalid response (HTTP ${response.status}). Check the API base URL.`);
    }
  }

  if (!response.ok) {
    if (response.status === 401 && !options.allowUnauthorized) showLogin();
    const error = new Error(payload?.error || `Request failed with ${response.status}`);
    error.status = response.status;
    error.code = payload?.code || "";
    throw error;
  }

  return payload;
}

function showLogin(message = "") {
  state.user = null;
  state.csrfToken = "";
  state.vehicles = [];
  state.reservations = [];
  state.users = [];
  state.pendingMutations.clear();
  $("#adminShell").hidden = true;
  $("#loginGate").hidden = false;
  $("#loginError").textContent = message;
  $("#loginPassword").value = "";
  $("#authenticatedUser").textContent = "";
  $("#authenticatedRole").textContent = "";
  $("#readOnlyBadge").hidden = true;
  renderAll();
}

function showAdmin(session) {
  state.user = session.user;
  state.csrfToken = session.csrfToken || state.csrfToken;
  const role = String(state.user?.role || "").toUpperCase();
  const badge = accessBadge(role);
  $("#authenticatedUser").textContent = state.user?.email || "Authenticated employee";
  $("#authenticatedRole").textContent = role || "Unknown role";
  $("#readOnlyBadge").textContent = badge.label;
  $("#readOnlyBadge").classList.toggle("read-only-pill", badge.readOnly);
  $("#readOnlyBadge").hidden = false;
  $("#vehicleForm").hidden = !canConfigure(role);
  document.querySelector('[data-view="employees"]').hidden = role !== "OWNER";
  document.querySelector('[data-view="settings"]').hidden = role !== "OWNER";
  $("#foodOwnerTools").hidden = role !== "OWNER";
  $("#loginGate").hidden = true;
  $("#adminShell").hidden = false;
}

async function submitLogin(event) {
  event.preventDefault();
  $("#loginError").textContent = "";
  try {
    const session = await request("/api/admin/auth/login", { method: "POST", allowUnauthorized: true, body: JSON.stringify({ email: $("#loginEmail").value.trim(), password: $("#loginPassword").value }) });
    showAdmin(session);
    await refreshData();
  } catch (error) { $("#loginError").textContent = error.message; }
}

async function restoreSession() {
  try {
    const session = await request("/api/admin/auth/session", { allowUnauthorized: true });
    showAdmin(session);
    await refreshData();
  } catch (_error) { showLogin(); }
}

async function logout() {
  try { await request("/api/admin/auth/logout", { method: "POST" }); } catch (_error) { /* session expiry is equivalent to logout */ }
  showLogin();
}

function photoMarkup(vehicle) {
  const photo = getPrimaryPhoto(vehicle);
  const title = getVehicleTitle(vehicle) || "Vehicle";

  if (photo?.imageUrl) {
    return `<img src="${escapeHtml(photo.imageUrl)}" alt="${escapeHtml(title)}" loading="lazy" />`;
  }

  return `<span>${escapeHtml(vehicle.category || "Vehicle")}</span>`;
}

function isEmptyValue(value) {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function detailGroupForKey(key) {
  const normalized = key.toLowerCase();

  if (["dailyrate", "depositamount", "deposit", "price", "rate"].some((term) => normalized.includes(term))) {
    return "Pricing";
  }

  if (["category", "seats", "transmission", "fuel", "mileage", "color", "year", "make", "model"].some((term) => normalized.includes(term))) {
    return "Specs";
  }

  if (["status", "available", "location", "sms"].some((term) => normalized.includes(term))) {
    return "Availability";
  }

  if (["id", "vin", "plate", "created", "updated", "notes", "photo", "image"].some((term) => normalized.includes(term))) {
    return "Admin/Internal";
  }

  return "Vehicle";
}

function renderPhotoGallery(vehicle) {
  const photos = getVehiclePhotos(vehicle);

  if (photos.length === 0) {
    return `
      <section class="details-group">
        <h3>Photos</h3>
        <div class="photo-empty">No photos uploaded</div>
      </section>
    `;
  }

  return `
    <section class="details-group">
      <h3>Photos</h3>
      <div class="details-photo-grid">
        ${photos
          .map(
            (photo, index) => `
              <figure class="details-photo-card">
                <img src="${escapeHtml(photo.imageUrl)}" alt="${escapeHtml(`${getVehicleTitle(vehicle) || "Vehicle"} photo ${index + 1}`)}" loading="lazy" />
                <figcaption>
                  <strong>${photo.isPrimary ? "Primary photo" : `Photo ${index + 1}`}</strong>
                  <span>${escapeHtml(photo.storageKey || "Public rental photo")}</span>
                </figcaption>
              </figure>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderVehicleDetails(vehicle) {
  const groups = new Map([
    ["Vehicle", []],
    ["Pricing", []],
    ["Specs", []],
    ["Availability", []],
    ["Admin/Internal", []]
  ]);

  Object.entries(vehicle).forEach(([key, value]) => {
    if (isEmptyValue(value) || key === "photos") return;
    const group = detailGroupForKey(key);
    groups.get(group).push({
      label: formatLabel(key),
      value: formatValue(value, key)
    });
  });

  const renderedGroups = [...groups.entries()]
    .filter(([, items]) => items.length > 0)
    .map(
      ([group, items]) => `
        <section class="details-group">
          <h3>${escapeHtml(group)}</h3>
          <dl>
            ${items
              .map(
                (item) => `
                  <div>
                    <dt>${escapeHtml(item.label)}</dt>
                    <dd>${escapeHtml(item.value)}</dd>
                  </div>
                `
              )
              .join("")}
          </dl>
        </section>
      `
    )
    .join("");

  return `
    ${renderPhotoGallery(vehicle)}
    ${renderedGroups || `
      <div class="empty-state compact">
        <strong>No extra details available</strong>
        <span>This vehicle does not include additional fields yet.</span>
      </div>
    `}
  `;
}

function openVehicleDetails(vehicleId) {
  const vehicle = state.vehicles.find((item) => Number(getVehicleId(item)) === Number(vehicleId));
  if (!vehicle) return;

  $("#detailsTitle").textContent = getVehicleTitle(vehicle) || "Vehicle details";
  $("#detailsContent").innerHTML = renderVehicleDetails(vehicle);
  $("#detailsDialog").showModal();
}

function closeVehicleDetails() {
  $("#detailsDialog").close();
}

function setView(view) {
  state.currentView = view;
  Object.entries(views).forEach(([name, element]) => {
    element.classList.toggle("active", name === view);
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  const [eyebrow, title] = titles[view] || titles.dashboard;
  $("#pageEyebrow").textContent = eyebrow;
  $("#pageTitle").textContent = title;
}

function renderMetrics() {
  const count = (statusList) => state.vehicles.filter((vehicle) => statusList.includes(vehicle.status)).length;
  $("#metricTotal").textContent = state.vehicles.length;
  $("#metricAvailable").textContent = count(["READY"]);
  $("#metricBusy").textContent = count(["OUT_OF_SERVICE"]);
  $("#metricService").textContent = count(["MAINTENANCE"]);
  $("#metricReservations").textContent = state.reservations.length;

  $("#statusBoard").innerHTML = vehicleStatuses
    .map((status) => {
      const vehicles = state.vehicles.filter((vehicle) => vehicle.status === status);
      return `
        <article>
          <span class="status-pill ${statusClass(status)}">${escapeHtml(displayStatus(status))}</span>
          <strong>${vehicles.length}</strong>
          <small>${vehicles.slice(0, 3).map(getVehicleTitle).filter(Boolean).join(", ") || "No vehicles"}</small>
        </article>
      `;
    })
    .join("");
}

function renderReservationQueue() {
  const queue = state.reservations
    .filter((reservation) => normalizeReservationStatus(reservation.Status) === reservationStatuses.pending)
    .slice(0, 5);
  const element = $("#reservationQueue");

  if (queue.length === 0) {
    element.innerHTML = $("#emptyTemplate").innerHTML;
    return;
  }

  element.innerHTML = queue
    .map(
      (reservation) => `
        <article class="queue-card">
          <div>
            <strong>${escapeHtml(reservation.CustomerName)}</strong>
            <span>${escapeHtml(`${reservation.Year || ""} ${reservation.Make || ""} ${reservation.Model || ""}`.trim())}</span>
            <span>${escapeHtml(formatDate(reservation.PickupAt))} → ${escapeHtml(formatDate(reservation.ReturnAt))}</span>
          </div>
          <div class="queue-actions">
            <span class="status-pill ${statusClass(normalizeReservationStatus(reservation.Status))}">${escapeHtml(displayStatus(normalizeReservationStatus(reservation.Status)))}</span>
            <span class="request-number-small">${escapeHtml(reservation.RequestNumber || "")}</span>
            ${renderReservationActions(reservation)}
          </div>
        </article>
      `
    )
    .join("");
}

function filteredFleet() {
  const search = $("#fleetSearch").value.trim().toLowerCase();
  const status = $("#statusFilter").value;

  return state.vehicles.filter((vehicle) => {
    const haystack = [
      vehicle.make,
      vehicle.model,
      vehicle.year,
      vehicle.plateNumber,
      vehicle.category,
      vehicle.color,
      vehicle.status
    ]
      .join(" ")
      .toLowerCase();

    if (search && !haystack.includes(search)) return false;
    if (status && vehicle.status !== status) return false;
    return true;
  });
}

function renderFleet() {
  const vehicles = filteredFleet();
  const board = $("#fleetBoard");

  if (vehicles.length === 0) {
    board.innerHTML = $("#emptyTemplate").innerHTML;
    return;
  }

  board.innerHTML = vehicles
    .map((vehicle) => {
      const photos = getVehiclePhotos(vehicle);
      const mayMutate = canConfigure(state.user?.role);
      return `
        <article class="fleet-card">
          <div class="fleet-photo">${photoMarkup(vehicle)}</div>
          <div class="fleet-main">
            <div class="fleet-title">
              <div>
                <strong>${escapeHtml(getVehicleTitle(vehicle) || "Vehicle")}</strong>
                <span>${escapeHtml(vehicle.plateNumber || "No plate")} · ${escapeHtml(vehicle.category || "Uncategorized")}</span>
              </div>
              <span class="status-pill ${statusClass(vehicle.status)}">${escapeHtml(displayStatus(vehicle.status))}</span>
            </div>
            <div class="fleet-stats">
              <span>${currency(vehicle.dailyRate)}/day</span>
              <span>${currency(vehicle.depositAmount)} deposit</span>
              <span>${mileage(vehicle.mileage)} mi</span>
              <span>${escapeHtml(vehicle.transmission || "Automatic")}</span>
            </div>
            <div class="photo-strip">
              ${photos
                .slice(0, 5)
                .map((photo) => `<img src="${escapeHtml(photo.imageUrl)}" alt="${escapeHtml(getVehicleTitle(vehicle) || "Vehicle")} photo" loading="lazy" />`)
                .join("")}
              ${photos.length === 0 ? "<span>No photos uploaded</span>" : ""}
            </div>
            ${mayMutate ? `<div class="fleet-status-row">
              <label>
                Status
                <select data-vehicle-status="${escapeHtml(String(getVehicleId(vehicle)))}">
                  ${vehicleStatuses
                    .map(
                      (status) => `
                        <option value="${escapeHtml(status)}" ${status === vehicle.status ? "selected" : ""}>
                          ${escapeHtml(status)}
                        </option>
                      `
                    )
                    .join("")}
                </select>
              </label>
              <button class="button small ghost" type="button" data-save-status="${escapeHtml(String(getVehicleId(vehicle)))}">
                Save status
              </button>
            </div>` : ""}
            <div class="fleet-actions">
              ${mayMutate ? `<button class="button small secondary" type="button" data-edit="${escapeHtml(String(getVehicleId(vehicle)))}">Edit</button>` : ""}
              <button class="button small secondary" type="button" data-details="${escapeHtml(String(getVehicleId(vehicle)))}">More details</button>
              ${mayMutate ? `<button class="button small ghost" type="button" data-upload="${escapeHtml(String(getVehicleId(vehicle)))}">Upload photos</button>
              <button class="button small danger" type="button" data-delete="${escapeHtml(String(getVehicleId(vehicle)))}">Retire</button>` : ""}
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function renderReservationActions(reservation) {
  const status = normalizeReservationStatus(reservation.Status);
  const availableActions = reservationActions(status, state.user?.role);
  if (availableActions.length === 0) {
    return `<span class="reservation-actions-muted">${canMutate(state.user?.role) ? "No actions" : "Read-only access"}</span>`;
  }
  const labels = {
    CONFIRMED: "Confirm",
    READY_FOR_PICKUP: "Ready for pickup",
    DECLINED: "Decline",
    CHECKED_OUT: "Mark checked out",
    RETURNED_PENDING_INSPECTION: "Mark returned",
    CANCELLED: "Cancel",
    COMPLETED: "Complete",
    NO_SHOW: "Mark no-show"
  };
  const classes = { CONFIRMED: "primary", DECLINED: "secondary", READY_FOR_PICKUP: "primary", CHECKED_OUT: "ghost", RETURNED_PENDING_INSPECTION: "ghost", CANCELLED: "secondary", COMPLETED: "ghost", NO_SHOW: "danger" };
  return `<div class="reservation-actions">${availableActions.map((nextStatus) => {
    const key = String(reservation.ReservationID);
    const requiredType = nextStatus === reservationStatuses.checkedOut ? "PICKUP" : nextStatus === reservationStatuses.completed ? "RETURN" : "";
    const inspectionMissing = requiredType && !getInspection(reservation, requiredType);
    return `<button class="button small ${classes[nextStatus]}" type="button" data-reservation-id="${escapeHtml(String(reservation.ReservationID))}" data-reservation-status="${escapeHtml(nextStatus)}" ${state.pendingMutations.has(key) || inspectionMissing ? "disabled" : ""} ${inspectionMissing ? `title="${requiredType === "PICKUP" ? "Complete pickup inspection first" : "Complete return inspection first"}"` : ""}>${escapeHtml(labels[nextStatus])}</button>`;
  }).join("")}</div>`;
}

function getInspection(reservation, inspectionType) {
  return (Array.isArray(reservation.Inspections) ? reservation.Inspections : []).find((inspection) => inspection.inspectionType === inspectionType) || null;
}

function inspectionSummary(inspection) {
  return `<div class="inspection-summary"><strong>${escapeHtml(inspection.inspectionType)} inspection complete</strong><span>${escapeHtml(String(inspection.odometer))} mi · ${escapeHtml(String(inspection.fuelLevelPercent))}% fuel · ${inspection.damageObserved ? "Damage observed" : "No damage observed"}</span><span>Keys: ${escapeHtml(String(inspection.keysCount))}${inspection.damageNotes ? ` · ${escapeHtml(inspection.damageNotes)}` : ""}</span><span>Completed by ${escapeHtml(inspection.completedBy || "Staff")} · ${escapeHtml(formatDate(inspection.completedAt))}</span></div>`;
}

function inspectionForm(reservation, inspectionType) {
  const kind = inspectionType.toLowerCase();
  const formId = `inspection-${reservation.ReservationID}-${kind}`;
  const pending = state.pendingMutations.has(`inspection:${reservation.ReservationID}:${inspectionType}`);
  return `<form class="inspection-form" id="${formId}" data-inspection-form data-inspection-type="${kind}" data-reservation-id="${reservation.ReservationID}">
    <strong>${kind === "pickup" ? "Pickup inspection" : "Return inspection"}</strong>
    <div class="form-grid compact"><label>Odometer<input name="odometer" type="number" min="0" step="1" required /></label><label>Fuel level (%)<input name="fuelLevelPercent" type="number" min="0" max="100" step="1" required /></label><label>Keys count<input name="keysCount" type="number" min="0" max="20" step="1" required /></label></div>
    <label class="inspection-check"><input name="damageObserved" type="checkbox" /> Damage observed</label><label>Damage notes<textarea name="damageNotes" rows="2" maxlength="1000"></textarea></label><label>Cleanliness notes<textarea name="cleanlinessNotes" rows="2" maxlength="1000"></textarea></label><label>Accessories notes<textarea name="accessoriesNotes" rows="2" maxlength="1000"></textarea></label>
    ${kind === "return" ? `<label class="inspection-check"><input name="allExpectedKeysReturned" type="checkbox" /> All expected keys returned</label><label class="inspection-check"><input name="accessoriesReturned" type="checkbox" /> Accessories returned</label>` : ""}
    <button class="button small primary" type="button" data-inspection-submit="${kind}" data-reservation-id="${reservation.ReservationID}" ${pending ? "disabled aria-busy=\"true\"" : ""}>${pending ? "Saving…" : "Complete inspection"}</button>
  </form>`;
}

function renderInspections(reservation) {
  const pickup = getInspection(reservation, "PICKUP");
  const returned = getInspection(reservation, "RETURN");
  const status = normalizeReservationStatus(reservation.Status);
  const mayMutate = canMutate(state.user?.role);
  const pendingForm = status === reservationStatuses.readyForPickup && !pickup ? (mayMutate ? inspectionForm(reservation, "PICKUP") : "<span class=\"reservation-actions-muted\">Pickup inspection requires Owner or Staff access</span>") : "";
  const returnForm = status === reservationStatuses.returnedPendingInspection && !returned ? (mayMutate ? inspectionForm(reservation, "RETURN") : "<span class=\"reservation-actions-muted\">Return inspection requires Owner or Staff access</span>") : "";
  if (!pickup && !returned && !pendingForm && !returnForm) return "";
  return `<section class="inspection-section">${pickup ? inspectionSummary(pickup) : ""}${returned ? inspectionSummary(returned) : ""}${pendingForm}${returnForm}</section>`;
}

const centsMoney = (cents) => currency(Number(cents || 0) / 100);
const PAYMENT_KIND_LABELS = { PAYMENT: "Payment", REFUND: "Refund", DEPOSIT: "Deposit taken", DEPOSIT_REFUND: "Deposit returned" };
const METHOD_LABELS = { CASH: "Cash", CARD: "Card", CLOVER: "Clover", CHECK: "Check", OTHER: "Other" };

function moneyCell(reservation) {
  const ledger = reservation.Counter?.ledger;
  if (!ledger) return `<strong>${escapeHtml(currency(reservation.EstimatedTotal))}</strong><span>Estimate</span>`;
  const status = normalizeReservationStatus(reservation.Status);
  if (["DECLINED", "CANCELLED"].includes(status) && !ledger.paidCents) return "<span>—</span>";
  if (ledger.settled && ledger.paidCents > 0) return `<strong>${escapeHtml(centsMoney(ledger.totalCents))}</strong><span class="money-ok">Paid</span>`;
  return `<strong>${escapeHtml(centsMoney(ledger.balanceCents))}</strong><span>${ledger.paidCents ? `due · ${escapeHtml(centsMoney(ledger.paidCents))} paid` : "due at pickup"}</span>`;
}

function renderReservations() {
  const element = $("#reservationTable");
  if (state.reservations.length === 0) { element.innerHTML = $("#emptyTemplate").innerHTML; return; }
  element.innerHTML = `
    <table>
      <thead><tr><th>Request</th><th>Customer</th><th>Vehicle</th><th>Pickup → Return</th><th>Status</th><th>Money</th><th><span class="visually-hidden">Open</span></th></tr></thead>
      <tbody>
        ${state.reservations.map((reservation) => {
          const status = normalizeReservationStatus(reservation.Status);
          return `<tr class="clickable-row" data-open-reservation="${escapeHtml(String(reservation.ReservationID))}">
            <td><strong>${escapeHtml(reservation.RequestNumber || `#${reservation.ReservationID}`)}</strong></td>
            <td><strong>${escapeHtml(reservation.CustomerName)}</strong><span>${escapeHtml(reservation.CustomerPhone || reservation.CustomerEmail || "")}</span></td>
            <td><strong>${escapeHtml(`${reservation.Year || ""} ${reservation.Make || ""} ${reservation.Model || ""}`.trim())}</strong><span>${escapeHtml(reservation.PlateNumber || "No plate")}</span></td>
            <td><strong>${escapeHtml(formatDate(reservation.PickupAt))}</strong><span>${escapeHtml(formatDate(reservation.ReturnAt))}</span></td>
            <td><span class="status-pill ${statusClass(status)}">${escapeHtml(displayStatus(status))}</span>${nextStepHint(reservation) ? `<span class="hint">${escapeHtml(nextStepHint(reservation))}</span>` : ""}</td>
            <td>${moneyCell(reservation)}</td>
            <td><button class="button small secondary" type="button" data-open-reservation="${escapeHtml(String(reservation.ReservationID))}">Open</button></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;
}

// What staff need to do next, in plain words.
function nextStepHint(reservation) {
  const status = normalizeReservationStatus(reservation.Status);
  const counter = reservation.Counter;
  if (status === reservationStatuses.pending) return "Confirm or decline";
  if (status === reservationStatuses.confirmed) return "Prepare vehicle";
  if (status === reservationStatuses.readyForPickup) {
    const missing = [];
    if (!counter?.checks?.complete) missing.push("counter checks");
    if (!getInspection(reservation, "PICKUP")) missing.push("pickup inspection");
    return missing.length ? `Needs ${missing.join(" + ")}` : "Ready to hand over";
  }
  if (status === reservationStatuses.checkedOut) return `Due back ${formatDate(reservation.ReturnAt)}`;
  if (status === reservationStatuses.returnedPendingInspection) {
    const missing = [];
    if (!getInspection(reservation, "RETURN")) missing.push("return inspection");
    if (counter && !counter.ledger.settled) missing.push("payment");
    return missing.length ? `Needs ${missing.join(" + ")}` : "Ready to complete";
  }
  return "";
}

function checksEditable(status) { return ["CONFIRMED", "READY_FOR_PICKUP", "CHECKED_OUT"].includes(status); }

function renderCounterChecks(reservation) {
  const status = normalizeReservationStatus(reservation.Status);
  const checks = reservation.Counter?.checks || {};
  const editable = checksEditable(status) && canMutate(state.user?.role);
  const item = (key, label, help) => {
    const value = checks[key] || {};
    return `<label class="counter-check ${value.done ? "is-done" : ""}"><input type="checkbox" name="${key}" ${value.done ? "checked" : ""} ${editable ? "" : "disabled"}><span><b>${label}</b><small>${value.done ? `Done${value.by ? ` by ${escapeHtml(value.by)}` : ""} · ${escapeHtml(formatDate(value.at))}` : help}</small></span></label>`;
  };
  return `<section class="drawer-section"><h3>Counter checklist</h3><p class="muted-note">Required before the keys are handed over.</p>
    <form id="counterChecksForm" data-reservation-id="${escapeHtml(String(reservation.ReservationID))}">
      ${item("license", "Driver license checked", "Valid, not expired, matches the renter")}
      ${item("insurance", "Insurance checked", "Proof of insurance covers this rental")}
      ${item("agreement", "Rental agreement signed", "Paper agreement signed by renter and staff")}
      <label class="field-label"><span>Note <span class="optional">optional</span></span><textarea name="note" rows="2" maxlength="1000" ${editable ? "" : "disabled"}>${escapeHtml(checks.note || "")}</textarea></label>
      ${editable ? '<button class="button small primary" type="submit">Save checklist</button>' : '<p class="muted-note">The checklist can be changed while the reservation is confirmed or out.</p>'}
    </form></section>`;
}

function renderMoney(reservation) {
  const counter = reservation.Counter;
  if (!counter) return "";
  const ledger = counter.ledger;
  const status = normalizeReservationStatus(reservation.Status);
  const canPay = canMutate(state.user?.role) && !["PENDING_REQUEST", "DECLINED"].includes(status);
  const canCharge = canMutate(state.user?.role) && ["CONFIRMED", "READY_FOR_PICKUP", "CHECKED_OUT", "RETURNED_PENDING_INSPECTION"].includes(status);
  const id = escapeHtml(String(reservation.ReservationID));
  const suggested = ledger.balanceCents > 0 ? (ledger.balanceCents / 100).toFixed(2) : "";
  const history = [
    ...counter.charges.map((row) => ({ at: row.createdAt, text: `${row.amountCents < 0 ? "Discount" : "Charge"}: ${row.description}`, amount: row.amountCents, by: row.createdBy })),
    ...counter.payments.map((row) => ({ at: row.recordedAt, text: `${PAYMENT_KIND_LABELS[row.kind]} · ${METHOD_LABELS[row.method]}${row.reference ? ` · ${row.reference}` : ""}`, amount: ["REFUND", "DEPOSIT_REFUND"].includes(row.kind) ? -row.amountCents : row.amountCents, by: row.recordedBy }))
  ].sort((a, b) => new Date(a.at) - new Date(b.at));
  return `<section class="drawer-section"><h3>Payment</h3>
    <dl class="ledger">
      <div><dt>Rental</dt><dd>${escapeHtml(centsMoney(ledger.rentalCents))}</dd></div>
      ${ledger.chargesCents ? `<div><dt>Extra charges / discounts</dt><dd>${escapeHtml(centsMoney(ledger.chargesCents))}</dd></div>` : ""}
      <div><dt>Paid</dt><dd>${escapeHtml(centsMoney(ledger.paidCents))}</dd></div>
      <div class="ledger-total ${ledger.settled ? "is-ok" : ""}"><dt>${ledger.balanceCents < 0 ? "Owed to customer" : "Balance due"}</dt><dd>${escapeHtml(centsMoney(Math.abs(ledger.balanceCents)))}</dd></div>
      <div><dt>Deposit held</dt><dd>${escapeHtml(centsMoney(ledger.depositHeldCents))}${ledger.depositRequiredCents ? ` <small>of ${escapeHtml(centsMoney(ledger.depositRequiredCents))}</small>` : ""}</dd></div>
    </dl>
    ${status === "COMPLETED" && ledger.depositHeldCents > 0 ? '<p class="warning-note">A deposit is still recorded as held. Record the deposit return.</p>' : ""}
    ${canPay ? `<form class="money-form" id="paymentForm" data-reservation-id="${id}">
      <div class="form-grid compact">
        <label>Type<select name="kind"><option value="PAYMENT">Payment</option><option value="DEPOSIT">Deposit taken</option><option value="DEPOSIT_REFUND">Deposit returned</option><option value="REFUND">Refund</option></select></label>
        <label>Method<select name="method">${Object.entries(METHOD_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
        <label>Amount ($)<input name="amount" inputmode="decimal" required value="${escapeHtml(suggested)}"></label>
        <label>Reference <span class="optional">optional</span><input name="reference" maxlength="120" placeholder="Receipt / last 4"></label>
      </div>
      <button class="button small primary" type="submit">Record</button></form>` : ""}
    ${canCharge ? `<details class="charge-details"><summary>Add a charge or discount</summary><form class="money-form" id="chargeForm" data-reservation-id="${id}">
      <div class="form-grid compact"><label>Description<input name="description" maxlength="200" required placeholder="Late return, fuel, cleaning…"></label><label>Amount ($)<input name="amount" inputmode="decimal" required></label></div>
      <label class="inspection-check"><input type="checkbox" name="discount"> This is a discount</label>
      <button class="button small secondary" type="submit">Add</button></form></details>` : ""}
    ${history.length ? `<ol class="money-history">${history.map((row) => `<li><span>${escapeHtml(row.text)}<small>${escapeHtml(formatDate(row.at))}${row.by ? ` · ${escapeHtml(row.by)}` : ""}</small></span><b class="${row.amount < 0 ? "neg" : ""}">${escapeHtml(centsMoney(row.amount))}</b></li>`).join("")}</ol>` : '<p class="muted-note">No payments recorded yet.</p>'}
  </section>`;
}

function renderReservationDialog() {
  const dialog = $("#reservationDialog");
  const reservation = state.reservations.find((item) => Number(item.ReservationID) === Number(state.openReservationId));
  if (!reservation) { if (dialog.open) dialog.close(); return; }
  const status = normalizeReservationStatus(reservation.Status);
  $("#reservationDialogEyebrow").textContent = reservation.RequestNumber || `#${reservation.ReservationID}`;
  $("#reservationDialogTitle").textContent = reservation.CustomerName || "Reservation";
  const hint = nextStepHint(reservation);
  $("#reservationDialogContent").innerHTML = `
    <div class="drawer-status"><span class="status-pill ${statusClass(status)}">${escapeHtml(displayStatus(status))}</span>${hint ? `<span class="hint">${escapeHtml(hint)}</span>` : ""}</div>
    <section class="drawer-section"><dl class="drawer-facts">
      <div><dt>Vehicle</dt><dd>${escapeHtml(`${reservation.Year || ""} ${reservation.Make || ""} ${reservation.Model || ""}`.trim())}<small>${escapeHtml(reservation.PlateNumber || "")}</small></dd></div>
      <div><dt>Pickup</dt><dd>${escapeHtml(formatDate(reservation.PickupAt))}</dd></div>
      <div><dt>Return</dt><dd>${escapeHtml(formatDate(reservation.ReturnAt))}</dd></div>
      <div><dt>Phone</dt><dd>${reservation.CustomerPhone ? `<a href="tel:${escapeHtml(reservation.CustomerPhone)}">${escapeHtml(reservation.CustomerPhone)}</a>` : "—"}</dd></div>
      <div><dt>Email</dt><dd>${reservation.CustomerEmail ? `<a href="mailto:${escapeHtml(reservation.CustomerEmail)}">${escapeHtml(reservation.CustomerEmail)}</a>` : "—"}</dd></div>
      ${reservation.CustomerNotes ? `<div class="wide"><dt>Customer notes</dt><dd>${escapeHtml(reservation.CustomerNotes)}</dd></div>` : ""}
    </dl></section>
    <section class="drawer-section"><h3>Next step</h3>${renderReservationActions(reservation)}</section>
    ${["CONFIRMED", "READY_FOR_PICKUP", "CHECKED_OUT", "RETURNED_PENDING_INSPECTION", "COMPLETED"].includes(status) ? renderCounterChecks(reservation) : ""}
    ${renderInspections(reservation) ? `<section class="drawer-section"><h3>Inspections</h3>${renderInspections(reservation)}</section>` : ""}
    ${status === "PENDING_REQUEST" ? "" : renderMoney(reservation)}
    <section class="drawer-section"><h3>History</h3>${renderTransitionHistory(reservation)} ${renderNotifications(reservation)}</section>`;
}

function openReservation(id) {
  state.openReservationId = Number(id);
  renderReservationDialog();
  const dialog = $("#reservationDialog");
  if (!dialog.open) dialog.showModal();
}

function dollarsInput(value) {
  const text = String(value || "").trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error("Enter an amount like 125 or 125.50");
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (cents <= 0) throw new Error("Amount must be more than zero");
  return cents;
}

async function counterMutation(form, path, method, body, success) {
  if (form.dataset.busy) return;
  form.dataset.busy = "1";
  const button = form.querySelector("button[type=submit]");
  if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); }
  try {
    await request(`/api/reservations/${form.dataset.reservationId}${path}`, { method, body: JSON.stringify(body) });
    await refreshData();
    toast(success);
  } catch (error) {
    if (error.status === 401) return;
    toast(error.message || "That didn't save. Try again.", "error");
    if (button) { button.disabled = false; button.removeAttribute("aria-busy"); }
  } finally { delete form.dataset.busy; }
}

function onDrawerSubmit(event) {
  const form = event.target;
  if (!["counterChecksForm", "paymentForm", "chargeForm"].includes(form.id)) return;
  event.preventDefault();
  try {
    if (form.id === "counterChecksForm") {
      const checks = Object.fromEntries(["license", "insurance", "agreement"].map((key) => [key, form.elements[key].checked]));
      return counterMutation(form, "/counter/checks", "PATCH", { checks, note: form.elements.note.value }, "Checklist saved");
    }
    if (form.id === "paymentForm") {
      const amountCents = dollarsInput(form.elements.amount.value);
      const kind = form.elements.kind.value;
      if (!window.confirm(`Record ${PAYMENT_KIND_LABELS[kind].toLowerCase()} of ${centsMoney(amountCents)} by ${METHOD_LABELS[form.elements.method.value]}? Payments can't be edited later; mistakes are fixed with a refund.`)) return;
      return counterMutation(form, "/payments", "POST", { kind, method: form.elements.method.value, amountCents, reference: form.elements.reference.value }, "Payment recorded");
    }
    const amount = dollarsInput(form.elements.amount.value);
    return counterMutation(form, "/charges", "POST", { description: form.elements.description.value, amountCents: form.elements.discount.checked ? -amount : amount }, form.elements.discount.checked ? "Discount added" : "Charge added");
  } catch (error) { toast(error.message, "error"); }
}

function renderNotifications(reservation) {
  const events = Array.isArray(reservation.Notifications) ? reservation.Notifications : [];
  if (!events.length) return "<span>No notification events</span>";
  return `<details class="notification-history"><summary>${events.length} event${events.length === 1 ? "" : "s"}</summary><ol>${events.map((event) => `<li><strong>${escapeHtml(event.eventType)}</strong><span class="status-pill ${statusClass(event.status)}">${escapeHtml(event.status)}</span><span>${escapeHtml(String(event.attemptCount))} attempt${event.attemptCount === 1 ? "" : "s"}${event.lastAttemptedAt ? ` · ${escapeHtml(formatDate(event.lastAttemptedAt))}` : ""}${event.sentAt ? ` · sent ${escapeHtml(formatDate(event.sentAt))}` : ""}${event.safeDetail ? ` · ${escapeHtml(event.safeDetail)}` : ""}</span></li>`).join("")}</ol></details>`;
}

function renderEmployees() {
  const element = $("#employeeTable");
  if (!element) return;
  const owner = String(state.user?.role || "").toUpperCase() === "OWNER";
  if (!state.users.length) { element.innerHTML = "<div class=\"empty-state\"><strong>No employee accounts</strong></div>"; return; }
  element.innerHTML = `<table><thead><tr><th>Employee</th><th>Role</th><th>State</th><th>Last login</th><th>Sessions</th><th>Version</th><th>Actions</th></tr></thead><tbody>${state.users.map((user) => `<tr><td><strong>${escapeHtml(user.email)}</strong></td><td>${owner ? `<select data-user-role="${user.id}"><option ${user.role === "OWNER" ? "selected" : ""}>OWNER</option><option ${user.role === "STAFF" ? "selected" : ""}>STAFF</option></select>` : escapeHtml(user.role)}</td><td><span class="status-pill ${user.isActive ? "active" : "inactive"}">${user.isActive ? "Active" : "Disabled"}</span></td><td>${escapeHtml(formatDate(user.lastLoginAt) || "Never")}</td><td>${escapeHtml(String(user.activeSessionCount))}</td><td>${escapeHtml(String(user.accountVersion))}</td><td>${owner ? `<div class="employee-actions"><button class="button small secondary" type="button" data-user-action="change-role" data-user-id="${user.id}">Save role</button><button class="button small ${user.isActive ? "danger" : "primary"}" type="button" data-user-action="${user.isActive ? "disable" : "enable"}" data-user-id="${user.id}">${user.isActive ? "Disable" : "Enable"}</button><button class="button small secondary" type="button" data-user-action="revoke-sessions" data-user-id="${user.id}">Revoke sessions</button></div>` : "<span>Owner only</span>"}</td></tr>`).join("")}</tbody></table>`;
}

function renderTransitionHistory(reservation) {
  const history = Array.isArray(reservation.TransitionHistory) ? reservation.TransitionHistory : [];
  if (!history.length) return "<span>No recorded transitions</span>";
  return `<details class="reservation-history"><summary>${history.length} transition${history.length === 1 ? "" : "s"}</summary><ol>${history.map((entry) => `<li>${escapeHtml(entry.FromStatus)} → ${escapeHtml(entry.ToStatus)} · ${escapeHtml(formatDate(entry.CreatedAt))}</li>`).join("")}</ol></details>`;
}

function renderAll() {
  if (state.openReservationId && $("#reservationDialog")?.open) renderReservationDialog();
  renderMetrics();
  renderReservationQueue();
  renderFleet();
  renderReservations();
  renderEmployees();
  renderFood();
}

function renderFood() {
  const queue = $("#foodOrderQueue"), menu = $("#foodMenuList");
  if (!queue || !menu) return;
  const next = { NEW: ["ACCEPTED", "REJECTED", "CANCELLED"], ACCEPTED: ["PREPARING", "CANCELLED"], PREPARING: ["READY", "CANCELLED"], READY: ["COMPLETED", "CANCELLED"] };
  queue.innerHTML = state.foodOrders.length ? state.foodOrders.map((order) => `<article class="food-order"><strong>${escapeHtml(order.orderNumber)}</strong> · ${escapeHtml(order.customerName)} · ${escapeHtml(order.customerPhone)}<br><small>${order.pickupType === "ASAP" ? "ASAP" : escapeHtml(formatDate(order.pickupAt))} · ${Math.max(0, Math.floor((Date.now() - new Date(order.createdAt)) / 60000))} min ago · ${escapeHtml(order.paymentStatus)}</small><p>${order.items.map((item) => `${escapeHtml(item.itemName)} × ${item.quantity}`).join(", ")}</p>${order.customerNotes ? `<p>Note: ${escapeHtml(order.customerNotes)}</p>` : ""}<strong>${currency(order.totalCents / 100)}</strong><div class="employee-actions">${(next[order.status] || []).map((status) => `<button class="button small secondary" data-food-status="${order.id}" data-next-status="${status}">${status.replaceAll("_", " ")}</button>`).join("")} ${order.paymentStatus === "UNPAID" ? `<button class="button small primary" data-food-paid="${order.id}">Mark paid</button>` : ""}</div><span class="status-pill ${statusClass(order.status)}">${escapeHtml(order.status)}</span></article>`).join("") : "<div class=\"empty-state\"><strong>No food orders</strong></div>";
  const owner = state.user?.role === "OWNER";
  $("#foodOwnerTools").hidden = !owner;
  const categorySelect = $("#foodItemCategory");
  if (categorySelect) categorySelect.innerHTML = state.foodMenu.map((category) => `<option value="${category.id}">${escapeHtml(category.name)}${category.isActive ? "" : " (inactive)"}</option>`).join("");
  menu.innerHTML = state.foodMenu.map((category) => `<section class="food-category"><div><strong>${escapeHtml(category.name)}</strong><span class="status-pill ${category.isActive ? "active" : "inactive"}">${category.isActive ? "Active" : "Inactive"}</span>${owner ? `<button class="button small secondary" data-edit-food-category="${category.id}">Edit</button><button class="button small ${category.isActive ? "danger" : "primary"}" data-toggle-food-category="${category.id}">${category.isActive ? "Deactivate" : "Activate"}</button>` : ""}</div>${category.items.map((item) => `<div><span>${escapeHtml(item.name)} · ${currency(item.priceCents / 100)} · ${item.isActive ? "Active" : "Inactive"} · ${item.isSoldOut ? "Sold out" : "Available"}</span><button class="button small secondary" data-food-soldout="${item.id}" data-sold-out="${!item.isSoldOut}">${item.isSoldOut ? "Mark available" : "Sold out"}</button>${owner ? `<button class="button small secondary" data-edit-food-item="${item.id}">Edit</button><button class="button small ${item.isActive ? "danger" : "primary"}" data-toggle-food-item="${item.id}">${item.isActive ? "Deactivate" : "Activate"}</button>` : ""}</div>`).join("")}</section>`).join("") || "<div class=\"empty-state\"><strong>No menu items</strong><span>Use the owner controls to add menu records.</span></div>";
}

function centsFromDollar(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 10000 || Math.round(amount * 100) !== amount * 100) throw new Error("Enter a valid price with no more than two decimal places.");
  return Math.round(amount * 100);
}
function clearFoodCategory() { $("#foodCategoryForm").reset(); $("#foodCategoryId").value = ""; $("#foodCategoryOrder").value = "0"; $("#foodCategoryActive").checked = true; $("#foodCategoryTitle").textContent = "Add category"; $("#foodCategoryError").textContent = ""; }
function clearFoodItem() { $("#foodItemForm").reset(); $("#foodItemId").value = ""; $("#foodItemOrder").value = "0"; $("#foodItemActive").checked = true; $("#foodItemTitle").textContent = "Add menu item"; $("#foodItemError").textContent = ""; }
function foodCategory(id) { return state.foodMenu.find((category) => Number(category.id) === Number(id)); }
function foodItem(id) { return state.foodMenu.flatMap((category) => category.items).find((item) => Number(item.id) === Number(id)); }
function editFoodCategory(id) { const category = foodCategory(id); if (!category) return; $("#foodCategoryId").value = category.id; $("#foodCategoryName").value = category.name; $("#foodCategoryOrder").value = category.displayOrder; $("#foodCategoryActive").checked = category.isActive; $("#foodCategoryTitle").textContent = "Edit category"; $("#foodCategoryError").textContent = ""; $("#foodCategoryName").focus(); }
function editFoodItem(id) { const item = foodItem(id); if (!item) return; $("#foodItemId").value = item.id; $("#foodItemCategory").value = item.categoryId; $("#foodItemName").value = item.name; $("#foodItemDescription").value = item.description || ""; $("#foodItemPrice").value = (item.priceCents / 100).toFixed(2); $("#foodItemImage").value = item.imageUrl || ""; $("#foodItemOrder").value = item.displayOrder; $("#foodItemActive").checked = item.isActive; $("#foodItemSoldOut").checked = item.isSoldOut; $("#foodItemTitle").textContent = "Edit menu item"; $("#foodItemError").textContent = ""; $("#foodItemName").focus(); }
async function saveFoodCategory(event) { event.preventDefault(); const id = $("#foodCategoryId").value; const body = { name: $("#foodCategoryName").value.trim(), displayOrder: Number($("#foodCategoryOrder").value), isActive: $("#foodCategoryActive").checked }; try { if (!body.name || !Number.isInteger(body.displayOrder) || body.displayOrder < 0) throw new Error("Enter a category name and a non-negative display order."); if (id && !window.confirm(`${body.isActive ? "Update" : "Hide"} this category from the public menu?`)) return; await request(id ? `/api/admin/food/categories/${id}` : "/api/admin/food/categories", { method: id ? "PATCH" : "POST", body: JSON.stringify(body) }); clearFoodCategory(); await refreshData(); toast("Category saved"); } catch (error) { $("#foodCategoryError").textContent = error.message; } }
async function saveFoodItem(event) { event.preventDefault(); const id = $("#foodItemId").value; try { const body = { categoryId: Number($("#foodItemCategory").value), name: $("#foodItemName").value.trim(), description: $("#foodItemDescription").value.trim(), priceCents: centsFromDollar($("#foodItemPrice").value), imageUrl: $("#foodItemImage").value.trim(), displayOrder: Number($("#foodItemOrder").value), isActive: $("#foodItemActive").checked, isSoldOut: $("#foodItemSoldOut").checked }; if (!body.categoryId || !body.name || !Number.isInteger(body.displayOrder) || body.displayOrder < 0) throw new Error("Enter a category, name, and non-negative display order."); if (id && !window.confirm(`${body.isActive ? "Update" : "Hide"} this menu item from the public menu?`)) return; await request(id ? `/api/admin/food/items/${id}` : "/api/admin/food/items", { method: id ? "PATCH" : "POST", body: JSON.stringify(body) }); clearFoodItem(); await refreshData(); toast("Menu item saved"); } catch (error) { $("#foodItemError").textContent = error.message; } }

async function refreshData(showMessage = false) {
  try {
    const owner = state.user?.role === "OWNER";
    const [vehiclePayload, reservationPayload, usersPayload, foodOrdersPayload, foodMenuPayload] = await Promise.all([
      request("/api/admin/vehicles"),
      request("/api/reservations"),
      owner ? request("/api/admin/users") : Promise.resolve({ users: [] }), request("/api/admin/food/orders"), request("/api/admin/food/menu")
    ]);
    state.vehicles = vehiclePayload.vehicles || [];
    state.reservations = reservationPayload.reservations || [];
    state.users = usersPayload.users || [];
    state.foodOrders = foodOrdersPayload.orders || [];
    state.foodMenu = foodMenuPayload.categories || [];
    renderAll();
    $("#apiStatus").textContent = "API connected";
    $("#apiStatus").className = "connection-pill ok";
    if (showMessage) toast("Dashboard refreshed");
  } catch (error) {
    $("#apiStatus").textContent = "API error";
    $("#apiStatus").className = "connection-pill bad";
    toast(error.message, "error");
  }
}

async function mutateEmployee(userId, operation, button) {
  const user = state.users.find((item) => Number(item.id) === Number(userId));
  if (!user || String(state.user?.role || "").toUpperCase() !== "OWNER") return;
  if (["disable", "change-role"].includes(operation) && !window.confirm(`Confirm ${operation.replace("-", " ")} for ${user.email}?`)) return;
  button.disabled = true; button.setAttribute("aria-busy", "true");
  try {
    const body = { expectedAccountVersion: user.accountVersion };
    if (operation === "change-role") body.role = document.querySelector(`[data-user-role="${userId}"]`)?.value;
    await request(`/api/admin/users/${userId}/operations/${operation}`, { method: "POST", body: JSON.stringify(body) });
    await refreshData(); toast("Employee account updated");
  } catch (error) {
    if (error.status === 409) await refreshData();
    const messages = { LAST_ACTIVE_OWNER_REQUIRED: "At least one active Owner is required.", SELF_ACCOUNT_OPERATION_NOT_ALLOWED: "Use Sign out to end your own session; self-account changes are unavailable here.", ADMIN_ACCOUNT_STATE_CONFLICT: "Employee data changed. The current data was loaded." };
    toast(messages[error.code] || error.message, "error");
  } finally { button.disabled = false; button.removeAttribute("aria-busy"); }
}

function readVehicleForm() {
  return {
    make: $("#make").value.trim(),
    model: $("#model").value.trim(),
    year: $("#year").value,
    color: $("#color").value.trim(),
    plateNumber: $("#plateNumber").value.trim(),
    vin: $("#vin").value.trim(),
    category: $("#category").value,
    seats: $("#seats").value,
    transmission: $("#transmission").value,
    fuelType: $("#fuelType").value,
    mileage: $("#mileage").value,
    dailyRate: $("#dailyRate").value,
    depositAmount: $("#depositAmount").value,
    status: $("#status").value,
    locationName: $("#locationName").value.trim() || OFFICE_LOCATION,
    notes: $("#notes").value.trim()
  };
}

function clearPhotoPreview() {
  $("#photoPreview").innerHTML = "";
}

function renderSelectedPhotoPreview() {
  const files = [...$("#photos").files];
  $("#photoPreview").innerHTML = files
    .map((file) => `<img src="${URL.createObjectURL(file)}" alt="${escapeHtml(file.name)} preview" />`)
    .join("");
}

function clearVehicleForm() {
  $("#vehicleForm").reset();
  $("#editingVehicleId").value = "";
  $("#vehicleFormTitle").textContent = "Add vehicle";
  $("#seats").value = "5";
  $("#mileage").value = "0";
  $("#depositAmount").value = "250";
  $("#locationName").value = OFFICE_LOCATION;
  clearPhotoPreview();
}

function editVehicle(vehicleId) {
  const vehicle = state.vehicles.find((item) => Number(getVehicleId(item)) === Number(vehicleId));
  if (!vehicle) return;

  $("#editingVehicleId").value = String(getVehicleId(vehicle));
  $("#vehicleFormTitle").textContent = `Edit ${getVehicleTitle(vehicle)}`;
  $("#make").value = vehicle.make || "";
  $("#model").value = vehicle.model || "";
  $("#year").value = vehicle.year || "";
  $("#color").value = vehicle.color || "";
  $("#plateNumber").value = vehicle.plateNumber || "";
  $("#vin").value = vehicle.vin || "";
  $("#category").value = vehicle.category || "Sedan";
  $("#seats").value = vehicle.seats || 5;
  $("#transmission").value = vehicle.transmission || "Automatic";
  $("#fuelType").value = vehicle.fuelType || "Gasoline";
  $("#mileage").value = vehicle.mileage || 0;
  $("#dailyRate").value = vehicle.dailyRate || "";
  $("#depositAmount").value = vehicle.depositAmount || 0;
  $("#status").value = vehicle.status || "READY";
  $("#locationName").value = vehicle.locationName || OFFICE_LOCATION;
  $("#notes").value = vehicle.notes || "";
  clearPhotoPreview();
  setView("fleet");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function submitVehicle(event) {
  event.preventDefault();
  if (state.vehicleSubmitting) return;
  const editingId = $("#editingVehicleId").value;
  const vehicle = readVehicleForm();
  const files = [...$("#photos").files];
  const submitButton = event.submitter || $("#vehicleForm button[type=\"submit\"]");
  const originalLabel = submitButton.textContent;
  state.vehicleSubmitting = true;
  submitButton.disabled = true;
  submitButton.textContent = editingId ? "Saving changes…" : "Creating vehicle…";
  $("#vehicleForm").setAttribute("aria-busy", "true");

  try {
    if (editingId) {
      await request(`/api/admin/vehicles/${editingId}`, {
        method: "PATCH",
        body: JSON.stringify(vehicle)
      });

      if (files.length > 0) {
        const formData = new FormData();
        files.forEach((file) => formData.append("photos", file));
        formData.append("makePrimary", "false");
        await request(`/api/admin/vehicles/${editingId}/photos`, {
          method: "POST",
          body: formData,
          headers: {}
        });
      }
      toast("Vehicle updated");
    } else {
      const formData = new FormData();
      Object.entries(vehicle).forEach(([key, value]) => formData.append(key, value));
      files.forEach((file) => formData.append("photos", file));
      await request("/api/admin/vehicles", {
        method: "POST",
        body: formData,
        headers: {}
      });
      toast("Vehicle created");
    }

    clearVehicleForm();
    await refreshData();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.vehicleSubmitting = false;
    submitButton.disabled = false;
    submitButton.textContent = originalLabel;
    $("#vehicleForm").removeAttribute("aria-busy");
  }
}

async function uploadVehiclePhotos(vehicleId) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.addEventListener("change", async () => {
    const files = [...input.files];
    if (files.length === 0) return;

    const formData = new FormData();
    files.forEach((file) => formData.append("photos", file));
    formData.append("makePrimary", "false");

    try {
      await request(`/api/admin/vehicles/${vehicleId}/photos`, {
        method: "POST",
        body: formData,
        headers: {}
      });
      toast("Photos uploaded");
      await refreshData();
    } catch (error) {
      toast(error.message, "error");
    }
  });
  input.click();
}

async function saveVehicleStatus(vehicleId) {
  const select = document.querySelector(`[data-vehicle-status="${String(vehicleId)}"]`);
  if (!select) return;

  try {
    await request(`/api/admin/vehicles/${vehicleId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: select.value })
    });
    toast("Vehicle status updated");
    await refreshData();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function markInactive(vehicleId) {
  const vehicle = state.vehicles.find((item) => Number(getVehicleId(item)) === Number(vehicleId));
  if (!vehicle) return;
  if (!window.confirm(`Retire ${getVehicleTitle(vehicle)} from the public fleet?`)) return;

  try {
    await request(`/api/admin/vehicles/${vehicleId}`, { method: "DELETE" });
    toast("Vehicle retired");
    await refreshData();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function handleReservationMutationFailure(error, scrollPosition) {
  const behavior = failureBehavior(error.status);
  if (behavior.clearSession) {
    showLogin("Your session has expired. Sign in again to continue.");
    return;
  }
  if (behavior.refresh) {
    await refreshData();
    window.scrollTo({ top: scrollPosition });
  }
  const messages = {
    permission: "You do not have permission to perform this action.",
    missing: "This reservation no longer exists. The latest data has been loaded.",
    conflict: "This reservation or vehicle changed before the action completed. The latest data has been loaded.",
    temporary: "The action could not be completed right now. No local state was changed."
  };
  if (["COUNTER_CHECKS_REQUIRED", "BALANCE_DUE"].includes(error.code)) { toast(error.message, "error"); return; }
  toast(messages[behavior.kind] || error.message, "error");
}

async function updateReservationStatus(reservationId, status, button) {
  const mutationKey = String(reservationId);
  if (state.pendingMutations.has(mutationKey)) return;
  const reservation = state.reservations.find((item) => Number(item.ReservationID) === Number(reservationId));
  if (status === reservationStatuses.noShow
    && !window.confirm(`Mark request ${reservation?.RequestNumber || `#${reservationId}`} as no-show? This releases the requested dates without adding fees.`)) return;
  const scrollPosition = window.scrollY;
  state.pendingMutations.add(mutationKey);
  const reservationButtons = [...document.querySelectorAll(`[data-reservation-id="${reservationId}"]`)];
  reservationButtons.forEach((actionButton) => {
    actionButton.disabled = true;
    actionButton.setAttribute("aria-busy", "true");
  });
  try {
    const operations = { CONFIRMED: "confirm", DECLINED: "decline", CANCELLED: "cancel", READY_FOR_PICKUP: "ready_for_pickup", CHECKED_OUT: "check_out", RETURNED_PENDING_INSPECTION: "mark_returned", COMPLETED: "complete", NO_SHOW: "no_show" };
    let reason = "";
    if ([reservationStatuses.declined, reservationStatuses.cancelled, reservationStatuses.noShow].includes(status)) {
      reason = window.prompt("Optional operational reason (maximum 500 characters):", "") ?? "";
    }
    await request(`/api/reservations/${reservationId}/operations/${operations[status]}`, {
      method: "POST",
      body: JSON.stringify({ expectedStatusVersion: reservation?.StatusVersion, reason })
    });
    await refreshData();
    window.scrollTo({ top: scrollPosition });
    toast("Reservation updated");
  } catch (error) {
    await handleReservationMutationFailure(error, scrollPosition);
  } finally {
    state.pendingMutations.delete(mutationKey);
    renderReservations();
    if ($("#reservationDialog").open) renderReservationDialog();
    reservationButtons.filter((actionButton) => actionButton.isConnected).forEach((actionButton) => {
      actionButton.disabled = false;
      actionButton.removeAttribute("aria-busy");
    });
  }
}

async function submitInspection(reservationId, inspectionType) {
  const form = document.querySelector(`[data-inspection-form][data-reservation-id="${reservationId}"][data-inspection-type="${inspectionType}"]`);
  if (!form) return;
  const type = inspectionType.toUpperCase();
  const key = `inspection:${reservationId}:${type}`;
  if (state.pendingMutations.has(key)) return;
  const field = (name) => form.elements[name];
  const body = {
    odometer: field("odometer").value,
    fuelLevelPercent: field("fuelLevelPercent").value,
    keysCount: field("keysCount").value,
    damageObserved: field("damageObserved").checked,
    damageNotes: field("damageNotes").value,
    cleanlinessNotes: field("cleanlinessNotes").value,
    accessoriesNotes: field("accessoriesNotes").value
  };
  if (inspectionType === "return") {
    body.allExpectedKeysReturned = field("allExpectedKeysReturned").checked;
    body.accessoriesReturned = field("accessoriesReturned").checked;
  }
  state.pendingMutations.add(key); renderReservations(); if ($("#reservationDialog").open) renderReservationDialog();
  try {
    await request(`/api/reservations/${reservationId}/inspections/${inspectionType}`, { method: "POST", body: JSON.stringify(body) });
    await refreshData(); toast(`${inspectionType === "pickup" ? "Pickup" : "Return"} inspection completed`);
  } catch (error) {
    const messages = { INSPECTION_ALREADY_COMPLETED: "This inspection was already completed. Latest data loaded.", INSPECTION_STATE_CONFLICT: "Inspection is not allowed in the current reservation state." };
    if (error.status === 409) await refreshData();
    toast(messages[error.code] || error.message, "error");
  } finally { state.pendingMutations.delete(key); renderReservations(); if ($("#reservationDialog").open) renderReservationDialog(); }
}

async function testApi() {
  try {
    const payload = await request("/api/health", { admin: false });
    $("#apiStatus").textContent = "API connected";
    $("#apiStatus").className = "connection-pill ok";
    toast(`API OK: ${payload.service}`);
  } catch (error) {
    $("#apiStatus").textContent = "API error";
    $("#apiStatus").className = "connection-pill bad";
    toast(error.message, "error");
  }
}

function saveSettings() {
  state.apiBase = $("#apiBaseInput").value.trim() || DEFAULT_API_BASE;
  showLogin("Sign in to the selected API.");
  toast("API URL updated for this page session");
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });

  $("#refreshButton").addEventListener("click", () => refreshData(true));
  document.addEventListener("click", (event) => {
    const opener = event.target.closest("[data-open-reservation]");
    if (opener && !event.target.closest("[data-reservation-status]")) openReservation(opener.dataset.openReservation);
  });
  $("#closeReservationDialog").addEventListener("click", () => $("#reservationDialog").close());
  $("#reservationDialog").addEventListener("close", () => { state.openReservationId = null; });
  $("#reservationDialog").addEventListener("submit", onDrawerSubmit);
  $("#vehicleForm").addEventListener("submit", submitVehicle);
  $("#clearFormButton").addEventListener("click", clearVehicleForm);
  $("#photos").addEventListener("change", renderSelectedPhotoPreview);
  $("#fleetSearch").addEventListener("input", renderFleet);
  $("#statusFilter").addEventListener("change", renderFleet);
  $("#saveSettingsButton").addEventListener("click", saveSettings);
  $("#testApiButton").addEventListener("click", testApi);
  $("#logoutButton").addEventListener("click", logout);
  $("#loginForm").addEventListener("submit", submitLogin);
  $("#foodCategoryForm").addEventListener("submit", saveFoodCategory);
  $("#foodItemForm").addEventListener("submit", saveFoodItem);
  $("#clearFoodCategory").addEventListener("click", clearFoodCategory);
  $("#clearFoodItem").addEventListener("click", clearFoodItem);
  $("#closeDetailsButton").addEventListener("click", closeVehicleDetails);
  $("#detailsDialog").addEventListener("click", (event) => {
    if (event.target === $("#detailsDialog")) closeVehicleDetails();
  });

  document.body.addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-edit]");
    if (editButton) editVehicle(editButton.dataset.edit);

    const uploadButton = event.target.closest("[data-upload]");
    if (uploadButton) uploadVehiclePhotos(uploadButton.dataset.upload);

    const detailsButton = event.target.closest("[data-details]");
    if (detailsButton) openVehicleDetails(detailsButton.dataset.details);

    const deleteButton = event.target.closest("[data-delete]");
    if (deleteButton) markInactive(deleteButton.dataset.delete);

    const saveStatusButton = event.target.closest("[data-save-status]");
    if (saveStatusButton) saveVehicleStatus(saveStatusButton.dataset.saveStatus);

    const reservationButton = event.target.closest("[data-reservation-id][data-reservation-status]");
    if (reservationButton) updateReservationStatus(reservationButton.dataset.reservationId, reservationButton.dataset.reservationStatus, reservationButton);
    const inspectionButton = event.target.closest("[data-inspection-submit][data-reservation-id]");
    if (inspectionButton) submitInspection(inspectionButton.dataset.reservationId, inspectionButton.dataset.inspectionSubmit);
    const employeeButton = event.target.closest("[data-user-action][data-user-id]");
    if (employeeButton) mutateEmployee(employeeButton.dataset.userId, employeeButton.dataset.userAction, employeeButton);
    const foodStatus = event.target.closest("[data-food-status]");
    if (foodStatus) request(`/api/admin/food/orders/${foodStatus.dataset.foodStatus}/status`, { method: "POST", body: JSON.stringify({ status: foodStatus.dataset.nextStatus }) }).then(() => refreshData()).catch((error) => toast(error.message, "error"));
    const paid = event.target.closest("[data-food-paid]");
    if (paid) request(`/api/admin/food/orders/${paid.dataset.foodPaid}/payment`, { method: "POST", body: JSON.stringify({ paymentStatus: "PAID" }) }).then(() => refreshData()).catch((error) => toast(error.message, "error"));
    const soldOut = event.target.closest("[data-food-soldout]");
    if (soldOut) request(`/api/admin/food/items/${soldOut.dataset.foodSoldout}`, { method: "PATCH", body: JSON.stringify({ isSoldOut: soldOut.dataset.soldOut === "true" }) }).then(() => refreshData()).catch((error) => toast(error.message, "error"));
    const categoryEdit = event.target.closest("[data-edit-food-category]");
    if (categoryEdit) editFoodCategory(categoryEdit.dataset.editFoodCategory);
    const itemEdit = event.target.closest("[data-edit-food-item]");
    if (itemEdit) editFoodItem(itemEdit.dataset.editFoodItem);
    const categoryToggle = event.target.closest("[data-toggle-food-category]");
    if (categoryToggle) { const category = foodCategory(categoryToggle.dataset.toggleFoodCategory); if (category && window.confirm(`${category.isActive ? "Hide" : "Show"} ${category.name} on the public menu?`)) request(`/api/admin/food/categories/${category.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !category.isActive }) }).then(() => refreshData()).catch((error) => toast(error.message, "error")); }
    const itemToggle = event.target.closest("[data-toggle-food-item]");
    if (itemToggle) { const item = foodItem(itemToggle.dataset.toggleFoodItem); if (item && window.confirm(`${item.isActive ? "Hide" : "Show"} ${item.name} on the public menu?`)) request(`/api/admin/food/items/${item.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !item.isActive }) }).then(() => refreshData()).catch((error) => toast(error.message, "error")); }
  });
}

async function init() {
  $("#apiBaseInput").value = state.apiBase;
  clearVehicleForm();
  bindEvents();
  setView("dashboard");
  await restoreSession();
}

init();
