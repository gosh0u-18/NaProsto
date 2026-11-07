const express = require('express');
const multer = require('multer');
const path = require('node:path');
const limits = require('./limits');
const { extractPdf } = require('./pdf-process');
const { createConfiguredAIClient } = require('./analysis/ai-client');
const { extractImage, imageType } = require('./ocr/image-process');
const { buildInsights } = require('./analysis/insights');
const { createAnalysisService } = require('./analysis/service');
const { analysisLimits, createWindowLimiter, messages } = require('./analysis/controls');

const errors = {
  MISSING_FILE: [400, 'Избери един PDF файл или една снимка.'],
  INVALID_PDF: [422, 'Файлът не е валиден PDF, повреден е или е защитен с парола. Избери друг документ.'],
  NO_TEXT: [422, 'В PDF документа няма извлекаем текст. Ако е сканиран, добави страницата като JPEG, PNG или WebP снимка, за да използваш OCR.'],
  PROCESSING_LIMIT: [422, 'Документът е прекалено сложен или обработката отне твърде дълго. Опитай с по-кратък PDF.'],
  BUSY: [503, 'В момента се обработват други документи. Опитай отново след малко.'],
  TOO_LARGE: [413, 'Файлът надвишава разрешения размер от 10 MB.'],
  BAD_UPLOAD: [400, 'Качването е невалидно. Изпрати само един PDF файл.'],
  REQUEST_TIMEOUT: [408, 'Качването отне твърде дълго. Опитай отново.'],
  INTERNAL: [500, 'Възникна проблем при обработката. Опитай отново.'],
  AI_DISABLED: [503, messages.AI_DISABLED],
  AI_CONFIGURATION: [503, messages.AI_CONFIGURATION],
  AI_RATE_LIMIT: [429, messages.AI_RATE_LIMIT],
  INVALID_IMAGE: [422, 'Снимката е невалидна, твърде голяма като резолюция или неподдържана. Използвай JPEG, PNG или WebP до 12 мегапиксела.'],
  NO_OCR_TEXT: [422, 'Не открихме четим текст на снимката. Снимай отблизо, на светло и без отблясъци.'],
  OCR_UNAVAILABLE: [503, 'OCR моделите не са подготвени на сървъра. Изпълни npm.cmd run prepare:ocr и опитай отново.'],
  INVALID_ORIGIN: [403, 'Отвори приложението от неговия собствен адрес, за да изпратиш документ.'],
};

function sendError(res, code) {
  const [status, message] = errors[code] || errors.INTERNAL;
  return res.status(status).json({ error: { code: errors[code] ? code : 'INTERNAL', message } });
}

function originalName(name) {
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  const value = decoded.includes('\uFFFD') ? name : decoded;
  return value.replaceAll('\\', '/').split('/').pop().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 255);
}

function createApp({
  extract = extractPdf, maxConcurrent = limits.maxConcurrent, requestTimeoutMs = limits.requestMs,
  aiClient = createConfiguredAIClient(), analysisOptions = {}, extractPhoto = extractImage,
  analysisLimiter = createWindowLimiter(analysisLimits.documentsPerMinute),
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });
  app.get('/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok' });
  });
  let active = 0;
  const analyze = createAnalysisService({ aiClient, options: analysisOptions });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: limits.fileBytes, files: 1, fields: 0, parts: 2, headerPairs: 50 },
  }).single('document');

  const receiveDocument = (processDocument) => (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host) {
          return sendError(res, 'INVALID_ORIGIN');
        }
      } catch { return sendError(res, 'INVALID_ORIGIN'); }
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      return sendError(res, 'INVALID_ORIGIN');
    }
    if (active >= maxConcurrent) {
      return sendError(res, 'BUSY');
    }
    active++;
    const deadlineAt = performance.now() + requestTimeoutMs;
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', onClose);
    const timer = setTimeout(() => {
      controller.abort();
      if (!res.headersSent && !res.destroyed) sendError(res, 'REQUEST_TIMEOUT');
      req.destroy();
    }, requestTimeoutMs);

    upload(req, res, async (error) => {
      try {
        if (controller.signal.aborted || res.destroyed) {
          return;
        }
        if (error) {
          return sendError(res, error.code === 'LIMIT_FILE_SIZE' ? 'TOO_LARGE' : 'BAD_UPLOAD');
        }
        if (!req.file) {
          return sendError(res, 'MISSING_FILE');
        }
        const pdf = /^%PDF-\d\.\d/.test(req.file.buffer.subarray(0, 8).toString('latin1'));
        const photo = imageType(req.file.buffer);
        if (!pdf && !photo) {
          return sendError(res, req.file.mimetype.startsWith('image/') ? 'INVALID_IMAGE' : 'INVALID_PDF');
        }
        const documentName = originalName(req.file.originalname);
        const result = await (pdf ? extract : extractPhoto)(req.file.buffer, { signal: controller.signal });
        req.file.buffer = null;
        const output = await processDocument(result, { signal: controller.signal, deadlineAt });
        if (!res.destroyed && !controller.signal.aborted) {
          if (output.analysis?.status === 'failed') {
            const reasons = output.analysis.chunks.map((chunk) => chunk.reason);
            res.status(reasons.includes('AI_RATE_LIMIT') ? 429 : reasons.includes('AI_TIMEOUT') ? 504 : 502);
          }
          res.json({ documentName, ...output });
        }
      } catch (error) {
        if (!res.destroyed && !controller.signal.aborted) sendError(res, error.code);
      } finally {
        if (req.file) req.file.buffer = null;
        clearTimeout(timer);
        res.removeListener('close', onClose);
        active--;
      }
    });
  };

  app.post('/api/documents/upload', receiveDocument(async (document) => document));
  app.get('/api/capabilities', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ analysis: { enabled: aiClient.enabled, mode: aiClient.mode }, photo: true, maxFileBytes: limits.fileBytes });
  });
  app.post('/api/documents/analyze', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!aiClient.enabled) {
      return sendError(res, 'AI_DISABLED');
    }
    const address = req.socket.remoteAddress;
    if (aiClient.mode === 'mock' && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
      return sendError(res, 'AI_CONFIGURATION');
    }
    if (!analysisLimiter.take()) {
      res.set('Retry-After', '60');
      return sendError(res, 'AI_RATE_LIMIT');
    }
    next();
  }, receiveDocument(async (document, context) => {
    const analysis = await analyze(document.pages, context);
    if (document.sourceType === 'photo') {
      analysis.extractionMethod = 'ocr';
      analysis.warnings = [...new Set([...analysis.warnings, ...(document.warnings || [])])];
      if (document.pages.some((page) => page.ocrConfidence < 70)) {
        analysis.warnings.push('OCR разпознаването е с ниска увереност. Провери текста спрямо снимката.');
        if (analysis.status === 'complete') analysis.status = 'partial';
      }
      analysis.insights = buildInsights(analysis, { pages: document.pages });
    }
    return { pageCount: document.pageCount, analysis };
  }));

  app.use(express.static(path.join(__dirname, '..', 'public')));
  return app;
}

module.exports = { createApp };
