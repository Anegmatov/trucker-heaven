# ParkingOps Approved Exact Design Pack

This pack is the implementation source of truth for the ParkingOps admin redesign.

## Reference priority

1. `02-live-lot-interactive-approved.png` is the approved Live Lot visual and interaction reference.
2. `08-authoritative-lot-diagram.pdf` is the immutable source of truth for physical lot geometry, numbering, orientation, buildings, and blank space.
3. The remaining PNG files define the approved visual system for each admin page.

## Non-negotiable map behavior

The Live Lot must not be a flat picture. The lot must be implemented as an interactive vector map using the existing canonical layout data. Each numbered space must be its own selectable element. Clicking or keyboard-selecting a space must open real API-backed details and history. The PDF may be used as a calibration/reference layer, but not as the only interactive surface.

The exact physical ranges are 10–90, 101–196, and 197–204. Spaces 91–100 do not exist. Do not move, add, remove, renumber, rotate, or reinterpret physical elements compared with the authoritative PDF.

## Files

- `01-dashboard.png`
- `02-live-lot-interactive-approved.png`
- `03-reservations.png`
- `04-customers.png`
- `05-physical-map.png`
- `06-rates-rules.png`
- `07-users.png`
- `08-authoritative-lot-diagram.pdf`
- `CODEX_IMPLEMENTATION_PROMPT.txt`
