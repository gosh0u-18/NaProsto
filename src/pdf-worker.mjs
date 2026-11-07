import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import limits from './limits.js';

process.once('message', async (buffer) => {
  let loadingTask;
  let result;
  try {
    loadingTask = getDocument({
      data: new Uint8Array(buffer),
      verbosity: 0,
      useWorkerFetch: false,
      useSystemFonts: false,
      isEvalSupported: false,
      stopAtErrors: true,
    });
    const document = await loadingTask.promise;
    if (document.numPages > limits.maxPages) {
      throw new Error('PROCESSING_LIMIT');
    }
    const pages = [];
    let totalCharacters = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const reader = page.streamTextContent().getReader();
      let text = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          for (const item of value.items) {
            if (typeof item.str !== 'string') {
              continue;
            }
            const part = item.str + (item.hasEOL ? '\n' : ' ');
            totalCharacters += part.length;
            if (text.length + part.length > limits.maxPageCharacters || totalCharacters > limits.maxCharacters) {
              throw new Error('PROCESSING_LIMIT');
            }
            text += part;
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        page.cleanup();
      }
      pages.push({ pageNumber, text: text.trim() });
    }
    result = pages.some((page) => page.text.trim())
      ? { pageCount: document.numPages, pages }
      : { error: 'NO_TEXT' };
  } catch (error) {
    result = { error: error.message === 'PROCESSING_LIMIT' ? 'PROCESSING_LIMIT' : 'INVALID_PDF' };
  } finally {
    await loadingTask?.destroy().catch(() => {});
  }
  if (process.connected) process.send(result, () => process.disconnect());
});
