(function () {
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  window.FoodConfig = { API_BASE: (window.FoodRuntimeConfig?.API_BASE || (local ? "http://localhost:3000" : "https://rentals-api.truckerheaven.com")).replace(/\/$/, "") };
})();
