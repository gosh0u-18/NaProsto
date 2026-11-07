const { validatePages } = require('./source-verifier');
const { boundedSettings } = require('./controls');

function chunkDocument(pages, options = {}) {
  validatePages(pages);
  const settings = boundedSettings(options);
  const chunks = [];
  const pagePlan = pages.map((page) => ({
    pageNumber: page.pageNumber, totalCharacters: page.text.length,
    plannedCharacters: 0, empty: !page.text.trim(),
  }));
  let totalCharacters = 0;
  let current;
  for (const [index, page] of pages.entries()) {
    if (pagePlan[index].empty) {
      continue;
    }
    if (options.preferPageBoundaries && current?.characterCount > 0 &&
        page.text.length <= settings.chunkCharacters && current.characterCount + page.text.length > settings.chunkCharacters &&
        chunks.length < settings.maxChunks) {
      current = undefined;
    }
    let offset = 0;
    while (offset < page.text.length && totalCharacters < settings.maxCharacters) {
      if (!current || current.characterCount >= settings.chunkCharacters) {
        if (chunks.length >= settings.maxChunks) {
          break;
        }
        current = { id: chunks.length + 1, pages: [], characterCount: 0 };
        chunks.push(current);
      }
      let end = Math.min(page.text.length, offset + settings.chunkCharacters - current.characterCount,
        offset + settings.maxCharacters - totalCharacters);
      if (end < page.text.length) {
        const lastSpace = page.text.lastIndexOf(' ', end - 1);
        if (lastSpace > offset && end - lastSpace < 200) end = lastSpace + 1;
        const code = page.text.charCodeAt(end - 1);
        if (code >= 0xD800 && code <= 0xDBFF) end--;
      }
      if (end <= offset) {
        if (!current.pages.length) { chunks.pop(); current = undefined; break; }
        current = undefined;
        if (settings.maxCharacters - totalCharacters < 2 || settings.chunkCharacters < 2) {
          break;
        }
        continue;
      }
      const text = page.text.slice(offset, end);
      const last = current.pages.at(-1);
      if (last?.pageNumber === page.pageNumber) last.text += text;
      else current.pages.push({ pageNumber: page.pageNumber, startOffset: offset, text });
      current.characterCount += text.length;
      totalCharacters += text.length;
      pagePlan[index].plannedCharacters += text.length;
      offset = end;
    }
  }
  return { chunks, pagePlan, totalCharacters };
}

module.exports = { chunkDocument };
