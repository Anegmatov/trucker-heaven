# Safe Implementation Plan

## Guardrails for every stage

Do not delete, rename, re-number, or reassign historical spaces. Preserve old routes/UI during rollout. Use owner authorization, CSRF, optimistic versions, transactions, audit events, draft/publication invalidation, and an explicit rollback/feature flag for every write path. Run `npm run check`, `npm test`, `npm run verify`, and relevant PostgreSQL integration tests in the isolated test database.

| Stage | Work and likely files | Migrations/APIs/tests | Rollback and data risk |
|---|---|---|---|
| 1. Baseline | Freeze/document current schema and production record counts; retain this audit | No migration. Read-only schema/report script could be added later | No data risk; documentation rollback is removal of docs only. |
| 2. Terminology layer | `frontend-admin/app.js`, `index.html`, styles; use Lot/Area/Parking type vocabulary | No migration; UI/unit verification updates | Feature flag/new view. Risk is misleading language; retain advanced labels/help. |
| 3. Provisioning command | `backend/routes/adminParking.js` plus a dedicated service (preferred) | Add owner-only transactional command and API contract tests. It resolves/reuses or creates area/category/inventory safely | Disable endpoint/flag. Main risk is accidental reuse/mutation; prohibit updates to rows with history. |
| 4. Map-first flow | Admin frontend components/state/styles; preserve existing wizard as Advanced Setup | Read draft/spot APIs; test blank map, underlay privacy, drafts and permissions | Flag back to existing wizard. No public changes before publish. |
| 5. Bulk rows/spaces | New setup service, existing bulk endpoint refactor or a new row command | Possibly no migration; tests for reverse/skip/duplicate/bounds/atomic spot-element links | Disable new command. Partial writes are prevented by one transaction. |
| 6. Group use/eligibility | Provisioning mapping config/service and map selection UI | API tests for Daily/Monthly/Bobtail/Company/Shop/blocked/staff-only mapping and exact eligibility | Turn off editor action; mapping must create replacements, never relink assigned spots. |
| 7. Rates | Simple rate panel, mapping to `parking_rate_rules`; advanced rate UI remains | API tests for daily/weekly/monthly, priority, effective dates and quote snapshots | Disable simple panel; rate history/snapshots remain intact. |
| 8. Review/publish | Extend `setupChecklist`/UI with number/use/rate/map findings | Tests for duplicate/missing/intentionally skipped numbers, unclassified spaces, incomplete routes, prior published layout retention | Publication stays atomic; old published layout remains on failed review. |
| 9. Advanced fallback | Relabel existing wizard/config routes as Advanced Setup | No schema change; regression test all existing admin workflows | Keep indefinitely until adoption/coverage evidence. |
| 10. Existing lots | Read-only adapter that displays existing area/inventory records as map groups; optional owner-reviewed metadata mapping | Migration only if new non-authoritative setup metadata is needed; migration must be additive | Do not bulk backfill guesses. Hide adapter with flag; physical mappings require review. |
| 11. Retirement decision | Measure successful publishes, support issues, audit old-flow use; remove only after explicit approval | Full regression suite and migration/recovery rehearsal | Prefer retaining Advanced Setup; no destructive cleanup without separate approved plan. |

## Suggested additive data shape, only if evidence requires it

Do not start with a replacement schema. If group selection needs provenance that cannot be derived from existing rows, add an additive, non-authoritative setup metadata table keyed to location/layout draft or generated group key. It can store owner-facing parking-use labels and provisioning provenance while the canonical reservation relationships remain unchanged. Its migration must be backward compatible and its rows must never replace historical assignment facts.

## Essential new test matrix

- A simple one-area lot provisions a default area/inventory and creates a numbered row transactionally.
- Multiple visual labels do not create areas unless a policy boundary is selected.
- A mapped Monthly Bobtail selection books only compatible, public, published, active, unblocked exact spaces.
- Staff-only/company/shop/blocked choices are not publicly selectable; blocks respect intervals.
- Existing exact assignments survive a map edit, failed publish, reassignment, check-in/out and cancellation.
- Concurrent overlapping bookings still permit no more than one final assignment per available space.
- Old wizard/config routes and public opaque area IDs remain compatible throughout the rollout.
