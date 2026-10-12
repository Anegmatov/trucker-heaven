# Component Inventory

The admin frontend is vanilla JavaScript, so Phase 1 standardizes render helpers, semantic templates, and CSS component classes instead of adding a UI framework.

| Pattern | Implementation | Current consumers | Intended later consumers |
|---|---|---|---|
| App shell / Sidebar / Header / Page header | `frontend-admin/index.html`, `styles.css`, `setView` / `renderPageMeta` in `app.js` | All admin views | All future workspaces |
| Status badge | `statusBadge()` and `.badge` | Reservations, activity, live lot | Customer/history/report lists |
| Buttons / icon buttons | shared `button`, `.secondary`, `.danger-button`, `.icon-button` CSS | Forms, actions, navigation | Dialogs and bulk tools |
| Form/select/textarea field | semantic labels and global field CSS | Login, filters, setup, advanced settings | Customer and rate workflows |
| Table / toolbar | `.table-wrap`, table CSS, reservation search form | Reservations, configuration lists | Customers, history, reports |
| Empty / loading / error / success | `.empty`, `.empty-state`, `.status-message`, `setMessage()` | Setup, layouts, configuration, Phase 1 placeholder views | Every async workspace |
| Detail panel | `.space-panel`, reservation detail, layout properties | Live Lot, reservation detail, lot diagram | Customer and activity detail panels |
| Map legend/status | layout and live-lot render helpers plus status CSS | Existing layout/live lot | Phase 2 map foundation |
| Activity/timeline pattern | existing recent-activity render and panel surface | Dashboard | Dedicated Activity/History views |
| Search input | `#globalSearch` and existing reservation search | Header → Reservations | Customer/space global search |

The Phase 1 placeholder pages intentionally use no fabricated data. They establish page headers, empty states, responsive layout, and navigation without claiming Phase 2 functionality exists.
