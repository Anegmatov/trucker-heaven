# Phase 2B Frontend Contract

1. Load `GET /locations/:id/live-lot/snapshot` for the selected lot/time/filter state. Render `layout.elements` as the immutable published map and overlay `spaces` by `layout.spaceId` / `space.layout`.
2. Show summary counts and every `space.warnings`; render spaces without geometry in an explicit unplaced list rather than hiding them.
3. On selection, call `GET /spaces/:id/operational-detail`; display customer/vehicle information only in this authorized detail panel.
4. Load `GET /spaces/:id/timeline` lazily for the selected detail panel. Treat intervals as `[start,end)` and display its warnings.
5. Header search calls `GET /operational-search` with a mandatory selected location. Group results by spaces, reservations, customers, and vehicles.
6. Use `operationalStatus` for state treatment, `parkingUse` as a separate label, and `bookingVisibility`/eligibility as independent indicators. Do not infer status from color or write status back.
7. Do not expose draft layouts or use the Phase 2A APIs for mutation. Existing block/reassign/check-in/out endpoints remain the action backend until later phases add explicitly designed workflows.

Map digitization remains blocked on the inaccessible reference image and the owner-confirmation questions in `docs/lot-setup-audit/OWNER_CONFIRMATION_QUESTIONS.md`. Do not hardcode space ranges, classifications, or geometry.
