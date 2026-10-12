const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const multer = require("multer");
const { AppError } = require("./http");

const MIME_EXTENSIONS = Object.freeze({
  "image/jpeg": new Set([".jpg", ".jpeg"]),
  "image/png": new Set([".png"]),
  "image/webp": new Set([".webp"])
});

function uploadMiddleware(config) {
  return multer({
    storage: multer.diskStorage({
      destination: config.temporaryUploadDirectory,
      filename: (req, file, callback) => callback(null, `${crypto.randomUUID()}.upload`)
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 30 },
    fileFilter: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      const allowed = MIME_EXTENSIONS[file.mimetype];
      callback(allowed?.has(extension) ? null : new AppError(422, "INVALID_IMAGE", "Upload a JPG, JPEG, PNG, or WEBP image."), Boolean(allowed?.has(extension)));
    }
  }).single("image");
}

function signatureMatches(buffer, mimeType) {
  if (mimeType === "image/jpeg") return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === "image/png") return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/webp") return buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP";
  return false;
}

async function finalizeImage(file, config) {
  if (!file) return null;
  try {
    const bytes = await fs.readFile(file.path);
    if (!signatureMatches(bytes, file.mimetype)) throw new AppError(422, "INVALID_IMAGE", "The image contents do not match its file type.");
    const originalExtension = path.extname(file.originalname).toLowerCase();
    const extension = originalExtension === ".jpeg" ? ".jpg" : originalExtension;
    const filename = `${crypto.randomUUID()}${extension}`;
    const destination = path.join(config.uploadDirectory, filename);
    if (path.dirname(destination) !== path.resolve(config.uploadDirectory)) throw new AppError(422, "INVALID_IMAGE", "The image filename is unsafe.");
    await fs.rename(file.path, destination);
    return `/uploads/menu-items/${filename}`;
  } catch (error) {
    await fs.unlink(file.path).catch(() => {});
    throw error;
  }
}

async function removeUploadedImage(imagePath, config) {
  if (!imagePath?.startsWith("/uploads/menu-items/")) return;
  const filename = path.basename(imagePath);
  const target = path.join(config.uploadDirectory, filename);
  if (path.dirname(target) !== path.resolve(config.uploadDirectory)) return;
  await fs.unlink(target).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

module.exports = { MIME_EXTENSIONS, uploadMiddleware, signatureMatches, finalizeImage, removeUploadedImage };
