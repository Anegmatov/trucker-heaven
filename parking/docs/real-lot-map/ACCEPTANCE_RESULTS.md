# Acceptance results

Completed on an isolated disposable `parkingops_test` PostgreSQL container:

- Migration 015 applied successfully and a second migration run was a no-op.
- `npm run verify:all` passed: syntax checks, 9 unit tests, frontend structure verification, and the PostgreSQL booking, layout, lot-setup, and exact-space integration suites.
- The container was created by `backend/scripts/verify-launch.sh` and removed on exit. No development database was written.

Browser acceptance was not run in this environment because no supported browser executable or browser-test harness is installed. It remains the release-time checklist item for the specified desktop and mobile viewports, using temporary OWNER and STAFF accounts only. No host `DATABASE_URL` targeting `ifta_db` was used.

## Photo-calibration verification

The authoritative printed-map photo was inspected from the documented local Windows-mounted path. `npm run check`, `npm run verify`, and `PARKING_VERIFY_PARENT_SITE=false npm run verify:all` passed after calibration. The focused unit suite now verifies the 185-number inventory, absence of `91`–`100`, protected `73`–`80`, photographed paired/stacked relationships, coordinate bounds, non-overlapping spaces, and no parking-space/building intersection.

The real browser acceptance matrix and screenshots remain pending because no browser executable or browser-test harness is available in this environment. No development import was applied: the available inherited URL targets `ifta_db`, which the importer rejected before connection.
# Immutable publication acceptance

Publication acceptance requires one current `PUBLISHED` layout, preserved `SUPERSEDED` geometry, and no active physical spot lacking a current published element.

## PostgreSQL immutable-publication certification

Completed on a disposable PostgreSQL 16 `parkingops_test` container. Fresh migrations 001–019 applied, then replayed without further schema changes. The focused layout suite contains 12 passing PostgreSQL-backed tests.

- Every publisher failure checkpoint (`after_snapshot_created`, `after_elements_copied`, `before_previous_superseded`, `after_previous_superseded`, `before_snapshot_published`, and `before_commit`) rolled back to the original one-current-layout state with no snapshot or copied elements committed. Sequence gaps are normal after rollback.
- Database triggers rejected direct metadata, version, layout, and element changes to published and superseded snapshots, while draft element edits remained supported.
- Two asynchronous publishers for one location serialized into consecutive immutable versions with exactly one current snapshot. Publishers for different locations completed independently.
- A reader held while a writer paused immediately before commit saw the complete old public snapshot; a later reader saw only the complete new snapshot.
- The authenticated OWNER route was exercised by the layout integration suite; STAFF remains denied and incomplete drafts remain rejected.

Three forward-only corrective migrations were added during this certification: 017 fixes `BEFORE DELETE` trigger return values, 018 removes the retained legacy two-state status check, and 019 closes the NULL `current_setting` bypass in the historical-element trigger.

The importer’s option and guarded apply/publish contract remain covered by unit tests and the production-like PostgreSQL fixture below. Production still requires the approved preflight, backup, migration, and explicit change authorization sequence.

## Production-like importer certification

Completed on disposable PostgreSQL `18.4 (Debian 18.4-1.pgdg13+1)` with database name `parkingops_test`. The new `realLotImporter.integration.test.js` creates the audited legacy shape: `South Zone`, `North Zone`, whitespace-variant `South  Zone`, 25 active N/S generic spaces, `North Zone layout` v4, and a completed booking plus released assignment referencing `N-01`.

- Successful combined import produced 185 numeric spaces (10–90, 101–196, 197–204; no 91–100), 205 new layout elements including 185 parking elements, one newer current snapshot, and an untouched superseded v4 snapshot.
- The 25 generic spaces remained present but inactive; the historical booking and assignment continued to reference `N-01`. Protected 73–80 remained non-public `NEEDS_CLASSIFICATION`; 81–90 remained Shop and 101–110 Company, all internal.
- Nine direct callback checkpoints each proved transaction rollback: physical spaces, classifications, generic deactivation, legacy-zone hiding, draft elements, snapshot creation, supersession, publication, and pre-commit.
- Two independent connections yielded one complete import and one clean “already transformed” rejection. A repeat combined import is deliberately rejected rather than attempting another publication.

`PARKING_VERIFY_PARENT_SITE=false npm run verify:all` was started against PostgreSQL 18. The execution window stopped it after 22 unit tests, 17 core PostgreSQL tests, and 12 layout tests passed, at the start of the importer suite. The importer (3/3), lot setup (1/1), and exact-space (9/9) suites were validated independently on disposable databases. This timeout is not a completed uninterrupted verification result.

## Legacy 015 to 019 upgrade certification

`npm run test:legacy-layout-upgrade` passed on a fresh PostgreSQL 18 `parkingops_test` database. It applies 001–015, creates `South Zone` with 25 active N/S generic spaces, a v4 published layout with 25 correctly linked parking elements, and a completed booking plus released assignment. The historical rows were captured as a normalized SHA-256 snapshot before 016–019.

The earlier upgrade probe failed because its element key did not equal the linked spot's `visual_element_key`; migration 013 correctly rejects that invalid fixture. The valid fixture inserts each spot before its element and uses the same key. Migrations 016–019 preserved the v4 layout, all 25 elements, links, generic spots, booking, and assignment byte-for-byte in the normalized snapshot; they then enforced immutability. The post-upgrade importer produced 185 numeric spaces and a 205-element current snapshot, and replay was a no-op.

The only remaining certification gate is one uninterrupted `verify:all` execution in a runner that permits the complete duration. This command sandbox terminates both foreground and detached child processes before the importer suite completes; no repository test hang or leaked backend/container process was found.
