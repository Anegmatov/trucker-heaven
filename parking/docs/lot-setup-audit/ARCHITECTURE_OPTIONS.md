# Architecture Options

## Comparison

| Dimension | A. Wording only | B. Map-first UI, existing backend | C. New spaces-plus-tags backend |
|---|---|---|---|
| Description | Rename labels and reorder the wizard slightly | Replace owner flow with map-first provisioning that creates current internal records | Replace area/inventory-centric model with spaces and tag/attribute model |
| Advantages | Lowest initial effort; low schema risk | Preserves tested safety/data while solving the primary usability issue; incremental rollout | Conceptual alignment with physical map; can reduce joins for new development |
| Disadvantages | Still forces area/category/inventory thinking and duplicate entry | Requires a carefully designed provisioning/mapping layer and editor work | Requires broad migration, historical adapters and reimplementation of safety/scoping semantics |
| Existing data | No migration | Preserved in place; legacy records rendered through terminology adapter | Highest risk: all historical relationships must be represented or retained indefinitely |
| Reservation logic | Unchanged | Unchanged; internal inputs remain location/inventory/category and exact-space assignment | Must rewrite availability, pricing, closures, public selection, assignment compatibility and likely APIs |
| Tests | Mostly copy/UI changes | Add map/provisioning tests; retain current integration suite as regression contract | Rewrite/dual-run most integration tests and migration tests |
| Migration risk | Low | Low-to-medium, because new objects must not mutate historical records | High; dual writes/backfills and compatibility layer required |
| Implementation cost | Low | Medium | High |
| Owner usability | Slightly better | High | Potentially high after a long risky program |
| Long-term maintainability | Keeps confusing conceptual seams | Good: explicit owner vocabulary adapter around proven operational core | Uncertain: simpler apparent model may recreate hidden joins as tags become scoped rules |

## Recommendation: Option B

Adopt **Option B**. Repository evidence supports it: the current model already has transactional bulk creation of a spot plus linked layout element, an area-save endpoint that provisions inventory from selected categories, and strict exact-space/publication controls. The missing piece is not a new data model; it is a task-oriented orchestration API and map-first editor.

Option B should deliberately retain the old advanced flow while the new one proves itself, and it should generate new replacement records rather than changing any historically referenced relationships. Consider Option C only after evidence shows the retained model cannot represent a confirmed operational requirement without unsafe or consistently unmaintainable translation rules.
