require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../db');
const customerImport = require('../services/customerImport');
const workbook = require('../services/occupancyWorkbook');
const reconciliation = require('../services/occupancyReconciliation');

function args(argv) {
  const result = { execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--execute') result.execute = true;
    else if (value === '--dry-run') result.execute = false;
    else if (value.startsWith('--')) {
      const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      result[key] = argv[++index];
    }
  }
  return result;
}

function required(value, message) {
  if (value === undefined || value === null || value === '') throw new Error(message);
  return value;
}

(async () => {
  const options = args(process.argv.slice(2));
  const file = path.resolve(required(options.file, 'Use --file with the current XLSX workbook path'));
  if (!fs.existsSync(file)) throw new Error('The occupancy workbook does not exist');
  if (!process.env.PARKING_DATABASE_URL) throw new Error('PARKING_DATABASE_URL is required for occupancy reconciliation');
  const metadata = await customerImport.fileMetadata(file);
  metadata.modifiedAt = fs.statSync(file).mtime.toISOString();
  const classified = await workbook.readAndClassify(file);
  const reportPath = path.resolve(options.report || `occupancy-reconciliation-${metadata.sha256.slice(0, 12)}.json`);
  let approved = null;
  let reportSha256 = null;
  let evaluatedAt = new Date().toISOString();
  if (options.execute) {
    if (!fs.existsSync(reportPath)) throw new Error('Execution requires the exact dry-run report');
    const reportBytes = fs.readFileSync(reportPath);
    approved = JSON.parse(reportBytes);
    reportSha256 = crypto.createHash('sha256').update(reportBytes).digest('hex');
    evaluatedAt = approved.generatedAt;
  }
  const production = await reconciliation.loadProduction(pool, metadata, evaluatedAt);
  const plan = reconciliation.buildPlan(classified, production, metadata, evaluatedAt);
  if (!options.execute) {
    fs.writeFileSync(reportPath, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    console.log(JSON.stringify({ mode: 'DRY_RUN', reportPath, workbook: metadata,
      detectedColors: plan.detectedColors, summary: plan.summary, productionMutationOccurred: false }, null, 2));
    return;
  }
  if (JSON.stringify(approved) !== JSON.stringify(plan)) {
    throw new Error('Fresh production comparison no longer matches the dry-run report');
  }
  if (String(required(options.confirmSha256, '--confirm-sha256 is required')).toLowerCase() !== metadata.sha256) {
    throw new Error('Confirmed workbook hash does not match');
  }
  if (String(required(options.confirmReportSha256, '--confirm-report-sha256 is required')).toLowerCase() !== reportSha256) {
    throw new Error('Confirmed report hash does not match');
  }
  const adminUserId = Number(required(options.approvedByAdminId, '--approved-by-admin-id is required'));
  const admin = (await pool.query('SELECT id,username,role,active FROM parking_admin_users WHERE id=$1', [adminUserId])).rows[0];
  if (!admin || !admin.active || admin.role !== 'OWNER') throw new Error('Execution requires an active Owner');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const result = await reconciliation.executePlan(client, plan, { adminUserId, reportSha256 });
    await client.query(`INSERT INTO parking_audit_events(admin_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'SPREADSHEET_OCCUPANCY_RECONCILIATION','OCCUPANCY_RECONCILIATION_BATCH',$2,$3)`, [
      adminUserId,result.batchPublicId,JSON.stringify({ sourceSha256: metadata.sha256, reportSha256,
        idempotent: result.idempotent, summary: result.summary })]);
    await client.query('COMMIT');
    console.log(JSON.stringify({ mode: 'EXECUTED', ...result }, null, 2));
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* transaction may not have started */ }
    throw error;
  } finally { client.release(); }
})().catch(error => {
  console.error(JSON.stringify({ event: 'occupancy_reconciliation_failed', message: error.message }));
  process.exitCode = 1;
}).finally(() => pool.end());
