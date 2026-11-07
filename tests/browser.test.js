const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// A small DOM double runs the actual browser script without adding test packages.
// innerHTML deliberately throws to catch unsafe rendering of document content.
class Element {
  constructor() {
    this.textContent = '';
    this.children = [];
    this.events = {};
    this.attributes = {};
    this.classes = new Set();
    this.classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name),
    };
  }
  set innerHTML(value) { throw new Error('Unsafe HTML rendering'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) {
    const previous = this.events[name];
    this.events[name] = (event) => {
      previous?.(event);
      return handler(event);
    };
  }
}

function setup(fetch) {
  const elements = new Map();
  const document = {
    querySelector: (selector) => {
      if (!elements.has(selector)) elements.set(selector, new Element());
      return elements.get(selector);
    },
    createElement: () => new Element(),
    createDocumentFragment: () => new Element(),
  };
  const context = vm.createContext({ document, window: { document }, fetch, FormData, AbortController, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/script.js'), 'utf8'), context);
  return (selector) => elements.get(selector);
}

test('file selection sends the document and safely displays text and empty pages', async () => {
  let called = false;
  const dangerousText = '<img src=x onerror=alert(1)>';
  const $ = setup(async (url, options) => {
    called = true;
    assert.equal(url, '/api/documents/upload');
    assert.equal(options.method, 'POST');
    assert.equal(options.body.get('document').name, 'документ.pdf');
    return { ok: true, json: async () => ({
      documentName: 'документ.pdf', pageCount: 2,
      pages: [{ pageNumber: 1, text: dangerousText }, { pageNumber: 2, text: '' }],
    }) };
  });
  $('#pdf-file').files = [new File(['PDF'], 'документ.pdf')];
  await $('#pdf-file').events.change();
  assert.ok(called);
  assert.equal($('#document-results').hidden, false);
  assert.equal($('#document-pages').children[0].children[0].children[1].textContent, dangerousText);
  assert.equal($('#document-pages').children[0].children[1].children[0].textContent, 'Страница 2');
  assert.match($('#document-pages').children[0].children[1].children[1].textContent, /няма извлекаем текст/);
  assert.equal($('#pdf-file').disabled, false);
});

test('drag and drop uses the same upload endpoint', async () => {
  let calls = 0;
  const $ = setup(async () => {
    calls++;
    return { ok: true, json: async () => ({ documentName: 'file.pdf', pageCount: 1, pages: [{ pageNumber: 1, text: 'Hello' }] }) };
  });
  let prevented = false;
  await $('#dropzone').events.drop({
    preventDefault: () => { prevented = true; },
    dataTransfer: { files: [new File(['PDF'], 'file.pdf')] },
  });
  assert.ok(prevented);
  assert.equal(calls, 1);
});

test('oversized files are rejected in the browser before upload', async () => {
  const $ = setup(() => { throw new Error('Must not upload'); });
  $('#pdf-file').files = [new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.pdf')];
  await $('#pdf-file').events.change();
  assert.match($('#upload-status').textContent, /10 MB/);
  assert.ok($('#upload-status').classes.has('error'));
});

test('OCR server messages are shown and the file input is usable afterwards', async () => {
  const message = 'Няма извлекаем текст. OCR предстои.';
  const $ = setup(async () => ({ ok: false, json: async () => ({ error: { message } }) }));
  $('#pdf-file').files = [new File(['PDF'], 'scan.pdf')];
  await $('#pdf-file').events.change();
  assert.equal($('#upload-status').textContent, message);
  assert.equal($('#document-results').hidden, true);
  assert.equal($('#pdf-file').disabled, false);
});

test('network failures produce a friendly message and allow another upload', async () => {
  const $ = setup(async () => { throw new Error('internal technical details'); });
  $('#pdf-file').files = [new File(['PDF'], 'file.pdf')];
  await $('#pdf-file').events.change();
  assert.match($('#upload-status').textContent, /Няма връзка/);
  assert.ok(!$('#upload-status').textContent.includes('internal'));
  assert.equal($('#pdf-file').disabled, false);
});

test('dropping multiple files does not upload any of them', async () => {
  const $ = setup(() => { throw new Error('Must not upload'); });
  await $('#dropzone').events.drop({
    preventDefault() {},
    dataTransfer: { files: [new File(['PDF'], 'one.pdf'), new File(['PDF'], 'two.pdf')] },
  });
  assert.match($('#upload-status').textContent, /само един/);
});

test('camera selection uploads the original photo and labels its OCR text', async () => {
  const $ = setup(async (url, options) => {
    assert.equal(url, '/api/documents/upload');
    assert.equal(options.body.get('document').name, 'camera.jpg');
    return { ok: true, json: async () => ({ documentName: 'camera.jpg', pageCount: 1, sourceType: 'photo',
      warnings: ['Провери OCR текста.'], pages: [{ pageNumber: 1, text: 'ДЕКЛАРАЦИЯ', extractionMethod: 'ocr' }] }) };
  });
  $('#camera-file').files = [new File(['photo bytes'], 'camera.jpg', { type: 'image/jpeg' })];
  await $('#camera-file').events.change();
  assert.match($('#document-pages').children[0].children[0].children[0].textContent, /OCR от снимка/);
  assert.equal($('#extraction-warnings').textContent, 'Провери OCR текста.');
});
