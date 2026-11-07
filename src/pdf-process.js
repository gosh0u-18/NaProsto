const path = require('node:path');
const { runIsolated } = require('./isolated-process');

function extractPdf(buffer, options = {}) {
  return runIsolated(path.join(__dirname, 'pdf-worker.mjs'), buffer, options);
}

module.exports = { extractPdf };
