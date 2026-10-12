const express = require('express');
const pool = require('../db');
const { requireAdmin, csrf, permit } = require('../auth');
const { apiError, cleanText, token } = require('../utils');
const ledger = require('../services/customerLedger');

const router = express.Router();
router.use(requireAdmin);
const read = permit('STAFF');
const operate = permit('STAFF');
const owner = permit('OWNER');

function pageLimit(value) {
  const parsed = Number(value || 50);
  if (!Number.isInteger(parsed) || parsed < 1) throw apiError('VALIDATION_ERROR', 'Page limit must be a positive whole number');
  return Math.min(parsed, 100);
}

function cursorOffset(value) {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!Number.isInteger(parsed.offset) || parsed.offset < 0) throw new Error('invalid offset');
    return parsed.offset;
  } catch (_) { throw apiError('INVALID_CURSOR', 'The customer pagination cursor is invalid', 400); }
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url');
}

function enumValue(value, values, label, { optional = true } = {}) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized && optional) return '';
  if (!values.includes(normalized)) throw apiError('VALIDATION_ERROR', `Choose a valid ${label}`);
  return normalized;
}

function publicName(row) {
  return row.display_name || row.company_name || [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Unnamed customer';
}

function customerView(row) {
  const currentParkings = Array.isArray(row.current_parking_items) ? row.current_parking_items.map(item => ({
    bookingId: Number(item.bookingId), reservationNumber: item.reservationNumber,
    parkingProduct: item.parkingProduct, status: item.status, arrivalAt: item.arrivalAt,
    departureAt: item.departureAt, spot: item.spot, plate: item.plate,
    unitNumber: item.unitNumber, vehicleDescription: item.vehicleDescription,
    rateCents: Number(item.rateCents || 0)
  })) : [];
  return {
    publicId: row.public_id,
    displayName: publicName(row),
    firstName: row.first_name,
    lastName: row.last_name,
    companyName: row.company_name || row.booking_company_name || row.latest_booking_company_name,
    phone: row.display_phone,
    email: row.display_email,
    usdotNumber: row.usdot_number || row.booking_usdot_number,
    mcNumber: row.mc_number,
    lifecycleStatus: row.lifecycle_status,
    accountStatus: row.status,
    recordSource: row.record_source,
    createdAt: row.created_at,
    currentParking: row.current_booking_id ? {
      bookingId: Number(row.current_booking_id), reservationNumber: row.current_reservation_number,
      parkingProduct: row.current_parking_product, status: row.current_booking_status,
      arrivalAt: row.current_arrival_at, departureAt: row.current_departure_at,
      spot: row.current_spot, plate: row.current_license_plate,
      unitNumber: row.current_unit_number, vehicleDescription: row.current_vehicle_description,
      rateCents: Number(row.current_rate_cents || row.legacy_rate_cents || 0)
    } : null,
    currentParkings,
    currentLotNumbers: currentParkings.map(item => item.spot).filter(Boolean),
    upcomingParking: row.upcoming_booking_id ? {
      bookingId: Number(row.upcoming_booking_id), parkingProduct: row.upcoming_parking_product,
      arrivalAt: row.upcoming_arrival_at, departureAt: row.upcoming_departure_at,
      spot: row.upcoming_spot, plate: row.upcoming_license_plate,
      unitNumber: row.upcoming_unit_number, rateCents: Number(row.upcoming_rate_cents || 0)
    } : null,
    latestVehicle: row.vehicle_public_id ? {
      publicId: row.vehicle_public_id, plate: row.vehicle_plate, unitNumber: row.vehicle_unit,
      description: row.vehicle_description
    } : null,
    payment: row.period_public_id ? {
      periodId: row.period_public_id, period: String(row.period_start).slice(0, 7),
      amountDueCents: Number(row.amount_due_cents), paidCents: Number(row.paid_cents),
      balanceCents: Number(row.balance_cents), creditCents: Number(row.credit_cents), status: row.period_status
    } : { status: 'NOT_DUE', amountDueCents: 0, paidCents: 0, balanceCents: 0, creditCents: 0 },
    lastPayment: row.last_payment_id ? {
      publicId: row.last_payment_id, amountCents: Number(row.last_payment_amount_cents),
      paymentDate: row.last_payment_date, source: row.last_payment_source, method: row.last_payment_method
    } : null,
    documentsStatus: row.document_status || 'MISSING',
    reservationCount: Number(row.reservation_count || 0)
  };
}

async function audit(client, req, action, entityType, entityId, metadata) {
  await client.query(`INSERT INTO parking_audit_events(admin_user_id,action,entity_type,entity_id,metadata)
    VALUES($1,$2,$3,$4,$5)`, [req.admin.id, action, entityType, String(entityId), JSON.stringify(metadata || {})]);
}

function listFilters(query) {
  const values = [];
  const filters = [];
  const add = (sql, value) => { values.push(value); filters.push(sql.replaceAll('?', `$${values.length}`)); };
  const search = String(query.q || '').trim();
  if (search) {
    values.push(`%${search}%`);
    const textIndex = values.length;
    const digits = ledger.normalizedDigits(search);
    const plate = ledger.normalizedPlate(search);
    const terms = [
      `concat_ws(' ',customer.display_name,customer.first_name,customer.last_name,customer.company_name,
        customer.display_phone,customer.display_email,customer.usdot_number,customer.mc_number,
        customer.legacy_current_spot) ILIKE $${textIndex}`,
      `EXISTS (SELECT 1 FROM parking_customer_vehicles search_vehicle WHERE search_vehicle.customer_id=customer.id
        AND concat_ws(' ',search_vehicle.license_plate,search_vehicle.unit_number,search_vehicle.vehicle_description) ILIKE $${textIndex})`,
      `EXISTS (SELECT 1 FROM parking_bookings search_booking
        LEFT JOIN reservation_spot_assignments search_assignment ON search_assignment.booking_id=search_booking.id AND search_assignment.released_at IS NULL
        LEFT JOIN parking_spots search_spot ON search_spot.id=search_assignment.parking_spot_id
        WHERE search_booking.customer_id=customer.id AND concat_ws(' ',search_booking.reservation_number,
          search_booking.first_name,search_booking.last_name,search_booking.company_name,search_booking.mobile_phone,
          search_booking.email,search_booking.usdot_number,search_booking.license_plate,
          search_booking.tractor_unit_number,search_spot.public_label) ILIKE $${textIndex})`
    ];
    if (digits.length >= 4) {
      values.push(`%${digits}%`);
      terms.push(`regexp_replace(COALESCE(customer.display_phone,''),'[^0-9]','','g') LIKE $${values.length}`);
    }
    if (plate.length >= 2) {
      values.push(`%${plate}%`);
      terms.push(`EXISTS (SELECT 1 FROM parking_customer_vehicles plate_vehicle WHERE plate_vehicle.customer_id=customer.id
        AND regexp_replace(upper(COALESCE(plate_vehicle.license_plate,'')),'[^A-Z0-9]','','g') LIKE $${values.length})`);
    }
    filters.push(`(${terms.join(' OR ')})`);
  }
  const lifecycle = enumValue(query.status, ['ACTIVE', 'FORMER'], 'customer status');
  if (lifecycle) add('customer.lifecycle_status=?', lifecycle);
  const payment = enumValue(query.payment, ['PAID', 'DUE', 'PARTIAL', 'OVERDUE', 'NOT_DUE'], 'payment status');
  if (payment) {
    if (payment === 'NOT_DUE') filters.push(`COALESCE(current_period.status,'NOT_DUE')='NOT_DUE'`);
    else add('current_period.status=?', payment);
  }
  const parking = enumValue(query.parking, ['CURRENT', 'UPCOMING', 'UNASSIGNED', 'PAST_ONLY', 'NONE'], 'parking status');
  if (parking === 'CURRENT') filters.push('current_booking.id IS NOT NULL');
  if (parking === 'UNASSIGNED') filters.push('current_booking.id IS NOT NULL AND current_booking.current_spot IS NULL');
  if (parking === 'UPCOMING') filters.push(`EXISTS (SELECT 1 FROM parking_bookings future WHERE future.customer_id=customer.id
    AND future.status='CONFIRMED' AND future.arrival_at>now())`);
  if (parking === 'PAST_ONLY') filters.push(`current_booking.id IS NULL AND EXISTS (SELECT 1 FROM parking_bookings past
    WHERE past.customer_id=customer.id AND past.departure_at<=now()) AND NOT EXISTS (SELECT 1 FROM parking_bookings future
    WHERE future.customer_id=customer.id AND future.status='CONFIRMED' AND future.arrival_at>now())`);
  if (parking === 'NONE') filters.push(`current_booking.id IS NULL AND NOT EXISTS (SELECT 1 FROM parking_bookings future
    WHERE future.customer_id=customer.id AND future.status='CONFIRMED' AND future.arrival_at>now())`);
  const documents = enumValue(query.documents, ['REVIEW'], 'document status');
  if (documents === 'REVIEW') filters.push(`EXISTS (SELECT 1 FROM parking_customer_documents document
    JOIN parking_bookings document_booking ON document_booking.id=document.booking_id
    WHERE document_booking.customer_id=customer.id AND document.upload_status='UPLOADED'
      AND document.superseded_at IS NULL AND document.verification_status='PENDING_REVIEW')`);
  const product = enumValue(query.reservationType, ['DAILY', 'WEEKLY', 'MONTHLY', 'IN_PERSON'], 'reservation type');
  if (product) {
    values.push(product, product);
    filters.push(`(customer.legacy_parking_type=$${values.length - 1} OR EXISTS (SELECT 1 FROM parking_bookings product_booking
      WHERE product_booking.customer_id=customer.id AND product_booking.parking_product=$${values.length}))`);
  }
  return { values, where: filters.length ? `WHERE ${filters.join(' AND ')}` : '' };
}

router.get('/customers', read, async (req, res, next) => {
  try {
    const limit = pageLimit(req.query.limit);
    const offset = cursorOffset(req.query.cursor);
    const { values, where } = listFilters(req.query);
    values.push(limit + 1, offset);
    const list = await pool.query(`SELECT customer.*,
        current_booking.id current_booking_id,current_booking.reservation_number current_reservation_number,
        current_booking.parking_product current_parking_product,current_booking.status current_booking_status,
        current_booking.arrival_at current_arrival_at,current_booking.departure_at current_departure_at,
        current_booking.current_spot,current_booking.license_plate current_license_plate,
        current_booking.tractor_unit_number current_unit_number,current_booking.vehicle_description current_vehicle_description,
        current_booking.current_rate_cents,current_booking.company_name booking_company_name,current_booking.usdot_number booking_usdot_number,
        upcoming_booking.id upcoming_booking_id,upcoming_booking.parking_product upcoming_parking_product,
        upcoming_booking.arrival_at upcoming_arrival_at,upcoming_booking.departure_at upcoming_departure_at,
        upcoming_booking.current_spot upcoming_spot,upcoming_booking.current_rate_cents upcoming_rate_cents,
        upcoming_booking.license_plate upcoming_license_plate,upcoming_booking.tractor_unit_number upcoming_unit_number,
        document_summary.status document_status,
        latest_booking_company.company_name latest_booking_company_name,
        current_parking_all.items current_parking_items,
        latest_vehicle.public_id vehicle_public_id,latest_vehicle.license_plate vehicle_plate,
        latest_vehicle.unit_number vehicle_unit,latest_vehicle.vehicle_description,
        current_period.public_id period_public_id,current_period.period_start,current_period.amount_due_cents,
        current_period.paid_cents,current_period.balance_cents,current_period.credit_cents,current_period.status period_status,
        last_payment.public_id last_payment_id,last_payment.amount_cents last_payment_amount_cents,
        last_payment.payment_date last_payment_date,last_payment.payment_source last_payment_source,last_payment.payment_method last_payment_method,
        (SELECT count(*) FROM parking_bookings count_booking WHERE count_booking.customer_id=customer.id)::int reservation_count,
        count(*) OVER()::int total_count
      FROM parking_customers customer
      LEFT JOIN LATERAL (
        SELECT booking.*,spot.public_label current_spot,price.snapshot->>'totalCents' current_rate_cents,
          concat_ws(' ',booking.tractor_unit_number,booking.trailer_number) vehicle_description
        FROM parking_bookings booking
        LEFT JOIN parking_booking_price_snapshots price ON price.booking_id=booking.id
        LEFT JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id AND assignment.released_at IS NULL
        LEFT JOIN parking_spots spot ON spot.id=assignment.parking_spot_id
        WHERE booking.customer_id=customer.id AND booking.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT')
          AND booking.arrival_at<=now()
          AND (booking.departure_at IS NULL OR booking.departure_at>now() OR (booking.parking_product='MONTHLY'
            AND booking.billing_period_end_at>now()
            AND booking.subscription_status IN ('ACTIVE','TRIALING','PAST_DUE','PAYMENT_ACTION_REQUIRED')))
        ORDER BY booking.arrival_at DESC,booking.id DESC LIMIT 1
      ) current_booking ON true
      LEFT JOIN LATERAL (
        SELECT booking.*,spot.public_label current_spot,price.snapshot->>'totalCents' current_rate_cents
        FROM parking_bookings booking
        LEFT JOIN parking_booking_price_snapshots price ON price.booking_id=booking.id
        LEFT JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id AND assignment.released_at IS NULL
        LEFT JOIN parking_spots spot ON spot.id=assignment.parking_spot_id
        WHERE booking.customer_id=customer.id AND booking.status='CONFIRMED' AND booking.arrival_at>now()
        ORDER BY booking.arrival_at,booking.id LIMIT 1
      ) upcoming_booking ON true
      LEFT JOIN LATERAL (
        SELECT booking.company_name FROM parking_bookings booking
        WHERE booking.customer_id=customer.id AND NULLIF(btrim(booking.company_name),'') IS NOT NULL
        ORDER BY booking.created_at DESC,booking.id DESC LIMIT 1
      ) latest_booking_company ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'bookingId',current_item.id,'reservationNumber',current_item.reservation_number,
          'parkingProduct',current_item.parking_product,'status',current_item.status,
          'arrivalAt',current_item.arrival_at,'departureAt',current_item.departure_at,
          'spot',current_item.current_spot,'plate',current_item.license_plate,
          'unitNumber',current_item.tractor_unit_number,'vehicleDescription',current_item.vehicle_description,
          'rateCents',current_item.current_rate_cents
        ) ORDER BY CASE WHEN current_item.current_spot ~ '^[0-9]+$' THEN current_item.current_spot::integer END,
          current_item.current_spot,current_item.id) items
        FROM (
          SELECT booking.id,booking.reservation_number,booking.parking_product,booking.status,
            booking.arrival_at,booking.departure_at,booking.license_plate,booking.tractor_unit_number,
            concat_ws(' ',booking.tractor_unit_number,booking.trailer_number) vehicle_description,
            spot.public_label current_spot,price.snapshot->>'totalCents' current_rate_cents
          FROM parking_bookings booking
          LEFT JOIN parking_booking_price_snapshots price ON price.booking_id=booking.id
          LEFT JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id AND assignment.released_at IS NULL
          LEFT JOIN parking_spots spot ON spot.id=assignment.parking_spot_id
          WHERE booking.customer_id=customer.id AND booking.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT')
            AND booking.arrival_at<=now()
            AND (booking.departure_at IS NULL OR booking.departure_at>now() OR (booking.parking_product='MONTHLY'
              AND booking.billing_period_end_at>now()
              AND booking.subscription_status IN ('ACTIVE','TRIALING','PAST_DUE','PAYMENT_ACTION_REQUIRED')))
        ) current_item
      ) current_parking_all ON true
      LEFT JOIN LATERAL (SELECT vehicle.* FROM parking_customer_vehicles vehicle
        WHERE vehicle.customer_id=customer.id ORDER BY vehicle.active DESC,vehicle.last_used_at DESC NULLS LAST,vehicle.id DESC LIMIT 1) latest_vehicle ON true
      LEFT JOIN LATERAL (SELECT aggregate.*,
          GREATEST(aggregate.amount_due_cents-aggregate.paid_cents,0)::bigint balance_cents,
          GREATEST(aggregate.paid_cents-aggregate.amount_due_cents,0)::bigint credit_cents,
          CASE WHEN aggregate.amount_due_cents=0 THEN 'NOT_DUE'
            WHEN aggregate.paid_cents>=aggregate.amount_due_cents THEN 'PAID'
            WHEN aggregate.paid_cents>0 THEN 'PARTIAL'
            WHEN aggregate.due_date<current_date THEN 'OVERDUE' ELSE 'DUE' END status
        FROM (SELECT min(balance.public_id) public_id,balance.period_start,
            sum(balance.amount_due_cents)::bigint amount_due_cents,sum(balance.paid_cents)::bigint paid_cents,
            min(balance.due_date) due_date
          FROM parking_customer_billing_period_balances balance WHERE balance.customer_id=customer.id
          GROUP BY balance.period_start) aggregate
        ORDER BY (aggregate.period_start=date_trunc('month',current_date)::date) DESC,
          aggregate.period_start DESC LIMIT 1) current_period ON true
      LEFT JOIN LATERAL (SELECT payment.* FROM parking_customer_payments payment
        WHERE payment.customer_id=customer.id AND payment.status='PAID'
        ORDER BY payment.payment_date DESC,payment.id DESC LIMIT 1) last_payment ON true
      LEFT JOIN LATERAL (
        SELECT CASE WHEN count(*) FILTER (WHERE document.verification_status='PENDING_REVIEW')>0 THEN 'REVIEW'
          WHEN count(*)>0 THEN 'APPROVED' ELSE 'MISSING' END status
        FROM parking_customer_documents document
        JOIN parking_bookings document_booking ON document_booking.id=document.booking_id
        WHERE document_booking.customer_id=customer.id AND document.upload_status='UPLOADED' AND document.superseded_at IS NULL
      ) document_summary ON true
      ${where}
      ORDER BY lower(COALESCE(customer.display_name,customer.company_name,concat_ws(' ',customer.first_name,customer.last_name))),customer.public_id
      LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    const hasMore = list.rows.length > limit;
    const rows = list.rows.slice(0, limit);
    const metrics = (await pool.query(`SELECT
        (SELECT count(*) FROM parking_customers WHERE lifecycle_status='ACTIVE')::int active_customers,
        count(DISTINCT customer_id) FILTER (WHERE period_start=date_trunc('month',current_date)::date
          AND status IN ('DUE','PARTIAL','OVERDUE'))::int due_this_month,
        COALESCE(sum(balance_cents) FILTER (WHERE status='OVERDUE'),0)::bigint overdue_balance_cents,
        COALESCE(sum(paid_cents) FILTER (WHERE period_start=date_trunc('month',current_date)::date),0)::bigint paid_this_month_cents
      FROM parking_customer_billing_period_balances`)).rows[0];
    res.json({
      customers: rows.map(customerView),
      metrics: {
        activeCustomers: Number(metrics.active_customers), dueThisMonth: Number(metrics.due_this_month),
        overdueBalanceCents: Number(metrics.overdue_balance_cents), paidThisMonthCents: Number(metrics.paid_this_month_cents)
      },
      totals: { customers: rows[0] ? Number(rows[0].total_count) : 0 },
      pagination: { limit, hasMore, nextCursor: hasMore ? encodeCursor(offset + limit) : null }
    });
  } catch (error) { next(error); }
});

router.get('/customers/payment-matrix', read, async (req, res, next) => {
  try {
    const year = Number(req.query.year || new Date().getUTCFullYear());
    if (!Number.isInteger(year) || year < 2000 || year > 2200) throw apiError('VALIDATION_ERROR', 'Choose a valid matrix year');
    const rows = await pool.query(`WITH balance_month AS (
        SELECT customer_id,period_start,sum(amount_due_cents)::bigint amount_due_cents,
          sum(paid_cents)::bigint paid_cents,min(due_date) due_date
        FROM parking_customer_billing_period_balances
        WHERE period_start>=$1::date AND period_start<($1::date+interval '1 year')
        GROUP BY customer_id,period_start
      ), anomaly_month AS (
        SELECT customer_id,period_start,count(*)::int anomaly_count
        FROM parking_customer_legacy_anomalies
        WHERE period_start>=$1::date AND period_start<($1::date+interval '1 year')
        GROUP BY customer_id,period_start
      ), month_data AS (
        SELECT COALESCE(balance.customer_id,anomaly.customer_id) customer_id,
          COALESCE(balance.period_start,anomaly.period_start) period_start,
          COALESCE(balance.amount_due_cents,0)::bigint amount_due_cents,
          COALESCE(balance.paid_cents,0)::bigint paid_cents,
          GREATEST(COALESCE(balance.amount_due_cents,0)-COALESCE(balance.paid_cents,0),0)::bigint balance_cents,
          GREATEST(COALESCE(balance.paid_cents,0)-COALESCE(balance.amount_due_cents,0),0)::bigint credit_cents,
          COALESCE(anomaly.anomaly_count,0)::int anomaly_count,
          CASE WHEN balance.customer_id IS NULL THEN 'LEGACY_DATA_MISSING'
            WHEN balance.amount_due_cents=0 THEN 'NOT_DUE'
            WHEN balance.paid_cents>=balance.amount_due_cents THEN 'PAID'
            WHEN balance.paid_cents>0 THEN 'PARTIAL'
            WHEN balance.due_date<current_date THEN 'OVERDUE' ELSE 'DUE' END status
        FROM balance_month balance FULL OUTER JOIN anomaly_month anomaly
          ON anomaly.customer_id=balance.customer_id AND anomaly.period_start=balance.period_start
      ) SELECT customer.public_id,
        COALESCE(customer.display_name,customer.company_name,concat_ws(' ',customer.first_name,customer.last_name)) customer_name,
        customer.legacy_rate_cents,current_parking.current_lots,current_parking.current_rate_cents,
        COALESCE(jsonb_agg(jsonb_build_object('period',to_char(month.period_start,'YYYY-MM'),
          'amountDueCents',month.amount_due_cents,'paidCents',month.paid_cents,
          'balanceCents',month.balance_cents,'creditCents',month.credit_cents,'status',month.status,
          'legacyAnomalyCount',month.anomaly_count)
          ORDER BY month.period_start) FILTER (WHERE month.period_start IS NOT NULL),'[]'::jsonb) periods
      FROM parking_customers customer
      LEFT JOIN LATERAL (
        SELECT array_agg(DISTINCT spot.public_label ORDER BY spot.public_label) current_lots,
          max((price.snapshot->>'totalCents')::integer) current_rate_cents
        FROM parking_bookings booking
        JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id AND assignment.released_at IS NULL
        JOIN parking_spots spot ON spot.id=assignment.parking_spot_id
        LEFT JOIN parking_booking_price_snapshots price ON price.booking_id=booking.id
        WHERE booking.customer_id=customer.id AND booking.status IN ('CONFIRMED','CHECKED_IN')
          AND booking.arrival_at<=now() AND booking.departure_at>now()
      ) current_parking ON true
      LEFT JOIN month_data month ON month.customer_id=customer.id
      WHERE customer.lifecycle_status='ACTIVE' OR month.period_start IS NOT NULL
      GROUP BY customer.id,current_parking.current_lots,current_parking.current_rate_cents
      ORDER BY lower(COALESCE(customer.display_name,customer.company_name,
        concat_ws(' ',customer.first_name,customer.last_name))),customer.public_id`, [`${year}-01-01`]);
    res.json({ year, customers: rows.rows.map(row => ({
      publicId: row.public_id, displayName: row.customer_name, lotNumbers: row.current_lots || [],
      rateCents: Number(row.current_rate_cents || row.legacy_rate_cents || 0), periods: row.periods
    })) });
  } catch (error) { next(error); }
});

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

router.get('/customers/export.csv', read, async (req, res, next) => {
  try {
    const rows = await pool.query(`SELECT customer.public_id,
        COALESCE(customer.display_name,customer.company_name,concat_ws(' ',customer.first_name,customer.last_name)) customer_name,
        customer.company_name,customer.display_phone,customer.display_email,customer.usdot_number,customer.mc_number,
        customer.lifecycle_status,customer.legacy_current_spot,customer.legacy_rate_cents,
        balance.status payment_status,balance.balance_cents,balance.paid_cents,
        payment.payment_date last_payment_date
      FROM parking_customers customer
      LEFT JOIN LATERAL (SELECT * FROM parking_customer_billing_period_balances item WHERE item.customer_id=customer.id
        ORDER BY item.period_start DESC,item.id DESC LIMIT 1) balance ON true
      LEFT JOIN LATERAL (SELECT * FROM parking_customer_payments item WHERE item.customer_id=customer.id AND item.status='PAID'
        ORDER BY item.payment_date DESC,item.id DESC LIMIT 1) payment ON true
      ORDER BY lower(COALESCE(customer.display_name,customer.company_name,concat_ws(' ',customer.first_name,customer.last_name)))`);
    const header = ['Customer ID','Customer / Company','Company','Phone','Email','DOT','MC','Customer Status','Spot','Rate Cents','Payment Status','Balance Cents','Paid Cents','Last Payment'];
    const lines = [header, ...rows.rows.map(row => [row.public_id,row.customer_name,row.company_name,row.display_phone,row.display_email,
      row.usdot_number,row.mc_number,row.lifecycle_status,row.legacy_current_spot,row.legacy_rate_cents,
      row.payment_status || 'NOT_DUE',row.balance_cents || 0,row.paid_cents || 0,row.last_payment_date || ''])]
      .map(row => row.map(csvCell).join(','));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="parkingops-customers-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(`\uFEFF${lines.join('\r\n')}\r\n`);
  } catch (error) { next(error); }
});

router.get('/customers/:publicId', read, async (req, res, next) => {
  try {
    const customer = (await pool.query('SELECT * FROM parking_customers WHERE public_id=$1', [req.params.publicId])).rows[0];
    if (!customer) throw apiError('NOT_FOUND', 'Customer not found', 404);
    const [bookings, vehicles, periods, payments, documents, notes, conflicts, legacyParking, legacyAnomalies] = await Promise.all([
      pool.query(`SELECT booking.id,booking.reservation_number,booking.status,booking.parking_product,booking.payment_status,
          booking.arrival_at,booking.departure_at,booking.billing_period_end_at,booking.subscription_status,
          booking.company_name,booking.usdot_number,booking.tractor_unit_number,
          booking.trailer_number,booking.license_plate,booking.license_plate_state,price.snapshot,
          spot.public_label assigned_spot_label,assignment.parking_spot_id assigned_spot_id
        FROM parking_bookings booking LEFT JOIN parking_booking_price_snapshots price ON price.booking_id=booking.id
        LEFT JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id AND assignment.released_at IS NULL
        LEFT JOIN parking_spots spot ON spot.id=assignment.parking_spot_id
        WHERE booking.customer_id=$1 ORDER BY booking.arrival_at DESC,booking.id DESC`, [customer.id]),
      pool.query(`SELECT public_id,unit_number,license_plate,license_plate_state,vehicle_classification,
          vehicle_description,active,last_used_at,record_source,created_at
        FROM parking_customer_vehicles WHERE customer_id=$1 ORDER BY active DESC,last_used_at DESC NULLS LAST,id DESC`, [customer.id]),
      pool.query(`SELECT balance.*,booking.reservation_number,booking.parking_product,booking.status booking_status
        FROM parking_customer_billing_period_balances balance
        LEFT JOIN parking_bookings booking ON booking.id=balance.booking_id
        WHERE balance.customer_id=$1
        ORDER BY balance.period_start DESC,balance.id DESC`, [customer.id]),
      pool.query(`SELECT payment.public_id,payment.booking_id,payment.amount_cents,payment.currency,payment.status,
          payment.payment_source,payment.payment_method,payment.payment_date,payment.payment_date_precision,payment.reference,payment.note,
          payment.processor_payment_id,payment.receipt_url,payment.legacy_confidence,payment.created_at,
          period.public_id billing_period_public_id,period.period_start,admin.username created_by,
          COALESCE(jsonb_agg(jsonb_build_object('publicId',adjustment.public_id,'amountCents',adjustment.amount_cents,
            'type',adjustment.adjustment_type,'reason',adjustment.reason,'createdAt',adjustment.created_at,
            'createdBy',adjustment_admin.username) ORDER BY adjustment.created_at,adjustment.id)
            FILTER (WHERE adjustment.id IS NOT NULL),'[]'::jsonb) adjustments
        FROM parking_customer_payments payment
        LEFT JOIN parking_customer_billing_periods period ON period.id=payment.billing_period_id
        LEFT JOIN parking_admin_users admin ON admin.id=payment.created_by_admin_user_id
        LEFT JOIN parking_customer_payment_adjustments adjustment ON adjustment.payment_id=payment.id
        LEFT JOIN parking_admin_users adjustment_admin ON adjustment_admin.id=adjustment.created_by_admin_user_id
        WHERE payment.customer_id=$1
        GROUP BY payment.id,period.public_id,period.period_start,admin.username
        ORDER BY payment.payment_date DESC,payment.id DESC`, [customer.id]),
      pool.query(`SELECT document.public_id,document.document_type,document.verification_status,document.policy_expires_at,
          document.review_note,document.original_filename,document.declared_mime_type,document.detected_mime_type,
          document.size_bytes,document.revision,document.created_at,document.uploaded_at,document.reviewed_at,
          reviewer.username reviewed_by,booking.id booking_id,booking.reservation_number,booking.parking_product,
          booking.status booking_status,booking.tractor_unit_number,booking.license_plate,booking.license_plate_state,
          spot.public_label assigned_spot_label
        FROM parking_customer_documents document JOIN parking_bookings booking ON booking.id=document.booking_id
        LEFT JOIN parking_admin_users reviewer ON reviewer.id=document.reviewed_by_admin_user_id
        LEFT JOIN reservation_spot_assignments assignment ON assignment.booking_id=booking.id AND assignment.released_at IS NULL
        LEFT JOIN parking_spots spot ON spot.id=assignment.parking_spot_id
        WHERE booking.customer_id=$1 AND document.upload_status='UPLOADED' AND document.superseded_at IS NULL
        ORDER BY document.created_at DESC,document.id DESC`, [customer.id]),
      pool.query(`SELECT note.public_id,note.note,note.follow_up_date,note.resolved_at,note.created_at,
          creator.username created_by,resolver.username resolved_by
        FROM parking_customer_notes note
        LEFT JOIN parking_admin_users creator ON creator.id=note.created_by_admin_user_id
        LEFT JOIN parking_admin_users resolver ON resolver.id=note.resolved_by_admin_user_id
        WHERE note.customer_id=$1 ORDER BY note.resolved_at NULLS FIRST,note.follow_up_date NULLS LAST,note.created_at DESC`, [customer.id]),
      pool.query(`SELECT conflict.id,conflict.status,conflict.occurrence_count,conflict.first_detected_at,
          conflict.last_detected_at,conflict.resolution_note
        FROM parking_customer_identity_conflicts conflict
        WHERE conflict.phone_customer_id=$1 OR conflict.email_customer_id=$1 ORDER BY conflict.last_detected_at DESC`, [customer.id]),
      pool.query(`SELECT public_id,source_row,source_ref,spot_label,start_date,parking_type,rate_cents,
          license_plate,unit_number,vehicle_description,created_at
        FROM parking_customer_legacy_parking_records WHERE customer_id=$1 ORDER BY source_row,id`, [customer.id]),
      pool.query(`SELECT public_id,source_row,source_ref,period_start,classification,anomaly_type,raw_value,
          financial_effect,created_at
        FROM parking_customer_legacy_anomalies WHERE customer_id=$1 ORDER BY period_start,source_row,id`, [customer.id])
    ]);
    res.json({
      customer: {
        publicId: customer.public_id, displayName: publicName(customer), firstName: customer.first_name,
        lastName: customer.last_name, companyName: customer.company_name, phone: customer.display_phone,
        email: customer.display_email, usdotNumber: customer.usdot_number, mcNumber: customer.mc_number,
        lifecycleStatus: customer.lifecycle_status, accountStatus: customer.status, recordSource: customer.record_source,
        legacySourceRef: customer.legacy_source_ref, legacyParkingType: customer.legacy_parking_type,
        legacyCurrentSpot: customer.legacy_current_spot, legacyRateCents: customer.legacy_rate_cents,
        createdAt: customer.created_at, importedAt: customer.imported_at
      },
      reservations: bookings.rows, vehicles: vehicles.rows,
      billingPeriods: periods.rows.map(row => ({ ...row, amount_due_cents: Number(row.amount_due_cents),
        paid_cents: Number(row.paid_cents), balance_cents: Number(row.balance_cents), credit_cents: Number(row.credit_cents) })),
      payments: payments.rows.map(row => ({ ...row, amount_cents: Number(row.amount_cents) })),
      documents: documents.rows, notes: notes.rows, identityConflicts: conflicts.rows,
      legacyParkingRecords: legacyParking.rows, legacyAnomalies: legacyAnomalies.rows
    });
  } catch (error) { next(error); }
});

router.post('/customers/:publicId/payments', csrf, operate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const amount = ledger.wholeCents(req.body.amountCents);
    const paymentDate = ledger.isoDate(req.body.paymentDate, 'Payment date');
    const method = ledger.paymentMethod(req.body.method);
    const reference = cleanText(req.body.reference, 160, 'Reference');
    const note = cleanText(req.body.note, 1000, 'Payment note');
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const customer = (await client.query('SELECT * FROM parking_customers WHERE public_id=$1 FOR UPDATE', [req.params.publicId])).rows[0];
    if (!customer) throw apiError('NOT_FOUND', 'Customer not found', 404);
    // Staff pick the exact charge being paid; the month is only a fallback for older clients.
    const period = req.body.billingPeriodId
      ? (await client.query('SELECT * FROM parking_customer_billing_periods WHERE public_id=$1 AND customer_id=$2 FOR UPDATE',
        [String(req.body.billingPeriodId), customer.id])).rows[0]
      : await ledger.ensureBookingPeriod(client, customer.id, req.body.period);
    if (!period) throw apiError('BILLING_PERIOD_NOT_FOUND', 'That charge was not found for this customer', 404);
    const payment = (await client.query(`INSERT INTO parking_customer_payments(
        public_id,customer_id,booking_id,processor,processor_payment_id,parking_product,amount_cents,currency,status,
        paid_at,billing_period_id,payment_source,payment_method,payment_date,reference,note,created_by_admin_user_id)
      VALUES($1,$2,$3,NULL,NULL,$11,$4,'usd','PAID',$5::date+interval '12 hours',$6,
        'ADMIN_MANUAL',$7,$5,$8,$9,$10) RETURNING *`, [
      `pay_${token(24)}`, customer.id, period.booking_id, amount, paymentDate, period.id,
      method, reference, note, req.admin.id,
      period.booking_id ? ((await client.query('SELECT parking_product FROM parking_bookings WHERE id=$1', [period.booking_id])).rows[0]?.parking_product || 'MONTHLY') : 'MONTHLY'
    ])).rows[0];
    await audit(client, req, 'CUSTOMER_PAYMENT_RECORDED', 'CUSTOMER_PAYMENT', payment.public_id, {
      customerPublicId: customer.public_id, billingPeriodPublicId: period.public_id,
      amountCents: amount, paymentDate, method
    });
    const balance = await ledger.periodBalance(client, period.id);
    await client.query('COMMIT');
    res.status(201).json({ payment: { publicId: payment.public_id }, balance });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* transaction may not have started */ }
    next(error);
  } finally { client.release(); }
});

router.post('/payments/:paymentId/corrections', csrf, owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const amount = ledger.wholeCents(req.body.amountCents, 'Correction amount', { allowNegative: true });
    const type = enumValue(req.body.type, ['CORRECTION', 'REVERSAL'], 'correction type', { optional: false });
    if (type === 'REVERSAL' && amount >= 0) {
      throw apiError('VALIDATION_ERROR', 'A reversal amount must be negative');
    }
    const reason = cleanText(req.body.reason, 1000, 'Correction reason', true);
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const payment = (await client.query(`SELECT payment.*,
        COALESCE((SELECT sum(amount_cents) FROM parking_customer_payment_adjustments WHERE payment_id=payment.id),0) adjusted_cents
      FROM parking_customer_payments payment WHERE payment.public_id=$1 FOR UPDATE`, [req.params.paymentId])).rows[0];
    if (!payment) throw apiError('NOT_FOUND', 'Payment not found', 404);
    if (!payment.billing_period_id) throw apiError('BILLING_PERIOD_REQUIRED', 'This payment is not linked to a billing period', 409);
    const effectiveBefore = Number(payment.amount_cents) + Number(payment.adjusted_cents);
    if (effectiveBefore + amount < 0) throw apiError('CORRECTION_EXCEEDS_PAYMENT', 'The correction would make this payment negative', 409);
    const adjustment = (await client.query(`INSERT INTO parking_customer_payment_adjustments(
        public_id,payment_id,billing_period_id,amount_cents,adjustment_type,reason,created_by_admin_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [
      `adj_${token(24)}`, payment.id, payment.billing_period_id, amount, type, reason, req.admin.id
    ])).rows[0];
    await audit(client, req, 'CUSTOMER_PAYMENT_CORRECTED', 'CUSTOMER_PAYMENT', payment.public_id, {
      adjustmentPublicId: adjustment.public_id, amountCents: amount, type, reason,
      effectiveBeforeCents: effectiveBefore, effectiveAfterCents: effectiveBefore + amount
    });
    const balance = await ledger.periodBalance(client, payment.billing_period_id);
    await client.query('COMMIT');
    res.status(201).json({ adjustment: { publicId: adjustment.public_id }, balance });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* transaction may not have started */ }
    next(error);
  } finally { client.release(); }
});

router.post('/customers/:publicId/notes', csrf, operate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const noteText = cleanText(req.body.note, 4000, 'Note', true);
    const followUpDate = req.body.followUpDate ? ledger.isoDate(req.body.followUpDate, 'Follow-up date') : null;
    await client.query('BEGIN');
    const customer = (await client.query('SELECT id FROM parking_customers WHERE public_id=$1 FOR UPDATE', [req.params.publicId])).rows[0];
    if (!customer) throw apiError('NOT_FOUND', 'Customer not found', 404);
    const note = (await client.query(`INSERT INTO parking_customer_notes(
        public_id,customer_id,note,follow_up_date,created_by_admin_user_id)
      VALUES($1,$2,$3,$4,$5) RETURNING *`, [`note_${token(24)}`, customer.id, noteText, followUpDate, req.admin.id])).rows[0];
    await audit(client, req, 'CUSTOMER_NOTE_ADDED', 'CUSTOMER', req.params.publicId, {
      notePublicId: note.public_id, followUpDate
    });
    await client.query('COMMIT');
    res.status(201).json({ note: { publicId: note.public_id, note: note.note, followUpDate: note.follow_up_date } });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* transaction may not have started */ }
    next(error);
  } finally { client.release(); }
});

router.patch('/customer-notes/:noteId/resolve', csrf, operate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const note = (await client.query(`UPDATE parking_customer_notes SET resolved_at=now(),resolved_by_admin_user_id=$2
      WHERE public_id=$1 AND resolved_at IS NULL RETURNING *`, [req.params.noteId, req.admin.id])).rows[0];
    if (!note) throw apiError('NOT_FOUND', 'Open customer note not found', 404);
    await audit(client, req, 'CUSTOMER_NOTE_RESOLVED', 'CUSTOMER_NOTE', note.public_id, { customerId: Number(note.customer_id) });
    await client.query('COMMIT');
    res.json({ resolved: true });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* transaction may not have started */ }
    next(error);
  } finally { client.release(); }
});

router.patch('/customers/:publicId/status', csrf, owner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const status = enumValue(req.body.status, ['ACTIVE', 'FORMER'], 'customer status', { optional: false });
    const reason = cleanText(req.body.reason, 1000, 'Status reason', true);
    await client.query('BEGIN');
    const before = (await client.query('SELECT id,lifecycle_status FROM parking_customers WHERE public_id=$1 FOR UPDATE',
      [req.params.publicId])).rows[0];
    if (!before) throw apiError('NOT_FOUND', 'Customer not found', 404);
    const customer = (await client.query(`UPDATE parking_customers SET lifecycle_status=$2
      WHERE id=$1 RETURNING id,lifecycle_status`, [before.id, status])).rows[0];
    if (before.lifecycle_status !== status) {
      await audit(client, req, 'CUSTOMER_STATUS_CHANGED', 'CUSTOMER', req.params.publicId, {
        before: before.lifecycle_status, after: status, reason
      });
    }
    await client.query('COMMIT');
    res.json({ lifecycleStatus: customer.lifecycle_status });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* transaction may not have started */ }
    next(error);
  } finally { client.release(); }
});

module.exports = router;
