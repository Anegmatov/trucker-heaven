# Phase 1 Visual Acceptance

## Checklist

- [x] Dashboard has persistent desktop shell, clear page title, warm-neutral workspace, primary status cards, and non-fabricated operational data.
- [x] Live Lot retains its existing map/list/detail workspace inside the new shell; Phase 2 map behavior is not implemented.
- [x] Reservations retain search, status badges, table/detail behavior, and a full-width operational workspace.
- [x] Customers, History, Activity, and Reports have explicit, non-fabricated shell/empty states.
- [x] Settings exposes Lot Diagram, Parking Types, Rates & Rules, Users, and General Settings for owners.
- [x] Tables use consistent headers, padding, borders, hover state, and a narrow-screen wrapper.
- [x] Tablet navigation is collapsible; desktop keeps the persistent sidebar.
- [x] Mobile stacks workspace content and protects ordinary controls from horizontal overflow.
- [x] Keyboard focus, current-page indication, field labels, semantic status text, and reduced motion are present.
- [x] Loading, error, empty, and success visual treatments share the design tokens.

## Manual screenshot review

Use an authenticated Owner session to review Dashboard, Live Lot, Reservations, Customers, and Settings at desktop width; use the responsive browser controls at tablet and phone widths. Confirm no clipped sidebar, duplicate heading, bright-blue visual dominance, cramped rows, unreadable status, or broken form control. Screenshot capture requires a browser runtime with a configured test account; this repository currently provides static/server verification but no committed browser automation runner.
