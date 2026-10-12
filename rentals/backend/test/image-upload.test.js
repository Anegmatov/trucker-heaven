const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  IMAGE_UPLOAD_LIMITS,
  inspectImage,
  storeValidatedImages,
  validateImageFiles,
  vehiclePhotoPath,
  vehicleUploadDirectory,
  vehiclePhotoStorageKey
} = require("../utils/imageUpload");

function png(width = 2, height = 3) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function jpeg(width = 2, height = 3) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
}

function webp(width = 2, height = 3) {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(22, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

function file(buffer, mimetype, originalname = "photo.jpg") {
  return { buffer, mimetype, originalname };
}

test("image inspection accepts only structurally valid JPEG, PNG, and WebP", () => {
  assert.deepEqual(inspectImage(jpeg()), { format: "jpeg", extension: ".jpg", mimeType: "image/jpeg", width: 2, height: 3 });
  assert.deepEqual(inspectImage(png()), { format: "png", extension: ".png", mimeType: "image/png", width: 2, height: 3 });
  assert.deepEqual(inspectImage(webp()), { format: "webp", extension: ".webp", mimeType: "image/webp", width: 2, height: 3 });
});

test("active content, empty, oversized, mismatched, and unsafe-dimension uploads are rejected", () => {
  const html = Buffer.from("<!doctype html><script>alert(1)</script>");
  const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>");
  const cases = [
    [() => validateImageFiles([file(html, "image/jpeg")]), "INVALID_IMAGE_CONTENT"],
    [() => validateImageFiles([file(svg, "image/svg+xml", "image.svg")]), "INVALID_IMAGE_CONTENT"],
    [() => validateImageFiles([file(html, "image/jpeg", "image.jpg")]), "INVALID_IMAGE_CONTENT"],
    [() => validateImageFiles([file(Buffer.alloc(0), "image/jpeg")]), "INVALID_IMAGE_CONTENT"],
    [() => validateImageFiles([file(Buffer.alloc(IMAGE_UPLOAD_LIMITS.maxBytes + 1), "image/jpeg")]), "IMAGE_TOO_LARGE"],
    [() => validateImageFiles([file(png(0, 3), "image/png")]), "INVALID_IMAGE_CONTENT"],
    [() => validateImageFiles([file(png(10001, 2), "image/png")]), "IMAGE_DIMENSIONS_EXCEEDED"],
    [() => validateImageFiles([file(png(), "image/jpeg")]), "UNSUPPORTED_IMAGE_TYPE"]
  ];
  for (const [operation, code] of cases) assert.throws(operation, (error) => error.code === code);
});

test("stored names are random, collision-safe, content-derived, and path confined", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driveops-images-"));
  try {
    const stored = await storeValidatedImages([
      file(jpeg(), "image/jpeg", "../../escape.html"),
      file(jpeg(), "image/jpeg", "../../escape.html"),
      file(png(), "image/png", "photo.jpg"),
      file(webp(), "image/webp", "photo.js")
    ], root);
    assert.equal(new Set(stored.map((entry) => entry.filename)).size, 4);
    assert.match(stored[0].filename, /^[a-f0-9]{36}\.jpg$/);
    assert.match(stored[2].filename, /^[a-f0-9]{36}\.png$/);
    assert.match(stored[3].filename, /^[a-f0-9]{36}\.webp$/);
    for (const entry of stored) assert.equal(path.dirname(entry.path), root);

    assert.match(vehiclePhotoStorageKey(stored[0].filename), /^uploads\/vehicles\/[a-f0-9]{36}\.jpg$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("vehicle storage preserves the local default, honors a custom directory, and rejects unsafe storage keys", () => {
  const defaultRoot = path.resolve(__dirname, "..", "uploads", "vehicles");
  const customRoot = path.resolve(os.tmpdir(), "driveops-custom-vehicle-storage");
  assert.equal(vehicleUploadDirectory({}), defaultRoot);
  assert.equal(vehicleUploadDirectory({ VEHICLE_UPLOAD_DIR: customRoot }), customRoot);
  assert.equal(
    vehiclePhotoPath("uploads/vehicles/0123456789abcdef0123456789abcdef0123.jpg", customRoot),
    path.join(customRoot, "0123456789abcdef0123456789abcdef0123.jpg")
  );
  for (const key of ["uploads/vehicles/../../private.txt", "uploads/vehicles/not-a-photo.jpg", "/etc/passwd"]) {
    assert.throws(() => vehiclePhotoPath(key, customRoot), (error) => error.code === "INVALID_IMAGE_CONTENT");
  }
});

test("a rejected batch leaves no public artifact", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "driveops-images-reject-"));
  try {
    await assert.rejects(
      storeValidatedImages([file(jpeg(), "image/jpeg"), file(Buffer.from("<html>"), "image/jpeg")], root),
      (error) => error.code === "INVALID_IMAGE_CONTENT"
    );
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
