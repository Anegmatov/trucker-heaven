-- Anchor the one shared driveway marker inside the measured gap between spaces
-- 143 and 142 on every canonical draft/published snapshot.  Separate legacy
-- ENTRANCE/EXIT records may remain for compatibility, but both resolve to this
-- same rectangle and render as one combined marker.

SELECT set_config('parking.layout_publication','on',true);

WITH gaps AS (
  SELECT layout.id layout_id,
    max(upper_space.y+upper_space.height) upper_edge,
    min(lower_space.y) lower_edge,
    min(lower_space.x) access_x,
    min(lower_space.width) access_width
  FROM parking_lot_layouts layout
  JOIN parking_layout_elements upper_space ON upper_space.layout_id=layout.id AND upper_space.label='143'
  JOIN parking_layout_elements lower_space ON lower_space.layout_id=layout.id AND lower_space.label='142'
  WHERE layout.name LIKE 'Trucker Heaven physical lot%'
    AND upper_space.parking_spot_id IS NOT NULL AND lower_space.parking_spot_id IS NOT NULL
  GROUP BY layout.id
), positions AS (
  SELECT layout_id,access_x x,
    upper_edge+(lower_edge-upper_edge)*0.25 y,
    access_width width,
    (lower_edge-upper_edge)*0.5 height
  FROM gaps WHERE lower_edge>upper_edge
)
UPDATE parking_layout_elements access
SET x=position.x,y=position.y,width=position.width,height=position.height,
    rotation=0,label='Entrance / Exit',version=access.version+1,updated_at=now()
FROM positions position
WHERE access.layout_id=position.layout_id AND access.element_type IN ('ENTRANCE','EXIT')
  AND (access.x,access.y,access.width,access.height,access.rotation,access.label)
    IS DISTINCT FROM (position.x,position.y,position.width,position.height,0,'Entrance / Exit');

UPDATE parking_area_directions direction
SET exit_element_key=entrance_element_key,
    exit_route_element_keys=arrival_route_element_keys,
    version=version+1,updated_at=now()
WHERE entrance_element_key IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM parking_lot_layouts layout
    WHERE layout.location_id=direction.location_id AND layout.name LIKE 'Trucker Heaven physical lot%'
  )
  AND (exit_element_key IS DISTINCT FROM entrance_element_key
    OR exit_route_element_keys IS DISTINCT FROM arrival_route_element_keys);
