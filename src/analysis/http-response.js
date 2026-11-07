const { analysisError } = require('./controls');

async function readBoundedJson(response, maximum) {
  if (!response.body) {
    throw analysisError('AI_INVALID_RESPONSE');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > maximum) {
        throw analysisError('AI_RESOURCE_LIMIT');
      }
      chunks.push(Buffer.from(value));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      throw analysisError('AI_INVALID_RESPONSE');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

module.exports = { readBoundedJson };
