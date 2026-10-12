// Private document storage on the server's own disk, for running without S3 (on a laptop,
// or a single server with a persistent disk). Works like S3 presigned URLs: the browser
// PUTs the file to a short-lived signed URL served by this API (routes/privateDocuments.js).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('../config');
const { apiError } = require('../utils');

// Signs upload links. Falls back to a per-process secret, so links simply expire on restart.
const secret = config.documents.localSecret || config.cookie.tokenPepper || crypto.randomBytes(32).toString('hex');

const directory = () => path.resolve(config.documents.localDirectory);
// Storage keys are hashed into file names, so a key can never point outside the directory.
const fileFor = key => path.join(directory(), crypto.createHash('sha256').update(String(key)).digest('hex'));

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verify(signedToken) {
  const [body, signature] = String(signedToken || '').split('.');
  const expected = crypto.createHmac('sha256', secret).update(String(body)).digest('base64url');
  if (!body || !signature || signature.length !== expected.length
      || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw apiError('DOCUMENT_UPLOAD_LINK_INVALID', 'This upload link is not valid.', 403);
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (Date.now() > Number(payload.expiresAt)) throw apiError('DOCUMENT_UPLOAD_LINK_EXPIRED', 'This upload link expired. Start the upload again.', 403);
  return payload;
}

// Receives one upload from a signed link: exact declared type and size, written atomically.
async function receive(signedToken, contentType, stream) {
  const { key, mimeType, sizeBytes } = verify(signedToken);
  if (String(contentType || '').split(';')[0].trim().toLowerCase() !== mimeType) {
    throw apiError('DOCUMENT_TYPE_NOT_ALLOWED', 'The file type does not match the upload.', 415);
  }
  fs.mkdirSync(directory(), { recursive: true });
  const target = fileFor(key);
  const partial = `${target}.${crypto.randomBytes(6).toString('hex')}.part`;
  let received = 0;
  const limit = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      done(received > sizeBytes ? apiError('DOCUMENT_SIZE_INVALID', 'The file is larger than declared.', 413) : null, chunk);
    }
  });
  try {
    await pipeline(stream, limit, fs.createWriteStream(partial, { mode: 0o600 }));
    if (received !== sizeBytes) throw apiError('DOCUMENT_SIZE_INVALID', 'The upload was incomplete. Please try again.', 400);
    fs.writeFileSync(`${target}.json`, JSON.stringify({ mimeType, sizeBytes }), { mode: 0o600 });
    fs.renameSync(partial, target);
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

function metadata(key) {
  return JSON.parse(fs.readFileSync(`${fileFor(key)}.json`, 'utf8'));
}

const adapter = {
  async signedUpload({ key, mimeType, sizeBytes }) {
    const expiresAt = Date.now() + config.documents.uploadTtlSeconds * 1000;
    const url = `${config.documents.localPublicUrl}/api/private-documents/${sign({ key, mimeType, sizeBytes, expiresAt })}`;
    return { url, method: 'PUT', headers: { 'Content-Type': mimeType }, expiresInSeconds: config.documents.uploadTtlSeconds };
  },
  async inspect({ key }) {
    const bytes = fs.readFileSync(fileFor(key));
    return { sizeBytes: bytes.length, mimeType: metadata(key).mimeType, bytes };
  },
  async signedRead() {
    throw apiError('DOCUMENT_STORAGE_READ_UNAVAILABLE', 'Open documents from the staff site.', 503);
  },
  async readObject({ key }) {
    const { mimeType, sizeBytes } = metadata(key);
    return { body: fs.createReadStream(fileFor(key)), sizeBytes, mimeType };
  }
};

module.exports = { adapter, receive };
