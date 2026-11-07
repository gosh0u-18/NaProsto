const { buildAnalysisRequest } = require('./prompt');
const { validatePages } = require('./source-verifier');
const { analysisLimits, analysisError, boundedSettings, withTimeout } = require('./controls');
const { readBoundedJson } = require('./http-response');
const { createGeminiClient } = require('./gemini-client');

function assertMockAllowed(env) {
  if (env.NODE_ENV !== 'test' && !(env.NODE_ENV === 'development' && env.AI_ALLOW_LOCAL_MOCK === 'true')) {
    throw analysisError('AI_CONFIGURATION');
  }
}

function createMockAIClient({ env = process.env, respond = () => ({
  items: [], warnings: ['Демонстрационен mock режим: не е извършен реален AI анализ.'],
}) } = {}) {
  assertMockAllowed(env);
  return { mode: 'mock', enabled: true, analyze: respond };
}

function outputText(response) {
  if (!response || typeof response !== 'object') {
    throw analysisError('AI_INVALID_RESPONSE');
  }
  if (response.status === 'incomplete') {
    throw analysisError('AI_INCOMPLETE');
  }
  if (response.status !== 'completed' || !Array.isArray(response.output)) {
    throw analysisError('AI_INVALID_RESPONSE');
  }
  const texts = [];
  for (const entry of response.output) {
    if (entry.type === 'reasoning') {
      continue;
    }
    if (entry.type !== 'message' || !Array.isArray(entry.content)) {
      throw analysisError('AI_INVALID_RESPONSE');
    }
    for (const part of entry.content) {
      if (part.type === 'refusal') {
        throw analysisError('AI_REFUSAL');
      }
      if (part.type !== 'output_text' || typeof part.text !== 'string') {
        throw analysisError('AI_INVALID_RESPONSE');
      }
      texts.push(part.text);
    }
  }
  if (!texts.length) {
    throw analysisError('AI_INVALID_RESPONSE');
  }
  return texts.join('');
}

function createAIClient({ env = process.env, allowRealRequests = false, fetchImpl = globalThis.fetch } = {}) {
  const mode = env.AI_MODE || 'disabled';
  if (mode === 'mock') {
    return createMockAIClient({ env });
  }
  if (mode === 'gemini') {
    return createGeminiClient({ env, allowRealRequests, fetchImpl });
  }
  if (!['disabled', 'openai'].includes(mode)) {
    throw analysisError('AI_CONFIGURATION');
  }
  if (mode !== 'openai' || !allowRealRequests) {
    return { mode: 'disabled', enabled: false, analyze: async () => { throw analysisError('AI_DISABLED'); } };
  }
  const key = env.OPENAI_API_KEY;
  const model = env.OPENAI_MODEL;
  if (!key?.trim() || !model?.trim()) {
    throw analysisError('AI_CONFIGURATION');
  }
  const settings = boundedSettings({ aiTimeoutMs: Number(env.AI_TIMEOUT_MS || analysisLimits.aiTimeoutMs) });
  return {
    mode: 'openai', enabled: true,
    async analyze(chunk, { signal, timeoutMs = settings.aiTimeoutMs } = {}) {
      validatePages(chunk.pages);
      if (chunk.pages.reduce((sum, page) => sum + page.text.length, 0) > settings.chunkCharacters) {
        throw analysisError('AI_RESOURCE_LIMIT');
      }
      const body = JSON.stringify(buildAnalysisRequest(chunk, { model, maxOutputTokens: settings.maxOutputTokens }));
      if (Buffer.byteLength(body) > settings.requestBytes) {
        throw analysisError('AI_RESOURCE_LIMIT');
      }
      return withTimeout(async (requestSignal) => {
        let response;
        try {
          response = await fetchImpl('https://api.openai.com/v1/responses', {
            method: 'POST', redirect: 'error', signal: requestSignal,
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body,
          });
        } catch { throw analysisError('AI_UNAVAILABLE'); }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          const code = response.status === 429 ? 'AI_RATE_LIMIT'
            : [401, 403].includes(response.status) ? 'AI_AUTH' : 'AI_UNAVAILABLE';
          throw analysisError(code);
        }
        try {
          return outputText(await readBoundedJson(response, settings.responseBytes));
        } catch (error) {
          if (['AI_INVALID_RESPONSE', 'AI_INCOMPLETE', 'AI_REFUSAL', 'AI_RESOURCE_LIMIT'].includes(error.code)) {
            throw error;
          }
          throw analysisError('AI_INVALID_RESPONSE');
        }
      }, { signal, timeoutMs: Math.min(timeoutMs, settings.aiTimeoutMs) });
    },
  };
}

function createConfiguredAIClient(env = process.env) {
  const enabled = env.AI_ENABLE_REAL_REQUESTS === 'true' && !env.NODE_TEST_CONTEXT && env.NODE_ENV !== 'test';
  if (env.AI_MODE === 'gemini' && enabled && !env.GEMINI_API_KEY?.trim()) {
    return { mode: 'disabled', enabled: false, analyze: async () => { throw analysisError('AI_CONFIGURATION'); } };
  }
  if (env.AI_MODE === 'openai' && enabled && (!env.OPENAI_API_KEY?.trim() || !env.OPENAI_MODEL?.trim())) {
    return { mode: 'disabled', enabled: false, analyze: async () => { throw analysisError('AI_CONFIGURATION'); } };
  }
  return createAIClient({ env, allowRealRequests: enabled });
}

module.exports = { createAIClient, createMockAIClient, createConfiguredAIClient };
