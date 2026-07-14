'use strict';

const fs = require('fs');

const ALLOWED_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);

function isAllowedMime(mime) {
  return ALLOWED_MIME_TYPES.has(String(mime || '').toLowerCase());
}

function hasExpectedSignature(filePath, mime) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    const read = fs.readSync(fd, header, 0, header.length, 0);
    const bytes = header.subarray(0, read);
    if (mime === 'application/pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
    if (mime === 'image/jpeg')
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (mime === 'image/png')
      return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function removeUploadedFile(file) {
  if (!file || !file.path) return;
  try {
    fs.unlinkSync(file.path);
  } catch {
    /* file already gone */
  }
}

module.exports = { isAllowedMime, hasExpectedSignature, removeUploadedFile };
