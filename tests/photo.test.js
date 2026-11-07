const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const sharp = require('sharp');
const { extractImage, imageType } = require('../src/ocr/image-process');
const { createApp } = require('../src/app');
const { createMockAIClient } = require('../src/analysis/ai-client');
const { makePhoto } = require('./helpers/photo');

test('photo OCR: real Bulgarian recognition uses local models and preserves source information', async () => {
  const result = await extractImage(await makePhoto());
  assert.equal(result.pageCount, 1);
  assert.equal(result.sourceType, 'photo');
  assert.equal(result.pages[0].pageNumber, 1);
  assert.equal(result.pages[0].extractionMethod, 'ocr');
  assert.match(result.pages[0].text, /ДЕКЛАРАЦИЯ/iu);
  assert.match(result.pages[0].text, /заявление/iu);
  assert.match(result.pages[0].text, /2027/);
  assert.ok(result.warnings.length > 0);
});

test('photo OCR: empty image has a helpful failure instead of false text', async () => {
  const buffer = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(extractImage(buffer), { code: 'NO_OCR_TEXT' });
});

test('photo OCR: mobile EXIF orientation is corrected before recognizing Bulgarian text', async () => {
  const rotated = await sharp(await makePhoto()).rotate(270).withMetadata({ orientation: 6 }).jpeg({ quality: 90 }).toBuffer();
  const result = await extractImage(rotated);
  assert.match(result.pages[0].text, /ДЕКЛАРАЦИЯ/iu);
  assert.match(result.pages[0].text, /заявление/iu);
});

test('photo OCR: a signature alone is not a valid image', async () => {
  const fake = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
  assert.equal(imageType(fake), 'png');
  await assert.rejects(extractImage(fake), { code: 'INVALID_IMAGE' });
});

test('photo OCR: SVG and arbitrary files are rejected before decoding', async () => {
  await assert.rejects(extractImage(Buffer.from('<svg/>')), { code: 'INVALID_IMAGE' });
  assert.equal(imageType(Buffer.from('text')), null);
});

test('photo OCR: excessive pixel dimensions are rejected independently of compressed file size', async () => {
  const buffer = await sharp({ create: { width: 4000, height: 4000, channels: 3, background: '#fff' } }).png().toBuffer();
  assert.ok(buffer.length < 10 * 1024 * 1024);
  await assert.rejects(extractImage(buffer), { code: 'INVALID_IMAGE' });
});

test('photo OCR: timeout and cancellation terminate the isolated worker', async () => {
  const buffer = await makePhoto();
  await assert.rejects(extractImage(buffer, { timeoutMs: 1 }), { code: 'PROCESSING_LIMIT' });
  const controller = new AbortController();
  const pending = extractImage(buffer, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
});

test('photo endpoint: shared upload and analysis routes accept original image bytes, never browser-provided OCR', async () => {
  const image = await makePhoto();
  const source = 'Подайте заявление до 15 октомври 2027 г.';
  let extractions = 0;
  const server = createApp({
    extractPhoto: async (buffer) => {
      extractions++;
      assert.deepEqual(buffer, image);
      return { pageCount: 1, sourceType: 'photo', pages: [{ pageNumber: 1, text: source, extractionMethod: 'ocr', ocrConfidence: 90 }], warnings: ['OCR: провери снимката.'] };
    },
    aiClient: createMockAIClient({ env: { NODE_ENV: 'test' }, respond: () => ({ items: [{
      type: 'action', obligationLevel: 'mandatory', title: 'Подай заявление', explanation: 'Подай заявление.',
      deadline: null, pageNumber: 1, sourceQuote: source, warnings: [],
    }], warnings: [] }) }),
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const caps = await (await fetch(`${base}/api/capabilities`)).json();
    assert.equal(caps.photo, true);
    assert.ok(!JSON.stringify(caps).includes('API_KEY'));
    for (const endpoint of ['upload', 'analyze']) {
      const form = new FormData();
      form.append('document', new Blob([image], { type: 'application/octet-stream' }), 'photo.bin');
      const response = await fetch(`${base}/api/documents/${endpoint}`, { method: 'POST', body: form });
      assert.equal(response.status, 200);
      const result = await response.json();
      if (endpoint === 'upload') assert.equal(result.sourceType, 'photo');
      else {
        assert.equal(result.analysis.items[0].verificationStatus, 'verified');
        assert.equal(result.analysis.extractionMethod, 'ocr');
        assert.ok(result.analysis.warnings.includes('OCR: провери снимката.'));
      }
    }
    assert.equal(extractions, 2);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('document endpoints: cross-origin browser uploads are rejected before processing', async () => {
  let processed = false;
  const server = createApp({ extractPhoto: async () => { processed = true; throw new Error('Must not process'); } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const form = new FormData();
    form.append('document', new Blob([await makePhoto()]), 'photo.png');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/documents/upload`, {
      method: 'POST', body: form, headers: { Origin: 'https://unrelated.example' },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'INVALID_ORIGIN');
    assert.equal(processed, false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('mobile app: manifest and all installation icons are served without exposing private files', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
    assert.equal(manifest.display, 'standalone');
    for (const icon of manifest.icons) {
      const response = await fetch(`${base}${icon.src}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /image\/png/);
    }
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    assert.equal((await fetch(`${base}/sw.js`)).status, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
