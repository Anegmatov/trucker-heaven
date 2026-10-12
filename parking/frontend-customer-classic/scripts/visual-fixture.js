'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '../dist');
const port = Number(process.env.PORT || 5182);
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function readJson(request, callback) {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => callback(JSON.parse(body || '{}')));
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/api/public/parking/v1/canonical-lot') {
    return json(response, 200, { lot: {
      name: 'Trucker Heaven Parking', address: '1000 Trucker Heaven Way, Mt. Juliet, TN', phone: '+16154705075',
      timezone: 'America/Chicago', roadDirectionsUrl: 'https://example.test/directions', bookingPolicy: { minimumWeeklyDays: 7, minimumMonthlyDays: 28 },
      categories: [
        { code: 'BOBTAIL', name: 'Bobtail Parking', startingRateCents: 1900, offeredDurations: [{ code: 'DAILY', unitRateCents: 1900 }, { code: 'WEEKLY', unitRateCents: 10000 }, { code: 'MONTHLY', unitRateCents: 15000 }] },
        { code: 'TRACTOR_TRAILER', name: 'General Truck Parking', startingRateCents: 1900, offeredDurations: [{ code: 'DAILY', unitRateCents: 1900 }, { code: 'WEEKLY', unitRateCents: 10000 }, { code: 'MONTHLY', unitRateCents: 25000 }] }
      ]
    } });
  }
  if (url.pathname === '/api/public/parking/v1/payments/configuration') {
    return json(response, 200, { checkoutConfigured: true, documentStorageConfigured: true });
  }
  if (url.pathname === '/api/public/parking/v1/availability' && request.method === 'POST') {
    readJson(request, trip => json(response, 200, { results: [{
      offerId: `visual-${String(trip.duration || 'daily').toLowerCase()}`, parkingAreaId: 'bobtail-area', parkingAreaName: 'Bobtail Parking Area', categoryCode: 'BOBTAIL',
      assignmentMode: trip.duration === 'MONTHLY' ? 'CUSTOMER_SELECTED_SPOT' : 'ZONE_CAPACITY', available: true, pricingAvailable: true,
      ...(trip.duration === 'MONTHLY' ? { numberedSpacesAvailable: 2 } : { remainingCapacity: 12 }),
      offeredDurations: [{ code: trip.duration, unitRateCents: trip.duration === 'MONTHLY' ? 15000 : trip.duration === 'WEEKLY' ? 10000 : 1900 }]
    }] }));
    return;
  }
  if (url.pathname === '/api/public/parking/v1/monthly-positions' && request.method === 'POST') {
    return json(response, 200, {
      assignmentMode: 'CUSTOMER_SELECTED_SPOT',
      positions: [{ id: 145, label: '145', selectionState: 'AVAILABLE' }, { id: 146, label: '146', selectionState: 'AVAILABLE' }],
      layout: {
        route: { entranceElementKey: 'entrance', arrivalRouteElementKeys: ['lane'], validated: false, points: [] },
        elements: [
          { elementKey: 'boundary', elementType: 'BOUNDARY', x: 3, y: 3, width: 94, height: 94, layerOrder: 1 },
          { elementKey: 'lane', elementType: 'DRIVE_LANE', x: 46, y: 8, width: 12, height: 84, layerOrder: 2 },
          { elementKey: 'entrance', elementType: 'ENTRANCE', x: 44, y: 89, width: 16, height: 4, layerOrder: 3 },
          { elementKey: 'shop', elementType: 'BUILDING', label: 'Trucker Heaven', x: 8, y: 12, width: 30, height: 19, layerOrder: 4 },
          { elementKey: 'space-145', elementType: 'PARKING_SPOT', x: 62, y: 24, width: 28, height: 9, layerOrder: 10, space: { id: 145, number: '145', monthlyEligible: true, selectable: true, selectionState: 'AVAILABLE' } },
          { elementKey: 'space-146', elementType: 'PARKING_SPOT', x: 62, y: 38, width: 28, height: 9, layerOrder: 10, space: { id: 146, number: '146', monthlyEligible: true, selectable: true, selectionState: 'AVAILABLE' } },
          { elementKey: 'space-147', elementType: 'PARKING_SPOT', x: 62, y: 52, width: 28, height: 9, layerOrder: 8, space: { id: 147, number: '147', monthlyEligible: true, selectable: false, selectionState: 'RESERVED' } }
        ]
      }
    });
  }
  if (url.pathname === '/api/public/parking/v1/quotes' && request.method === 'POST') {
    readJson(request, trip => {
      const monthly = trip.duration === 'MONTHLY';
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      json(response, 200, {
        categoryCode: 'BOBTAIL', parkingAreaId: 'bobtail-area', parkingAreaName: 'Bobtail Parking Area', assignmentMode: monthly ? 'CUSTOMER_SELECTED_SPOT' : 'ZONE_CAPACITY',
        arrival: new Date(`${trip.arrivalLocal}:00.000Z`).toISOString(), departure: new Date(`${trip.departureLocal}:00.000Z`).toISOString(), timezone: 'America/Chicago',
        arrivalLocal: trip.arrivalLocal, departureLocal: trip.departureLocal,
        quoteToken: `visual-${String(trip.duration || 'daily').toLowerCase()}-quote-token`, expiresAt,
        ...(monthly ? { selectedMonthlyPosition: { id: Number(trip.selectedSpotId), label: String(trip.selectedSpotId) }, hold: { expiresAt, message: 'This monthly position is temporarily held for checkout.' } } : {}),
        quote: { duration: trip.duration, totalCents: monthly ? 15000 : trip.duration === 'WEEKLY' ? 10000 : 1900,
          baseCents: monthly ? 15000 : trip.duration === 'WEEKLY' ? 10000 : 1900, taxCents: 0, feeCents: 0,
          ...(monthly ? { recurringUnitRateCents: 15000 } : {}) }
      });
    });
    return;
  }
  if (url.pathname === '/api/customer/parking/v1/lookup/summary') {
    return json(response, 200, { summary: { reservations: { current: [], upcoming: [], past: [] }, payments: [] }, csrfToken: '', documentType: null });
  }
  if (url.pathname === '/favicon.ico') { response.writeHead(204, { 'Cache-Control': 'no-store' }); response.end(); return; }
  if (url.pathname.startsWith('/api/')) return json(response, 404, { error: { code: 'NOT_FOUND', message: 'Visual fixture route not found.' } });

  const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  const candidate = path.resolve(root, relative);
  const file = candidate.startsWith(`${root}${path.sep}`) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate : path.join(root, 'index.html');
  response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(response);
});

server.listen(port, '127.0.0.1', () => console.log(`ParkingOps customer visual fixture available at http://127.0.0.1:${port}`));
