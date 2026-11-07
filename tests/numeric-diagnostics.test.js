const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diagnosePage } = require('../src/analysis/source-verifier');
const { validateCandidateAnalysis } = require('../src/analysis/schema');
const { createAnalysisService } = require('../src/analysis/service');
const { createMockAIClient } = require('../src/analysis/ai-client');

test('numeric diagnostics: simulated scan values are suspicious even with readable prose', () => {
  for (const text of ['Документите трябва да постъпят до I8.11.202б г.',
    'Срокът е 17:O0 ч., българско време.', 'Сумата по фактурата е 8 OOO,OO евро с ДДС.']) {
    const result = diagnosePage({ pageNumber: 1, text });
    assert.equal(result.suspicious, true);
    assert.ok(result.reasons.includes('SUSPICIOUS_NUMERIC_TEXT'));
  }
});

test('numeric diagnostics: normal dates, amounts, names and identifiers are not flagged', () => {
  const result = diagnosePage({ pageNumber: 1, text: 'До 20.11.2026 г., 17:00 ч. Сума 8 000,00 евро. ЛИРА О52. Борис. priem@example.com. До 10 MB на файл.' });
  assert.equal(result.suspicious, false);
});

test('numeric diagnostics: ambiguous source is accepted but a guessed repaired date is rejected', () => {
  const item = { type: 'deadline', obligationLevel: 'mandatory', title: 'Срок', explanation: 'Свери срока с изображението.',
    actor: null, sourceQuote: 'Документите трябва да постъпят до I8.11.202б г.', pageNumber: 1,
    deadline: { kind: 'ambiguous', originalText: 'I8.11.202б', date: null, referenceEvent: null }, warnings: [] };
  assert.equal(validateCandidateAnalysis({ items: [item], warnings: [] }).valid, true);
  const changed = { ...item, deadline: { ...item.deadline, kind: 'absolute', date: '2026-11-18' } };
  assert.equal(validateCandidateAnalysis({ items: [changed], warnings: [] }).valid, false);
});

test('numeric diagnostics: source-backed mock analysis of suspicious text remains partial', async () => {
  const text = 'Сумата по фактурата е 8 OOO,OO евро с ДДС.';
  const aiClient = createMockAIClient({ env: { NODE_ENV: 'test' }, respond: () => ({ items: [], warnings: [],
    documentContext: [{ kind: 'keyTerm', text: 'Сумата изисква сверяване.', sourceQuote: text, pageNumber: 1 }] }) });
  const result = await createAnalysisService({ aiClient })([{ pageNumber: 1, text }]);
  assert.equal(result.status, 'partial');
  assert.equal(result.insights.documentSummary.status, 'partial');
  assert.equal(result.documentContext[0].sourceQuote, text);
  assert.ok(result.documentContext[0].warnings.length);
});
