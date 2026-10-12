"use strict";

// Builds the static customer site into dist/: scripts and styles get content-hashed names so
// browsers never mix an old app.js with a new index.html; assets/ is copied as-is.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist");
const files = ["index.html", "render-runtime.js", "config.js", "booking-core.js", "lot-plan-data.js", "lot-plan.js", "my-parking.js", "app.js", "styles.css"];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
const assets = walk(path.join(root, "assets")).map(file => path.relative(root, file).split(path.sep).join("/"));

const source = Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(root, file), "utf8")]));
const hash = crypto.createHash("sha256");
for (const file of files) hash.update(`${file}\n${source[file]}\n`);
for (const asset of assets) hash.update(asset).update(fs.readFileSync(path.join(root, asset)));
const revision = hash.digest("hex").slice(0, 16);
const outputNames = Object.fromEntries(files.map(file => [file, file === "index.html" ? file : `${path.basename(file, path.extname(file))}.${revision}${path.extname(file)}`]));

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
let index = source["index.html"];
for (const file of files.filter(name => name !== "index.html")) {
  const pattern = new RegExp(`${file.replace(/[.]/g, "\\.")}\\?v=[^"']+`, "g");
  if (!pattern.test(index)) throw new Error(`index.html does not reference ${file}`);
  index = index.replace(pattern, outputNames[file]);
  fs.writeFileSync(path.join(output, outputNames[file]), source[file]);
}
if (index.includes("?v=")) throw new Error("Customer entrypoint still contains a mutable asset revision.");
fs.writeFileSync(path.join(output, "index.html"), index);
for (const asset of assets) {
  const destination = path.join(output, asset);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, asset), destination);
}
fs.writeFileSync(path.join(output, "trucker-heaven-parking-build.json"), JSON.stringify({ revision, entrypoint: "index.html", assets: outputNames }, null, 2));
console.log(`Built customer parking site in dist (revision ${revision}).`);
