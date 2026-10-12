'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const sourceFiles = [
  'render-runtime.js', 'config.js', 'api.js', 'routes.js', 'admin-core.js',
  'reservation-desk.js', 'advanced.js', 'app.js', 'styles.css', 'advanced.css',
  'reservation-desk.css', 'assets/trucker-heaven-logo-nav.png'
];
const sharedCustomerAssets = Object.freeze({
  'assets/trucker-heaven-logo-nav.png': path.resolve(root, '..', 'public', 'brand', 'trucker-heaven-logo-nav.png')
});
const deploymentKeys = {
  apiBase: 'PARKING_ADMIN_API_BASE',
  customerAppUrl: 'PARKING_ADMIN_CUSTOMER_APP_URL',
  parentSiteUrl: 'PARKING_ADMIN_PARENT_SITE_URL'
};

function buildRuntime() {
  const configured = Object.values(deploymentKeys).filter(key => process.env[key]);
  if (!configured.length) return { buffer: fs.readFileSync(path.join(root, 'render-runtime.js')), source: 'exact-host-map' };
  if (configured.length !== Object.keys(deploymentKeys).length) {
    throw new Error(`Production runtime URL injection is incomplete; provide ${Object.values(deploymentKeys).join(', ')} together.`);
  }
  const values = Object.fromEntries(Object.entries(deploymentKeys).map(([field, key]) => {
    const parsed = new URL(process.env[key]);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${key} must use HTTP or HTTPS.`);
    return [field, parsed.toString().replace(/\/$/, '')];
  }));
  const environment = String(process.env.PARKING_ADMIN_ENVIRONMENT || 'production');
  const source = `(() => {\n  'use strict';\n  window.PARKING_ADMIN_RUNTIME_CONFIG = Object.freeze(${JSON.stringify({ environment, ...values }, null, 2)});\n})();\n`;
  return { buffer: Buffer.from(source), source: 'build-environment' };
}

const runtime = buildRuntime();
const buffers = Object.fromEntries(sourceFiles.map(file => [file, file === 'render-runtime.js' ? runtime.buffer : fs.readFileSync(sharedCustomerAssets[file] || path.join(root, file))]));
const revision = crypto.createHash('sha256').update(sourceFiles.map(file => Buffer.concat([Buffer.from(file), buffers[file]]))
  .reduce((all, item) => Buffer.concat([all, item]), Buffer.alloc(0))).digest('hex').slice(0, 16);
const outputs = Object.fromEntries(sourceFiles.map(file => {
  const extension = path.extname(file);
  const base = path.basename(file, extension);
  const directory = path.dirname(file);
  return [file, path.join(directory === '.' ? '' : directory, `${base}.${revision}${extension}`).replaceAll('\\', '/')];
}));

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
for (const file of sourceFiles) {
  let buffer = buffers[file];
  if (file === 'app.js') buffer = Buffer.from(buffer.toString('utf8').replaceAll('assets/trucker-heaven-logo-nav.png', outputs['assets/trucker-heaven-logo-nav.png']));
  fs.writeFileSync(path.join(output, outputs[file]), buffer);
}
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
for (const [source, destination] of Object.entries(outputs)) html = html.replaceAll(`./${source}`, `./${destination}`).replaceAll(`"${source}"`, `"${destination}"`);
fs.writeFileSync(path.join(output, 'index.html'), html);
fs.writeFileSync(path.join(output, 'parkingops-admin-build.json'), JSON.stringify({
  revision, entrypoint: 'index.html', runtimeConfigurationSource: runtime.source, assets: outputs
}, null, 2));
console.log(`Built canonical ParkingOps admin artifact in dist (revision ${revision}; runtime ${runtime.source}).`);
