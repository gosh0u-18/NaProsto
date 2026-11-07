const analysisLimits = Object.freeze({
  chunkCharacters: 4000,
  maxChunks: 4,
  maxCharacters: 16000,
  totalMs: 60000,
  aiTimeoutMs: 30000,
  responseBytes: 256000,
  requestBytes: 64000,
  maxOutputTokens: 4000,
  requestsPerMinute: 12,
  documentsPerMinute: 6,
  reserveMs: 150,
});

const messages = {
  AI_DISABLED: 'AI анализът е изключен. За локална демонстрация трябва изрично да се включи mock режим.',
  AI_CONFIGURATION: 'Настройките за AI анализ не са валидни.',
  AI_TIMEOUT: 'AI обработката надхвърли разрешеното време.',
  AI_RATE_LIMIT: 'Достигнат е лимитът за AI заявки. Опитай отново след минута.',
  AI_AUTH: 'AI услугата не е конфигурирана за достъп.',
  AI_MODEL: 'Избраният AI модел не е достъпен. Провери модела и достъпа до него в настройките на доставчика.',
  AI_REQUEST: 'AI услугата отхвърли заявката. Провери ключа, модела и съвместимостта на настройките на сървъра.',
  AI_UNAVAILABLE: 'AI услугата временно не е достъпна.',
  AI_NETWORK_BLOCKED: 'Мрежовите ограничения блокират достъпа на сървъра до AI услугата. Стартирай сървъра от нормален терминал с разрешен достъп до интернет.',
  AI_REFUSAL: 'AI услугата не върна анализ за тази част.',
  AI_INCOMPLETE: 'AI услугата върна незавършен отговор.',
  AI_INVALID_RESPONSE: 'AI услугата върна невалиден отговор.',
  AI_RESOURCE_LIMIT: 'Достигнат е ресурсният лимит за анализа.',
  INVALID_ANALYSIS: 'Отговорът не отговаря на схемата за анализ.',
  CANCELLED: 'Обработката е прекратена.',
};

function analysisError(code) {
  return Object.assign(new Error(messages[code] || messages.AI_UNAVAILABLE), {
    code: Object.hasOwn(messages, code) ? code : 'AI_UNAVAILABLE',
  });
}

function boundedSettings(overrides = {}) {
  const result = { ...analysisLimits };
  for (const key of Object.keys(result)) {
    if (overrides[key] !== undefined) {
      if (!Number.isInteger(overrides[key]) || overrides[key] < 1) {
        throw analysisError('AI_CONFIGURATION');
      }
      result[key] = Math.min(result[key], overrides[key]);
    }
  }
  return result;
}

function createWindowLimiter(maximum, { windowMs = 60000, now = () => performance.now() } = {}) {
  let start = now();
  let count = 0;
  return {
    take() {
      if (now() - start >= windowMs) { start = now(); count = 0; }
      if (count >= maximum) {
        return false;
      }
      count++;
      return true;
    },
  };
}

async function withTimeout(operation, { signal, timeoutMs }) {
  if (signal?.aborted) {
    throw analysisError('CANCELLED');
  }
  if (timeoutMs <= 0) {
    throw analysisError('AI_TIMEOUT');
  }
  const controller = new AbortController();
  let timer;
  let abort;
  const deadline = new Promise((resolve, reject) => {
    abort = () => { controller.abort(); reject(analysisError('CANCELLED')); };
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(analysisError('AI_TIMEOUT')); }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), deadline]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

module.exports = { analysisLimits, analysisError, messages, boundedSettings, createWindowLimiter, withTimeout };
