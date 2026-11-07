const { instructions } = require('./prompt');
const { candidateAnalysisSchema } = require('./schema');
const { validatePages } = require('./source-verifier');
const { readBoundedJson } = require('./http-response');
const { analysisLimits, boundedSettings, withTimeout, analysisError } = require('./controls');

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

function buildGeminiRequest(chunk, settings, model) {
  const request = {
    systemInstruction: { parts: [{ text: instructions }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify({ untrustedDocumentFragments: chunk.pages }) }] }],
    generationConfig: {
      candidateCount: 1,
      maxOutputTokens: settings.maxOutputTokens,
      responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: candidateAnalysisSchema } },
    },
    tools: [],
  };
  if (model === DEFAULT_GEMINI_MODEL) request.generationConfig.thinkingConfig = { thinkingLevel: 'MINIMAL' };
  return request;
}

function geminiOutputText(response) {
  if (!response || typeof response !== 'object') {
    throw analysisError('AI_INVALID_RESPONSE');
  }
  if (response.promptFeedback?.blockReason && response.promptFeedback.blockReason !== 'BLOCK_REASON_UNSPECIFIED') {
    throw analysisError('AI_REFUSAL');
  }
  if (!Array.isArray(response.candidates) || response.candidates.length !== 1) {
    throw analysisError('AI_INVALID_RESPONSE');
  }
  const candidate = response.candidates[0];
  if (candidate.finishReason === 'MAX_TOKENS') {
    throw analysisError('AI_INCOMPLETE');
  }
  if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(candidate.finishReason)) {
    throw analysisError('AI_REFUSAL');
  }
  if (candidate.finishReason !== 'STOP' || !Array.isArray(candidate.content?.parts)) {
    throw analysisError('AI_INVALID_RESPONSE');
  }
  const texts = [];
  for (const part of candidate.content.parts) {
    if (part.thought === true) {
      continue;
    }
    if (typeof part.text !== 'string' || Object.keys(part).some((key) => !['text', 'thought', 'thoughtSignature'].includes(key))) {
      throw analysisError('AI_INVALID_RESPONSE');
    }
    texts.push(part.text);
  }
  const text = texts.join('');
  if (!text.trim()) {
    throw analysisError('AI_INVALID_RESPONSE');
  }
  return text;
}

function createGeminiClient({ env = process.env, allowRealRequests = false, fetchImpl = globalThis.fetch } = {}) {
  if (!allowRealRequests) {
    return { mode: 'disabled', enabled: false, analyze: async () => { throw analysisError('AI_DISABLED'); } };
  }
  const key = env.GEMINI_API_KEY;
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  if (!key?.trim() || !/^gemini-[a-z0-9][a-z0-9.-]{0,100}$/i.test(model)) {
    throw analysisError('AI_CONFIGURATION');
  }
  const settings = boundedSettings({ aiTimeoutMs: Number(env.AI_TIMEOUT_MS || analysisLimits.aiTimeoutMs) });
  return {
    mode: 'gemini', enabled: true,
    async analyze(chunk, { signal, timeoutMs = settings.aiTimeoutMs } = {}) {
      validatePages(chunk.pages);
      if (chunk.pages.reduce((sum, page) => sum + page.text.length, 0) > settings.chunkCharacters) {
        throw analysisError('AI_RESOURCE_LIMIT');
      }
      const body = JSON.stringify(buildGeminiRequest(chunk, settings, model));
      if (Buffer.byteLength(body) > settings.requestBytes) {
        throw analysisError('AI_RESOURCE_LIMIT');
      }
      return withTimeout(async (requestSignal) => {
        let response;
        try {
          response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: 'POST', redirect: 'error', signal: requestSignal,
            headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body,
          });
        } catch (error) {
          const code = error.cause?.code || error.code;
          throw analysisError(['EACCES', 'EPERM'].includes(code) ? 'AI_NETWORK_BLOCKED' : 'AI_UNAVAILABLE');
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          const code = response.status === 429 ? 'AI_RATE_LIMIT'
            : [401, 403].includes(response.status) ? 'AI_AUTH'
              : response.status === 404 ? 'AI_MODEL' : response.status === 400 ? 'AI_REQUEST' : 'AI_UNAVAILABLE';
          throw analysisError(code);
        }
        try {
          return geminiOutputText(await readBoundedJson(response, settings.responseBytes));
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

module.exports = { createGeminiClient, DEFAULT_GEMINI_MODEL };
