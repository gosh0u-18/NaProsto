const path = require('node:path');
const { runIsolated } = require('../isolated-process');

function imageType(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return null;
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'png';
  }
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) {
    return 'jpeg';
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return null;
}

function extractImage(buffer, options = {}) {
  if (!imageType(buffer)) {
    return Promise.reject(Object.assign(new Error('INVALID_IMAGE'), { code: 'INVALID_IMAGE' }));
  }
  return runIsolated(path.join(__dirname, 'image-worker.js'), buffer, options);
}

module.exports = { extractImage, imageType };
