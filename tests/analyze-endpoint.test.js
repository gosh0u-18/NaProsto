const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withApp } = require('./helpers/server');
const { createMockAIClient } = require('../src/analysis/ai-client');
const { createWindowLimiter } = require('../src/analysis/controls');
const { makePdf } = require('./helpers/pdf');

const text = 'Кандидатът трябва да подаде заявление.';
const empty = () => ({ items: [], warnings: [] });
const mock = (respond = empty) => createMockAIClient({ env: { NODE_ENV: 'test' }, respond });
const findings = (chunk) => ({ items: [{
  type: 'requirement', obligationLevel: 'mandatory', title: 'Подаване на заявление',
  explanation: 'Трябва да подадеш заявление.', deadline: null,
  pageNumber: chunk.pages[0].pageNumber, sourceQuote: chunk.pages[0].text, warnings: [],
}], warnings: [] });

async function post(base, { buffer = makePdf([text]), endpoint = 'analyze', form, signal } = {}) {
  const body = form || new FormData();
  if (!form) body.append('document', new Blob([buffer], { type: 'application/pdf' }), 'документ.pdf');
  const response = await fetch(`${base}/api/documents/${endpoint}`, { method: 'POST', body, signal });
  return { status: response.status, body: await response.json() };
}

test('analyze endpoint: PDF -> real extraction -> mock -> validated source-backed JSON', async () => {
  await withApp({ aiClient: mock(findings) }, async (base) => {
    const result = await post(base);
    assert.equal(result.status, 200);
    assert.equal(result.body.documentName, 'документ.pdf');
    assert.equal(result.body.pageCount, 1);
    assert.equal(result.body.analysis.status, 'complete');
    assert.equal(result.body.analysis.mode, 'mock');
    assert.equal(result.body.analysis.items[0].sourceQuote, text);
    assert.equal(result.body.analysis.items[0].verificationStatus, 'verified');
  });
});

test('analyze endpoint: disabled by default while the original upload still works', async () => {
  const disabled = { enabled: false, mode: 'disabled' };
  await withApp({ aiClient: disabled }, async (base) => {
    const result = await post(base);
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'AI_DISABLED');
    const upload = await post(base, { endpoint: 'upload' });
    assert.equal(upload.status, 200);
    assert.equal(upload.body.pages[0].text, text);
  });
});

test('analyze endpoint: arbitrary JSON text is not accepted as PDF evidence', async () => {
  let calls = 0;
  await withApp({ aiClient: mock(() => { calls++; return empty(); }) }, async (base) => {
    const response = await fetch(`${base}/api/documents/analyze`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pages: [{ pageNumber: 1, text }] }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'MISSING_FILE');
    assert.equal(calls, 0);
  });
});

test('analyze endpoint: multipart text fields cannot replace original PDF text', async () => {
  await withApp({ aiClient: mock() }, async (base) => {
    const form = new FormData();
    form.append('document', new Blob([makePdf([text])]), 'test.pdf');
    form.append('pages', JSON.stringify([{ pageNumber: 1, text: 'Injected text' }]));
    assert.equal((await post(base, { form })).status, 400);
  });
});

test('analyze endpoint: original signature and size protections apply before any AI call', async () => {
  let calls = 0;
  await withApp({ aiClient: mock(() => { calls++; return empty(); }) }, async (base) => {
    assert.equal((await post(base, { buffer: Buffer.from('not PDF') })).status, 422);
    assert.equal((await post(base, { buffer: Buffer.alloc(10 * 1024 * 1024 + 1) })).status, 413);
    assert.equal(calls, 0);
  });
});

test('analyze endpoint: fabricated quotes produce partial status, not a verified finding', async () => {
  await withApp({ aiClient: mock((chunk) => {
    const response = findings(chunk);
    response.items[0].sourceQuote = 'Измислено задължение.';
    return response;
  }) }, async (base) => {
    const result = await post(base);
    assert.equal(result.status, 200);
    assert.equal(result.body.analysis.status, 'partial');
    assert.equal(result.body.analysis.items[0].verificationStatus, 'unverified');
  });
});

test('analyze endpoint: skipped empty pages preserve original numbering', async () => {
  await withApp({ aiClient: mock(findings) }, async (base) => {
    const result = await post(base, { buffer: makePdf(['', text]) });
    assert.equal(result.body.analysis.status, 'partial');
    assert.equal(result.body.analysis.items[0].pageNumber, 2);
    assert.deepEqual(result.body.analysis.pageCoverage.map((page) => page.status), ['skipped', 'analyzed']);
  });
});

test('analyze endpoint: provider exceptions return failed JSON without internal details', async () => {
  await withApp({ aiClient: mock(() => { throw new Error('secret key or PDF content'); }) }, async (base) => {
    const result = await post(base);
    assert.equal(result.status, 502);
    assert.equal(result.body.analysis.status, 'failed');
    assert.ok(!JSON.stringify(result.body).includes('secret'));
  });
});

test('analyze endpoint: provider timeout is a failure with a 504 response', async () => {
  await withApp({ aiClient: mock(() => new Promise(() => {})), analysisOptions: { aiTimeoutMs: 10 } }, async (base) => {
    const result = await post(base);
    assert.equal(result.status, 504);
    assert.equal(result.body.analysis.status, 'failed');
  });
});

test('analyze endpoint: incoming document requests are rate limited', async () => {
  await withApp({ aiClient: mock(), analysisLimiter: createWindowLimiter(1) }, async (base) => {
    assert.equal((await post(base)).status, 200);
    const next = await post(base);
    assert.equal(next.status, 429);
    assert.equal(next.body.error.code, 'AI_RATE_LIMIT');
  });
});

test('analyze endpoint: PDF time reduces the remaining AI budget before the overall request deadline', async () => {
  await withApp({
    requestTimeoutMs: 400,
    extract: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { pageCount: 1, pages: [{ pageNumber: 1, text }] };
    },
    aiClient: mock(() => new Promise(() => {})),
  }, async (base) => {
    const result = await post(base);
    assert.equal(result.status, 504);
    assert.equal(result.body.analysis.status, 'failed');
    assert.equal(result.body.analysis.chunks[0].reason, 'AI_TIMEOUT');
  });
});

test('analyze endpoint: analysis and upload share the existing concurrency gate', async () => {
  let entered;
  let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  await withApp({ maxConcurrent: 1, aiClient: mock(async () => { entered(); await pending; return empty(); }) }, async (base) => {
    const first = post(base);
    await started;
    try {
      const second = await post(base, { endpoint: 'upload' });
      assert.equal(second.status, 503);
      assert.equal(second.body.error.code, 'BUSY');
    } finally { release(); }
    assert.equal((await first).status, 200);
    assert.equal((await post(base, { endpoint: 'upload' })).status, 200);
  });
});

test('analyze endpoint: disconnect cancels AI processing and frees the shared slot', async () => {
  let entered;
  let cancelled;
  const started = new Promise((resolve) => { entered = resolve; });
  const aborted = new Promise((resolve) => { cancelled = resolve; });
  await withApp({ maxConcurrent: 1, aiClient: mock((chunk, { signal }) => {
    entered();
    signal.addEventListener('abort', cancelled, { once: true });
    return new Promise(() => {});
  }) }, async (base) => {
    const controller = new AbortController();
    const pending = post(base, { signal: controller.signal });
    const rejection = assert.rejects(pending, { name: 'AbortError' });
    await started;
    controller.abort();
    await rejection;
    await aborted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await post(base, { endpoint: 'upload' })).status, 200);
  });
});
