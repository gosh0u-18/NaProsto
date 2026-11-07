const fs = require('node:fs/promises');
const path = require('node:path');

async function makePhoto() {
  // Fixed synthetic fixture: OCR tests do not depend on installed system fonts.
  return fs.readFile(path.join(__dirname, '../fixtures/bulgarian-photo.png'));
}

module.exports = { makePhoto };
