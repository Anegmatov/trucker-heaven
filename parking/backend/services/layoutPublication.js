const { apiError } = require('../utils');
const { capacityBlockingStatuses } = require('./bookingWorkflow');
const { lockInventoryIds } = require('./parkingService');

async function protectAssignedSpaces(client, draft) {
  const inventory = await client.query(`SELECT i.id FROM parking_inventory i
    JOIN parking_zones z ON z.id=i.zone_id WHERE z.location_id=$1 ORDER BY i.id`, [draft.location_id]);
  await lockInventoryIds(client, inventory.rows.map(row => row.id));

  // Booking allocation takes the inventory advisory lock before locking a spot.
  // Publication uses the same order, then locks every physical spot represented
  // by this draft before it inspects the unreleased assignment rows.
  await client.query(`SELECT spot.id FROM parking_layout_elements element
    JOIN parking_spots spot ON spot.id=element.parking_spot_id
    WHERE element.layout_id=$1 ORDER BY spot.id FOR UPDATE OF spot`, [draft.id]);

  const conflicts = await client.query(`SELECT spot.id spot_id,spot.public_label,
      booking.reservation_number,booking.status,
      array_remove(ARRAY[
        CASE WHEN NOT element.active THEN 'SPACE_INACTIVE' END,
        CASE WHEN element.inventory_id IS DISTINCT FROM booking.inventory_id THEN 'INVENTORY_CHANGED' END,
        CASE WHEN element.parking_purpose IS DISTINCT FROM 'CUSTOMER' THEN 'PURPOSE_CHANGED' END,
        CASE WHEN NOT element.space_public_bookable THEN 'BOOKING_CLASSIFICATION_CHANGED' END,
        CASE WHEN booking.parking_product='MONTHLY' AND NOT element.monthly_eligible THEN 'MONTHLY_TERM_REMOVED' END
      ],NULL) reasons
    FROM parking_layout_elements element
    JOIN parking_spots spot ON spot.id=element.parking_spot_id
    JOIN reservation_spot_assignments assignment ON assignment.parking_spot_id=spot.id AND assignment.released_at IS NULL
    JOIN parking_bookings booking ON booking.id=assignment.booking_id
    WHERE element.layout_id=$1
      AND booking.status=ANY($2::text[])
      AND (booking.status='CHECKED_IN' OR assignment.protected_until_at>now())
      AND (NOT element.active
        OR element.inventory_id IS DISTINCT FROM booking.inventory_id
        OR element.parking_purpose IS DISTINCT FROM 'CUSTOMER'
        OR NOT element.space_public_bookable
        OR (booking.parking_product='MONTHLY' AND NOT element.monthly_eligible))
    ORDER BY spot.public_label,booking.reservation_number
    FOR UPDATE OF assignment`, [draft.id, capacityBlockingStatuses()]);
  if (conflicts.rowCount) {
    throw apiError('ACTIVE_ASSIGNMENT_CONFLICT',
      'Reassign or resolve active and future reservations before publishing these space changes', 409, {
        spaces: conflicts.rows.map(row => ({
          spaceId: Number(row.spot_id), space: row.public_label,
          reservationNumber: row.reservation_number, status: row.status, reasons: row.reasons
        }))
      });
  }

  const capacityConflicts = await client.query(`WITH commitments AS (
      SELECT booking.id,booking.inventory_id,booking.status,
        CASE WHEN booking.status='CHECKED_IN' THEN COALESCE(booking.actual_arrival_at,booking.arrival_at) ELSE booking.arrival_at END starts_at,
        CASE WHEN booking.status='CHECKED_IN' AND booking.actual_departure_at IS NULL THEN 'infinity'::timestamptz
          WHEN booking.status='CHECKED_IN' THEN booking.actual_departure_at ELSE booking.departure_at END ends_at,
        CASE
          WHEN booking.parking_product='DAILY' THEN 'DAILY'
          WHEN booking.parking_product='WEEKLY' THEN 'WEEKLY'
          WHEN booking.parking_product='MONTHLY' THEN 'MONTHLY'
          WHEN booking.parking_product='LEGACY' AND EXISTS (
            SELECT 1 FROM reservation_spot_assignments exact_assignment
            JOIN parking_layout_elements exact_element
              ON exact_element.layout_id=$1 AND exact_element.parking_spot_id=exact_assignment.parking_spot_id
            WHERE exact_assignment.booking_id=booking.id AND exact_assignment.released_at IS NULL
              AND exact_element.monthly_eligible AND NOT exact_element.daily_eligible
          ) THEN 'MONTHLY'
          WHEN booking.parking_product='LEGACY' AND EXISTS (
            SELECT 1 FROM reservation_spot_assignments exact_assignment
            JOIN parking_layout_elements exact_element
              ON exact_element.layout_id=$1 AND exact_element.parking_spot_id=exact_assignment.parking_spot_id
            WHERE exact_assignment.booking_id=booking.id AND exact_assignment.released_at IS NULL
              AND exact_element.daily_eligible AND NOT exact_element.monthly_eligible
          ) THEN 'DAILY'
          WHEN snapshot.snapshot->>'duration'='MONTHLY' THEN 'MONTHLY'
          WHEN snapshot.snapshot->>'duration'='WEEKLY' THEN 'WEEKLY'
          ELSE 'DAILY'
        END duration
      FROM parking_bookings booking
      JOIN parking_booking_price_snapshots snapshot ON snapshot.booking_id=booking.id
      WHERE booking.location_id=$2 AND booking.status=ANY($3::text[])
        AND (CASE WHEN booking.status='CHECKED_IN' AND booking.actual_departure_at IS NULL THEN true
          WHEN booking.status='CHECKED_IN' THEN booking.actual_departure_at>now() ELSE booking.departure_at>now() END)
    ), inventory_duration AS (
      SELECT DISTINCT inventory_id,duration FROM commitments
    ), proposed_spots AS (
      SELECT element.inventory_id,spot.id parking_spot_id,duration.duration
      FROM parking_layout_elements element
      JOIN parking_spots spot ON spot.id=element.parking_spot_id
      JOIN parking_inventory configured_inventory ON configured_inventory.id=element.inventory_id
      JOIN parking_rate_rules plan ON plan.id=element.rate_plan_id
        AND plan.active AND plan.location_id=spot.location_id
        AND plan.category_id=configured_inventory.category_id
        AND (plan.zone_id IS NULL OR plan.zone_id=spot.zone_id)
        AND (plan.starts_at IS NULL OR plan.starts_at<=now())
        AND (plan.ends_at IS NULL OR plan.ends_at>now())
      JOIN inventory_duration duration ON duration.inventory_id=element.inventory_id
      WHERE element.layout_id=$1 AND element.element_type='PARKING_SPOT'
        AND element.active AND element.public_visible AND element.parking_purpose='CUSTOMER'
        AND element.space_public_bookable AND spot.active AND spot.public_bookable
        AND spot.classification_state='COMPLETE'
        AND ((duration.duration='DAILY' AND element.daily_eligible AND plan.daily_rate_cents IS NOT NULL)
          OR (duration.duration='WEEKLY' AND element.weekly_eligible AND plan.weekly_rate_cents IS NOT NULL)
          OR (duration.duration='MONTHLY' AND element.monthly_eligible AND plan.monthly_rate_cents IS NOT NULL))
    ), capacities AS (
      SELECT inventory_id,duration,count(*)::int physical_capacity
      FROM proposed_spots GROUP BY inventory_id,duration
    ), horizons AS (
      SELECT inventory_id,duration,
        CASE WHEN bool_or(ends_at='infinity'::timestamptz) THEN COALESCE(max(ends_at) FILTER (WHERE ends_at<>'infinity'::timestamptz),now()+interval '100 years')
          ELSE GREATEST(now(),max(ends_at)) END horizon
      FROM commitments GROUP BY inventory_id,duration
    ), points AS (
      SELECT inventory_id,duration,now() point FROM inventory_duration
      UNION
      SELECT target.inventory_id,target.duration,GREATEST(now(),booking.starts_at)
      FROM inventory_duration target JOIN commitments booking ON booking.inventory_id=target.inventory_id
      JOIN horizons horizon ON horizon.inventory_id=target.inventory_id AND horizon.duration=target.duration
      WHERE booking.starts_at<horizon.horizon AND booking.ends_at>now()
      UNION
      SELECT target.inventory_id,target.duration,block.starts_at
      FROM inventory_duration target JOIN horizons horizon USING(inventory_id,duration)
      JOIN proposed_spots proposed USING(inventory_id,duration)
      JOIN parking_spot_blocks block ON block.parking_spot_id=proposed.parking_spot_id
      WHERE block.released_at IS NULL AND block.starts_at>=now() AND block.starts_at<horizon.horizon
      UNION
      SELECT target.inventory_id,target.duration,closure.starts_at
      FROM inventory_duration target JOIN horizons horizon USING(inventory_id,duration)
      JOIN parking_inventory inventory ON inventory.id=target.inventory_id
      JOIN parking_zones zone ON zone.id=inventory.zone_id
      JOIN parking_closures closure ON closure.active
        AND (closure.location_id=zone.location_id OR closure.zone_id=zone.id
          OR closure.inventory_id=inventory.id OR closure.category_id=inventory.category_id)
      WHERE closure.starts_at>=now() AND closure.starts_at<horizon.horizon
    ), measured AS (
      SELECT point.inventory_id,point.duration,point.point,COALESCE(capacity.physical_capacity,0)::int physical_capacity,
        (SELECT count(*)::int FROM commitments booking
          WHERE booking.inventory_id=point.inventory_id AND booking.starts_at<=point.point AND booking.ends_at>point.point) commitments,
        (SELECT count(DISTINCT proposed.parking_spot_id)::int FROM proposed_spots proposed
          JOIN parking_spot_blocks block ON block.parking_spot_id=proposed.parking_spot_id
          WHERE proposed.inventory_id=point.inventory_id AND proposed.duration=point.duration
            AND block.released_at IS NULL AND block.starts_at<=point.point
            AND COALESCE(block.ends_at,'infinity'::timestamptz)>point.point) blocked,
        (SELECT COALESCE(sum(closure.capacity_reduction) FILTER (WHERE closure.closure_type='CAPACITY_REDUCTION'),0)::int
          FROM parking_inventory inventory JOIN parking_zones zone ON zone.id=inventory.zone_id
          LEFT JOIN parking_closures closure ON closure.active AND closure.starts_at<=point.point AND closure.ends_at>point.point
            AND (closure.location_id=zone.location_id OR closure.zone_id=zone.id
              OR closure.inventory_id=inventory.id OR closure.category_id=inventory.category_id)
          WHERE inventory.id=point.inventory_id) closure_reduction,
        EXISTS(SELECT 1 FROM parking_inventory inventory JOIN parking_zones zone ON zone.id=inventory.zone_id
          JOIN parking_closures closure ON closure.active AND closure.closure_type='FULL_CLOSURE'
            AND closure.starts_at<=point.point AND closure.ends_at>point.point
            AND (closure.location_id=zone.location_id OR closure.zone_id=zone.id
              OR closure.inventory_id=inventory.id OR closure.category_id=inventory.category_id)
          WHERE inventory.id=point.inventory_id) closed
      FROM points point LEFT JOIN capacities capacity USING(inventory_id,duration)
    ) SELECT inventory_id,duration,point,physical_capacity,commitments,blocked,closure_reduction,closed,
        GREATEST(0,commitments+blocked+closure_reduction-physical_capacity)::int shortfall
      FROM measured
      WHERE commitments>0 AND (closed OR commitments+blocked+closure_reduction>physical_capacity)
      ORDER BY point,inventory_id,duration LIMIT 20`, [draft.id, draft.location_id, capacityBlockingStatuses()]);
  if (capacityConflicts.rowCount) {
    throw apiError('AREA_CAPACITY_COMMITMENT_CONFLICT',
      'Publishing this layout would reduce usable parking-area capacity below active or future commitments', 409, {
        conflicts: capacityConflicts.rows.map(row => ({
          inventoryId: Number(row.inventory_id), duration: row.duration, at: row.point,
          physicalCapacity: Number(row.physical_capacity), commitments: Number(row.commitments),
          blocked: Number(row.blocked), closureReduction: Number(row.closure_reduction),
          closed: Boolean(row.closed), shortfall: row.closed ? Number(row.commitments) : Number(row.shortfall)
        }))
      });
  }
}

// The only writer that turns a draft into a public layout snapshot.
async function publishDraftSnapshot(client, { layoutId, actorId, onStep = null }) {
  const step = async name => { if (onStep) await onStep(name); };
  const draftResult = await client.query("SELECT * FROM parking_lot_layouts WHERE id=$1 AND status='DRAFT' FOR UPDATE", [layoutId]);
  if (!draftResult.rowCount) throw new Error('Only a draft layout can be published');
  const draft = draftResult.rows[0];
  // Exact booking takes inventory advisory locks before it reads/locks rows
  // protected by location foreign keys. Publication must use that same order.
  await protectAssignedSpaces(client, draft);
  await client.query('SELECT id FROM parking_locations WHERE id=$1 FOR UPDATE', [draft.location_id]);
  const current = (await client.query("SELECT * FROM parking_lot_layouts WHERE location_id=$1 AND status='PUBLISHED' FOR UPDATE", [draft.location_id])).rows[0] || null;
  const nextVersion = Number((await client.query('SELECT COALESCE(max(version),0)::int version FROM parking_lot_layouts WHERE location_id=$1', [draft.location_id])).rows[0].version) + 1;
  await client.query("SELECT set_config('parking.layout_publication','on',true)");
  const snapshot = (await client.query(`INSERT INTO parking_lot_layouts(location_id,name,status,version,published_at,superseded_at,superseded_by_layout_id,created_by_admin_user_id,updated_by_admin_user_id)
    VALUES($1,$2,'SUPERSEDED',$3,now(),now(),$4,$5,$5) RETURNING *`, [draft.location_id, draft.name, nextVersion, current?.id || layoutId, actorId])).rows[0];
  await step('after_snapshot_created');
  await client.query(`INSERT INTO parking_layout_elements(layout_id,element_type,element_key,label,zone_id,inventory_id,parking_spot_id,x,y,width,height,rotation,layer_order,public_visible,active,parking_purpose,daily_eligible,weekly_eligible,monthly_eligible,space_public_bookable,space_internal_note,rate_plan_id)
    SELECT $1,element_type,element_key,label,zone_id,inventory_id,parking_spot_id,x,y,width,height,rotation,layer_order,public_visible,active,parking_purpose,daily_eligible,weekly_eligible,monthly_eligible,space_public_bookable,space_internal_note,rate_plan_id
    FROM parking_layout_elements WHERE layout_id=$2`, [snapshot.id, layoutId]);
  await step('after_elements_copied');
  await step('before_previous_superseded');
  if (current) await client.query(`UPDATE parking_lot_layouts SET status='SUPERSEDED',superseded_at=now(),superseded_by_layout_id=$1,updated_by_admin_user_id=$2
    WHERE id=$3`, [snapshot.id, actorId, current.id]);
  await step('after_previous_superseded');
  await step('before_snapshot_published');
  await client.query(`UPDATE parking_lot_layouts SET status='PUBLISHED',superseded_at=NULL,superseded_by_layout_id=NULL,updated_by_admin_user_id=$1
    WHERE id=$2`, [actorId, snapshot.id]);
  // Draft configuration becomes operational only here, in the same transaction
  // as the immutable public snapshot. A draft edit can therefore never change
  // customer availability or assignment before publication.
  await client.query('SET CONSTRAINTS parking_spots_location_id_public_label_key DEFERRED');
  await client.query(`UPDATE parking_spots spot SET
      public_label=element.label,
      zone_id=element.zone_id,
      inventory_id=element.inventory_id,
      parking_use=CASE element.parking_purpose
        WHEN 'UNRESOLVED' THEN 'NEEDS_CLASSIFICATION'
        WHEN 'COMPANY' THEN 'COMPANY'
        WHEN 'SHOP' THEN CASE WHEN spot.parking_use='SHOP_BOBTAIL' THEN 'SHOP_BOBTAIL' ELSE 'SHOP' END
        WHEN 'INTERNAL' THEN 'INTERNAL'
        WHEN 'CUSTOMER' THEN CASE WHEN category.code='BOBTAIL' THEN 'CUSTOMER_BOBTAIL' ELSE 'CUSTOMER' END
        ELSE spot.parking_use END,
      classification_state=CASE WHEN element.parking_purpose='UNRESOLVED' THEN 'NEEDS_CLASSIFICATION' ELSE 'COMPLETE' END,
      public_bookable=(element.parking_purpose='CUSTOMER' AND element.space_public_bookable),
      active=element.active,
      version=spot.version+1
    FROM parking_layout_elements element
    JOIN parking_inventory inventory ON inventory.id=element.inventory_id
    JOIN parking_categories category ON category.id=inventory.category_id
    WHERE element.layout_id=$1 AND element.parking_spot_id=spot.id`, [snapshot.id]);
  await step('after_snapshot_published');
  await step('before_commit');
  return { draft, previous: current, published: { ...snapshot, status: 'PUBLISHED', superseded_at: null, superseded_by_layout_id: null }, nextVersion };
}
module.exports = { publishDraftSnapshot, protectAssignedSpaces };
