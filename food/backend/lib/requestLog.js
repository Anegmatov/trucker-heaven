const crypto = require("node:crypto");

function requestLog(req, res, next) {
  req.requestId = req.headers["x-request-id"]?.slice(0, 80) || crypto.randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  const started = Date.now();
  res.on("finish", () => {
    const line = {
      at: new Date().toISOString(),
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl.split("?")[0],
      status: res.statusCode,
      durationMs: Date.now() - started
    };
    console.log(JSON.stringify(line));
  });
  next();
}

module.exports = { requestLog };
