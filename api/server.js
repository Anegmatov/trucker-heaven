// Trucker Heaven shared API: one process, one port, three modules routed by hostname.
//
//   parking  -> ../parking/backend   (PARKING_* env)
//   rentals  -> ../rentals/backend   (RENTALS_* env)
//   food     -> ../food/backend      (its own unprefixed names, e.g. DATABASE_URL; FOOD_* overrides —
//                                     the live Render service keeps its variables as they are)
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
    // Food keeps its original (unprefixed) variable names so the existing Render service works
    // untouched; FOOD_-prefixed names override them when both are set.
    const config = loadConfig({ ...process.env, ...prefixedEnv("FOOD_"), PORT: String(PORT) });
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

// Modules without their own <MOD>_DATABASE_URL share the instance behind API_DATABASE_URL (or the
// food module's DATABASE_URL), each in a database named after the module. Missing databases are
// created at startup, so one Postgres instance serves every module with no secrets to copy around.
async function resolveDatabases(log) {
  const shared = process.env.API_DATABASE_URL || process.env.DATABASE_URL;
  const wanted = ENABLED.filter((m) => m !== "food").filter((m) => !process.env[`${m.toUpperCase()}_DATABASE_URL`]);
  if (!wanted.length) return;
  if (!shared) throw new Error(`Set ${wanted.map((m) => `${m.toUpperCase()}_DATABASE_URL`).join(", ")} or API_DATABASE_URL`);
  const { Client } = require("pg");
  const base = new URL(shared);
  const ssl = /render\.com$|sslmode=require/.test(shared) ? { rejectUnauthorized: false } : undefined;
  const admin = new Client({ connectionString: shared, ssl });
  await admin.connect();
  try {
    for (const mod of wanted) {
      const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [mod]);
      if (!exists.rowCount) {
        await admin.query(`CREATE DATABASE "${mod}"`);
        log(`created database "${mod}" on the shared instance`);
      }
      const url = new URL(base); url.pathname = `/${mod}`;
      process.env[`${mod.toUpperCase()}_DATABASE_URL`] = url.toString();
      log(`${mod}: using database "${mod}" on the shared instance`);
    }
  } finally {
    await admin.end();
  }
}

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
  const log = (msg) => console.log(`[api] ${msg}`);
  await resolveDatabases(log);
  const { modules, hosts, router } = build();
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
