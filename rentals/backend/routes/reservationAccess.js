const express = require("express");
const multer = require("multer");
const defaultDatabase = require("../db/connection");
const { requireAdminSession, requireCsrf, requireRole } = require("../middleware/requireAdmin");
const { writeAudit } = require("../services/adminAuthService");
const {
  customerDocumentStatuses,
  downloadAdminDocument,
  downloadCurrentCustomerDocument,
  listReservationDocuments,
  maximumDocumentBytes,
  normalizeDocumentType,
  reservationIdForAccessToken,
  reviewDocument,
  uploadDocument
} = require("../services/rentalDocumentService");
const {
  cancelCustomerReservation,
  customerReservation,
  findCustomerReservations,
  replaceAccessToken,
  revokeAccessToken
} = require("../services/reservationAccessService");
const { logFailure } = require("../utils/safeLog");
const { moduleEnv } = require("../config/env");

const ACCESS_TOKEN_HEADER = "X-Reservation-Access-Token";

function publicDocumentUpload(env = moduleEnv()) {
  const parser = multer({
    storage: multer.memoryStorage(),
    preservePath: true,
    // Busboy counts the accepted file before enforcing the next-part boundary.
    // Keep a strict single-file/no-field surface while allowing that one file.
    limits: { fileSize: maximumDocumentBytes(env), files: 1, fields: 0, parts: 2 }
  }).single("file");
  return (req, res, next) => parser(req, res, (error) => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "Rental document is too large", code: "DOCUMENT_TOO_LARGE" });
    }
    return res.status(400).json({ error: "Malformed rental document upload", code: "INVALID_MULTIPART_UPLOAD" });
  });
}

function errorResponse(res, error, fallback, operation) {
  if ([400, 401, 403, 404, 409, 413].includes(error.statusCode)) {
    return res.status(error.statusCode).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  logFailure(operation, error);
  return res.status(500).json({ error: fallback });
}

function contentDisposition(filename) {
  const safe = String(filename || "document").replace(/["\\\r\n]/g, "_");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function sendPrivateDocument(res, document) {
  res.set({
    "Content-Type": document.mimeType,
    "Content-Length": String(document.buffer.length),
    "Content-Disposition": contentDisposition(document.displayFilename),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0"
  });
  return res.status(200).send(document.buffer);
}

function requireReservationAccess(database) {
  return async (req, res, next) => {
    try {
      req.customerReservationId = await reservationIdForAccessToken(database, req.get(ACCESS_TOKEN_HEADER));
      return next();
    } catch (error) {
      return errorResponse(res, error, "Reservation access is unavailable", "reservation.access.customer.authorization");
    }
  };
}

function rejectCustomerOwnershipParameters(req, res, next) {
  if (req.query?.reservationId !== undefined || req.query?.documentId !== undefined) {
    return res.status(400).json({ error: "Reservation ownership is established by the access token", code: "CUSTOMER_OWNERSHIP_OVERRIDE" });
  }
  return next();
}

function createReservationAccessRouter({
  database = defaultDatabase,
  includePublic = true,
  includeAdmin = true,
  publicMutationMiddleware = (_req, _res, next) => next(),
  lookupMiddleware = publicMutationMiddleware,
  env = moduleEnv()
} = {}) {
  const router = express.Router();

  if (includePublic) {
    router.get("/reservation-access", async (req, res) => {
      try {
        return res.json({ reservation: await customerReservation(database, req.get(ACCESS_TOKEN_HEADER)) });
      } catch (error) {
        return errorResponse(res, error, "Reservation access is unavailable", "reservation.access.customer");
      }
    });

    router.post("/reservation-access/find", lookupMiddleware, async (req, res) => {
      try {
        return res.json({ reservations: await findCustomerReservations(database, { email: req.body?.email, phone: req.body?.phone }) });
      } catch (error) {
        return errorResponse(res, error, "Reservation lookup is unavailable", "reservation.access.customer.find");
      }
    });

    router.post(
      "/reservation-access/cancel",
      publicMutationMiddleware,
      rejectCustomerOwnershipParameters,
      async (req, res) => {
        try {
          return res.json({
            message: "Your reservation request has been cancelled. No payment has been collected online.",
            reservation: await cancelCustomerReservation({
              database,
              token: req.get(ACCESS_TOKEN_HEADER),
              expectedStatusVersion: req.body?.expectedStatusVersion
            })
          });
        } catch (error) {
          return errorResponse(res, error, "Reservation cancellation is unavailable", "reservation.access.customer.cancel");
        }
      }
    );

    router.get("/reservation-access/documents", requireReservationAccess(database), async (req, res) => {
      try {
        return res.json({ documents: await customerDocumentStatuses(database, req.customerReservationId) });
      } catch (error) {
        return errorResponse(res, error, "Document status is unavailable", "reservation.documents.customer.status");
      }
    });

    router.post(
      "/reservation-access/documents/:documentType",
      publicMutationMiddleware,
      requireReservationAccess(database),
      rejectCustomerOwnershipParameters,
      publicDocumentUpload(env),
      async (req, res) => {
        try {
          const documentType = normalizeDocumentType(req.params.documentType);
          await uploadDocument(database, req.customerReservationId, documentType, req.file, env);
          const documents = await customerDocumentStatuses(database, req.customerReservationId);
          return res.status(201).json({ documentType, status: "PENDING_REVIEW", documents });
        } catch (error) {
          return errorResponse(res, error, "Rental document upload failed", "reservation.documents.customer.upload");
        }
      }
    );

    router.get("/reservation-access/documents/:documentType/download", requireReservationAccess(database), async (req, res) => {
      try {
        const documentType = normalizeDocumentType(req.params.documentType);
        const document = await downloadCurrentCustomerDocument(database, req.customerReservationId, documentType, env);
        return sendPrivateDocument(res, document);
      } catch (error) {
        return errorResponse(res, error, "Rental document download failed", "reservation.documents.customer.download");
      }
    });
  }

  if (includeAdmin) {
    router.post(
      "/admin/reservations/:id/access/:action",
      requireAdminSession,
      requireRole("OWNER", "STAFF"),
      requireCsrf,
      async (req, res) => {
        const action = String(req.params.action).toLowerCase();
        try {
          if (action === "revoke") {
            await revokeAccessToken(database, req.params.id);
            await writeAudit(database, req.admin.id, "RESERVATION_ACCESS_REVOKE", "RESERVATION", req.params.id);
            return res.status(204).end();
          }
          if (!["issue", "rotate"].includes(action)) return res.status(404).json({ error: "Access operation was not found" });
          const token = await replaceAccessToken(database, req.params.id);
          await writeAudit(database, req.admin.id, action === "issue" ? "RESERVATION_ACCESS_ISSUE" : "RESERVATION_ACCESS_ROTATE", "RESERVATION", req.params.id);
          return res.json({ accessToken: token });
        } catch (error) {
          return errorResponse(res, error, "Reservation access operation failed", "reservation.access.admin");
        }
      }
    );

    router.get(
      "/admin/reservations/:id/documents",
      requireAdminSession,
      requireRole("OWNER", "STAFF"),
      async (req, res) => {
        try {
          return res.json({ documents: await listReservationDocuments(database, req.params.id) });
        } catch (error) {
          return errorResponse(res, error, "Rental documents could not be loaded", "reservation.documents.admin.list");
        }
      }
    );

    router.get(
      "/admin/reservations/:id/documents/:documentId/download",
      requireAdminSession,
      requireRole("OWNER", "STAFF"),
      async (req, res) => {
        try {
          const document = await downloadAdminDocument(database, req.params.id, req.params.documentId, env);
          return sendPrivateDocument(res, document);
        } catch (error) {
          return errorResponse(res, error, "Rental document download failed", "reservation.documents.admin.download");
        }
      }
    );

    for (const action of ["approve", "reject"]) {
      router.post(
        `/admin/reservations/:id/documents/:documentId/${action}`,
        requireAdminSession,
        requireRole("OWNER", "STAFF"),
        requireCsrf,
        async (req, res) => {
          try {
            const document = await reviewDocument(database, {
              reservationId: req.params.id,
              documentId: req.params.documentId,
              decision: action === "approve" ? "APPROVED" : "REJECTED",
              internalNote: req.body?.internalNote,
              customerInstruction: req.body?.customerInstruction,
              actor: req.admin
            });
            return res.json({ document });
          } catch (error) {
            return errorResponse(res, error, "Rental document review failed", `reservation.documents.admin.${action}`);
          }
        }
      );
    }
  }

  return router;
}

module.exports = {
  ACCESS_TOKEN_HEADER,
  contentDisposition,
  createReservationAccessRouter,
  publicDocumentUpload,
  requireReservationAccess,
  rejectCustomerOwnershipParameters,
  sendPrivateDocument
};
