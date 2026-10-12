# Layout Read Model

The snapshot uses only the published layout. `layout` is `null` when no published map exists. When present, it includes ID, version, publish time, and ordered elements with stable element IDs, type, label, linked space ID, normalized coordinates, rotation, z-order, and `RECTANGLE` shape.

The existing schema supports generic typed rectangular elements such as parking spaces, entrances, exits, office, drive lane, restricted area, and labels. It does not yet represent polygons, curves, image underlays, or first-class arrows/obstacles. Phase 2A adds no schema extension because the operational read contract does not require inventing those shapes; Phase 2B must render supported types and surface unsupported map requirements for owner confirmation.
