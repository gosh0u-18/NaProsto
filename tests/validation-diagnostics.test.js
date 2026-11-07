const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCandidateAnalysis, getValidationDiagnostics } = require('../src/analysis/schema');
const { createAnalysisService } = require('../src/analysis/service');
const { createMockAIClient } = require('../src/analysis/ai-client');
const pages = [{ pageNumber: 1, text: 'Подайте заявление до 20.11.2026.' }];
const item = () => ({ type: 'action', obligationLevel: 'mandatory', title: 'Подаване', explanation: 'Подай заявление.',
  actor: null, deadline: null, sourceQuote: pages[0].text, pageNumber: 1, warnings: [] });
const analyzeWith = (respond) => createAnalysisService({ aiClient: createMockAIClient({ env: { NODE_ENV: 'test' }, respond }) })(pages);

test('validation diagnostics: invalid deadline identifies the rule without source or model values', async () => {
  const value = item();
  value.deadline = { kind: 'absolute', originalText: '20.11.2026', date: '2027-11-20', referenceEvent: null };
  const result = await analyzeWith(() => ({ items: [value], warnings: [] }));
  assert.equal(result.status, 'failed');
  const chunk = result.chunks[0];
  assert.equal(chunk.reason, 'INVALID_ANALYSIS');
  assert.equal(chunk.validationDiagnostics.issues[0].field, '/items/0/deadline');
  assert.match(chunk.validationDiagnostics.issues[0].message, /Датата трябва/);
  assert.ok(!JSON.stringify(chunk.validationDiagnostics).includes('2027-11-20'));
  assert.ok(!JSON.stringify(chunk.validationDiagnostics).includes(pages[0].text));
});

test('validation diagnostics: missing known field and wrong type have useful codes', () => {
  for (const [modify, field, code] of [
    [(value) => { delete value.title; }, '/items/0/title', 'required'],
    [(value) => { value.pageNumber = 'private-invalid-value'; }, '/items/0/pageNumber', 'type'],
  ]) {
    const value = item(); modify(value);
    assert.throws(() => parseCandidateAnalysis({ items: [value], warnings: [] }), (error) => {
      const issue = getValidationDiagnostics(error).issues[0];
      assert.equal(issue.field, field); assert.equal(issue.code, code); return true;
    });
  }
});

test('validation diagnostics: hostile keys and content never leak through schema paths', async () => {
  const secret = 'secret-document-content-KEY';
  const value = item(); value.actor = { role: 'Кандидат', sourceQuote: 'Кандидат', [secret]: secret };
  const result = await analyzeWith(() => ({ items: [value], warnings: [], [secret]: secret }));
  const diagnostics = result.chunks[0].validationDiagnostics;
  assert.ok(diagnostics.issues.length);
  assert.ok(!JSON.stringify(diagnostics).includes(secret));
});

test('validation diagnostics: malformed JSON is safe and issue count is bounded', async () => {
  const malformed = await analyzeWith(() => 'private malformed model text');
  assert.equal(malformed.chunks[0].validationDiagnostics.issues[0].field, '/');
  assert.ok(!JSON.stringify(malformed).includes('private malformed'));
  const result = await analyzeWith(() => ({ items: Array.from({ length: 30 }, () => ({})), warnings: [] }));
  assert.equal(result.chunks[0].validationDiagnostics.issues.length, 10);
  assert.equal(result.chunks[0].validationDiagnostics.truncated, true);
});

test('validation diagnostics: provider-injected issues are not trusted or exposed', async () => {
  const result = await analyzeWith(() => { throw Object.assign(new Error('private provider error'), {
    code: 'INVALID_ANALYSIS', issues: [{ path: '/private', message: 'secret API key' }],
    validationDiagnostics: { issues: [{ field: '/', message: 'secret' }] },
  }); });
  assert.equal(result.chunks[0].reason, 'INVALID_ANALYSIS');
  assert.equal(result.chunks[0].validationDiagnostics, undefined);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('validation diagnostics: valid analysis remains unchanged without diagnostic errors', async () => {
  const result = await analyzeWith(() => ({ items: [item()], warnings: [] }));
  assert.equal(result.status, 'complete');
  assert.equal(result.chunks[0].validationDiagnostics, undefined);
});
