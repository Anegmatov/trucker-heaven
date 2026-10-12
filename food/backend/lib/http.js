class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function notFound(req, res) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "The requested resource was not found." } });
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const status = error.status || (error.code === "23505" ? 409 : 500);
  const code = error.code && /^[A-Z0-9_]+$/.test(error.code) ? error.code : status === 409 ? "CONFLICT" : "INTERNAL_ERROR";
  if (status >= 500) console.error(`[request:${req.requestId || "unknown"}]`, error.message);
  const body = { error: { code, message: status >= 500 ? "The server could not complete the request." : error.message } };
  if (error.details) body.error.details = error.details;
  res.status(status).json(body);
}

module.exports = { AppError, asyncRoute, notFound, errorHandler };
