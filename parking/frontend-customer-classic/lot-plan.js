/* Trucker Heaven Parking: draws the real lot (traced from the lot diagram) as an SVG string. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LotPlan = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const n = value => Math.round(Number(value) * 10) / 10;

  // Where the lot's single gate sits on the east side, between spaces 143 and 142.
  const ENTRANCE = { x: 1509, y: 1031, label: 'ENTRANCE / EXIT' };
  // Trucker Heaven buildings carry the name, like the painted diagram.
  const BUILDING_NAMES = [
    { x: 436, y: 1645, vertical: true, size: 30 },
    { x: 864, y: 1692, vertical: false, size: 44 },
    { x: 1078, y: 1830, vertical: false, size: 20 }
  ];

  // states: Map(spaceNumber -> 'open' | 'area' | 'taken' | 'off' | 'mine')
  function render(plan, { states = new Map(), selected = null, title = 'Trucker Heaven parking lot', interactive = false } = {}) {
    const [vx, vy, vw, vh] = plan.viewBox;
    const out = [];
    out.push(`<svg class="lot" viewBox="${vx} ${vy} ${vw} ${vh}" role="img" aria-label="${esc(title)}" preserveAspectRatio="xMidYMid meet">`);
    out.push(`<rect class="lot-ground" x="${vx}" y="${vy}" width="${vw}" height="${vh}" rx="18"/>`);
    out.push(`<rect class="lot-pavement" x="173" y="30" width="1382" height="2531"/>`);
    // Painted lines from the diagram.
    out.push('<g class="lot-paint">');
    for (const [c, a, b, axis] of plan.lines) {
      const long = b - a > 900;
      out.push(axis === 'h'
        ? `<line x1="${n(a)}" y1="${c}" x2="${n(b)}" y2="${c}"${long ? ' class="edge"' : ''}/>`
        : `<line x1="${c}" y1="${n(a)}" x2="${c}" y2="${n(b)}"${long ? ' class="edge"' : ''}/>`);
    }
    for (const r of plan.structures) out.push(`<rect class="${r.filled ? 'lot-mark' : ''}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`);
    out.push('</g>');
    for (const r of plan.buildings) out.push(`<rect class="lot-building" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="4"/>`);
    for (const b of BUILDING_NAMES) {
      out.push(`<text class="lot-building-name" x="${b.x}" y="${b.y}" font-size="${b.size}"${b.vertical ? ` transform="rotate(90 ${b.x} ${b.y})"` : ''}>TRUCKER <tspan>HEAVEN</tspan></text>`);
    }
    for (const [x, y, w, h] of plan.pills) out.push(`<rect class="lot-island" x="${x}" y="${y}" width="${w}" height="${h}" rx="${n(h / 2)}"/>`);
    for (const [x, y, w, h] of plan.marks) out.push(`<rect class="lot-mark" x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>`);
    for (const label of plan.labels) {
      out.push(`<text class="lot-zone" x="${label.x}" y="${label.y}"${label.vertical ? ` transform="rotate(90 ${label.x} ${label.y})"` : ''}>${esc(label.text)}</text>`);
    }
    out.push(`<g class="lot-gate"><path d="M ${ENTRANCE.x + 70} ${ENTRANCE.y} h -60 m 18 -14 l -18 14 l 18 14"/><text x="${ENTRANCE.x - 16}" y="${ENTRANCE.y - 26}">${ENTRANCE.label}</text></g>`);
    // Numbered spaces.
    out.push('<g class="lot-spaces">');
    for (const [number, [x, y, w, h]] of Object.entries(plan.spots)) {
      const state = String(number) === String(selected) ? 'mine' : (states.get(String(number)) || 'off');
      const tappable = interactive && (state === 'open' || state === 'mine');
      const size = Math.min(h * 0.58, w * 0.42, 22);
      out.push(`<g class="sp is-${state}" data-space="${esc(number)}"${tappable ? ` role="button" tabindex="-1" aria-label="Space ${esc(number)}"` : ''}>`
        + `<rect x="${n(x + 2)}" y="${n(y + 2)}" width="${n(w - 4)}" height="${n(h - 4)}" rx="3"/>`
        + `<text x="${n(x + w / 2)}" y="${n(y + h / 2)}" font-size="${n(size)}">${esc(number)}</text></g>`);
    }
    out.push('</g></svg>');
    return out.join('');
  }

  // Centre of a space as fractions of the drawing, for scrolling it into view.
  function spaceCenter(plan, number) {
    const box = plan.spots[String(number)];
    if (!box) return null;
    const [vx, vy, vw, vh] = plan.viewBox;
    return { x: (box[0] + box[2] / 2 - vx) / vw, y: (box[1] + box[3] / 2 - vy) / vh };
  }

  return { render, spaceCenter };
});
