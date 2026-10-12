# Immutable layout publication

Layouts use a `DRAFT → PUBLISHED → SUPERSEDED` lifecycle. A draft remains editable. Publishing creates a distinct immutable snapshot, atomically supersedes the previous current snapshot, and leaves historical elements untouched. There is exactly one `PUBLISHED` layout per location; public, availability, and Live Lot readers select only that status.

The shared publisher runs under one transaction and locks the location publication state. Before commit readers see the old published snapshot; after commit they see the new snapshot. An error rolls back the complete transition. Its optional `onStep` callback is test-only: it is an in-process argument with no HTTP, CLI, or environment-variable path.

Migration 016 introduced the lifecycle and triggers. Forward-only migrations 017–019 correct PostgreSQL trigger return semantics, remove the legacy two-state lifecycle check, and treat an unset publication GUC as untrusted. Apply all four migrations together; do not edit historical snapshots manually.

The guarded real-lot importer calls the same publisher inside its single transaction. Its PostgreSQL 18 fixture verifies that a v4 generic layout becomes one newer immutable published snapshot, while the old snapshot and its elements remain historical records.

The 015-to-019 PostgreSQL 18 verifier additionally proves that a pre-existing v4 published layout with 25 valid element-to-spot links is unchanged by the migration itself before the importer supersedes it.

The real-lot importer rejects apply-only mode. Its combined `--apply --publish` path builds the candidate draft, creates a new published snapshot, supersedes the prior snapshot, and changes inventory visibility in the same transaction. Rollback uses the validated pre-change PostgreSQL archive during an approved maintenance window; no historical layout is manually rewritten.
