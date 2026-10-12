# Navigation and Roles

## Final navigation

| Section | Route/view | STAFF | OWNER | Notes |
|---|---|---:|---:|---|
| Operations | `#dashboard` | Yes | Yes | Former `#overview` aliases here. |
| Operations | `#live-lot` | Yes | Yes | Existing operational Live Lot is preserved. |
| Operations | `#reservations` | Yes | Yes | Existing reservation workspace is preserved. |
| Operations | `#customers` | Yes | Yes | Phase 1 shell/empty state only. |
| Operations | `#history` | Yes | Yes | Phase 1 shell/compatibility guidance only. |
| Operations | `#activity` | Yes | Yes | Phase 1 shell/empty state only. |
| Operations | `#reports` | Yes | Yes | Phase 1 shell/empty state only. |
| Configuration | `#settings` | No | Yes | General configuration. |
| Configuration | `#lot-setup` | No | Yes | Settings → Lot Diagram; legacy advanced setup is retained. |
| Configuration | `#pricing` | No | Yes | Settings → Rates & Rules. |
| Configuration | `#staff-accounts` | No | Yes | Settings → Users. |

## Compatibility

`#overview` redirects to Dashboard. Existing `#arrivals` remains directly accessible as the arrivals/departures compatibility view. `#layout` continues to target `#lot-setup`; `#configuration`, `#locations`, `#zones`, `#categories`, `#inventory`, and `#closures` continue through Settings; `#rates` targets Rates & Rules.

The owner menu does not provide raw database names. Technical configuration remains in the retained advanced configuration screen to preserve existing capabilities. UI hiding is not authorization: existing backend OWNER/STAFF route enforcement remains unchanged.

## Advanced settings placement

Lot Diagram opens the current Lot Setup workflow. Parking Types opens Settings with category configuration, Rates & Rules opens pricing, Users opens staff-account management, and General Settings opens the location/general tab. Existing area/category/inventory mechanics are retained behind this advanced surface while normal navigation uses parking terminology.
