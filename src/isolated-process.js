const { fork } = require('node:child_process');
const limits = require('./limits');

function runIsolated(workerPath, buffer, { signal, timeoutMs = limits.processingMs } = {}) {
  if (signal?.aborted) {
    return Promise.reject(Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' }));
  }
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [], {
      execArgv: ['--max-old-space-size=128'], serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    let result;
    let failure;
    const stop = (code) => {
      failure ||= Object.assign(new Error(code), { code });
      child.kill();
    };
    const abort = () => stop('CANCELLED');
    const timer = setTimeout(() => stop('PROCESSING_LIMIT'), Math.min(timeoutMs, limits.processingMs));
    signal?.addEventListener('abort', abort, { once: true });
    child.once('message', (message) => {
      if (message.error) failure = Object.assign(new Error(message.error), { code: message.error });
      else result = message;
      child.kill();
    });
    child.once('error', () => stop('PROCESSING_LIMIT'));
    child.once('close', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (result) resolve(result);
      else reject(Object.assign(new Error('PROCESSING_LIMIT'), { code: 'PROCESSING_LIMIT' }));
    });
    child.send(buffer, (error) => { if (error) stop('PROCESSING_LIMIT'); });
  });
}

module.exports = { runIsolated };
