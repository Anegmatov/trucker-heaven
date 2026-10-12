'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const files = [
  ...fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.js')).map(entry => path.join(root, entry.name)),
  ...fs.readdirSync(__dirname, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.js')).map(entry => path.join(__dirname, entry.name))
].sort();

if (!files.length) throw new Error('No frontend-admin JavaScript files were found to check.');
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
    process.exit(result.status || 1);
  }
}
console.log(`Checked ${files.length} frontend-admin JavaScript files.`);
