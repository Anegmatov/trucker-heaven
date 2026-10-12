'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const rootIndex = process.argv.indexOf('--root');
const customRoot = rootIndex >= 0 ? process.argv[rootIndex + 1] : null;
if (rootIndex >= 0 && !customRoot) throw new Error('--root requires a directory');
const mode = customRoot ? 'preview' : process.argv.includes('--dist') ? 'dist' : 'source';
const auditRoot = customRoot ? path.resolve(customRoot) : mode === 'dist' ? path.join(root, 'dist') : root;
const textExtensions = new Set(['.html', '.js', '.css', '.json', '.md', '.txt', '.yaml', '.yml']);

function filesBelow(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (mode === 'source' && entry.name === 'dist') continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(file));
    else files.push(file);
  }
  return files;
}

const files = filesBelow(auditRoot);
const textFiles = files.filter(file => textExtensions.has(path.extname(file).toLowerCase()));
const contents = textFiles.map(file => ({ file, source: fs.readFileSync(file, 'utf8') }));
const combined = contents.map(item => item.source).join('\n');
const signatureFiles = new Set(['privacy-audit.js', 'verify-build.js', 'verify-integration.js']);
const semanticContent = contents.filter(item => !signatureFiles.has(path.basename(item.file))).map(item => item.source).join('\n');
const deployableNames = mode === 'source'
  ? ['index.html', 'render-runtime.js', 'config.js', 'api.js', 'routes.js', 'admin-core.js', 'reservation-desk.js', 'advanced.js', 'app.js', 'styles.css', 'advanced.css', 'reservation-desk.css'].map(file => path.join(root, file))
  : textFiles;
const deployable = deployableNames.filter(file => fs.existsSync(file)).map(file => fs.readFileSync(file, 'utf8')).join('\n');
const adminPersistenceSurface = mode === 'preview'
  ? contents.filter(item => path.relative(auditRoot, item.file).split(path.sep)[0] === 'admin').map(item => item.source).join('\n')
  : deployable;

const emails = [...combined.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)].map(match => match[0]);
const unsafeEmails = emails.filter(value => !/@(?:example\.test|example\.com|example\.org)$/i.test(value));
const phoneCandidates = contents.flatMap(item => [...item.source.matchAll(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g)]
  .map(match => ({ value: match[0], file: item.file, context: item.source.slice(Math.max(0, match.index - 100), match.index + match[0].length + 100) })));
const unsafePhones = phoneCandidates.filter(({ value, file, context }) => {
  // A bare ten-digit integer can be a JavaScript limit such as the maximum
  // setTimeout delay; require phone punctuation or a leading plus sign.
  if (!value.includes('+') && !/[\s().-]/.test(value)) return false;
  const digits = value.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  const exchange = digits.slice(3, 6);
  const subscriber = Number(digits.slice(6));
  const reservedExample = exchange === '555' && subscriber >= 100 && subscriber <= 199;
  const publicSupportConfiguration = /^config(?:\.[a-f0-9]+)?\.js$/i.test(path.basename(file)) && /PARKING_SUPPORT_PHONE/.test(context);
  return !reservedExample && !publicSupportConfiguration;
});

assert.equal(unsafeEmails.length, 0, 'Privacy audit found a non-reserved email literal; matched values are intentionally suppressed.');
assert.equal(unsafePhones.length, 0, 'Privacy audit found a private phone literal; matched values are intentionally suppressed.');
assert.equal(/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|service_role|postgres(?:ql)?:\/\/[^\s"']+|DATABASE_URL\s*=|SESSION_TOKEN_PEPPER\s*=\S{16,}/i.test(semanticContent), false, 'Privacy audit found a credential marker; matched values are intentionally suppressed.');
assert.equal(/(?:\/home\/[^\s"']+|\/Users\/[^\s"']+|[A-Z]:\\Users\\[^\s"']+)/i.test(semanticContent), false, 'Privacy audit found a private workstation path; matched values are intentionally suppressed.');
assert.equal(/localStorage\s*[.\[]|indexedDB\s*[.(\[]|openDatabase\s*\(/i.test(adminPersistenceSurface), false, 'Privacy audit found admin browser record persistence.');
assert.equal(/supabase|anonKey/i.test(deployable), false, 'Privacy audit found a direct database-vendor path.');
assert.equal(/TRUCKER_HEAVEN_INITIAL_|TRUCKER_HEAVEN_EXCEL_SYNC_INFO|legacy-seed-data/i.test(deployable), false, 'Privacy audit found a legacy operational seed marker.');
assert.equal(/sourceMappingURL|\.map["']\s*(?:>|,|})/i.test(semanticContent), false, 'Privacy audit found a source-map reference.');
assert.equal(files.some(file => /legacy-seed-data/i.test(path.basename(file))), false, 'Privacy audit found a legacy seed file.');

console.log(`Admin privacy audit passed (${mode}): ${files.length} files scanned, ${textFiles.length} text files inspected; no private email/phone literals, legacy operational seeds, credentials, private workstation paths, admin browser record persistence, direct database access, or source maps.`);
