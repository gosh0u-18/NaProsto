const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyAnalysis } = require('../src/analysis/source-verifier');
const { validateCandidateAnalysis, candidateAnalysisSchema } = require('../src/analysis/schema');
const { buildInsights } = require('../src/analysis/insights');
const { canonicalRole } = require('../src/analysis/actors');

const quote = 'Кандидатът подава заявление. Изпълнителят изпраща потвърждение.';
const pages = [{ pageNumber: 1, text: quote }];
const item = (changes = {}) => ({ type: 'action', obligationLevel: 'mandatory', title: 'Подаване',
  explanation: 'Подаване на заявление.', sourceQuote: 'Кандидатът подава заявление.', pageNumber: 1,
  actor: { role: 'Кандидатът', sourceQuote: 'Кандидатът' }, deadline: null, warnings: [], ...changes });
const input = (...items) => ({ items, warnings: [] });

test('actors: arbitrary new single-word and multi-word roles need no dictionary', () => {
  for (const role of ['Наемателят', 'Приемателна комисия', 'Ръководител на проекта', 'Страна (А)']) {
    const sourceQuote = `${role} представя документите.`;
    const result = verifyAnalysis(input(item({ sourceQuote, actor: { role, sourceQuote: role } })), [{ pageNumber: 1, text: sourceQuote }]);
    assert.equal(result.items[0].actorVerificationStatus, 'verified');
    assert.equal(buildInsights({ ...result, status: 'complete' }).roles.length, 1);
  }
});

test('actors: partial words and inferred grammatical forms are not literal roles', () => {
  for (const [role, evidence] of [['Наемател', 'Наемателят'], ['Комисия', 'Подкомисия'], ['Работна група', 'Работна групата']]) {
    const sourceQuote = `${evidence} представя документите.`;
    const result = verifyAnalysis(input(item({ sourceQuote, actor: { role, sourceQuote: evidence } })), [{ pageNumber: 1, text: sourceQuote }]);
    assert.equal(result.items[0].actorVerificationStatus, 'unverified');
  }
  assert.notEqual(canonicalRole('Наемател'), canonicalRole('Наемателят'));
});

test('actors: evidence and role are checked on the original page inside the finding quote', () => {
  const result = verifyAnalysis(input(item()), pages);
  assert.equal(result.items[0].actorVerificationStatus, 'verified');
  const insights = buildInsights({ ...result, status: 'complete' });
  assert.equal(insights.roles[0].label, 'Кандидатът');
  assert.deepEqual(insights.roles[0].findingIds, [result.items[0].id]);
  assert.deepEqual(insights.unassignedFindingIds, []);
});

test('actors: another party mentioned elsewhere on the page cannot supply evidence', () => {
  const result = verifyAnalysis(input(item({ actor: { role: 'Изпълнителят', sourceQuote: 'Изпълнителят' } })), pages);
  assert.equal(result.items[0].verificationStatus, 'verified');
  assert.equal(result.items[0].actorVerificationStatus, 'unverified');
  const insights = buildInsights({ ...result, status: 'complete' });
  assert.deepEqual(insights.roles, []);
  assert.deepEqual(insights.unassignedFindingIds, [result.items[0].id]);
});

test('actors: invented role, invented quote and wrong page never become verified', () => {
  for (const change of [
    { actor: { role: 'Работодател', sourceQuote: 'Кандидатът' } },
    { sourceQuote: 'Кандидатът плаща такса.' }, { pageNumber: 2 },
  ]) assert.equal(verifyAnalysis(input(item(change)), pages).items[0].actorVerificationStatus, 'unverified');
});

test('actors: absent legacy and explicit null actors remain unknown', () => {
  const legacy = item(); delete legacy.actor;
  for (const value of [legacy, item({ actor: null })]) {
    const result = verifyAnalysis(input(value), pages);
    assert.equal(result.items[0].actor, null);
    assert.equal(result.items[0].actorVerificationStatus, 'unknown');
    assert.equal(buildInsights({ ...result, status: 'complete' }).roles.length, 0);
  }
  assert.ok(candidateAnalysisSchema.properties.items.items.required.includes('actor'));
});

test('actors: malformed, oversized or model-owned verification fields are rejected', () => {
  for (const change of [{ actor: 'Кандидат' }, { actor: {} },
    { actor: { role: '', sourceQuote: 'Кандидатът' } },
    { actor: { role: 'a'.repeat(121), sourceQuote: 'x' } },
    { actor: { role: 'Кандидатът', sourceQuote: 'x'.repeat(601) } },
    { actorVerificationStatus: 'verified' }]) {
    assert.equal(validateCandidateAnalysis(input(item(change))).valid, false);
  }
});

test('actors: typography variants group together without merging different parties', () => {
  assert.equal(canonicalRole('  КАНДИДАТЪТ  '), canonicalRole('кандидатът'));
  assert.notEqual(canonicalRole('Кандидат'), canonicalRole('Изпълнител'));
  const result = verifyAnalysis(input(item(), item({ actor: { role: 'Кандидатът', sourceQuote: 'Кандидатът' } }),
    item({ sourceQuote: 'Изпълнителят изпраща потвърждение.', actor: { role: 'Изпълнителят', sourceQuote: 'Изпълнителят' } })), pages);
  const insights = buildInsights({ ...result, status: 'complete' });
  assert.equal(insights.roles.length, 2);
  assert.equal(insights.roles[0].findingIds.length, 2);
});

test('actors: different parties with different deadlines are not automatically conflicting', () => {
  const clauses = ['Кандидатът подава до 01.11.2027.', 'Изпълнителят подава до 02.11.2027.'];
  const values = clauses.map((sourceQuote, index) => item({ sourceQuote,
    actor: { role: index ? 'Изпълнителят' : 'Кандидатът', sourceQuote: index ? 'Изпълнителят' : 'Кандидатът' },
    deadline: { kind: 'absolute', originalText: index ? '02.11.2027' : '01.11.2027', date: index ? '2027-11-02' : '2027-11-01', referenceEvent: null } }));
  const result = verifyAnalysis(input(...values), [{ pageNumber: 1, text: clauses.join(' ') }]);
  assert.equal(result.potentialConflicts.length, 0);
  assert.equal(result.potentialDuplicates.length, 0);
});
