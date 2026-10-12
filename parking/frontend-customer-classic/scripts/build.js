"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const repository = path.resolve(root, "..");
const output = path.join(root, "dist");
const files = ["index.html", "app.js", "config.js", "customer-core.js", "lifecycle.js", "render-runtime.js", "lot-plan.js", "lot-plan-data.js", "styles.css", "liquid-glass.css", "th-chrome.css", "th-chrome.js"];
const assetSources = new Map([
  ["brand/trucker-heaven-logo-full.png", path.join(repository, "public", "brand", "trucker-heaven-logo-full.png")],
  ["brand/trucker-heaven-logo-nav.png", path.join(repository, "public", "brand", "trucker-heaven-logo-nav.png")],
  ["brand/trucker-heaven-logo.svg", path.join(repository, "public", "brand", "trucker-heaven-logo.svg")],
  ["images/parking-hero.png", path.join(repository, "public", "images", "parking-hero.png")],
  ["images/facility-aerial.jpg", path.join(repository, "public", "images", "facility-aerial.jpg")],
  ["images/parking-sky.jpg", path.join(repository, "public", "images", "parking-sky.jpg")],
  ["images/parking-strip.jpg", path.join(repository, "public", "images", "parking-strip.jpg")],
  ["images/trucker-heaven-aerial.jpg", path.join(root, "assets", "parking", "trucker-heaven-aerial.jpg")],
  // main-site header/footer chrome (th-chrome.css)
  ["assets/logo.svg", path.join(root, "assets", "logo.svg")],
  ...fs.readdirSync(path.join(root, "assets", "fonts")).filter(name => name.endsWith(".woff2")).map(name => [`assets/fonts/${name}`, path.join(root, "assets", "fonts", name)])
]);
const source = Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(root, file), "utf8")]));
const revisionHash = crypto.createHash("sha256").update(files.map(file => `${file}\n${source[file]}`).join("\n"));
for (const [file, sourcePath] of assetSources) revisionHash.update(file).update(fs.readFileSync(sourcePath));
const revision = revisionHash.digest("hex").slice(0, 16);
const outputNames = Object.fromEntries(files.map(file => file === "index.html" ? [file, file] : [file, `${path.basename(file, path.extname(file))}.${revision}${path.extname(file)}`]));
for (const file of assetSources.keys()) outputNames[file] = file;

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
let index = source["index.html"];
for (const file of files.filter(file => file !== "index.html")) {
  index = index.replace(new RegExp(`${file.replace('.', '\\.')}\\?v=[^\"']+`, "g"), outputNames[file]);
  fs.writeFileSync(path.join(output, outputNames[file]), source[file]);
}
if (index.includes("?v=")) throw new Error("Customer entrypoint still contains a mutable asset revision.");
fs.writeFileSync(path.join(output, "index.html"), index);
for (const [file, sourcePath] of assetSources) {
  const destination = path.join(output, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(sourcePath, destination);
}
fs.writeFileSync(path.join(output, "trucker-heaven-parking-build.json"), JSON.stringify({ revision, entrypoint: "index.html", assets: outputNames }, null, 2));
console.log(`Built customer parking artifact in dist (revision ${revision}).`);
