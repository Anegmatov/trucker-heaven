# Handoff

1. Back up and verify the target database identity.
2. Apply migrations 015 through 019 with the explicit ParkingOps URL.
3. Run the importer as dry-run and review its generic-space report.
4. Run only the guarded combined `--apply --publish` workflow after the required importer atomicity acceptance is complete; resolve classifications before enabling exact-space mode.
5. Confirm that public layout, exact-space availability, and historical snapshots match the post-commit checks.

The PostgreSQL 18 upgrade fixture is certified locally. Before production, run one uninterrupted `PARKING_VERIFY_PARENT_SITE=false npm run verify:all` in a runner without the current command-sandbox lifetime limit, then obtain explicit production approval for the guarded combined command. Do not use an apply-only invocation.

No deployment or database provisioning is performed by this change.
# Layout publication handoff

Published layouts are immutable snapshots. Owner publication and the real-lot importer use the shared atomic publisher; prior public geometry becomes `SUPERSEDED` and remains read-only/queryable.
