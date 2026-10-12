const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..", "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("public frontend exposes required ordering and lookup controls", () => {
  const app = read("frontend-public/src/App.jsx");
  for (const route of ["/menu", "/catering", "/featured", "/about", "/order", "/order/cart", "/order/details", "/order/review", "/order/view"]) assert.ok(app.includes(`'${route}'`));
  assert.match(app, /order\\\/confirmation|order\\\/status/);
  const review = read("frontend-public/src/pages/order/ReviewOrderPage.jsx");
  assert.match(review, /payOnSiteAccepted: true/);
  assert.match(review, /PAY ON SITE/);
  assert.doesNotMatch(review, /Stripe|card number/i);
});

test("public frontend uses configurable API and local approved assets", () => {
  const api = read("frontend-public/src/lib/foodops.js");
  assert.match(api, /VITE_FOODOPS_API_URL \|\| '\/api\/v1'/);
  assert.match(api, /sessionStorage/);
  assert.match(api, /X-Order-Access-Credential/);
  assert.ok(!api.includes("?accessToken="), "public order credentials must not be placed in URLs");
  assert.match(read("backend/routes/public.js"), /X-Order-Access-Credential/);
  assert.match(read("frontend-public/src/pages/MenuPage.jsx"), /isAvailable|available/);
  assert.match(api, /resolveMediaUrl/);
  assert.match(read("frontend-public/vite.config.js"), /['"]\/uploads['"]/);
  assert.match(read("frontend-public/src/components/MediaImage.jsx"), /onError/);
  assert.doesNotMatch(read("frontend-public/src/pages/MenuPage.jsx"), /referenceByName|item\.imagePath\s*\|\|/);
  assert.ok(fs.existsSync(path.join(root, "frontend-public/public/assets/hero-food.png")));
  assert.doesNotMatch(read("frontend-public/index.html"), /https?:\/\/[^"']+\.(?:png|jpe?g|webp)/i);
});

test("public menu is the single dynamic ordering menu", () => {
  const menu = read("frontend-public/src/pages/MenuPage.jsx");
  const app = read("frontend-public/src/App.jsx");
  const api = read("frontend-public/src/lib/foodops.js");
  assert.match(api, /loadPublicMenu/);
  assert.match(menu, /menuError/);
  assert.match(menu, /categorySlug/);
  assert.match(menu, /SOLD OUT/);
  assert.match(menu, /menu-add-button/);
  assert.doesNotMatch(app + menu, /#order-menu|pages\/order\/OrderPage/);
  assert.doesNotMatch(menu + api, /api\/v1\/admin/);
});

test("admin frontend includes every required view and role-aware users", () => {
  const html = read("frontend-admin/index.html");
  const app = read("frontend-admin/app.js");
  for (const route of ["dashboard", "orders", "catering", "menu", "settings"]) assert.ok(html.includes(`data-route="${route}"`));
  for (const route of ["categories", "gallery", "hours", "users"]) assert.match(app, new RegExp(`\\["${route}"`));
  assert.match(app, /renderSpecials/);
  assert.match(app, /state\.user\?\.role === "OWNER"/);
  assert.match(app, /state\.user\.role !== "OWNER"/);
  assert.match(app, /form\.matches\("#menu-form"\)/);
  assert.doesNotMatch(app, /form\.id\s*===\s*"menu-form"/);
  assert.match(app, /saved=true;clearAlert\(\);await openRoute\("menu"\)/);
  assert.match(app, /slugify/);
  assert.match(app, /data-slug-edited/);
  assert.match(app, /Visible on public menu/);
  assert.match(app, /await openRoute\("categories"\)/);
  assert.match(app, /collectModifierGroups/);
  assert.match(app, /dietaryInformationVerified/);
  assert.match(app, /renderCatering/);
  assert.match(app, /recordDrawerShell/);
  assert.match(read("frontend-admin/styles.css"), /\[hidden\]\{display:none!important\}/);
});

test("responsive CSS provides required desktop-to-mobile adaptations", () => {
  const publicCss = read("frontend-public/src/styles.css");
  assert.match(publicCss, /@media \(max-width: 1120px\)/);
  assert.match(publicCss, /@media \(max-width: 840px\)/);
  assert.match(publicCss, /@media \(max-width: 430px\)/);
  assert.doesNotMatch(publicCss, /overflow-x\s*:\s*hidden/);
  const adminCss = read("frontend-admin/styles.css");
  assert.match(adminCss, /@media\(max-width:1180px\)/);
  assert.match(adminCss, /@media\(max-width:800px\)/);
  assert.match(adminCss, /@media\(max-width:520px\)/);
  assert.doesNotMatch(adminCss, /overflow-x\s*:\s*hidden/);
});
