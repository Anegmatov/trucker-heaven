"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const geometry = require(path.join(root, "lot-geometry.js"));
const canonicalLayout = require(path.join(root, "..", "backend", "data", "trucker-heaven-real-lot-layout.v1.json"));
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "advanced.js"), "utf8");
const css = fs.readFileSync(path.join(root, "advanced.css"), "utf8");
assert.ok(!html.includes('lot-geometry.js') && !app.includes('ParkingLotGeometry'), 'The admin runtime must consume backend layout geometry only.');

const expectedNumbers = [
  ...Array.from({ length: 81 }, (_, index) => index + 10),
  ...Array.from({ length: 96 }, (_, index) => index + 101),
  ...Array.from({ length: 8 }, (_, index) => index + 197)
];
assert.deepEqual(geometry.spaceNumbers, expectedNumbers, "The PDF projection must contain the authoritative 185 spaces and no 91–100 range.");
assert.equal(new Set(geometry.spaceNumbers).size, 185, "Each authoritative space must have exactly one visual element.");

const group = numbers => numbers.map(number => geometry.spaceGeometry(number));
const all = group(expectedNumbers);
assert.ok(all.every(item => item && item.x >= 0 && item.y >= 0 && item.x + item.width <= 100 && item.y + item.height <= 100), "Every projected space must fit inside the portrait map.");
function sourceGeometry(number) {
  const row = canonicalLayout.rows.find(item => number >= item.range[0] && number <= item.range[1]);
  assert.ok(row, `Canonical data is missing space ${number}.`);
  const first = row.numberDirection === 'DESCENDING' ? row.range[1] : row.range[0];
  const index = row.numberDirection === 'DESCENDING' ? first - number : number - first;
  const columns = Number(row.columns || 1);
  const gap = Number(row.gap || 0);
  return {
    number,
    x: Number(row.x) + (index % columns) * (Number(row.width) + gap),
    y: Number(row.y) + Math.floor(index / columns) * Number(row.step || (Number(row.height) + gap)),
    width: Number(row.width), height: Number(row.height), rotation: Number(row.rotation || 0)
  };
}
const normalizedGeometry = value => Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
  typeof item === 'number' ? Math.round(item * 1e9) / 1e9 : item]));
for (const number of expectedNumbers) assert.deepEqual(normalizedGeometry(sourceGeometry(number)), normalizedGeometry(geometry.spaceGeometry(number)), `Canonical data for space ${number} must match the PDF projection.`);
assert.ok(group(Array.from({ length: 32 }, (_, index) => 165 + index)).every(item => item.x < 30), "165–196 must be on the upper-left exterior.");
assert.ok(group(Array.from({ length: 13 }, (_, index) => 60 + index)).every(item => item.x < 20 && item.y > 50), "60–72 must sit below the upper-left exterior run.");
const bobtailRow = group(Array.from({ length: 13 }, (_, index) => 60 + index));
assert.ok(bobtailRow.every((item, index) => item.height < 1.48 && Math.abs(item.y - (57 + index * 1.65)) < 1e-9), "60–72 must retain their anchors while using the shorter Bobtail display preset.");
assert.ok(group([90, 89, 88, 87, 86, 85]).every(item => item.x < 20 && item.y > 79), "90–85 must occupy the lower-left run.");
assert.ok(group(Array.from({ length: 23 }, (_, index) => 37 + index)).every(item => item.x >= 40 && item.x < 50), "37–59 must be the upper-center left column.");
assert.ok(group(Array.from({ length: 23 }, (_, index) => 14 + index)).every(item => item.x >= 50 && item.x < 60), "36–14 must be the upper-center right column.");
assert.ok(group([197, 198, 199, 200, 201, 202, 203, 204, 73, 74, 75, 76, 77, 78, 79, 80]).every(item => item.x >= 38 && item.x < 70 && item.height > 8), "The central paired rows must remain tall vertical bays.");
assert.ok(group(Array.from({ length: 22 }, (_, index) => 143 + index)).every(item => item.x > 80), "164–143 must occupy the upper-right exterior.");
assert.ok(group(Array.from({ length: 32 }, (_, index) => 111 + index)).every(item => item.x > 80 && item.y > 45), "142–111 must occupy the right-side middle run.");
assert.ok(group(Array.from({ length: 10 }, (_, index) => 101 + index)).every(item => item.x > 80 && item.y > 90), "110–101 must occupy the lower-right run.");

for (const retired of [
  "Northbound perimeter flow", "West perimeter drive", "Air circulation", "East north island", "Southbound perimeter drive",
  "Main entrance / check-in", "Trucker Heaven west structure", "West shop barrier", "East company island",
  "Lower boom barrier", "Lower service structure"
]) {
  assert.ok(!html.includes(retired) && !app.includes(retired), `Retired annotation remains in the Lot Setup entrypoint: ${retired}`);
}
assert.equal((html.match(/<h2 id="lotSetupHeading">Advanced Map Tools<\/h2>/g) || []).length, 1, "Advanced Map Tools must have one concise heading.");
assert.ok(!html.includes("Edit Map &amp; Spaces") && !html.includes("Draft map loaded. Customers still see the published version."), "The retired explanatory heading and alert must be absent.");
assert.ok(html.includes("Editing draft") || app.includes(">Editing draft<"), "A compact Editing draft status is required.");
assert.ok(css.includes('.lot-setup-editor') && css.includes('.lot-map-canvas') && css.includes('.lot-map-space'), "Lot Setup must use the consolidated Gold Operations map editor styling.");
assert.ok(html.includes("Select a space to edit.") && html.includes("Shift-click to select more than one."), "The inspector must use the compact empty state and help line.");
for (const marker of ["lotPresentationGeometry", "prepareLotGeometryForEdit", "selectLotSpace", "lotPointerDown", "moveLotSelection", "rotateLotSelection", "undoLotChange", "redoLotChange", "saveLotDraft", "publishLotDraft", "daily_eligible", "monthly_eligible", "lotConfigurationEditable", "lotStructuralEditable", "lotPublishable"]) {
  assert.ok(app.includes(marker), `Lot Setup behavior is no longer wired: ${marker}`);
}
assert.ok(app.includes('name="bookingTerm"') && app.includes('Spaces 110–148 are Daily.'), "The advanced inspector must use one Daily-or-Monthly selection.");
assert.ok(app.includes("function lotPresentationGeometry(item)") && app.includes("return lotStoredGeometry(item);"), "Lot Setup must render the geometry saved in its draft rather than masking a published edit.");
assert.ok(app.includes("const x = Number(element.x), y = Number(element.y), width = Number(element.width), height = Number(element.height);"), "Live Lot must render the geometry saved by Lot Setup.");

console.log("Backend-driven admin geometry verified; legacy 185-space projection remains compatibility-only and is not shipped.");
