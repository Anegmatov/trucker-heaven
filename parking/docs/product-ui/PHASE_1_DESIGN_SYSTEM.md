# Phase 1 Design System

## Principles

ParkingOps uses a calm, high-density operational interface: a charcoal navigation rail, warm off-white workspace, restrained white surfaces, muted olive action color, and brass accent. It avoids decorative gradients, oversized dashboard metrics, and bright-blue SaaS styling. The system is implemented as CSS custom properties in `frontend-admin/styles.css` and maps legacy selectors to the same tokens.

## Tokens

| Purpose | Token | Value |
|---|---|---|
| Sidebar | `--color-sidebar` | `#20272E` |
| Page / surface | `--color-page-background`, `--color-surface` | `#F5F4F0`, `#FFFFFF` |
| Secondary surface / border | `--color-surface-secondary`, `--color-border` | `#EFEEE9`, `#DDDCD7` |
| Text | `--color-text-primary`, `--color-text-secondary` | `#1E252B`, `#68717A` |
| Primary action | `--color-primary`, `--color-primary-hover`, `--color-primary-soft` | `#546B52`, `#465B45`, `#E7EDE5` |
| Accent | `--color-accent`, `--color-accent-hover`, `--color-accent-soft` | `#A48352`, `#8E7045`, `#F2EBDD` |
| Problem / warning / information | `--color-danger`, `--color-warning`, `--color-info` | `#B8564F`, `#C28A3A`, `#65798A` |

Status color never stands alone. Every space/status also carries a text label, and interactive items have a visible selection/focus treatment. Available is olive, reserved brass, occupied slate, monthly muted purple, company bronze, blocked gray, and problem muted red.

## Typography and spacing

The system uses the existing safe system stack: `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`. Page titles are compact and high-contrast; section titles and labels establish hierarchy without giant type. The spacing scale is 4, 8, 12, 16, 20, 24, 32, 40, and 48px. Tables use 13px row padding and uppercase, low-emphasis headers for readable operational density.

## Components

- Buttons: olive primary; white secondary with olive hover; muted-red destructive action; icon buttons have accessible names.
- Forms: 4px radius, strong neutral border, visible focus ring, explicit labels, and inline message styling.
- Cards / panels: white surface, subtle 1px border, 6px radius, minimal/no shadow.
- Tables: one entity per row, aligned headers, consistent row height, hover/focus affordance, scroll wrapper at narrow widths.
- Status badges: compact rectangular label with semantic background and text.
- Side panels: surface with a primary-color top edge; reserved for map/reservation details.
- Loading, error, empty, and success states: shared neutral, info, red, and olive treatment.

## Accessibility and motion

Keyboard focus uses a 3px olive-outline treatment. The visual system honours `prefers-reduced-motion`; status colors are supplementary to text; and no hidden color-only interaction is used.
