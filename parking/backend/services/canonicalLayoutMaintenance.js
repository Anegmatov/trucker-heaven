'use strict';

function enabled(environment = process.env) {
  return environment.PARKING_CANONICAL_LAYOUT_MAINTENANCE === 'true';
}

function locked(hasCanonicalLayout, environment = process.env) {
  return Boolean(hasCanonicalLayout) && !enabled(environment);
}

async function structuralChanges(client, draftLayoutId, locationId) {
  const result = await client.query(`SELECT EXISTS(
    (SELECT element_type,element_key,parking_spot_id,x,y,width,height,rotation,layer_order
       FROM parking_layout_elements WHERE layout_id=$1
     EXCEPT
     SELECT element_type,element_key,parking_spot_id,x,y,width,height,rotation,layer_order
       FROM parking_layout_elements WHERE layout_id=(SELECT id FROM parking_lot_layouts WHERE location_id=$2 AND status='PUBLISHED'))
    UNION ALL
    (SELECT element_type,element_key,parking_spot_id,x,y,width,height,rotation,layer_order
       FROM parking_layout_elements WHERE layout_id=(SELECT id FROM parking_lot_layouts WHERE location_id=$2 AND status='PUBLISHED')
     EXCEPT
     SELECT element_type,element_key,parking_spot_id,x,y,width,height,rotation,layer_order
       FROM parking_layout_elements WHERE layout_id=$1)
  ) changed`, [draftLayoutId, locationId]);
  return Boolean(result.rows[0].changed);
}

module.exports = Object.freeze({ enabled, locked, structuralChanges });
