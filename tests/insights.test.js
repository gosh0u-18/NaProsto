const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildInsights } = require('../src/analysis/insights');
const { createAnalysisService } = require('../src/analysis/service');
const { createMockAIClient } = require('../src/analysis/ai-client');

const item = (id, changes = {}) => ({ id, type: 'action', obligationLevel: 'mandatory',
  title: 'Подай заявление', explanation: 'Подай заявление.', sourceQuote: 'Подайте заявление.',
  verificationStatus: 'verified', pageNumber: 1, deadline: null, warnings: [], ...changes });
const analysis = (items = [], changes = {}) => ({ items, status: 'complete', warnings: [],
  pageCoverage: [{ pageNumber: 1, status: 'analyzed' }], potentialDuplicates: [], potentialConflicts: [], ...changes });
const date = (value) => ({ kind: 'absolute', date: value, originalText: value, referenceEvent: null });

test('insights: summary and key points use existing source-backed findings only', () => {
  const result = buildInsights(analysis([item('1'), item('2', { verificationStatus: 'unverified' })]));
  assert.deepEqual(result.summary.keyFindingIds, ['1']);
  assert.match(result.summary.text, /2 важни точки\. С намерен цитат: 1/);
  assert.equal(result.summary.completePages, 1);
  assert.equal(result.summary.totalPages, 1);
});

test('insights: explicit dates are sorted chronologically, then relative and missing deadlines', () => {
  const result = buildInsights(analysis([
    item('no-date'), item('later', { deadline: date('2027-11-01') }),
    item('relative', { deadline: { kind: 'relative', date: null, originalText: '7 дни от уведомяване', referenceEvent: 'уведомяване' } }),
    item('earlier', { deadline: date('2027-10-01') }),
  ]));
  assert.deepEqual(result.nextSteps.map((step) => step.findingId), ['earlier', 'later', 'relative', 'no-date']);
  assert.equal(result.nextSteps[2].reason, 'RELATIVE_DEADLINE');
});

test('insights: recommendations, information, conditions and unverified actions do not become automatic tasks', () => {
  const result = buildInsights(analysis([
    item('yes'), item('recommendation', { obligationLevel: 'recommended' }), item('information', { obligationLevel: 'informational' }),
    item('condition', { type: 'condition' }), item('unverified', { verificationStatus: 'unverified' }),
  ]));
  assert.deepEqual(result.nextSteps.map((step) => step.findingId), ['yes']);
});

test('insights: conflicting actions require review instead of an automatically chosen task', () => {
  const result = buildInsights(analysis([item('1'), item('2')], { potentialConflicts: [{ itemIds: ['1', '2'] }] }));
  assert.equal(result.nextSteps.length, 0);
  assert.equal(result.summary.keyFindingIds.length, 0);
  assert.deepEqual(result.reviewPoints.find((point) => point.code === 'POTENTIAL_CONFLICTS').findingIds, ['1', '2']);
});

test('insights: duplicate candidates are flagged without merging different findings', () => {
  const result = buildInsights(analysis([item('1'), item('2')], { potentialDuplicates: [{ itemIds: ['1', '2'] }] }));
  assert.equal(result.nextSteps.length, 2);
  assert.ok(result.reviewPoints.some((point) => point.code === 'POTENTIAL_DUPLICATES'));
});

test('insights: relative and ambiguous deadlines remain unresolved and visible for review', () => {
  const items = [item('relative', { deadline: { kind: 'relative', date: null } }), item('unclear', { deadline: { kind: 'ambiguous', date: null } })];
  const before = JSON.stringify(items);
  const result = buildInsights(analysis(items));
  assert.ok(result.reviewPoints.some((point) => point.code === 'RELATIVE_DEADLINES'));
  assert.ok(result.reviewPoints.some((point) => point.code === 'AMBIGUOUS_DEADLINES'));
  assert.equal(JSON.stringify(items), before);
});

test('insights: financial terms are detected in exact found quotes, never invented from explanations', () => {
  const result = buildInsights(analysis([
    item('fee', { sourceQuote: 'Не се дължи такса за отказ.' }),
    item('hallucinated', { explanation: 'Има огромна неустойка.', sourceQuote: 'Подайте заявление.' }),
    item('unverified', { sourceQuote: 'Дължи се неустойка.', verificationStatus: 'unverified' }),
  ]));
  const finance = result.reviewPoints.find((point) => point.code === 'FINANCIAL_TERMS');
  assert.deepEqual(finance.findingIds, ['fee']);
  assert.ok(!finance.message.includes('Дължиш'));
});

test('insights: unrelated words do not trigger a financial warning', () => {
  const result = buildInsights(analysis([item('1', { sourceQuote: 'Изучаваме таксономия и история на цензурата.' })]));
  assert.ok(!result.reviewPoints.some((point) => point.code === 'FINANCIAL_TERMS'));
});

test('insights: termination and consent clauses receive source-linked review points', () => {
  const result = buildInsights(analysis([item('1', { sourceQuote: 'Прекратяване с предизвестие.' }), item('2', { sourceQuote: 'Съгласие за обработка на лични данни.' })]));
  assert.deepEqual(result.reviewPoints.find((point) => point.code === 'TERMINATION_TERMS').findingIds, ['1']);
  assert.deepEqual(result.reviewPoints.find((point) => point.code === 'DATA_CONSENT').findingIds, ['2']);
});

test('insights: incomplete analysis and OCR limitations are not hidden by a summary', () => {
  const result = buildInsights(analysis([item('1')], { status: 'partial' }), { pages: [{ pageNumber: 1, extractionMethod: 'ocr' }] });
  assert.match(result.summary.text, /непълен/);
  assert.ok(result.reviewPoints.some((point) => point.code === 'INCOMPLETE_ANALYSIS'));
  assert.ok(result.reviewPoints.some((point) => point.code === 'OCR_SOURCE'));
});

test('insights: no findings are not presented as proof that a document has no obligations', () => {
  const complete = buildInsights(analysis());
  assert.match(complete.summary.text, /Възможно е да сме пропуснали/);
  const failed = buildInsights(analysis([], { status: 'failed' }));
  assert.match(failed.summary.text, /Няма достатъчен/);
  assert.equal(failed.nextSteps.length, 0);
});

test('insights pipeline: guidance is produced without an additional AI call', async () => {
  let calls = 0;
  const source = 'Подайте заявление.';
  const finding = { ...item('1') };
  delete finding.id;
  delete finding.verificationStatus;
  const aiClient = createMockAIClient({ env: { NODE_ENV: 'test' }, respond: () => {
    calls++;
    return { items: [finding], warnings: [] };
  } });
  const result = await createAnalysisService({ aiClient })([{ pageNumber: 1, text: source }]);
  assert.equal(calls, 1);
  assert.equal(result.insights.nextSteps.length, 1);
  assert.equal(result.insights.nextSteps[0].findingId, result.items[0].id);
});
