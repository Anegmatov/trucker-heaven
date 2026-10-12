(function registerParkingLotGeometry(root, factory) {
  const geometry = factory();
  if (typeof module === 'object' && module.exports) module.exports = geometry;
  if (root) root.ParkingLotGeometry = geometry;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  const spaces = [];
  const addStack = (numbers, { x, y, width, height, gap, step = height + gap }) => {
    numbers.forEach((number, index) => spaces.push(Object.freeze({ number, x, y: y + index * step, width, height, rotation: 0 })));
  };
  const addColumns = (numbers, { x, y, width, height, gap }) => {
    numbers.forEach((number, index) => spaces.push(Object.freeze({ number, x: x + index * (width + gap), y, width, height, rotation: 0 })));
  };
  const ascending = (first, last) => Array.from({ length: last - first + 1 }, (_, index) => first + index);
  const descending = (first, last) => ascending(last, first).reverse();

  // Coordinates are a visual projection of the supplied Trucker Heaven PDF.
  // They never alter persisted layout data until an owner deliberately moves a
  // selected space and saves that draft through the existing API.
  addStack(ascending(165, 196), { x: 1, y: 3, width: 25, height: 1.42, gap: 0.14 });
  // 60–72 are Bobtail spaces. Preserve their authoritative anchors while
  // shortening only their displayed depth in every geometry-driven map view.
  addStack(ascending(60, 72), { x: 1, y: 57, width: 15, height: 0.96, gap: 0.17, step: 1.65 });
  addStack(descending(90, 85), { x: 1, y: 80.5, width: 15, height: 1.76, gap: 0.34 });

  addStack(ascending(37, 59), { x: 42, y: 8, width: 7.2, height: 1.22, gap: 0.2 });
  addStack(descending(36, 14), { x: 51.3, y: 8, width: 7.2, height: 1.22, gap: 0.2 });
  addColumns(ascending(10, 13), { x: 42, y: 40.5, width: 3.9, height: 5.8, gap: 0.45 });

  addColumns(ascending(197, 204), { x: 38.7, y: 48.5, width: 3.55, height: 8.5, gap: 0.38 });
  addColumns(ascending(73, 80), { x: 38.7, y: 57.5, width: 3.55, height: 8.5, gap: 0.38 });
  addColumns(descending(84, 81), { x: 43, y: 79.5, width: 3.7, height: 8.8, gap: 0.55 });

  addStack(descending(164, 143), { x: 83.5, y: 10, width: 15.5, height: 1.32, gap: 0.15 });
  addStack(descending(142, 111), { x: 83.5, y: 48, width: 15.5, height: 1.25, gap: 0.14 });
  addStack(descending(110, 101), { x: 83.5, y: 93.2, width: 15.5, height: 0.58, gap: 0.08 });

  const byNumber = new Map(spaces.map(space => [space.number, space]));
  const spaceNumbers = Object.freeze([...byNumber.keys()].sort((a, b) => a - b));
  const decorations = Object.freeze([
    Object.freeze({ kind: 'property-outline', x: 0.5, y: 0.5, width: 99, height: 99 }),
    Object.freeze({ kind: 'building north-logo', label: 'TRUCKER HEAVEN', x: 70.5, y: 1.8, width: 25.5, height: 6.5 }),
    Object.freeze({ kind: 'label bobtail-upper', label: 'BOBTAIL', x: 40, y: 4.2, width: 19, height: 2.4 }),
    Object.freeze({ kind: 'building main-building', label: 'TRUCKER HEAVEN', x: 25, y: 67.5, width: 51, height: 9.2 }),
    Object.freeze({ kind: 'building west-building', label: 'TH', x: 16, y: 67.5, width: 8, height: 14 }),
    Object.freeze({ kind: 'building lower-service', x: 16, y: 89.3, width: 23, height: 9.2 }),
    Object.freeze({ kind: 'label bobtail-center', label: 'BOBTAIL', x: 43, y: 67.1, width: 18, height: 2 }),
    Object.freeze({ kind: 'island upper-right-island', x: 85.5, y: 43, width: 11, height: 1.8 }),
    Object.freeze({ kind: 'island lower-right-island', x: 88, y: 90.8, width: 10.5, height: 1.6 }),
    Object.freeze({ kind: 'exit south-exit', label: 'South exit', x: 39, y: 97.8, width: 19, height: 1.3 })
  ]);
  function numberFromElement(element) {
    if (!element?.parking_spot_id || String(element.element_type || '').toUpperCase() !== 'PARKING_SPOT') return null;
    const number = Number(String(element.label ?? element.spot_label ?? '').trim());
    return Number.isSafeInteger(number) ? number : null;
  }

  function spaceGeometry(number) {
    const geometry = byNumber.get(Number(number));
    return geometry ? { ...geometry } : null;
  }

  return Object.freeze({ spaceNumbers, decorations, numberFromElement, spaceGeometry });
});
