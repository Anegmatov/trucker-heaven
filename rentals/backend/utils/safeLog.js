function safeErrorCode(error) {
  if (error?.code && /^[A-Z0-9_]+$/i.test(String(error.code))) return String(error.code);
  if (Number.isInteger(error?.statusCode)) return `HTTP_${error.statusCode}`;
  return "UNKNOWN";
}

function logFailure(scope, error) {
  console.error(`[${scope}] failed code=${safeErrorCode(error)}`);
}

module.exports = { logFailure, safeErrorCode };
