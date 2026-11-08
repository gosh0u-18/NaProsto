const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildInsights } = require('../src/analysis/insights');

class Element {
  constructor() {
    this.textContent = ''; this.children = []; this.events = {}; this.checked = false;
    this.classList = { toggle() {} };
  }
  set innerHTML(value) { throw new Error('Unsafe HTML'); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, handler) { this.events[name] = handler; }
  click() { return this.events.click?.(); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function setup(fetchImpl, file = new File(['original bytes'], 'original.pdf')) {
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const document = { querySelector: (selector) => $(selector.slice(1)), createElement: () => new Element(), getElementById: (id) => nodes.get(id) };
  const window = { document, printCalls: 0, print() { this.printCalls++; }, events: {}, addEventListener(name, handler) { this.events[name] = handler; } };
  const context = vm.createContext({ window, document, fetch: fetchImpl, FormData, Blob, AbortController, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/analysis.js'), 'utf8'), context);
  const ui = window.DocumentAnalysisUI.create({ getFile: () => file, onBusy() {} });
  return { $, ui, window };
}
const item = (changes = {}) => ({ id: '1', type: 'action', obligationLevel: 'mandatory', title: 'Подай заявление',
  actor: { role: 'Кандидат', sourceQuote: 'Кандидатът' }, actorVerificationStatus: 'verified',
  explanation: 'Подай заявление.', sourceQuote: 'Подайте заявление.', pageNumber: 1, verificationStatus: 'verified', deadline: null, warnings: [], ...changes });
const result = (items = [item()], changes = {}) => { const analysis = {
  status: 'complete', mode: 'openai', items, warnings: [], potentialDuplicates: [], potentialConflicts: [],
  pageCoverage: [{ pageNumber: 1, status: 'analyzed', processedCharacters: 100, totalCharacters: 100 }], ...changes,
}; analysis.insights = { ...buildInsights(analysis), ...analysis.insights }; return { documentName: 'test.pdf', analysis }; };
const chooseRole = ($, index = 1) => { $('user-role').value = $('user-role').children[index].value; $('user-role').events.change(); };
const capabilities = () => ({ ok: true, json: async () => ({ analysis: { enabled: true, mode: 'openai' } }) });

function allText(node) {
  return [node.textContent, ...node.children.map(allText)].join(' ');
}

test('print: selection dialog does not immediately print; empty selection is rejected and cancel works', async () => {
  const { $, ui, window } = setup(async () => capabilities());
  await ui.ready; ui.render(result());
  $('print-analysis').click();
  assert.equal($('print-options').open, true);
  assert.equal(window.printCalls, 0);
  $('confirm-print').click();
  assert.equal(window.printCalls, 0);
  assert.match($('print-options-status').textContent, /Избери поне/);
  $('cancel-print').click();
  assert.equal($('print-options').open, false);
});

test('print: personal tasks use current role and completion, with no other party tasks or summary', async () => {
  const { $, ui, window } = setup(async () => capabilities());
  await ui.ready;
  ui.render(result([item({ title: 'Моя задача' }), item({ id: '2', title: 'Чужда задача', actor: { role: 'Изпълнител', sourceQuote: 'Изпълнителят' } })]));
  chooseRole($);
  const checkbox = $('analysis-tasks').children[0].children[0];
  checkbox.checked = true; checkbox.events.change();
  $('print-tasks-option').checked = true;
  $('confirm-print').click();
  const text = allText($('print-report'));
  assert.match(text, /☑ Моя задача/);
  assert.ok(!text.includes('Чужда задача'));
  assert.ok(!text.includes('Обобщение'));
  assert.equal(window.printCalls, 1);
  assert.equal($('print-report').hidden, false);
  window.events.afterprint();
  assert.equal($('print-report').hidden, true);
});

test('print: partial warnings survive every selection and quotes stay literal', async () => {
  const { $, ui } = setup(async () => capabilities());
  await ui.ready;
  ui.render(result([item({ sourceQuote: '<script>literal quote</script>', verificationStatus: 'unverified' })],
    { status: 'partial', warnings: ['Провери срока.'], pageCoverage: [{ pageNumber: 2, status: 'skipped' }] }));
  $('print-quotes-option').checked = true;
  $('confirm-print').click();
  const text = allText($('print-report'));
  assert.match(text, /анализът не е пълен/);
  assert.match(text, /Провери срока/);
  assert.match(text, /Страница 2: Пропусната/);
  assert.match(text, /<script>literal quote<\/script>/);
  assert.match(text, /цитатът не е потвърден/);
});

test('print: missing role prints an explanation instead of assigning general tasks', async () => {
  const { $, ui } = setup(async () => capabilities());
  await ui.ready; ui.render(result());
  $('print-tasks-option').checked = true;
  $('print-summary-option').checked = true;
  $('confirm-print').click();
  const text = allText($('print-report'));
  assert.match(text, /Не е избрана роля/);
  assert.match(text, /Обобщение/);
  ui.reset();
  assert.equal($('print-report').hidden, true);
});

test('analysis UI: retry appears for failed analysis and sends the original document again', async () => {
  let calls = 0;
  const { $, ui } = setup(async (url, options) => {
    if (url === '/api/capabilities') return capabilities();
    calls++;
    assert.equal(await options.body.get('document').text(), 'original bytes');
    return { ok: true, json: async () => result() };
  });
  await ui.ready;
  ui.render(result([], { status: 'failed' }));
  assert.equal($('analysis-retry').hidden, false);
  assert.equal($('retry-analysis').disabled, true);
  await $('retry-analysis').click();
  assert.equal(calls, 0);
  $('analysis-consent').checked = true;
  $('analysis-consent').events.change();
  assert.equal($('retry-analysis').disabled, false);
  await $('retry-analysis').click();
  assert.equal(calls, 1);
  assert.equal($('analysis-retry').hidden, true);
});

test('analysis UI: retry visibility follows status and is disabled during other processing', async () => {
  const { $, ui } = setup(async () => capabilities());
  await ui.ready;
  ui.render(result([], { status: 'partial' }));
  assert.equal($('analysis-retry').hidden, false);
  $('analysis-consent').checked = true;
  $('analysis-consent').events.change();
  ui.setExternalBusy(true);
  assert.equal($('retry-analysis').disabled, true);
  ui.setExternalBusy(false);
  assert.equal($('retry-analysis').disabled, false);
  ui.render(result([], { status: 'complete' }));
  assert.equal($('analysis-retry').hidden, true);
  ui.render(result([], { status: 'failed' }));
  ui.reset();
  assert.equal($('analysis-retry').hidden, true);
});

test('analysis UI: server configuration controls availability without exposing a key', async () => {
  const { $, ui } = setup(async () => ({ ok: true, json: async () => ({ analysis: { enabled: false, mode: 'disabled' } }) }));
  await ui.ready;
  $('analysis-consent').checked = true;
  $('analysis-consent').events.change();
  assert.equal($('analyze-document').disabled, true);
  assert.match($('analysis-availability').textContent, /не е настроен/);
});

test('analysis UI: Gemini availability, consent and results name Google instead of OpenAI', async () => {
  const { $, ui } = setup(async () => ({ ok: true, json: async () => ({ analysis: { enabled: true, mode: 'gemini' } }) }));
  await ui.ready;
  assert.match($('analysis-consent-label').textContent, /Google Gemini/);
  assert.ok(!$('analysis-consent-label').textContent.includes('OpenAI'));
  assert.match($('analysis-availability').textContent, /Google Gemini/);
  ui.render(result([], { mode: 'gemini' }));
  assert.match($('analysis-summary').textContent, /Google Gemini/);
});

test('analysis UI: overview renders source-linked insights and follows the backend task order', async () => {
  const { $, ui } = setup(async () => capabilities());
  await ui.ready;
  ui.render(result([item({ id: 'later', title: 'По-късна задача' }), item({ id: 'earlier', title: 'По-ранна задача' })], {
    insights: { summary: { text: 'Кратко обобщение', keyFindingIds: ['earlier'] },
      reviewPoints: [{ code: 'CHECK', message: '<script>unsafe</script>', findingIds: ['earlier'] }],
      nextSteps: [{ findingId: 'earlier' }, { findingId: 'later' }] },
  }));
  assert.equal($('analysis-overview').hidden, false);
  assert.equal($('overview-description').textContent, 'Кратко обобщение');
  assert.match($('overview-points').children[0].textContent, /По-ранна задача/);
  assert.equal($('review-points').children[0].textContent, '<script>unsafe</script>');
  chooseRole($);
  assert.equal($('analysis-tasks').children[0].children[1].children[0].textContent, 'По-ранна задача');
});

test('analysis UI: a conflicting finding excluded by backend guidance is not an automatic task', async () => {
  const { $, ui } = setup(async () => capabilities());
  await ui.ready;
  ui.render(result([item()], { insights: { summary: { text: 'Провери противоречието.', keyFindingIds: [] },
    reviewPoints: [], nextSteps: [] } }));
  assert.equal($('tasks-progress').textContent, '0 от 0 изпълнени');
});

test('analysis UI: opening a source expands collapsed extracted text before navigating', async () => {
  const { $, ui } = setup(async () => capabilities());
  await ui.ready;
  ui.render(result());
  $('extracted-text').open = false;
  let visibleOnNavigation = false;
  $('page-1').scrollIntoView = () => { visibleOnNavigation = $('extracted-text').open; };
  const details = $('analysis-items').children[0].children[4];
  details.children[2].click();
  assert.equal(visibleOnNavigation, true);
});

test('analysis UI: an old server returning 404 is distinguished from a network failure', async () => {
  const { $, ui } = setup(async () => ({ ok: false, status: 404 }));
  await ui.ready;
  assert.match($('analysis-availability').textContent, /стара версия/);
  assert.equal($('analysis-consent').disabled, true);
  assert.ok(!$('analysis-availability').textContent.includes('Няма връзка'));
});

test('analysis UI: uploading after server restart refreshes capabilities and enables consent', async () => {
  let old = true;
  const { $, ui } = setup(async () => old ? { ok: false, status: 404 } : ({
    ok: true, json: async () => ({ analysis: { enabled: true, mode: 'gemini' } }),
  }));
  await ui.ready;
  assert.equal($('analysis-consent').disabled, true);
  old = false;
  await ui.fileReady();
  assert.equal($('analysis-consent').disabled, false);
  assert.equal($('analyze-document').disabled, true);
  $('analysis-consent').checked = true;
  $('analysis-consent').events.change();
  assert.equal($('analyze-document').disabled, false);
});

test('analysis UI: invalid configuration responses cannot enable consent', async () => {
  const { $, ui } = setup(async () => ({ ok: true, json: async () => ({ analysis: { enabled: 'true', mode: 'gemini' } }) }));
  await ui.ready;
  assert.match($('analysis-availability').textContent, /непознат отговор/);
  assert.equal($('analysis-consent').disabled, true);
});

test('analysis UI: analysis needs explicit consent and reuploads original bytes', async () => {
  let calls = 0;
  const { $, ui } = setup(async (url, options) => {
    if (url === '/api/capabilities') return capabilities();
    calls++;
    assert.equal(url, '/api/documents/analyze');
    assert.equal(await options.body.get('document').text(), 'original bytes');
    return { ok: true, json: async () => result() };
  });
  await ui.ready;
  await $('analyze-document').click();
  assert.equal(calls, 0);
  $('analysis-consent').checked = true;
  $('analysis-consent').events.change();
  await $('analyze-document').click();
  assert.equal(calls, 1);
  assert.equal($('analysis-results').hidden, false);
});

test('analysis UI: document content is rendered with textContent, never interpreted as HTML', async () => {
  const { $, ui } = setup(async () => capabilities());
  await ui.ready;
  const attack = '<img src=x onerror=alert(1)>';
  ui.render(result([item({ title: attack, explanation: attack, sourceQuote: attack })]));
  const card = $('analysis-items').children[0];
  assert.equal(card.children[1].textContent, attack);
  assert.equal(card.children[2].textContent, attack);
  assert.equal(card.children[4].children[1].textContent, attack);
});

test('analysis UI: only verified mandatory actions become tasks; recommendations are preserved as findings', async () => {
  const { $, ui } = setup(async () => capabilities());
  await ui.ready;
  ui.render(result([
    item(), item({ id: '2', obligationLevel: 'recommended' }),
    item({ id: '3', verificationStatus: 'unverified' }), item({ id: '4', type: 'condition' }),
  ]));
  assert.equal($('analysis-items').children.length, 4);
  assert.equal($('analysis-tasks').children.length, 1);
  chooseRole($);
  const checkbox = $('analysis-tasks').children[0].children[0];
  checkbox.checked = true;
  checkbox.events.change();
  assert.equal($('tasks-progress').textContent, '1 от 1 изпълнени');
});

test('analysis UI: partial status, OCR and skipped pages are visible', async () => {
  const { $, ui } = setup(async () => capabilities());
  await ui.ready;
  ui.render(result([], { status: 'partial', extractionMethod: 'ocr', pageCoverage: [{ pageNumber: 7, status: 'skipped', processedCharacters: 0, totalCharacters: 100 }] }));
  assert.match($('analysis-summary').textContent, /частичен/);
  assert.match($('analysis-coverage').children[0].textContent, /Страница 7: Пропусната/);
  assert.ok($('analysis-warnings').children[0].children.some((node) => node.textContent.includes('OCR')));
});

test('analysis UI: failed HTTP analysis is displayed as failed, not as success', async () => {
  const { $, ui } = setup(async (url) => url === '/api/capabilities' ? capabilities() : ({ ok: false, json: async () => result([], { status: 'failed' }) }));
  await ui.ready;
  $('analysis-consent').checked = true;
  await $('analyze-document').click();
  assert.match($('analysis-status').textContent, /не е завършен/);
  assert.equal($('analyze-document').disabled, false);
});

test('analysis UI: clearing a document removes prior results and consent', async () => {
  const { $, ui } = setup(async () => capabilities());
  await ui.ready;
  ui.render(result());
  $('analysis-consent').checked = true;
  ui.reset();
  assert.equal($('analysis-results').hidden, true);
  assert.equal($('analysis-actions').hidden, true);
  assert.equal($('analysis-consent').checked, false);
});

test('analysis UI: changing from mock to paid AI requires fresh consent', async () => {
  let mode = 'mock';
  const { $, ui } = setup(async () => ({ ok: true, json: async () => ({ analysis: { enabled: true, mode } }) }));
  await ui.ready;
  $('analysis-consent').checked = true;
  mode = 'openai';
  await ui.fileReady();
  assert.equal($('analysis-consent').checked, false);
  assert.equal($('analyze-document').disabled, true);
});

test('PWA: service worker never intercepts API requests or document uploads', () => {
  const handlers = {};
  const self = { location: { origin: 'https://example.test' }, addEventListener: (name, handler) => { handlers[name] = handler; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8'), { self, URL, Set });
  for (const [method, resource] of [['POST', '/api/documents/upload'], ['GET', '/api/capabilities'], ['GET', '/private-document.pdf']]) {
    let intercepted = false;
    handlers.fetch({ request: { method, url: `https://example.test${resource}` }, respondWith() { intercepted = true; } });
    assert.equal(intercepted, false);
  }
});

test('analysis UI: role selection is explicit and switching preserves separate progress without AI calls', async () => {
  let calls = 0;
  const { $, ui } = setup(async () => { calls++; return capabilities(); });
  await ui.ready;
  ui.render(result([item(), item({ id: '2', actor: { role: 'Изпълнител', sourceQuote: 'Изпълнителят' } }),
    item({ id: '3', actor: null, actorVerificationStatus: 'unknown' })]));
  assert.equal($('tasks-progress').textContent, '0 от 0 изпълнени');
  assert.equal($('other-party-tasks').children.length, 2);
  assert.equal($('unassigned-tasks').children.length, 1);
  chooseRole($);
  const checkbox = $('analysis-tasks').children[0].children[0];
  checkbox.checked = true; checkbox.events.change();
  assert.equal($('tasks-progress').textContent, '1 от 1 изпълнени');
  chooseRole($, 2);
  assert.equal($('tasks-progress').textContent, '0 от 1 изпълнени');
  assert.equal($('other-party-tasks').children.length, 1);
  chooseRole($);
  assert.equal($('tasks-progress').textContent, '1 от 1 изпълнени');
  assert.equal($('analysis-tasks').children[0].children[0].checked, true);
  assert.equal(calls, 1);
});

test('analysis UI: legacy unknown parties are review-only and cannot become personal tasks', async () => {
  const { $, ui } = setup(async () => capabilities());
  await ui.ready;
  ui.render(result([item({ actor: null, actorVerificationStatus: 'unknown' })]));
  assert.equal($('user-role').disabled, true);
  assert.equal($('tasks-progress').textContent, '0 от 0 изпълнени');
  assert.equal($('unassigned-tasks').children.length, 1);
  assert.match($('role-status').textContent, /Няма потвърдена роля/);
});

test('analysis UI: document summary renders literal text and original page sources', async () => {
  const { $, ui } = setup(async () => capabilities());
  await ui.ready;
  ui.render(result([], { insights: { ...buildInsights({ items: [], status: 'partial' }), documentSummary: {
    status: 'partial', facts: [{ kind: 'purpose', text: '<script>literal</script>', sourceQuote: 'Цел на документа.', pageNumber: 7, verificationStatus: 'verified' }],
    missingKinds: ['party'], rejectedCount: 1, warning: 'Провери тълкуването.',
  } } }));
  const container = $('document-context-summary');
  assert.match(container.children[1].textContent, /Частично/);
  const section = container.children[2];
  assert.equal(section.children[1].textContent, '<script>literal</script>');
  assert.match(section.children[2].children[0].textContent, /страница 7/);
  let navigated = false;
  $('page-7').scrollIntoView = () => { navigated = true; };
  section.children[2].children[2].click();
  assert.equal($('extracted-text').open, true);
  assert.equal(navigated, true);
});

test('analysis UI: validation diagnostics are rendered as literal warning text', async () => {
  const { $, ui } = setup(async () => capabilities());
  await ui.ready;
  ui.render(result([], { status: 'failed', chunks: [{ chunkId: 1, reason: 'INVALID_ANALYSIS',
    validationDiagnostics: { issues: [{ field: '/items/0/deadline', code: 'VALIDATION_RULE', message: 'Провери срока. <literal>' }], truncated: true },
  }] }));
  const warnings = $('analysis-warnings').children[0].children.map((node) => node.textContent);
  assert.ok(warnings.some((text) => text.includes('/items/0/deadline') && text.includes('<literal>')));
  assert.ok(warnings.some((text) => text.includes('първите 10')));
});
