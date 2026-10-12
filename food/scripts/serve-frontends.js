const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };

function serve(directory, port) {
  const base = path.join(root, directory);
  const server = http.createServer((req, res) => {
    const requested = decodeURIComponent(req.url.split("?")[0]);
    const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
    const target = path.resolve(base, relative);
    if (!target.startsWith(`${path.resolve(base)}${path.sep}`)) { res.writeHead(403).end("Forbidden"); return; }
    fs.readFile(target, (error, data) => {
      if (error) { res.writeHead(error.code === "ENOENT" ? 404 : 500).end("Not found"); return; }
      res.writeHead(200, { "Content-Type": types[path.extname(target)] || "application/octet-stream", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" });
      res.end(data);
    });
  });
  server.listen(port, () => console.log(`[static] ${directory} http://localhost:${port}`));
  return server;
}

const servers = [serve("frontend-admin", 5191)];
const stop = () => servers.forEach((server) => server.close());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
