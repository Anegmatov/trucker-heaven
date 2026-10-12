"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = ["styles.css", "liquid-glass.css"].map(file => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
for (const marker of ["parking-type-choices", "search-layout", "availability-layout", "review-layout", "duration-options", "property-image-wrap"]) assert.ok(html.includes(marker) || css.includes(marker), `Customer responsive layout is missing ${marker}.`);
for (const marker of ["overflow-x: hidden", "@media (max-width: 980px)", "@media (max-width: 680px)", "grid-template-columns: 1fr", "map-stage", "object-fit: cover", "min-width: 320px"]) assert.ok(css.includes(marker), `Customer responsive stylesheet is missing ${marker}.`);
for (const marker of ["monthly-map-stage", "monthly-selector-head", "map-area-label"]) assert.ok(css.includes(marker), `Customer mobile monthly map is missing ${marker}.`);
for (const marker of ["@media (max-width: 430px)", "@media (max-width: 390px)", ".GlassActionBar", "@supports not ((-webkit-backdrop-filter"]) assert.ok(css.includes(marker), `Customer Liquid Glass responsive layer is missing ${marker}.`);
console.log("Customer responsive structure verified for desktop, tablet, and mobile breakpoints.");
