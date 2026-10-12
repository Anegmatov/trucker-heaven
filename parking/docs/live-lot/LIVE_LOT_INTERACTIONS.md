# Live Lot interactions

## Time and filters

The default view is now. A manager can choose a local date/time in the selected lot's IANA timezone; the frontend converts it to an offset-bearing ISO instant before calling the API. The page prominently announces a future view and provides **Return to now**. Invalid values are not requested.

Filter state is retained across refreshes. Server-supported filters refetch the snapshot. "Needs attention" and "Future booking" are safe local filters because each snapshot includes all warnings and next-reservation data for its server-filtered spaces. Reset clears the filters, future-view instant, and search.

## Search and navigation

Search starts at two characters, waits 250 ms, scopes to the selected location, and ignores stale responses. Results are capped at eight visible results in each API group: Spaces, Reservations, Customers, and Vehicles. Arrow keys, Home, and End move among result buttons.

A space result selects its map/list space. A reservation or vehicle selects its associated visible space when the API supplies a matching number; otherwise it opens the existing reservation workflow. Customer results open the existing filtered reservation list because Phase 2B deliberately does not create a customer-profile route.

## Selected spaces

Selection keeps the snapshot visible, opens the panel, and lazily requests operational detail followed by a 30-day timeline. The panel displays only fields supplied by the detail contract, including authorized current customer and vehicle data. It routes to the existing reservation or move workflow only when the API's advisory flags make that route relevant. Closing restores focus to the selected map/list button.

Timeline intervals are rendered in API order with their `[start,end)` convention and server warnings. Timeline and detail failures provide retry controls without discarding the map.
