# Live Lot accessibility

Linked map spaces are native buttons with the number, operational status, and future-reservation context in their accessible name. Selected state is exposed with `aria-selected`, and focus styling is distinct from status color. Noninteractive map furniture is hidden from assistive technology.

Every filter has a visible label. The future-state and filter-count notices use polite live regions. Search results use grouped native buttons in a listbox region and support arrow-key, Home, and End movement in addition to normal Tab/Enter behavior.

The fallback list is keyboard accessible and uses the same selection state as the map. Opening a space moves focus to the panel close control; closing returns focus to that space. Status labels, legend text, warning markers, patterns for blocked spaces, and selected outlines prevent color-only meaning. The global reduced-motion rule also applies to the Live Lot.
