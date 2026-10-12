const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { moduleEnv } = require("../config/env");

const IMAGE_UPLOAD_LIMITS = Object.freeze({
  maxBytes: 6 * 1024 * 1024,
  maxFiles: 10,
  maxWidth: 10000,
  maxHeight: 10000,
  maxPixels: 40_000_000
});

const FORMAT_DETAILS = Object.freeze({
  jpeg: { extension: ".jpg", mimeType: "image/jpeg" },
  png: { extension: ".png", mimeType: "image/png" },
  webp: { extension: ".webp", mimeType: "image/webp" }
});

function defaultVehicleUploadDirectory() {
  return path.resolve(__dirname, "..", "uploads", "vehicles");
}

function vehicleUploadDirectory(env = moduleEnv()) {
  const configured = String(env.VEHICLE_UPLOAD_DIR || "").trim();
  // A relative RENTALS_VEHICLE_UPLOAD_DIR resolves against this module, never the process cwd.
  return configured ? path.resolve(path.join(__dirname, ".."), configured) : defaultVehicleUploadDirectory();
}

function uploadError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

function pngDimensions(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)
    || buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegDimensions(buffer) {
  if (buffer.length < 12 || buffer[0] !== 0xff || buffer[1] !== 0xd8
    || buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) return null;
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 <= buffer.length - 2) {
    if (buffer[offset] !== 0xff) return null;
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return null;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;
    if (startOfFrameMarkers.has(marker)) {
      if (segmentLength < 7) return null;
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += segmentLength;
  }
  return null;
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function webpDimensions(buffer) {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  if (buffer.readUInt32LE(4) + 8 > buffer.length) return null;
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buffer.length >= 30) {
    return { width: readUInt24LE(buffer, 24) + 1, height: readUInt24LE(buffer, 27) + 1 };
  }
  if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 " && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

function inspectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw uploadError("INVALID_IMAGE_CONTENT", "The uploaded image is empty or invalid");
  if (buffer.length > IMAGE_UPLOAD_LIMITS.maxBytes) throw uploadError("IMAGE_TOO_LARGE", "The uploaded image exceeds the byte limit");

  const candidates = [
    ["png", pngDimensions(buffer)],
    ["jpeg", jpegDimensions(buffer)],
    ["webp", webpDimensions(buffer)]
  ];
  const detected = candidates.find(([, dimensions]) => dimensions);
  if (!detected) throw uploadError("INVALID_IMAGE_CONTENT", "The uploaded file is not a supported raster image");
  const [format, dimensions] = detected;
  if (!dimensions.width || !dimensions.height) throw uploadError("INVALID_IMAGE_CONTENT", "The uploaded image has invalid dimensions");
  if (dimensions.width > IMAGE_UPLOAD_LIMITS.maxWidth || dimensions.height > IMAGE_UPLOAD_LIMITS.maxHeight
    || dimensions.width * dimensions.height > IMAGE_UPLOAD_LIMITS.maxPixels) {
    throw uploadError("IMAGE_DIMENSIONS_EXCEEDED", "The uploaded image dimensions exceed the safe limit");
  }
  return { format, ...FORMAT_DETAILS[format], ...dimensions };
}

function validateImageFiles(files = []) {
  return files.map((file) => {
    const inspected = inspectImage(file.buffer);
    if (file.mimetype !== inspected.mimeType) {
      throw uploadError("UNSUPPORTED_IMAGE_TYPE", "The declared image type does not match the uploaded content");
    }
    return { ...file, ...inspected };
  });
}

async function removeStoredImages(files = []) {
  await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => undefined)));
}

function vehiclePhotoPath(storageKey, uploadRoot) {
  const match = /^uploads\/vehicles\/([a-f0-9]{36}\.(?:jpg|png|webp))$/.exec(String(storageKey || ""));
  if (!match) throw uploadError("INVALID_IMAGE_CONTENT", "The stored image filename is invalid");

  const root = path.resolve(uploadRoot);
  const destination = path.resolve(root, match[1]);
  if (path.dirname(destination) !== root) throw uploadError("INVALID_IMAGE_CONTENT", "The stored image filename is invalid");
  return destination;
}

async function storeValidatedImages(files, uploadRoot) {
  const validated = validateImageFiles(files);
  const root = path.resolve(uploadRoot);
  await fs.mkdir(root, { recursive: true });
  const stored = [];
  try {
    for (const file of validated) {
      let written = null;
      for (let attempt = 0; attempt < 4 && !written; attempt += 1) {
        const filename = `${crypto.randomBytes(18).toString("hex")}${file.extension}`;
        const destination = vehiclePhotoPath(vehiclePhotoStorageKey(filename), root);
        try {
          await fs.writeFile(destination, file.buffer, { flag: "wx", mode: 0o640 });
          written = { ...file, filename, path: destination };
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
      if (!written) throw new Error("Unable to allocate a unique image filename");
      stored.push(written);
    }
    return stored;
  } catch (error) {
    await removeStoredImages(stored);
    throw error;
  }
}

function vehiclePhotoStorageKey(filename) {
  if (!/^[a-f0-9]{36}\.(?:jpg|png|webp)$/.test(String(filename || ""))) {
    throw uploadError("INVALID_IMAGE_CONTENT", "The stored image filename is invalid");
  }
  return `uploads/vehicles/${filename}`;
}

module.exports = {
  defaultVehicleUploadDirectory,
  FORMAT_DETAILS,
  IMAGE_UPLOAD_LIMITS,
  inspectImage,
  removeStoredImages,
  storeValidatedImages,
  uploadError,
  validateImageFiles,
  vehiclePhotoPath,
  vehicleUploadDirectory,
  vehiclePhotoStorageKey
};
