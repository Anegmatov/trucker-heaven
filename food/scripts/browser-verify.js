const fs = require("node:fs/promises");
const path = require("node:path");

const webdriverUrl = process.env.WEBDRIVER_URL || "http://127.0.0.1:4444";
const publicUrl = process.env.PUBLIC_URL || "http://localhost:5190";
const adminUrl = process.env.ADMIN_URL || "http://localhost:5191";
const productPhoto = process.env.PRODUCT_PHOTO;
const screenshotDirectory = process.env.SCREENSHOT_DIRECTORY || "/tmp/foodops-browser";
const elementKey = "element-6066-11e4-a52e-4f735466cecf";

if (!productPhoto) throw new Error("PRODUCT_PHOTO must name a local JPG, PNG, or WEBP for the upload workflow");

let sessionId;
async function command(method, endpoint, body) {
  const response = await fetch(`${webdriverUrl}${endpoint}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok || payload.value?.error) throw new Error(`WebDriver ${method} ${endpoint}: ${payload.value?.message || response.status}`);
  return payload.value;
}
const session = (method, endpoint, body) => command(method, `/session/${sessionId}${endpoint}`, body);
const execute = (script, args = []) => session("POST", "/execute/sync", { script, args });
const navigate = (url) => session("POST", "/url", { url });
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(description, script, args = [], timeout = 12000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try { if (await execute(script, args)) return; } catch (error) { lastError = error; }
    await sleep(120);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

async function setValues(formSelector, values) {
  await execute(`const form=document.querySelector(arguments[0]); if(!form)return false; const values=arguments[1];
    for(const [name,value] of Object.entries(values)){const field=form.elements[name]; if(!field)continue;
      if(field instanceof RadioNodeList){if(value===false)continue;const option=[...field].find((node)=>node.value===String(value));if(option){option.checked=true;option.dispatchEvent(new Event('change',{bubbles:true}));}continue;}
      if(field.type==='checkbox'||field.type==='radio') field.checked=Boolean(value); else field.value=String(value);
      field.dispatchEvent(new Event('input',{bubbles:true})); field.dispatchEvent(new Event('change',{bubbles:true}));}
    return true;`, [formSelector, values]);
}
async function submit(formSelector) {
  const result = await execute(`const form=document.querySelector(arguments[0]); if(!form)return {missing:true};
    const invalid=[...form.elements].filter((field)=>!field.checkValidity()).map((field)=>({name:field.name,message:field.validationMessage,value:field.value}));
    if(invalid.length)return {invalid}; const submitter=form.querySelector('button[type=submit],input[type=submit],button:not([type])');
    if(!submitter)return {missingSubmitter:true}; return {submitted:true,bound:form.dataset.submitBound||''};`, [formSelector]);
  if (result.missing) throw new Error(`Missing form ${formSelector}`);
  if (result.invalid) throw new Error(`Invalid ${formSelector}: ${JSON.stringify(result.invalid)}`);
  if (result.missingSubmitter) throw new Error(`Missing submit button for ${formSelector}`);
  if (["#category-form", "#menu-form"].includes(formSelector) && result.bound !== "true") throw new Error(`Dynamic submit handler was not bound for ${formSelector}`);
  const submitSelector = `${formSelector} button[type=submit],${formSelector} input[type=submit],${formSelector} button:not([type])`;
  await execute("document.querySelector(arguments[0])?.scrollIntoView({block:'center',inline:'center'})", [submitSelector]);
  await nativeClick(submitSelector);
}
async function click(selector) { return execute("const node=document.querySelector(arguments[0]); if(!node)return false; node.click(); return true;", [selector]); }
async function findClick(containerSelector, text, buttonSelector) {
  return execute(`const node=[...document.querySelectorAll(arguments[0])].find((item)=>item.textContent.includes(arguments[1])); const button=node?.querySelector(arguments[2]); if(!button)return false; button.click(); return true;`, [containerSelector, text, buttonSelector]);
}
async function upload(selector, filename) {
  const element = await session("POST", "/element", { using: "css selector", value: selector });
  await session("POST", `/element/${element[elementKey]}/value`, { text: filename, value: [...filename] });
}
async function nativeClick(selector) {
  const element = await session("POST", "/element", { using: "css selector", value: selector });
  await session("POST", `/element/${element[elementKey]}/click`, {});
}
async function login(email, password) {
  await waitFor("login form", "return Boolean(document.querySelector('#login-form') && !document.querySelector('#login-view').hidden)");
  if (await execute("return window.__FOODOPS_ADMIN_BUILD") !== "2026-07-25.1") throw new Error("Firefox loaded a stale FoodOps admin application build");
  await setValues("#login-form", { email, password });
  await submit("#login-form");
  await waitFor("admin shell", "return Boolean(document.querySelector('#app-shell') && !document.querySelector('#app-shell').hidden)", [], 20000);
}
async function route(name) {
  const routeSelector = `[data-route="${name}"]`;
  if (!await execute("return Boolean(document.querySelector('#app-shell') && !document.querySelector('#app-shell').hidden)")) {
    await navigate(adminUrl);
    await waitFor("admin shell after window switch", "return Boolean(document.querySelector('#app-shell') && !document.querySelector('#app-shell').hidden)");
  }
  await waitFor(`admin route ${name}`, "return Boolean(document.querySelector(arguments[0]))", [routeSelector]);
  const clicked = await click(routeSelector);
  if (!clicked) throw new Error(`Missing admin route ${name}`);
  const viewSelector = { categories: "#category-form", menu: "#menu-form", orders: "#order-editor", settings: "#settings-form" }[name];
  await waitFor(`${name} view`, "return location.hash===`#${arguments[0]}` && !document.querySelector('#page-content .loading') && (!arguments[1] || Boolean(document.querySelector(arguments[1])))", [name, viewSelector || ""]);
}
async function lookup(orderNumber, accessToken, expectedStatus) {
  await setValues("#lookup-form", { orderNumber, accessToken });
  await submit("#lookup-form");
  await waitFor(`public order status ${expectedStatus}`, "return document.querySelector('#lookup-result')?.textContent.includes(arguments[0])", [expectedStatus], 10000);
}
async function transition(orderNumber, nextStatus) {
  await execute("window.confirm=()=>true; window.prompt=()=> 'Browser verification reason';");
  const clicked = await click(`[data-transition='${nextStatus}'][data-order-number='${orderNumber}']`);
  if (!clicked) throw new Error(`Missing ${nextStatus} action for ${orderNumber}`);
  await waitFor(`admin status ${nextStatus}`, "return document.querySelector('#order-editor')?.textContent.includes(arguments[0])", [nextStatus === "PREPARING" ? "Preparing" : nextStatus[0] + nextStatus.slice(1).toLowerCase()]);
}
async function screenshot(name) {
  const data = await session("GET", "/screenshot");
  const target = path.join(screenshotDirectory, `${name}.png`);
  await fs.writeFile(target, Buffer.from(data, "base64"));
  return target;
}
async function responsiveAudit(handle, url, application) {
  await session("POST", "/window", { handle });
  const sizes = [[1440,900],[1366,768],[1024,768],[500,844],[390,844]];
  const results = [];
  for (const [width,height] of sizes) {
    await session("POST", "/window/rect", { x: 0, y: 0, width, height });
    await navigate(url);
    await waitFor(`${application} at ${width}`, application === "public" ? "return document.querySelector('#menu-status')?.hidden===true" : "return Boolean(document.querySelector('#app-shell') && !document.querySelector('#app-shell').hidden)");
    if (application === "admin") { await route("settings"); await execute("document.querySelector('#settings-form button[type=submit]')?.scrollIntoView({block:'center'})"); }
    else if (width <= 500) { await click("[data-open-cart]"); await waitFor("mobile cart", "return document.querySelector('#cart-dialog')?.open===true"); await execute("document.querySelector('#place-order')?.scrollIntoView({block:'center'})"); }
    const audit = await execute(`const root=document.documentElement; const broken=[...document.images].filter(i=>i.complete&&i.naturalWidth===0).map(i=>i.src);
      const button=document.querySelector(arguments[0]); const rect=button?.getBoundingClientRect(); return {viewport:innerWidth,scrollWidth:root.scrollWidth,broken,
      targetVisible:!button||Boolean(rect&&rect.top>=0&&rect.bottom<=innerHeight+1),bodyOverflow:getComputedStyle(document.body).overflowX};`, [application === "admin" ? "#settings-form button[type=submit]" : "#place-order"]);
    if (audit.scrollWidth > audit.viewport + 1) throw new Error(`${application} horizontal overflow at ${width}: ${audit.scrollWidth} > ${audit.viewport}`);
    if (audit.broken.length) throw new Error(`${application} broken images at ${width}: ${audit.broken.join(", ")}`);
    if (!audit.targetVisible) throw new Error(`${application} target control unreachable at ${width}`);
    results.push({ width, height, ...audit });
    if (application === "public" && width <= 500) await click("[data-close-dialog]");
    if (width === 1440 || width === 390) await screenshot(`${application}-${width}`);
  }
  return results;
}

async function main() {
  await fs.mkdir(screenshotDirectory, { recursive: true });
  const created = await command("POST", "/session", { capabilities: { alwaysMatch: { browserName: "firefox", acceptInsecureCerts: false, "moz:firefoxOptions": { args: ["-headless"] } } } });
  sessionId = created.sessionId;
  const report = { owner: [], customer: [], staff: [], responsive: {}, screenshots: [] };
  try {
    const adminHandle = await session("GET", "/window");
    await session("POST", "/window/rect", { x: 0, y: 0, width: 1440, height: 900 });
    await navigate(adminUrl);
    await login("owner@truckerheaven.test", "ChangeMe-FoodOps-2026!");
    report.owner.push("login");

    await route("categories");
    await setValues("#category-form", { name: "Browser QA", description: "Created by the real browser workflow", displayOrder: 95, isActive: true });
    await waitFor("generated category slug", "return document.querySelector('#category-form [name=slug]')?.value==='browser-qa'");
    await submit("#category-form");
    await waitFor("new category", "return document.querySelector('#page-content')?.textContent.includes('Browser QA')");
    report.owner.push("create category");

    await route("menu");
    await setValues("#menu-form", { name: "Browser Road Skillet", description: "A browser-verified plate for FoodOps QA.", price: "14.25", displayOrder: 4, imageAlt: "Breakfast skillet used for browser verification", isActive: true, isAvailable: true, isFeatured: true });
    await execute("const s=document.querySelector('#menu-form [name=categoryId]'); const o=[...s.options].find(x=>x.textContent==='Browser QA'); if(!o)return false; s.value=o.value; s.dispatchEvent(new Event('change',{bubbles:true})); return true;");
    await upload("#menu-form input[type=file]", productPhoto);
    await submit("#menu-form");
    await waitFor("new menu item", "return [...document.querySelectorAll('.item-row')].some(x=>x.textContent.includes('Browser Road Skillet'))", [], 15000);
    report.owner.push("create menu item with photograph");

    const publicTab = await session("POST", "/window/new", { type: "tab" });
    const publicHandle = publicTab.handle;
    await navigate(publicUrl);
    await waitFor("public menu", "return document.querySelector('#menu-status')?.hidden===true");
    await waitFor("public browser item", "return document.querySelector('#menu-grid')?.textContent.includes('Browser Road Skillet')");
    report.owner.push("verify public create");

    await session("POST", "/window", { handle: adminHandle });
    await route("menu");
    await findClick(".item-row", "Browser Road Skillet", "[data-edit-menu]");
    await waitFor("menu editor", "return document.querySelector('#menu-form [name=name]')?.value==='Browser Road Skillet'");
    await setValues("#menu-form", { name: "Browser Road Skillet Deluxe", price: "15.50" });
    await submit("#menu-form");
    await waitFor("edited menu item", "return [...document.querySelectorAll('.item-row')].some(x=>x.textContent.includes('Browser Road Skillet Deluxe')&&x.textContent.includes('$15.50'))", [], 15000);
    report.owner.push("edit name and price");

    await session("POST", "/window", { handle: publicHandle });
    await navigate(publicUrl);
    await waitFor("public update", "return document.querySelector('#menu-grid')?.textContent.includes('Browser Road Skillet Deluxe')&&document.querySelector('#menu-grid')?.textContent.includes('$15.50')");

    await session("POST", "/window", { handle: adminHandle });
    await route("menu");
    await findClick(".item-row", "Browser Road Skillet Deluxe", "[data-edit-menu]");
    await waitFor("availability editor", "return document.querySelector('#menu-form [name=isAvailable]')?.checked===true");
    await setValues("#menu-form", { isAvailable: false }); await submit("#menu-form");
    await waitFor("item unavailable", "return [...document.querySelectorAll('.item-row')].some(x=>x.textContent.includes('Browser Road Skillet Deluxe')&&x.textContent.toLowerCase().includes('unavailable'))");
    await session("POST", "/window", { handle: publicHandle }); await navigate(`${publicUrl}/#menu`);
    await waitFor("public unavailable", "return !document.querySelector('#menu-grid')?.textContent.includes('Browser Road Skillet Deluxe')");
    report.owner.push("unavailable hides public item");
    await session("POST", "/window", { handle: adminHandle }); await route("menu"); await findClick(".item-row", "Browser Road Skillet Deluxe", "[data-edit-menu]"); await waitFor("restore editor", "return Boolean(document.querySelector('#menu-form [name=isAvailable]'))"); await setValues("#menu-form", { isAvailable: true }); await submit("#menu-form"); await waitFor("availability restored", "return [...document.querySelectorAll('.item-row')].some(x=>x.textContent.includes('Browser Road Skillet Deluxe')&&x.textContent.includes('Visible on public menu'))");

    await session("POST", "/window", { handle: publicHandle }); await navigate(publicUrl); await waitFor("public ordering menu", "return document.querySelector('#menu-status')?.hidden===true");
    await findClick(".menu-card", "Browser Road Skillet Deluxe", "[data-add-item]");
    await findClick(".menu-card", "Classic Cheeseburger", "[data-add-item]");
    await click("[data-open-cart]"); await waitFor("cart", "return document.querySelector('#cart-dialog')?.open===true");
    await findClick(".cart-row", "Browser Road Skillet Deluxe", "[data-quantity='1']");
    const requested = new Date(Date.now() + 60 * 60 * 1000); requested.setSeconds(0,0);
    await setValues("#checkout-form", { customerName: "Browser Customer", customerPhone: "615-555-0199", customerEmail: "browser@example.test", orderType: false, requestedAt: requested.toISOString().slice(0,16), customerInstructions: "Browser workflow pickup instructions", termsAccepted: true, payOnSiteAccepted: true });
    await execute("document.querySelector('#checkout-form [name=orderType][value=TAKEOUT]').checked=true");
    await submit("#checkout-form");
    await waitFor("order confirmation", "return document.querySelector('#confirmation-dialog')?.open===true", [], 15000);
    const firstOrder = await execute("return {number:document.querySelector('.confirmation-number strong').textContent.trim(),token:document.querySelector('#confirmation-content .credential').textContent.trim(),text:document.querySelector('#confirmation-content').textContent}");
    if (!firstOrder.text.includes("Payment is collected at pickup or on site")) throw new Error("Confirmation payment wording missing");
    report.customer.push("multiple-item takeout order", "quantity change", "confirmation", "saved lookup credential");
    await click("#confirmation-dialog [data-close-dialog]");
    await waitFor("current order control after close", "return !document.querySelector('#current-order')?.hidden && document.querySelector('#current-order')?.textContent.includes(arguments[0])", [firstOrder.number]);
    await click("[data-view-current-order]"); await waitFor("reopened current order", "return document.querySelector('#confirmation-dialog')?.open===true && document.querySelector('#confirmation-content')?.textContent.includes(arguments[0])", [firstOrder.number]);
    await click("#confirmation-dialog [data-close-dialog]");
    await navigate(publicUrl); await waitFor("restored current order after reload", "return !document.querySelector('#current-order')?.hidden && document.querySelector('#current-order')?.textContent.includes(arguments[0]) && !document.querySelector('[data-view-current-order]')?.disabled", [firstOrder.number]);
    await click("[data-view-current-order]"); await waitFor("restored order detail", "return document.querySelector('#confirmation-dialog')?.open===true && document.querySelector('#confirmation-content')?.textContent.includes(arguments[0])", [firstOrder.number]); await click("#confirmation-dialog [data-close-dialog]");
    report.customer.push("close and reopen current order", "refresh restores current order");
    await lookup(firstOrder.number, firstOrder.token, "Pending"); report.customer.push("secure lookup");

    await session("POST", "/window", { handle: adminHandle }); await route("orders"); await findClick(".record-card", firstOrder.number, "[data-order]"); await waitFor("order detail", "return document.querySelector('#order-editor')?.textContent.includes(arguments[0])", [firstOrder.number]);
    for (const [next,label] of [["CONFIRMED","Confirmed"],["PREPARING","Preparing"],["READY","Ready"]]) {
      await transition(firstOrder.number,next);
      await session("POST", "/window", { handle: publicHandle }); await lookup(firstOrder.number, firstOrder.token, label);
      await session("POST", "/window", { handle: adminHandle });
    }
    await execute("window.confirm=()=>true"); await click(`[data-payment-order='${firstOrder.number}']`); await waitFor("paid on site", "return document.querySelector('#order-editor')?.textContent.includes('Paid On Site')");
    await transition(firstOrder.number,"COMPLETED");
    await session("POST", "/window", { handle: publicHandle }); await lookup(firstOrder.number, firstOrder.token, "Completed");
    report.owner.push("confirm, prepare, ready, paid on site, complete"); report.customer.push("status history updates");

    await navigate(publicUrl); await waitFor("second public order menu", "return document.querySelector('#menu-status')?.hidden===true"); await findClick(".menu-card", "Coffee", "[data-add-item]"); await click("[data-open-cart]"); await setValues("#checkout-form", { customerName: "Staff Workflow Customer", customerPhone: "615-555-0188", customerInstructions: "Staff should confirm", termsAccepted: true, payOnSiteAccepted: true }); await submit("#checkout-form"); await waitFor("second confirmation", "return document.querySelector('#confirmation-dialog')?.open===true", [], 15000); const secondOrder=await execute("return {number:document.querySelector('.confirmation-number strong').textContent.trim(),token:document.querySelector('#confirmation-content .credential').textContent.trim()}");
    const savedOrder = await execute("return JSON.parse(localStorage.getItem('foodops_current_order') || 'null')");
    if (savedOrder?.version !== 1 || savedOrder.orderNumber !== secondOrder.number || savedOrder.accessCredential !== secondOrder.token) throw new Error("New order did not replace the current saved order reference");
    report.customer.push("new order replaces current order reference");

    await session("POST", "/window", { handle: adminHandle }); await click("#sign-out"); await waitFor("staff login form", "return !document.querySelector('#login-view').hidden"); await login("staff@truckerheaven.test", "ChangeMe-Staff-2026!"); report.staff.push("login");
    await route("orders"); await findClick(".record-card", secondOrder.number, "[data-order]"); await waitFor("staff order detail", "return document.querySelector('#order-editor')?.textContent.includes(arguments[0])", [secondOrder.number]); await transition(secondOrder.number,"CONFIRMED"); report.staff.push("operate order");
    await route("menu"); await findClick(".item-row", "Browser Road Skillet Deluxe", "[data-edit-menu]"); await waitFor("staff item editor", "return document.querySelector('#menu-form [name=name]')?.value.includes('Browser Road Skillet Deluxe')"); await setValues("#menu-form", { description: "Updated by STAFF during browser verification." }); await submit("#menu-form"); await waitFor("staff item save", "return [...document.querySelectorAll('.item-row')].some(x=>x.textContent.includes('Browser Road Skillet Deluxe'))"); report.staff.push("manage menu item");
    const staffUsersStatus = await execute("return fetch('http://localhost:3011/api/v1/admin/users',{credentials:'include'}).then(r=>r.status)");
    if (staffUsersStatus !== 403) throw new Error(`STAFF users endpoint returned ${staffUsersStatus}, expected 403`); report.staff.push("OWNER-only users denied 403");

    report.responsive.public = await responsiveAudit(publicHandle, publicUrl, "public");
    report.responsive.admin = await responsiveAudit(adminHandle, `${adminUrl}/#settings`, "admin");
    report.screenshots = ["public-1440.png","public-390.png","admin-1440.png","admin-390.png"].map((name)=>path.join(screenshotDirectory,name));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (sessionId) await command("DELETE", `/session/${sessionId}`).catch(() => {});
  }
}

main().catch((error) => { console.error("[browser] failed:", error.stack || error.message); process.exitCode = 1; });
