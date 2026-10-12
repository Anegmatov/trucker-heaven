require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../db');
const importer = require('../services/customerImport');

function args(argv) {
  const result = { execute: false, compareProduction: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--execute') result.execute = true;
    else if (value === '--dry-run') result.execute = false;
    else if (value === '--compare-production') result.compareProduction = true;
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

function expectedNumber(value, name) {
  const number = Number(required(value, `${name} is required for execution`));
  if (!Number.isInteger(number) || number < 0) throw new Error(`${name} must be a non-negative whole number`);
  return number;
}

function proposedCounts(report) {
  const plan = report.executionPlan || {};
  const counts = Object.fromEntries([
    'customersCreated', 'customersMatched', 'vehicleRecords', 'legacyParkingRecords',
    'legacyNotes', 'billingPeriods', 'legacyPayments', 'anomalyRecords', 'importedLegacyPaymentCents', 'rowsSkipped'
  ].map(key => [key, Number(plan[key] || 0)]));
  counts.sourceRowsProcessed = Number(plan.importRows || 0);
  return counts;
}

function confirmationComparable(report) {
  const copy = JSON.parse(JSON.stringify(report));
  delete copy.generatedAt;
  return copy;
}

(async () => {
  const options = args(process.argv.slice(2));
  const file = path.resolve(required(options.file, 'Use --file with the legacy workbook path'));
  if (!fs.existsSync(file)) throw new Error('The legacy workbook does not exist');
  const metadata = await importer.fileMetadata(file);
  const rows = await importer.readWorkbook(file);
  const analysis = importer.analyzeRows(rows);
  let productionCompared = false;
  if (options.compareProduction || options.execute) {
    if (!process.env.PARKING_DATABASE_URL) throw new Error('PARKING_DATABASE_URL is required for production comparison');
    const index = await importer.loadProductionIndex(pool);
    importer.compareToProduction(analysis, index);
    productionCompared = true;
  }
  const dryRunReport = importer.report(analysis, metadata, { productionCompared });
  const reportPath = path.resolve(options.report || `customer-import-dry-run-${metadata.sha256.slice(0, 12)}.json`);
  let reportHash = null;
  if (options.execute) {
    if (!fs.existsSync(reportPath)) throw new Error('Execution requires the previously approved dry-run report');
    const approvedReportBytes = fs.readFileSync(reportPath);
    let approvedReport;
    try { approvedReport = JSON.parse(approvedReportBytes); } catch (_) { throw new Error('Approved dry-run report is not valid JSON'); }
    if (JSON.stringify(confirmationComparable(approvedReport)) !== JSON.stringify(confirmationComparable(dryRunReport))) {
      throw new Error('Fresh production comparison no longer matches the approved dry-run report');
    }
    reportHash = crypto.createHash('sha256').update(approvedReportBytes).digest('hex');
  } else {
    fs.writeFileSync(reportPath, `${JSON.stringify(dryRunReport, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  const counts = proposedCounts(dryRunReport);
  console.log(JSON.stringify({
    mode: options.execute ? 'EXECUTION_GATE' : 'DRY_RUN', reportPath,
    workbookSha256: metadata.sha256, sheet: metadata.sheet,
    rowsInspected: dryRunReport.rowsInspected, realCustomerRows: dryRunReport.realCustomerRows,
    matchedExisting: dryRunReport.matchedExisting, newCustomersProposed: dryRunReport.newCustomersProposed,
    ambiguous: dryRunReport.ambiguous, nonCustomerRowsExcluded: dryRunReport.nonCustomerRowsExcluded,
    invalid: dryRunReport.invalid, historicalBillingPeriodsProposed: dryRunReport.historicalBillingPeriodsProposed,
    historicalPaymentRecordsProposed: dryRunReport.historicalPaymentRecordsProposed,
    uncertainPaymentCells: dryRunReport.uncertainPaymentCells,
    nonFinancialLegacyAnomalies: dryRunReport.nonFinancialLegacyAnomalies,
    uniqueLegacyCustomerIdentities: dryRunReport.uniqueLegacyCustomerIdentities,
    sameCustomerAdditionalVehicleOrSpaceRows: dryRunReport.sameCustomerAdditionalVehicleOrSpaceRows,
    sharedCarrierSeparateIdentities: dryRunReport.sharedCarrierSeparateIdentities,
    executionPlan: dryRunReport.executionPlan,
    productionMutationOccurred: false
  }, null, 2));
  if (!options.execute) return;
  const confirmedHash = String(required(options.confirmSha256, '--confirm-sha256 is required for execution')).toLowerCase();
  if (confirmedHash !== metadata.sha256) throw new Error('Confirmed workbook hash does not match the file');
  const adminUserId = Number(required(options.approvedByAdminId, '--approved-by-admin-id is required for execution'));
  if (!Number.isSafeInteger(adminUserId) || adminUserId < 1) throw new Error('Approved admin ID is invalid');
  const expected = Object.fromEntries(Object.keys(counts).map(key => [key,
    expectedNumber(options[`expected${key[0].toUpperCase()}${key.slice(1)}`], `--expected-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`)
  ]));
  if (JSON.stringify(expected) !== JSON.stringify(counts)) throw new Error('Expected mutation counts do not match the dry-run report');
  if (dryRunReport.ambiguous || dryRunReport.invalid || dryRunReport.uncertainPaymentCells) {
    throw new Error('Execution refused: blocking identity, invalid customer, or financial ambiguity remains in the dry run');
  }
  if (!productionCompared) throw new Error('Execution refused: production comparison is required');
  if (String(required(options.confirmReportSha256, '--confirm-report-sha256 is required for execution')).toLowerCase() !== reportHash) {
    throw new Error('Confirmed dry-run report hash does not match');
  }
  const admin = (await pool.query(`SELECT id,username,role,active FROM parking_admin_users WHERE id=$1`, [adminUserId])).rows[0];
  if (!admin || !admin.active || admin.role !== 'OWNER') throw new Error('Import approval requires an active Owner');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const result = await importer.executeImport(client, analysis, metadata, {
      adminUserId: admin.id, initiatedBy: admin.username
    });
    await client.query(`INSERT INTO parking_audit_events(admin_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'CUSTOMER_LEGACY_IMPORT','CUSTOMER_IMPORT_BATCH',$2,$3)`, [
      admin.id, result.batchPublicId, JSON.stringify({ sourceSha256: metadata.sha256, reportSha256: reportHash, ...result })
    ]);
    await client.query('COMMIT');
    console.log(JSON.stringify({ mode: 'EXECUTED', ...result }, null, 2));
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* transaction may not have started */ }
    throw error;
  } finally { client.release(); }
})().catch(error => {
  console.error(JSON.stringify({ event: 'customer_import_failed', message: error.message }));
  process.exitCode = 1;
}).finally(() => pool.end());
