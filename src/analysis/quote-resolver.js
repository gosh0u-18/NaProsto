const { validateCandidateAnalysis } = require('./schema');

function whitespaceIndex(text) {
  const starts = [];
  const ends = [];
  let value = '';
  for (const match of text.matchAll(/\s+|\S+/gu)) {
    if (/^\s/u.test(match[0])) {
      value += ' ';
      starts.push(match.index);
      ends.push(match.index + match[0].length);
    } else {
      value += match[0];
      for (let index = 0; index < match[0].length; index++) {
        starts.push(match.index + index);
        ends.push(match.index + index + 1);
      }
    }
  }
  return { value, starts, ends };
}

function originalSpan(source, quote) {
  if (typeof quote !== 'string' || !quote.trim()) {
    return null;
  }
  if (source.includes(quote)) {
    return quote;
  }
  const needle = quote.trim().replace(/\s+/gu, ' ');
  if (needle.length < 8) {
    return null;
  }
  const indexed = whitespaceIndex(source);
  const index = indexed.value.indexOf(needle);
  if (index < 0) {
    return null;
  }
  return source.slice(indexed.starts[index], indexed.ends[index + needle.length - 1]);
}

function restoreCandidateQuotes(candidate, pages) {
  const restored = [];
  const items = candidate.items.map((item) => {
    const page = pages.find((page) => page.pageNumber === item.pageNumber);
    const quote = page && originalSpan(page.text, item.sourceQuote);
    if (!quote) { restored.push(false); return item; }
    const fixed = { ...item, sourceQuote: quote };
    if (item.actor) {
      const evidence = originalSpan(quote, item.actor.sourceQuote);
      if (evidence) fixed.actor = { ...item.actor, sourceQuote: evidence };
    }
    if (item.deadline) {
      const originalText = originalSpan(quote, item.deadline.originalText);
      if (!originalText) { restored.push(false); return item; }
      const event = item.deadline.referenceEvent === null ? null : originalSpan(originalText, item.deadline.referenceEvent);
      if (item.deadline.referenceEvent !== null && !event) { restored.push(false); return item; }
      fixed.deadline = { ...item.deadline, originalText, referenceEvent: event };
    }
    // Restoring whitespace must not bypass any deadline/schema business rule.
    if (!validateCandidateAnalysis({ items: [fixed], warnings: [] }).valid) { restored.push(false); return item; }
    restored.push(JSON.stringify(fixed) !== JSON.stringify(item));
    return fixed;
  });
  return { candidate: { ...candidate, items }, restored };
}

module.exports = { restoreCandidateQuotes };
