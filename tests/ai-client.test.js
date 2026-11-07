const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAIClient, createMockAIClient, createConfiguredAIClient } = require('../src/analysis/ai-client');

const chunk = { id: 1, pages: [{ pageNumber: 1, text: 'Подайте заявление.', startOffset: 0 }] };
const env = { AI_MODE: 'openai', OPENAI_API_KEY: 'local-test-token-never-sent-to-network', OPENAI_MODEL: 'test-model' };
const jsonResponse = (data, options) => new Response(JSON.stringify(data), options);
const completed = (content = [{ type: 'output_text', text: '{"items":[],"warnings":[]}' }]) => ({
  status: 'completed', output: [{ type: 'message', content }],
});

test('AI configuration: real requests need explicit backend opt-in and are disabled in tests', () => {
  assert.equal(createConfiguredAIClient(env).enabled, false);
  assert.equal(createConfiguredAIClient({ ...env, AI_ENABLE_REAL_REQUESTS: 'true' }).enabled, true);
  assert.equal(createConfiguredAIClient({ ...env, AI_ENABLE_REAL_REQUESTS: 'true', NODE_ENV: 'test' }).enabled, false);
  assert.equal(createConfiguredAIClient({ ...env, AI_ENABLE_REAL_REQUESTS: 'true', NODE_TEST_CONTEXT: 'child-v8' }).enabled, false);
  assert.equal(createConfiguredAIClient({ ...env, AI_ENABLE_REAL_REQUESTS: 'true', OPENAI_API_KEY: '' }).enabled, false);
});

test('AI client: disabled by default without requiring an API key', async () => {
  const client = createAIClient({ env: {} });
  assert.equal(client.enabled, false);
  await assert.rejects(client.analyze(chunk), { code: 'AI_DISABLED' });
});

test('AI client: environment mode and a key alone cannot enable paid requests', async () => {
  let called = false;
  const client = createAIClient({ env, fetchImpl: () => { called = true; throw new Error('Network forbidden'); } });
  await assert.rejects(client.analyze(chunk), { code: 'AI_DISABLED' });
  assert.equal(called, false);
});

test('AI client: mock requires test mode or an explicitly enabled local development environment', () => {
  assert.throws(() => createMockAIClient({ env: { NODE_ENV: 'production' } }), { code: 'AI_CONFIGURATION' });
  assert.throws(() => createAIClient({ env: { AI_MODE: 'mock', NODE_ENV: 'development' } }), { code: 'AI_CONFIGURATION' });
  assert.equal(createAIClient({ env: { AI_MODE: 'mock', NODE_ENV: 'development', AI_ALLOW_LOCAL_MOCK: 'true' } }).mode, 'mock');
});

test('AI client: local mock clearly reports that it is not a real AI analysis', async () => {
  const client = createMockAIClient({ env: { NODE_ENV: 'test' } });
  const result = await client.analyze(chunk);
  assert.deepEqual(result.items, []);
  assert.match(result.warnings[0], /mock/);
});

test('AI client: prepared Responses request has the strict schema, no tools or document storage', async () => {
  let request;
  const client = createAIClient({ env, allowRealRequests: true, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, `Bearer ${env.OPENAI_API_KEY}`);
    assert.equal(options.redirect, 'error');
    request = JSON.parse(options.body);
    assert.ok(!options.body.includes(env.OPENAI_API_KEY));
    return jsonResponse(completed());
  } });
  assert.equal(await client.analyze(chunk), '{"items":[],"warnings":[]}');
  assert.equal(request.model, 'test-model');
  assert.equal(request.text.format.type, 'json_schema');
  assert.equal(request.text.format.strict, true);
  assert.equal(request.store, false);
  assert.deepEqual(request.tools, []);
  assert.equal(request.max_output_tokens, 4000);
});

test('AI client: real adapter configuration requires both key and model', () => {
  for (const changes of [{ OPENAI_API_KEY: '' }, { OPENAI_MODEL: '' }, { AI_TIMEOUT_MS: 'nonsense' }]) {
    assert.throws(() => createAIClient({ env: { ...env, ...changes }, allowRealRequests: true }), { code: 'AI_CONFIGURATION' });
  }
});

test('AI client: provider HTTP errors are sanitized without reading its error body', async () => {
  for (const [status, code] of [[401, 'AI_AUTH'], [403, 'AI_AUTH'], [429, 'AI_RATE_LIMIT'], [500, 'AI_UNAVAILABLE']]) {
    let calls = 0;
    const client = createAIClient({ env, allowRealRequests: true, fetchImpl: async () => {
      calls++;
      return new Response('secret document or provider internals', { status });
    } });
    await assert.rejects(client.analyze(chunk), (error) => error.code === code && !error.message.includes('secret'));
    assert.equal(calls, 1);
  }
});

test('AI client: refusal, incomplete and unexpected tool output are not treated as JSON success', async () => {
  for (const [data, code] of [
    [completed([{ type: 'refusal', refusal: 'internal message' }]), 'AI_REFUSAL'],
    [{ status: 'incomplete' }, 'AI_INCOMPLETE'],
    [{ status: 'completed', output: [{ type: 'function_call', name: 'delete_files' }] }, 'AI_INVALID_RESPONSE'],
    [null, 'AI_INVALID_RESPONSE'],
  ]) {
    const client = createAIClient({ env, allowRealRequests: true, fetchImpl: async () => jsonResponse(data) });
    await assert.rejects(client.analyze(chunk), { code });
  }
});

test('AI client: response body has a bounded byte size', async () => {
  const client = createAIClient({ env, allowRealRequests: true, fetchImpl: async () => new Response('x'.repeat(256001)) });
  await assert.rejects(client.analyze(chunk), { code: 'AI_RESOURCE_LIMIT' });
});

test('AI client: oversized input is blocked before the transport is called', async () => {
  const client = createAIClient({ env, allowRealRequests: true, fetchImpl: () => { throw new Error('Must not be called'); } });
  await assert.rejects(client.analyze({ pages: [{ pageNumber: 1, text: 'x'.repeat(4001) }] }), { code: 'AI_RESOURCE_LIMIT' });
});

test('AI client: timeout cancels the injected transport without a real request', async () => {
  let aborted = false;
  const client = createAIClient({ env: { ...env, AI_TIMEOUT_MS: '10' }, allowRealRequests: true,
    fetchImpl: (url, { signal }) => {
      signal.addEventListener('abort', () => { aborted = true; });
      return new Promise(() => {});
    },
  });
  await assert.rejects(client.analyze(chunk), { code: 'AI_TIMEOUT' });
  assert.equal(aborted, true);
});

test('AI client: network failures hide exception details and do not retry', async () => {
  let calls = 0;
  const client = createAIClient({ env, allowRealRequests: true, fetchImpl: async () => {
    calls++;
    throw new Error('secret token and document');
  } });
  await assert.rejects(client.analyze(chunk), (error) => error.code === 'AI_UNAVAILABLE' && !error.message.includes('secret'));
  assert.equal(calls, 1);
});

test('AI client: pre-aborted requests never reach the transport', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const client = createAIClient({ env, allowRealRequests: true, fetchImpl: () => { calls++; throw new Error('Must not call'); } });
  await assert.rejects(client.analyze(chunk, { signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(calls, 0);
});

test('AI client: malformed HTTP JSON is sanitized', async () => {
  const client = createAIClient({ env, allowRealRequests: true, fetchImpl: async () => new Response('not JSON with provider details') });
  await assert.rejects(client.analyze(chunk), { code: 'AI_INVALID_RESPONSE' });
});

test('AI client: response stream failures do not expose internal transport errors', async () => {
  const client = createAIClient({ env, allowRealRequests: true, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error('secret transport details')); },
  })) });
  await assert.rejects(client.analyze(chunk), (error) => error.code === 'AI_INVALID_RESPONSE' && !error.message.includes('secret'));
});
