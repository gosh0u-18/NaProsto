const { chunkDocument } = require('./chunker');
const { parseCandidateAnalysis, bounds, getValidationDiagnostics } = require('./schema');
const { verifyAnalysis, verifySource, compareItems } = require('./source-verifier');
const { boundedSettings, createWindowLimiter, withTimeout, analysisError, messages } = require('./controls');
const { restoreCandidateQuotes } = require('./quote-resolver');
const { buildInsights } = require('./insights');
const { verifyDocumentContext } = require('./summary');
const { filterCandidate } = require('./candidate-filter');

function createAnalysisService({ aiClient, options = {}, requestLimiter } = {}) {

  const settings = boundedSettings(options);
  const limiter = requestLimiter || createWindowLimiter(settings.requestsPerMinute);

  return async function analyzeDocument(pages, { signal, deadlineAt = Infinity } = {}) {
    if (!aiClient?.enabled) {
      throw analysisError('AI_DISABLED');
    }
    if (signal?.aborted) {
      throw analysisError('CANCELLED');
    }
    const stopAt = Math.min(performance.now() + settings.totalMs, deadlineAt - settings.reserveMs);
    const plan = chunkDocument(pages, { ...settings, preferPageBoundaries: aiClient.mode === 'gemini' });
    const items = [];
    const documentContext = [];
    const scopes = [];
    const restoredQuotes = [];
    const warnings = [];
    const chunkResults = [];
    const successfulCharacters = new Map();
    const partialPages = new Set();
    let requests = 0;
    let sentCharacters = 0;
    let aggregateBytes = 0;
    let receivedItems = 0;
    let stopReason;

    for (const chunk of plan.chunks) {
      if (signal?.aborted) {
        throw analysisError('CANCELLED');
      }
      const remaining = stopAt - performance.now();
      if (remaining <= 0) { stopReason = 'AI_TIMEOUT'; break; }
      if (!limiter.take()) { stopReason = 'AI_RATE_LIMIT'; break; }
      requests++;
      sentCharacters += chunk.pages.reduce((sum, page) => sum + page.text.length, 0);
      try {
        const raw = await withTimeout(
          (requestSignal) => aiClient.analyze(chunk, { signal: requestSignal, timeoutMs: Math.min(settings.aiTimeoutMs, remaining) }),
          { signal, timeoutMs: Math.min(settings.aiTimeoutMs, remaining) },
        );

        const resolved = restoreCandidateQuotes(parseCandidateAnalysis(raw, { deferDeadlineChecks: true }), chunk.pages);
        const bytes = Buffer.byteLength(JSON.stringify(resolved.candidate));
        if (bytes > settings.responseBytes || aggregateBytes + bytes > bounds.inputBytes || receivedItems + resolved.candidate.items.length > bounds.items || documentContext.length + resolved.candidate.documentContext.length > 48) {
          throw analysisError('AI_RESOURCE_LIMIT');
        }
        const filtered = filterCandidate(resolved.candidate);
        const candidate = filtered.candidate;
        aggregateBytes += bytes;
        receivedItems += resolved.candidate.items.length;
        items.push(...candidate.items);
        documentContext.push(...verifyDocumentContext(candidate.documentContext, chunk.pages));
        scopes.push(...candidate.items.map((item) => verifySource(item, chunk.pages)));
        restoredQuotes.push(...resolved.restored.filter((value, index) => !filtered.rejectedIndices.includes(index)));
        warnings.push(...candidate.warnings);
        for (const page of chunk.pages) successfulCharacters.set(page.pageNumber, (successfulCharacters.get(page.pageNumber) || 0) + page.text.length);
        if (filtered.rejectedIndices.length) {
          for (const page of chunk.pages) partialPages.add(page.pageNumber);
          warnings.push(`Пропуснати са ${filtered.rejectedIndices.length} находки с невалидни срокове. Останалите са проверени отделно. Прегледай оригинала за липсващи действия.`);
          chunkResults.push({ chunkId: chunk.id, status: 'partial', reason: 'INVALID_ANALYSIS',
            rejectedItems: filtered.rejectedIndices.length, validationDiagnostics: filtered.validationDiagnostics });
        } else {
          chunkResults.push({ chunkId: chunk.id, status: 'analyzed', reason: null });
        }
      } catch (error) {
        if (signal?.aborted) {
          throw analysisError('CANCELLED');
        }
        const code = Object.hasOwn(messages, error.code) ? error.code : 'AI_UNAVAILABLE';
        const validationDiagnostics = code === 'INVALID_ANALYSIS' ? getValidationDiagnostics(error) : undefined;
        chunkResults.push({ chunkId: chunk.id, status: 'failed', reason: code,
          ...(validationDiagnostics ? { validationDiagnostics } : {}),
        });
        warnings.push(messages[code]);

        if (['AI_RATE_LIMIT', 'AI_AUTH', 'AI_MODEL', 'AI_REQUEST', 'AI_NETWORK_BLOCKED', 'AI_RESOURCE_LIMIT'].includes(code)) { stopReason = code; break; }
      }
    }
    if (signal?.aborted) {
      throw analysisError('CANCELLED');
    }

    const uniqueWarnings = [...new Set(warnings)];
    const result = verifyAnalysis({ items, warnings: uniqueWarnings.slice(0, bounds.warnings) }, pages);
    for (const [index, scope] of scopes.entries()) {
      if (restoredQuotes[index]) {
        result.items[index].warnings.push('Цитатът е възстановен дословно от източника чрез съпоставяне само на интервали и нови редове. Думите и пунктуацията не са променяни.');
      }
      
      if (scope.verificationStatus !== 'verified') {
        Object.assign(result.items[index], {
          verificationStatus: 'unverified', verificationReason: scope.verificationReason,
          actorVerificationStatus: result.items[index].actor ? 'unverified' : 'unknown',
          warnings: [...new Set([...result.items[index].warnings, ...scope.warnings,
            'Цитатът не е намерен в частта, предоставена за тази AI заявка.'])],
        });
      }
    }
    Object.assign(result, compareItems(result.items));
    if (!result.potentialConflicts.length) {
      result.warnings = result.warnings.filter((warning) => warning !== 'Има потенциални противоречия. Находките са запазени отделно за преглед.');
    }
    const pageCoverage = plan.pagePlan.map((page) => {
      const processedCharacters = successfulCharacters.get(page.pageNumber) || 0;
      const status = page.empty ? 'skipped' : processedCharacters === page.totalCharacters && !partialPages.has(page.pageNumber) ? 'analyzed'
        : processedCharacters > 0 ? 'partial' : 'skipped';
      const reasons = [];
      if (partialPages.has(page.pageNumber)) reasons.push('INVALID_ANALYSIS');
      if (page.empty) reasons.push('NO_EXTRACTABLE_TEXT');
      if (!page.empty && page.plannedCharacters < page.totalCharacters) reasons.push('TEXT_BUDGET');
      if (processedCharacters < page.plannedCharacters) reasons.push(stopReason || 'CHUNK_FAILED');
      return { pageNumber: page.pageNumber, status, totalCharacters: page.totalCharacters, processedCharacters, reasons };
    });
    for (const chunk of plan.chunks.slice(chunkResults.length)) {
      chunkResults.push({ chunkId: chunk.id, status: 'skipped', reason: stopReason || 'AI_TIMEOUT' });
    }
    if (stopReason) result.warnings.push(messages[stopReason]);
    if (aiClient.mode === 'mock') result.warnings.push('Mock режим: резултатът е демонстрационен и не представлява реален AI анализ.');
    const hasProblems = pageCoverage.some((page) => page.status !== 'analyzed') ||
      documentContext.some((entry) => entry.verificationStatus !== 'verified') ||
      result.pageDiagnostics.some((page) => page.suspicious) || result.items.some((item) => item.verificationStatus !== 'verified') ||
      chunkResults.some((chunk) => chunk.status !== 'analyzed');
    const succeeded = chunkResults.some((chunk) => chunk.status === 'analyzed' || chunk.status === 'partial');
    const status = !succeeded ? 'failed' : hasProblems ? 'partial' : 'complete';
    if (status !== 'complete') result.warnings.push('Анализът е непълен. Прегледай покритието на страниците и предупрежденията.');
    const analysis = {
      ...result, warnings: [...new Set(result.warnings)],
      documentContext,
      status, mode: aiClient.mode, pageCoverage, chunks: chunkResults,
      usage: { requests, sentCharacters, acceptedItems: items.length },
    };
    return { ...analysis, insights: buildInsights(analysis, { pages }) };
  };
}

module.exports = { createAnalysisService };
