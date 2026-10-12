const state = {
  vehicles: [],
  reservations: [],
  currentRoute: "dashboard",
  apiBase: localStorage.getItem("driveopsApiBase") || "http://localhost:3000",
  adminKey: localStorage.getItem("driveopsAdminKey") || "change-this-before-production"
};

const views = {
  dashboard: document.querySelector("#dashboardView"),
  browse: document.querySelector("#browseView"),
  fleet: document.querySelector("#fleetView"),
  reservations: document.querySelector("#reservationsView"),
  settings: document.querySelector("#settingsView")
};

const routeTitles = {
  dashboard: ["Operations dashboard", "Nashville rental control center"],
  browse: ["Customer catalog", "Cars customers can reserve"],
  fleet: ["Admin fleet", "Add cars and upload vehicle pictures"],
  reservations: ["Reservation desk", "Customer booking and admin review"],
  settings: ["Connection", "API and admin settings"]
};

function $(selector) {
  return document.querySelector(selector);
}

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

function statusClass(status) {
  return String(status || "").toLowerCase();
}

function toast(message, type = "success") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast show ${type}`;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => {
    el.className = "toast";
  }, 3200);
}

function emptyState() {
  return $("#emptyTemplate").innerHTML;
}

function apiUrl(path) {
  return `${state.apiBase.replace(/\/$/, "")}${path}`;
}

async function request(path, options = {}) {
  const headers = {
    ...(options.headers || {})
  };

  if (!(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  if (options.admin) {
    headers["x-admin-key"] = state.adminKey;
  }

  const response = await fetch(apiUrl(path), {
    ...options,
    headers
  });

  let payload = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || `Request failed with ${response.status}`);
  }

  return payload;
}

function vehicleLabel(vehicle) {
  return `${vehicle.year || ""} ${vehicle.make || ""} ${vehicle.model || ""}`.trim();
}

function vehiclePhoto(vehicle) {
  if (vehicle.primaryPhotoUrl) {
    return `<img src="${escapeHtml(vehicle.primaryPhotoUrl)}" alt="${escapeHtml(vehicleLabel(vehicle))}" />`;
  }

  return `<span>No photo</span>`;
}

function renderDashboard() {
  const total = state.vehicles.length;
  const available = state.vehicles.filter((vehicle) => vehicle.status === "Available").length;
  const busy = state.vehicles.filter((vehicle) => ["Reserved", "Rented"].includes(vehicle.status)).length;
  const service = state.vehicles.filter((vehicle) => ["Cleaning", "Maintenance"].includes(vehicle.status)).length;

  $("#kpiTotalFleet").textContent = total;
  $("#kpiAvailable").textContent = available;
  $("#kpiBusy").textContent = busy;
  $("#kpiService").textContent = service;
}

function getFilteredVehicles() {
  const search = $("#searchInput").value.trim().toLowerCase();
  const category = $("#categoryFilter").value;
  const maxRate = Number($("#maxRateFilter").value || 0);

  return state.vehicles
    .filter((vehicle) => vehicle.status === "Available")
    .filter((vehicle) => {
      const haystack = [
        vehicle.make,
        vehicle.model,
        vehicle.category,
        vehicle.color,
        vehicle.plateNumber,
        vehicle.locationName
      ]
        .join(" ")
        .toLowerCase();

      if (search && !haystack.includes(search)) return false;
      if (category && vehicle.category !== category) return false;
      if (maxRate > 0 && Number(vehicle.dailyRate) > maxRate) return false;
      return true;
    });
}

function renderCategoryOptions() {
  const select = $("#categoryFilter");
  const current = select.value;
  const categories = [...new Set(state.vehicles.map((vehicle) => vehicle.category).filter(Boolean))].sort();

  select.innerHTML = `<option value="">All categories</option>${categories
    .map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
    .join("")}`;

  if (categories.includes(current)) select.value = current;
}

function renderCustomerCatalog() {
  renderCategoryOptions();
  const vehicles = getFilteredVehicles();
  const grid = $("#customerCarGrid");

  if (vehicles.length === 0) {
    grid.innerHTML = emptyState();
    return;
  }

  grid.innerHTML = vehicles
    .map(
      (vehicle) => `
        <article class="car-card">
          <div class="car-photo">${vehiclePhoto(vehicle)}</div>
          <div class="car-card-body">
            <div class="car-title">
              <strong>${escapeHtml(vehicleLabel(vehicle))}</strong>
              <span class="status-pill available">Available</span>
            </div>
            <div class="car-meta">
              <span>${escapeHtml(vehicle.category)}</span>
              <span>${escapeHtml(vehicle.seats)} seats</span>
              <span>${escapeHtml(vehicle.transmission)}</span>
              <span>${mileage(vehicle.mileage)} mi</span>
            </div>
            <div class="rate-line">
              <span>Daily rate</span>
              <strong>${currency(vehicle.dailyRate)}</strong>
            </div>
            <p class="form-note">Deposit: ${currency(vehicle.depositAmount)} · Pickup: ${escapeHtml(vehicle.locationName)}</p>
            <button class="button primary wide" type="button" data-reserve-vehicle="${vehicle.id}">Reserve</button>
          </div>
        </article>
      `
    )
    .join("");
}

function renderFleetRows() {
  const tbody = $("#fleetRows");

  if (state.vehicles.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6">${emptyState()}</td></tr>`;
    return;
  }

  tbody.innerHTML = state.vehicles
    .map(
      (vehicle) => `
        <tr>
          <td><div class="thumb">${vehiclePhoto(vehicle)}</div></td>
          <td>
            <strong>${escapeHtml(vehicleLabel(vehicle))}</strong>
            <small>${escapeHtml(vehicle.plateNumber || "No plate")} · ${escapeHtml(vehicle.category)} · ${escapeHtml(vehicle.color || "No color")}</small>
          </td>
          <td>
            <strong>${currency(vehicle.dailyRate)}/day</strong>
            <small>Deposit ${currency(vehicle.depositAmount)}</small>
          </td>
          <td><span class="status-pill ${statusClass(vehicle.status)}">${escapeHtml(vehicle.status)}</span></td>
          <td>${vehicle.photos?.length || 0}</td>
          <td>
            <div class="actions">
              <button class="button small secondary" type="button" data-edit-vehicle="${vehicle.id}">Edit</button>
              <button class="button small ghost" type="button" data-photo-vehicle="${vehicle.id}">Add photos</button>
              <button class="button small danger" type="button" data-inactive-vehicle="${vehicle.id}">Inactive</button>
            </div>
          </td>
        </tr>
      `
    )
    .join("");
}

function renderReservationVehicleOptions() {
  const select = $("#reservationVehicle");
  const available = state.vehicles.filter((vehicle) => vehicle.status === "Available");

  if (available.length === 0) {
    select.innerHTML = `<option value="">No available vehicles</option>`;
    return;
  }

  select.innerHTML = available
    .map(
      (vehicle) =>
        `<option value="${vehicle.id}">${escapeHtml(vehicleLabel(vehicle))} - ${currency(vehicle.dailyRate)}/day</option>`
    )
    .join("");
}

function renderReservationRows() {
  const tbody = $("#reservationRows");

  if (state.reservations.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6">No reservations yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = state.reservations
    .map(
      (reservation) => `
        <tr>
          <td><strong>#${escapeHtml(reservation.ReservationID)}</strong></td>
          <td>
            <strong>${escapeHtml(reservation.CustomerName)}</strong>
            <small>${escapeHtml(reservation.CustomerEmail || "")}</small>
          </td>
          <td>
            <strong>${escapeHtml(`${reservation.Year || ""} ${reservation.Make || ""} ${reservation.Model || ""}`.trim())}</strong>
            <small>${escapeHtml(reservation.PlateNumber || "No plate")}</small>
          </td>
          <td>
            <strong>${escapeHtml(new Date(reservation.PickupAt).toLocaleString())}</strong>
            <small>Return: ${escapeHtml(new Date(reservation.ReturnAt).toLocaleString())}</small>
          </td>
          <td>${currency(reservation.EstimatedTotal)}</td>
          <td><span class="status-pill ${statusClass(reservation.Status)}">${escapeHtml(reservation.Status)}</span></td>
        </tr>
      `
    )
    .join("");
}

function renderAll() {
  renderDashboard();
  renderCustomerCatalog();
  renderFleetRows();
  renderReservationVehicleOptions();
  renderReservationRows();
}

function setRoute(route) {
  state.currentRoute = route;

  Object.entries(views).forEach(([name, element]) => {
    element.classList.toggle("active", name === route);
  });

  document.querySelectorAll("[data-route]").forEach((button) => {
    button.classList.toggle("active", button.dataset.route === route);
  });

  const [eyebrow, title] = routeTitles[route] || routeTitles.dashboard;
  $("#pageEyebrow").textContent = eyebrow;
  $("#pageTitle").textContent = title;
}

async function loadVehicles() {
  try {
    const payload = await request("/api/admin/vehicles", { admin: true });
    state.vehicles = payload.vehicles || [];
  } catch (error) {
    // Customer catalog can still work without an admin key.
    if (String(error.message || "").toLowerCase().includes("admin") || String(error.message || "").toLowerCase().includes("key")) {
      const payload = await request("/api/public/vehicles");
      state.vehicles = payload.vehicles || [];
      return;
    }
    throw error;
  }
}

async function loadReservations() {
  try {
    const payload = await request("/api/reservations", { admin: true });
    state.reservations = payload.reservations || [];
  } catch (_error) {
    state.reservations = [];
  }
}

async function refreshData(showMessage = false) {
  try {
    await loadVehicles();
    await loadReservations();
    renderAll();
    $("#apiStatus").textContent = "API connected";
    $("#apiStatus").className = "connection-pill ok";
    if (showMessage) toast("Data refreshed");
  } catch (error) {
    console.error(error);
    $("#apiStatus").textContent = "API error";
    $("#apiStatus").className = "connection-pill bad";
    toast(error.message, "error");
  }
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
    locationName: $("#locationName").value.trim() || "Nashville Office",
    notes: $("#notes").value.trim()
  };
}

function clearVehicleForm() {
  $("#vehicleForm").reset();
  $("#editingVehicleId").value = "";
  $("#seats").value = "5";
  $("#mileage").value = "0";
  $("#depositAmount").value = "250";
  $("#locationName").value = "Nashville Office";
}

async function submitVehicle(event) {
  event.preventDefault();

  const editingId = $("#editingVehicleId").value;
  const vehicle = readVehicleForm();
  const files = [...$("#photos").files];

  try {
    if (editingId) {
      await request(`/api/admin/vehicles/${editingId}`, {
        method: "PATCH",
        admin: true,
        body: JSON.stringify(vehicle)
      });

      if (files.length > 0) {
        const photoData = new FormData();
        files.forEach((file) => photoData.append("photos", file));
        photoData.append("makePrimary", "false");
        await request(`/api/admin/vehicles/${editingId}/photos`, {
          method: "POST",
          admin: true,
          body: photoData,
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
        admin: true,
        body: formData,
        headers: {}
      });

      toast("Vehicle created with photos");
    }

    clearVehicleForm();
    await refreshData();
  } catch (error) {
    toast(error.message, "error");
  }
}

function editVehicle(vehicleId) {
  const vehicle = state.vehicles.find((item) => Number(item.id) === Number(vehicleId));
  if (!vehicle) return;

  $("#editingVehicleId").value = vehicle.id;
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
  $("#status").value = vehicle.status || "Available";
  $("#locationName").value = vehicle.locationName || "Nashville Office";
  $("#notes").value = vehicle.notes || "";

  toast(`Editing ${vehicleLabel(vehicle)}`);
  setRoute("fleet");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function uploadMorePhotos(vehicleId) {
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
        admin: true,
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

async function markInactive(vehicleId) {
  const vehicle = state.vehicles.find((item) => Number(item.id) === Number(vehicleId));
  if (!vehicle) return;

  const confirmed = window.confirm(`Mark ${vehicleLabel(vehicle)} inactive?`);
  if (!confirmed) return;

  try {
    await request(`/api/admin/vehicles/${vehicleId}`, {
      method: "DELETE",
      admin: true
    });
    toast("Vehicle marked inactive");
    await refreshData();
  } catch (error) {
    toast(error.message, "error");
  }
}

function reserveVehicle(vehicleId) {
  $("#reservationVehicle").value = String(vehicleId);
  setRoute("reservations");
  toast("Fill customer details to reserve this car");
}

async function submitReservation(event) {
  event.preventDefault();

  const payload = {
    vehicleId: $("#reservationVehicle").value,
    customerName: $("#customerName").value.trim(),
    customerEmail: $("#customerEmail").value.trim(),
    customerPhone: $("#customerPhone").value.trim(),
    pickupAt: $("#pickupAt").value,
    returnAt: $("#returnAt").value
  };

  try {
    await request("/api/reservations", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    $("#reservationForm").reset();
    toast("Reservation created");
    await refreshData();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function testApi() {
  try {
    const payload = await request("/api/health");
    toast(`API OK: ${payload.service}`);
    $("#apiStatus").textContent = "API connected";
    $("#apiStatus").className = "connection-pill ok";
  } catch (error) {
    toast(error.message, "error");
    $("#apiStatus").textContent = "API error";
    $("#apiStatus").className = "connection-pill bad";
  }
}

function saveSettings() {
  state.apiBase = $("#apiBaseInput").value.trim() || "http://localhost:3000";
  state.adminKey = $("#adminKeyInput").value.trim();
  localStorage.setItem("driveopsApiBase", state.apiBase);
  localStorage.setItem("driveopsAdminKey", state.adminKey);
  toast("Settings saved");
  refreshData();
}

function bindEvents() {
  document.querySelectorAll("[data-route]").forEach((element) => {
    element.addEventListener("click", () => setRoute(element.dataset.route));
  });

  $("#refreshButton").addEventListener("click", () => refreshData(true));
  $("#vehicleForm").addEventListener("submit", submitVehicle);
  $("#clearFormButton").addEventListener("click", clearVehicleForm);
  $("#reservationForm").addEventListener("submit", submitReservation);
  $("#saveSettingsButton").addEventListener("click", saveSettings);
  $("#testApiButton").addEventListener("click", testApi);

  ["#searchInput", "#categoryFilter", "#maxRateFilter"].forEach((selector) => {
    $(selector).addEventListener("input", renderCustomerCatalog);
    $(selector).addEventListener("change", renderCustomerCatalog);
  });

  document.body.addEventListener("click", (event) => {
    const routeButton = event.target.closest("[data-route]");
    if (routeButton) setRoute(routeButton.dataset.route);

    const editButton = event.target.closest("[data-edit-vehicle]");
    if (editButton) editVehicle(editButton.dataset.editVehicle);

    const photoButton = event.target.closest("[data-photo-vehicle]");
    if (photoButton) uploadMorePhotos(photoButton.dataset.photoVehicle);

    const inactiveButton = event.target.closest("[data-inactive-vehicle]");
    if (inactiveButton) markInactive(inactiveButton.dataset.inactiveVehicle);

    const reserveButton = event.target.closest("[data-reserve-vehicle]");
    if (reserveButton) reserveVehicle(reserveButton.dataset.reserveVehicle);
  });
}

function setDefaultReservationDates() {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  now.setHours(now.getHours() + 2);

  const end = new Date(now.getTime());
  end.setDate(end.getDate() + 3);

  const toLocalInput = (date) => {
    const offsetMs = date.getTimezoneOffset() * 60 * 1000;
    return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
  };

  $("#pickupAt").value = toLocalInput(now);
  $("#returnAt").value = toLocalInput(end);
}

function init() {
  $("#apiBaseInput").value = state.apiBase;
  $("#adminKeyInput").value = state.adminKey;
  clearVehicleForm();
  setDefaultReservationDates();
  bindEvents();
  setRoute("dashboard");
  refreshData();
}

init();
