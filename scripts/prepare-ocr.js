const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');

// Only trusted, installed language models are written here. No user document
// or OCR output is ever persisted. Everything stays inside node_modules.
const target = path.resolve(__dirname, '../node_modules/.cache/razberi-ocr');
fs.mkdirSync(target, { recursive: true });
for (const language of ['bul', 'eng']) {
  const base = path.dirname(require.resolve(`@tesseract.js-data/${language}`));
  const model = fs.readFileSync(path.join(base, '4.0.0_best_int', `${language}.traineddata.gz`));
  fs.writeFileSync(path.join(target, `${language}.traineddata`), gunzipSync(model));
}
