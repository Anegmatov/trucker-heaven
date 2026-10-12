# Responsive and Accessibility Baseline

## Responsive behavior

- Desktop: persistent 244px sidebar, compact header search/user controls, full workspace width, and side-panel-ready Live Lot/layout structure.
- Up to 980px: sidebar becomes a controlled slide-out menu; workspace uses full width; header search contracts.
- Up to 680px: header preserves menu/sign-out actions, workspace/panels stack, wide tables use a contained scroll wrapper, and controls become full-width. The map is not forced into a desktop-width canvas.

The existing Live Lot and Lot Diagram responsive constraints are retained. Phase 1 does not implement the future mobile map behavior; it ensures ordinary navigation, forms, lists, messages, and page shells do not overflow.

## Accessibility baseline

- Semantic `nav`, buttons, labelled fields, table headers, and live-message regions remain in place.
- Current navigation receives `.is-current`; mobile navigation uses `aria-expanded` and a named control.
- Global search and icon-like navigation control have accessible labels.
- Keyboard focus is visible on buttons, links, inputs, selects, textareas, navigation, and map elements.
- Status labels provide text in addition to color; layout/live-lot items include accessible labels.
- Existing side/detail controls remain keyboard-operable; the shell keeps native dialog/confirmation behavior unchanged.
- Motion is minimized for users who request reduced motion.

Future custom modal work must add explicit focus trapping and restoration. Phase 1 does not introduce a new custom dialog.
