# Import tool

The provisioner defaults to a dry-run. It supports only the approved local development database and an explicitly guarded production target; it never accepts an unknown, test, IFTA, or legacy parking database. A real-lot `--apply` without `--publish` is rejected because it would activate inventory that has no current published geometry.

For local development, the established explicit URL command remains supported:

`DATABASE_URL=postgres://postgres@127.0.0.1:5432/parkingops_dev_20260723_014831 node backend/scripts/importTruckerHeavenRealLot.js --dry-run`

For production, never pass a URL on the command line or rely on inherited `DATABASE_URL` with the legacy importer. A read-only production dry-run requires all of the following:

```bash
node backend/scripts/importTruckerHeavenRealLot.js \
  --database-url-file /secure/path/parkingops-production-url \
  --expected-database parkingops_prod \
  --production \
  --dry-run
```

The script requires certificate-validated TLS for production, verifies the URL host is remote, the URL and connected database both equal `parkingops_prod`, and requires a complete recognizable legacy baseline before it builds a plan. That baseline is not a loose name match: one location must normalize exactly to `South Zone`, its related zones must normalize exactly to `North Zone` and `South Zone`, its generic inventory must be N-01–N-15 and S-01–S-10 with no numeric conflict, and its published `North Zone layout` v4 must reference those generic spaces. Whitespace is normalized only for human-readable names; all target selection is then by stable IDs and same-location relationships. Dry-run performs no writes.

Production writes are deliberately harder to invoke. They require the production dry-run protections plus `--apply`, `--publish`, and the exact confirmation value in one combined transaction:

```bash
node backend/scripts/importTruckerHeavenRealLot.js \
  --database-url-file /secure/path/parkingops-production-url \
  --expected-database parkingops_prod \
  --production \
  --apply \
  --confirm-production REAL_LOT_IMPORT_APPROVED \
  --publish
```

Do not use the write command until the owner has approved the dry-run. `--publish` without `--apply` is rejected. A prior Trucker Heaven physical-lot draft is recognized as an update target so calibrated geometry can be reprovisioned without replacing historical spot records.

## Render Shell production runner

The canonical production path is the single-command runner. Open the ParkingOps backend service's Render Shell, where Render has already injected the service's `DATABASE_URL`, then run these commands from the backend package directory:

```bash
npm run production:audit-real-lot
npm run production:import-real-lot
```

The runner accepts no database URL argument and never writes one to disk. It rejects local, IFTA, and test targets; verifies the connected database name, schema, OWNER, exact audited 25-space legacy baseline, and maintenance guard; obtains an advisory lock; writes a committed database-contained recovery snapshot; and only then performs the import. If the canonical published physical lot is already active, the import is a verified no-op. Its JSON result contains only the database/host identity and operational counts—never a URL, user, password, token, or credential hash.

### Render private-database TLS policy

The API and runner use the same PostgreSQL connection factory. It strips pg SSL query parameters from the connection string before giving it to node-postgres, then supplies the selected `ssl` setting explicitly; this prevents a URL `sslmode` from silently replacing the policy. A bare private Render `dpg-*` endpoint retains the API's established plain private-network behavior unless TLS is explicitly requested. When TLS is requested for that positively classified private endpoint and no configured CA is available, only that endpoint may use `rejectUnauthorized:false` for Render's private self-signed certificate. Render public, pooler-public, and unknown remote hosts always require certificate verification. Global TLS verification is never disabled.

The recovery snapshot is retained in `parkingops_real_lot_recovery`. It includes the pre-change location, zones, inventory, layouts, elements, spaces, directions, and the non-secret booking, assignment, block, and price-reference rows needed to prove that historical reservations were not changed. Metadata records the source commit, canonical-layout checksum, exact snapshot table names, pre/post checksums, prior layout, timestamps, report, and status.

Rollback is exceptional: use it only before later operational work has been recorded. It is a single guarded transaction and refuses a different database, an incomplete migration, maintenance mode, another active runner, or any post-import state conflict. Use the migration ID printed by the successful import:

```bash
npm run production:rollback-real-lot -- --migration-id rli_YYYYMMDDHHMMSS_abcdefghij
```

Do not use the legacy importer write command from Render Shell. The runner is the only supported deployment-time entry point.

## Transaction and certification

The combined write path uses one PostgreSQL client and one transaction for zone/inventory changes, physical spaces and classifications, generic-space deactivation, draft elements, immutable publication, and commit. The importer locks the target location before changing it and rejects a transformed or changed legacy baseline, so a concurrent second import rolls back cleanly instead of producing a second real-lot publication.

`applyRealLotTransaction` has a direct-callback test hook only. It is not reachable from the CLI, HTTP, or environment. PostgreSQL 18.4 acceptance covers each importer boundary: physical spaces, classifications, legacy-zone visibility, layout elements, generic deactivation, snapshot creation, supersession, publication, and pre-commit. Each injected failure rolls back the complete fixture.

The upgrade verifier confirms that a valid legacy v4 map must link each parking element using the spot's exact visual key; 016–019 preserve those historical rows before the importer performs its atomic supersession.
