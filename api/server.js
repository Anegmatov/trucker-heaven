// Trucker Heaven shared API: one process, one port, three modules routed by hostname.
//
//   parking  -> ../parking/backend   (PARKING_* env)
//   rentals  -> ../rentals/backend   (RENTALS_* env)
//   food     -> ../food/backend      (FOOD_*    env; the module itself reads unprefixed names,
//                                     so this file hands it a FOOD_-stripped view)
//
// Hostname -> module comes from API_HOSTS, e.g.
//   API_HOSTS="parking-api.truckerheaven.com=parking,rentals-api.truckerheaven.com=rentals,food-api.truckerheaven.com=food"
// Defaults cover local development: parking.localhost, rentals.localhost, food.localhost
// (browsers resolve *.localhost to 127.0.0.1 without /etc/hosts). A request whose host matches
// nothing is answered with 404 and the list of known hosts, except /health which always works.

"use strict";
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_HOSTS = "parking.localhost=parking,rentals.localhost=rentals,food.localhost=food";
const ENABLED = String(process.env.API_MODULES || "parking,rentals,food").split(",").map((s) => s.trim()).filter(Boolean);

function prefixedEnv(prefix) {
  const out = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value;
  }
  if (process.env.NODE_ENV && !out.NODE_ENV) out.NODE_ENV = process.env.NODE_ENV;
  return out;
}

// Each loader returns { app, start(), stop() }. Nothing connects to a database until start().
const loaders = {
  parking() {
    const app = require("../parking/backend/app");
    return {
      app,
      async start(log) { await app.init({ log }); app.startBackgroundJobs(); },
      async stop() { await app.close(); }
    };
  },
  rentals() {
    const app = require("../rentals/backend/app");
    const { init, shutdown } = require("../rentals/backend/startup");
    return { app, async start() { await init(); }, async stop() { await shutdown(); } };
  },
  food() {
    const { createApp } = require("../food/backend/server");
    const { loadConfig } = require("../food/backend/lib/config");
    const { createPool } = require("../food/backend/db/connection");
    const { runMigrations } = require("../food/backend/db/migrate");
    const config = loadConfig({ ...prefixedEnv("FOOD_"), PORT: String(PORT) });
    const database = createPool(config);
    const app = createApp({ database, config });
    return {
      app,
      async start() {
        fs.mkdirSync(config.uploadDirectory, { recursive: true });
        fs.mkdirSync(config.temporaryUploadDirectory, { recursive: true });
        await database.query("SELECT 1");
        await runMigrations(database);
      },
      async stop() { await database.end(); }
    };
  }
};

function parseHosts(spec) {
  const map = new Map();
  for (const pair of spec.split(",")) {
    const [host, mod] = pair.split("=").map((s) => s && s.trim().toLowerCase());
    if (host && mod) map.set(host, mod);
  }
  return map;
}

function hostOf(req) {
  const raw = req.headers["x-forwarded-host"] || req.headers.host || "";
  return String(raw).split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
}

function build() {
  const modules = {};
  for (const name of ENABLED) {
    if (!loaders[name]) throw new Error(`Unknown module "${name}" in API_MODULES`);
    modules[name] = loaders[name]();
  }
  const hosts = parseHosts(process.env.API_HOSTS || DEFAULT_HOSTS);
  for (const [host, mod] of hosts) if (!modules[mod]) hosts.delete(host);

  function router(req, res) {
    const mod = hosts.get(hostOf(req));
    if (mod) return modules[mod].app(req, res);
    // Single-link mode: /parking/..., /rentals/..., /food/... on any hostname (e.g. the *.onrender.com URL).
    const prefixed = /^\/(parking|rentals|food)(\/|$)/.exec(req.url);
    if (prefixed && modules[prefixed[1]]) {
      req.url = req.url.slice(prefixed[1].length + 1) || "/";
      return modules[prefixed[1]].app(req, res);
    }
    // Single-module deployments and health checks don't need a hostname.
    if (ENABLED.length === 1) return modules[ENABLED[0]].app(req, res);
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, service: "trucker-heaven-api", modules: ENABLED, hosts: [...hosts.keys()] }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Unknown host", host: hostOf(req), hosts: [...hosts.keys()] }));
  }
  return { modules, hosts, router };
}

async function main() {
  const { modules, hosts, router } = build();
  const log = (msg) => console.log(`[api] ${msg}`);
  for (const [name, mod] of Object.entries(modules)) {
    await mod.start((m) => log(`${name}: ${m}`));
    log(`${name} ready`);
  }
  const server = http.createServer(router);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(PORT, resolve); });
  log(`listening on ${PORT}`);
  for (const [host, mod] of hosts) log(`  ${host} -> ${mod}`);

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received; shutting down`);
    const force = setTimeout(() => process.exit(1), 15000); force.unref();
    server.close(async () => {
      for (const [name, mod] of Object.entries(modules)) {
        await mod.stop().catch((e) => console.error(`[api] ${name} shutdown failed:`, e.message));
      }
      clearTimeout(force);
      process.exit(0);
    });
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}

if (require.main === module) {
  main().catch((error) => { console.error("[api] startup failed:", error.message); process.exit(1); });
}

module.exports = { build, prefixedEnv, parseHosts };
