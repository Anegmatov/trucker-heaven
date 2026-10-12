const fs = require("fs");
const path = require("path");

const repositoryRoot = path.join(__dirname, "..", "..");
const frontendDirectories = ["frontend-customer", "frontend-admin"];
const errors = [];
let htmlFiles = 0;
let localResources = 0;

function localResourcePath(htmlPath, value) {
  const clean = value.split(/[?#]/, 1)[0];
  if (!clean || clean.startsWith("/") || /^(?:https?:|data:|tel:|mailto:)/i.test(clean)) return null;
  return path.resolve(path.dirname(htmlPath), clean);
}

for (const directory of frontendDirectories) {
  const absoluteDirectory = path.join(repositoryRoot, directory);
  for (const name of fs.readdirSync(absoluteDirectory)) {
    if (!name.endsWith(".html")) continue;
    htmlFiles += 1;
    const htmlPath = path.join(absoluteDirectory, name);
    const source = fs.readFileSync(htmlPath, "utf8");
    const ids = [...source.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicates.length) errors.push(`${directory}/${name}: duplicate IDs ${[...new Set(duplicates)].join(", ")}`);

    for (const match of source.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
      const resource = localResourcePath(htmlPath, match[1]);
      if (!resource) continue;
      localResources += 1;
      if (!fs.existsSync(resource)) errors.push(`${directory}/${name}: missing local resource ${match[1]}`);
    }

    for (const match of source.matchAll(/\baria-describedby=["']([^"']+)["']/g)) {
      for (const referencedId of match[1].trim().split(/\s+/)) {
        if (!ids.includes(referencedId)) errors.push(`${directory}/${name}: aria-describedby references missing #${referencedId}`);
      }
    }
  }
}

const customerApp = fs.readFileSync(path.join(repositoryRoot, "frontend-customer", "app.js"), "utf8");
for (const marker of ["requestForm", "requestError", "X-Reservation-Access-Token", "Idempotency-Key", "/api/public/reservation-access"]) {
  if (!customerApp.includes(marker)) errors.push(`frontend-customer/app.js: missing ${marker}`);
}
for (const forbidden of ["stripe", "checkout-session", "card number"]) {
  if (customerApp.toLowerCase().includes(forbidden)) errors.push(`frontend-customer/app.js: online payment code must not ship (${forbidden})`);
}

if (errors.length) {
  errors.forEach((error) => console.error(`[frontend-check] ${error}`));
  process.exitCode = 1;
} else {
  console.log(`[frontend-check] ${htmlFiles} HTML files and ${localResources} local resource references verified; no duplicate IDs or missing accessibility targets.`);
}
