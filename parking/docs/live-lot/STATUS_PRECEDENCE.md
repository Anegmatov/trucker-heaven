# Status Precedence

`operationalStatus` is derived at `evaluatedAt`; it is never stored or selected by color.

1. `INACTIVE` — `parking_spots.active=false`.
2. `BLOCKED` — an unreleased `parking_spot_blocks` interval contains the instant.
3. `OCCUPIED` — an unreleased exact assignment belongs to a `CHECKED_IN` reservation.
4. `RESERVED` — an unreleased assignment belongs to a `PENDING` or `CONFIRMED` reservation and covers the instant.
5. `AVAILABLE` — none of the above.

Booking visibility (`PUBLIC`/`INTERNAL_ONLY`), vehicle eligibility, and parking use are separate fields. A monthly stay can be `OCCUPIED`; an internal-only space can be `AVAILABLE`. Configuration issues are warnings, not a competing status, so bad data remains visible.

Checked-in assignments past expected departure remain `OCCUPIED` with `ASSIGNMENT_PAST_EXPECTED_DEPARTURE`. A block plus future reservation remains `BLOCKED` now with `BLOCKED_FUTURE_RESERVATION`.
