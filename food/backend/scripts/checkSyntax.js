const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const roots = [path.join(__dirname, ".."), path.join(__dirname, "..", "..", "frontend-public"), path.join(__dirname, "..", "..", "frontend-admin"), path.join(__dirname, "..", "..", "scripts")];
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (entry.name.endsWith(".js")) files.push(target);
  }
}
for (const root of roots) walk(root);
for (const file of [...new Set(files)].sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status || 1); }
}
console.log(`[syntax] ${new Set(files).size} JavaScript files passed`);
