'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const dist = path.resolve(__dirname, '../dist');
const port = Number(process.env.PORT || 5181);
const apiTarget = new URL(process.env.PARKING_API_PROXY || 'http://127.0.0.1:3001');
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8'
};

if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('Build the customer application first: npm run build');

http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    const headers = { ...request.headers, host: apiTarget.host };
    delete headers.origin;
    const proxy = http.request({ hostname: apiTarget.hostname, port: apiTarget.port, method: request.method,
      path: request.url, headers }, upstream => {
      response.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(response);
    });
    proxy.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { code: 'LOCAL_API_UNAVAILABLE', message: 'The local ParkingOps API is unavailable.' } }));
    });
    request.pipe(proxy);
    return;
  }
  const candidate = path.resolve(dist, `.${pathname}`);
  const file = candidate.startsWith(`${dist}${path.sep}`) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate : path.join(dist, 'index.html');
  response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store, max-age=0, must-revalidate' });
  fs.createReadStream(file).pipe(response);
}).listen(port, '127.0.0.1', () => {
  console.log(`ParkingOps customer build available at http://127.0.0.1:${port}`);
});
