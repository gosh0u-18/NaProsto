const { randomUUID } = require('node:crypto');
const { verifySource } = require('./source-verifier');

function verifyDocumentContext(entries, pages) {
  return entries.map((entry) => ({ ...entry, id: randomUUID(),
    ...verifySource(entry, pages),
  }));
}

function buildDocumentSummary(analysis) {
  const all = analysis.documentContext || [];
  const accepted = all.filter((entry) => entry.verificationStatus === 'verified');
  const seen = new Set();
  const facts = accepted.filter((entry) => {
    const key = JSON.stringify([entry.kind, entry.text, entry.pageNumber, entry.sourceQuote]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  let status = 'unavailable';
  if (analysis.status !== 'failed') {
    if (analysis.status !== 'complete' || accepted.length !== all.length) {
      status = 'partial';
    } else if (facts.length > 0) {
      status = 'available';
    }
  }
  return {
    status,
    facts,
    missingKinds: ['documentType', 'purpose', 'party', 'keyTerm'].filter((kind) => !facts.some((entry) => entry.kind === kind)),
    rejectedCount: all.length - accepted.length,
    warning: 'Намерихме цитатите в текста. Обяснението все пак може да е неточно или да пропуска условие. Провери оригинала преди действие.',
  };
}

module.exports = { verifyDocumentContext, buildDocumentSummary };
