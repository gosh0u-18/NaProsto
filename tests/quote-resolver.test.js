const { test } = require('node:test');
const assert = require('node:assert/strict');
const { restoreCandidateQuotes } = require('../src/analysis/quote-resolver');
const { verifySource } = require('../src/analysis/source-verifier');
const { createAnalysisService } = require('../src/analysis/service');
const { createMockAIClient } = require('../src/analysis/ai-client');
const { chunkDocument } = require('../src/analysis/chunker');
const { analysisLimits } = require('../src/analysis/controls');

const item = (sourceQuote, changes = {}) => ({
  type: 'requirement', obligationLevel: 'mandatory', title: 'Подай заявление', explanation: 'Подай заявление.',
  pageNumber: 1, sourceQuote, deadline: null, warnings: [], ...changes,
});
const input = (value) => ({ items: [value], warnings: [] });

test('quote resolver: pipeline restores deadline whitespace before final strict validation', async () => {
  const sourceQuote = 'Подайте заявление до 15\n октомври 2027 г.';
  const value = item(sourceQuote, { deadline: { kind: 'absolute', originalText: '15 октомври 2027 г.', date: '2027-10-15', referenceEvent: null } });
  const aiClient = createMockAIClient({ env: { NODE_ENV: 'test' }, respond: () => input(value) });
  const result = await createAnalysisService({ aiClient })([{ pageNumber: 1, text: sourceQuote }]);
  assert.equal(result.status, 'complete');
  assert.equal(result.items[0].deadline.originalText, '15\n октомври 2027 г.');
  assert.equal(result.items[0].verificationStatus, 'verified');
});

test('quote resolver: independently changed quote and deadline whitespace are restored together', async () => {
  const sourceQuote = 'Подайте\n заявление до 15\n октомври 2027 г.';
  const value = item('Подайте заявление до 15 октомври 2027 г.', { deadline: {
    kind: 'absolute', originalText: '15  октомври 2027 г.', date: '2027-10-15', referenceEvent: null,
  } });
  const aiClient = createMockAIClient({ env: { NODE_ENV: 'test' }, respond: () => input(value) });
  const result = await createAnalysisService({ aiClient })([{ pageNumber: 1, text: sourceQuote }]);
  assert.equal(result.status, 'complete');
  assert.equal(result.items[0].sourceQuote, sourceQuote);
});

test('quote resolver: missing deadline, changed words and invented dates remain invalid', async () => {
  for (const change of [
    { quote: 'Подайте заявление.', originalText: '15 октомври 2027 г.', date: '2027-10-15' },
    { quote: 'Подайте заявление до 15 октомври 2027 г.', originalText: '16 октомври 2027 г.', date: '2027-10-16' },
    { quote: 'Подайте заявление до 15 октомври 2027 г.', originalText: '15 октомври 2027 г.', date: '2028-10-15' },
  ]) {
    const value = item(change.quote, { deadline: { kind: 'absolute', originalText: change.originalText, date: change.date, referenceEvent: null } });
    const aiClient = createMockAIClient({ env: { NODE_ENV: 'test' }, respond: () => input(value) });
    const result = await createAnalysisService({ aiClient })([{ pageNumber: 1, text: change.quote }]);
    assert.equal(result.status, 'failed');
    assert.equal(result.chunks[0].reason, 'INVALID_ANALYSIS');
  }
});

test('quote resolver: restores only original whitespace and returns a literal source substring', () => {
  const pages = [{ pageNumber: 1, text: 'Увод. Подайте\n  заявление\u00a0до 15 октомври 2027 г. Край.' }];
  const result = restoreCandidateQuotes(input(item('Подайте заявление до 15 октомври 2027 г.')), pages);
  assert.equal(result.restored[0], true);
  assert.equal(result.candidate.items[0].sourceQuote, 'Подайте\n  заявление\u00a0до 15 октомври 2027 г.');
  assert.equal(verifySource(result.candidate.items[0], pages).verificationStatus, 'verified');
});

test('quote resolver: paraphrases, punctuation, changed dates and different case remain unverified', () => {
  const pages = [{ pageNumber: 1, text: 'Подайте\nзаявление до 15 октомври 2027 г.' }];
  for (const quote of ['Изпратете заявление до 15 октомври 2027 г.', 'Подайте заявление до 16 октомври 2027 г.',
    'подайте заявление до 15 октомври 2027 г.', 'Подайте заявление, до 15 октомври 2027 г.']) {
    const result = restoreCandidateQuotes(input(item(quote)), pages);
    assert.equal(result.restored[0], false);
    assert.equal(verifySource(result.candidate.items[0], pages).verificationStatus, 'unverified');
  }
});

test('quote resolver: it never borrows evidence from another page', () => {
  const pages = [{ pageNumber: 2, text: 'Подайте\nзаявление.' }];
  const result = restoreCandidateQuotes(input(item('Подайте заявление.')), pages);
  assert.equal(result.restored[0], false);
  assert.equal(verifySource(result.candidate.items[0], pages).verificationReason, 'PAGE_NOT_FOUND');
});

test('quote resolver: empty and exact quotes are left unchanged', () => {
  const pages = [{ pageNumber: 1, text: 'Подайте заявление.' }];
  for (const quote of ['', 'Подайте заявление.']) {
    const result = restoreCandidateQuotes(input(item(quote)), pages);
    assert.equal(result.restored[0], false);
    assert.equal(result.candidate.items[0].sourceQuote, quote);
  }
});

test('quote resolver: deadline evidence is restored without changing the calendar date', () => {
  const quote = 'Подайте заявление до 15 октомври 2027 г.';
  const pages = [{ pageNumber: 1, text: 'Подайте заявление до 15\n октомври 2027 г.' }];
  const result = restoreCandidateQuotes(input(item(quote, { deadline: {
    kind: 'absolute', originalText: 'до 15 октомври 2027 г.', date: '2027-10-15', referenceEvent: null,
  } })), pages);
  assert.equal(result.restored[0], true);
  assert.equal(result.candidate.items[0].deadline.date, '2027-10-15');
  assert.equal(result.candidate.items[0].deadline.originalText, 'до 15\n октомври 2027 г.');
});

test('quote resolver: normalization cannot bypass validation of an invented deadline', () => {
  const pages = [{ pageNumber: 1, text: 'Подайте заявление до 15\n октомври 2027 г.' }];
  const original = item('Подайте заявление до 15 октомври 2027 г.', { deadline: {
    kind: 'absolute', originalText: 'до 15 октомври 2027 г.', date: '2028-10-15', referenceEvent: null,
  } });
  const result = restoreCandidateQuotes(input(original), pages);
  assert.equal(result.restored[0], false);
  assert.equal(result.candidate.items[0], original);
});

test('pipeline: restored whitespace is visible and the final quote exists exactly in the source', async () => {
  const pages = [{ pageNumber: 1, text: 'Подайте\n  заявление.' }];
  const aiClient = createMockAIClient({ env: { NODE_ENV: 'test' }, respond: () => input(item('Подайте заявление.')) });
  const result = await createAnalysisService({ aiClient })(pages);
  assert.equal(result.items[0].verificationStatus, 'verified');
  assert.ok(pages[0].text.includes(result.items[0].sourceQuote));
  assert.ok(result.items[0].warnings.some((warning) => warning.includes('възстановен дословно')));
});

test('chunker: page preference keeps the two reported page sizes intact in separate chunks', () => {
  const pages = [{ pageNumber: 1, text: 'а'.repeat(2413) }, { pageNumber: 2, text: 'б'.repeat(2455) }];
  const result = chunkDocument(pages, { preferPageBoundaries: true });
  assert.equal(result.chunks.length, 2);
  assert.deepEqual(result.chunks.map((chunk) => chunk.pages.map((page) => [page.pageNumber, page.text.length])), [[[1, 2413]], [[2, 2455]]]);
  assert.equal(result.totalCharacters, 4868);
});

test('chunker: preferring pages retains request and text budget limits', () => {
  const result = chunkDocument(Array.from({ length: 10 }, (_, index) => ({ pageNumber: index + 1, text: 'а'.repeat(2500) })), { preferPageBoundaries: true });
  assert.ok(result.chunks.length <= analysisLimits.maxChunks);
  assert.ok(result.totalCharacters <= analysisLimits.maxCharacters);
});

test('AI budgets: approved 30 second calls and 60 second analysis remain bounded', () => {
  assert.equal(analysisLimits.aiTimeoutMs, 30000);
  assert.equal(analysisLimits.totalMs, 60000);
  assert.equal(require('../src/limits').requestMs, 90000);
});
