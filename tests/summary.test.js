const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAnalysisService } = require('../src/analysis/service');
const { createMockAIClient } = require('../src/analysis/ai-client');
const { validateCandidateAnalysis } = require('../src/analysis/schema');
const { buildDocumentSummary } = require('../src/analysis/summary');
const text = 'Договор за обучение. Курсистът заплаща такса. Целта е професионално обучение.';
const fact = (changes = {}) => ({ kind: 'documentType', text: 'Договор за обучение.',
  pageNumber: 1, sourceQuote: 'Договор за обучение.', ...changes });
const candidate = (documentContext) => ({ items: [], warnings: [], documentContext });
const client = (respond) => createMockAIClient({ env: { NODE_ENV: 'test' }, respond });

test('summary: context is verified and returned within one existing mock request', async () => {
  let calls = 0;
  const analyze = createAnalysisService({ aiClient: client(() => {
    calls++;
    return candidate([fact(), fact({ kind: 'purpose', text: 'Професионално обучение.', sourceQuote: 'Целта е професионално обучение.' }),
      fact({ kind: 'party', text: 'Курсист', sourceQuote: 'Курсистът заплаща такса.' })]);
  }) });
  const result = await analyze([{ pageNumber: 1, text }]);
  assert.equal(calls, 1);
  assert.equal(result.insights.documentSummary.status, 'available');
  assert.equal(result.insights.documentSummary.facts.length, 3);
  assert.deepEqual(result.insights.documentSummary.missingKinds, ['keyTerm']);
  assert.match(result.documentContext[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(result.documentContext[0].verificationStatus, 'verified');
});

test('summary: invented quotes and wrong pages are excluded and mark a partial result', async () => {
  const analyze = createAnalysisService({ aiClient: client(() => candidate([fact(),
    fact({ kind: 'purpose', sourceQuote: 'Безплатно обучение.' }), fact({ kind: 'party', pageNumber: 9 })])) });
  const result = await analyze([{ pageNumber: 1, text }]);
  assert.equal(result.status, 'partial');
  assert.equal(result.insights.documentSummary.status, 'partial');
  assert.equal(result.insights.documentSummary.facts.length, 1);
  assert.equal(result.insights.documentSummary.rejectedCount, 2);
});

test('summary: context outside the model fragment cannot be verified against the full document', async () => {
  let calls = 0;
  const analyze = createAnalysisService({ options: { chunkCharacters: 20 }, aiClient: client(() =>
    candidate(++calls === 1 ? [fact({ pageNumber: 2 })] : [])) });
  const result = await analyze([{ pageNumber: 1, text: 'Първа страница.' }, { pageNumber: 2, text: 'Договор за обучение.' }]);
  assert.equal(result.documentContext[0].verificationStatus, 'unverified');
  assert.equal(result.insights.documentSummary.facts.length, 0);
});

test('summary: empty and legacy responses do not invent document type or purpose', async () => {
  const analyze = createAnalysisService({ aiClient: client(() => ({ items: [], warnings: [] })) });
  const result = await analyze([{ pageNumber: 1, text }]);
  assert.equal(result.insights.documentSummary.status, 'unavailable');
  assert.deepEqual(result.insights.documentSummary.facts, []);
  assert.equal(result.insights.documentSummary.missingKinds.length, 4);
});

test('summary: bounds, enum, source and server-owned fields are validated', () => {
  for (const entries of [Array.from({ length: 13 }, () => fact()), [fact({ text: 'x'.repeat(501) })],
    [fact({ sourceQuote: '' })], [fact({ sourceQuote: 'x'.repeat(1001) })], [fact({ pageNumber: 0 })],
    [fact({ kind: 'invented' })], [fact({ verificationStatus: 'verified' })]]) {
    assert.equal(validateCandidateAnalysis(candidate(entries)).valid, false);
  }
});

test('summary: exact duplicates removed, alternative conditions and contradictory texts retained', () => {
  const first = { ...fact({ kind: 'keyTerm' }), verificationStatus: 'verified' };
  const second = { ...first, text: 'Друга уговорка.', sourceQuote: 'Друга уговорка.' };
  const result = buildDocumentSummary({ status: 'partial', documentContext: [first, { ...first }, second] });
  assert.equal(result.facts.length, 2);
  assert.equal(result.status, 'partial');
});
