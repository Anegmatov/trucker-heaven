// Old page addresses (fleet.html?…, vehicle.html?id=…, reservation.html) now live in the single-page site.
// Trip dates and filters carry over; old pickupDate/pickupTime pairs become pickupAt.
(() => {
  "use strict";
  const page = window.location.pathname.split("/").pop();
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id") || "";
  params.delete("id");
  ["pickup", "return"].forEach((end) => {
    const date = params.get(`${end}Date`);
    if (date && !params.has(`${end}At`)) params.set(`${end}At`, `${date}T${params.get(`${end}Time`) || "09:00"}`);
    params.delete(`${end}Date`); params.delete(`${end}Time`);
  });
  const query = params.toString().replace(/%3A/g, ":");
  const path = page === "vehicle.html" && /^\d+$/.test(id) ? `#/v/${id}` : "#/";
  window.location.replace(page === "reservation.html" ? "./#find" : `./${path}${query ? `?${query}` : ""}`);
})();
