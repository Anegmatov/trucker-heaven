const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const publicApp = read('frontend-public/src/App.jsx');
const publicApi = read('frontend-public/src/lib/foodops.js');
const publicMenu = read('frontend-public/src/pages/MenuPage.jsx');
const publicMediaImage = read('frontend-public/src/components/MediaImage.jsx');
const viteConfig = read('frontend-public/vite.config.js');
const publicOrder = read('frontend-public/src/pages/order/ReviewOrderPage.jsx');
const publicCss = read('frontend-public/src/styles.css');
const adminHtml = read('frontend-admin/index.html');
const adminJs = read('frontend-admin/app.js');
const adminCss = read('frontend-admin/styles.css');

for (const route of ['/', '/menu', '/catering', '/featured', '/about', '/order', '/order/cart', '/order/details', '/order/review', '/order/view']) {
  assert.ok(publicApp.includes(`'${route}'`), `public route ${route}`);
}
for (const feature of ['Idempotency-Key', 'sessionStorage', 'X-Order-Access-Credential', "'/api/v1'"]) assert.match(publicApi, new RegExp(feature));
for (const feature of ['payOnSiteAccepted', 'termsAccepted', 'PAY ON SITE']) assert.match(publicOrder, new RegExp(feature));
assert.match(publicMenu, /isAvailable|available/);
assert.match(publicMenu, /menu-add-button/);
assert.match(publicApi, /resolveMediaUrl/);
assert.match(viteConfig, /['"]\/uploads['"]/);
assert.doesNotMatch(publicMenu, /referenceByName|item\.imagePath\s*\|\|/);
assert.doesNotMatch(publicApp + publicMenu, /#order-menu|pages\/order\/OrderPage/);
assert.match(publicMediaImage, /onError/);
assert.doesNotMatch(publicApp + publicApi + publicMenu, /src\/admin|api\/v1\/admin/);
for (const route of ['dashboard', 'orders', 'catering', 'menu', 'settings']) assert.match(adminHtml, new RegExp(`data-route=["']${route}["']`));
for (const endpoint of ['/auth/login', '/menu-items', '/categories', '/orders', '/catering-requests', '/specials', '/gallery', '/hours-contact', '/settings', '/users']) assert.ok(adminJs.includes(endpoint), `admin endpoint ${endpoint}`);
assert.match(read('frontend-admin/config.js'), /apiBaseUrl/);
assert.match(read('frontend-admin/config.js'), /publicSiteUrl/);
assert.match(read('frontend-admin/config.js'), /parentSiteUrl/);
assert.match(publicCss, /@media\s*\(max-width:\s*430px\)/);
assert.match(adminCss, /@media\(max-width:520px\)/);
assert.ok(!publicCss.includes('overflow-x:hidden'), 'public CSS must not hide overflow defects');
assert.ok(!adminCss.includes('overflow-x:hidden'), 'admin CSS must not hide overflow defects');
for (const asset of ['frontend-public/public/assets/hero-food.png', 'frontend-public/public/assets/catering-spread.jpg', 'frontend-admin/assets/hero-lounge.png']) {
  assert.ok(fs.statSync(path.join(root, asset)).size > 100, `${asset} must exist`);
}
assert.ok(fs.existsSync(path.join(root, 'frontend-public/dist/index.html')), 'React customer build must exist');
console.log('[frontends] React public and operations admin contracts passed');
