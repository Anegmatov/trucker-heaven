const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { DateTime } = require('luxon');
const { token } = require('../utils');
const ledger = require('./customerLedger');

const SHEET_NAME = 'PARKING PAYMENT MANAGEMENT';
const classifications = Object.freeze([
  'MATCH_EXISTING', 'NEW_CUSTOMER', 'SAME_CUSTOMER_ADDITIONAL_VEHICLE_OR_SPACE',
  'SEPARATE_CUSTOMER_SHARED_CARRIER', 'BLOCKING_IDENTITY_CONFLICT', 'INVALID', 'NON_CUSTOMER'
]);
const customerRowClassifications = new Set([
  'MATCH_EXISTING', 'NEW_CUSTOMER', 'SAME_CUSTOMER_ADDITIONAL_VEHICLE_OR_SPACE',
  'SEPARATE_CUSTOMER_SHARED_CARRIER', 'BLOCKING_IDENTITY_CONFLICT'
]);

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim().replace(/\s+/g, ' ');
}

function displayValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return text(value) || null;
}

function normalizedName(value) {
  return text(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizedPhone(value) {
  const digits = ledger.normalizedDigits(value);
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

function normalizedEmail(value) {
  const email = text(value).toLowerCase().replace(/\s+/g, '');
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function authorityNumbers(value) {
  const source = text(value).toUpperCase();
  const dot = source.match(/(?:USDOT|USDT|USDO|DOT)\s*#?\s*(\d{1,12})/);
  const mc = source.match(/\bMC\s*#?\s*(\d{1,12})/);
  if (!dot && !mc && /^\d{1,12}$/.test(source)) return { usdotNumber: source, mcNumber: null };
  return { usdotNumber: dot?.[1] || null, mcNumber: mc?.[1] || null };
}

function usefulPlate(value) {
  if (value instanceof Date) return null;
  const raw = text(value);
  if (!raw || /^(N\/?A|NO\s*PLT|TEMP\s*TAG|PAID|PAID FULL Y|\.)$/i.test(raw)) return null;
  const normalized = ledger.normalizedPlate(raw);
  return normalized.length >= 2 && /[A-Z]/.test(normalized) ? raw : null;
}

function usefulPlates(value) {
  if (value instanceof Date) return [];
  const raw = text(value);
  if (!raw) return [];
  const parts = raw.split('/').map(part => usefulPlate(part)).filter(Boolean);
  return [...new Set(parts.length ? parts : [usefulPlate(raw)].filter(Boolean))];
}

function usefulUnit(value) {
  const raw = text(value);
  if (!raw || /^(N\/?A|PAID|PAID FULL Y|NO KEY.*)$/i.test(raw)) return null;
  return raw.length <= 80 ? raw : raw.slice(0, 80);
}

function currencyCents(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 5) {
    const cents = Math.round(value * 100);
    return Number.isSafeInteger(cents) ? cents : null;
  }
  const raw = text(value).replaceAll(',', '').replaceAll('$', '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const amount = Number(raw);
  const cents = Math.round(amount * 100);
  return amount > 5 && Number.isSafeInteger(cents) ? cents : null;
}

function monthColumns(headers) {
  const columns = [];
  let latest = null;
  for (let index = 12; index < headers.length; index += 1) {
    const header = headers[index];
    if (text(header).toUpperCase() === '$$') {
      if (columns.length && columns.at(-1).amountColumn === null) columns.at(-1).amountColumn = index;
      continue;
    }
    let month = null;
    if (header instanceof Date && !Number.isNaN(header.getTime())) {
      month = DateTime.fromJSDate(header, { zone: 'utc' }).startOf('month');
    } else {
      const label = text(header).toUpperCase();
      const monthNumber = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
        .findIndex(name => label.startsWith(name)) + 1;
      if (monthNumber && latest) {
        const year = latest.year + (monthNumber <= latest.month ? 1 : 0);
        month = DateTime.utc(year, monthNumber, 1);
      }
    }
    if (month?.isValid) {
      latest = month;
      columns.push({ period: month.toFormat('yyyy-MM'), statusColumn: index, amountColumn: null });
    }
  }
  return columns;
}

function excelColumn(index) {
  let value = index + 1;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + value % 26) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function paymentCell(statusValue, amountValue, rateCents, sourceRef) {
  const status = text(statusValue);
  const amount = text(amountValue);
  if (!status && !amount) return null;
  const combined = [status, amount].filter(Boolean).join(' | ');
  const upper = combined.toUpperCase();
  const anomaly = anomalyType => ({
    confidence: 'NON_FINANCIAL_LEGACY_ANOMALY', paymentAmountCents: null,
    sourceRef, raw: combined, anomalyType
  });
  if (/\bMISSING\b/.test(upper)) return anomaly('LEGACY_NO_RELIABLE_EVIDENCE');
  if (!status && Number(amountValue) === 0) return anomaly('LEGACY_ZERO_WITHOUT_PAYMENT_EVIDENCE');
  const typoPaid = /^PIAD\s*(?:\$\s*)?(\d+(?:\.\d{1,2})?)$/i.exec(status);
  if (typoPaid) {
    const cents = currencyCents(typoPaid[1]);
    if (cents !== null) return {
      confidence: 'EXACT_AMOUNT', paymentAmountCents: cents, sourceRef, raw: combined,
      normalization: 'PIAD_TO_PAID'
    };
  }
  const expression = /\bPAID\s+((?:\d+(?:\.\d{1,2})?\s*\+\s*)+\d+(?:\.\d{1,2})?)/i.exec(status);
  if (expression) {
    const terms = expression[1].split('+').map(value => Number(value.trim()));
    const evaluatedCents = Math.round(terms.reduce((sum, value) => sum + value, 0) * 100);
    const pairedCents = currencyCents(amountValue);
    if (terms.every(Number.isFinite) && Number.isSafeInteger(evaluatedCents) && pairedCents === evaluatedCents) {
      return {
        confidence: 'EXACT_AMOUNT', paymentAmountCents: pairedCents, sourceRef, raw: combined,
        normalization: 'VERIFIED_ADDITION_EXPRESSION'
      };
    }
    return { confidence: 'AMBIGUOUS', paymentAmountCents: null, sourceRef, raw: combined };
  }
  const dueOnly = /NOT\s*PAID|MISS(?:ING)?\s*PAY|OVER\s*DUE|\bDUE\b/.test(upper) && !/\bPAID\b/.test(upper.replace(/NOT\s*PAID/g, ''));
  if (dueOnly) return { confidence: 'EXACT_STATUS_ONLY', paymentAmountCents: null, sourceRef, raw: combined, statusOnly: 'DUE' };
  if (/[+]|\bAND\b|\//.test(upper.replace(/PAID FULL Y/g, ''))) {
    return { confidence: 'AMBIGUOUS', paymentAmountCents: null, sourceRef, raw: combined };
  }
  if (!/PAID|PAID FULL|\bPD\b/i.test(combined) && currencyCents(statusValue) === null && currencyCents(amountValue) === null) {
    return anomaly('LEGACY_UNPARSEABLE');
  }
  const amountCellCents = currencyCents(amountValue);
  if (amountCellCents !== null) return { confidence: 'EXACT_AMOUNT', paymentAmountCents: amountCellCents, sourceRef, raw: combined };
  const statusNumeric = currencyCents(statusValue);
  if (statusNumeric !== null) return { confidence: 'EXACT_AMOUNT', paymentAmountCents: statusNumeric, sourceRef, raw: combined };
  const amounts = [...upper.matchAll(/(?:\$\s*)?(\d+(?:\.\d{1,2})?)/g)]
    .map(match => Number(match[1])).filter(value => value > 5);
  if (amounts.length === 1) {
    return { confidence: 'EXACT_AMOUNT', paymentAmountCents: Math.round(amounts[0] * 100), sourceRef, raw: combined };
  }
  if (amounts.length > 1) return { confidence: 'AMBIGUOUS', paymentAmountCents: null, sourceRef, raw: combined };
  if (/PAID|PAID FULL|\bPD\b/i.test(combined) && Number.isInteger(rateCents)) {
    return { confidence: 'EXACT_STATUS_ONLY', paymentAmountCents: rateCents, sourceRef, raw: combined };
  }
  return anomaly('LEGACY_UNPARSEABLE');
}

function companyLike(name) {
  return /\b(LLC|INC|EXPRESS|TRANSPORT|TRUCKING|LOGISTICS|FLEET|MOTORS|ASSET|ROS+O|IMC)\b|\//i.test(name);
}

function nameTokens(value) {
  const ignored = new Set(['LLC', 'INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'TRUCKING', 'TRANSPORT',
    'EXPRESS', 'LOGISTICS', 'FLEET', 'MOTORS', 'IMC', 'BOOT']);
  return text(value).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').split(' ')
    .filter(tokenValue => tokenValue && !ignored.has(tokenValue) && !/^\d+$/.test(tokenValue));
}

function compatibleNames(left, right) {
  const leftNormalized = normalizedName(left);
  const rightNormalized = normalizedName(right);
  if (!leftNormalized || !rightNormalized) return false;
  if (leftNormalized === rightNormalized) return true;
  const leftTokens = nameTokens(left);
  const rightTokens = nameTokens(right);
  if (Math.min(leftTokens.length, rightTokens.length) < 2) return false;
  const [shorter, longer] = leftTokens.length <= rightTokens.length
    ? [leftTokens, new Set(rightTokens)] : [rightTokens, new Set(leftTokens)];
  return shorter.every(tokenValue => longer.has(tokenValue));
}

function splitPersonName(name) {
  const parts = text(name).split(' ').filter(Boolean);
  if (parts.length < 2) return { firstName: parts[0] || null, lastName: null };
  return { firstName: parts.slice(0, -1).join(' ').slice(0, 80), lastName: parts.at(-1).slice(0, 80) };
}

function classifyBase(row, rowNumber, periods) {
  const spot = displayValue(row[0]);
  const name = text(row[1]);
  const upperName = name.toUpperCase();
  const nonEmpty = row.some(value => text(value));
  if (!nonEmpty) return { sourceRow: rowNumber, classification: 'NON_CUSTOMER', reason: 'Blank row' };
  if (!/^\d+$/.test(String(spot || ''))) return { sourceRow: rowNumber, classification: 'NON_CUSTOMER', reason: 'Operational/header/summary row' };
  if (/^(AVAIL(?:ABLE)?|SHOP|\*|DAILY CUSTOMER|DAILY\s+\d{2}\/|WILL PAY|USDOT\b|COMPANY ACCIDENT)/i.test(name) || !name) {
    return { sourceRow: rowNumber, classification: 'NON_CUSTOMER', reason: 'Availability, shop, daily placeholder, or unlabeled operational row' };
  }
  if (!/[A-Za-z]{2}/.test(name) || /^['"]+$/.test(name) || /^\(?\d[\d\s()+-]+$/.test(name)) {
    return { sourceRow: rowNumber, classification: 'INVALID', reason: 'No reliable customer or company name' };
  }
  const phone = normalizedPhone(row[2]);
  const email = normalizedEmail(row[3]);
  const authority = authorityNumbers(row[5]);
  const rateCents = currencyCents(row[11]);
  const plates = usefulPlates(row[7]);
  const rawLicensePlateCell = displayValue(row[7]);
  const plate = plates.length === 1 ? plates[0] : (plates.length > 1 ? rawLicensePlateCell : null);
  const unitNumber = usefulUnit(row[8]);
  const description = text(row[9]) || null;
  const isCompany = companyLike(name);
  const person = isCompany ? { firstName: null, lastName: null } : splitPersonName(name);
  const paymentPeriods = [];
  for (const period of periods) {
    const sourceColumn = period.amountColumn ?? period.statusColumn;
    const parsed = paymentCell(row[period.statusColumn], period.amountColumn === null ? null : row[period.amountColumn],
      rateCents, `${SHEET_NAME}!${excelColumn(sourceColumn)}${rowNumber}`);
    if (!parsed) continue;
    paymentPeriods.push({
      period: period.period,
      amountDueCents: rateCents ?? parsed.paymentAmountCents,
      ...parsed
    });
  }
  const notes = [text(row[4]), text(row[10])].filter(Boolean).join(' | ') || null;
  const candidate = {
    sourceRow: rowNumber, classification: 'NEW_CUSTOMER', reason: 'No production comparison performed yet',
    spot, displayName: name.slice(0, 160), companyName: isCompany ? name.slice(0, 160) : null,
    ...person, normalizedPhone: phone, displayPhone: displayValue(row[2]),
    normalizedEmail: email, displayEmail: displayValue(row[3]),
    usdotNumber: authority.usdotNumber, mcNumber: authority.mcNumber,
    sourceAuthority: displayValue(row[5]), startDate: row[6] instanceof Date ? row[6].toISOString().slice(0, 10) : null,
    plate, plates, rawLicensePlateCell, unitNumber, vehicleDescription: description,
    rateCents, parkingType: rateCents === 1900 ? 'DAILY' : 'MONTHLY', notes, paymentPeriods
  };
  candidate.sourceFingerprint = crypto.createHash('sha256').update(JSON.stringify(candidate)).digest('hex');
  return candidate;
}

function sameStrongIdentity(left, right) {
  if (!compatibleNames(left.displayName, right.displayName)) return false;
  const samePhone = left.normalizedPhone && left.normalizedPhone === right.normalizedPhone;
  const sameEmail = left.normalizedEmail && left.normalizedEmail === right.normalizedEmail;
  const leftPlates = new Set((left.plates || []).map(ledger.normalizedPlate));
  const samePlate = (right.plates || []).some(plate => leftPlates.has(ledger.normalizedPlate(plate)));
  return Boolean(samePhone || sameEmail || samePlate);
}

function conflictingStrongSignal(left, right) {
  if (compatibleNames(left.displayName, right.displayName)) return [];
  const conflicts = [];
  if (left.normalizedPhone && left.normalizedPhone === right.normalizedPhone) conflicts.push('phone');
  if (left.normalizedEmail && left.normalizedEmail === right.normalizedEmail) conflicts.push('email');
  const leftPlates = new Set((left.plates || []).map(ledger.normalizedPlate));
  if ((right.plates || []).some(plate => leftPlates.has(ledger.normalizedPlate(plate)))) conflicts.push('plate');
  return conflicts;
}

function groupIdentityRecord(members) {
  const byShortestName = [...members].sort((left, right) => nameTokens(left.displayName).length - nameTokens(right.displayName).length
    || left.displayName.length - right.displayName.length || left.sourceRow - right.sourceRow);
  const namedPerson = byShortestName.find(candidate => candidate.firstName && candidate.lastName);
  const companies = members.map(candidate => candidate.companyName).filter(Boolean).sort((left, right) => right.length - left.length);
  const unique = field => {
    const values = [...new Set(members.map(candidate => candidate[field]).filter(Boolean))];
    return values.length === 1 ? values[0] : null;
  };
  const displayCandidate = namedPerson || byShortestName[0];
  const normalizedPhoneValue = unique('normalizedPhone');
  const normalizedEmailValue = unique('normalizedEmail');
  return {
    displayName: displayCandidate.displayName,
    firstName: namedPerson?.firstName || null,
    lastName: namedPerson?.lastName || null,
    companyName: companies[0] || null,
    normalizedPhone: normalizedPhoneValue,
    displayPhone: normalizedPhoneValue
      ? members.find(candidate => candidate.normalizedPhone === normalizedPhoneValue)?.displayPhone || null : null,
    normalizedEmail: normalizedEmailValue,
    displayEmail: normalizedEmailValue
      ? members.find(candidate => candidate.normalizedEmail === normalizedEmailValue)?.displayEmail || null : null,
    usdotNumber: unique('usdotNumber'), mcNumber: unique('mcNumber'),
    parkingType: members.every(candidate => candidate.parkingType === members[0].parkingType) ? members[0].parkingType : 'IN_PERSON',
    spot: members[0].spot, rateCents: members[0].rateCents
  };
}

function analyzeRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Workbook sheet is empty');
  const periods = monthColumns(rows[0]);
  if (!periods.length) throw new Error('No monthly payment columns were found');
  const candidates = rows.slice(1).map((row, index) => classifyBase(row, index + 2, periods));
  const customerCandidates = candidates.filter(candidate => candidate.classification === 'NEW_CUSTOMER');
  const parent = new Map(customerCandidates.map(candidate => [candidate.sourceRow, candidate.sourceRow]));
  const find = row => {
    let current = row;
    while (parent.get(current) !== current) current = parent.get(current);
    let cursor = row;
    while (parent.get(cursor) !== cursor) {
      const next = parent.get(cursor); parent.set(cursor, current); cursor = next;
    }
    return current;
  };
  const union = (left, right) => {
    const leftRoot = find(left); const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(Math.max(leftRoot, rightRoot), Math.min(leftRoot, rightRoot));
  };
  const blockingRows = new Map();
  for (let leftIndex = 0; leftIndex < customerCandidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < customerCandidates.length; rightIndex += 1) {
      const left = customerCandidates[leftIndex]; const right = customerCandidates[rightIndex];
      if (sameStrongIdentity(left, right)) union(left.sourceRow, right.sourceRow);
      else {
        const conflicts = conflictingStrongSignal(left, right);
        if (conflicts.length) {
          for (const candidate of [left, right]) {
            if (!blockingRows.has(candidate.sourceRow)) blockingRows.set(candidate.sourceRow, new Set());
            conflicts.forEach(signal => blockingRows.get(candidate.sourceRow).add(signal));
          }
        }
      }
    }
  }
  const groups = new Map();
  for (const candidate of customerCandidates) {
    const root = find(candidate.sourceRow);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(candidate);
  }
  const carrierGroups = new Map();
  const addCarrier = (kind, value, groupId) => {
    if (!value) return;
    const key = `${kind}:${value}`;
    if (!carrierGroups.has(key)) carrierGroups.set(key, new Set());
    carrierGroups.get(key).add(groupId);
  };
  for (const [groupId, members] of groups) {
    for (const candidate of members) {
      addCarrier('dot', candidate.usdotNumber, groupId);
      addCarrier('mc', candidate.mcNumber, groupId);
    }
  }
  for (const [groupId, members] of groups) {
    members.sort((left, right) => left.sourceRow - right.sourceRow);
    const primary = members[0];
    const sharedCarrierKeys = [...carrierGroups.entries()]
      .filter(([, groupIds]) => groupIds.size > 1 && groupIds.has(groupId)).map(([key]) => key);
    const groupBlocking = members.flatMap(candidate => [...(blockingRows.get(candidate.sourceRow) || [])]);
    for (const [index, candidate] of members.entries()) {
      candidate.identityGroupId = `legacy-row-${primary.sourceRow}`;
      candidate.identityPrimarySourceRow = primary.sourceRow;
      candidate.possibleSourceRows = members.map(member => member.sourceRow);
      candidate.sharedCarrierSignals = sharedCarrierKeys;
      if (groupBlocking.length) {
        candidate.classification = 'BLOCKING_IDENTITY_CONFLICT';
        candidate.reason = `Exact ${[...new Set(groupBlocking)].join(', ')} is shared by incompatible names`;
      } else if (index > 0) {
        candidate.classification = 'SAME_CUSTOMER_ADDITIONAL_VEHICLE_OR_SPACE';
        candidate.reason = `Same compatible name and exact direct identity signal as source row ${primary.sourceRow}`;
      } else if (sharedCarrierKeys.length) {
        candidate.classification = 'SEPARATE_CUSTOMER_SHARED_CARRIER';
        candidate.reason = 'Separate direct identity; DOT/MC is shared only as carrier metadata';
      } else {
        candidate.classification = 'NEW_CUSTOMER';
        candidate.reason = 'Unique direct workbook identity; no production comparison performed yet';
      }
    }
    primary.identityRecord = groupIdentityRecord(members);
  }
  return { sheet: SHEET_NAME, rowsInspected: rows.length - 1, periods, candidates, identityGroups: groups };
}

async function readWorkbook(file) {
  const { readSheet } = await import('read-excel-file/node');
  return readSheet(file, { sheet: SHEET_NAME });
}

async function fileMetadata(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return { filename: path.basename(file), sha256: hash.digest('hex'), sheet: SHEET_NAME };
}

async function loadProductionIndex(client) {
  const [customers, vehicles, periods] = await Promise.all([
    client.query(`SELECT id,public_id,display_name,company_name,first_name,last_name,normalized_phone,normalized_email,
      usdot_number,mc_number FROM parking_customers`),
    client.query(`SELECT customer_id,license_plate FROM parking_customer_vehicles WHERE license_plate IS NOT NULL`),
    client.query(`SELECT customer_id,to_char(period_start,'YYYY-MM') period FROM parking_customer_billing_periods`)
  ]);
  const bySignal = new Map();
  const add = (kind, value, id) => {
    if (!value) return;
    const key = `${kind}:${value}`;
    if (!bySignal.has(key)) bySignal.set(key, new Set());
    bySignal.get(key).add(Number(id));
  };
  const names = new Map();
  for (const customer of customers.rows) {
    add('phone', customer.normalized_phone, customer.id);
    add('email', customer.normalized_email, customer.id);
    add('dot', customer.usdot_number, customer.id);
    add('mc', customer.mc_number, customer.id);
    names.set(Number(customer.id), [...new Set([
      customer.display_name, customer.company_name,
      [customer.first_name, customer.last_name].filter(Boolean).join(' ')
    ].filter(Boolean))]);
  }
  for (const vehicle of vehicles.rows) add('plate', ledger.normalizedPlate(vehicle.license_plate), vehicle.customer_id);
  return {
    customers: new Map(customers.rows.map(row => [Number(row.id), row])), bySignal, names,
    periods: new Set(periods.rows.map(row => `${Number(row.customer_id)}:${row.period}`))
  };
}

function compareToProduction(analysis, index) {
  const groups = new Map();
  for (const candidate of analysis.candidates.filter(row => customerRowClassifications.has(row.classification))) {
    if (!groups.has(candidate.identityGroupId)) groups.set(candidate.identityGroupId, []);
    groups.get(candidate.identityGroupId).push(candidate);
  }
  const productionNames = id => {
    const value = index.names.get(id);
    return Array.isArray(value) ? value : [value].filter(Boolean);
  };
  for (const members of groups.values()) {
    if (members.some(candidate => candidate.classification === 'BLOCKING_IDENTITY_CONFLICT')) continue;
    const primary = members.find(candidate => candidate.sourceRow === candidate.identityPrimarySourceRow) || members[0];
    const matches = new Set();
    const incompatibleDirectMatches = new Set();
    const signals = [];
    const add = (candidate, kind, value) => {
      if (!value) return;
      const ids = index.bySignal.get(`${kind}:${value}`) || new Set();
      for (const id of ids) {
        if (productionNames(id).some(name => compatibleNames(candidate.displayName, name))) {
          matches.add(id); signals.push(`${kind}:${id}`);
        } else incompatibleDirectMatches.add(id);
      }
    };
    for (const candidate of members) {
      add(candidate, 'phone', candidate.normalizedPhone);
      add(candidate, 'email', candidate.normalizedEmail);
      for (const plate of candidate.plates || []) add(candidate, 'plate', ledger.normalizedPlate(plate));
    }
    const allDirectIds = new Set([...matches, ...incompatibleDirectMatches]);
    if (matches.size > 1 || incompatibleDirectMatches.size) {
      for (const candidate of members) {
        candidate.classification = 'BLOCKING_IDENTITY_CONFLICT';
        candidate.reason = incompatibleDirectMatches.size
          ? 'An exact production phone/email/plate belongs to an incompatible customer name'
          : 'Exact production direct identity signals point to multiple canonical customers';
        candidate.possibleCustomerPublicIds = [...allDirectIds]
          .map(id => index.customers.get(id)?.public_id).filter(Boolean);
      }
      continue;
    }
    if (matches.size === 1) {
      const id = [...matches][0];
      const overlap = members.flatMap(candidate => candidate.paymentPeriods || [])
        .filter(period => index.periods.has(`${id}:${period.period}`));
      if (overlap.length) {
        for (const candidate of members) {
          candidate.classification = 'BLOCKING_IDENTITY_CONFLICT';
          candidate.reason = 'Legacy payment periods overlap an existing canonical billing ledger';
          candidate.matchedCustomerId = id;
          candidate.possibleCustomerPublicIds = [index.customers.get(id)?.public_id].filter(Boolean);
          candidate.overlappingPeriods = [...new Set(overlap.map(period => period.period))];
        }
      } else {
        for (const candidate of members) {
          candidate.matchedCustomerId = id;
          candidate.matchedCustomerPublicId = index.customers.get(id)?.public_id;
          if (candidate === primary) {
            candidate.classification = 'MATCH_EXISTING';
            candidate.reason = `Compatible name plus exact production ${[...new Set(signals.map(signal => signal.split(':')[0]))].join(', ')}`;
          }
        }
      }
    } else if (primary.classification === 'NEW_CUSTOMER') primary.reason = 'No compatible-name direct production identity signal matched';
  }
  return analysis;
}

function executionPlan(analysis) {
  const real = analysis.candidates.filter(row => customerRowClassifications.has(row.classification));
  const accepted = real.filter(row => row.classification !== 'BLOCKING_IDENTITY_CONFLICT');
  const primaries = real.filter(row => row.sourceRow === row.identityPrimarySourceRow);
  const parsedPeriods = accepted.flatMap(row => row.paymentPeriods || []);
  const exactPeriods = parsedPeriods.filter(period => ['EXACT_AMOUNT', 'EXACT_STATUS_ONLY'].includes(period.confidence));
  const anomalies = parsedPeriods.filter(period => period.confidence === 'NON_FINANCIAL_LEGACY_ANOMALY');
  const financialBlocking = parsedPeriods.filter(period => period.confidence === 'AMBIGUOUS');
  const vehicleRecords = accepted.reduce((total, row) => total
    + ((row.plates || []).length || (row.unitNumber || row.vehicleDescription ? 1 : 0)), 0);
  return {
    uniqueLegacyCustomerIdentities: primaries.length,
    customersCreated: primaries.filter(row => ['NEW_CUSTOMER', 'SEPARATE_CUSTOMER_SHARED_CARRIER'].includes(row.classification)).length,
    customersMatched: primaries.filter(row => row.classification === 'MATCH_EXISTING').length,
    additionalVehicleOrSpaceRows: accepted.filter(row => row.classification === 'SAME_CUSTOMER_ADDITIONAL_VEHICLE_OR_SPACE').length,
    sharedCarrierSeparateIdentities: primaries.filter(row => (row.sharedCarrierSignals || []).length > 0).length,
    blockingIdentityConflictGroups: new Set(real.filter(row => row.classification === 'BLOCKING_IDENTITY_CONFLICT')
      .map(row => row.identityGroupId)).size,
    blockingIdentityConflictRows: real.filter(row => row.classification === 'BLOCKING_IDENTITY_CONFLICT').length,
    vehicleRecords, legacyParkingRecords: accepted.length,
    legacyNotes: accepted.filter(row => row.notes).length,
    billingPeriods: exactPeriods.length,
    legacyPayments: exactPeriods.filter(period => period.paymentAmountCents !== null).length,
    anomalyRecords: anomalies.length,
    blockingFinancialCells: financialBlocking.length,
    importedLegacyPaymentCents: exactPeriods.reduce((total, period) => total + Number(period.paymentAmountCents || 0), 0),
    sourceCustomerRows: real.length, importRows: analysis.candidates.length,
    rowsSkipped: analysis.candidates.filter(row => ['NON_CUSTOMER', 'INVALID'].includes(row.classification)).length
  };
}

function report(analysis, metadata, { productionCompared = false } = {}) {
  const count = name => analysis.candidates.filter(row => row.classification === name).length;
  const real = analysis.candidates.filter(row => customerRowClassifications.has(row.classification));
  const parsedPeriods = real.flatMap(row => row.paymentPeriods || []);
  const anomalies = parsedPeriods.filter(period => period.confidence === 'NON_FINANCIAL_LEGACY_ANOMALY');
  const financialBlocking = parsedPeriods.filter(period => period.confidence === 'AMBIGUOUS');
  const plan = executionPlan(analysis);
  return {
    reportVersion: 2,
    generatedAt: new Date().toISOString(),
    workbook: metadata,
    productionCompared,
    productionMutationOccurred: false,
    rowsInspected: analysis.rowsInspected,
    realCustomerRows: real.length,
    matchedExisting: count('MATCH_EXISTING'),
    uniqueLegacyCustomerIdentities: plan.uniqueLegacyCustomerIdentities,
    newCustomersProposed: plan.customersCreated,
    sameCustomerAdditionalVehicleOrSpaceRows: plan.additionalVehicleOrSpaceRows,
    sharedCarrierSeparateIdentities: plan.sharedCarrierSeparateIdentities,
    ambiguous: plan.blockingIdentityConflictGroups,
    blockingIdentityConflictRows: plan.blockingIdentityConflictRows,
    invalid: count('INVALID'),
    nonCustomerRowsExcluded: count('NON_CUSTOMER'),
    historicalBillingPeriodsProposed: plan.billingPeriods,
    historicalPaymentRecordsProposed: plan.legacyPayments,
    uncertainPaymentCells: plan.blockingFinancialCells,
    nonFinancialLegacyAnomalies: plan.anomalyRecords,
    importedLegacyPaymentCents: plan.importedLegacyPaymentCents,
    executionPlan: plan,
    classifications: analysis.candidates.map(row => ({
      sourceRow: row.sourceRow, classification: row.classification, reason: row.reason,
      identityGroupId: row.identityGroupId, identityPrimarySourceRow: row.identityPrimarySourceRow,
      displayName: row.displayName, spot: row.spot, phone: row.displayPhone, email: row.displayEmail,
      usdotNumber: row.usdotNumber, mcNumber: row.mcNumber, plate: row.plate, unitNumber: row.unitNumber,
      matchedCustomerPublicId: row.matchedCustomerPublicId,
      possibleCustomerPublicIds: row.possibleCustomerPublicIds,
      possibleSourceRows: row.possibleSourceRows, sharedCarrierSignals: row.sharedCarrierSignals,
      overlappingPeriods: row.overlappingPeriods,
      proposedBillingPeriods: (row.paymentPeriods || []).map(period => ({ period: period.period,
        amountDueCents: period.amountDueCents, paymentAmountCents: period.paymentAmountCents,
        confidence: period.confidence, sourceRef: period.sourceRef, raw: period.raw,
        anomalyType: period.anomalyType, normalization: period.normalization }))
    }))
  };
}

async function executeImport(client, analysis, metadata, { adminUserId, initiatedBy }) {
  const plan = executionPlan(analysis);
  if (plan.blockingIdentityConflictGroups || plan.blockingFinancialCells) {
    throw new Error('Import execution requires zero blocking identity and financial conflicts');
  }
  const batch = (await client.query(`INSERT INTO parking_customer_import_batches(
      public_id,source_filename,source_sha256,source_sheet,status,initiated_by_admin_user_id,initiated_by,rows_considered)
    VALUES($1,$2,$3,$4,'RUNNING',$5,$6,$7) RETURNING *`, [
    `imp_${token(24)}`, metadata.filename, metadata.sha256, metadata.sheet,
    adminUserId, initiatedBy, analysis.rowsInspected
  ])).rows[0];
  const actual = {
    customersCreated: 0, customersMatched: 0, vehicleRecords: 0, legacyParkingRecords: 0,
    legacyNotes: 0, billingPeriods: 0, legacyPayments: 0, anomalyRecords: 0, importedLegacyPaymentCents: 0,
    rowsSkipped: 0, sourceRowsProcessed: 0
  };
  const customerIds = new Map();
  const primaries = analysis.candidates.filter(candidate => customerRowClassifications.has(candidate.classification)
    && candidate.sourceRow === candidate.identityPrimarySourceRow);
  for (const candidate of primaries) {
    const identity = candidate.identityRecord || candidate;
    let customerId = candidate.matchedCustomerId || null;
    if (['NEW_CUSTOMER', 'SEPARATE_CUSTOMER_SHARED_CARRIER'].includes(candidate.classification)) {
      const customer = (await client.query(`INSERT INTO parking_customers(
          public_id,first_name,last_name,display_name,company_name,normalized_phone,display_phone,
          normalized_email,display_email,usdot_number,mc_number,status,lifecycle_status,record_source,
          legacy_import_batch_id,legacy_source_ref,legacy_parking_type,legacy_current_spot,legacy_rate_cents,imported_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING','ACTIVE','LEGACY_EXCEL_IMPORT',
          $12,$13,$14,$15,$16,now()) RETURNING id`, [
        `cust_${token(24)}`, identity.firstName, identity.lastName, identity.displayName,
        identity.companyName, identity.normalizedPhone, identity.displayPhone,
        identity.normalizedEmail, identity.displayEmail, identity.usdotNumber, identity.mcNumber,
        batch.id, `${SHEET_NAME}!A${candidate.sourceRow}`, identity.parkingType,
        identity.spot, identity.rateCents
      ])).rows[0];
      customerId = Number(customer.id); actual.customersCreated += 1;
    } else if (candidate.classification === 'MATCH_EXISTING') {
      await client.query(`UPDATE parking_customers SET
          company_name=COALESCE(company_name,$2),usdot_number=COALESCE(usdot_number,$3),mc_number=COALESCE(mc_number,$4)
        WHERE id=$1`, [customerId, identity.companyName, identity.usdotNumber, identity.mcNumber]);
      actual.customersMatched += 1;
    }
    if (!customerId) throw new Error(`Customer identity group ${candidate.identityGroupId} has no execution target`);
    customerIds.set(candidate.identityGroupId, customerId);
  }
  for (const candidate of analysis.candidates) {
    if (['NON_CUSTOMER', 'INVALID'].includes(candidate.classification)) actual.rowsSkipped += 1;
    const customerId = customerIds.get(candidate.identityGroupId) || candidate.matchedCustomerId || null;
    let firstVehicleId = null;
    if (customerId && ((candidate.plates || []).length || candidate.unitNumber || candidate.vehicleDescription)) {
      const vehiclePlates = (candidate.plates || []).length ? candidate.plates : [null];
      for (const [plateIndex, plate] of vehiclePlates.entries()) {
        const vehicle = (await client.query(`INSERT INTO parking_customer_vehicles(
          public_id,customer_id,unit_number,license_plate,license_plate_state,vehicle_classification,
          vehicle_description,record_source,legacy_import_batch_id,legacy_source_ref)
        VALUES($1,$2,$3,$4,NULL,'GENERAL',$5,'LEGACY_EXCEL_IMPORT',$6,$7) RETURNING id`, [
          `veh_${token(24)}`, customerId, plateIndex === 0 ? candidate.unitNumber : null, plate,
          candidate.vehicleDescription, batch.id, `${SHEET_NAME}!H${candidate.sourceRow}:J${candidate.sourceRow}${vehiclePlates.length > 1 ? `:${plateIndex + 1}` : ''}`
        ])).rows[0];
        if (firstVehicleId === null) firstVehicleId = Number(vehicle.id);
        actual.vehicleRecords += 1;
      }
    }
    if (customerId) {
      await client.query(`INSERT INTO parking_customer_legacy_parking_records(
          public_id,customer_id,vehicle_id,import_batch_id,source_row,source_ref,spot_label,start_date,
          parking_type,rate_cents,license_plate,unit_number,vehicle_description,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [
        `lpr_${token(24)}`, customerId, firstVehicleId, batch.id, candidate.sourceRow,
        `${SHEET_NAME}!A${candidate.sourceRow}:L${candidate.sourceRow}`, candidate.spot, candidate.startDate,
        candidate.parkingType, candidate.rateCents, candidate.plate, candidate.unitNumber,
        candidate.vehicleDescription, JSON.stringify({ authority: candidate.sourceAuthority, plates: candidate.plates || [],
          rawLicensePlateCell: candidate.rawLicensePlateCell })
      ]);
      actual.legacyParkingRecords += 1;
    }
    if (customerId && candidate.notes) {
      await client.query(`INSERT INTO parking_customer_notes(
          public_id,customer_id,note,legacy_import_batch_id,legacy_source_ref)
        VALUES($1,$2,$3,$4,$5)`, [`note_${token(24)}`, customerId, candidate.notes,
        batch.id, `${SHEET_NAME}!E${candidate.sourceRow}:K${candidate.sourceRow}`]);
      actual.legacyNotes += 1;
    }
    if (customerId) {
      for (const period of candidate.paymentPeriods || []) {
        if (period.confidence === 'AMBIGUOUS') {
          throw new Error(`Blocking financial ambiguity remains at ${period.sourceRef}`);
        }
        if (period.confidence === 'NON_FINANCIAL_LEGACY_ANOMALY') {
          await client.query(`INSERT INTO parking_customer_legacy_anomalies(
              public_id,customer_id,import_batch_id,source_row,source_ref,period_start,classification,
              anomaly_type,raw_value,financial_effect,metadata)
            VALUES($1,$2,$3,$4,$5,$6,'NON_FINANCIAL_LEGACY_ANOMALY',$7,$8,false,$9)`, [
            `lan_${token(24)}`, customerId, batch.id, candidate.sourceRow, period.sourceRef,
            `${period.period}-01`, period.anomalyType, period.raw,
            JSON.stringify({ paymentAmountCents: null, normalization: period.normalization || null })
          ]);
          actual.anomalyRecords += 1;
          continue;
        }
        if (!['EXACT_AMOUNT', 'EXACT_STATUS_ONLY'].includes(period.confidence) || period.amountDueCents === null) continue;
        const billing = (await client.query(`INSERT INTO parking_customer_billing_periods(
            public_id,customer_id,booking_id,period_start,amount_due_cents,due_date,currency,source,
            legacy_confidence,legacy_import_batch_id,legacy_source_ref,legacy_source_row)
          VALUES($1,$2,NULL,$3,$4,$3,'usd','LEGACY_EXCEL_IMPORT',$5,$6,$7,$8)
          RETURNING *`, [`bill_${token(24)}`, customerId, `${period.period}-01`, period.amountDueCents,
          period.confidence, batch.id, period.sourceRef, candidate.sourceRow])).rows[0];
        actual.billingPeriods += 1;
        if (period.paymentAmountCents === null) continue;
        await client.query(`INSERT INTO parking_customer_payments(
            public_id,customer_id,booking_id,processor,processor_payment_id,parking_product,amount_cents,currency,status,
            paid_at,billing_period_id,payment_source,payment_method,payment_date,payment_date_precision,
            legacy_confidence,legacy_import_batch_id,legacy_source_ref)
          VALUES($1,$2,NULL,NULL,NULL,'MONTHLY',$3,'usd','PAID',NULL,$4,'LEGACY_EXCEL_IMPORT','LEGACY',
            $5,'PERIOD_ONLY',$6,$7,$8)`, [`pay_${token(24)}`, customerId, period.paymentAmountCents,
          billing.id, `${period.period}-01`, period.confidence, batch.id, period.sourceRef]);
        actual.legacyPayments += 1;
        actual.importedLegacyPaymentCents += period.paymentAmountCents;
      }
    }
    await client.query(`INSERT INTO parking_customer_import_rows(
        import_batch_id,source_row,classification,matched_customer_id,reason,source_fingerprint,proposed_record)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [batch.id, candidate.sourceRow, candidate.classification,
      customerId, candidate.reason || '', candidate.sourceFingerprint || crypto.createHash('sha256').update(`row:${candidate.sourceRow}`).digest('hex'),
      JSON.stringify({ displayName: candidate.displayName, spot: candidate.spot, periods: (candidate.paymentPeriods || []).map(item => item.period) })]);
    actual.sourceRowsProcessed += 1;
  }
  const expected = {
    customersCreated: plan.customersCreated, customersMatched: plan.customersMatched,
    vehicleRecords: plan.vehicleRecords, legacyParkingRecords: plan.legacyParkingRecords,
    legacyNotes: plan.legacyNotes,
    billingPeriods: plan.billingPeriods, legacyPayments: plan.legacyPayments,
    anomalyRecords: plan.anomalyRecords, importedLegacyPaymentCents: plan.importedLegacyPaymentCents,
    rowsSkipped: plan.rowsSkipped,
    sourceRowsProcessed: analysis.candidates.length
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Import execution count mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
  const summary = {
    created: actual.customersCreated, matched: actual.customersMatched, conflicts: 0, errors: 0,
    ...actual, uniqueLegacyCustomerIdentities: plan.uniqueLegacyCustomerIdentities,
    additionalVehicleOrSpaceRows: plan.additionalVehicleOrSpaceRows,
    sharedCarrierSeparateIdentities: plan.sharedCarrierSeparateIdentities
  };
  await client.query(`UPDATE parking_customer_import_batches SET status='COMPLETED',records_created=$2,records_matched=$3,
      conflicts=$4,errors=$5,summary=$6,completed_at=now() WHERE id=$1`, [
    batch.id, summary.created, summary.matched, summary.conflicts, summary.errors, JSON.stringify(summary)
  ]);
  return { batchPublicId: batch.public_id, ...summary };
}

module.exports = {
  SHEET_NAME, classifications, text, normalizedName, normalizedPhone, normalizedEmail, authorityNumbers,
  usefulPlate, usefulPlates, currencyCents, monthColumns, paymentCell, compatibleNames,
  classifyBase, analyzeRows, readWorkbook, fileMetadata, loadProductionIndex, compareToProduction,
  executionPlan, report, executeImport
};
