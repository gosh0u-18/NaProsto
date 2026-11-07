const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAnalysisService } = require('../src/analysis/service');
const { createMockAIClient } = require('../src/analysis/ai-client');

const quote = 'Кандидатът подава заявление до 20.11.2026 г.';
const item = (changes = {}) => ({ type: 'action', obligationLevel: 'mandatory', title: 'Подай заявление',
  explanation: 'Кандидатът подава заявление.', actor: { role: 'Кандидатът', sourceQuote: 'Кандидатът' },
  sourceQuote: quote, pageNumber: 1, deadline: null, warnings: [], ...changes });
const invalidDeadline = { kind: 'absolute', originalText: '20.11.2026', date: '2026-11-20', referenceEvent: 'приемане' };
const analyze = (items, documentContext = []) => createAnalysisService({ aiClient: createMockAIClient({
  env: { NODE_ENV: 'test' }, respond: () => ({ items, warnings: [], documentContext }),
}) })([{ pageNumber: 1, text: quote }]);

test('partial validation: invalid absolute reference event rejects only its finding', async () => {
  const result = await analyze([item(), item({ title: 'Невалиден срок', deadline: invalidDeadline })]);
  assert.equal(result.status, 'partial');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].verificationStatus, 'verified');
  assert.equal(result.items[0].actorVerificationStatus, 'verified');
  assert.equal(result.chunks[0].status, 'partial');
  assert.equal(result.chunks[0].rejectedItems, 1);
  assert.equal(result.chunks[0].validationDiagnostics.issues[0].field, '/items/1/deadline');
  assert.equal(result.pageCoverage[0].status, 'partial');
  assert.equal(result.pageCoverage[0].processedCharacters, quote.length);
  assert.ok(result.pageCoverage[0].reasons.includes('INVALID_ANALYSIS'));
  assert.equal(result.insights.nextSteps.length, 1);
  assert.equal(result.usage.acceptedItems, 1);
  assert.equal(result.usage.requests, 1);
});

test('partial validation: entirely invalid findings remain a failed analysis', async () => {
  const result = await analyze([item({ deadline: invalidDeadline })]);
  assert.equal(result.status, 'failed');
  assert.equal(result.items.length, 0);
  assert.equal(result.chunks[0].reason, 'INVALID_ANALYSIS');
});

test('partial validation: valid summary survives invalid findings without pretending tasks exist', async () => {
  const result = await analyze([item({ deadline: invalidDeadline })], [{ kind: 'keyTerm',
    text: 'Подаване на заявление.', sourceQuote: quote, pageNumber: 1 }]);
  assert.equal(result.status, 'partial');
  assert.equal(result.items.length, 0);
  assert.equal(result.documentContext[0].verificationStatus, 'verified');
  assert.equal(result.insights.documentSummary.status, 'partial');
  assert.equal(result.insights.nextSteps.length, 0);
});

test('partial validation: malformed fields still fail the whole chunk', async () => {
  const result = await analyze([item(), item({ pageNumber: 'private-invalid' })]);
  assert.equal(result.status, 'failed');
  assert.equal(result.items.length, 0);
  assert.ok(!JSON.stringify(result).includes('private-invalid'));
});

test('partial validation: invented date and unsupported deadline are not repaired', async () => {
  for (const deadline of [
    { kind: 'absolute', originalText: '20.11.2026', date: '2027-11-20', referenceEvent: null },
    { kind: 'relative', originalText: '7 дни след приемане', date: null, referenceEvent: 'приемане' },
  ]) {
    const result = await analyze([item(), item({ title: 'Отхвърли', deadline })]);
    assert.equal(result.status, 'partial');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].deadline, null);
  }
});
