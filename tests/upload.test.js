const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../src/app');
const { extractPdf } = require('../src/pdf-process');
const limits = require('../src/limits');
const { makePdf } = require('./helpers/pdf');

let server;
let base;
before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

async function upload(buffer, { name = 'document.pdf', type = 'application/pdf', url = base } = {}) {
  const form = new FormData();
  form.append('document', new Blob([buffer], { type }), name);
  const response = await fetch(`${url}/api/documents/upload`, { method: 'POST', body: form });
  return { status: response.status, body: await response.json() };
}

test('extracts Bulgarian text and preserves original page numbers, including an empty middle page', async () => {
  const result = await upload(makePdf(['Срок: 15 октомври.', '', 'Подайте заявление.']), { name: 'документ.pdf' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    documentName: 'документ.pdf', pageCount: 3,
    pages: [
      { pageNumber: 1, text: 'Срок: 15 октомври.' },
      { pageNumber: 2, text: '' },
      { pageNumber: 3, text: 'Подайте заявление.' },
    ],
  });
});

test('recognizes a real PDF even with an unhelpful filename and MIME type', async () => {
  const result = await upload(makePdf(['Real PDF']), { name: 'file.bin', type: 'application/octet-stream' });
  assert.equal(result.status, 200);
});

test('rejects a missing file', async () => {
  const response = await fetch(`${base}/api/documents/upload`, { method: 'POST' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'MISSING_FILE');
});

test('rejects an empty file', async () => {
  const result = await upload(Buffer.alloc(0));
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, 'INVALID_PDF');
});

test('rejects a non-PDF disguised by extension and MIME', async () => {
  const result = await upload(Buffer.from('<html>not a PDF</html>'));
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, 'INVALID_PDF');
});

test('a PDF signature alone is insufficient: the real parser rejects corrupt data', async () => {
  const result = await upload(Buffer.from('%PDF-1.7\nBroken contents\n%%EOF'));
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, 'INVALID_PDF');
  assert.ok(!JSON.stringify(result.body).includes('stack'));
});

test('rejects files over 10 MB', async () => {
  const result = await upload(Buffer.alloc(limits.fileBytes + 1));
  assert.equal(result.status, 413);
  assert.equal(result.body.error.code, 'TOO_LARGE');
});

test('accepts a valid PDF exactly at the 10 MB limit', async () => {
  const buffer = Buffer.alloc(limits.fileBytes, 32);
  makePdf(['At the limit']).copy(buffer);
  const result = await upload(buffer);
  assert.equal(result.status, 200);
});

test('image-only PDF receives a clear OCR message', async () => {
  const result = await upload(makePdf([''], { imageOnly: true }));
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, 'NO_TEXT');
  assert.match(result.body.error.message, /OCR/);
});

test('rejects documents with more than 100 pages', async () => {
  const result = await upload(makePdf(Array(101).fill('Page')));
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, 'PROCESSING_LIMIT');
});

test('rejects excessive extracted text on a page', async () => {
  const result = await upload(makePdf(['A'.repeat(limits.maxPageCharacters + 1)]));
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, 'PROCESSING_LIMIT');
});

test('rejects multiple files', async () => {
  const form = new FormData();
  for (let i = 0; i < 2; i++) form.append('document', new Blob([makePdf(['PDF'])]), `${i}.pdf`);
  const response = await fetch(`${base}/api/documents/upload`, { method: 'POST', body: form });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'BAD_UPLOAD');
});

test('rejects excessive total extracted text across multiple pages', async () => {
  const result = await upload(makePdf(Array(11).fill('A'.repeat(95_000))));
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, 'PROCESSING_LIMIT');
});

test('rejects unexpected multipart fields', async () => {
  const form = new FormData();
  form.append('unexpected', 'value');
  const response = await fetch(`${base}/api/documents/upload`, { method: 'POST', body: form });
  assert.equal(response.status, 400);
});

test('a timed-out PDF child process is terminated', async () => {
  await assert.rejects(extractPdf(makePdf(['Hello']), { timeoutMs: 1 }), { code: 'PROCESSING_LIMIT' });
});

test('a cancelled processing request terminates its child process', async () => {
  const controller = new AbortController();
  const result = extractPdf(makePdf(['Hello']), { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { code: 'CANCELLED' });
});

test('limits concurrent requests and releases its slot afterwards', async () => {
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const limited = createApp({ maxConcurrent: 1, extract: async () => {
    entered();
    await pending;
    return { pageCount: 1, pages: [{ pageNumber: 1, text: 'Hello' }] };
  } }).listen(0, '127.0.0.1');
  await once(limited, 'listening');
  const url = `http://127.0.0.1:${limited.address().port}`;
  try {
    const first = upload(makePdf(['Hello']), { url });
    await started;
    const second = await upload(makePdf(['Hello']), { url });
    assert.equal(second.status, 503);
    assert.equal(second.body.error.code, 'BUSY');
    release();
    assert.equal((await first).status, 200);
    assert.equal((await upload(makePdf(['Again']), { url })).status, 200);
  } finally {
    release();
    await new Promise((resolve) => limited.close(resolve));
  }
});

test('unexpected server errors are hidden from the user', async () => {
  const faulty = createApp({ extract: async () => { throw new Error('secret internal path'); } }).listen(0, '127.0.0.1');
  await once(faulty, 'listening');
  try {
    const result = await upload(makePdf(['Hello']), { url: `http://127.0.0.1:${faulty.address().port}` });
    assert.equal(result.status, 500);
    assert.equal(result.body.error.code, 'INTERNAL');
    assert.ok(!JSON.stringify(result.body).includes('secret'));
  } finally {
    await new Promise((resolve) => faulty.close(resolve));
  }
});

test('the home page, styles and browser script are still served after upload errors', async () => {
  for (const resource of ['/', '/styles.css', '/script.js']) {
    const response = await fetch(`${base}${resource}`);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).length > 100);
  }
});
