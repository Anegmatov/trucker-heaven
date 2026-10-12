const crypto = require("crypto");
const fs = require("fs/promises");
const { constants: fsConstants } = require("fs");
const path = require("path");
const { writeAudit } = require("./adminAuthService");
const { enqueueDocumentReviewNotification } = require("./notificationOutboxService");
const { inspectImage } = require("../utils/imageUpload");
const { moduleEnv } = require("../config/env");

const DOCUMENT_TYPES = Object.freeze(["DRIVER_LICENSE", "INSURANCE"]);
const TYPES = new Set(DOCUMENT_TYPES);
const REVIEW_STATUSES = Object.freeze(["NOT_SUBMITTED", "PENDING_REVIEW", "APPROVED", "REJECTED"]);
const FORMAT_BY_MIME = Object.freeze({
  "image/jpeg": { extension: "jpg", sourceExtensions: new Set(["jpg", "jpeg"]) },
  "image/png": { extension: "png", sourceExtensions: new Set(["png"]) },
  "image/webp": { extension: "webp", sourceExtensions: new Set(["webp"]) },
  "application/pdf": { extension: "pdf", sourceExtensions: new Set(["pdf"]) }
});
const STORAGE_NAME_PATTERN = /^[a-f0-9]{48}\.(?:jpg|png|webp|pdf)$/;

function fail(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function uploadRoot(env = moduleEnv()) {
  // A relative RENTALS_RENTAL_UPLOAD_DIR resolves against this module, never the process cwd.
  return env.RENTAL_UPLOAD_DIR ? path.resolve(path.join(__dirname, ".."), env.RENTAL_UPLOAD_DIR) : path.join(__dirname, "..", "uploads", "rentals-private");
}

function maximumDocumentBytes(env = moduleEnv()) {
  const value = Number(env.RENTAL_DOCUMENT_MAX_BYTES || 6 * 1024 * 1024);
  if (!Number.isInteger(value) || value <= 0) throw new Error("RENTAL_DOCUMENT_MAX_BYTES must be a positive integer");
  return value;
}

function normalizeDocumentType(value) {
  const type = String(value || "").trim().toUpperCase();
  if (!TYPES.has(type)) throw fail(404, "Document type was not found", "DOCUMENT_TYPE_NOT_FOUND");
  return type;
}

function positiveId(value, label = "document") {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw fail(400, `Invalid ${label}`, "INVALID_IDENTIFIER");
  return id;
}

function cleanReviewText(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw fail(400, `${label} is invalid`, "INVALID_REVIEW_TEXT");
  const cleaned = value.trim();
  if (!cleaned) return null;
  if (cleaned.length > 1000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(cleaned)) {
    throw fail(400, `${label} is invalid`, "INVALID_REVIEW_TEXT");
  }
  return cleaned;
}

function displayFilename(originalName, extension) {
  const base = path.basename(String(originalName || ""))
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = `document.${extension}`;
  return (base || fallback).slice(0, 255);
}

function pdfSignatureIsValid(buffer) {
  if (buffer.length < 8 || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") return false;
  const tail = buffer.subarray(Math.max(0, buffer.length - 2048)).toString("latin1");
  return tail.includes("%%EOF");
}

function detectedMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  if (pdfSignatureIsValid(buffer)) return "application/pdf";
  try {
    return inspectImage(buffer).mimeType;
  } catch (_error) {
    return null;
  }
}

function validateUpload(file, env = moduleEnv()) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw fail(400, "A non-empty rental document file is required", "INVALID_DOCUMENT_CONTENT");
  }
  const byteSize = Number(file.size ?? file.buffer.length);
  if (!Number.isInteger(byteSize) || byteSize !== file.buffer.length) {
    throw fail(400, "Rental document size is invalid", "INVALID_DOCUMENT_CONTENT");
  }
  if (byteSize > maximumDocumentBytes(env)) {
    throw fail(413, "Rental document is too large", "DOCUMENT_TOO_LARGE");
  }
  const providedFilename = String(file.originalname || "");
  if (!providedFilename || /[\\/]/.test(providedFilename) || [".", ".."].includes(providedFilename)) {
    throw fail(400, "Rental document filename is invalid", "INVALID_DOCUMENT_FILENAME");
  }
  const format = FORMAT_BY_MIME[file.mimetype];
  const actualMimeType = detectedMimeType(file.buffer);
  if (!format || actualMimeType !== file.mimetype) {
    throw fail(400, "Rental document type does not match its content", "INVALID_DOCUMENT_CONTENT");
  }
  const originalExtension = path.extname(providedFilename).slice(1).toLowerCase();
  if (!originalExtension || !format.sourceExtensions.has(originalExtension)) {
    throw fail(400, "Rental document filename does not match its content", "DOCUMENT_EXTENSION_MISMATCH");
  }
  return {
    buffer: file.buffer,
    byteSize,
    mimeType: actualMimeType,
    extension: format.extension,
    originalFilename: displayFilename(file.originalname, format.extension)
  };
}

function storageName(extension) {
  return `${crypto.randomBytes(24).toString("hex")}.${extension}`;
}

function pathInsideRoot(rootDirectory, name) {
  if (!STORAGE_NAME_PATTERN.test(String(name || ""))) throw fail(404, "Document file was not found", "DOCUMENT_FILE_NOT_FOUND");
  const destination = path.resolve(rootDirectory, name);
  if (destination === rootDirectory || !destination.startsWith(`${rootDirectory}${path.sep}`)) {
    throw fail(404, "Document file was not found", "DOCUMENT_FILE_NOT_FOUND");
  }
  return destination;
}

async function storeUpload(validated, env = moduleEnv()) {
  const configuredRoot = uploadRoot(env);
  await fs.mkdir(configuredRoot, { recursive: true, mode: 0o750 });
  const rootDirectory = await fs.realpath(configuredRoot);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const name = storageName(validated.extension);
    const destination = pathInsideRoot(rootDirectory, name);
    try {
      await fs.writeFile(destination, validated.buffer, { flag: "wx", mode: 0o640 });
      return { name, destination };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Unable to allocate private rental document storage");
}

function customerDocument(row) {
  return {
    status: row?.review_status || "NOT_SUBMITTED",
    instruction: row?.customer_instruction || "",
    submittedAt: row?.uploaded_at || null,
    downloadAvailable: Boolean(row)
  };
}

function adminDocument(row) {
  return {
    id: Number(row.id),
    type: row.document_type,
    revision: Number(row.revision),
    current: row.superseded_at === null,
    status: row.review_status,
    displayFilename: row.original_filename || `document.${FORMAT_BY_MIME[row.mime_type]?.extension || "bin"}`,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    uploadedAt: row.uploaded_at,
    supersededAt: row.superseded_at,
    reviewedAt: row.reviewed_at,
    reviewedByAdminUserId: row.reviewed_by_admin_user_id === null ? null : Number(row.reviewed_by_admin_user_id),
    internalNote: row.review_note || "",
    customerInstruction: row.customer_instruction || ""
  };
}

async function reservationIdForAccessToken(database, token, client = database) {
  const { isGrant, verifyGrant } = require("../utils/accessGrant");
  if (isGrant(token)) {
    const grantId = verifyGrant(token);
    if (!grantId) throw fail(401, "Reservation access is invalid", "INVALID_RESERVATION_ACCESS");
    const found = await client.query("SELECT reservationid FROM reservationsmvp WHERE reservationid = $1", [grantId]);
    if (!found.rowCount) throw fail(401, "Reservation access is invalid", "INVALID_RESERVATION_ACCESS");
    return grantId;
  }
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw fail(401, "Reservation access is invalid", "INVALID_RESERVATION_ACCESS");
  }
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const result = await client.query("SELECT reservationid FROM reservationsmvp WHERE customer_access_token_hash = $1", [tokenHash]);
  if (!result.rowCount) throw fail(401, "Reservation access is invalid", "INVALID_RESERVATION_ACCESS");
  return Number(result.rows[0].reservationid);
}

async function uploadDocument(database, reservationId, requestedType, file, env = moduleEnv()) {
  const id = positiveId(reservationId, "reservation");
  const documentType = normalizeDocumentType(requestedType);
  const validated = validateUpload(file, env);
  const stored = await storeUpload(validated, env);
  let client;
  let transactionStarted = false;
  try {
    client = await database.connect();
    await client.query("BEGIN");
    transactionStarted = true;
    const reservation = await client.query("SELECT reservationid FROM reservationsmvp WHERE reservationid = $1 FOR UPDATE", [id]);
    if (!reservation.rowCount) throw fail(404, "Reservation not found", "RESERVATION_NOT_FOUND");
    const current = await client.query(
      "SELECT id FROM rental_documents WHERE reservation_id = $1 AND document_type = $2 AND superseded_at IS NULL FOR UPDATE",
      [id, documentType]
    );
    const revisionResult = await client.query(
      "SELECT COUNT(*)::integer + 1 AS revision FROM rental_documents WHERE reservation_id = $1 AND document_type = $2",
      [id, documentType]
    );
    if (current.rowCount) {
      await client.query("UPDATE rental_documents SET superseded_at = CURRENT_TIMESTAMP WHERE id = $1 AND superseded_at IS NULL", [current.rows[0].id]);
    }
    const inserted = await client.query(
      `INSERT INTO rental_documents
        (reservation_id, document_type, storage_name, mime_type, byte_size, review_status, original_filename)
       VALUES ($1, $2, $3, $4, $5, 'PENDING_REVIEW', $6)
       RETURNING id, document_type, review_status, original_filename, mime_type, byte_size, uploaded_at,
         superseded_at, reviewed_at, reviewed_by_admin_user_id, review_note, customer_instruction`,
      [id, documentType, stored.name, validated.mimeType, validated.byteSize, validated.originalFilename]
    );
    await client.query(
      "INSERT INTO rental_document_review_history (document_id, review_status) VALUES ($1, 'PENDING_REVIEW')",
      [inserted.rows[0].id]
    );
    await client.query("COMMIT");
    transactionStarted = false;
    return adminDocument({ ...inserted.rows[0], revision: revisionResult.rows[0].revision });
  } catch (error) {
    if (transactionStarted && client) await client.query("ROLLBACK").catch(() => undefined);
    await fs.unlink(stored.destination).catch(() => undefined);
    throw error;
  } finally {
    if (client) client.release();
  }
}

async function customerDocumentStatuses(database, reservationId) {
  const id = positiveId(reservationId, "reservation");
  const result = await database.query(
    `SELECT document_type, review_status, customer_instruction, uploaded_at
       FROM rental_documents
      WHERE reservation_id = $1 AND superseded_at IS NULL`,
    [id]
  );
  const documents = Object.fromEntries(result.rows.map((row) => [row.document_type, customerDocument(row)]));
  return {
    driverLicense: documents.DRIVER_LICENSE || customerDocument(null),
    insurance: documents.INSURANCE || customerDocument(null)
  };
}

async function listReservationDocuments(database, reservationId) {
  const id = positiveId(reservationId, "reservation");
  const reservation = await database.query("SELECT reservationid FROM reservationsmvp WHERE reservationid = $1", [id]);
  if (!reservation.rowCount) throw fail(404, "Reservation not found", "RESERVATION_NOT_FOUND");
  const result = await database.query(
    `WITH revisions AS (
       SELECT d.*,
         ROW_NUMBER() OVER (PARTITION BY document_type ORDER BY uploaded_at ASC, id ASC)::integer AS revision
         FROM rental_documents d WHERE reservation_id = $1
     )
     SELECT id, document_type, revision, original_filename, mime_type, byte_size, review_status,
       review_note, customer_instruction, reviewed_by_admin_user_id, reviewed_at, uploaded_at, superseded_at
       FROM revisions ORDER BY document_type ASC, revision DESC`,
    [id]
  );
  const revisions = result.rows.map(adminDocument);
  const current = Object.fromEntries(DOCUMENT_TYPES.map((type) => {
    const row = revisions.find((document) => document.type === type && document.current);
    return [type === "DRIVER_LICENSE" ? "driverLicense" : "insurance", row || { type, status: "NOT_SUBMITTED", current: true }];
  }));
  return { current, revisions };
}

async function selectDocument(database, { documentId, reservationId, documentType, currentOnly = false }) {
  const values = [];
  const predicates = [];
  if (documentId !== undefined) { values.push(positiveId(documentId)); predicates.push(`id = $${values.length}`); }
  if (reservationId !== undefined) { values.push(positiveId(reservationId, "reservation")); predicates.push(`reservation_id = $${values.length}`); }
  if (documentType !== undefined) { values.push(normalizeDocumentType(documentType)); predicates.push(`document_type = $${values.length}`); }
  if (currentOnly) predicates.push("superseded_at IS NULL");
  const result = await database.query(
    `SELECT id, reservation_id, document_type, storage_name, mime_type, byte_size, original_filename,
       review_status, review_note, customer_instruction, reviewed_by_admin_user_id, reviewed_at, uploaded_at, superseded_at
       FROM rental_documents WHERE ${predicates.join(" AND ")} LIMIT 1`,
    values
  );
  if (!result.rowCount) throw fail(404, "Document not found", "DOCUMENT_NOT_FOUND");
  return result.rows[0];
}

async function readStoredDocument(row, env = moduleEnv()) {
  const format = FORMAT_BY_MIME[row.mime_type];
  if (!format || !String(row.storage_name || "").endsWith(`.${format.extension}`)) {
    throw fail(404, "Document file was not found", "DOCUMENT_FILE_NOT_FOUND");
  }
  const configuredRoot = uploadRoot(env);
  let rootDirectory;
  try { rootDirectory = await fs.realpath(configuredRoot); } catch (_error) { throw fail(404, "Document file was not found", "DOCUMENT_FILE_NOT_FOUND"); }
  const filePath = pathInsideRoot(rootDirectory, row.storage_name);
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== Number(row.byte_size) || stat.size <= 0 || stat.size > maximumDocumentBytes(env)) {
      throw fail(404, "Document file was not found", "DOCUMENT_FILE_NOT_FOUND");
    }
    const buffer = await handle.readFile();
    if (detectedMimeType(buffer) !== row.mime_type) throw fail(404, "Document file was not found", "DOCUMENT_FILE_NOT_FOUND");
    return {
      buffer,
      mimeType: row.mime_type,
      displayFilename: displayFilename(row.original_filename, format.extension)
    };
  } catch (error) {
    if (error.statusCode) throw error;
    throw fail(404, "Document file was not found", "DOCUMENT_FILE_NOT_FOUND");
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function downloadCurrentCustomerDocument(database, reservationId, documentType, env = moduleEnv()) {
  const row = await selectDocument(database, { reservationId, documentType, currentOnly: true });
  return readStoredDocument(row, env);
}

async function downloadAdminDocument(database, reservationId, documentId, env = moduleEnv()) {
  const row = await selectDocument(database, { reservationId, documentId });
  return readStoredDocument(row, env);
}

async function currentDocument(database, reservationId, documentType) {
  return selectDocument(database, { reservationId, documentType, currentOnly: true });
}

async function document(database, documentId, env = moduleEnv()) {
  const row = await selectDocument(database, { documentId });
  return { row, ...(await readStoredDocument(row, env)) };
}

async function reviewDocument(database, { reservationId, documentId, decision, internalNote, customerInstruction, actor }) {
  const id = positiveId(reservationId, "reservation");
  const selectedDocumentId = positiveId(documentId);
  const status = String(decision || "").trim().toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(status)) throw fail(400, "Review decision is invalid", "INVALID_REVIEW_DECISION");
  if (!actor || !["OWNER", "STAFF"].includes(actor.role) || !Number.isInteger(Number(actor.id))) {
    throw fail(403, "You are not authorized to review documents", "DOCUMENT_REVIEW_FORBIDDEN");
  }
  const safeInternalNote = cleanReviewText(internalNote, "Internal note");
  const safeCustomerInstruction = cleanReviewText(customerInstruction, "Customer instruction");
  const client = await database.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const result = await client.query(
      `SELECT d.* FROM rental_documents d
        JOIN reservationsmvp r ON r.reservationid = d.reservation_id
       WHERE d.id = $1 AND d.reservation_id = $2 FOR UPDATE OF r, d`,
      [selectedDocumentId, id]
    );
    if (!result.rowCount) throw fail(404, "Document not found", "DOCUMENT_NOT_FOUND");
    const document = result.rows[0];
    if (document.superseded_at !== null) throw fail(409, "Only the current document revision can be reviewed", "DOCUMENT_REVISION_SUPERSEDED");
    if (document.review_status !== "PENDING_REVIEW") throw fail(409, "Document review is already finalized", "DOCUMENT_REVIEW_FINALIZED");
    const updated = await client.query(
      `UPDATE rental_documents SET review_status = $1, review_note = $2, customer_instruction = $3,
         reviewed_by_admin_user_id = $4, reviewed_at = CURRENT_TIMESTAMP
       WHERE id = $5 AND superseded_at IS NULL AND review_status = 'PENDING_REVIEW'
       RETURNING *`,
      [status, safeInternalNote, safeCustomerInstruction, Number(actor.id), selectedDocumentId]
    );
    if (updated.rowCount !== 1) throw fail(409, "Document review state changed", "DOCUMENT_REVIEW_CONFLICT");
    await client.query(
      `INSERT INTO rental_document_review_history
        (document_id, review_status, internal_note, customer_instruction, reviewed_by_admin_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [selectedDocumentId, status, safeInternalNote, safeCustomerInstruction, Number(actor.id)]
    );
    const approved = await client.query(
      `SELECT COUNT(DISTINCT document_type)::integer AS count
         FROM rental_documents
        WHERE reservation_id = $1 AND superseded_at IS NULL AND review_status = 'APPROVED'
          AND document_type IN ('DRIVER_LICENSE', 'INSURANCE')`,
      [id]
    );
    const bothApproved = Number(approved.rows[0].count) === DOCUMENT_TYPES.length;
    await writeAudit(client, Number(actor.id), `RENTAL_DOCUMENT_${status}`, "RENTAL_DOCUMENT", selectedDocumentId, {
      reservationId: id,
      documentType: document.document_type
    });
    await enqueueDocumentReviewNotification(client, {
      reservationId: id,
      documentId: selectedDocumentId,
      documentType: document.document_type,
      status,
      customerInstruction: safeCustomerInstruction,
      bothApproved
    });
    const revision = await client.query(
      `SELECT COUNT(*)::integer AS revision FROM rental_documents
        WHERE reservation_id = $1 AND document_type = $2
          AND (uploaded_at < $3 OR (uploaded_at = $3 AND id <= $4))`,
      [id, document.document_type, updated.rows[0].uploaded_at, selectedDocumentId]
    );
    await client.query("COMMIT");
    transactionStarted = false;
    return adminDocument({ ...updated.rows[0], revision: revision.rows[0].revision });
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  DOCUMENT_TYPES,
  REVIEW_STATUSES,
  TYPES,
  adminDocument,
  customerDocument,
  customerDocumentStatuses,
  currentDocument,
  detectedMimeType,
  displayFilename,
  document,
  downloadAdminDocument,
  downloadCurrentCustomerDocument,
  fail,
  listReservationDocuments,
  maximumDocumentBytes,
  normalizeDocumentType,
  pathInsideRoot,
  readStoredDocument,
  reservationIdForAccessToken,
  reviewDocument,
  root: uploadRoot,
  upload: uploadDocument,
  uploadDocument,
  uploadRoot,
  validateUpload
};
