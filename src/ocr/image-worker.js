const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');
const { imageType } = require('./image-process');
const limits = require('../limits');

sharp.cache(false);
sharp.concurrency(1);

const models = path.resolve(__dirname, '../../node_modules/.cache/razberi-ocr');

process.once('message', async (buffer) => {
  let worker;
  let result;
  try {
    const expected = imageType(buffer);
    const image = sharp(buffer, { limitInputPixels: 12000000, failOn: 'warning', animated: false });
    const metadata = await image.metadata();
    if (!expected || metadata.format !== expected || (metadata.pages || 1) !== 1) {
      throw new Error('INVALID_IMAGE');
    }
    if (metadata.width < 32 || metadata.height < 32) {
      throw new Error('INVALID_IMAGE');
    }
    const pixels = await image.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).grayscale().normalize().png().toBuffer();
    for (const language of ['bul', 'eng']) {
      if (!fs.existsSync(path.join(models, `${language}.traineddata`))) {
        throw new Error('OCR_UNAVAILABLE');
      }
    }
    worker = await createWorker('bul+eng', 1, {
      cachePath: models, langPath: models, gzip: false,
      cacheMethod: 'readOnly', logger: () => {}, errorHandler: () => {},
    });
    const { data } = await worker.recognize(pixels);
    const text = data.text.trim();
    if (!text) {
      throw new Error('NO_OCR_TEXT');
    }
    if (text.length > limits.maxPageCharacters) {
      throw new Error('PROCESSING_LIMIT');
    }
    result = {
      pageCount: 1, sourceType: 'photo',
      pages: [{ pageNumber: 1, text, extractionMethod: 'ocr', ocrConfidence: Math.round(data.confidence) }],
      warnings: ['Текстът е разпознат от снимка чрез OCR. Провери имената, числата и сроковете спрямо снимката.'],
    };
  } catch (error) {
    const code = ['NO_OCR_TEXT', 'PROCESSING_LIMIT', 'OCR_UNAVAILABLE'].includes(error.message) ? error.message : 'INVALID_IMAGE';
    result = { error: code };
  } finally {
    await worker?.terminate().catch(() => {});
  }
  if (process.connected) process.send(result, () => process.disconnect());
});
