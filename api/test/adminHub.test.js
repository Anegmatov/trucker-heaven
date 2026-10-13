const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createAdminHub } = require("../adminHub");

// The hub's sign-in routes need a food session; without the food module they answer 404 and
// the status route still reports what runs here. Behaviour with real sessions is covered by the
// browser check in the admin rollout (one login opens the parking and rentals staff sites).
function call(server, method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path }, (res) => {
      let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject); req.end();
  });
}

test("admin hub: status lists modules; sign-in routes need the food admin", async () => {
  const hub = createAdminHub({ modules: { parking: {}, rentals: {} }, food: null });
  const server = http.createServer(hub);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const status = await call(server, "GET", "/status");
    assert.equal(status.status, 200); assert.deepEqual(JSON.parse(status.body).modules, ["parking", "rentals"]);
    const parking = await call(server, "POST", "/parking");
    assert.equal(parking.status, 404);
    const logout = await call(server, "POST", "/logout");
    assert.equal(logout.status, 204);
    const nothing = await call(server, "GET", "/nope");
    assert.equal(nothing.status, 404);
  } finally { server.close(); }
});
