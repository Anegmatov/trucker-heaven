// Receives customer document uploads when files are stored on this server's disk
// (DOCUMENT_STORAGE_PROVIDER=LOCAL). The signed link itself authorizes the upload.
const express = require('express');
const { receive } = require('../services/localDocumentStorage');

const router = express.Router();

router.put('/:signedToken', async (req, res, next) => {
  try {
    await receive(req.params.signedToken, req.get('content-type'), req);
    res.status(204).end();
  } catch (error) { next(error); }
});

module.exports = router;
