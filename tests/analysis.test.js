const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  candidateAnalysisSchema, structuredOutputFormat,
  validateCandidateAnalysis, parseCandidateAnalysis, validateResultShape, bounds,
} = require('../src/analysis/schema');
const { verifyAnalysis, verifySource, diagnosePage } = require('../src/analysis/source-verifier');

const quote = 'Кандидатът трябва да подаде заявление до 15 октомври 2027 г.';
const pages = [{ pageNumber: 1, text: quote }, { pageNumber: 2, text: '' }];
const item = (changes = {}) => ({
  type: 'requirement', obligationLevel: 'mandatory',
  title: 'Подаване на заявление', explanation: 'Трябва да подадеш заявление.',
  deadline: null, pageNumber: 1, sourceQuote: quote, warnings: [], ...changes,
});
const input = (...items) => ({ items, warnings: [] });
const deadline = (changes = {}) => ({
  kind: 'absolute', originalText: 'до 15 октомври 2027 г.',
  date: '2027-10-15', referenceEvent: null, ...changes,
});

test('analysis: verifies an exact quote and generates server-owned UUID and status', () => {
  const result = verifyAnalysis(input(item()), pages);
  assert.equal(result.items[0].verificationStatus, 'verified');
  assert.equal(result.items[0].verificationReason, 'QUOTE_FOUND');
  assert.match(result.items[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(validateResultShape(result), true);
});

test('analysis: rejects model-supplied IDs and verification statuses', () => {
  for (const change of [{ id: 'fake' }, { verificationStatus: 'verified' }]) {
    assert.equal(validateCandidateAnalysis(input(item(change))).valid, false);
    assert.throws(() => verifyAnalysis(input(item(change)), pages), { code: 'INVALID_ANALYSIS' });
  }
});

test('analysis: invented quote is unverified', () => {
  const result = verifyAnalysis(input(item({ sourceQuote: 'Изплатете 1000 лева.' })), pages);
  assert.equal(result.items[0].verificationStatus, 'unverified');
  assert.equal(result.items[0].verificationReason, 'QUOTE_NOT_FOUND');
});

test('analysis: a real quote on a different page is not verified', () => {
  const result = verifyAnalysis(input(item({ pageNumber: 2 })), pages);
  assert.equal(result.items[0].verificationReason, 'QUOTE_NOT_FOUND');
});

test('analysis: nonexistent page is not verified', () => {
  const result = verifyAnalysis(input(item({ pageNumber: 9 })), pages);
  assert.equal(result.items[0].verificationReason, 'PAGE_NOT_FOUND');
});

test('analysis: empty, whitespace and non-string quotes have explicit rejection reasons', () => {
  for (const sourceQuote of ['', ' \n\t']) {
    assert.equal(verifyAnalysis(input(item({ sourceQuote })), pages).items[0].verificationReason, 'EMPTY_QUOTE');
  }
  for (const sourceQuote of [null, 10, {}, []]) {
    assert.equal(verifySource(item({ sourceQuote }), pages).verificationReason, 'INVALID_QUOTE');
    assert.equal(validateCandidateAnalysis(input(item({ sourceQuote }))).valid, false);
  }
});

test('analysis: whitespace/case differences are not treated as exact source matches', () => {
  assert.equal(verifySource(item({ sourceQuote: quote.toLowerCase() }), pages).verificationStatus, 'unverified');
  assert.equal(verifySource(item({ sourceQuote: quote.replaceAll(' ', '  ') }), pages).verificationStatus, 'unverified');
});

test('analysis: nonsequential original page numbers are preserved', () => {
  const result = verifyAnalysis(input(item({ pageNumber: 7 })), [{ pageNumber: 7, text: quote }]);
  assert.equal(result.items[0].pageNumber, 7);
  assert.equal(result.items[0].verificationStatus, 'verified');
});

test('analysis: malformed JSON, arrays, missing fields and unexpected properties are rejected', () => {
  for (const value of ['{broken', null, [], {}, input(item({ type: 'other' })), input(item({ extra: 'value' }))]) {
    assert.equal(validateCandidateAnalysis(value).valid, false);
  }
});

test('analysis: serializable JSON string is accepted without mutating the input', () => {
  const original = input(item());
  const snapshot = JSON.stringify(original);
  verifyAnalysis(original, pages);
  assert.equal(JSON.stringify(original), snapshot);
  assert.equal(validateCandidateAnalysis(snapshot).valid, true);
});

test('analysis: bounds prevent oversized results and unbounded item comparisons', () => {
  assert.equal(validateCandidateAnalysis(input(...Array(bounds.items + 1).fill(item()))).valid, false);
  assert.equal(validateCandidateAnalysis(input(item({ title: 'a'.repeat(bounds.title + 1) }))).valid, false);
  assert.equal(validateCandidateAnalysis(' '.repeat(bounds.inputBytes + 1)).valid, false);
});

test('analysis: accepts explicit Bulgarian, numeric and ISO calendar dates', () => {
  for (const originalText of ['до 15 октомври 2027 г.', 'до 15.10.2027', 'до 15/10/2027', 'до 2027-10-15']) {
    const result = validateCandidateAnalysis(input(item({ sourceQuote: originalText, deadline: deadline({ originalText }) })));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  }
});

test('analysis: missing years and invented or invalid dates are rejected', () => {
  const cases = [
    ['до 15 октомври', '2027-10-15'],
    ['до 15 октомври 2027 г.', '2028-10-15'],
    ['до 31.02.2027', '2027-02-31'],
    ['до 29.02.2027', '2027-02-29'],
    ['до 15.10.2027', '15.10.2027'],
    ['до 15.10.2027', '2027-10-150'],
  ];
  for (const [originalText, date] of cases) {
    assert.equal(validateCandidateAnalysis(input(item({ sourceQuote: originalText, deadline: deadline({ originalText, date }) }))).valid, false);
  }
});

test('analysis: leap years are validated as calendar dates', () => {
  for (const [year, valid] of [[2028, true], [2000, true], [2100, false]]) {
    const originalText = `до 29.02.${year}`;
    assert.equal(validateCandidateAnalysis(input(item({ sourceQuote: originalText, deadline: deadline({ originalText, date: `${year}-02-29` }) }))).valid, valid);
  }
});

test('analysis: relative deadline keeps the original trigger and never calculates a date', () => {
  const sourceQuote = 'Подайте заявление в 7-дневен срок от уведомяването.';
  const relative = { kind: 'relative', originalText: 'в 7-дневен срок от уведомяването', date: null, referenceEvent: 'уведомяването' };
  const result = verifyAnalysis(input(item({ sourceQuote, deadline: relative })), [{ pageNumber: 1, text: sourceQuote }]);
  assert.equal(result.items[0].deadline.date, null);
  assert.equal(result.items[0].deadline.referenceEvent, 'уведомяването');
  assert.ok(result.items[0].warnings.some((warning) => warning.includes('Относителният')));
  assert.equal(validateCandidateAnalysis(input(item({ sourceQuote, deadline: { ...relative, date: '2027-10-15' } }))).valid, false);
});

test('analysis: ambiguous deadlines and missing deadlines remain unresolved', () => {
  const sourceQuote = 'Подайте документите до 15 октомври.';
  const ambiguous = { kind: 'ambiguous', originalText: 'до 15 октомври', date: null, referenceEvent: null };
  const result = verifyAnalysis(input(item({ sourceQuote, deadline: ambiguous })), [{ pageNumber: 1, text: sourceQuote }]);
  assert.equal(result.items[0].deadline.date, null);
  assert.ok(result.items[0].warnings.length > 0);
  assert.equal(verifyAnalysis(input(item()), pages).items[0].deadline, null);
});

test('analysis: fabricated deadline text and trigger events are rejected', () => {
  assert.equal(validateCandidateAnalysis(input(item({ deadline: deadline({ originalText: 'до 01.01.2028' }) }))).valid, false);
  const originalText = 'в 7-дневен срок';
  assert.equal(validateCandidateAnalysis(input(item({
    sourceQuote: originalText,
    deadline: { kind: 'relative', originalText, date: null, referenceEvent: 'подписване' },
  }))).valid, false);
});

test('analysis: multiple explicit dates cannot be silently reduced to one date', () => {
  const originalText = 'до 15.10.2027 или 20.10.2027';
  assert.equal(validateCandidateAnalysis(input(item({ sourceQuote: originalText, deadline: deadline({ originalText }) }))).valid, false);
});

test('analysis: an absolute deadline cannot hide a missing year behind a null date', () => {
  const originalText = 'до 15 октомври';
  assert.equal(validateCandidateAnalysis(input(item({
    sourceQuote: originalText, deadline: deadline({ originalText, date: null }),
  }))).valid, false);
});

test('analysis: conflicting deadlines stay as two findings and are flagged for review', () => {
  const second = 'Кандидатът трябва да подаде заявление до 20 октомври 2027 г.';
  const result = verifyAnalysis(input(
    item({ deadline: deadline() }),
    item({ pageNumber: 3, sourceQuote: second, deadline: deadline({ originalText: 'до 20 октомври 2027 г.', date: '2027-10-20' }) }),
  ), [...pages, { pageNumber: 3, text: second }]);
  assert.equal(result.items.length, 2);
  assert.equal(result.potentialDuplicates.length, 0);
  assert.equal(result.potentialConflicts.length, 1);
  assert.equal(result.potentialConflicts[0].reason, 'DIFFERENT_EXPLICIT_DEADLINES');
});

test('analysis: exact duplicates are only flagged, never merged', () => {
  const result = verifyAnalysis(input(item(), item()), pages);
  assert.equal(result.items.length, 2);
  assert.notEqual(result.items[0].id, result.items[1].id);
  assert.equal(result.potentialDuplicates.length, 1);
  assert.deepEqual(result.potentialDuplicates[0].itemIds, result.items.map((entry) => entry.id));
});

test('analysis: different conditions and relative trigger events are not marked as duplicates', () => {
  const quotes = ['Ако сте ученик, подайте заявление.', 'Ако сте студент, подайте заявление.'];
  const result = verifyAnalysis(input(...quotes.map((sourceQuote, index) => item({ sourceQuote, pageNumber: index + 1 }))),
    quotes.map((text, index) => ({ pageNumber: index + 1, text })));
  assert.equal(result.items.length, 2);
  assert.equal(result.potentialDuplicates.length, 0);
  const texts = ['в 7-дневен срок от подписването', 'в 7-дневен срок от уведомяването'];
  const relative = verifyAnalysis(input(...texts.map((sourceQuote, index) => item({
    sourceQuote, pageNumber: index + 1,
    deadline: { kind: 'relative', originalText: sourceQuote, date: null, referenceEvent: index ? 'уведомяването' : 'подписването' },
  }))), texts.map((text, index) => ({ pageNumber: index + 1, text })));
  assert.equal(relative.potentialDuplicates.length, 0);
});

test('analysis: mandatory, recommended, informational and unclear are distinct and preserved', () => {
  for (const obligationLevel of ['mandatory', 'recommended', 'informational', 'unclear']) {
    const result = verifyAnalysis(input(item({ obligationLevel })), pages);
    assert.equal(result.items[0].obligationLevel, obligationLevel);
    if (obligationLevel === 'unclear') assert.ok(result.items[0].warnings.length > 0);
  }
  assert.equal(validateCandidateAnalysis(input(item({ obligationLevel: 'optional' }))).valid, false);
});

test('analysis: obligation/recommendation disagreement is flagged, not merged or automatically resolved', () => {
  const result = verifyAnalysis(input(item(), item({ obligationLevel: 'recommended' })), pages);
  assert.equal(result.potentialDuplicates.length, 0);
  assert.equal(result.potentialConflicts[0].reason, 'DIFFERENT_OBLIGATION_LEVELS');
  assert.equal(result.items[1].obligationLevel, 'recommended');
});

test('analysis: suspicious numeric-only extraction is warned about even when a quote is found', () => {
  const text = '18 - I. 2025/2026, 4.1., 4.2.';
  const result = verifyAnalysis(input(item({ sourceQuote: '2025/2026' })), [{ pageNumber: 1, text }]);
  assert.equal(result.items[0].verificationStatus, 'verified');
  assert.equal(result.pageDiagnostics[0].suspicious, true);
  assert.ok(result.items[0].warnings.some((warning) => warning.includes('непълен')));
  assert.ok(result.warnings.length > 0);
});

test('analysis: empty pages and unreadable Unicode have separate diagnostics', () => {
  assert.deepEqual(diagnosePage({ pageNumber: 1, text: '' }).reasons, ['NO_EXTRACTABLE_TEXT']);
  assert.ok(diagnosePage({ pageNumber: 1, text: 'Текст \uFFFD \uE000' }).reasons.includes('UNREADABLE_CHARACTERS'));
});

test('analysis: English text is not suspicious merely because it has no Cyrillic', () => {
  assert.equal(diagnosePage({ pageNumber: 1, text: 'The application must be submitted by the candidate.' }).suspicious, false);
});

test('analysis: verified describes source presence, not correctness of interpretation', () => {
  const result = verifyAnalysis(input(item({ explanation: 'Това тълкуване може да е грешно.' })), pages);
  assert.equal(result.items[0].verificationStatus, 'verified');
  assert.equal(result.items[0].explanation, 'Това тълкуване може да е грешно.');
});

test('analysis: duplicate page numbers and oversized source text are rejected', () => {
  assert.throws(() => verifyAnalysis(input(), [pages[0], pages[0]]), { code: 'INVALID_SOURCE_PAGES' });
  assert.throws(() => verifyAnalysis(input(), [{ pageNumber: 1, text: 'a'.repeat(100_001) }]), { code: 'INVALID_SOURCE_PAGES' });
});

test('analysis: schema uses the documented conservative Structured Outputs subset', () => {
  const allowed = new Set(['type', 'additionalProperties', 'required', 'properties', 'items', 'anyOf', 'enum']);
  function inspect(schema) {
    for (const key of Object.keys(schema)) assert.ok(allowed.has(key), key);
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
      for (const property of Object.values(schema.properties)) inspect(property);
    }
    if (schema.items) inspect(schema.items);
    if (schema.anyOf) schema.anyOf.forEach(inspect);
  }
  assert.equal(candidateAnalysisSchema.type, 'object');
  assert.equal(structuredOutputFormat.strict, true);
  inspect(candidateAnalysisSchema);
  assert.ok(!('id' in candidateAnalysisSchema.properties.items.items.properties));
  assert.ok(!('verificationStatus' in candidateAnalysisSchema.properties.items.items.properties));
  assert.throws(() => parseCandidateAnalysis('{'), { code: 'INVALID_ANALYSIS' });
});
