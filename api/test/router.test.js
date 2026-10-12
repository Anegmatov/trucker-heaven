const test = require("node:test");
const assert = require("node:assert/strict");
const { parseHosts, prefixedEnv } = require("../server");

test("parseHosts maps lower-cased hostnames to modules", () => {
  const hosts = parseHosts("Parking-API.truckerheaven.com=parking, rentals.localhost=rentals,bad");
  assert.deepEqual([...hosts], [["parking-api.truckerheaven.com", "parking"], ["rentals.localhost", "rentals"]]);
});

test("prefixedEnv strips the prefix and carries NODE_ENV", () => {
  process.env.ZZZ_DATABASE_URL = "x"; process.env.ZZZ_A = "1"; process.env.NODE_ENV = "test";
  const env = prefixedEnv("ZZZ_");
  assert.equal(env.DATABASE_URL, "x"); assert.equal(env.A, "1"); assert.equal(env.NODE_ENV, "test");
  assert.equal(env.ZZZ_A, undefined);
});
