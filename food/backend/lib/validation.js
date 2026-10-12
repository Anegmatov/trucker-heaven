const { AppError } = require("./http");

function text(value, name, { required = true, max = 5000 } = {}) {
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw new AppError(422, "VALIDATION_ERROR", `${name} is required.`, { field: name });
  if (result.length > max) throw new AppError(422, "VALIDATION_ERROR", `${name} must be ${max} characters or fewer.`, { field: name });
  return result;
}

function integer(value, name, { minimum = 0, maximum = 2147483647 } = {}) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AppError(422, "VALIDATION_ERROR", `${name} must be an integer from ${minimum} to ${maximum}.`, { field: name });
  }
  return parsed;
}

function boolean(value, name) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new AppError(422, "VALIDATION_ERROR", `${name} must be true or false.`, { field: name });
}

function optionalEmail(value) {
  const result = text(value, "email", { required: false, max: 254 });
  if (result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new AppError(422, "VALIDATION_ERROR", "Enter a valid email address.", { field: "email" });
  return result || null;
}

function slug(value) {
  const result = text(value, "slug", { max: 80 }).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result)) throw new AppError(422, "VALIDATION_ERROR", "Slug may contain lowercase letters, numbers, and single hyphens.", { field: "slug" });
  return result;
}

module.exports = { text, integer, boolean, optionalEmail, slug };
