const crypto = require('crypto');
const { token, reservationNumber } = require('../utils');
const customerImport = require('./customerImport');

const END_OF_LEGACY_OCCUPANCY = '2099-12-31T00:00:00.000Z';
const ACTIVE_BOOKING_STATUSES = new Set(['CONFIRMED', 'CHECKED_IN']);

function fingerprint(row) {
  return crypto.createHash('sha256').update(JSON.stringify({
    sourceRow: row.sourceRow, lot: row.lot, customer: row.customer, plate: row.plate,
    unit: row.unit, rateCents: row.rateCents, rawDate: row.rawDate, fill: row.fill,
    classification: row.classification
  })).digest('hex');
}

function normalizedRow(row) {
  return { ...row, sourceFingerprint: fingerprint(row) };
}

function currentAt(assignment, now) {
  if (!assignment || !ACTIVE_BOOKING_STATUSES.has(assignment.bookingStatus)) return false;
  const instant = new Date(now);
  if (assignment.bookingStatus === 'CHECKED_IN' && assignment.actualCheckOutAt) return false;
  return new Date(assignment.reservedArrivalAt) <= instant && new Date(assignment.protectedUntilAt) > instant;
}

function isProtectedParkingOps(assignment, sourceModifiedAt, now) {
  if (!currentAt(assignment, now) || assignment.assignmentSource === 'SPREADSHEET_RECONCILIATION') return false;
  if (assignment.paymentStatus === 'PAID' || assignment.hasStripeEvidence) return true;
  if (sourceModifiedAt && new Date(assignment.bookingCreatedAt) > new Date(sourceModifiedAt)) return true;
  return assignment.assignmentSource === 'ADMIN_REASSIGN' && (!sourceModifiedAt
    || new Date(assignment.assignedAt) > new Date(sourceModifiedAt));
}

function sameOccupant(assignment, identity) {
  return Boolean(assignment && identity?.customerId && Number(assignment.customerId) === Number(identity.customerId));
}

function fallbackIdentity(source, signals) {
  if (!signals) return null;
  const phone = customerImport.normalizedPhone(source.phone);
  const email = customerImport.normalizedEmail(source.email);
  const plate = customerImport.usefulPlate(source.plate);
  const normalizedPlate = plate ? String(plate).toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
  const matchingCustomers = new Set();
  for (const customer of signals.customers || []) {
    if ((phone && customer.normalizedPhone === phone) || (email && customer.normalizedEmail === email)) matchingCustomers.add(customer.id);
  }
  for (const vehicle of signals.vehicles || []) if (normalizedPlate && vehicle.normalizedPlate === normalizedPlate) {
    matchingCustomers.add(vehicle.customerId);
  }
  if (matchingCustomers.size !== 1) return null;
  const customerId = [...matchingCustomers][0];
  const customer = signals.customers.find(item => item.id === customerId);
  const sourceHasRealName = /[A-Za-z]{2}/.test(source.customer || '')
    && !/^(AVAIL(?:ABLE)?|DAILY(?: CUSTOMER)?\b)/i.test(source.customer || '');
  const canonicalNames = [customer?.displayName, customer?.companyName,
    [customer?.firstName,customer?.lastName].filter(Boolean).join(' ')].filter(Boolean);
  const directSignalCount = Number(Boolean(phone && customer?.normalizedPhone === phone))
    + Number(Boolean(email && customer?.normalizedEmail === email))
    + Number(Boolean(normalizedPlate && signals.vehicles.some(item => item.customerId === customerId && item.normalizedPlate === normalizedPlate)));
  if (sourceHasRealName && directSignalCount < 2
    && !canonicalNames.some(name => customerImport.compatibleNames(source.customer, name))) return null;
  const exactVehicle = signals.vehicles.find(item => item.customerId === customerId
    && normalizedPlate && item.normalizedPlate === normalizedPlate) || null;
  return {
    sourceRow: source.sourceRow, customerId, vehicleId: exactVehicle?.id || null,
    displayName: customer?.displayName, companyName: customer?.companyName,
    firstName: customer?.firstName, lastName: customer?.lastName,
    phone: customer?.displayPhone, email: customer?.displayEmail,
    unit: exactVehicle?.unit, plate: exactVehicle?.plate, plateState: exactVehicle?.plateState,
    vehicleDescription: exactVehicle?.vehicleDescription,
    resolutionEvidence: directSignalCount >= 2 ? 'MULTIPLE_EXACT_DIRECT_SIGNALS' : 'UNIQUE_EXACT_DIRECT_SIGNAL'
  };
}

function summarizePlan(rows, canonicalCount, canonicalMissingSpreadsheet) {
  const countClassification = name => rows.filter(row => row.classification === name).length;
  const countResolution = name => rows.filter(row => row.resolution === name).length;
  return {
    canonicalPhysicalLots: canonicalCount,
    spreadsheetLotRows: rows.length,
    availableYellow: countClassification('AVAILABLE_YELLOW'),
    availableEmpty: countClassification('AVAILABLE_EMPTY'),
    internalRed: countClassification('SHOP_COMPANY_INTERNAL'),
    customerOccupied: countClassification('CUSTOMER_OCCUPIED'),
    invalidOrAmbiguous: countClassification('INVALID_OR_AMBIGUOUS'),
    canonicalMatches: rows.filter(row => row.spot).length,
    unmatchedLotNumbers: countResolution('UNMATCHED_CANONICAL_LOT'),
    canonicalLotsMissingSpreadsheet: canonicalMissingSpreadsheet,
    alreadyCorrect: countResolution('NO_CHANGE'),
    newAssignmentsRequired: countResolution('ASSIGNED'),
    unresolvedOccupancyBlocksRequired: countResolution('OCCUPANCY_BLOCKED'),
    spacesToMakeAvailable: countResolution('AVAILABLE'),
    internalSpacesToMark: countResolution('INTERNAL'),
    newerParkingOpsConflictsProtected: countResolution('PROTECTED_NEWER_PARKINGOPS'),
    conflictsSkipped: countResolution('CONFLICT_SKIPPED')
  };
}

function buildPlan(classified, production, metadata, now = new Date().toISOString()) {
  const spots = new Map(production.spots.map(spot => [String(spot.label), spot]));
  const assignments = new Map(production.assignments.map(assignment => [Number(assignment.spotId), assignment]));
  const identities = new Map(production.identities.map(identity => [Number(identity.sourceRow), identity]));
  const rows = classified.rows.map(normalizedRow).map(source => {
    const spot = spots.get(String(source.lot)) || null;
    const assignment = spot ? assignments.get(Number(spot.id)) || null : null;
    const identity = identities.get(Number(source.sourceRow)) || fallbackIdentity(source, production.identitySignals) || null;
    const base = { ...source, spot, identity, existingAssignment: assignment, resolution: 'PENDING', action: null };
    if (source.classification === 'INVALID_OR_AMBIGUOUS') {
      return { ...base, resolution: 'CONFLICT_SKIPPED', action: 'NONE' };
    }
    if (!spot) return { ...base, resolution: 'UNMATCHED_CANONICAL_LOT', action: 'NONE' };
    if (isProtectedParkingOps(assignment, metadata.modifiedAt, now)) {
      return { ...base, resolution: 'PROTECTED_NEWER_PARKINGOPS', action: 'NONE' };
    }
    if (source.classification === 'SHOP_COMPANY_INTERNAL') {
      const alreadyInternal = ['SHOP', 'COMPANY', 'INTERNAL'].includes(spot.parkingUse)
        && spot.publicBookable === false && spot.parkingPurpose !== 'CUSTOMER';
      return { ...base, resolution: alreadyInternal && !currentAt(assignment, now) ? 'NO_CHANGE' : 'INTERNAL',
        action: alreadyInternal && !currentAt(assignment, now) ? 'NONE' : 'SET_INTERNAL' };
    }
    if (source.classification === 'AVAILABLE_YELLOW' || source.classification === 'AVAILABLE_EMPTY') {
      const needsCustomerConfiguration = spot.parkingPurpose !== 'CUSTOMER' || spot.publicBookable !== true;
      // Live Lot treats an unreleased CHECKED_IN assignment as occupied even
      // after its protected interval. It must be explicitly closed when the
      // current workbook says the physical space is available.
      const hasCurrent = Boolean(assignment);
      return { ...base, resolution: !hasCurrent && !needsCustomerConfiguration ? 'NO_CHANGE' : 'AVAILABLE',
        action: !hasCurrent && !needsCustomerConfiguration ? 'NONE' : 'SET_AVAILABLE', needsCustomerConfiguration };
    }
    if (!identity?.customerId) {
      const existingBlock = production.blocks.find(block => Number(block.spotId) === Number(spot.id));
      return { ...base, resolution: existingBlock?.occupancyReconciliation ? 'NO_CHANGE' : 'OCCUPANCY_BLOCKED',
        action: existingBlock?.occupancyReconciliation ? 'NONE' : 'BLOCK_UNRESOLVED' };
    }
    if (sameOccupant(assignment, identity) && currentAt(assignment, now)) {
      return { ...base, resolution: 'NO_CHANGE', action: 'NONE' };
    }
    return { ...base, resolution: 'ASSIGNED', action: 'ASSIGN_CUSTOMER',
      needsCustomerConfiguration: spot.parkingPurpose !== 'CUSTOMER' };
  });
  const workbookLots = new Set(classified.rows.map(row => String(row.lot)));
  const canonicalMissingSpreadsheet = production.spots.filter(spot => !workbookLots.has(String(spot.label))).length;
  return {
    generatedAt: now,
    workbook: metadata,
    detectedColors: classified.detectedColors,
    summary: summarizePlan(rows, production.spots.length, canonicalMissingSpreadsheet),
    rows
  };
}

async function loadProduction(client, metadata, now = new Date().toISOString()) {
  const spotsResult = await client.query(`SELECT spot.id,spot.public_label label,spot.location_id,spot.zone_id,
      spot.inventory_id,inventory.category_id,spot.parking_use,spot.public_bookable,spot.classification_state,
      layout.id layout_id,element.id element_id,element.parking_purpose,element.daily_eligible,
      element.weekly_eligible,element.monthly_eligible,element.space_public_bookable,element.rate_plan_id
    FROM parking_spots spot
    JOIN parking_inventory inventory ON inventory.id=spot.inventory_id
    LEFT JOIN parking_lot_layouts layout ON layout.location_id=spot.location_id AND layout.status='PUBLISHED'
    LEFT JOIN parking_layout_elements element ON element.layout_id=layout.id AND element.parking_spot_id=spot.id
    WHERE spot.active AND spot.public_label ~ '^[0-9]+$'
    ORDER BY spot.public_label::integer`);
  const spots = spotsResult.rows.map(row => ({
    id: Number(row.id), label: row.label, locationId: Number(row.location_id), zoneId: Number(row.zone_id),
    inventoryId: Number(row.inventory_id), categoryId: Number(row.category_id), parkingUse: row.parking_use,
    publicBookable: row.public_bookable, classificationState: row.classification_state,
    layoutId: row.layout_id ? Number(row.layout_id) : null, elementId: row.element_id ? Number(row.element_id) : null,
    parkingPurpose: row.parking_purpose, dailyEligible: row.daily_eligible, weeklyEligible: row.weekly_eligible,
    monthlyEligible: row.monthly_eligible, spacePublicBookable: row.space_public_bookable,
    ratePlanId: row.rate_plan_id ? Number(row.rate_plan_id) : null
  }));
  const locationIds = [...new Set(spots.map(spot => spot.locationId))];
  const assignmentsResult = await client.query(`SELECT assignment.id,assignment.parking_spot_id,assignment.booking_id,
      assignment.assignment_source,assignment.assigned_at,assignment.reserved_arrival_at,assignment.reserved_departure_at,
      assignment.protected_until_at,assignment.actual_check_out_at,booking.status booking_status,
      booking.customer_id,booking.payment_status,booking.created_at booking_created_at,
      (booking.stripe_checkout_session_id IS NOT NULL OR booking.stripe_payment_intent_id IS NOT NULL
        OR booking.stripe_subscription_id IS NOT NULL) has_stripe_evidence
    FROM reservation_spot_assignments assignment
    JOIN parking_bookings booking ON booking.id=assignment.booking_id
    WHERE assignment.released_at IS NULL AND booking.location_id=ANY($1::bigint[])
      AND booking.status=ANY($2::text[])
    ORDER BY assignment.assigned_at DESC,assignment.id DESC`, [locationIds, [...ACTIVE_BOOKING_STATUSES]]);
  const assignments = [];
  const seenSpots = new Set();
  for (const row of assignmentsResult.rows) {
    const spotId = Number(row.parking_spot_id);
    if (seenSpots.has(spotId)) continue;
    seenSpots.add(spotId);
    assignments.push({
      id: Number(row.id), spotId, bookingId: Number(row.booking_id), assignmentSource: row.assignment_source,
      assignedAt: row.assigned_at, reservedArrivalAt: row.reserved_arrival_at,
      reservedDepartureAt: row.reserved_departure_at, protectedUntilAt: row.protected_until_at,
      actualCheckOutAt: row.actual_check_out_at, bookingStatus: row.booking_status,
      customerId: row.customer_id ? Number(row.customer_id) : null, paymentStatus: row.payment_status,
      bookingCreatedAt: row.booking_created_at, hasStripeEvidence: row.has_stripe_evidence
    });
  }
  const blockProvenanceExists = (await client.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='parking_spot_blocks'
      AND column_name='occupancy_reconciliation_row_id') present`)).rows[0].present;
  const blocksResult = await client.query(`SELECT block.id,block.parking_spot_id,
      ${blockProvenanceExists ? 'block.occupancy_reconciliation_row_id' : 'NULL::bigint occupancy_reconciliation_row_id'}
    FROM parking_spot_blocks block JOIN parking_spots spot ON spot.id=block.parking_spot_id
    WHERE block.released_at IS NULL AND spot.location_id=ANY($1::bigint[]) AND block.starts_at<=$2
      AND COALESCE(block.ends_at,'infinity'::timestamptz)>$2`, [locationIds, now]);
  const identitiesResult = await client.query(`SELECT DISTINCT ON (legacy.source_row)
      legacy.source_row,legacy.customer_id,legacy.vehicle_id,legacy.import_batch_id,
      customer.display_name,customer.company_name,customer.first_name,customer.last_name,
      customer.display_phone,customer.display_email,vehicle.unit_number,vehicle.license_plate,
      vehicle.license_plate_state,vehicle.vehicle_description
    FROM parking_customer_legacy_parking_records legacy
    JOIN parking_customer_import_batches batch ON batch.id=legacy.import_batch_id
    JOIN parking_customers customer ON customer.id=legacy.customer_id
    LEFT JOIN parking_customer_vehicles vehicle ON vehicle.id=legacy.vehicle_id
    WHERE batch.source_sha256=$1 AND batch.source_sheet=$2
    ORDER BY legacy.source_row,legacy.created_at DESC,legacy.id DESC`, [metadata.sha256, metadata.sheet]);
  const identities = identitiesResult.rows.map(row => ({
    sourceRow: Number(row.source_row), customerId: Number(row.customer_id),
    vehicleId: row.vehicle_id ? Number(row.vehicle_id) : null, importBatchId: Number(row.import_batch_id),
    displayName: row.display_name, companyName: row.company_name, firstName: row.first_name,
    lastName: row.last_name, phone: row.display_phone, email: row.display_email,
    unit: row.unit_number, plate: row.license_plate, plateState: row.license_plate_state,
    vehicleDescription: row.vehicle_description
  }));
  const [allCustomersResult,allVehiclesResult] = await Promise.all([
    client.query(`SELECT id,display_name,company_name,first_name,last_name,normalized_phone,normalized_email,
        display_phone,display_email FROM parking_customers`),
    client.query(`SELECT id,customer_id,unit_number,license_plate,license_plate_state,vehicle_description
      FROM parking_customer_vehicles`)
  ]);
  return {
    spots, assignments,
    blocks: blocksResult.rows.map(row => ({ id: Number(row.id), spotId: Number(row.parking_spot_id),
      occupancyReconciliation: Boolean(row.occupancy_reconciliation_row_id) })),
    identities,
    identitySignals: {
      customers: allCustomersResult.rows.map(row => ({ id: Number(row.id), displayName: row.display_name,
        companyName: row.company_name, firstName: row.first_name, lastName: row.last_name,
        normalizedPhone: row.normalized_phone, normalizedEmail: row.normalized_email,
        displayPhone: row.display_phone, displayEmail: row.display_email })),
      vehicles: allVehiclesResult.rows.map(row => ({ id: Number(row.id), customerId: Number(row.customer_id),
        unit: row.unit_number, plate: row.license_plate, plateState: row.license_plate_state,
        vehicleDescription: row.vehicle_description,
        normalizedPlate: String(row.license_plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '') }))
    }
  };
}

async function closeStaleAssignment(client, assignment, adminUserId, now) {
  if (!assignment) return false;
  const released = await client.query(`UPDATE reservation_spot_assignments
    SET released_at=$2,release_reason='Superseded by current spreadsheet physical occupancy reconciliation',
      actual_check_out_at=CASE WHEN actual_check_in_at IS NULL THEN actual_check_out_at
        ELSE COALESCE(actual_check_out_at,$2) END
    WHERE id=$1 AND released_at IS NULL RETURNING booking_id`, [assignment.id, now]);
  if (!released.rowCount) return false;
  const booking = (await client.query(`UPDATE parking_bookings SET status='CHECKED_OUT',actual_departure_at=COALESCE(actual_departure_at,$2),
      updated_at=$2,version=version+1 WHERE id=$1 AND status=ANY($3::text[]) RETURNING id,version`,
  [released.rows[0].booking_id, now, [...ACTIVE_BOOKING_STATUSES]])).rows[0];
  const previousStatus = assignment.bookingStatus || 'CONFIRMED';
  if (booking) await client.query(`INSERT INTO parking_booking_status_history(
      booking_id,previous_status,new_status,actor_type,admin_user_id,reason,note,version)
    VALUES($1,$2,'CHECKED_OUT','SYSTEM',$3,'SPREADSHEET_OCCUPANCY_RECONCILIATION',
      'Historical assignment ended before current physical-state reconciliation',$4)`,
  [booking.id, previousStatus, adminUserId, booking.version]);
  return true;
}

async function releasePriorReconciliation(client, spotId, adminUserId, now) {
  await client.query(`UPDATE parking_spot_blocks SET released_at=$2,released_by_admin_user_id=$3
    WHERE parking_spot_id=$1 AND released_at IS NULL AND occupancy_reconciliation_row_id IS NOT NULL`,
  [spotId, now, adminUserId]);
  const assignments = await client.query(`SELECT id,booking_id FROM reservation_spot_assignments
    WHERE parking_spot_id=$1 AND released_at IS NULL AND assignment_source='SPREADSHEET_RECONCILIATION'`, [spotId]);
  for (const assignment of assignments.rows) await closeStaleAssignment(client,
    { id: Number(assignment.id), bookingStatus: 'CHECKED_IN' }, adminUserId, now);
}

async function referenceDailyConfiguration(client, spot) {
  const reference = (await client.query(`SELECT element.rate_plan_id
    FROM parking_spots reference
    JOIN parking_inventory reference_inventory ON reference_inventory.id=reference.inventory_id
    JOIN parking_inventory target_inventory ON target_inventory.id=$2
    JOIN parking_lot_layouts layout ON layout.location_id=reference.location_id AND layout.status='PUBLISHED'
    JOIN parking_layout_elements element ON element.layout_id=layout.id AND element.parking_spot_id=reference.id
    WHERE reference.location_id=$1 AND reference.public_label ~ '^[0-9]+$'
      AND reference.public_label::integer BETWEEN 110 AND 148
      AND reference_inventory.category_id=target_inventory.category_id
      AND element.parking_purpose='CUSTOMER' AND element.daily_eligible AND element.rate_plan_id IS NOT NULL
    ORDER BY reference.public_label::integer LIMIT 1`, [spot.locationId, spot.inventoryId])).rows[0];
  if (!reference) throw new Error(`No canonical Daily configuration exists for lot ${spot.label}`);
  return { ratePlanId: Number(reference.rate_plan_id) };
}

async function setCustomerConfiguration(client, spot) {
  const reference = await referenceDailyConfiguration(client, spot);
  await client.query(`UPDATE parking_spots SET parking_use='CUSTOMER',public_bookable=true,
      classification_state='COMPLETE',operational_label='',version=version+1,updated_at=now() WHERE id=$1`,
  [spot.id]);
  if (spot.elementId) {
    await client.query("SELECT set_config('parking.layout_publication','on',true)");
    await client.query(`UPDATE parking_layout_elements SET parking_purpose='CUSTOMER',daily_eligible=true,
      weekly_eligible=false,monthly_eligible=false,space_public_bookable=true,rate_plan_id=$2,
      space_internal_note='' WHERE id=$1`, [spot.elementId, reference.ratePlanId]);
  }
}

async function setInternalConfiguration(client, spot, source) {
  await client.query(`UPDATE parking_spots SET parking_use='INTERNAL',public_bookable=false,
      classification_state='COMPLETE',operational_label=$2,version=version+1,updated_at=now() WHERE id=$1`,
  [spot.id, `Spreadsheet red: internal (${source.customer || `Lot ${source.lot}`})`.slice(0, 160)]);
  if (spot.elementId) {
    await client.query("SELECT set_config('parking.layout_publication','on',true)");
    await client.query(`UPDATE parking_layout_elements SET parking_purpose='INTERNAL',daily_eligible=false,
      weekly_eligible=false,monthly_eligible=false,space_public_bookable=false,rate_plan_id=NULL,
      space_internal_note=$2 WHERE id=$1`, [spot.elementId, 'Spreadsheet operational red: shop/company/internal']);
  }
}

async function createVehicleIfNeeded(client, reconciliationRowId, row) {
  if (row.identity.vehicleId || (!row.plate && !row.unit)) return row.identity.vehicleId || null;
  const vehicle = (await client.query(`INSERT INTO parking_customer_vehicles(
      public_id,customer_id,unit_number,license_plate,license_plate_state,vehicle_classification,
      vehicle_description,record_source,occupancy_reconciliation_row_id)
    VALUES($1,$2,$3,$4,NULL,'GENERAL',NULL,'SPREADSHEET_RECONCILIATION',$5) RETURNING id`, [
    `veh_${token(24)}`, row.identity.customerId, row.unit, customerImport.usefulPlate(row.plate), reconciliationRowId
  ])).rows[0];
  return Number(vehicle.id);
}

async function createOccupancy(client, reconciliationRowId, row, adminUserId, now) {
  if (row.needsCustomerConfiguration) await setCustomerConfiguration(client, row.spot);
  const currentSpot = (await client.query(`SELECT spot.*,inventory.category_id FROM parking_spots spot
    JOIN parking_inventory inventory ON inventory.id=spot.inventory_id WHERE spot.id=$1 FOR UPDATE`, [row.spot.id])).rows[0];
  const vehicleId = await createVehicleIfNeeded(client, reconciliationRowId, row);
  const vehicle = vehicleId ? (await client.query('SELECT * FROM parking_customer_vehicles WHERE id=$1', [vehicleId])).rows[0] : null;
  const identity = row.identity;
  const booking = (await client.query(`INSERT INTO parking_bookings(
      reservation_number,public_token,lookup_credential_hash,idempotency_hash,inventory_id,location_id,category_id,
      status,arrival_at,departure_at,actual_arrival_at,first_name,last_name,mobile_phone,email,company_name,
      tractor_unit_number,license_plate,license_plate_state,assigned_zone_id,assigned_spot_label,
      operational_notes,customer_notes,terms_accepted_at,cancellation_terms_accepted_at,assignment_mode_snapshot,
      parking_product,payment_status,customer_id,record_source,occupancy_reconciliation_row_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,'CHECKED_IN',$8,$9,$8,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
      $20,'',NULL,NULL,'EXACT_SPOT','LEGACY','NOT_REQUIRED',$21,'SPREADSHEET_RECONCILIATION',$22)
    RETURNING *`, [reservationNumber(),token(32),crypto.createHash('sha256').update(token(32)).digest('hex'),
      `occupancy:${row.sourceFingerprint}`,currentSpot.inventory_id,currentSpot.location_id,currentSpot.category_id,
      now,END_OF_LEGACY_OCCUPANCY,identity.firstName,identity.lastName,identity.phone,identity.email,
      identity.companyName ? String(identity.companyName).slice(0, 120) : null,
      vehicle?.unit_number || row.unit,vehicle?.license_plate || customerImport.usefulPlate(row.plate),vehicle?.license_plate_state || null,
      currentSpot.zone_id,currentSpot.public_label,
      `Current physical occupancy from ${row.sourceRow ? `spreadsheet row ${row.sourceRow}` : 'spreadsheet reconciliation'}`,
      identity.customerId,reconciliationRowId])).rows[0];
  await client.query(`INSERT INTO parking_booking_price_snapshots(booking_id,snapshot) VALUES($1,$2)`, [booking.id,
    JSON.stringify({ duration: 'IN_PERSON', totalCents: row.rateCents, currency: 'usd',
      source: 'SPREADSHEET_RECONCILIATION', sourceRow: row.sourceRow, paymentEvidence: false })]);
  await client.query(`INSERT INTO parking_booking_status_history(
      booking_id,previous_status,new_status,actor_type,admin_user_id,reason,note,version)
    VALUES($1,NULL,'CHECKED_IN','SYSTEM',$2,'SPREADSHEET_OCCUPANCY_RECONCILIATION',
      'Physical occupancy only; no payment was inferred',1)`, [booking.id, adminUserId]);
  const assignment = (await client.query(`INSERT INTO reservation_spot_assignments(
      booking_id,parking_spot_id,reserved_arrival_at,reserved_departure_at,protected_until_at,assigned_at,
      assignment_source,assigned_by_admin_user_id,assignment_reason,actual_check_in_at,occupancy_reconciliation_row_id)
    VALUES($1,$2,$3,$4,$4,$3,'SPREADSHEET_RECONCILIATION',$5,
      'Current physical lot state from formatted Excel workbook',$3,$6) RETURNING id`,
  [booking.id,currentSpot.id,now,END_OF_LEGACY_OCCUPANCY,adminUserId,reconciliationRowId])).rows[0];
  return { bookingId: Number(booking.id), assignmentId: Number(assignment.id), vehicleId };
}

async function executePlan(client, plan, { adminUserId, reportSha256 }) {
  const existing = await client.query(`SELECT public_id,summary FROM parking_occupancy_reconciliation_batches
    WHERE source_sha256=$1 AND source_sheet=$2 AND status='COMPLETED'`, [plan.workbook.sha256, plan.workbook.sheet]);
  if (existing.rowCount) return { batchPublicId: existing.rows[0].public_id, idempotent: true,
    summary: existing.rows[0].summary };
  const batch = (await client.query(`INSERT INTO parking_occupancy_reconciliation_batches(
      public_id,source_filename,source_sha256,source_sheet,source_modified_at,available_colors,internal_colors,
      status,initiated_by_admin_user_id,dry_run_report_sha256,rows_considered)
    VALUES($1,$2,$3,$4,$5,$6,$7,'RUNNING',$8,$9,$10) RETURNING *`, [
    `occ_${token(24)}`,plan.workbook.filename,plan.workbook.sha256,plan.workbook.sheet,plan.workbook.modifiedAt,
    JSON.stringify(plan.detectedColors.available),JSON.stringify(plan.detectedColors.internal),adminUserId,
    reportSha256,plan.rows.length])).rows[0];
  const actual = { assigned: 0, available: 0, internal: 0, occupancyBlocked: 0, noChange: 0,
    protected: 0, conflictsSkipped: 0, unmatched: 0, staleAssignmentsClosed: 0 };
  for (const source of plan.rows) {
    const row = (await client.query(`INSERT INTO parking_occupancy_reconciliation_rows(
        public_id,batch_id,source_row,source_fingerprint,lot_number,raw_customer,raw_plate,raw_unit,raw_rate_cents,
        raw_date,fill_evidence,classification,resolution,reason,parking_spot_id,customer_id,vehicle_id,previous_state,proposed_state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`, [
      `ocr_${token(24)}`,batch.id,source.sourceRow,source.sourceFingerprint,source.lot,source.customer,source.plate,
      source.unit,source.rateCents,source.rawDate,JSON.stringify(source.fill),source.classification,source.resolution,
      source.reason,source.spot?.id || null,source.identity?.customerId || null,source.identity?.vehicleId || null,
      JSON.stringify({ spot: source.spot || null, assignment: source.existingAssignment || null }),
      JSON.stringify({ action: source.action, resolution: source.resolution })])).rows[0];
    if (source.resolution === 'NO_CHANGE') { actual.noChange += 1; continue; }
    if (source.resolution === 'PROTECTED_NEWER_PARKINGOPS') { actual.protected += 1; continue; }
    if (source.resolution === 'CONFLICT_SKIPPED') { actual.conflictsSkipped += 1; continue; }
    if (source.resolution === 'UNMATCHED_CANONICAL_LOT') { actual.unmatched += 1; continue; }
    if (source.existingAssignment && !isProtectedParkingOps(source.existingAssignment, plan.workbook.modifiedAt, plan.generatedAt)) {
      if (await closeStaleAssignment(client, source.existingAssignment, adminUserId, plan.generatedAt)) actual.staleAssignmentsClosed += 1;
    }
    await releasePriorReconciliation(client, source.spot.id, adminUserId, plan.generatedAt);
    if (source.action === 'SET_INTERNAL') {
      await setInternalConfiguration(client, source.spot, source); actual.internal += 1;
    } else if (source.action === 'SET_AVAILABLE') {
      if (source.needsCustomerConfiguration) await setCustomerConfiguration(client, source.spot);
      actual.available += 1;
    } else if (source.action === 'BLOCK_UNRESOLVED') {
      const block = (await client.query(`INSERT INTO parking_spot_blocks(
          parking_spot_id,starts_at,ends_at,reason,public_message,internal_note,created_by_admin_user_id,
          occupancy_reconciliation_row_id)
        VALUES($1,$2,NULL,'Unresolved physical spreadsheet occupancy','Unavailable',
          'Identity requires staff review; no customer was guessed',$3,$4) RETURNING id`,
      [source.spot.id,plan.generatedAt,adminUserId,row.id])).rows[0];
      await client.query('UPDATE parking_occupancy_reconciliation_rows SET block_id=$2 WHERE id=$1', [row.id,block.id]);
      actual.occupancyBlocked += 1;
    } else if (source.action === 'ASSIGN_CUSTOMER') {
      const created = await createOccupancy(client, row.id, source, adminUserId, plan.generatedAt);
      await client.query(`UPDATE parking_occupancy_reconciliation_rows
        SET booking_id=$2,assignment_id=$3,vehicle_id=COALESCE(vehicle_id,$4) WHERE id=$1`,
      [row.id,created.bookingId,created.assignmentId,created.vehicleId]);
      actual.assigned += 1;
    }
  }
  const summary = { ...plan.summary, actual };
  await client.query(`UPDATE parking_occupancy_reconciliation_batches SET status='COMPLETED',summary=$2,completed_at=now()
    WHERE id=$1`, [batch.id,JSON.stringify(summary)]);
  return { batchPublicId: batch.public_id, idempotent: false, summary };
}

module.exports = {
  END_OF_LEGACY_OCCUPANCY, fingerprint, currentAt, isProtectedParkingOps, fallbackIdentity, buildPlan,
  loadProduction, executePlan,
  _private: { closeStaleAssignment, setCustomerConfiguration }
};
