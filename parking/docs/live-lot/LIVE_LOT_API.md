# Live Lot API

All routes are under `/api/admin/parking/v1`, require an authenticated `OWNER` or `STAFF`, and return JSON. They do not expose payment or session data.

## Snapshot

`GET /locations/:locationId/live-lot/snapshot`

Parameters: `at` (offset-bearing ISO timestamp), `vehicleCategoryId`, `operationalStatus`, `parkingUse`, `availableOnly=true`, and `search`. `at` defaults to now and is limited to ±366 days. The response contains `location`, `requestedAt`, `evaluatedAt`, summary counts, normalized `spaces`, published `layout` (or `null`), and warnings. Empty lots return an empty `spaces` array; missing published maps return `layout: null` plus `NO_PUBLISHED_LAYOUT`.

Each space includes stable ID/number, area, status, booking visibility, eligibility, current/next reservation, current assignment, active block, optional layout rectangle, and warnings. Map responses omit customer phone/email; selected-space detail supplies operational PII.

## Detail

`GET /spaces/:spaceId/operational-detail?at=...`

Returns the selected snapshot record, bounded internal notes, latest 20 assignment-history entries, current customer/vehicle when assigned, and advisory action eligibility. Mutation endpoints remain independently authorized and validated.

## Timeline

`GET /spaces/:spaceId/timeline?from=...&to=...`

Offsets are required for supplied timestamps. Default range is 30 days from `from`; maximum requested range is 90 days. Response intervals use `[startsAt, endsAt)` and contain `AVAILABLE`, `RESERVED`, `OCCUPIED`, or `BLOCKED` periods plus warnings.

## Search

`GET /operational-search?locationId=:id&q=:query&limit=20`

Requires a two-character query and a location scope; max limit is 50. It returns grouped `spaces`, `reservations`, derived `customers`, and `vehicles`. SQL wildcard characters are escaped before `ILIKE` matching; phone searches additionally compare normalized digits. USDOT is not returned because the current schema has no USDOT field.

Errors use existing API error envelopes, including `AUTHENTICATION_REQUIRED`, `PERMISSION_DENIED`, `VALIDATION_ERROR`, `OPERATIONAL_TIME_OFFSET_REQUIRED`, `INVALID_TIMELINE_RANGE`, and `TIMELINE_RANGE_TOO_LARGE`.
