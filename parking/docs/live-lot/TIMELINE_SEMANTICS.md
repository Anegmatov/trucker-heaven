# Timeline Semantics

Intervals are half-open: `[start, end)`. A departure at exactly 12:00 does not conflict with a reservation starting at exactly 12:00.

The endpoint clips assignments and blocks to the requested finite range; open-ended blocks end at the request boundary and carry `openEnded: true`, never an infinite JSON timestamp. It creates explicit `AVAILABLE` gaps. If legacy data overlaps, it emits `TIMELINE_OVERLAP` and resolves display precedence as Blocked, Occupied, Reserved, Available. Adjacent intervals merge only when type and source identity match.

Input instants must include an offset, avoiding ambiguous local daylight-saving times. The location IANA timezone is returned for display; all response interval timestamps are UTC ISO instants.
