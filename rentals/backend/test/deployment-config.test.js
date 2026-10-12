const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const express = require("express");
const fsSync = require("node:fs");

const { createApp } = require("../server");
const { deleteStoredVehiclePhoto, saveUploadedPhotos } = require("../routes/adminVehicles");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const vehicleFilename = "0123456789abcdef0123456789abcdef0123.jpg";

function frontendConfig(relativePath, hostname, overrides = {}) {
  const window = { location: { hostname }, ...overrides };
  vm.runInNewContext(
    fsSync.readFileSync(path.join(repositoryRoot, relativePath), "utf8"),
    { window, URL }
  );
  return window;
}

test("customer runtime URLs retain local behavior and use rental production domains", () => {
  for (const hostname of ["localhost", "127.0.0.1", "0.0.0.0"]) {
    const config = frontendConfig("frontend-customer/config.js", hostname).DriveOpsConfig;
    assert.equal(config.PARENT_SITE_URL, "https://truckerheaven.com");
    assert.equal(config.CUSTOMER_SITE_URL, "http://localhost:5174");
    assert.equal(config.ADMIN_SITE_URL, "http://localhost:5175");
    assert.equal(config.API_BASE, "http://localhost:3000");
  }

  const hosted = frontendConfig("frontend-customer/config.js", "rentals.truckerheaven.com").DriveOpsConfig;
  assert.equal(hosted.PARENT_SITE_URL, "https://truckerheaven.com");
  assert.equal(hosted.CUSTOMER_SITE_URL, "https://rentals.truckerheaven.com");
  assert.equal(hosted.ADMIN_SITE_URL, "https://rentals-admin.truckerheaven.com");
  assert.equal(hosted.API_BASE, "https://rentals-api.truckerheaven.com");
});

test("frontend runtime overrides remain non-secret and malformed values fall back safely", () => {
  const customer = frontendConfig("frontend-customer/config.js", "rentals.truckerheaven.com", {
    DriveOpsRuntimeConfig: { API_BASE: "https://preview-api.example.test/", ADMIN_SITE_URL: "javascript:alert(1)" }
  }).DriveOpsConfig;
  assert.equal(customer.API_BASE, "https://preview-api.example.test");
  assert.equal(customer.ADMIN_SITE_URL, "https://rentals-admin.truckerheaven.com");

  const admin = frontendConfig("frontend-admin/config.js", "rentals-admin.truckerheaven.com").DriveOpsAdminConfig;
  assert.equal(admin.API_BASE, "https://rentals-api.truckerheaven.com");
  const malformedAdmin = frontendConfig("frontend-admin/config.js", "rentals-admin.truckerheaven.com", {
    DriveOpsAdminRuntimeConfig: { API_BASE: "https://preview-api.example.test/?unsafe=true" }
  }).DriveOpsAdminConfig;
  assert.equal(malformedAdmin.API_BASE, "https://rentals-api.truckerheaven.com");
});

function testEnvironment(overrides = {}) {
  return {
    NODE_ENV: "test",
    CORS_ALLOWED_ORIGINS: "http://localhost:5174,http://localhost:5175",
    SESSION_TOKEN_PEPPER: "test-only-pepper",
    ...overrides
  };
}

function routeStubs() {
  return { publicVehicles: express.Router(), adminVehicles: express.Router(), reservations: express.Router() };
}

test("vehicle static serving, stored URLs, and deletion use the configured directory", async () => {
  const uploadDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "driveops-vehicle-storage-"));
  const storageKey = `uploads/vehicles/${vehicleFilename}`;
  try {
    await fs.writeFile(path.join(uploadDirectory, vehicleFilename), "vehicle-photo");
    const app = createApp({
      env: testEnvironment({ VEHICLE_UPLOAD_DIR: uploadDirectory, PUBLIC_BASE_URL: "https://rentals-api.truckerheaven.com/" }),
      routes: routeStubs(),
      database: { query: async () => ({ rows: [], rowCount: 0 }) }
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address();
      const response = await fetch(`http://127.0.0.1:${port}/${storageKey}`);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "vehicle-photo");
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

    const queries = [];
    await saveUploadedPhotos(
      { app, protocol: "http", get: () => "ignored.example.test" },
      { query: async (...args) => queries.push(args) },
      7,
      [{ filename: vehicleFilename }],
      true
    );
    assert.equal(queries[1][1][1], `https://rentals-api.truckerheaven.com/${storageKey}`);
    assert.equal(queries[1][1][2], storageKey);

    assert.equal(await deleteStoredVehiclePhoto(storageKey, uploadDirectory), true);
    await assert.rejects(fs.stat(path.join(uploadDirectory, vehicleFilename)), { code: "ENOENT" });
    assert.equal(await deleteStoredVehiclePhoto("uploads/vehicles/../../private.txt", uploadDirectory), false);
  } finally {
    await fs.rm(uploadDirectory, { recursive: true, force: true });
  }
});
