# Integrity Warnings

Warnings are non-fatal, structured objects with code, severity, message, and relevant stable IDs. Snapshot warnings include:

- `NO_PUBLISHED_LAYOUT`
- `SPACE_MISSING_PUBLISHED_LAYOUT_ELEMENT`
- `SPACE_MISSING_AREA`
- `SPACE_NO_ACTIVE_VEHICLE_ELIGIBILITY`
- `BLOCKED_FUTURE_RESERVATION`
- `ASSIGNMENT_PAST_EXPECTED_DEPARTURE`
- `TIMELINE_OVERLAP` (timeline only)

Database constraints already prevent several requested invalid forms (duplicate labels per location, invalid spot/inventory relationships, incompatible assignment booking relationships, and overlapping current assignments). The read model still avoids silently omitting any active space when its map/eligibility configuration is incomplete.
