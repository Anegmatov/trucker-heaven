const { spawnSync } = require("node:child_process");
const path = require("node:path");

const backend = path.join(__dirname, "..", "backend");
const result = spawnSync("npm", ["run", "verify"], { cwd: backend, env: process.env, stdio: "inherit", shell: process.platform === "win32" });
process.exitCode = result.status || 0;
